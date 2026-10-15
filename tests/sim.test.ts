import { describe, expect, it } from 'vitest'
import { AiDriver } from '../src/sim/ai'
import { DURABILITY, applyDamage, DAMAGE_FIRE, DAMAGE_SMOKE, HOLD_TIME, idleInput, WRECK_TIME, type CarInput } from '../src/sim/car'
import { RaceSim } from '../src/sim/race'
import { addRecoveryPenalty, applyTimeLimit, compareStandings, crossesForward, MAX_RACE_TIME, newProgress, passGate, TOTAL_GATES, totalTime } from '../src/sim/rules'
import { Track } from '../src/sim/track'
import { CANYON_CIRCUIT, DEFAULT_LAB, generateLabTrack } from '../src/sim/tracks'

const track = new Track(CANYON_CIRCUIT)

function runAiRace(seed: number, t = track, items = true, maxSteps = 60 * 320) {
  const sim = new RaceSim({ track: t, cars: 3, seed, items })
  const ai = sim.cars.map((_, i) => new AiDriver(i, i === 0 ? 'relaxed' : 'pro', seed))
  const events: Record<string, number> = {}
  for (let k = 0; k < maxSteps && sim.phase !== 'finished'; k += 1) {
    sim.step(ai.map(a => a.think(sim)))
    for (const e of sim.drainEvents()) events[e.type] = (events[e.type] ?? 0) + 1
  }
  return { sim, events }
}

describe('race rules', () => {
  it('counts only forward crossings of the next gate', () => {
    expect(crossesForward(99, 2, 100, 1000)).toBe(true)
    expect(crossesForward(101, -2, 100, 1000)).toBe(false)
    expect(crossesForward(995, 10, 0, 1000)).toBe(true)
    expect(crossesForward(90, 5, 100, 1000)).toBe(false)
  })

  it('finishes on the 48th gate, counts recoveries and applies the time limit', () => {
    const p = newProgress()
    addRecoveryPenalty(p)
    for (let g = 1; g < TOTAL_GATES; g += 1) expect(passGate(p, g)).not.toBe('finish')
    expect(p.lapTimes).toHaveLength(2)
    expect(passGate(p, 200)).toBe('finish')
    expect(p.recoveries).toBe(1)
    expect(totalTime(p)).toBe(200)
    expect(passGate(p, 201)).toBe('none')
    const late = newProgress()
    expect(applyTimeLimit(late, MAX_RACE_TIME - 0.01)).toBe(false)
    expect(applyTimeLimit(late, MAX_RACE_TIME)).toBe(true)
    expect(late.dnf).toBe(true)
  })

  it('ranks finishers by total time including penalties', () => {
    const a = newProgress(); a.finished = true; a.finishTime = 150; a.penalty = 6
    const b = newProgress(); b.finished = true; b.finishTime = 154
    const c = newProgress(); c.gates = 40
    const list = [{ id: 0, progress: a, toNext: 0 }, { id: 1, progress: b, toNext: 0 }, { id: 2, progress: c, toNext: 5 }]
    list.sort(compareStandings)
    expect(list.map(s => s.id)).toEqual([1, 0, 2])
  })
})

describe('race simulation', () => {
  it('is deterministic for identical seeds and inputs', () => {
    const a = runAiRace(7, track, true, 60 * 40)
    const b = runAiRace(7, track, true, 60 * 40)
    expect(a.sim.digest()).toBe(b.sim.digest())
    const c = runAiRace(8, track, true, 60 * 40)
    expect(c.sim.digest()).not.toBe(a.sim.digest())
  })

  it('lets three AI rivals complete all 48 gates well inside 300 seconds', () => {
    const { sim, events } = runAiRace(3)
    const summary = sim.cars.map(c => ({ gates: c.progress.gates, time: c.progress.finishTime.toFixed(1), pen: c.progress.penalty, laps: c.progress.lapTimes.map(t => t.toFixed(1)).join('/'), top: c.stats.topSpeed.toFixed(1), drifts: c.stats.driftBoosts, pads: c.stats.pads, tricks: c.stats.tricks, walls: c.stats.wallHits, hits: c.stats.hits }))
    console.info(JSON.stringify(summary), JSON.stringify(events))
    for (const c of sim.cars) {
      expect(c.progress.finished).toBe(true)
      expect(c.progress.gates).toBe(TOTAL_GATES)
      expect(c.progress.finishTime).toBeLessThan(260)
    }
  })

  it('completes generated Track Lab layouts', () => {
    for (const seed of [11, 222]) {
      const { track: lab } = generateLabTrack({ ...DEFAULT_LAB, seed })
      const { sim } = runAiRace(seed, lab, false)
      console.info('lab', seed, lab.length.toFixed(0), sim.cars.map(c => `${c.progress.gates}:${c.progress.finishTime.toFixed(1)}+${c.progress.penalty}`).join(' '))
      for (const c of sim.cars) expect(c.progress.finished).toBe(true)
    }
  })

  it('serves the 3 s recovery penalty as a hold and never places a recovered car past its next gate', () => {
    const sim = new RaceSim({ track, cars: 1, seed: 1, items: false })
    const go: CarInput = { ...idleInput(), throttle: 1 }
    for (let k = 0; k < 60 * 6; k += 1) sim.step([go])
    const car = sim.cars[0]
    const gatesBefore = car.progress.gates
    sim.step([{ ...go, recover: true }])
    for (let k = 0; k < 60; k += 1) sim.step([go])
    expect(car.progress.penalty).toBe(0)
    expect(car.progress.recoveries).toBe(1)
    expect(car.progress.gates).toBe(gatesBefore)
    expect(car.recovering).toBeLessThanOrEqual(0)
    expect(car.hold).toBeGreaterThan(1.5)
    expect(car.hold).toBeLessThanOrEqual(HOLD_TIME)
    expect(Math.hypot(car.vx, car.vz)).toBe(0)
    expect(Math.abs(car.loc.d)).toBeLessThan(car.loc.halfW)
    const odo = car.odo
    for (let k = 0; k < 60 * 3; k += 1) sim.step([go])
    expect(car.hold).toBe(0)
    for (let k = 0; k < 60 * 2; k += 1) sim.step([go])
    expect(car.odo).toBeGreaterThan(odo + 5)
  })
  it('smokes, burns, then wrecks and respawns in place after the hold', () => {
    const sim = new RaceSim({ track, cars: 1, seed: 1, items: false })
    const go: CarInput = { ...idleInput(), throttle: 1 }
    for (let k = 0; k < 60 * 6; k += 1) sim.step([go])
    const car = sim.cars[0]
    sim.drainEvents()
    const ev: string[] = []
    applyDamage(car, 0.1, ev as never, 1)
    // Cars are 2x durable: every hit deals amount / DURABILITY.
    expect(car.damage).toBeCloseTo(0.1 / DURABILITY, 6)
    applyDamage(car, (DAMAGE_SMOKE + 0.01) * DURABILITY - 0.1, ev as never, 1)
    applyDamage(car, (DAMAGE_FIRE - DAMAGE_SMOKE) * DURABILITY, ev as never, 1)
    expect(car.damage).toBeGreaterThanOrEqual(DAMAGE_FIRE)
    expect(car.wreck).toBe(0)
    const events: { type: string }[] = []
    applyDamage(car, 0.5 * DURABILITY, events as never, 1)
    expect(events.map(e => e.type)).toContain('explode')
    expect(car.wreck).toBeGreaterThan(0)
    const s0 = car.loc.s
    for (let k = 0; k < Math.ceil(WRECK_TIME * 60) + 2; k += 1) sim.step([go])
    expect(car.wreck).toBeLessThanOrEqual(0)
    expect(car.hold).toBeGreaterThan(HOLD_TIME - 0.2)
    expect(car.damage).toBe(0)
    expect(Math.abs(car.loc.s - s0)).toBeLessThan(40)
    expect(car.progress.recoveries).toBe(1)
    expect(car.stats.wrecks).toBe(1)
  })
  it('launches cars into big air over crests and mega ramps', () => {
    const { sim } = runAiRace(3)
    for (const c of sim.cars) expect(c.stats.airTime).toBeGreaterThan(20)
    expect(sim.track.ramps.some(r => r.mega)).toBe(true)
  })
  it('pins fast cars through boost-fed corkscrews and drops slow ones off the ceiling', () => {
    expect(track.corks.length).toBe(2)
    for (const ck of track.corks) {
      expect(track.pads.filter(p => p.cork === ck.index).length).toBe(3)
      expect(track.pads.filter(p => p.cork < 0 && ((ck.s0 - p.s + track.length) % track.length) < 30).length).toBe(6)
    }
    const roll = (speed: number, throttle: number) => {
      const sim = new RaceSim({ track, cars: 1, seed: 1, items: false })
      while (sim.phase === 'countdown') sim.step([idleInput()])
      const car = sim.cars[0]
      const ck = track.corks[1]
      const s = ck.s0 - 6
      const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: 1, rz: 0, halfW: 0, bank: 0 }
      track.frameAt(s, f)
      car.x = f.x; car.y = f.y; car.z = f.z
      car.yaw = Math.atan2(f.tx, f.tz)
      car.vx = f.tx * speed; car.vz = f.tz * speed; car.vy = 0
      car.grounded = true
      track.locate(car.x, car.y, car.z, track.sampleIndex(s), car.loc)
      const seen = new Set<string>()
      let maxY = -Infinity
      for (let k = 0; k < 60 * 6; k += 1) {
        sim.step([{ ...idleInput(), throttle }])
        maxY = Math.max(maxY, car.y - track.y[car.loc.i])
        for (const e of sim.drainEvents()) seen.add(e.type)
      }
      return { seen, maxY, car }
    }
    const fast = roll(50, 1)
    expect(fast.seen.has('corkEnter')).toBe(true)
    expect(fast.seen.has('corkExit')).toBe(true)
    expect(fast.seen.has('corkFall')).toBe(false)
    expect(fast.maxY).toBeGreaterThan(15)
    expect(fast.car.stats.corks).toBe(1)
    // Crawling in: no speed to stay on the ceiling — drops off and restarts on the run-in.
    const slow = roll(16, 0)
    expect(slow.seen.has('corkEnter')).toBe(true)
    expect(slow.seen.has('corkFall')).toBe(true)
    expect(slow.seen.has('corkExit')).toBe(false)
    expect(slow.seen.has('recoverStart')).toBe(true)
    const rel = (slow.car.loc.s - track.corks[1].s0 + track.length) % track.length
    expect(rel).toBeGreaterThan(track.length - 40)
  })

  it('fires a short Shift nitro that recharges over its cooldown', () => {
    const sim = new RaceSim({ track, cars: 1, seed: 2, items: false })
    while (sim.phase === 'countdown') sim.step([idleInput()])
    const car = sim.cars[0]
    expect(car.meter).toBe(1)
    const events: string[] = []
    const step = (boost: boolean) => { sim.step([{ ...idleInput(), throttle: 1, boost }]); for (const e of sim.drainEvents()) events.push(e.type) }
    for (let k = 0; k < 60; k += 1) step(false)
    const v0 = car.vF
    step(true)
    expect(events).toContain('nitro')
    expect(car.meter).toBe(0)
    expect(car.meterBoosting).toBe(true)
    for (let k = 0; k < 40; k += 1) step(false)
    expect(car.vF).toBeGreaterThan(v0 + 12)
    // Re-tapped during the cooldown: denied, no second burst.
    for (let k = 0; k < 50; k += 1) step(false)
    expect(car.meterBoosting).toBe(false)
    step(true)
    expect(events.filter(e => e === 'nitro').length).toBe(1)
    expect(events).toContain('nitroDenied')
    step(false)
    for (let k = 0; k < 60 * 8; k += 1) step(false)
    expect(car.meter).toBe(1)
    step(true)
    expect(events.filter(e => e === 'nitro').length).toBe(2)
  })

  it('collects a mid-race Power Cell and spends the stored charge on Power Boost', () => {
    const sim = new RaceSim({ track, cars: 1, seed: 9, items: false })
    while (sim.phase === 'countdown') sim.step([idleInput()])
    const car = sim.cars[0]
    const cell = sim.powerCells[0]
    car.x = cell.x
    car.y = cell.y - 0.8
    car.z = cell.z
    car.vx = 0
    car.vz = 0
    car.grounded = true
    track.locate(car.x, car.y, car.z, track.sampleIndex(cell.s), car.loc)
    sim.step([idleInput()])
    expect(car.power).toBe(1)
    expect(sim.drainEvents().map(e => e.type)).toContain('power')
    expect(cell.respawn).toBeGreaterThan(5)
    sim.step([{ ...idleInput(), boost: true }])
    expect(car.power).toBe(0)
    expect(car.powerBoosting).toBe(true)
    expect(car.stats.powerBoosts).toBe(1)
    expect(sim.drainEvents().map(e => e.type)).toContain('powerBoost')
    for (let k = 0; k < 60 * 2; k += 1) sim.step([idleInput()])
    expect(car.powerBoosting).toBe(false)
  })

  it('banks steep corners and magnetically holds cars on them at any speed', () => {
    let steep = 0
    let best = 0
    for (let i = 0; i < track.n; i += 1) {
      const deg = (Math.atan(Math.abs(track.bank[i])) * 180) / Math.PI
      if (deg > 50) steep += 1
      if (deg > (Math.atan(Math.abs(track.bank[best])) * 180) / Math.PI) best = i
    }
    expect(steep * track.ds).toBeGreaterThan(400)
    expect((Math.atan(Math.abs(track.bank[best])) * 180) / Math.PI).toBeGreaterThan(60)
    const ride = (speed: number, throttleCap: number, ticks = 45) => {
      const sim = new RaceSim({ track, cars: 1, seed: 1, items: false })
      while (sim.phase === 'countdown') sim.step([idleInput()])
      const car = sim.cars[0]
      const s = best * track.ds - 12
      const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: 1, rz: 0, halfW: 0, bank: 0 }
      track.frameAt(s, f)
      car.x = f.x
      car.z = f.z
      car.y = f.y
      car.yaw = Math.atan2(f.tx, f.tz)
      car.vx = f.tx * speed
      car.vz = f.tz * speed
      car.vy = 0
      car.grounded = true
      track.locate(car.x, car.y, car.z, Math.round(s / track.ds) % track.n, car.loc)
      const ai = new AiDriver(0, 'pro', 3)
      let maxSlip = 0
      const d0 = car.loc.d
      const down = -Math.sign(track.bank[best])
      const s0 = car.loc.s
      let peeled = false
      let airborne = false
      for (let k = 0; k < ticks; k += 1) {
        const inp = ai.think(sim)
        inp.throttle = Math.min(inp.throttle, throttleCap)
        inp.drift = false
        inp.boost = false
        sim.step([inp])
        for (const e of sim.drainEvents()) if (e.type === 'peel' || e.type === 'unanchored') peeled = true
        if (!car.grounded) airborne = true
        maxSlip = Math.max(maxSlip, car.slip)
      }
      const moved = ((car.loc.s - s0 + track.length * 1.5) % track.length) - track.length / 2
      return { maxSlip, slid: (car.loc.d - d0) * down, anchor: car.anchor, peeled, airborne, moved }
    }
    // Too slow for the bank: the magnetic road still holds the car (no slide, no peel).
    const slow = ride(9, 0.15)
    expect(slow.maxSlip).toBe(0)
    expect(slow.peeled).toBe(false)
    expect(slow.airborne).toBe(false)
    expect(Math.abs(slow.slid)).toBeLessThan(1.5) // AI still steers; slip stays 0
    // Fully stalled on a > 60° bank for three seconds: stays put, then drives off as if flat.
    const stalled = ride(0, 0, 180)
    expect(stalled.maxSlip).toBe(0)
    expect(stalled.peeled).toBe(false)
    expect(stalled.airborne).toBe(false)
    expect(Math.abs(stalled.slid)).toBeLessThan(0.3)
    const restart = ride(0, 1, 120)
    expect(restart.peeled).toBe(false)
    expect(restart.moved).toBeGreaterThan(15)
    const fast = ride(46, 1)
    expect(fast.maxSlip).toBeLessThan(0.05)
    expect(fast.anchor).toBeGreaterThan(1)
  })
  it('rewards a perfectly timed launch and punishes an early one', () => {
    const run = (pressAt: number) => {
      const sim = new RaceSim({ track, cars: 1, seed: 1, items: false })
      while (sim.phase === 'countdown') sim.step([{ ...idleInput(), throttle: sim.countdown <= pressAt ? 1 : 0 }])
      return sim.cars[0].stats.launch
    }
    expect(run(0.25)).toBe('perfect')
    expect(run(2.5)).toBe('early')
    expect(run(0.7)).toBe('none')
  })
})
