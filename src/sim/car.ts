import { CONFIG } from '../game/config'
import { approach, clamp, lerp, mod, wrapAngle, wrapDelta } from './math'
import { addRecoveryPenalty, newProgress, nextGateIndex, RECOVERY_PENALTY, type Progress } from './rules'
import { newCorkFrame, newLoc, type Track, type TrackLoc } from './track'

/**
 * Arcade vehicle simulation. Every car uses the same CONFIG.car block; nothing cosmetic can
 * reach this file. All state changes happen in fixed 1/60 s steps from explicit inputs.
 */
export const DT = 1 / 60
export const CAR_RADIUS = 1.55
export const TRICK_TIME = 0.5
export const DRIFT_TIERS = [0.9, 1.9, 3.0] as const
export const DRIFT_BOOST = [0.7, 1.15, 1.7] as const
/** Half the body width: barriers stop the body edge, not the centre of the car. */
export const CAR_HALF_W = 1.05
/** Damage thresholds (0 – 1): light smoke, heavy fire, destroyed at 1. */
/** Every damage source is divided by this (identical for all cars): 2 = twice as tough as the original tuning. */
export const DURABILITY = 2
export const DAMAGE_SMOKE = 0.35
export const DAMAGE_FIRE = 0.7
/** Seconds a destroyed car burns before it respawns on the spot. */
export const WRECK_TIME = 1.6
/** Seconds a respawned car waits on the road before it may race again. */
export const HOLD_TIME = RECOVERY_PENALTY
/** Damage causes, carried in RaceEvent.other for presentation. */
export const DAMAGE_CAUSE = { wall: 1, car: 2, item: 3, landing: 4 } as const

export type ItemKind = 'seeker' | 'mine' | 'shield' | 'canister'
export const ITEM_KINDS: readonly ItemKind[] = ['seeker', 'mine', 'shield', 'canister']

export interface CarInput {
  throttle: number
  brake: number
  steer: number
  drift: boolean
  boost: boolean
  item: boolean
  recover: boolean
}

export const idleInput = (): CarInput => ({ throttle: 0, brake: 0, steer: 0, drift: false, boost: false, item: false, recover: false })

export type RaceEvent = { type: string; car: number; value?: number; other?: number }

export interface CarStats {
  topSpeed: number
  nitros: number
  powerBoosts: number
  corks: number
  driftBoosts: number
  perfectPads: number
  pads: number
  tricks: number
  draftTime: number
  airTime: number
  hits: number
  dodges: number
  blocks: number
  itemsUsed: number
  wallHits: number
  wrecks: number
  launch: 'none' | 'perfect' | 'early'
}

export interface CarState {
  id: number
  x: number
  y: number
  z: number
  yaw: number
  vx: number
  vz: number
  vy: number
  /** Signed forward speed (m/s), cached each step. */
  vF: number
  grounded: boolean
  airTime: number
  loc: TrackLoc
  /** Unwrapped distance travelled along the track since the grid. */
  odo: number
  lastDs: number
  prevS: number
  drift: boolean
  driftDir: number
  driftCharge: number
  driftTier: number
  driftHeld: number
  boostTime: number
  /** Stored Power Cell charges, capped at three. */
  power: number
  /** Seconds of the stored Power Boost left. */
  powerBoostTime: number
  /** Nitro charge 0 – 1 (1 = ready). */
  meter: number
  /** True while the nitro burst is firing. */
  meterBoosting: boolean
  /** True while a stored Power charge is firing. */
  powerBoosting: boolean
  /** Seconds of nitro burst left. */
  nitro: number
  prevBoost: boolean
  /** Corkscrew index while riding a roll ribbon, else -1. */
  cork: number
  /** Seconds of free-fall left after losing a corkscrew (then the car is reset). */
  corkFall: number
  draftCharge: number
  drafting: boolean
  trick: number
  trickT: number
  tricks: number
  spin: number
  wheelspin: number
  shield: number
  immune: number
  ghostT: number
  item: ItemKind | null
  itemRequest: boolean
  recovering: number
  wrongWay: number
  stuck: number
  throttlePressAt: number
  prevDrift: boolean
  prevItem: boolean
  prevRecover: boolean
  prevThrottle: boolean
  lastPad: number
  padTimer: number
  rampIndex: number
  place: number
  progress: Progress
  stats: CarStats
  warnSeeker: number
  warnLocked: boolean
  warnLockD: number
  warnMine: number
  /** Accumulated damage 0 – 1; reaching 1 destroys the car. */
  damage: number
  /** Seconds left burning as a wreck (> 0 = destroyed). */
  wreck: number
  /** Seconds left on the respawn hold countdown (> 0 = waiting to race). */
  hold: number
  /** Hold time remaining when throttle was pressed (-1 = not pressed), for relaunch timing. */
  holdPress: number
  /** Banked-road grip loss 0 – 1 (too slow for the bank: the car slides down the slope). */
  slip: number
  /** Normal force on the road in g (> 1 = speed pressing the car into a bank). */
  anchor: number
  /** Presentation hints (deterministic, never read by rules). */
  steerVis: number
  landImpact: number
}

export function createCar(id: number, track: Track, lane: number, gridS: number): CarState {
  const car: CarState = {
    id, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, vy: 0, vF: 0, grounded: true, airTime: 0,
    loc: newLoc(), odo: gridS, lastDs: 0, prevS: 0,
    drift: false, driftDir: 0, driftCharge: 0, driftTier: 0, driftHeld: 0,
    boostTime: 0, power: 0, powerBoostTime: 0, meter: 1, meterBoosting: false, powerBoosting: false, nitro: 0, prevBoost: false, cork: -1, corkFall: 0, draftCharge: 0, drafting: false,
    trick: 0, trickT: 0, tricks: 0, spin: 0, wheelspin: 0, shield: 0, immune: 0, ghostT: 0,
    item: null, itemRequest: false, recovering: 0, wrongWay: 0, stuck: 0, throttlePressAt: -1,
    prevDrift: false, prevItem: false, prevRecover: false, prevThrottle: false,
    lastPad: -1, padTimer: 0, rampIndex: -1, place: id + 1, progress: newProgress(),
    stats: { topSpeed: 0, nitros: 0, powerBoosts: 0, corks: 0, driftBoosts: 0, perfectPads: 0, pads: 0, tricks: 0, draftTime: 0, airTime: 0, hits: 0, dodges: 0, blocks: 0, itemsUsed: 0, wallHits: 0, wrecks: 0, launch: 'none' },
    damage: 0, wreck: 0, hold: 0, holdPress: -1,
    warnSeeker: -1, warnLocked: false, warnLockD: 0, warnMine: -1, slip: 0, anchor: 1, steerVis: 0, landImpact: 0,
  }
  placeOnTrack(car, track, mod(gridS, track.length), lane)
  return car
}

const frame = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }

export function placeOnTrack(car: CarState, track: Track, s: number, lane: number): void {
  track.frameAt(s, frame)
  car.x = frame.x + frame.rx * lane
  car.z = frame.z + frame.rz * lane
  car.y = frame.y + frame.bank * lane
  car.yaw = Math.atan2(frame.tx, frame.tz)
  track.locate(car.x, car.y, car.z, track.sampleIndex(s), car.loc)
  car.y = car.loc.roadY
  car.prevS = car.loc.s
  car.grounded = true
  car.vy = 0
  car.rampIndex = car.loc.rampIndex
}

/** Countdown-phase input handling: launch timing is judged on the first throttle press. */
export function countdownStep(car: CarState, inp: CarInput, remaining: number): void {
  const thr = inp.throttle > 0.5
  if (thr && !car.prevThrottle) car.throttlePressAt = remaining
  if (!thr) car.throttlePressAt = -1
  car.prevThrottle = thr
  car.prevDrift = inp.drift
  car.prevItem = inp.item
  car.prevRecover = inp.recover
  car.prevBoost = inp.boost
}

export function applyLaunch(car: CarState, events: RaceEvent[]): void {
  const at = car.throttlePressAt
  if (at < 0) return
  if (at <= 0.4) {
    car.boostTime = Math.max(car.boostTime, 1.3)
    car.stats.launch = 'perfect'
    events.push({ type: 'launchPerfect', car: car.id })
  } else if (at > 1.0) {
    car.wheelspin = 0.7
    car.stats.launch = 'early'
    events.push({ type: 'launchEarly', car: car.id })
  }
}

/** True while a car is out of the racing (recovering, burning or on its respawn hold). */
export const inactive = (car: CarState): boolean => car.recovering > 0 || car.wreck > 0 || car.hold > 0

/** Add damage; crossing 1.0 destroys the car. Identical rules for every car. */
export function applyDamage(car: CarState, amount: number, events: RaceEvent[], cause: number): void {
  if (amount <= 0 || car.progress.finished || inactive(car) || car.ghostT > 0) return
  const before = car.damage
  car.damage = Math.min(1, before + amount / DURABILITY)
  events.push({ type: 'damage', car: car.id, value: car.damage, other: cause })
  if (car.damage >= 1) {
    car.wreck = WRECK_TIME
    car.drift = false
    car.driftCharge = 0
    car.driftTier = 0
    car.trick = 0
    car.tricks = 0
    car.boostTime = 0
    car.powerBoostTime = 0
    car.meterBoosting = false
    car.powerBoosting = false
    car.nitro = 0
    if (car.cork >= 0) { car.cork = -1; car.grounded = false }
    car.spin = 0
    car.stats.wrecks += 1
    events.push({ type: 'explode', car: car.id, other: cause })
    return
  }
  if (before < DAMAGE_FIRE && car.damage >= DAMAGE_FIRE) events.push({ type: 'onFire', car: car.id })
  else if (before < DAMAGE_SMOKE && car.damage >= DAMAGE_SMOKE) events.push({ type: 'smoking', car: car.id })
}

export function startRecovery(car: CarState, events: RaceEvent[], reason: string): void {
  if (inactive(car) || car.progress.finished) return
  car.recovering = 0.6
  car.drift = false
  car.driftCharge = 0
  car.trick = 0
  car.tricks = 0
  car.vx = car.vz = car.vy = 0
  car.vF = 0
  car.meterBoosting = false
  car.powerBoostTime = 0
  car.powerBoosting = false
  car.nitro = 0
  car.cork = -1
  car.corkFall = 0
  events.push({ type: 'recoverStart', car: car.id, value: reason === 'manual' ? 0 : reason === 'fell' ? 1 : 2 })
}

/** Put the car back on the road at its current spot and start the 3-second hold. */
function respawn(car: CarState, track: Track, events: RaceEvent[], wrecked: boolean): void {
  car.slip = 0
  car.anchor = 1
  const L = track.length
  let s = car.loc.s
  // Lost a corkscrew: back to the run-in before the pads, for another go at it.
  const ci = track.corkAt(s)
  if (ci >= 0) s = mod(track.corks[ci].s0 - 30, L)
  // Never place a car beyond the gate it still has to cross.
  const gateS = track.gates[nextGateIndex(car.progress)].s
  if (wrapDelta(gateS - s, L) < 10) s = mod(gateS - 10, L)
  const lane = clamp(car.loc.d, -car.loc.halfW + 2.5, car.loc.halfW - 2.5) * 0.35
  car.odo += wrapDelta(s - car.loc.s, L)
  placeOnTrack(car, track, s, lane)
  car.vx = car.vz = car.vy = car.vF = 0
  car.lastDs = 0
  car.prevS = car.loc.s
  car.hold = HOLD_TIME
  car.holdPress = -1
  car.ghostT = HOLD_TIME + 1.2
  car.immune = Math.max(car.immune, HOLD_TIME + 1.2)
  car.damage = 0
  car.wreck = 0
  car.recovering = 0
  car.boostTime = 0
  car.powerBoostTime = 0
  car.nitro = 0
  car.meterBoosting = false
  car.powerBoosting = false
  car.cork = -1
  car.corkFall = 0
  car.wrongWay = 0
  car.stuck = 0
  car.spin = 0
  car.wheelspin = 0
  car.drafting = false
  car.draftCharge = 0
  addRecoveryPenalty(car.progress)
  events.push({ type: 'recovered', car: car.id, value: wrecked ? 1 : 0 })
}

/** Keep the body inside the barriers: canyon walls and rails stop cars at any height. */
function clampToBarrier(car: CarState, loc: TrackLoc, events: RaceEvent[] | null): void {
  const lim = loc.barrier - CAR_HALF_W
  const over = Math.abs(loc.d) - lim
  if (over <= 0) return
  const sg = Math.sign(loc.d)
  car.x -= loc.rx * sg * over
  car.z -= loc.rz * sg * over
  const vn = (car.vx * loc.rx + car.vz * loc.rz) * sg
  if (vn > 0) {
    car.vx -= loc.rx * sg * vn * 1.3
    car.vz -= loc.rz * sg * vn * 1.3
    const loss = clamp(vn / 45, 0, 0.35)
    car.vx *= 1 - loss
    car.vz *= 1 - loss
    if (events && vn > 5) {
      car.stats.wallHits += 1
      events.push({ type: 'wall', car: car.id, value: vn })
      if (vn > 10 && car.drift) {
        car.drift = false
        events.push({ type: 'driftLost', car: car.id })
      }
      if (vn > 14) applyDamage(car, (vn - 14) / 30, events, DAMAGE_CAUSE.wall)
    }
  }
  loc.d = sg * lim
}

/** A destroyed car skids to a stop and burns, then respawns where it blew up. */
function stepWreck(car: CarState, track: Track, events: RaceEvent[]): void {
  const dt = DT
  car.wreck -= dt
  const k = Math.exp(-2.4 * dt)
  car.vx *= k
  car.vz *= k
  car.x += car.vx * dt
  car.z += car.vz * dt
  if (!car.grounded) {
    car.vy -= CONFIG.car.gravity * dt
    car.y += car.vy * dt
  }
  const prevS = car.loc.s
  track.locate(car.x, car.y, car.z, car.loc.i, car.loc)
  clampToBarrier(car, car.loc, null)
  if (car.grounded || car.y <= car.loc.roadY) {
    car.y = car.loc.roadY
    car.vy = 0
    car.grounded = true
  }
  const ds = wrapDelta(car.loc.s - prevS, track.length)
  car.odo += ds
  car.prevS = prevS
  car.lastDs = 0
  car.vF = car.vx * Math.sin(car.yaw) + car.vz * Math.cos(car.yaw)
  if (car.wreck <= 0) respawn(car, track, events, true)
}

/** Respawn hold: the car waits on the road; pressing throttle in the last 0.4 s relaunches with a boost. */
function stepHold(car: CarState, inp: CarInput, prevThrottle: boolean, events: RaceEvent[]): void {
  const thr = inp.throttle > 0.5
  if (thr && !prevThrottle) car.holdPress = car.hold
  if (!thr) car.holdPress = -1
  car.hold -= DT
  car.vx = car.vz = car.vy = car.vF = 0
  car.lastDs = 0
  car.prevS = car.loc.s
  if (car.hold > 1e-9) return
  car.hold = 0
  car.ghostT = Math.max(car.ghostT, 1.0)
  car.immune = Math.max(car.immune, 1.0)
  events.push({ type: 'holdGo', car: car.id })
  if (car.holdPress >= 0 && car.holdPress <= 0.4) {
    car.boostTime = Math.max(car.boostTime, 1.1)
    events.push({ type: 'launchPerfect', car: car.id, value: 1 })
  }
  car.holdPress = -1
}

function finishRecovery(car: CarState, track: Track, events: RaceEvent[]): void {
  respawn(car, track, events, false)
}

/** One fixed simulation step while racing. */
export function stepCar(car: CarState, inp: CarInput, track: Track, events: RaceEvent[]): void {
  const C = CONFIG.car
  const dt = DT
  const driftPressed = inp.drift && !car.prevDrift
  const itemPressed = inp.item && !car.prevItem
  const recoverPressed = inp.recover && !car.prevRecover
  const boostPressed = inp.boost && !car.prevBoost
  car.prevBoost = inp.boost
  const prevThrottle = car.prevThrottle
  car.prevDrift = inp.drift
  car.prevItem = inp.item
  car.prevRecover = inp.recover
  car.prevThrottle = inp.throttle > 0.5
  if (itemPressed && car.item && !inactive(car) && car.spin <= 0 && car.cork < 0) car.itemRequest = true

  car.immune = Math.max(0, car.immune - dt)
  car.shield = Math.max(0, car.shield - dt)
  car.ghostT = Math.max(0, car.ghostT - dt)
  car.spin = Math.max(0, car.spin - dt)
  car.wheelspin = Math.max(0, car.wheelspin - dt)
  car.padTimer = Math.max(0, car.padTimer - dt)
  car.landImpact = Math.max(0, car.landImpact - dt * 3)
  car.powerBoostTime = Math.max(0, car.powerBoostTime - dt)
  car.powerBoosting = car.powerBoostTime > 0

  if (car.wreck > 0) {
    stepWreck(car, track, events)
    return
  }
  if (car.hold > 0) {
    stepHold(car, inp, prevThrottle, events)
    return
  }
  if (car.recovering > 0) {
    car.recovering -= dt
    if (car.recovering <= 0) finishRecovery(car, track, events)
    return
  }
  if (recoverPressed && !car.progress.finished) {
    startRecovery(car, events, 'manual')
    return
  }
  if (car.corkFall > 0) {
    car.corkFall -= dt
    if (car.corkFall <= 0) {
      car.corkFall = 0
      startRecovery(car, events, 'fell')
      return
    }
  }

  let steer = clamp(inp.steer, -1, 1)
  let throttle = clamp(inp.throttle, 0, 1)
  let brake = clamp(inp.brake, 0, 1)
  if (car.spin > 0) { throttle = 0; brake = 0; steer = 0 }
  if (car.wheelspin > 0) throttle = 0
  car.steerVis = approach(car.steerVis, steer, dt * 6)

  // Nitro: tap boost when charged for a short burst; it then recharges over the cooldown.
  if (car.nitro > 0) {
    car.nitro = Math.max(0, car.nitro - dt)
    car.boostTime = Math.max(car.boostTime, Math.min(car.nitro, dt * 2))
  } else if (!car.progress.finished) car.meter = Math.min(1, car.meter + dt / C.nitroCooldown)
  if (boostPressed && car.spin <= 0 && car.nitro <= 0) {
    if (car.power > 0) {
      car.power -= 1
      car.powerBoostTime = C.powerTime
      car.powerBoosting = true
      car.boostTime = Math.max(car.boostTime, C.powerTime)
      car.stats.powerBoosts += 1
      events.push({ type: 'powerBoost', car: car.id, value: car.power })
    } else if (car.meter >= 1) {
      car.nitro = C.nitroTime
      car.meter = 0
      car.boostTime = Math.max(car.boostTime, C.nitroTime)
      car.stats.nitros += 1
      events.push({ type: 'nitro', car: car.id })
    } else events.push({ type: 'nitroDenied', car: car.id, value: car.meter })
  }
  car.meterBoosting = car.nitro > 0
  const boosting = car.boostTime > 0
  car.boostTime = Math.max(0, car.boostTime - dt)
  const nitroAcc = car.nitro > 0 ? C.nitroAccel : 0
  const powerAcc = car.powerBoostTime > 0 ? C.powerAccel : 0

  if (car.cork >= 0) {
    stepCork(car, track, events, steer, throttle, brake, boosting, nitroAcc, powerAcc)
    return
  }

  let fx = Math.sin(car.yaw)
  let fz = Math.cos(car.yaw)
  let vF = car.vx * fx + car.vz * fz
  const L = car.loc
  const sp = Math.abs(vF)

  let bankSin = 0
  let slideAcc = 0
  if (car.grounded) {
    // Banked road: speed presses the car into the slope; too slow and the tyres let go.
    let slipTarget = 0
    if (Math.abs(L.bank) > 0.25) {
      const vAl = Math.max(0, car.vx * L.tx + car.vz * L.tz)
      const bf = bankForces(L.bank, track.curv[L.i], vAl)
      const hold = C.bankGrip * bf.normal
      bankSin = bf.sin
      if (C.bankMagnet) {
        // Magnetic road: the tyres always hold, whatever the speed (stalled cars included).
        car.anchor = Math.max(1, bf.normal / C.gravity)
      } else if (bf.pull > hold) {
        car.anchor = bf.normal / C.gravity
        slipTarget = clamp((bf.pull - hold) / (0.6 * C.gravity), 0, 1)
        slideAcc = (bf.pull - hold) * bf.cos * 1.6
      } else car.anchor = bf.normal / C.gravity
    } else car.anchor = 1
    const prevSlip = car.slip
    car.slip = approach(car.slip, slipTarget, dt * (slipTarget > car.slip ? 5 : 3))
    if (car.slip > 0.25 && prevSlip <= 0.25) events.push({ type: 'unanchored', car: car.id })
    const surface = L.onRoad ? 1 : C.shoulderFactor
    const downhill = clamp(-L.slope * (fx * L.tx + fz * L.tz), 0, 0.4) * C.downhillBonus
    const cap = (boosting ? C.boostSpeed : C.maxSpeed * surface) + (car.drafting ? C.draftBonus : 0) + downhill
    if (throttle > 0.05 && vF >= -0.5) {
      const target = cap * throttle
      if (vF < target) {
        const a = C.accel * (1 - 0.55 * clamp(vF / C.maxSpeed, 0, 1)) + (boosting ? C.boostAccel : 0) + nitroAcc + powerAcc
        vF = Math.min(target, vF + a * dt)
      }
    } else if (throttle > 0.05) {
      vF = Math.min(0, vF + C.brake * dt)
    } else if (brake > 0.05) {
      if (vF > 0.5) vF = Math.max(0, vF - C.brake * brake * dt)
      else vF = Math.max(-C.reverseSpeed, vF - 16 * brake * dt)
    } else {
      vF = approach(vF, 0, C.coastDrag * dt)
    }
    if (vF > cap) vF = Math.max(cap, vF - (boosting ? 8 : 20) * dt)
    // Gentle arcade slope influence.
    const along = fx * L.tx + fz * L.tz
    vF -= C.gravity * L.slope * along * 0.42 * dt

    // Drift start / charge / release.
    if (!car.drift && inp.drift && car.driftHeld < 0.45 && Math.abs(steer) > 0.35 && vF > C.driftMinSpeed && car.spin <= 0) {
      car.drift = true
      car.driftDir = Math.sign(steer)
      car.driftCharge = 0
      car.driftTier = 0
      events.push({ type: 'driftStart', car: car.id, value: car.driftDir })
    }
    if (car.drift) {
      if (!inp.drift) {
        if (car.driftTier > 0) {
          car.boostTime = Math.max(car.boostTime, DRIFT_BOOST[car.driftTier - 1])
          car.meter = Math.min(1, car.meter + 0.06 * car.driftTier)
          car.stats.driftBoosts += 1
          events.push({ type: 'driftBoost', car: car.id, value: car.driftTier })
        }
        car.drift = false
      } else if (vF < 11 || car.spin > 0) {
        car.drift = false
        events.push({ type: 'driftLost', car: car.id })
      } else {
        car.driftCharge += dt * (0.75 + 0.5 * Math.max(0, steer * car.driftDir))
        const tier = car.driftCharge >= DRIFT_TIERS[2] ? 3 : car.driftCharge >= DRIFT_TIERS[1] ? 2 : car.driftCharge >= DRIFT_TIERS[0] ? 1 : 0
        if (tier > car.driftTier) events.push({ type: 'driftTier', car: car.id, value: tier })
        car.driftTier = tier
      }
    }

    // Steering.
    let yawRate: number
    if (car.drift) {
      yawRate = car.driftDir * (C.driftBase + C.driftSteer * steer * car.driftDir) * clamp(sp / 22, 0.4, 1)
    } else {
      const rate = lerp(C.turnLow, C.turnHigh + C.bankTurn * bankSin, clamp(sp / C.maxSpeed, 0, 1)) * clamp(sp / 4, 0, 1)
      yawRate = steer * rate * (vF < -0.5 ? -1 : 1)
    }
    yawRate *= 1 - 0.6 * car.slip
    if (car.spin > 0) yawRate = 9 * (car.id % 2 ? 1 : -1) * (car.spin / 1.0)
    car.yaw = wrapAngle(car.yaw - yawRate * dt)

    // Re-express velocity in the new heading and bleed lateral slip (grip).
    const vFwd = vF
    const nfx = Math.sin(car.yaw)
    const nfz = Math.cos(car.yaw)
    const rx = -nfz
    const rz = nfx
    const wvx = fx * vFwd + (-fz) * ((car.vx * -fz + car.vz * fx))
    const wvz = fz * vFwd + fx * ((car.vx * -fz + car.vz * fx))
    let f2 = wvx * nfx + wvz * nfz
    let r2 = wvx * rx + wvz * rz
    const grip = (car.drift ? C.driftGrip : C.grip) * (L.onRoad ? 1 : 0.8) * (car.spin > 0 ? 0.15 : 1) * (1 - car.slip) * (1 - car.slip)
    const r3 = r2 * Math.exp(-grip * dt)
    const speed = Math.hypot(f2, r2)
    const redirected = Math.sqrt(Math.max(0, speed * speed - r3 * r3))
    f2 = f2 + (Math.sign(f2 || 1) * redirected - f2) * 0.92
    r2 = r3
    car.vx = nfx * f2 + rx * r2
    car.vz = nfz * f2 + rz * r2
    if (slideAcc > 0) {
      // Slide down the bank (toward its lower, inside edge).
      const down = -Math.sign(L.bank)
      car.vx += L.rx * down * slideAcc * dt
      car.vz += L.rz * down * slideAcc * dt
    }
    fx = nfx
    fz = nfz
    vF = f2
  } else {
    // Airborne: gravity, aerial steering and tricks.
    car.slip = approach(car.slip, 0, dt * 2)
    car.anchor = 0
    car.vy -= C.gravity * dt
    const dYaw = steer * C.airTurn * dt
    car.yaw = wrapAngle(car.yaw - dYaw)
    // Aerial steering bends the trajectory a little.
    const c = Math.cos(-dYaw * 0.5)
    const s = Math.sin(-dYaw * 0.5)
    const vx = car.vx * c + car.vz * s
    const vz = -car.vx * s + car.vz * c
    car.vx = vx * (1 - 0.1 * dt)
    car.vz = vz * (1 - 0.1 * dt)
    car.airTime += dt
    if (driftPressed && car.trick === 0 && car.airTime > 0.08 && car.spin <= 0) {
      car.trick = steer < -0.35 ? 2 : steer > 0.35 ? 3 : 1
      car.trickT = 0
      events.push({ type: 'trickStart', car: car.id, value: car.trick })
    }
    if (car.trick !== 0) {
      car.trickT += dt
      if (car.trickT >= TRICK_TIME) {
        car.tricks += 1
        events.push({ type: 'trick', car: car.id, value: car.trick })
        car.trick = 0
        car.trickT = 0
      }
    }
    fx = Math.sin(car.yaw)
    fz = Math.cos(car.yaw)
    vF = car.vx * fx + car.vz * fz
  }
  car.driftHeld = inp.drift ? car.driftHeld + dt : 0

  // Integrate.
  const prevY = car.y
  car.x += car.vx * dt
  car.z += car.vz * dt
  if (!car.grounded) car.y += car.vy * dt

  const prevS = car.loc.s
  const prevRamp = car.rampIndex
  track.locate(car.x, car.y, car.z, car.loc.i, car.loc)
  const loc = car.loc

  // Barriers: canyon walls and guard rails stop the body edge at any height (no flying through rock).
  clampToBarrier(car, loc, events)
  if (car.wreck > 0) return

  // Ground contact.
  if (car.grounded) {
    if (!loc.onSurface) {
      car.grounded = false
    } else if (prevRamp >= 0 && loc.rampIndex < 0 && wrapDelta(loc.s - prevS, track.length) > 0) {
      car.grounded = false
      const mega = track.ramps[prevRamp]?.mega ?? false
      car.vy = Math.max(car.vy, (mega ? C.megaKick : C.rampKick) * clamp(vF, 0, mega ? 64 : 80) + (mega ? 4 : 2))
      car.airTime = 0
      car.tricks = 0
      events.push({ type: 'launch', car: car.id, value: vF, other: mega ? 1 : 0 })
    } else if (loc.roadY < prevY - 0.9) {
      car.grounded = false
      car.airTime = 0
      car.tricks = 0
    } else if (!C.bankMagnet && car.slip > 0.7 && Math.abs(loc.bank) > 1.35) {
      // Far too slow on a near-vertical bank: the car peels off the wall and drops down the slope.
      car.grounded = false
      const down = -Math.sign(loc.bank)
      car.vx += loc.rx * down * 3
      car.vz += loc.rz * down * 3
      car.vy = 1.5
      car.airTime = 0
      car.tricks = 0
      events.push({ type: 'peel', car: car.id })
    } else if (crestLaunch(car, track, fx, fz, vF)) {
      // Crest: the road falls away faster than gravity can pull the car down — airtime!
      car.grounded = false
      car.vy = loc.slope * vF * (fx * loc.tx + fz * loc.tz)
      car.y = prevY + car.vy * dt
      car.airTime = 0
      car.tricks = 0
      events.push({ type: 'crest', car: car.id, value: vF })
    } else {
      car.vy = clamp((loc.roadY - prevY) / dt, -40, 40)
      car.y = loc.roadY
    }
  } else if (car.corkFall <= 0 && loc.onSurface && car.y <= loc.roadY && ((car.airTime > 0.1 && car.vy <= landRoadVy(car) + 0.4) || car.y < loc.roadY - 0.35)) {
    // Landing (only while moving into the road, so crest take-offs never flicker).
    car.y = loc.roadY
    const roadVy = landRoadVy(car)
    const impact = roadVy - car.vy
    car.vy = 0
    car.grounded = true
    car.stats.airTime += car.airTime
    car.landImpact = clamp(impact / 20, 0, 1)
    const velHeading = Math.atan2(car.vx, car.vz)
    const misalign = Math.abs(wrapAngle(car.yaw - velHeading))
    if (car.trick !== 0) {
      car.vx *= 0.55
      car.vz *= 0.55
      car.spin = 0.55
      car.drift = false
      events.push({ type: 'crash', car: car.id })
      applyDamage(car, 0.25, events, DAMAGE_CAUSE.landing)
    } else if (car.tricks > 0) {
      car.boostTime = Math.max(car.boostTime, 0.5 + 0.45 * car.tricks)
      car.meter = Math.min(1, car.meter + 0.1 * car.tricks)
      car.stats.tricks += car.tricks
      events.push({ type: 'trickLand', car: car.id, value: car.tricks })
    } else if (car.airTime > 0.3) {
      events.push({ type: 'land', car: car.id, value: car.landImpact })
    }
    if (misalign > 0.9 && Math.hypot(car.vx, car.vz) > 8) {
      car.vx *= 0.8
      car.vz *= 0.8
      events.push({ type: 'rough', car: car.id })
    }
    car.trick = 0
    car.trickT = 0
    car.tricks = 0
    car.airTime = 0
  }
  car.rampIndex = car.grounded ? loc.rampIndex : -1

  // Corkscrews: roll in from the run-in; anywhere deeper there is no road under the car.
  if (car.grounded && car.corkFall <= 0) {
    const ci = track.corkAt(loc.s)
    if (ci >= 0) {
      const ck = track.corks[ci]
      const rel = wrapDelta(loc.s - ck.s0, track.length)
      const vAl = car.vx * loc.tx + car.vz * loc.tz
      if (rel < 14 && vAl > 0) {
        car.cork = ci
        car.vF = vAl
        car.drift = false
        car.slip = 0
        events.push({ type: 'corkEnter', car: car.id, value: vAl })
      } else {
        car.grounded = false
        car.corkFall = 0.9
        events.push({ type: 'corkFall', car: car.id })
      }
    }
  }

  // Fell off an exposed ridge or bridge.
  if (!car.grounded && !loc.onSurface && car.y < loc.roadY - 12) startRecovery(car, events, 'fell')
  if (!car.grounded && car.airTime > 8) startRecovery(car, events, 'fell')

  // Boost pads.
  if (car.grounded) checkPads(car, track, events)

  // Progress bookkeeping.
  const ds = wrapDelta(loc.s - prevS, track.length)
  car.lastDs = ds
  car.prevS = prevS
  car.odo += ds
  vF = car.vx * fx + car.vz * fz
  car.vF = vF
  car.stats.topSpeed = Math.max(car.stats.topSpeed, vF)

  const facing = fx * loc.tx + fz * loc.tz
  if (facing < -0.25 && ds < 0 && car.grounded) car.wrongWay += dt
  else car.wrongWay = Math.max(0, car.wrongWay - dt * 2)
  if (Math.abs(vF) < 1.2 && throttle > 0.5 && car.spin <= 0 && car.wheelspin <= 0) car.stuck += dt
  else car.stuck = 0
  if (car.stuck > 3 && !car.progress.finished) startRecovery(car, events, 'stuck')
}

function checkPads(car: CarState, track: Track, events: RaceEvent[]): void {
  const loc = car.loc
  for (const pad of track.pads) {
    if ((pad.cork >= 0) !== (car.cork >= 0)) continue
    const rel = wrapDelta(loc.s - pad.s + pad.len / 2, track.length)
    if (rel < 0 || rel > pad.len) continue
    const off = Math.abs(loc.d - pad.d)
    if (off > pad.halfW + 0.6) continue
    if (car.lastPad === pad.index && car.padTimer > 0) continue
    const perfect = off <= 0.85
    car.boostTime = Math.max(car.boostTime, perfect ? 1.6 : 1.05)
    if (perfect) car.meter = Math.min(1, car.meter + 0.08)
    car.lastPad = pad.index
    car.padTimer = 2
    car.stats.pads += 1
    if (perfect) car.stats.perfectPads += 1
    events.push({ type: 'pad', car: car.id, value: perfect ? 1 : 0 })
  }
}

const cf = newCorkFrame()

/**
 * Corkscrew rail: the car follows the rolling ribbon. Speed along the path is driven by
 * throttle, boost and gravity; the road can only push, so the normal force
 * N = v²·κn + g·n_y must stay positive — too slow at the top and the car drops off.
 */
function stepCork(car: CarState, track: Track, events: RaceEvent[], steer: number, throttle: number, brake: number, boosting: boolean, nitroAcc: number, powerAcc: number): void {
  const C = CONFIG.car
  const dt = DT
  const ck = track.corks[car.cork]
  const L = track.length
  car.drift = false
  car.driftCharge = 0
  car.driftTier = 0
  car.trick = 0
  car.slip = 0
  car.airTime = 0
  car.grounded = true
  car.driftHeld = 0
  const loc = car.loc
  let s = loc.s
  let d = loc.d
  track.corkFrame(ck, s, d, cf)
  let v = car.vF
  const cap = boosting ? C.boostSpeed : C.maxSpeed
  if (throttle > 0.05) {
    const target = cap * throttle
    if (v < target) v = Math.min(target, v + (C.accel * (1 - 0.55 * clamp(v / C.maxSpeed, 0, 1)) + (boosting ? C.boostAccel : 0) + nitroAcc + powerAcc) * dt)
  } else if (brake > 0.05) v = Math.max(0, v - C.brake * brake * dt)
  else v = approach(v, 0, C.coastDrag * dt)
  if (v > cap) v = Math.max(cap, v - 8 * dt)
  v -= C.gravity * cf.fy * dt
  const hw = track.corkHalfW(ck, s)
  d = clamp(d + steer * C.corkSteer * clamp(v / 20, 0.3, 1) * dt, -hw + 1.3, hw - 1.3)
  const prevS = s
  s = mod(s + (Math.max(0, v) * dt) / cf.stretch, L)
  const rel = wrapDelta(s - ck.s0, L)
  track.corkFrame(ck, s, d, cf)
  car.x = cf.x
  car.y = cf.y
  car.z = cf.z
  car.yaw = Math.atan2(cf.fx, cf.fz)
  car.vx = cf.fx * v
  car.vz = cf.fz * v
  car.vy = cf.fy * v
  car.vF = v
  const N = v * v * cf.kn + C.gravity * cf.ny
  car.anchor = N / C.gravity
  car.steerVis = approach(car.steerVis, steer, dt * 6)
  // Bookkeeping in base-track terms (gates and progress follow the base distance).
  track.locate(car.x, car.y, car.z, track.sampleIndex(s), loc)
  loc.s = s
  loc.i = track.sampleIndex(s)
  loc.d = d
  loc.roadY = car.y
  loc.onRoad = true
  loc.onSurface = true
  loc.rampIndex = -1
  loc.rampH = 0
  loc.bank = 0
  const ds = wrapDelta(s - prevS, L)
  car.lastDs = ds
  car.prevS = prevS
  car.odo += ds
  car.stats.topSpeed = Math.max(car.stats.topSpeed, v)
  car.wrongWay = 0
  car.stuck = 0
  checkPads(car, track, events)
  if (rel >= ck.len - 1e-6 || rel < 0) {
    // Rolled out: back on the ground road.
    car.cork = -1
    const h = Math.hypot(cf.fx, cf.fz) || 1
    car.vx = (cf.fx / h) * v
    car.vz = (cf.fz / h) * v
    car.vy = 0
    car.stats.corks += 1
    events.push({ type: 'corkExit', car: car.id, value: v })
    return
  }
  // Only up on the wall or ceiling can the car lose the ribbon (low on the roll it is a crest).
  if ((cf.ny < 0.25 && N < -0.1 * C.gravity) || v < 5) {
    // Not enough speed to stay pinned: the car drops off the ribbon.
    car.cork = -1
    car.grounded = false
    car.corkFall = 0.9
    car.vx += cf.nx * 1.5
    car.vy += cf.ny * 1.5
    car.vz += cf.nz * 1.5
    events.push({ type: 'corkFall', car: car.id, value: v })
  }
}

/**
 * Banked-road anchoring (per unit mass, bank angle θ leaning into a corner of curvature k):
 * normal force N = g·cosθ + a_c·sinθ and down-slope pull P = g·sinθ − a_c·cosθ with
 * a_c = v²·|k|. Tyres hold while P ≤ μ·N; below the anchor speed the car slides down the bank.
 */
export function bankForces(bank: number, k: number, vAlong: number): { normal: number; pull: number; cos: number; sin: number } {
  const g = CONFIG.car.gravity
  const cos = 1 / Math.sqrt(1 + bank * bank)
  const sin = Math.abs(bank) * cos
  const ac = vAlong * vAlong * Math.abs(k)
  return { normal: g * cos + ac * sin, pull: g * sin - ac * cos, cos, sin }
}

/** Minimum speed (m/s) that keeps a car anchored on a bank of cross-slope `bank` and curvature `k`. */
export function bankAnchorSpeed(bank: number, k: number): number {
  const mu = CONFIG.car.bankGrip
  const cos = 1 / Math.sqrt(1 + bank * bank)
  const sin = Math.abs(bank) * cos
  const need = CONFIG.car.gravity * (sin - mu * cos) / Math.max(1e-6, cos + mu * sin)
  return need <= 0 ? 0 : Math.sqrt(need / Math.max(Math.abs(k), 1e-4))
}

/** True when the crest ahead curves down harder than gravity: the car leaves the road. */
function crestLaunch(car: CarState, track: Track, fx: number, fz: number, vF: number): boolean {
  const loc = car.loc
  const vAl = vF * (fx * loc.tx + fz * loc.tz)
  if (vAl < 18 || loc.rampIndex >= 0) return false
  return track.vcurv[loc.i] * vAl * vAl < -CONFIG.car.gravity * 1.05
}

/** Vertical speed of the road surface under the car's horizontal motion. */
function landRoadVy(car: CarState): number {
  const loc = car.loc
  return loc.slope * (car.vx * loc.tx + car.vz * loc.tz)
}
