import { describe, expect, it } from 'vitest'
import { CANYON_CIRCUIT, checkTrack, decodeLab, DEFAULT_LAB, encodeLab, generateLabTrack } from '../src/sim/tracks'
import { GATES_PER_LAP, newLoc, Track } from '../src/sim/track'

describe('Canyon Circuit geometry', () => {
  const track = new Track(CANYON_CIRCUIT)

  it('is a drivable closed loop with sane radii, spacing and grades', () => {
    const check = checkTrack(track)
    console.info('canyon circuit', JSON.stringify(check), 'pads', track.pads.length, 'ramps', track.ramps.length, 'items', track.items.length)
    expect(check.ok).toBe(true)
    expect(check.length).toBeGreaterThan(2400)
    expect(check.length).toBeLessThan(3600)
  })

  it('has exactly 16 ordered gates per lap ending on the start line', () => {
    expect(track.gates).toHaveLength(GATES_PER_LAP)
    for (let k = 1; k < GATES_PER_LAP - 1; k += 1) expect(track.gates[k].s).toBeGreaterThan(track.gates[k - 1].s)
    expect(track.gates[GATES_PER_LAP - 1].s).toBeCloseTo(0, 6)
  })

  it('locates points on the centre line and to the right', () => {
    const loc = newLoc()
    const i = 300
    const x = track.x[i] + track.rx[i] * 4
    const z = track.z[i] + track.rz[i] * 4
    track.locate(x, track.y[i], z, -1, loc)
    expect(loc.i).toBe(i)
    expect(loc.d).toBeCloseTo(4, 3)
    expect(loc.s).toBeCloseTo(i * track.ds, 3)
  })

  it('contains every feature family', () => {
    expect(track.pads.length).toBeGreaterThan(5)
    expect(track.ramps.filter(r => !r.mega).length).toBe(2)
    expect(track.ramps.filter(r => r.mega).length).toBe(2)
    expect(track.items.length).toBe(3)
    let bridge = 0, canyon = 0, ridge = 0
    for (let i = 0; i < track.n; i += 1) {
      if (track.bridge[i] > 0.5) bridge += 1
      if (track.canyon[i] > 0.5) canyon += 1
      if (track.ridge[i] > 0.5) ridge += 1
    }
    expect(bridge).toBeGreaterThan(20)
    expect(canyon).toBeGreaterThan(200)
    expect(ridge).toBeGreaterThan(100)
  })
})

describe('Track Lab', () => {
  it('generates valid layouts across seeds', () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const { check } = generateLabTrack({ ...DEFAULT_LAB, seed: seed * 131, twist: 0.9, hills: 0.9 })
      expect(check.ok, `seed ${seed} ${JSON.stringify(check)}`).toBe(true)
    }
  })

  it('round-trips share codes', () => {
    const p = { ...DEFAULT_LAB, name: 'Red-Rock Run', seed: 777, twist: 0.31 }
    expect(decodeLab(encodeLab(p))).toEqual(p)
    expect(decodeLab('nonsense')).toBeNull()
  })
})
