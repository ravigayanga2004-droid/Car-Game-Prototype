import { CONFIG } from '../game/config'
import { applyDamage, applyLaunch, CAR_RADIUS, DAMAGE_CAUSE, inactive, countdownStep, createCar, DT, stepCar, type CarInput, type CarState, type ItemKind, type RaceEvent } from './car'
import { clamp, mod, rng, wrapDelta, type Rng } from './math'
import { applyTimeLimit, compareStandings, COUNTDOWN, crossesForward, nextGateIndex, passGate, type Standing } from './rules'
import { MAX_POWER, powerCellPlacements } from './power'
import type { Track } from './track'

/**
 * The deterministic race: fixed 60 Hz steps over explicit per-car inputs. Rendering, UI,
 * audio and networking only read this state and drain `events`; they never write to it.
 */
export type RacePhase = 'countdown' | 'racing' | 'finished'

export interface RaceOptions {
  track: Track
  cars: number
  seed: number
  items: boolean
  /** Disable the local Power Cell mechanic for the legacy authoritative online ghost service. */
  powerCells?: boolean
  /** Grid slot per car (0..2 = lane, +3 per row). Defaults to 0,1,2… */
  slots?: number[]
}

/** Plain-data snapshot used for online resynchronisation (no items in online races). */
export interface SimSnapshot { tick: number; clock: number; phase: RacePhase; cars: CarState[]; powerCells?: Array<{ respawn: number }> }

export interface ItemBox { row: number; lane: number; x: number; y: number; z: number; respawn: number }
export interface PowerCell { index: number; s: number; lane: number; x: number; y: number; z: number; respawn: number }
export interface Seeker { id: number; owner: number; target: number; odo: number; d: number; speed: number; locked: boolean; lockD: number; life: number }
export interface Mine { id: number; owner: number; x: number; y: number; z: number; s: number; d: number; arm: number; life: number }

export const GRID_BACK = 14
export const GRID_LANES = [-5, 0, 5]
const SEEKER_HIT_WIDTH = 2.6
const MINE_RADIUS = 2.3

export class RaceSim {
  readonly track: Track
  readonly cars: CarState[]
  readonly items: boolean
  readonly boxes: ItemBox[] = []
  readonly powerCells: PowerCell[] = []
  readonly seekers: Seeker[] = []
  readonly mines: Mine[] = []
  readonly events: RaceEvent[] = []
  phase: RacePhase = 'countdown'
  /** Race clock: negative during the countdown, 0 at GO. */
  clock = -COUNTDOWN
  tick = 0
  order: number[] = []
  private readonly rand: Rng
  private nextId = 1

  constructor(opts: RaceOptions) {
    this.track = opts.track
    this.items = opts.items
    this.rand = rng(opts.seed)
    this.cars = []
    for (let i = 0; i < opts.cars; i += 1) {
      const slot = opts.slots?.[i] ?? i
      this.cars.push(createCar(i, this.track, GRID_LANES[slot % GRID_LANES.length] * clamp(this.track.halfW[0] / 10, 0.8, 1.2), -GRID_BACK - Math.floor(slot / 3) * 10))
    }
    this.order = this.cars.map(c => c.id)
    if (opts.items) {
      const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
      for (const row of this.track.items) {
        this.track.frameAt(row.s, f)
        for (const lane of row.lanes) {
          this.boxes.push({ row: row.index, lane, x: f.x + f.rx * lane, y: f.y + f.bank * lane + 1.3, z: f.z + f.rz * lane, respawn: 0 })
        }
      }
    }
    if (opts.powerCells !== false) {
      const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
      for (const cell of powerCellPlacements(this.track)) {
        this.track.frameAt(cell.s, f)
        this.powerCells.push({ index: cell.index, s: cell.s, lane: cell.lane, x: f.x + f.rx * cell.lane, y: f.y + f.bank * cell.lane + 1.35, z: f.z + f.rz * cell.lane, respawn: 0 })
      }
    }
  }

  /** Remaining countdown seconds (0 once racing). */
  get countdown(): number {
    return this.phase === 'countdown' ? -this.clock : 0
  }

  drainEvents(): RaceEvent[] {
    const out = this.events.splice(0, this.events.length)
    return out
  }

  exportState(): SimSnapshot {
    return { tick: this.tick, clock: this.clock, phase: this.phase, cars: structuredClone(this.cars), powerCells: structuredClone(this.powerCells.map(c => ({ respawn: c.respawn }))) }
  }

  importState(s: SimSnapshot): void {
    this.tick = s.tick
    this.clock = s.clock
    this.phase = s.phase
    for (let i = 0; i < this.cars.length && i < s.cars.length; i += 1) Object.assign(this.cars[i], structuredClone(s.cars[i]))
    if (s.powerCells) for (let i = 0; i < this.powerCells.length && i < s.powerCells.length; i += 1) this.powerCells[i].respawn = s.powerCells[i].respawn
  }

  step(inputs: readonly CarInput[]): void {
    if (this.phase === 'finished') return
    this.tick += 1
    if (this.phase === 'countdown') {
      this.clock += DT
      for (const car of this.cars) countdownStep(car, inputs[car.id], -this.clock)
      if (this.clock >= -1e-9) {
        this.clock = 0
        this.phase = 'racing'
        this.events.push({ type: 'go', car: -1 })
        for (const car of this.cars) applyLaunch(car, this.events)
      }
      return
    }
    this.clock += DT
    for (const car of this.cars) stepCar(car, inputs[car.id], this.track, this.events)
    this.collide()
    this.draft()
    this.gates()
    this.stepPowerCells()
    if (this.items) this.stepItems()
    this.standings()
    for (const car of this.cars) {
      if (applyTimeLimit(car.progress, this.clock)) this.events.push({ type: 'dnf', car: car.id })
    }
    if (this.cars.every(c => c.progress.finished || c.progress.dnf)) {
      this.phase = 'finished'
      this.events.push({ type: 'raceOver', car: -1 })
    }
  }

  private collide(): void {
    const cars = this.cars
    for (let i = 0; i < cars.length; i += 1) {
      const a = cars[i]
      if (inactive(a) || a.ghostT > 0) continue
      for (let j = i + 1; j < cars.length; j += 1) {
        const b = cars[j]
        if (inactive(b) || b.ghostT > 0) continue
        if (Math.abs(a.y - b.y) > 1.6) continue
        const dx = b.x - a.x
        const dz = b.z - a.z
        const d2 = dx * dx + dz * dz
        const min = CAR_RADIUS * 2
        if (d2 >= min * min || d2 < 1e-8) continue
        const dist = Math.sqrt(d2)
        const nx = dx / dist
        const nz = dz / dist
        const push = (min - dist) / 2
        a.x -= nx * push; a.z -= nz * push
        b.x += nx * push; b.z += nz * push
        const vrel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz
        if (vrel < 0) {
          const j2 = (-vrel * 1.3) / 2
          a.vx -= nx * j2; a.vz -= nz * j2
          b.vx += nx * j2; b.vz += nz * j2
          if (-vrel > 3) this.events.push({ type: 'bump', car: a.id, other: b.id, value: -vrel })
          if (-vrel > 14) {
            const dmg = (-vrel - 14) / 40
            applyDamage(a, dmg, this.events, DAMAGE_CAUSE.car)
            applyDamage(b, dmg, this.events, DAMAGE_CAUSE.car)
          }
        }
      }
    }
  }

  private draft(): void {
    for (const a of this.cars) {
      let wake = false
      if (a.grounded && a.vF > 25 && !inactive(a)) {
        const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw)
        for (const b of this.cars) {
          if (b === a || inactive(b) || b.vF < 20) continue
          const rx = b.x - a.x, rz = b.z - a.z
          const along = rx * fx + rz * fz
          const lat = Math.abs(rx * -fz + rz * fx)
          if (along > 5 && along < 32 && lat < 3.5 && Math.abs(b.y - a.y) < 3) { wake = true; break }
        }
      }
      a.draftCharge = wake ? Math.min(1.2, a.draftCharge + DT) : Math.max(0, a.draftCharge - DT * 2)
      const was = a.drafting
      a.drafting = a.draftCharge >= 0.8
      if (a.drafting) {
        a.meter = Math.min(1, a.meter + 0.08 * DT)
        a.stats.draftTime += DT
      }
      if (a.drafting && !was) this.events.push({ type: 'draft', car: a.id })
    }
  }

  private gates(): void {
    const L = this.track.length
    for (const car of this.cars) {
      const p = car.progress
      if (p.finished || p.dnf || inactive(car) || car.lastDs <= 0) continue
      const gate = this.track.gates[nextGateIndex(p)]
      if (!crossesForward(car.prevS, car.lastDs, gate.s, L)) continue
      if (Math.abs(car.loc.d) > car.loc.barrier + 1.5) continue
      const result = passGate(p, this.clock)
      this.events.push({ type: result, car: car.id, value: p.gates })
    }
  }

  private standings(): void {
    const L = this.track.length
    const list: Standing[] = this.cars.map(c => ({ id: c.id, progress: c.progress, toNext: mod(this.track.gates[nextGateIndex(c.progress)].s - c.loc.s, L) }))
    list.sort(compareStandings)
    this.order = list.map(s => s.id)
    list.forEach((s, i) => (this.cars[s.id].place = i + 1))
  }

  private stepPowerCells(): void {
    for (const cell of this.powerCells) {
      if (cell.respawn > 0) {
        cell.respawn = Math.max(0, cell.respawn - DT)
        continue
      }
      for (const car of this.cars) {
        if (inactive(car) || car.progress.finished || car.power >= MAX_POWER) continue
        const dx = car.x - cell.x, dz = car.z - cell.z
        if (dx * dx + dz * dz > 2.9 * 2.9 || Math.abs(car.y + 0.8 - cell.y) > 3) continue
        car.power = Math.min(MAX_POWER, car.power + 1)
        cell.respawn = 5.5
        this.events.push({ type: 'power', car: car.id, value: car.power, other: cell.index })
        break
      }
    }
  }

  // ─── items ──────────────────────────────────────────────────────────────

  private rollItem(car: CarState): ItemKind {
    const r = this.rand()
    // The leader has nobody ahead to target, so it never draws a seeker.
    if (car.place === 1) return r < 0.4 ? 'mine' : r < 0.7 ? 'shield' : 'canister'
    return r < 0.32 ? 'seeker' : r < 0.6 ? 'mine' : r < 0.8 ? 'shield' : 'canister'
  }

  private stepItems(): void {
    const respawn = CONFIG.race.itemRespawn
    for (const box of this.boxes) {
      if (box.respawn > 0) {
        box.respawn = Math.max(0, box.respawn - DT)
        continue
      }
      for (const car of this.cars) {
        if (inactive(car)) continue
        const dx = car.x - box.x, dz = car.z - box.z
        if (dx * dx + dz * dz > 2.7 * 2.7 || Math.abs(car.y + 0.8 - box.y) > 3) continue
        box.respawn = respawn
        this.events.push({ type: 'box', car: car.id, value: this.boxes.indexOf(box) })
        if (!car.item) {
          car.item = this.rollItem(car)
          this.events.push({ type: 'item', car: car.id, value: ['seeker', 'mine', 'shield', 'canister'].indexOf(car.item) })
        }
        break
      }
    }

    for (const car of this.cars) {
      if (!car.itemRequest) continue
      car.itemRequest = false
      const item = car.item
      if (!item) continue
      car.item = null
      car.stats.itemsUsed += 1
      if (item === 'shield') {
        car.shield = 8
        this.events.push({ type: 'useShield', car: car.id })
      } else if (item === 'canister') {
        car.meter = 1
        this.events.push({ type: 'useCanister', car: car.id })
      } else if (item === 'mine') {
        const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw)
        const x = car.x - fx * 4.5, z = car.z - fz * 4.5
        const mloc = { ...car.loc }
        this.track.locate(x, car.y, z, car.loc.i, mloc)
        this.mines.push({ id: this.nextId++, owner: car.id, x, y: mloc.onSurface ? mloc.roadY : car.y, z, s: mloc.s, d: mloc.d, arm: 0.6, life: 30 })
        if (this.mines.length > 8) this.mines.shift()
        this.events.push({ type: 'useMine', car: car.id })
      } else {
        const idx = this.order.indexOf(car.id)
        const target = idx > 0 ? this.order[idx - 1] : -1
        const tgt = target >= 0 ? this.cars[target] : null
        const gap = tgt ? mod(tgt.loc.s - car.loc.s, this.track.length) : 0
        const odo = tgt ? tgt.odo - Math.max(4, gap) : car.odo + 3
        this.seekers.push({ id: this.nextId++, owner: car.id, target, odo, d: car.loc.d, speed: 85, locked: false, lockD: 0, life: tgt ? 14 : 3 })
        this.events.push({ type: 'useSeeker', car: car.id, other: target })
      }
    }

    for (const car of this.cars) {
      car.warnSeeker = -1
      car.warnLocked = false
      car.warnMine = -1
    }

    for (let i = this.seekers.length - 1; i >= 0; i -= 1) {
      const p = this.seekers[i]
      p.life -= DT
      const tgt = p.target >= 0 ? this.cars[p.target] : null
      if (!tgt) {
        p.odo += p.speed * DT
        if (p.life <= 0) {
          this.seekers.splice(i, 1)
          this.events.push({ type: 'fizzle', car: p.owner })
        }
        continue
      }
      if (inactive(tgt) || tgt.progress.finished || p.life <= 0) {
        this.seekers.splice(i, 1)
        this.events.push({ type: 'fizzle', car: p.owner })
        continue
      }
      p.speed = Math.max(80, tgt.vF + 42)
      const closing = p.speed - tgt.vF
      p.odo += p.speed * DT
      const gap = tgt.odo - p.odo
      if (!p.locked) {
        p.d += clamp(tgt.loc.d - p.d, -10 * DT, 10 * DT)
        if (gap < closing * 0.8) {
          p.locked = true
          p.lockD = tgt.loc.d
          this.events.push({ type: 'seekerLock', car: tgt.id, other: p.owner })
        }
      } else p.d += clamp(p.lockD - p.d, -20 * DT, 20 * DT)
      tgt.warnSeeker = tgt.warnSeeker < 0 ? Math.max(0, gap) : Math.min(tgt.warnSeeker, Math.max(0, gap))
      if (p.locked) {
        tgt.warnLocked = true
        tgt.warnLockD = p.lockD
      }
      if (gap <= 0) {
        this.seekers.splice(i, 1)
        const inLane = Math.abs(tgt.loc.d - p.lockD) < SEEKER_HIT_WIDTH
        const low = tgt.y - tgt.loc.roadY < 2
        if (inLane && low && tgt.immune <= 0) this.hit(tgt, p.owner, 'seeker')
        else {
          tgt.stats.dodges += 1
          this.events.push({ type: 'dodged', car: tgt.id, other: p.owner })
        }
      }
    }

    const L = this.track.length
    for (let i = this.mines.length - 1; i >= 0; i -= 1) {
      const m = this.mines[i]
      m.life -= DT
      m.arm = Math.max(0, m.arm - DT)
      if (m.life <= 0) {
        this.mines.splice(i, 1)
        continue
      }
      let hitCar: CarState | null = null
      for (const car of this.cars) {
        if (inactive(car)) continue
        const ahead = wrapDelta(m.s - car.loc.s, L)
        if (ahead > 0 && ahead < 90 && Math.abs(m.d - car.loc.d) < 6) car.warnMine = car.warnMine < 0 ? ahead : Math.min(car.warnMine, ahead)
        if (m.arm > 0 || car.immune > 0) continue
        const dx = car.x - m.x, dz = car.z - m.z
        if (dx * dx + dz * dz < MINE_RADIUS * MINE_RADIUS && car.y - m.y < 1.8) { hitCar = car; break }
      }
      if (hitCar) {
        this.mines.splice(i, 1)
        this.hit(hitCar, m.owner, 'mine')
      }
    }
  }

  private hit(car: CarState, owner: number, _kind: 'seeker' | 'mine'): void {
    if (car.shield > 0) {
      car.shield = 0
      car.immune = 0.8
      car.stats.blocks += 1
      this.events.push({ type: 'blocked', car: car.id, other: owner })
      return
    }
    car.spin = 1.0
    car.vx *= 0.45
    car.vz *= 0.45
    car.drift = false
    car.driftCharge = 0
    car.trick = 0
    car.immune = 2
    car.stats.hits += 1
    this.events.push({ type: 'hit', car: car.id, other: owner })
    applyDamage(car, 0.3, this.events, DAMAGE_CAUSE.item)
  }

  /** Canonical digest of simulation state for determinism checks. */
  digest(): string {
    const parts: string[] = [this.phase, this.tick.toString(), this.clock.toFixed(6)]
    for (const c of this.cars) {
      parts.push([c.x, c.y, c.z, c.yaw, c.vx, c.vz, c.vy, c.meter, c.power, c.boostTime, c.powerBoostTime, c.damage, c.wreck, c.hold].map(v => v.toFixed(6)).join(','), String(c.progress.gates), String(c.item), c.progress.penalty.toFixed(3))
    }
    parts.push(String(this.seekers.length), String(this.mines.length), this.boxes.map(b => b.respawn.toFixed(3)).join(','), this.powerCells.map(c => c.respawn.toFixed(3)).join(','))
    return parts.join('|')
  }
}
