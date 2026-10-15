import { clamp, lerp, mod, smoothstep, wrapAngle, wrapDelta } from './math'

/**
 * Track geometry shared by simulation, AI and presentation.
 *
 * A closed centripetal Catmull-Rom spline through control points is resampled at a uniform
 * ~2 m spacing. Every sample stores a frame (tangent/right), width, banking, curvature and
 * section weights. The simulation only uses these arrays; the renderer builds meshes from the
 * very same data so collision edges always match what the player sees.
 */
export type SectionKind = 'canyon' | 'ridge' | 'bridge' | 'open'

export interface ControlPoint {
  x: number
  y: number
  z: number
  /** Asphalt width in metres. */
  w: number
  kind: SectionKind
}

export interface FeatureSpec {
  /**
   * `mega` = absurdly tall launch ramp; `hill` = roller-coaster crest (amp > 0) or dip (amp < 0);
   * `bank` = steep banked corner (`deg`, leaning into the local curvature); `twist` = S-bends that
   * weave the road sideways by `amp` metres over `len`; `corkscrew` = a full 360° barrel-roll
   * section starting at `at` (`len` long, `radius` metres, rolling toward `dir`), fed by boost pads.
   */
  type: 'boost' | 'ramp' | 'items' | 'mega' | 'hill' | 'bank' | 'twist' | 'corkscrew'
  /** Spline parameter: control-point index plus fraction. */
  u?: number
  /** Exact track distance from the start line (m); overrides `u`. */
  at?: number
  /** Lateral offset for boost pads (m, positive = right). */
  lane?: number
  /** Hill height (m); negative for a dip. */
  amp?: number
  /** Hill / bank / twist length along the track (m). */
  len?: number
  /** Bank angle in degrees (bank features). */
  deg?: number
  /** Number of full S-cycles (twist features, default 1). */
  cycles?: number
  /** Corkscrew roll radius (m). */
  radius?: number
  /** Corkscrew roll direction: +1 climbs the right side first, -1 the left. */
  dir?: number
  /** Corkscrew ribbon half-width (m) at full roll. */
  width?: number
}

export interface TrackSpec {
  id: string
  name: string
  seed: number
  points: ControlPoint[]
  features: FeatureSpec[]
  /** Spline parameter of the start/finish line; omitted = straightest stretch. */
  start?: number
}

export interface BoostPad { index: number; s: number; d: number; len: number; halfW: number; /** Corkscrew index for pads on a roll ribbon, else -1. */ cork: number }
/** A 360° roll section: the ribbon spirals around an axis `radius` above the base road. */
export interface Corkscrew { index: number; s0: number; len: number; radius: number; dir: number; hw: number }
/** Full rail frame on a corkscrew ribbon (position, unit forward, unit surface normal, unit lateral). */
export interface CorkFrame {
  x: number; y: number; z: number
  fx: number; fy: number; fz: number
  nx: number; ny: number; nz: number
  lx: number; ly: number; lz: number
  /** World metres per metre of base-track distance. */
  stretch: number
  /** Normal curvature of the rail path (1/m): centripetal need per v². */
  kn: number
  /** Roll angle (rad, signed by direction). */
  roll: number
}
export const newCorkFrame = (): CorkFrame => ({ x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, nx: 0, ny: 1, nz: 0, lx: 1, ly: 0, lz: 0, stretch: 1, kn: 0, roll: 0 })
export interface Ramp { index: number; s0: number; len: number; height: number; mega: boolean }
export interface ItemRow { index: number; s: number; lanes: number[] }
export interface Gate { index: number; s: number; sample: number }

export interface TrackLoc {
  i: number
  s: number
  d: number
  centerY: number
  roadY: number
  halfW: number
  barrier: number
  wall: boolean
  onRoad: boolean
  onSurface: boolean
  tx: number
  tz: number
  rx: number
  rz: number
  slope: number
  rampH: number
  rampIndex: number
  /** Road cross-slope (tan of the bank angle; road height = centre + bank · d). */
  bank: number
}

export const SHOULDER = 3
const cfBase = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
const cfA = { x: 0, y: 0, z: 0 }
const cfB = { x: 0, y: 0, z: 0 }
/** Mega ramp dimensions (m). */
export const MEGA_RAMP = { len: 42, height: 19 } as const
/** Steepest allowed bank (degrees). */
export const MAX_BANK_DEG = 66
/** Bank tilt is capped so a car doing this speed (m/s) stays anchored (matches the car's default gravity/grip). */
export const BANK_ANCHOR_SPEED = 30
const BANK_G = 30
const BANK_MU = 0.9
export const RAIL_HEIGHT = 1.1
export const GATES_PER_LAP = 16

export function newLoc(): TrackLoc {
  return { i: 0, s: 0, d: 0, centerY: 0, roadY: 0, halfW: 10, barrier: 13, wall: false, onRoad: true, onSurface: true, tx: 0, tz: 1, rx: -1, rz: 0, slope: 0, rampH: 0, rampIndex: -1, bank: 0 }
}

const DENSE_STEPS = 48

export class Track {
  readonly spec: TrackSpec
  readonly n: number
  readonly length: number
  readonly ds: number
  readonly x: Float64Array
  readonly y: Float64Array
  readonly z: Float64Array
  readonly tx: Float64Array
  readonly tz: Float64Array
  readonly rx: Float64Array
  readonly rz: Float64Array
  readonly slope: Float64Array
  /** Vertical curvature d(slope)/ds (negative on crests). */
  readonly vcurv: Float64Array
  readonly halfW: Float64Array
  readonly bank: Float64Array
  readonly curv: Float64Array
  readonly canyon: Float64Array
  readonly ridge: Float64Array
  readonly bridge: Float64Array
  readonly heading: Float64Array
  readonly gates: Gate[]
  readonly pads: BoostPad[]
  readonly ramps: Ramp[]
  readonly items: ItemRow[]
  readonly corks: Corkscrew[]
  readonly bounds: { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number }

  constructor(spec: TrackSpec) {
    this.spec = spec
    const pts = spec.points
    const m = pts.length
    if (m < 4) throw new Error('track needs at least 4 control points')

    // ── Dense spline ──────────────────────────────────────────────────────
    const count = m * DENSE_STEPS + 1
    const dx = new Float64Array(count)
    const dy = new Float64Array(count)
    const dz = new Float64Array(count)
    const cum = new Float64Array(count)
    let idx = 0
    for (let k = 0; k < m; k += 1) {
      const p0 = pts[mod(k - 1, m)]
      const p1 = pts[k]
      const p2 = pts[mod(k + 1, m)]
      const p3 = pts[mod(k + 2, m)]
      for (let j = 0; j < DENSE_STEPS; j += 1) {
        catmull(p0, p1, p2, p3, j / DENSE_STEPS, dx, dy, dz, idx)
        idx += 1
      }
    }
    dx[idx] = dx[0]
    dy[idx] = dy[0]
    dz[idx] = dz[0]
    for (let i = 1; i < count; i += 1) {
      cum[i] = cum[i - 1] + Math.hypot(dx[i] - dx[i - 1], dy[i] - dy[i - 1], dz[i] - dz[i - 1])
    }
    const total = cum[count - 1]
    const sOfU = (u: number): number => {
      const f = mod(u, m) * DENSE_STEPS
      const a = Math.floor(f)
      return lerp(cum[a], cum[Math.min(count - 1, a + 1)], f - a)
    }
    const uOfS = (s: number): number => {
      s = mod(s, total)
      let lo = 0
      let hi = count - 1
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (cum[mid] <= s) lo = mid
        else hi = mid
      }
      const t = (s - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo])
      return (lo + t) / DENSE_STEPS
    }
    const denseAt = (s: number, out: number[]): void => {
      const u = uOfS(s) * DENSE_STEPS
      const a = Math.min(count - 2, Math.floor(u))
      const t = u - a
      out[0] = lerp(dx[a], dx[a + 1], t)
      out[1] = lerp(dy[a], dy[a + 1], t)
      out[2] = lerp(dz[a], dz[a + 1], t)
    }

    const n = Math.max(64, Math.round(total / 2))
    const ds = total / n
    this.n = n
    this.length = total
    this.ds = ds

    // Automatic start: the straightest stretch with a long straight run-up behind it.
    let sStart = spec.start !== undefined ? sOfU(spec.start) : 0
    if (spec.start === undefined) sStart = findStraightest(total, ds, n, denseAt)

    const arr = () => new Float64Array(n)
    this.x = arr(); this.y = arr(); this.z = arr()
    this.tx = arr(); this.tz = arr(); this.rx = arr(); this.rz = arr()
    this.slope = arr(); this.vcurv = arr(); this.halfW = arr(); this.bank = arr(); this.curv = arr()
    this.canyon = arr(); this.ridge = arr(); this.bridge = arr(); this.heading = arr()
    const u = arr()
    const tmp = [0, 0, 0]
    for (let i = 0; i < n; i += 1) {
      const s = sStart + i * ds
      denseAt(s, tmp)
      this.x[i] = tmp[0]
      this.y[i] = tmp[1]
      this.z[i] = tmp[2]
      u[i] = uOfS(s)
    }
    const sAt = (uu: number) => mod(sOfU(uu) - sStart, total)

    // Roller-coaster hills: smooth cosine crests and dips layered on the spline profile.
    for (const f of spec.features) {
      if (f.type !== 'hill') continue
      const c = f.at !== undefined ? mod(f.at, total) : sAt(f.u ?? 0)
      const half = Math.max(20, (f.len ?? 160) / 2)
      const amp = f.amp ?? 12
      for (let i = 0; i < n; i += 1) {
        const rel = wrapDelta(i * ds - c, total)
        if (Math.abs(rel) < half) this.y[i] += amp * (0.5 + 0.5 * Math.cos((Math.PI * rel) / half))
      }
    }

    // Twists: S-bends that weave the road sideways (applied along the pre-twist normal).
    const twists = spec.features.filter(f => f.type === 'twist')
    if (twists.length) {
      const nx = arr(), nz = arr()
      for (let i = 0; i < n; i += 1) {
        const a = mod(i - 1, n), b = (i + 1) % n
        const tx = this.x[b] - this.x[a], tz = this.z[b] - this.z[a]
        const l = Math.hypot(tx, tz) || 1
        nx[i] = -tz / l
        nz[i] = tx / l
      }
      const off = arr()
      for (const f of twists) {
        const c = f.at !== undefined ? mod(f.at, total) : sAt(f.u ?? 0)
        const len = Math.max(80, f.len ?? 200)
        const half = len / 2
        const amp = f.amp ?? 10
        const cycles = Math.max(0.5, f.cycles ?? 1)
        for (let i = 0; i < n; i += 1) {
          const rel = wrapDelta(i * ds - c, total)
          if (Math.abs(rel) >= half) continue
          const env = Math.pow(0.5 + 0.5 * Math.cos((Math.PI * rel) / half), 0.6)
          off[i] += amp * env * Math.sin((2 * Math.PI * cycles * (rel + half)) / len)
        }
      }
      for (let i = 0; i < n; i += 1) {
        this.x[i] += nx[i] * off[i]
        this.z[i] += nz[i] * off[i]
      }
    }

    // Width and raw section weights from control points.
    const rawC = arr(); const rawR = arr(); const rawB = arr()
    for (let i = 0; i < n; i += 1) {
      const k = Math.floor(u[i]) % m
      const t = u[i] - Math.floor(u[i])
      const a = pts[k]
      const b = pts[(k + 1) % m]
      this.halfW[i] = lerp(a.w, b.w, smoothstep(0, 1, t)) / 2
      const wa = t < 1 ? 1 - t : 0
      rawC[i] = (a.kind === 'canyon' ? wa : 0) + (b.kind === 'canyon' ? t : 0)
      rawR[i] = (a.kind === 'ridge' ? wa : 0) + (b.kind === 'ridge' ? t : 0)
      // Bridges span only between two consecutive bridge points.
      rawB[i] = a.kind === 'bridge' && b.kind === 'bridge' ? 1 : a.kind === 'bridge' ? smoothstep(0.35, 0, t) : b.kind === 'bridge' ? smoothstep(0.65, 1, t) : 0
    }
    smoothCircular(rawC, this.canyon, 18)
    smoothCircular(rawR, this.ridge, 18)
    smoothCircular(rawB, this.bridge, 4)

    // Frames, slope and heading.
    for (let i = 0; i < n; i += 1) {
      const a = mod(i - 1, n)
      const b = (i + 1) % n
      let tx = this.x[b] - this.x[a]
      let tz = this.z[b] - this.z[a]
      const len = Math.hypot(tx, tz) || 1
      tx /= len
      tz /= len
      this.tx[i] = tx
      this.tz[i] = tz
      this.rx[i] = -tz
      this.rz[i] = tx
      this.slope[i] = (this.y[b] - this.y[a]) / (2 * ds)
      this.heading[i] = Math.atan2(tx, tz)
    }
    const rawV = arr()
    for (let i = 0; i < n; i += 1) rawV[i] = (this.slope[(i + 1) % n] - this.slope[mod(i - 1, n)]) / (2 * ds)
    smoothCircular(rawV, this.vcurv, 2)
    const rawK = arr()
    for (let i = 0; i < n; i += 1) {
      rawK[i] = wrapAngle(this.heading[(i + 1) % n] - this.heading[mod(i - 1, n)]) / (2 * ds)
    }
    smoothCircular(rawK, this.curv, 5)
    // Corkscrews: resolved first so their zones (plus run-in/out) stay flat and unbanked.
    this.corks = []
    const corkFlat = arr()
    for (const f of spec.features) {
      if (f.type !== 'corkscrew') continue
      const s0 = f.at !== undefined ? mod(f.at, total) : sAt(f.u ?? 0)
      const len = Math.max(80, f.len ?? 120)
      this.corks.push({ index: this.corks.length, s0, len, radius: clamp(f.radius ?? 8, 5, 14), dir: (f.dir ?? 1) < 0 ? -1 : 1, hw: clamp(f.width ?? 6, 4, 9) })
      for (let i = 0; i < n; i += 1) {
        const rel = wrapDelta(i * ds - s0, total)
        const w = smoothstep(-40, -18, rel) * smoothstep(len + 24, len + 6, rel)
        if (w > corkFlat[i]) corkFlat[i] = w
      }
    }

    // Banking: every corner leans in a little (inside edge lower); bank features tilt the road
    // steeply sideways. Bridges stay flat.
    const bankW = arr(), bankT = arr()
    for (const f of spec.features) {
      if (f.type !== 'bank') continue
      const c = f.at !== undefined ? mod(f.at, total) : sAt(f.u ?? 0)
      const half = Math.max(30, f.len ?? 120) / 2
      let kSum = 0
      for (let i = 0; i < n; i += 1) if (Math.abs(wrapDelta(i * ds - c, total)) < half * 0.6) kSum += this.curv[i]
      const sign = kSum < 0 ? -1 : 1
      const tanMax = Math.tan((clamp(f.deg ?? 45, 0, MAX_BANK_DEG) * Math.PI) / 180)
      const ramp = Math.min(half * 0.45, 32)
      const win = Math.max(1, Math.round(15 / ds))
      for (let i = 0; i < n; i += 1) {
        const rel = Math.abs(wrapDelta(i * ds - c, total))
        if (rel >= half) continue
        // Steepest where the corner is tightest: cap the tilt so the anchor speed stays <= BANK_ANCHOR_SPEED.
        let kLoc = 0
        for (let o = -win; o <= win; o += 1) {
          const kk = this.curv[mod(i + o, n)] * sign
          if (kk > kLoc) kLoc = kk
        }
        const q = (BANK_ANCHOR_SPEED * BANK_ANCHOR_SPEED * kLoc) / BANK_G
        const tanCap = kLoc <= 0 ? 0.18 : BANK_MU * q >= 1 ? tanMax : (q + BANK_MU) / (1 - BANK_MU * q)
        const w = smoothstep(half, half - ramp, rel)
        if (w > bankW[i]) { bankW[i] = w; bankT[i] = sign * Math.min(tanMax, tanCap) }
      }
    }
    const rawBank = arr()
    for (let i = 0; i < n; i += 1) rawBank[i] = lerp(clamp(this.curv[i] * 7, -0.18, 0.18), bankT[i], bankW[i])
    const sw = Math.max(1, Math.round(8 / ds))
    for (let i = 0; i < n; i += 1) {
      let sum = 0
      for (let o = -sw; o <= sw; o += 1) sum += rawBank[mod(i + o, n)]
      this.bank[i] = (sum / (2 * sw + 1)) * (1 - this.bridge[i]) * (1 - corkFlat[i])
      // The stored half-width is horizontal. Steep banks become tall wide walls: the tilted
      // surface grows so the plan-view width only shrinks to ~2/3 of a flat road.
      this.halfW[i] *= lerp(1, 1 / Math.sqrt(1 + this.bank[i] * this.bank[i]), 0.6)
    }

    // Gates: 16 per lap, the 16th on the start/finish line.
    this.gates = []
    for (let k = 0; k < GATES_PER_LAP; k += 1) {
      let s = mod(((k + 1) * total) / GATES_PER_LAP, total)
      // Gate gantries never stand inside a corkscrew tube: move them to the nearer end.
      if (k < GATES_PER_LAP - 1) {
        for (const c of this.corks) {
          const rel = wrapDelta(s - c.s0, total)
          if (rel > -5 && rel < c.len + 5) s = mod(rel < c.len / 2 ? c.s0 - 7 : c.s0 + c.len + 7, total)
        }
      }
      this.gates.push({ index: k, s, sample: Math.round(s / ds) % n })
    }

    this.pads = []
    this.ramps = []
    this.items = []
    for (const f of spec.features) {
      if (f.type === 'hill' || f.type === 'bank' || f.type === 'twist' || f.type === 'corkscrew') continue
      let s = f.at !== undefined ? mod(f.at, total) : sAt(f.u ?? 0)
      // The starting grid and finish straight stay clear of ramps, pads and item rows.
      if (s < 70 || s > total - 40) s = mod(s + 110, total)
      const hw = this.halfW[Math.round(s / ds) % n]
      if (f.type === 'boost') this.pads.push({ index: this.pads.length, s, d: clamp(f.lane ?? 0, -hw + 2.2, hw - 2.2), len: 10, halfW: 2.1, cork: -1 })
      else if (f.type === 'ramp') this.ramps.push({ index: this.ramps.length, s0: mod(s - 14, total), len: 14, height: 2.4, mega: false })
      else if (f.type === 'mega') this.ramps.push({ index: this.ramps.length, s0: mod(s - MEGA_RAMP.len, total), len: MEGA_RAMP.len, height: MEGA_RAMP.height, mega: true })
      else if (f.type === 'items') this.items.push({ index: this.items.length, s, lanes: [-0.62, -0.2, 0.2, 0.62].map(t => t * hw) })
    }

    // Corkscrew power: two full-width pad rows on the run-in, then pads around the roll in
    // alternating lanes (grab them to keep the speed that pins you to the ceiling).
    for (const ck of this.corks) {
      const hw = this.halfW[this.sampleIndex(ck.s0 - 20)]
      for (const back of [22, 8]) {
        for (const t of [-0.55, 0, 0.55]) this.pads.push({ index: this.pads.length, s: mod(ck.s0 - back, total), d: t * (hw - 2.2), len: 10, halfW: 2.1, cork: -1 })
      }
      const inner = [0.3, 0.5, 0.7]
      inner.forEach((u, k) => this.pads.push({ index: this.pads.length, s: mod(ck.s0 + ck.len * u, total), d: (k % 2 ? -1 : 1) * ck.dir * ck.hw * 0.42, len: 9, halfW: 2.0, cork: ck.index }))
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity, maxY = -Infinity
    for (let i = 0; i < n; i += 1) {
      minX = Math.min(minX, this.x[i]); maxX = Math.max(maxX, this.x[i])
      minZ = Math.min(minZ, this.z[i]); maxZ = Math.max(maxZ, this.z[i])
      minY = Math.min(minY, this.y[i]); maxY = Math.max(maxY, this.y[i])
    }
    this.bounds = { minX, maxX, minZ, maxZ, minY, maxY }
  }

  /** Sample index nearest to track distance `s`. */
  sampleIndex(s: number): number {
    return mod(Math.round(s / this.ds), this.n)
  }

  barrierAt(i: number): number {
    return this.halfW[i] + SHOULDER + 0.4
  }

  isWall(i: number): boolean {
    return this.canyon[i] > 0.5 && this.bridge[i] < 0.5
  }

  /** Height of the ramp surface at track distance `s` (0 outside ramps). */
  rampAt(s: number): { h: number; index: number } {
    for (const r of this.ramps) {
      const rel = wrapDelta(s - r.s0, this.length)
      if (rel >= 0 && rel <= r.len) return { h: (r.height * rel) / r.len, index: r.index }
    }
    return { h: 0, index: -1 }
  }

  /** Corkscrew index whose roll zone contains track distance `s`, or -1. */
  corkAt(s: number): number {
    for (const ck of this.corks) {
      const rel = wrapDelta(s - ck.s0, this.length)
      if (rel >= 0 && rel < ck.len) return ck.index
    }
    return -1
  }

  /** Distance from `s` to the start of the next corkscrew ahead (Infinity if none within `max`). */
  corkAhead(s: number, max: number): { dist: number; index: number } {
    let best = Infinity, index = -1
    for (const ck of this.corks) {
      const rel = wrapDelta(ck.s0 - s, this.length)
      if (rel >= 0 && rel < max && rel < best) { best = rel; index = ck.index }
    }
    return { dist: best, index }
  }

  /** Roll progress 0..1 through a corkscrew at `s` (clamped). */
  corkU(ck: Corkscrew, s: number): number {
    return clamp(wrapDelta(s - ck.s0, this.length) / ck.len, 0, 1)
  }

  /** Roll angle (rad, 0 → 2π) at `s`: eased in and out so the entry and exit are smooth. */
  corkPhi(ck: Corkscrew, s: number): number {
    const u = this.corkU(ck, s)
    return Math.PI * 2 * u * u * u * (u * (u * 6 - 15) + 10)
  }

  /** Ribbon half-width: tapers from the approach road to the narrow roll and back. */
  corkHalfW(ck: Corkscrew, s: number): number {
    const u = this.corkU(ck, s)
    const w = smoothstep(0, 0.16, u) * smoothstep(1, 0.84, u)
    return lerp(this.halfW[this.sampleIndex(s)], ck.hw, w)
  }

  /** World position of ribbon point (s, d) lifted `h` along the surface normal. */
  corkPoint(ck: Corkscrew, s: number, d: number, h: number, out: { x: number; y: number; z: number }): void {
    this.frameAt(s, cfBase)
    const phi = this.corkPhi(ck, s)
    const c = Math.cos(phi), sn = Math.sin(phi) * ck.dir
    const R = ck.radius
    // Up U = (0,1,0); right Rv = (rx,0,rz). Lateral r = c·Rv + sn·U; normal n = c·U − sn·Rv.
    const off = R * sn
    const lift = R * (1 - c)
    out.x = cfBase.x + cfBase.rx * (off + d * c - h * sn)
    out.z = cfBase.z + cfBase.rz * (off + d * c - h * sn)
    out.y = cfBase.y + lift + d * sn + h * c
  }

  /** Full rail frame with numeric tangent and normal curvature at (s, d). */
  corkFrame(ck: Corkscrew, s: number, d: number, out: CorkFrame): CorkFrame {
    // Wide stencil: the base centreline is piecewise linear between samples, so a narrow
    // second difference would spike at every sample boundary.
    const e = 2.5
    this.corkPoint(ck, s - e, d, 0, cfA)
    this.corkPoint(ck, s + e, d, 0, cfB)
    this.corkPoint(ck, s, d, 0, out)
    let fx = cfB.x - cfA.x, fy = cfB.y - cfA.y, fz = cfB.z - cfA.z
    const l = Math.hypot(fx, fy, fz) || 1
    fx /= l; fy /= l; fz /= l
    const phi = this.corkPhi(ck, s)
    const c = Math.cos(phi), sn = Math.sin(phi) * ck.dir
    this.frameAt(s, cfBase)
    // Lateral and normal from the roll, re-orthogonalised against the true tangent.
    let lx = cfBase.rx * c, ly = sn, lz = cfBase.rz * c
    const lf = lx * fx + ly * fy + lz * fz
    lx -= fx * lf; ly -= fy * lf; lz -= fz * lf
    const ll = Math.hypot(lx, ly, lz) || 1
    lx /= ll; ly /= ll; lz /= ll
    // n = l × f  (points from the ribbon toward the roll axis, i.e. "up" for the car)
    let nx = ly * fz - lz * fy, ny = lz * fx - lx * fz, nz = lx * fy - ly * fx
    const refY = c, refX = -cfBase.rx * sn, refZ = -cfBase.rz * sn
    if (nx * refX + ny * refY + nz * refZ < 0) { nx = -nx; ny = -ny; nz = -nz }
    out.fx = fx; out.fy = fy; out.fz = fz
    out.nx = nx; out.ny = ny; out.nz = nz
    out.lx = lx; out.ly = ly; out.lz = lz
    const stretch = l / (2 * e)
    out.stretch = stretch
    const ax = (cfB.x - 2 * out.x + cfA.x) / (e * e), ay = (cfB.y - 2 * out.y + cfA.y) / (e * e), az = (cfB.z - 2 * out.z + cfA.z) / (e * e)
    out.kn = (ax * nx + ay * ny + az * nz) / (stretch * stretch)
    out.roll = phi * ck.dir
    return out
  }

  /** Interpolated centre-line frame at track distance `s`. */
  frameAt(s: number, out: { x: number; y: number; z: number; tx: number; tz: number; rx: number; rz: number; halfW: number; bank: number }): void {
    const f = mod(s, this.length) / this.ds
    const a = Math.floor(f) % this.n
    const b = (a + 1) % this.n
    const t = f - Math.floor(f)
    out.x = lerp(this.x[a], this.x[b], t)
    out.y = lerp(this.y[a], this.y[b], t)
    out.z = lerp(this.z[a], this.z[b], t)
    let tx = lerp(this.tx[a], this.tx[b], t)
    let tz = lerp(this.tz[a], this.tz[b], t)
    const l = Math.hypot(tx, tz) || 1
    tx /= l
    tz /= l
    out.tx = tx
    out.tz = tz
    out.rx = -tz
    out.rz = tx
    out.halfW = lerp(this.halfW[a], this.halfW[b], t)
    out.bank = lerp(this.bank[a], this.bank[b], t)
  }

  /**
   * Paved width from the centreline: steep banks pave their shoulders into a concrete apron
   * (so wall rides near the rim stay on-road), blending in from ~24° to ~39°.
   */
  pavedW(i: number): number {
    const apron = clamp((Math.abs(this.bank[i]) - 0.45) / 0.35, 0, 1)
    return this.halfW[i] + SHOULDER * apron
  }

  /**
   * Project a world position onto the track. `hint` is the previous sample index (or -1 for a
   * global search). Height is part of the metric so stacked sections never get confused.
   */
  locate(x: number, y: number, z: number, hint: number, out: TrackLoc): TrackLoc {
    const n = this.n
    let best = 0
    let bestD = Infinity
    if (hint < 0) {
      for (let i = 0; i < n; i += 1) {
        const ddx = x - this.x[i], ddz = z - this.z[i], ddy = (y - this.y[i]) * 2
        const dist = ddx * ddx + ddz * ddz + ddy * ddy
        if (dist < bestD) { bestD = dist; best = i }
      }
    } else {
      for (let k = -28; k <= 28; k += 1) {
        const i = mod(hint + k, n)
        const ddx = x - this.x[i], ddz = z - this.z[i], ddy = (y - this.y[i]) * 2
        const dist = ddx * ddx + ddz * ddz + ddy * ddy
        if (dist < bestD) { bestD = dist; best = i }
      }
    }
    const i = best
    const px = x - this.x[i]
    const pz = z - this.z[i]
    const along = clamp(px * this.tx[i] + pz * this.tz[i], -this.ds, this.ds)
    const d = px * this.rx[i] + pz * this.rz[i]
    const s = mod(i * this.ds + along, this.length)
    const halfW = this.halfW[i]
    const centerY = this.y[i] + this.slope[i] * along
    const ramp = Math.abs(d) <= halfW + 0.5 ? this.rampAt(s) : { h: 0, index: -1 }
    out.i = i
    out.s = s
    out.d = d
    out.centerY = centerY
    out.halfW = halfW
    out.barrier = this.barrierAt(i)
    out.wall = this.isWall(i)
    out.onRoad = Math.abs(d) <= this.pavedW(i)
    out.onSurface = Math.abs(d) <= halfW + SHOULDER + 0.5
    out.rampH = ramp.h
    out.rampIndex = ramp.index
    out.roadY = centerY + this.bank[i] * clamp(d, -halfW - SHOULDER, halfW + SHOULDER) + ramp.h
    out.tx = this.tx[i]
    out.tz = this.tz[i]
    out.rx = this.rx[i]
    out.rz = this.rz[i]
    out.slope = this.slope[i]
    out.bank = this.bank[i]
    return out
  }

  /** Maximum |curvature| between two distances ahead of `s` (for AI speed planning). */
  maxCurvature(s: number, from: number, to: number): number {
    let k = 0
    const a = Math.floor((s + from) / this.ds)
    const b = Math.ceil((s + to) / this.ds)
    for (let i = a; i <= b; i += 1) k = Math.max(k, Math.abs(this.curv[mod(i, this.n)]))
    return k
  }
}

function catmull(p0: ControlPoint, p1: ControlPoint, p2: ControlPoint, p3: ControlPoint, t: number, ox: Float64Array, oy: Float64Array, oz: Float64Array, idx: number): void {
  const k = (a: ControlPoint, b: ControlPoint) => Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)))
  const t0 = 0
  const t1 = t0 + k(p0, p1)
  const t2 = t1 + k(p1, p2)
  const t3 = t2 + k(p2, p3)
  const tt = lerp(t1, t2, t)
  const comp = (a: number, b: number, c: number, d: number) => {
    const a1 = ((t1 - tt) / (t1 - t0)) * a + ((tt - t0) / (t1 - t0)) * b
    const a2 = ((t2 - tt) / (t2 - t1)) * b + ((tt - t1) / (t2 - t1)) * c
    const a3 = ((t3 - tt) / (t3 - t2)) * c + ((tt - t2) / (t3 - t2)) * d
    const b1 = ((t2 - tt) / (t2 - t0)) * a1 + ((tt - t0) / (t2 - t0)) * a2
    const b2 = ((t3 - tt) / (t3 - t1)) * a2 + ((tt - t1) / (t3 - t1)) * a3
    return ((t2 - tt) / (t2 - t1)) * b1 + ((tt - t1) / (t2 - t1)) * b2
  }
  ox[idx] = comp(p0.x, p1.x, p2.x, p3.x)
  oy[idx] = comp(p0.y, p1.y, p2.y, p3.y)
  oz[idx] = comp(p0.z, p1.z, p2.z, p3.z)
}

function smoothCircular(src: Float64Array, dst: Float64Array, radius: number): void {
  const n = src.length
  let sum = 0
  for (let k = -radius; k <= radius; k += 1) sum += src[mod(k, n)]
  const w = 2 * radius + 1
  for (let i = 0; i < n; i += 1) {
    dst[i] = sum / w
    sum += src[mod(i + radius + 1, n)] - src[mod(i - radius, n)]
  }
}

function findStraightest(_total: number, ds: number, n: number, denseAt: (s: number, out: number[]) => void): number {
  const hx = new Float64Array(n)
  const hz = new Float64Array(n)
  const tmp = [0, 0, 0]
  for (let i = 0; i < n; i += 1) {
    denseAt(i * ds, tmp)
    hx[i] = tmp[0]
    hz[i] = tmp[2]
  }
  const heading = new Float64Array(n)
  for (let i = 0; i < n; i += 1) heading[i] = Math.atan2(hx[(i + 1) % n] - hx[mod(i - 1, n)], hz[(i + 1) % n] - hz[mod(i - 1, n)])
  let best = 0
  let bestScore = Infinity
  const back = Math.round(140 / ds)
  const ahead = Math.round(60 / ds)
  for (let i = 0; i < n; i += 4) {
    let score = 0
    for (let k = -back; k <= ahead; k += 2) score = Math.max(score, Math.abs(wrapAngle(heading[mod(i + k + 1, n)] - heading[mod(i + k - 1, n)])))
    if (score < bestScore) { bestScore = score; best = i }
  }
  return best * ds
}
