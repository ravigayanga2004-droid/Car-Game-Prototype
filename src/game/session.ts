import { newCorkFrame } from '../sim/track'
import { CONFIG } from './config'
import * as THREE from 'three'
import { StyleTracker, type StyleAction, type StyleSnapshot } from './style'
import { tierColor } from '../view/fx'
import type { Audio, EngineVoice, Sfx } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Device } from '../engine/save'
import type { View } from '../engine/renderer'
import { AiDriver, type AiSkill } from '../sim/ai'
import { DAMAGE_FIRE, DAMAGE_SMOKE, idleInput, type CarInput, type CarState, type RaceEvent } from '../sim/car'
import { clamp, lerp, mod, wrapAngle } from '../sim/math'
import { applyCornerAssist, ASSIST_STRENGTH } from '../sim/assist'
import type { AssistMode } from '../engine/save'
import { packInput, quantizeInput, unpackInput, carCheck, type GhostFrame } from '../sim/netcodec'
import { RaceSim, type SimSnapshot } from '../sim/race'
import { bestLap, LAPS, lapOf, nextGateIndex, RECOVERY_PENALTY, totalTime, TOTAL_GATES } from '../sim/rules'
import type { Track } from '../sim/track'
import { CarModel } from '../view/cars'
import { ChaseCam } from '../view/chasecam'
import { Effects } from '../view/fx'
import type { TrackWorld } from '../view/world'

export type Mode = 'solo' | 'split' | 'test' | 'online'

export interface RacerSpec {
  name: string
  chassis: number
  livery: number
  human: boolean
  device?: Device
}

export interface ResultRow {
  id: number
  name: string
  chassis: number
  livery: number
  human: boolean
  humanIndex: number
  place: number
  finished: boolean
  dnf: boolean
  total: number
  penalty: number
  bestLap: number
  lapTimes: number[]
  /** Human run driven with corner assist on for any part of it. */
  assisted: boolean
  /** Per completed lap: driven with assist on. */
  lapAssist: boolean[]
  gates: number
  recoveries: number
  stats: CarState['stats']
}

export type PopupKind = 'good' | 'great' | 'bad' | 'info' | 'warn'
/** HUD feedback pulses (presentation only). */
export type JuiceKind = 'gate' | 'lap' | 'final' | 'boost' | 'tier' | 'pad' | 'hit' | 'block' | 'place' | 'bank' | 'finish' | 'land' | 'item' | 'go' | 'count' | 'wall' | 'warn' | 'damage' | 'wreck' | 'hold' | 'nitro' | 'nitroReady' | 'nitroDenied' | 'power' | 'powerBoost' | 'cork'
export interface SessionHooks {
  popup(view: number, text: string, kind: PopupKind): void
  juice?(view: number, kind: JuiceKind, value?: number): void
  finished(results: ResultRow[]): void
  localFinished?(view: number): void
}

/** Link to the online ghost service; implemented by net/ghostnet.ts. */
export interface OnlineLink {
  readonly seat: number
  targetTick(): number
  pushInput(tick: number, packed: number): void
  ghostFrames(): Map<number, GhostFrame[]>
  ghostProfile(seat: number): { name: string; chassis: number; livery: number } | null
  takeResync(): SimSnapshot | null
  recordCheck(tick: number, check: [number, number, number]): void
}

export interface SessionOptions {
  mode: Mode
  track: Track
  trackId: string
  racers: RacerSpec[]
  items: boolean
  seed: number
  aiSkill: AiSkill
  online?: OnlineLink
}

const ENDING_DELAY = 2.4
const GHOST_DELAY_TICKS = 2

interface Pose { x: number; y: number; z: number; yaw: number }

class GhostCar {
  readonly model: CarModel
  constructor(readonly seat: number, name: string, chassis: number, livery: number) {
    this.model = new CarModel(chassis, livery, true, name)
  }
}

export class Session {
  readonly sim: RaceSim
  readonly mode: Mode
  readonly track: Track
  readonly trackId: string
  readonly racers: RacerSpec[]
  readonly humans: number[] = []
  readonly cams: ChaseCam[] = []
  readonly models: CarModel[] = []
  readonly fx = new Effects()
  readonly group = new THREE.Group()
  readonly online?: OnlineLink
  private readonly ai: AiDriver[]
  private readonly inputs: CarInput[]
  private readonly prev: Pose[]
  private readonly cf = newCorkFrame()
  private readonly lastMeter: number[] = [1, 1, 1]
  private readonly tmpM = new THREE.Vector3()
  private readonly curr: Pose[]
  private readonly engines: EngineVoice[] = []
  private readonly ghosts = new Map<number, GhostCar>()
  private readonly ghostSmooth = new Map<number, { x: number; y: number; z: number; yaw: number }>()
  private readonly history: number[] = []
  private time = 0
  private lastCount = 4
  private ending = -1
  private done = false
  private autopilot: boolean[]
  /** Cosmetic style chains, one per local human view. */
  private readonly wallRide = [0, 0]
  readonly styles: StyleTracker[] = []
  private readonly lastHold: number[] = [0, 0]
  private readonly lastPlace: number[] = []
  private readonly tmpV = new THREE.Vector3()
  paused = false
  reducedMotion = false
  /** Corner assist per human view (0 = P1 / solo / online, 1 = split-screen P2); input shaping only, see sim/assist.ts. */
  readonly assistModes: [AssistMode, AssistMode] = ['strong', 'strong']
  /** Per car: assist was on at any point of the race / during each lap (index = lap number). */
  private readonly assistUsed: boolean[] = []
  private readonly assistLaps: boolean[][] = []
  /** Smoothed 0..1 assist activity per car, for the HUD chip. */
  readonly assistLevel: number[] = []
  private readonly assistOut = { level: 0 }
  results: ResultRow[] | null = null
  /** Assist mode for car i: its human view's setting, Off for AI. */
  assistMode(i: number): AssistMode {
    const v = this.humans.indexOf(i)
    return v < 0 ? 'off' : (this.assistModes[v] ?? 'off')
  }

  constructor(opts: SessionOptions, private readonly world: TrackWorld, private readonly input: Input, private readonly audio: Audio, private readonly hooks: SessionHooks) {
    this.mode = opts.mode
    this.track = opts.track
    this.trackId = opts.trackId
    this.racers = opts.racers
    this.online = opts.online
    const slots = opts.online ? [opts.online.seat] : undefined
    this.sim = new RaceSim({ track: opts.track, cars: opts.racers.length, seed: opts.seed, items: opts.items, powerCells: !opts.online, slots })
    this.ai = opts.racers.map((r, i) => new AiDriver(i, r.human ? 'relaxed' : opts.aiSkill, opts.seed))
    this.autopilot = opts.racers.map(() => false)
    this.inputs = opts.racers.map(() => idleInput())
    opts.racers.forEach((r, i) => {
      if (r.human) this.humans.push(i)
      const model = new CarModel(r.chassis, r.livery, false, r.name)
      this.models.push(model)
      this.group.add(model.root)
    })
    this.prev = this.sim.cars.map(c => ({ x: c.x, y: c.y, z: c.z, yaw: c.yaw }))
    this.curr = this.sim.cars.map(c => ({ x: c.x, y: c.y, z: c.z, yaw: c.yaw }))
    for (const h of this.humans) {
      const cam = new ChaseCam()
      const c = this.sim.cars[h]
      cam.reset(c.x, c.y, c.z, c.yaw)
      this.cams.push(cam)
    }
    this.group.add(this.fx.group)
    world.scene.add(this.group)
    for (let i = 0; i < this.sim.cars.length; i += 1) this.engines.push(audio.engine(this.racers[i].human ? 1 : 0.55))
    this.humans.forEach((h, v) => {
      const st = new StyleTracker()
      st.onBank = pts => {
        if (pts > 0) {
          this.hooks.popup(v, `STYLE +${pts.toLocaleString('en-US')}`, 'great')
          this.audio.play('style', 0.8)
          this.juice(v, 'bank', pts)
        }
      }
      this.styles.push(st)
      this.lastPlace[v] = this.sim.cars[h].place
    })
  }

  styleOf(view: number): StyleSnapshot | null {
    return this.styles[view]?.snapshot() ?? null
  }

  private juice(view: number, kind: JuiceKind, value?: number): void {
    if (view >= 0) this.hooks.juice?.(view, kind, value)
  }

  private style(view: number, action: StyleAction, count = 1): void {
    if (view >= 0) this.styles[view]?.add(action, count)
  }

  get phase(): 'countdown' | 'racing' | 'ending' | 'done' {
    if (this.done) return 'done'
    if (this.ending >= 0) return 'ending'
    return this.sim.phase === 'countdown' ? 'countdown' : 'racing'
  }

  // ─── simulation ────────────────────────────────────────────────────────

  /** One fixed step (online races may run several to stay on the service clock). */
  step(): void {
    if (this.done) return
    if (this.online) {
      const target = this.online.targetTick()
      if (this.sim.tick > target + 1) return
      let n = 0
      do {
        this.stepOnce()
        n += 1
      } while (this.sim.tick < target - 1 && n < 240 && !this.done)
      this.applyResync()
      return
    }
    this.stepOnce()
  }

  private stepOnce(): void {
    const sim = this.sim
    for (let i = 0; i < this.prev.length; i += 1) {
      const c = sim.cars[i]
      const p = this.prev[i]
      const q = this.curr[i]
      p.x = q.x; p.y = q.y; p.z = q.z; p.yaw = q.yaw
      void c
    }
    for (let i = 0; i < sim.cars.length; i += 1) {
      const r = this.racers[i]
      const car = sim.cars[i]
      if (r.human && !this.autopilot[i] && !this.paused) {
        this.input.carInput(r.device ?? 'auto', this.inputs[i])
        // Assist shapes the input before quantising/recording, so online replay stays exact.
        this.assistOut.level = 0
        const mode = this.assistMode(i)
        if (mode !== 'off') {
          applyCornerAssist(car, this.track, this.inputs[i], this.assistOut, ASSIST_STRENGTH[mode])
          if (this.sim.phase === 'racing' && !car.progress.finished) {
            this.assistUsed[i] = true
            ;(this.assistLaps[i] ??= [])[car.progress.lapTimes.length] = true
          }
        } else this.assistOut.level = 0
        const prevLevel = this.assistLevel[i] ?? 0
        this.assistLevel[i] = this.assistOut.level > prevLevel ? this.assistOut.level : prevLevel * 0.9
        if (this.online) quantizeInput(this.inputs[i])
      } else if (r.human && this.paused) {
        Object.assign(this.inputs[i], idleInput())
      } else {
        Object.assign(this.inputs[i], this.ai[i].think(sim))
      }
      if (r.human && (car.progress.finished || car.progress.dnf) && !this.autopilot[i]) this.autopilot[i] = true
    }
    if (this.online) {
      quantizeInput(this.inputs[0])
      const packed = packInput(this.inputs[0])
      this.history[sim.tick + 1] = packed
      this.online.pushInput(sim.tick + 1, packed)
    }
    sim.step(this.inputs)
    if (this.online) this.online.recordCheck(sim.tick, carCheck(sim.cars[0]))
    for (let i = 0; i < sim.cars.length; i += 1) {
      const c = sim.cars[i]
      const q = this.curr[i]
      q.x = c.x; q.y = c.y; q.z = c.z; q.yaw = c.yaw
      if (c.recovering > 0.5 || Math.hypot(q.x - this.prev[i].x, q.z - this.prev[i].z) > 12) {
        this.prev[i].x = q.x; this.prev[i].y = q.y; this.prev[i].z = q.z; this.prev[i].yaw = q.yaw
      }
    }
    for (const e of sim.drainEvents()) this.onEvent(e)
    this.checkEnd()
  }

  /** Online divergence repair: adopt the service state at tick T and replay our own inputs. */
  private applyResync(): void {
    const snap = this.online?.takeResync()
    if (!snap) return
    const now = this.sim.tick
    if (snap.tick > now) return
    this.sim.importState(snap)
    const inp = idleInput()
    while (this.sim.tick < now) {
      const packed = this.history[this.sim.tick + 1] ?? 0
      this.sim.step([unpackInput(packed, inp)])
      this.online?.recordCheck(this.sim.tick, carCheck(this.sim.cars[0]))
    }
    this.sim.drainEvents()
    const c = this.sim.cars[0]
    this.curr[0] = { x: c.x, y: c.y, z: c.z, yaw: c.yaw }
    this.prev[0] = { ...this.curr[0] }
  }

  private checkEnd(): void {
    if (this.ending >= 0 || this.done) return
    const humansDone = this.humans.every(h => {
      const p = this.sim.cars[h].progress
      return p.finished || p.dnf
    })
    if (humansDone || this.sim.phase === 'finished') this.ending = 0
  }

  /** Simulate AI rivals to their finish instantly so results are complete. */
  private fastForward(): void {
    let guard = 0
    while (this.sim.phase !== 'finished' && guard < 60 * 330) {
      for (let i = 0; i < this.sim.cars.length; i += 1) Object.assign(this.inputs[i], this.ai[i].think(this.sim))
      this.sim.step(this.inputs)
      this.sim.drainEvents()
      guard += 1
    }
  }

  private finish(): void {
    if (this.done) return
    this.done = true
    if (!this.online) this.fastForward()
    const rows: ResultRow[] = this.sim.cars.map((c, i) => ({
      id: i,
      name: this.racers[i].name,
      chassis: this.racers[i].chassis,
      livery: this.racers[i].livery,
      human: this.racers[i].human,
      humanIndex: this.humans.indexOf(i),
      place: 0,
      finished: c.progress.finished,
      dnf: c.progress.dnf || !c.progress.finished,
      total: c.progress.finished ? totalTime(c.progress) : Infinity,
      penalty: c.progress.penalty,
      bestLap: bestLap(c.progress),
      lapTimes: [...c.progress.lapTimes],
      assisted: this.racers[i].human && this.assistUsed[i] === true,
      lapAssist: c.progress.lapTimes.map((_, lap) => this.racers[i].human && this.assistLaps[i]?.[lap] === true),
      gates: c.progress.gates,
      recoveries: c.progress.recoveries,
      stats: { ...c.stats },
    }))
    const sorted = [...rows].sort((a, b) => (a.finished === b.finished ? (a.finished ? a.total - b.total : b.gates - a.gates) : a.finished ? -1 : 1))
    sorted.forEach((r, k) => (r.place = k + 1))
    this.results = sorted
    for (const e of this.engines) e.silence()
    this.hooks.finished(sorted)
  }

  // ─── events → feedback ─────────────────────────────────────────────────

  private viewOf(car: number): number {
    return this.humans.indexOf(car)
  }

  private near(car: number): number {
    const c = this.sim.cars[car]
    if (!c) return 0
    let best = Infinity
    for (const h of this.humans) {
      const o = this.sim.cars[h]
      best = Math.min(best, Math.hypot(o.x - c.x, o.z - c.z))
    }
    return clamp(1 - best / 70, 0, 1)
  }

  private sfx(name: Sfx, car: number, vol = 1): void {
    if (car < 0) return this.audio.play(name, vol)
    const v = this.viewOf(car) >= 0 ? 1 : this.near(car) * 0.6
    if (v > 0.05) this.audio.play(name, vol * v)
  }

  private onEvent(e: RaceEvent): void {
    const view = this.viewOf(e.car)
    const car = e.car >= 0 ? this.sim.cars[e.car] : null
    const pop = (text: string, kind: PopupKind) => view >= 0 && this.hooks.popup(view, text, kind)
    const fx = this.fx
    switch (e.type) {
      case 'go':
        this.audio.play('go')
        this.humans.forEach((_, v) => this.juice(v, 'go'))
        break
      case 'launchPerfect':
        pop('PERFECT START!', 'great')
        this.sfx('launchPerfect', e.car)
        this.style(view, 'launch')
        if (car) {
          fx.burst(car.x, car.y + 0.5, car.z, 24, 8, '#7ef9ff', 0.25, 0.6, 4)
          fx.shock(car.x, car.y, car.z, '#7ef9ff', 6, 0.45)
        }
        this.juice(view, 'boost', 2)
        break
      case 'launchEarly': pop('TOO EARLY — WHEELSPIN', 'bad'); this.sfx('launchEarly', e.car); break
      case 'gate':
        this.sfx('gate', e.car, 0.8)
        if (car && view >= 0) {
          fx.flash(car.x, car.y + 3, car.z, '#7ef9ff', 9, 0.25)
          fx.spray('add', car.x, car.y + 4, car.z, 18, 10, { cell: 3, life: 0.5, size: 0.5, color: '#9ff6ff', gravity: 6, drag: 1.5, stretch: 3 }, 0.2)
        }
        this.juice(view, 'gate', e.value)
        break
      case 'lap': {
        const p = car?.progress
        const lap = p ? lapOf(p) : 1
        pop(lap === LAPS ? 'FINAL LAP!' : `LAP ${lap} / ${LAPS}`, 'info')
        this.sfx(lap === LAPS ? 'finalLap' : 'lap', e.car)
        if (car && view >= 0) {
          fx.confetti(car.x, car.y + 4, car.z, lap === LAPS ? 70 : 40)
          fx.shock(car.x, car.y, car.z, lap === LAPS ? '#ff7a3a' : '#ffd23f', 10, 0.6)
          if (lap === LAPS) this.audio.setMusic('final')
        }
        this.juice(view, lap === LAPS ? 'final' : 'lap', lap)
        break
      }
      case 'finish':
        if (view >= 0) {
          this.hooks.localFinished?.(view)
          this.audio.play('finish')
          this.styles[view]?.update(99)
          this.juice(view, 'finish', car?.place)
          if (car) {
            fx.confetti(car.x, car.y + 5, car.z, 120)
            fx.flash(car.x, car.y + 3, car.z, '#fff1c4', 16, 0.35)
            fx.shock(car.x, car.y, car.z, '#ffd23f', 14, 0.8)
          }
        }
        break
      case 'dnf': pop('TIME LIMIT', 'bad'); break
      case 'pad':
        this.sfx(e.value ? 'padPerfect' : 'pad', e.car)
        if (e.value) pop('PERFECT PAD!', 'great')
        if (car) {
          const c = e.value ? '#7ef9ff' : '#ffb020'
          fx.burst(car.x, car.y + 0.3, car.z, e.value ? 26 : 14, 9, c, 0.22, 0.5, 2)
          fx.shock(car.x, car.y, car.z, c, e.value ? 8 : 5.5, 0.45)
        }
        this.style(view, e.value ? 'padPerfect' : 'pad')
        this.juice(view, 'pad', e.value ? 2 : 1)
        if (view >= 0) this.cams[view].kick(0.15)
        break
      case 'nitro':
        pop('NITRO!', 'good')
        this.sfx('nitro', e.car)
        if (car) {
          const bx = -Math.sin(car.yaw), bz = -Math.cos(car.yaw)
          fx.nitroIgnite(car.x + bx * 2.3, car.y + 0.4, car.z + bz * 2.3, bx, bz)
        }
        this.juice(view, 'nitro')
        if (view >= 0) this.cams[view].kick(0.22)
        break
      case 'nitroDenied':
        if (view >= 0) {
          this.audio.play('nitroDenied', 0.8)
          this.juice(view, 'nitroDenied', e.value)
        }
        break
      case 'power':
        pop(`POWER BANKED ${e.value ?? 1}/3`, 'good')
        this.sfx('item', e.car, 0.9)
        if (car) {
          fx.burst(car.x, car.y + 1.1, car.z, 24, 8, '#7ef9ff', 0.32, 0.65, 3, 'glow', 3)
          fx.shock(car.x, car.y + 0.6, car.z, '#d8fdff', 5.5, 0.35)
        }
        this.juice(view, 'power', e.value)
        break
      case 'powerBoost':
        pop('POWER BOOST!', 'great')
        this.sfx('boost', e.car, 1.1)
        if (car) {
          const bx = -Math.sin(car.yaw), bz = -Math.cos(car.yaw)
          fx.nitroIgnite(car.x + bx * 2.3, car.y + 0.4, car.z + bz * 2.3, bx, bz)
          fx.shock(car.x, car.y + 0.4, car.z, '#ffd23f', 8, 0.42)
        }
        this.juice(view, 'powerBoost')
        if (view >= 0) this.cams[view].kick(0.3)
        break
      case 'corkEnter':
        pop('CORKSCREW!', 'great')
        this.sfx('cork', e.car)
        if (car) fx.corkRing(car.x, car.y, car.z, Math.sin(car.yaw), Math.cos(car.yaw), '#ffd23f')
        this.juice(view, 'cork', 1)
        if (view >= 0) this.cams[view].kick(0.12)
        break
      case 'corkExit':
        this.style(view, 'cork')
        this.sfx('land', e.car, 0.5)
        if (car) {
          fx.corkRing(car.x, car.y, car.z, Math.sin(car.yaw), Math.cos(car.yaw), '#7ef9ff')
          fx.burst(car.x, car.y + 0.3, car.z, 16, 7, '#ffd23f', 0.24, 0.5, 3)
        }
        this.juice(view, 'cork', 2)
        break
      case 'corkFall':
        pop('TOO SLOW — FELL OFF!', 'bad')
        this.sfx('crunch', e.car, 0.6)
        if (car) fx.burst(car.x, car.y, car.z, 14, 6, '#ffb020', 0.22, 0.5, 8)
        this.juice(view, 'warn')
        break
      case 'driftStart': break
      case 'driftTier':
        this.sfx('driftTier', e.car, 0.7)
        if (car) {
          const bx = car.x - Math.sin(car.yaw) * 1.8, bz = car.z - Math.cos(car.yaw) * 1.8
          fx.flash(bx, car.y + 0.4, bz, tierColor(e.value ?? 1), 3.5, 0.2)
          fx.shock(bx, car.y, bz, tierColor(e.value ?? 1), 3.2, 0.35)
        }
        this.juice(view, 'tier', e.value)
        break
      case 'driftBoost': {
        const names = ['', 'MINI-TURBO', 'SUPER TURBO', 'ULTRA TURBO']
        pop(names[e.value ?? 1] ?? 'TURBO', (e.value ?? 1) >= 3 ? 'great' : 'good')
        this.sfx('boost', e.car)
        if (car) {
          const c = tierColor(e.value ?? 1)
          const bx = car.x - Math.sin(car.yaw) * 2.2, bz = car.z - Math.cos(car.yaw) * 2.2
          fx.burst(bx, car.y + 0.5, bz, 18 + (e.value ?? 1) * 6, 7, c, 0.25, 0.45, 2)
          fx.shock(bx, car.y, bz, c, 5 + (e.value ?? 1) * 1.5, 0.45)
        }
        this.style(view, (['drift1', 'drift1', 'drift2', 'drift3'] as const)[e.value ?? 1] ?? 'drift1')
        this.juice(view, 'boost', e.value)
        if (view >= 0) this.cams[view].kick(0.1 + (e.value ?? 1) * 0.05)
        break
      }
      case 'driftLost': break
      case 'launch':
        this.sfx('land', e.car, 0.5)
        if (e.other === 1) {
          pop('MEGA RAMP — SEND IT!', 'great')
          this.sfx('boost', e.car, 0.9)
          this.style(view, 'air')
          if (car) {
            fx.burst(car.x, car.y + 0.4, car.z, 30, 10, '#ffb020', 0.3, 0.6, 6)
            fx.shock(car.x, car.y, car.z, '#ffb020', 10, 0.55)
          }
          this.juice(view, 'boost', 2)
          if (view >= 0) this.cams[view].kick(0.35)
        }
        break
      case 'crest':
        if (car && view >= 0 && (e.value ?? 0) > 45) {
          fx.burst(car.x, car.y + 0.1, car.z, 10, 4, '#d9b48a', 0.5, 0.7, 1, 'dust')
          this.cams[view].kick(0.12)
        }
        break
      case 'damage': {
        const hard = (e.value ?? 0) >= DAMAGE_FIRE
        this.sfx('crunch', e.car, 0.9)
        if (car) {
          fx.debris(car.x, car.y + 0.8, car.z, 8 + Math.round((e.value ?? 0) * 12), car.vx, car.vz)
          fx.burst(car.x, car.y + 0.7, car.z, 18, 10, '#ffcf6b', 0.16, 0.45, 12, 'glow', 3)
        }
        if (view >= 0) {
          this.cams[view].kick(0.35 + (e.value ?? 0) * 0.4)
          this.juice(view, 'damage', e.value)
          if (hard) this.styles[view]?.break()
        }
        break
      }
      case 'smoking':
        pop('ENGINE DAMAGED!', 'warn')
        break
      case 'onFire':
        pop('ON FIRE — ONE MORE HIT AND YOU BLOW!', 'bad')
        this.sfx('ignite', e.car)
        if (car) fx.fire(car.x, car.y + 1, car.z, car.vx, car.vz, 2)
        break
      case 'explode':
        pop('WRECKED!', 'bad')
        this.sfx('wreck', e.car)
        if (car) fx.wreckBlast(car.x, car.y, car.z, car.vx, car.vz)
        this.humans.forEach((h, v) => {
          const o = this.sim.cars[h]
          const d = car ? Math.hypot(o.x - car.x, o.z - car.z) : 999
          if (h === e.car) this.cams[v].kick(1.4)
          else if (d < 60) this.cams[v].kick(1.1 * (1 - d / 60))
        })
        if (view >= 0) {
          this.styles[view]?.break()
          this.juice(view, 'wreck')
        }
        break
      case 'holdGo':
        pop('GO!', 'great')
        if (view >= 0) this.sfx('go', e.car, 0.8)
        if (car) {
          fx.shock(car.x, car.y, car.z, '#7ef9ff', 8, 0.45)
          fx.burst(car.x, car.y + 0.6, car.z, 20, 7, '#7ef9ff', 0.25, 0.5, 3)
        }
        this.juice(view, 'go')
        break
      case 'trickStart': this.sfx('trick', e.car); break
      case 'trick': break
      case 'trickLand': {
        const n = e.value ?? 1
        pop(n > 1 ? `TRICK ×${n}!` : 'TRICK LANDED!', 'great')
        this.sfx('trickLand', e.car)
        if (car) {
          fx.burst(car.x, car.y + 0.8, car.z, 22 + n * 6, 7, '#ffd23f', 0.28, 0.6, 4)
          fx.shock(car.x, car.y, car.z, '#ffd23f', 8, 0.55)
          fx.burst(car.x, car.y + 0.2, car.z, 12, 5, '#d9b48a', 0.6, 0.9, 1, 'dust')
        }
        this.style(view, 'trick', n)
        this.juice(view, 'boost', 1)
        break
      }
      case 'crash':
        pop('SLOPPY LANDING', 'bad')
        this.sfx('crash', e.car)
        if (view >= 0) this.styles[view]?.break()
        this.juice(view, 'hit')
        if (car) fx.burst(car.x, car.y + 0.4, car.z, 20, 6, '#c7925d', 0.6, 0.9, 3, 'dust')
        if (view >= 0) this.cams[view].kick(0.6)
        break
      case 'land':
        if ((e.value ?? 0) > 0.3) {
          this.sfx('land', e.car, e.value)
          if (car) {
            fx.burst(car.x, car.y + 0.2, car.z, 14, 5, '#d9b48a', 0.6, 0.9, 1, 'dust')
            fx.rings.spawn(car.x, car.y + 0.1, car.z, 1, 6 + (e.value ?? 0) * 4, 0.5, '#ffe2b8')
          }
          if (view >= 0) this.cams[view].kick((e.value ?? 0) * 0.4)
          if ((e.value ?? 0) > 0.6) this.style(view, 'air')
          this.juice(view, 'land', e.value)
        }
        break
      case 'rough': break
      case 'wall':
        this.sfx('wall', e.car, clamp((e.value ?? 5) / 15, 0.3, 1))
        if (car) {
          const wx = car.x + car.loc.rx * Math.sign(car.loc.d) * 1.2, wz = car.z + car.loc.rz * Math.sign(car.loc.d) * 1.2
          fx.burst(wx, car.y + 0.5, wz, 16, 9, '#ffcf6b', 0.14, 0.4, 12, 'glow', 3)
          fx.burst(wx, car.y + 0.4, wz, 6, 3, '#cfa27a', 0.5, 0.8, 1, 'dust')
        }
        if (view >= 0) {
          this.cams[view].kick(0.2)
          if ((e.value ?? 0) > 12) this.styles[view]?.break()
        }
        this.juice(view, 'wall', e.value)
        break
      case 'unanchored':
        pop('TOO SLOW — LOSING THE WALL!', 'warn')
        this.sfx('warn', e.car, 0.7)
        if (car) fx.burst(car.x, car.y + 0.3, car.z, 12, 4, '#cfa27a', 0.6, 0.9, 1, 'dust')
        this.juice(view, 'warn')
        break
      case 'peel':
        pop('PEELED OFF THE WALL!', 'bad')
        this.sfx('crunch', e.car, 0.6)
        if (car) {
          fx.burst(car.x, car.y + 0.4, car.z, 22, 7, '#d8b08a', 0.8, 1.2, 1, 'dust')
          fx.burst(car.x, car.y + 0.5, car.z, 14, 10, '#ffcf6b', 0.12, 0.35, 14, 'glow', 3)
        }
        if (view >= 0) {
          this.cams[view].kick(0.45)
          this.styles[view]?.break()
        }
        this.juice(view, 'wall', 14)
        break
      case 'bump':
        this.sfx('bump', e.car)
        if (view >= 0) this.cams[view].kick(0.2)
        break
      case 'draft': pop('SLIPSTREAM', 'good'); this.sfx('draft', e.car); this.style(view, 'draft'); break
      case 'box':
        this.sfx('box', e.car)
        if (car) {
          fx.burst(car.x, car.y + 1.3, car.z, 20, 7, '#ff8ad9', 0.3, 0.5, 6)
          fx.flash(car.x, car.y + 1.3, car.z, '#ffb3ec', 5, 0.2)
        }
        break
      case 'item': {
        const names = ['SEEKER', 'DUST MINE', 'SHIELD', 'NITRO CANISTER']
        pop(`GOT ${names[e.value ?? 0]}`, 'info')
        this.sfx('item', e.car)
        this.juice(view, 'item', e.value)
        break
      }
      case 'useCanister': this.sfx('canister', e.car); break
      case 'useShield':
        this.sfx('shield', e.car)
        this.models[e.car]?.flashShield()
        if (car) fx.shock(car.x, car.y, car.z, '#6ff3ff', 5, 0.4)
        break
      case 'useMine': this.sfx('mine', e.car); break
      case 'useSeeker': this.sfx('seeker', e.car); break
      case 'seekerLock': {
        const tv = this.viewOf(e.car)
        if (tv >= 0) this.hooks.popup(tv, 'SEEKER LOCKED — SWITCH LANES!', 'warn')
        this.sfx('lock', e.car)
        this.juice(tv, 'warn')
        break
      }
      case 'dodged': pop('DODGED!', 'great'); this.sfx('dodge', e.car); this.style(view, 'dodge'); break
      case 'blocked':
        pop('BLOCKED!', 'good')
        this.sfx('blocked', e.car)
        this.models[e.car]?.flashShield()
        if (car) {
          fx.burst(car.x, car.y + 1, car.z, 30, 10, '#7ef9ff', 0.25, 0.5, 2)
          fx.shock(car.x, car.y, car.z, '#7ef9ff', 7, 0.45)
        }
        this.style(view, 'block')
        this.juice(view, 'block')
        break
      case 'hit':
        pop('HIT!', 'bad')
        this.sfx('hit', e.car)
        if (car) fx.explosion(car.x, car.y, car.z)
        if (view >= 0) {
          this.cams[view].kick(0.8)
          this.styles[view]?.break()
        }
        this.juice(view, 'hit')
        {
          const ov = this.viewOf(e.other ?? -1)
          if (ov >= 0) this.hooks.popup(ov, 'DIRECT HIT!', 'good')
        }
        break
      case 'fizzle': this.sfx('fizzle', e.car); break
      case 'recoverStart':
        pop(`RESET — ${RECOVERY_PENALTY.toFixed(0)} s HOLD`, 'bad')
        this.sfx('recover', e.car)
        break
      case 'recovered':
        pop(e.value ? 'RESPAWNED — HOLD FOR 3' : 'BACK ON TRACK — HOLD FOR 3', 'info')
        this.sfx('recover', e.car, 0.7)
        if (car) {
          fx.burst(car.x, car.y + 1, car.z, 22, 5, '#7ef9ff', 0.25, 0.6, 0)
          fx.shock(car.x, car.y, car.z, '#7ef9ff', 6, 0.5)
          fx.flash(car.x, car.y + 1, car.z, '#bdfaff', 6, 0.3)
        }
        break
      case 'raceOver': break
    }
  }

  // ─── rendering ─────────────────────────────────────────────────────────

  render(alpha: number, dt: number): View[] {
    this.time += dt
    const sim = this.sim
    if (this.ending >= 0 && !this.done && !this.paused) {
      this.ending += dt
      if (this.ending > ENDING_DELAY) this.finish()
    }
    // Countdown beeps.
    if (sim.phase === 'countdown' && !this.paused) {
      const c = Math.ceil(sim.countdown)
      if (c < this.lastCount && c >= 1) {
        this.audio.play('count')
        this.humans.forEach((_, v) => this.juice(v, 'count', c))
      }
      this.lastCount = c
    }
    const a = this.paused ? 1 : alpha
    for (let i = 0; i < sim.cars.length; i += 1) {
      const car = sim.cars[i]
      const p = this.prev[i]
      const q = this.curr[i]
      const x = lerp(p.x, q.x, a), y = lerp(p.y, q.y, a), z = lerp(p.z, q.z, a)
      const yaw = p.yaw + wrapAngle(q.yaw - p.yaw) * a
      const bank = this.track.bank[car.loc.i] ?? 0
      const pitch = car.grounded ? -Math.atan(car.loc.slope) : -Math.atan2(car.vy, Math.max(8, Math.abs(car.vF))) * 0.6
      const roll = car.grounded ? Math.atan(bank) * (Math.cos(wrapAngle(car.yaw - this.track.heading[car.loc.i])) > 0 ? -1 : 1) : 0
      this.models[i].pose(x, y, z, yaw, car, this.paused ? 0 : dt, this.time, pitch, roll)
      if (car.cork >= 0) {
        const cf = this.track.corkFrame(this.track.corks[car.cork], car.loc.s, car.loc.d, this.cf)
        this.models[i].orient(cf.fx, cf.fy, cf.fz, cf.nx, cf.ny, cf.nz)
      }
      if (!this.paused && !this.done) this.effectsFor(car, i, dt)
      const eng = this.engines[i]
      if (this.done || this.paused) eng.silence()
      else {
        const isHuman = this.viewOf(i) >= 0
        const vol = isHuman ? (this.humans.length > 1 ? 0.7 : 1) : this.near(i)
        eng.update(Math.abs(car.vF), this.inputs[i].throttle, car.boostTime > 0 || car.meterBoosting || car.powerBoosting, car.drift, car.grounded, 0, vol)
      }
    }
    this.renderGhosts(dt)
    if (!this.paused && !this.done) {
      this.humans.forEach((h, v) => {
        this.styles[v].update(dt)
        // Anchored wall rides (> ~45° bank, holding grip) score WALL RIDE when the wall ends.
        const hc = this.sim.cars[h]
        const steepNow = hc.grounded && Math.abs(this.track.bank[hc.loc.i] ?? 0) > 1 && hc.slip < 0.05
        if (steepNow) this.wallRide[v] += dt
        else if (Math.abs(this.track.bank[hc.loc.i] ?? 0) < 0.6 || !hc.grounded || hc.slip > 0.25) {
          if (this.wallRide[v] > 1.2) this.style(v, 'wall', Math.min(3, Math.floor(this.wallRide[v] / 1.5) + 1))
          this.wallRide[v] = 0
        }
        const car = sim.cars[h]
        const was = this.lastPlace[v]
        if (sim.phase !== 'countdown' && !car.progress.finished && car.place !== was) {
          if (car.place < was) {
            this.hooks.popup(v, car.place === 1 ? 'TAKE THE LEAD!' : 'OVERTAKE!', 'good')
            this.audio.play('overtake', 0.8)
            this.style(v, 'overtake')
          }
          this.juice(v, 'place', car.place)
        }
        this.lastPlace[v] = car.place
        // Respawn hold countdown ticks (3, 2, 1) for the local driver.
        const hn = car.hold > 0 ? Math.ceil(car.hold) : 0
        if (hn > 0 && hn !== this.lastHold[v]) {
          this.audio.play('count', 0.8)
          this.juice(v, 'hold', hn)
        }
        this.lastHold[v] = hn
        // Nitro recharged.
        if (car.meter >= 1 && this.lastMeter[v] < 1 && car.nitro <= 0 && sim.phase !== 'countdown') {
          this.audio.play('nitroReady', 0.8)
          this.juice(v, 'nitroReady')
        }
        this.lastMeter[v] = car.meter
      })
    }
    if (!this.paused) this.fx.update(dt)
    this.fx.syncItems(sim, this.time)
    this.world.update(this.time, sim)
    const views: View[] = []
    const n = this.cams.length
    this.cams.forEach((cam, v) => {
      const h = this.humans[v]
      const m = this.models[h].root
      const car = sim.cars[h]
      cam.reducedMotion = this.reducedMotion
      if (!this.paused) cam.update(dt, m.position.x, m.position.y, m.position.z, this.models[h].yaw, car, this.track)
      const gate = car.progress.finished ? -1 : nextGateIndex(car.progress)
      views.push({
        camera: cam.camera,
        x: 0,
        y: n > 1 ? (v === 0 ? 0.5 : 0) : 0,
        w: 1,
        h: n > 1 ? 0.5 : 1,
        before: () => {
          this.world.setHighlight(gate)
          this.world.focus(car.x, car.y, car.z)
          this.models.forEach((mm, k) => (mm.tag.visible = k !== h))
        },
      })
    })
    return views
  }

  /** Damage smoke/fire emits at a fixed 60 bursts per second regardless of display refresh. */
  private readonly dmgAcc: number[] = []
  private effectsFor(car: CarState, i: number, dt: number): void {
    const fx = this.fx
    const model = this.models[i]
    const fwdX = Math.sin(car.yaw), fwdZ = Math.cos(car.yaw)
    // Local +X of the model in world space.
    const lx = Math.cos(car.yaw), lz = -Math.sin(car.yaw)
    const rx = -Math.cos(car.yaw), rz = Math.sin(car.yaw)
    // Wheel-anchored emitters follow the road's cross-slope so particles sit on steep banks.
    const tilt = car.grounded ? this.track.bank[car.loc.i] ?? 0 : 0
    const onCork = car.cork >= 0
    if (onCork) model.root.updateMatrixWorld()
    const at = (p: THREE.Vector3) => {
      // On a corkscrew the car is fully rolled: use the model's real transform.
      if (onCork) return this.tmpV.copy(p).applyMatrix4(model.root.matrixWorld)
      const ox = lx * p.x + fwdX * p.z, oz = lz * p.x + fwdZ * p.z
      return this.tmpV.set(car.x + ox, car.y + p.y + tilt * (ox * car.loc.rx + oz * car.loc.rz), car.z + oz)
    }
    const speed = Math.abs(car.vF)
    const human = this.viewOf(i) >= 0
    if (car.drift && car.grounded) {
      for (const w of model.rearWheels) {
        const p = at(w)
        fx.driftSparks(p.x, p.y + 0.1, p.z, car.vx, car.vz, car.driftTier)
        fx.tyreSmoke(p.x, p.y, p.z, car.vx, car.vz, car.loc.onRoad ? 0.55 : 0.2)
      }
    }
    if (car.grounded && car.slip > 0.1) {
      for (const w of model.rearWheels) {
        const p = at(w)
        fx.tyreSmoke(p.x, p.y, p.z, car.vx, car.vz, Math.min(0.9, 0.3 + car.slip), '#e9dccb')
      }
    }
    if (car.grounded && !car.loc.onRoad && speed > 6) {
      for (const w of model.rearWheels) {
        const p = at(w)
        fx.dustTrail(p.x, p.y, p.z, Math.min(0.9, speed / 40))
      }
    }
    if (car.wheelspin > 0 && car.grounded) {
      for (const w of model.rearWheels) {
        const p = at(w)
        fx.tyreSmoke(p.x, p.y, p.z, 0, 0, 0.7, '#e6ddd2')
      }
    }
    const boosting = car.boostTime > 0 || car.meterBoosting || car.powerBoosting
    if (car.nitro > 0 && car.wreck <= 0) {
      // Nitro jets point straight out of the pipes (rolled with the car on corkscrews).
      const fresh = clamp((car.nitro - (CONFIG.car.nitroTime - 0.35)) / 0.35, 0, 1)
      let bx = -fwdX, by = 0, bz = -fwdZ
      if (onCork) {
        const q = model.root.quaternion
        const b = this.tmpM.set(0, 0, -1).applyQuaternion(q)
        bx = b.x; by = b.y; bz = b.z
      }
      for (const e of model.exhausts) {
        const p = at(e)
        fx.nitroJet(p.x, p.y, p.z, bx, by, bz, car.vx, car.vy * (onCork ? 1 : 0), car.vz, fresh)
      }
    } else if (boosting) {
      for (const e of model.exhausts) {
        const p = at(e)
        fx.exhaust(p.x, p.y, p.z, -fwdX, 0, -fwdZ, car.meterBoosting || car.powerBoosting)
      }
    }
    if (human && !onCork && (boosting || speed > 52) && Math.random() < (boosting ? 0.85 : 0.35)) {
      const side = (Math.random() - 0.5) * 8
      const up = Math.random() * 3.4
      fx.streak(car.x + rx * side + fwdX * 7, car.y + up, car.z + rz * side + fwdZ * 7, -fwdX * 34 + car.vx * 0.6, 0, -fwdZ * 34 + car.vz * 0.6, car.meterBoosting ? '#9ff6ff' : car.powerBoosting ? '#ffd23f' : boosting ? '#ffd08a' : '#fff6e8')
    }
    // Damage: smoke from the engine bay, then fire; burning wreck; respawn beacon while holding.
    if (car.wreck > 0 || car.damage >= DAMAGE_SMOKE) {
      this.dmgAcc[i] = Math.min(4, (this.dmgAcc[i] ?? 0) + dt * 60)
      while (this.dmgAcc[i] >= 1) {
        this.dmgAcc[i] -= 1
        const L = model.length
        const hx = car.x + fwdX * L * 0.28, hz = car.z + fwdZ * L * 0.28
        if (car.wreck > 0) {
          fx.fire(car.x + (Math.random() - 0.5) * 2, car.y + 1.1, car.z + (Math.random() - 0.5) * 3, 0, 0, 1.6)
          if (Math.random() < 0.6) fx.engineSmoke(car.x, car.y + 2, car.z, 0, 0, 1)
        } else {
          const heavy = car.damage >= DAMAGE_FIRE ? 1 : clamp((car.damage - DAMAGE_SMOKE) / (DAMAGE_FIRE - DAMAGE_SMOKE), 0, 1) * 0.5
          fx.engineSmoke(hx, car.y + 1.2, hz, car.vx, car.vz, heavy)
          if (car.damage >= DAMAGE_FIRE) fx.fire(hx, car.y + 1.25, hz, car.vx, car.vz, 1.3)
          else if (Math.random() < 0.08) fx.burst(hx, car.y + 0.9, hz, 3, 4, '#ffcf6b', 0.12, 0.3, 10, 'glow', 2)
        }
      }
    } else this.dmgAcc[i] = 0
    if (car.hold > 0 && Math.floor(this.time * 2) !== Math.floor((this.time - 1 / 60) * 2)) {
      fx.shock(car.x, car.y, car.z, '#7ef9ff', 4.5, 0.5)
    }
    if (car.drafting && Math.random() < 0.6) {
      const side = (Math.random() - 0.5) * 3
      fx.streak(car.x + rx * side + fwdX * 3, car.y + 0.6 + Math.random() * 1.5, car.z + rz * side + fwdZ * 3, car.vx * 0.5 - fwdX * 20, 0, car.vz * 0.5 - fwdZ * 20, '#ffffff')
    }
  }

  private renderGhosts(dt: number): void {
    const link = this.online
    if (!link) return
    const frames = link.ghostFrames()
    const tick = this.sim.tick - GHOST_DELAY_TICKS
    for (const [seat, list] of frames) {
      if (seat === link.seat || list.length === 0) continue
      let g = this.ghosts.get(seat)
      if (!g) {
        const prof = link.ghostProfile(seat) ?? { name: `Racer ${seat + 1}`, chassis: seat % 5, livery: seat % 6 }
        g = new GhostCar(seat, prof.name, prof.chassis, prof.livery)
        this.ghosts.set(seat, g)
        this.group.add(g.model.root)
      }
      let a = list[0]
      let b = list[list.length - 1]
      for (let k = 0; k < list.length - 1; k += 1) {
        if (list[k].tick <= tick && list[k + 1].tick >= tick) {
          a = list[k]
          b = list[k + 1]
          break
        }
      }
      let x: number, y: number, z: number, yaw: number
      if (b.tick > a.tick && tick <= b.tick) {
        const t = clamp((tick - a.tick) / (b.tick - a.tick), 0, 1)
        x = lerp(a.x, b.x, t); y = lerp(a.y, b.y, t); z = lerp(a.z, b.z, t)
        yaw = a.yaw + wrapAngle(b.yaw - a.yaw) * t
      } else {
        // Dead-reckon from the newest frame (≤0.6 s) along its speed and turn rate.
        const last = list[list.length - 1]
        const prev = list.length > 1 ? list[list.length - 2] : last
        const span = Math.max(1, last.tick - prev.tick)
        const rate = last === prev || last.f & 8 ? 0 : clamp(wrapAngle(last.yaw - prev.yaw) / span, -0.05, 0.05)
        const ahead = clamp(tick - last.tick, 0, 36)
        x = last.x; y = last.y; z = last.z; yaw = last.yaw
        for (let k = 0; k < ahead; k += 3) {
          const step = Math.min(3, ahead - k)
          yaw += rate * step
          x += Math.sin(yaw) * last.v * (step / 60)
          z += Math.cos(yaw) * last.v * (step / 60)
        }
        if (ahead > 0 && prev !== last) y = last.y + ((last.y - prev.y) / span) * Math.min(ahead, 12)
        b = last
      }
      // Smooth corrections so new frames never snap the ghost.
      const s = this.ghostSmooth.get(seat)
      if (!s || Math.hypot(s.x - x, s.z - z) > 25) this.ghostSmooth.set(seat, { x, y, z, yaw })
      else {
        const k = 1 - Math.exp(-dt * 14)
        s.x += (x - s.x) * k; s.y += (y - s.y) * k; s.z += (z - s.z) * k
        s.yaw += wrapAngle(yaw - s.yaw) * k
      }
      const p = this.ghostSmooth.get(seat)!
      g.model.pose(p.x, p.y, p.z, p.yaw, null, dt, this.time, 0, 0)
      for (const f of g.model.flames) f.visible = (b.f & 2) !== 0
      g.model.root.visible = !(b.f & 64)
    }
  }

  /** Per-view HUD numbers. */
  hud(view: number): { car: CarState; lap: number; gate: number; place: number; total: number; countdown: number; clock: number; bestLap: number; lastLap: number; gatesDone: number } {
    const h = this.humans[view]
    const car = this.sim.cars[h]
    const p = car.progress
    let place = car.place
    let total = this.sim.cars.length
    if (this.online) {
      // Online places come from ghost progress (presentation only).
      const frames = this.online.ghostFrames()
      total = 1
      for (const [seat, list] of frames) {
        if (seat === this.online.seat || !list.length) continue
        total += 1
      }
      place = this.onlinePlace()
    }
    return {
      car,
      lap: lapOf(p),
      gate: nextGateIndex(p) + 1,
      place,
      total,
      countdown: this.sim.countdown,
      clock: p.finished ? p.finishTime : Math.max(0, this.sim.clock),
      bestLap: bestLap(p),
      lastLap: p.lapTimes.length ? p.lapTimes[p.lapTimes.length - 1] : 0,
      gatesDone: p.gates,
    }
  }

  private onlinePlace(): number {
    const link = this.online!
    const me = this.sim.cars[0]
    let place = 1
    for (const [seat, list] of link.ghostFrames()) {
      if (seat === link.seat || !list.length) continue
      const g = list[list.length - 1]
      if (g.gates > me.progress.gates) place += 1
    }
    return place
  }

  /** Minimap markers: [x, z, colorIndex, isHuman]. */
  markers(): { x: number; z: number; livery: number; human: boolean; ghost: boolean }[] {
    const out = this.sim.cars.map((c, i) => ({ x: c.x, z: c.z, livery: this.racers[i].livery, human: this.racers[i].human, ghost: false }))
    if (this.online) {
      for (const [seat, list] of this.online.ghostFrames()) {
        if (seat === this.online.seat || !list.length) continue
        const f = list[list.length - 1]
        const prof = this.online.ghostProfile(seat)
        out.push({ x: f.x, z: f.z, livery: prof?.livery ?? 0, human: false, ghost: true })
      }
    }
    return out
  }

  get totalGates(): number {
    return TOTAL_GATES
  }

  /** Remove everything this session added to the shared world. */
  dispose(): void {
    this.world.scene.remove(this.group)
    this.fx.clear()
    for (const m of this.models) m.dispose()
    for (const g of this.ghosts.values()) g.model.dispose()
    for (const e of this.engines) e.dispose()
    this.world.setHighlight(-1)
  }

  get elapsed(): number {
    return this.time
  }

  get ticks(): number {
    return this.sim.tick
  }

  modIndex(i: number): number {
    return mod(i, this.sim.cars.length)
  }
}
