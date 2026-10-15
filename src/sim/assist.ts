import { CONFIG } from '../game/config'
import { bankAnchorSpeed, type CarInput, type CarState } from './car'
import { clamp, wrapAngle } from './math'
import type { Track } from './track'

/**
 * Corner assist: Off / Light / Strong per human player (Strong by default, set in Settings).
 *
 * A pure input shaper: it only nudges the player's own steering/throttle/brake values before
 * they reach the car model (and before online quantisation/recording), exactly like a steering
 * wheel with a helpful hand on it. It never changes grip, speed or any car stat, so every car
 * still has identical performance and online re-simulation stays deterministic.
 *
 * - Corner guidance: in a bend, a steering input weaker than the road needs is blended toward
 *   the line that follows the road at the car's current lane. Deliberate lane changes against
 *   the bend and straights are left alone.
 * - Edge guard: drifting toward the edge of the asphalt steers back inward before a wall hit.
 * - Entry speed: arriving at a corner far too fast lifts throttle, then adds light braking.
 *   Banked walls and corkscrews keep their anchor speed, and nitro is never cancelled.
 * Drifts, airtime, corkscrew rails, holds and recovery are untouched (player skill stays).
 *
 * Strength is one blend value: Light halves the steering and edge correction and only lifts off
 * the throttle when far too fast (never brakes); Strong is the full tuning; Off does nothing.
 */
export type AssistStrengthName = 'off' | 'light' | 'strong'
export const ASSIST_STRENGTH: Record<AssistStrengthName, number> = { off: 0, light: 0.5, strong: 1 }

export interface AssistResult {
  /** 0..1 how hard the assist is correcting this tick (HUD feedback only). */
  level: number
}

const frame = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
const EDGE_ZONE = 3.2
const LAT_A = 30

export function applyCornerAssist(car: CarState, track: Track, inp: CarInput, out?: AssistResult, strength = 1): void {
  if (out) out.level = 0
  if (!(strength > 0)) return
  const k = Math.min(1, strength)
  if (!car.grounded || car.cork >= 0 || car.recovering > 0 || car.wreck > 0 || car.hold > 0 || car.spin > 0) return
  if (car.progress.finished || car.progress.dnf) return
  const sp = car.vF
  if (sp < 9) return
  const s = car.loc.s
  const i = car.loc.i
  // Only when driving the right way along the road.
  if (Math.cos(wrapAngle(car.yaw - track.heading[i])) < 0.4) return
  const hw = car.loc.halfW
  const d = car.loc.d
  const raw = clamp(inp.steer, -1, 1)
  let level = 0

  // Lateral drift toward the edge (m/s, + = toward +d).
  track.frameAt(s, frame)
  const latV = car.vx * frame.rx + car.vz * frame.rz
  const margin = hw - Math.abs(d)
  const outward = Math.sign(d) !== 0 && Math.sign(latV) === Math.sign(d) && Math.abs(latV) > 0.6
  let wEdge = 0
  let lane = clamp(d, -(hw - 2.6), hw - 2.6)
  if (margin < EDGE_ZONE && outward) {
    wEdge = clamp((EDGE_ZONE - margin) / EDGE_ZONE, 0, 1) * 0.75 * k
    lane = Math.sign(d) * Math.max(0, hw - 4.6)
  }

  // Ideal steer toward a look-ahead point on the chosen lane (same convention as the AI).
  const look = 8 + sp * 0.38
  track.frameAt(s + look, frame)
  const tx = frame.x + frame.rx * lane
  const tz = frame.z + frame.rz * lane
  const err = wrapAngle(Math.atan2(tx - car.x, tz - car.z) - car.yaw)
  const ideal = clamp(-err * 2.2, -1, 1)

  if (!car.drift) {
    let w = 0
    const bend = Math.abs(ideal) > 0.12 && track.maxCurvature(s, 0, 18 + sp * 0.8) > 1 / 320
    if (bend) {
      const agree = Math.abs(raw) < 0.15 || raw * ideal > 0
      if (agree) w = (Math.abs(raw) < Math.abs(ideal) ? 0.5 : 0.15) * k
    }
    w = Math.max(w, wEdge)
    if (w > 0) {
      const next = raw + (ideal - raw) * w
      level = Math.max(level, Math.min(1, Math.abs(next - raw) * 1.6))
      inp.steer = clamp(next, -1, 1)
    }
  } else if (wEdge > 0) {
    // Drifting into the edge: widen the drift a little instead of fighting it.
    const next = clamp(raw + (ideal - raw) * wEdge * 0.5, -1, 1)
    level = Math.max(level, Math.min(1, Math.abs(next - raw) * 1.6))
    inp.steer = next
  }

  // Entry speed: never below a bank's anchor speed, never during nitro, never over the player's brake.
  if (car.nitro <= 0 && !car.drift && inp.throttle > 0 && inp.brake <= 0) {
    const kAhead = track.maxCurvature(s, 4, 22 + sp * 1.5)
    let vMax = Math.sqrt(LAT_A / Math.max(kAhead, 1e-4))
    for (let dAhead = 0; dAhead <= 30 + sp * 1.2; dAhead += 6) {
      const j = track.sampleIndex(s + dAhead)
      const b = track.bank[j]
      if (Math.abs(b) < 0.25) continue
      const k = Math.abs(track.curv[j])
      const sinB = Math.abs(b) / Math.sqrt(1 + b * b)
      vMax = Math.max(vMax, Math.sqrt((LAT_A + CONFIG.car.gravity * sinB * 1.1) / Math.max(k, 1e-4)), bankAnchorSpeed(b, k) * 1.3 + 4)
    }
    if (track.corkAhead(s, 90).index >= 0) vMax = Infinity
    const over = sp - vMax
    // Strong lifts at +4 m/s and brakes past +10; Light only lifts, and only past +8.
    const lift = k >= 1 ? 4 : 8
    if (over > lift) {
      inp.throttle = 0
      if (k >= 1 && over > 10) inp.brake = clamp((over - 10) / 20, 0.1, 0.5)
      level = Math.max(level, clamp(over / 16, 0.3, 1))
    }
  }
  if (out) out.level = level
}
