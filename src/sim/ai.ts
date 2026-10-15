import { CONFIG } from '../game/config'
import { bankAnchorSpeed, DT, idleInput, TRICK_TIME, type CarInput } from './car'
import { clamp, mod, rng, wrapAngle, wrapDelta, type Rng } from './math'
import type { RaceSim } from './race'

/**
 * AI rival. It produces ordinary CarInput for the shared car model; skill only changes line
 * choice, braking points and item/drift decisions — never grip, speed or acceleration.
 */
export type AiSkill = 'relaxed' | 'pro'

const frame = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }

export class AiDriver {
  private readonly rand: Rng
  private lane = 0
  private laneTimer = 0
  private launchAt: number
  private itemHold = 0
  private itemPulse = false
  private dodgeDecided = false
  private dodgeWill = false
  private boostHold = false
  private recoverPulse = false
  private readonly latA: number
  private readonly driftSkill: number

  constructor(readonly carId: number, readonly skill: AiSkill, seed: number) {
    this.rand = rng(seed * 31 + carId * 977 + 5)
    this.launchAt = skill === 'pro' ? 0.1 + this.rand() * 0.3 : 0.1 + this.rand() * 0.9
    this.latA = skill === 'pro' ? 31 : 25
    this.driftSkill = skill === 'pro' ? 0.9 : 0.5
  }

  think(sim: RaceSim): CarInput {
    const car = sim.cars[this.carId]
    const track = sim.track
    const inp = idleInput()
    if (sim.phase === 'countdown') {
      inp.throttle = sim.countdown <= this.launchAt ? 1 : 0
      return inp
    }
    if (car.recovering > 0 || car.wreck > 0) return inp
    if (car.hold > 0) {
      // Same relaunch timing rule as players: press throttle inside the last 0.4 s.
      inp.throttle = car.hold <= this.launchAt ? 1 : 0
      return inp
    }
    if (this.recoverPulse) {
      this.recoverPulse = false
      return inp
    }
    if ((car.stuck > 1.6 || car.wrongWay > 2.5) && !car.progress.finished) {
      this.recoverPulse = true
      inp.recover = true
      return inp
    }

    const sp = Math.max(0, car.vF)
    const s = car.loc.s
    const hw = car.loc.halfW
    this.laneTimer -= DT
    if (this.laneTimer <= 0) {
      this.lane = (this.rand() - 0.5) * 2 * (hw - 3) * 0.55
      this.laneTimer = 2 + this.rand() * 3
    }
    let lane = this.lane

    // Line toward boost pads ahead (skilled drivers aim for the perfect centre).
    for (const pad of track.pads) {
      const ahead = wrapDelta(pad.s - s, track.length)
      if (ahead > 8 && ahead < 70 && (this.skill === 'pro' || pad.index % 2 === 0)) lane = pad.d
    }
    // Overtaking: avoid sitting right behind a slower car.
    for (const other of sim.cars) {
      if (other === car) continue
      const ahead = wrapDelta(other.loc.s - s, track.length)
      if (ahead > 2 && ahead < 18 && Math.abs(other.loc.d - lane) < 3 && other.vF < sp + 2) {
        lane = other.loc.d + (other.loc.d > 0 ? -4.5 : 4.5)
      }
    }
    // Mines ahead.
    for (const m of sim.mines) {
      const ahead = wrapDelta(m.s - s, track.length)
      if (ahead > 0 && ahead < 55 && Math.abs(m.d - lane) < 3.6) lane = m.d + (m.d > 0 ? -4.8 : 4.8)
    }
    // Seeker lock: dodge by changing lanes (decided once per lock).
    if (car.warnLocked) {
      if (!this.dodgeDecided) {
        this.dodgeDecided = true
        this.dodgeWill = this.rand() < (this.skill === 'pro' ? 0.85 : 0.5)
      }
      if (this.dodgeWill) lane = car.warnLockD + (car.warnLockD > 0 ? -5.5 : 5.5)
    } else this.dodgeDecided = false
    lane = clamp(lane, -hw + 2.2, hw - 2.2)

    // Steering toward a look-ahead point on the chosen lane.
    const look = 9 + sp * 0.42
    track.frameAt(s + look, frame)
    const tx = frame.x + frame.rx * lane
    const tz = frame.z + frame.rz * lane
    const desired = Math.atan2(tx - car.x, tz - car.z)
    const err = wrapAngle(desired - car.yaw)
    inp.steer = clamp(-err * 2.4, -1, 1)

    // Speed planning from upcoming curvature.
    const kAhead = track.maxCurvature(s, 4, 22 + sp * 1.5)
    const latA = this.latA * CONFIG.race.aiPace * (car.drift ? 1.35 : 1)
    let vMax = Math.sqrt(latA / Math.max(kAhead, 1e-4))
    // Banked corners carry the turn: allow more speed, and never drop below the anchor speed.
    for (let dAhead = 0; dAhead <= 30 + sp * 1.2; dAhead += 6) {
      const j = track.sampleIndex(s + dAhead)
      const b = track.bank[j]
      if (Math.abs(b) < 0.25) continue
      const k = Math.abs(track.curv[j])
      const sinB = Math.abs(b) / Math.sqrt(1 + b * b)
      vMax = Math.max(vMax, Math.sqrt((latA + CONFIG.car.gravity * sinB * 1.1) / Math.max(k, 1e-4)), bankAnchorSpeed(b, k) * 1.3 + 4)
    }
    if (sp > vMax + 3) {
      inp.brake = clamp((sp - vMax) / 14, 0.15, 1)
    } else inp.throttle = 1

    // Drift through sharp corners for mini-turbo charge.
    const iNear = track.sampleIndex(s + 12)
    const kNear = Math.abs(track.curv[iNear])
    const turnSign = track.curv[iNear] < 0 ? 1 : -1
    if (!car.drift) {
      const kFar = track.curv[track.sampleIndex(s + 34)]
      const sameWay = Math.abs(kFar) < 1 / 400 || (kFar < 0 ? 1 : -1) === turnSign
      if (kNear > 1 / 75 && sp > 28 && car.grounded && sameWay && this.rand() < this.driftSkill * 0.25) {
        inp.drift = true
        inp.steer = turnSign
      }
    } else {
      const kExit = track.maxCurvature(s, 0, 20)
      // Release before an S-bend flips direction (a committed drift cannot counter-steer).
      let flips = false
      for (const dA of [6, 16, 28]) {
        const kk = track.curv[track.sampleIndex(s + dA)]
        if (Math.abs(kk) > 1 / 400 && (kk < 0 ? 1 : -1) !== car.driftDir) flips = true
      }
      const keep = kExit > 1 / 130 && car.driftTier < 3 && !flips
      inp.drift = keep
      if (keep) {
        const k = Math.abs(track.curv[track.sampleIndex(s + 8)])
        // Tighten or widen the drift so its yaw rate matches the corner, then hold the lane.
        const need = sp * k
        const sd = clamp((need - CONFIG.car.driftBase) / CONFIG.car.driftSteer, -1, 1)
        inp.steer = clamp(car.driftDir * sd + clamp(-err * 1.5, -0.7, 0.7), -1, 1)
        inp.throttle = 1
        inp.brake = 0
      }
    }

    // Air tricks: flip early on big jumps when there is air time left.
    if (!car.grounded && car.trick === 0 && car.tricks === 0 && car.airTime > 0.1 && car.vy > 3) {
      // Conservative landing estimate against the current road height (crests only fall away further).
      const g = CONFIG.car.gravity
      const h = Math.max(0, car.y - car.loc.roadY)
      const tLand = (car.vy + Math.sqrt(car.vy * car.vy + 2 * g * h)) / g
      if (tLand > TRICK_TIME + 0.2 && this.rand() < (this.skill === 'pro' ? 0.2 : 0.06)) inp.drift = true
    }

    // Nitro: tap when charged on a straight, or to carry speed into a corkscrew.
    const straight = track.maxCurvature(s, 0, 140) < 1 / 260
    const cork = track.corkAhead(s, 60)
    const wantNitro = (car.power > 0 || car.meter >= 1) && car.nitro <= 0 && car.grounded &&
      ((straight && car.cork < 0 && cork.index < 0) || (cork.index >= 0 && car.vF < 46) || (car.cork >= 0 && car.vF < 34))
    inp.boost = wantNitro && !this.boostHold
    this.boostHold = inp.boost

    // Items.
    if (car.item) {
      this.itemHold += DT
      let use = false
      if (car.item === 'canister') use = this.itemHold > 0.5
      else if (car.item === 'shield') use = car.warnSeeker >= 0 && car.warnSeeker < 160
      else if (car.item === 'seeker') use = car.place > 1 && this.itemHold > 1.2
      else if (car.item === 'mine') {
        const behind = sim.cars.some(o => o !== car && mod(car.loc.s - o.loc.s, track.length) < 60 && Math.abs(o.loc.d - car.loc.d) < 5)
        use = (behind && this.itemHold > 0.6) || this.itemHold > 9
      }
      if (use && !this.itemPulse) {
        inp.item = true
        this.itemPulse = true
        this.itemHold = 0
      } else this.itemPulse = false
    } else {
      this.itemHold = 0
      this.itemPulse = false
    }
    return inp
  }
}
