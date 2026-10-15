import { describe, expect, it } from 'vitest'
import { applyCornerAssist, ASSIST_STRENGTH } from '../src/sim/assist'
import { defaultSave, improveBest, parseSave } from '../src/engine/save'
import { idleInput, type CarInput } from '../src/sim/car'
import { clamp, wrapAngle } from '../src/sim/math'
import { RaceSim } from '../src/sim/race'
import { Track } from '../src/sim/track'
import { CANYON_CIRCUIT } from '../src/sim/tracks'

const track = new Track(CANYON_CIRCUIT)
const frame = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }

/** A clumsy human: flat-out throttle, late and weak steering, never brakes or drifts. */
function clumsy(sim: RaceSim): CarInput {
  const car = sim.cars[0]
  const inp = idleInput()
  if (sim.phase === 'countdown') return inp
  if (car.hold > 0) { inp.throttle = car.hold < 0.3 ? 1 : 0; return inp }
  inp.throttle = 1
  track.frameAt(car.loc.s + 6, frame)
  const err = wrapAngle(Math.atan2(frame.x - car.x, frame.z - car.z) - car.yaw)
  inp.steer = clamp(-err * 0.9, -0.55, 0.55)
  if (car.stuck > 2 || car.wrongWay > 2.5) inp.recover = true
  return inp
}

function run(assist: boolean | number, seconds: number) {
  const strength = assist === true ? 1 : assist === false ? 0 : assist
  const sim = new RaceSim({ track, cars: 1, seed: 7, items: false })
  let wallHits = 0
  let resets = 0
  for (let k = 0; k < seconds * 60; k += 1) {
    const inp = clumsy(sim)
    if (strength > 0) applyCornerAssist(sim.cars[0], track, inp, undefined, strength)
    sim.step([inp])
    for (const e of sim.drainEvents()) {
      if (e.type === 'wall') wallHits += 1
      if (e.type === 'recover' || e.type === 'explode') resets += 1
    }
  }
  const car = sim.cars[0]
  return { gates: car.progress.gates, wallHits, resets, damage: car.stats.wrecks, recoveries: car.progress.recoveries }
}

describe('corner assist', () => {
  it('helps a clumsy driver: fewer wall hits/resets and more progress', () => {
    const off = run(false, 150)
    const on = run(true, 150)
    // eslint-disable-next-line no-console
    console.log('assist off', off, 'on', on)
    expect(on.wallHits + on.resets * 5).toBeLessThan(off.wallHits + off.resets * 5)
    expect(on.gates).toBeGreaterThanOrEqual(off.gates)
  }, 60000)

  it('leaves straight-line driving and deliberate lane changes alone', () => {
    const sim = new RaceSim({ track, cars: 1, seed: 1, items: false })
    const go: CarInput = { ...idleInput(), throttle: 1 }
    for (let k = 0; k < 60 * 5; k += 1) sim.step([go])
    const car = sim.cars[0]
    // Find a straight stretch by driving until curvature ahead is tiny.
    for (let k = 0; k < 60 * 30 && track.maxCurvature(car.loc.s, 0, 18 + car.vF * 0.8) > 1 / 500; k += 1) {
      const inp = { ...go }
      applyCornerAssist(car, track, inp)
      sim.step([inp])
    }
    expect(track.maxCurvature(car.loc.s, 0, 18 + car.vF * 0.8)).toBeLessThanOrEqual(1 / 500)
    if (Math.abs(car.loc.d) < car.loc.halfW - 4) {
      const lane: CarInput = { ...go, steer: 0.6 }
      applyCornerAssist(car, track, lane)
      expect(lane.steer).toBeCloseTo(0.6, 6)
    }
  })

  it('is a pure deterministic function of car state and input', () => {
    const sim = new RaceSim({ track, cars: 1, seed: 3, items: false })
    for (let k = 0; k < 60 * 12; k += 1) {
      const inp = clumsy(sim)
      const a = { ...inp }, b = { ...inp }
      const ra = { level: 0 }, rb = { level: 0 }
      applyCornerAssist(sim.cars[0], track, a, ra)
      applyCornerAssist(sim.cars[0], track, b, rb)
      expect(a).toEqual(b)
      expect(ra.level).toBe(rb.level)
      sim.step([a])
    }
  })

  it('Light sits between Off and Strong, and Off is a no-op', () => {
    const off = run(false, 150)
    const light = run(ASSIST_STRENGTH.light, 150)
    const strong = run(ASSIST_STRENGTH.strong, 150)
    // eslint-disable-next-line no-console
    console.log('assist off', off, 'light', light, 'strong', strong)
    const cost = (r: typeof off) => r.wallHits + r.resets * 5
    expect(cost(light)).toBeLessThanOrEqual(cost(off))
    expect(cost(strong)).toBeLessThanOrEqual(cost(light))
    const sim = new RaceSim({ track, cars: 1, seed: 3, items: false })
    for (let k = 0; k < 60 * 10; k += 1) {
      const inp = clumsy(sim)
      const before = { ...inp }
      const r = { level: 1 }
      applyCornerAssist(sim.cars[0], track, inp, r, ASSIST_STRENGTH.off)
      expect(inp).toEqual(before)
      expect(r.level).toBe(0)
      sim.step([inp])
    }
  }, 90000)
})

describe('assist settings and personal bests', () => {
  it('defaults to Strong for both players and migrates the old on/off flag', () => {
    const d = defaultSave()
    expect([d.assistP1, d.assistP2]).toEqual(['strong', 'strong'])
    const old = { ...d, cornerAssist: false } as Record<string, unknown>
    delete old.assistP1
    delete old.assistP2
    const m = parseSave(JSON.stringify(old))
    expect([m.assistP1, m.assistP2]).toEqual(['off', 'off'])
    const mixed = parseSave(JSON.stringify({ ...d, assistP1: 'light', assistP2: 'bogus' }))
    expect([mixed.assistP1, mixed.assistP2]).toEqual(['light', 'strong'])
  })

  it('records whether the best total and best lap were set with assist', () => {
    const a = improveBest(undefined, 200, 60, true, false)!
    expect(a).toEqual({ total: 200, lap: 60, totalAssist: true })
    // Faster lap without assist, slower total: lap flag clears, total keeps its assist tag.
    const b = improveBest(a, 210, 58, false, false)!
    expect(b).toEqual({ total: 200, lap: 58, totalAssist: true })
    // Unassisted faster total replaces the assisted one.
    const c = improveBest(b, 190, 59, false, false)!
    expect(c).toEqual({ total: 190, lap: 58 })
    expect(improveBest(c, 195, 59)).toBeNull()
    // Flags survive a save round trip.
    const saved = parseSave(JSON.stringify({ ...defaultSave(), bests: { canyon: a } }))
    expect(saved.bests.canyon).toEqual(a)
  })
})
