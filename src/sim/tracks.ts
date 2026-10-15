import { clamp, hashString, rng, TAU } from './math'
import { SHOULDER, Track, type ControlPoint, type FeatureSpec, type SectionKind, type TrackSpec } from './track'

const P = (x: number, z: number, y: number, w: number, kind: SectionKind): ControlPoint => ({ x, y, z, w, kind })

/**
 * The signature circuit: a desert start straight, a winding sandstone canyon with switchbacks,
 * a climb onto an exposed ridge, a bridge over the gorge, a plunging descent back into the
 * canyon and a fast open-desert return.
 */
export const CANYON_CIRCUIT: TrackSpec = {
  id: 'canyon-circuit',
  name: 'Canyon Charge',
  seed: 1977,
  start: 0.5,
  points: [
    P(0, 380, 3, 22, 'open'),
    P(0, 200, 3, 22, 'open'),
    P(15, 60, 6, 20, 'canyon'),
    P(80, -50, 12, 18, 'canyon'),
    P(95, -190, 20, 18, 'canyon'),
    P(45, -300, 28, 18, 'canyon'),
    P(-55, -320, 36, 22, 'canyon'),
    P(-110, -240, 44, 24, 'canyon'),
    P(-80, -150, 51, 22, 'canyon'),
    P(-150, -80, 58, 18, 'canyon'),
    P(-270, -110, 70, 18, 'ridge'),
    P(-380, -210, 82, 18, 'ridge'),
    P(-500, -230, 88, 19, 'ridge'),
    P(-600, -150, 87, 20, 'bridge'),
    P(-640, -30, 85, 20, 'bridge'),
    P(-615, 90, 79, 20, 'ridge'),
    P(-535, 190, 62, 20, 'ridge'),
    P(-420, 250, 40, 20, 'canyon'),
    P(-300, 320, 21, 20, 'canyon'),
    P(-190, 440, 8, 24, 'open'),
    P(-100, 520, 4, 26, 'open'),
    P(-25, 490, 3, 22, 'open'),
  ],
  // Positions are metres from the start line. Hills are roller-coaster crests (airtime at
  // speed) and dips (compressions); mega ramps sit only in front of long straight landings.
  // Banks tilt the tight corners steeply sideways: carry speed or slide down the slope.
  // Twists weave the straights into S-bends.
  features: [
    // Lap opener: a boost-fed corkscrew at the canyon mouth, just past the finish-line jump's landing.
    { type: 'corkscrew', at: 170, len: 110, radius: 8, dir: 1, width: 6 },
    { type: 'items', at: 334 },
    { type: 'ramp', at: 300 },
    { type: 'bank', at: 356, len: 80, deg: 32 },
    { type: 'twist', at: 488, len: 190, amp: 8, cycles: 1.5 },
    { type: 'hill', at: 405, amp: 5, len: 80 },
    { type: 'hill', at: 468, amp: -6, len: 80 },
    { type: 'hill', at: 528, amp: 5, len: 80 },
    { type: 'boost', at: 580, lane: 0 },
    { type: 'bank', at: 682, len: 210, deg: 58 },
    { type: 'bank', at: 968, len: 196, deg: 64 },
    { type: 'items', at: 1080 },
    { type: 'boost', at: 1112, lane: 4 },
    { type: 'twist', at: 1118, len: 140, amp: 8 },
    { type: 'hill', at: 1150, amp: -6, len: 90 },
    { type: 'hill', at: 1240, amp: 14, len: 150 },
    { type: 'bank', at: 1365, len: 200, deg: 52 },
    { type: 'boost', at: 1480, lane: -4 },
    { type: 'boost', at: 1600, lane: 0 },
    { type: 'ramp', at: 1662 },
    { type: 'boost', at: 1745, lane: 0 },
    { type: 'twist', at: 1772, len: 146, amp: 9 },
    { type: 'items', at: 1862 },
    { type: 'hill', at: 1900, amp: 13, len: 156 },
    { type: 'mega', at: 2012 },
    // Desert corkscrew: rolls the other way, then drops straight into the 62° sweeper.
    { type: 'corkscrew', at: 2330, len: 120, radius: 9, dir: -1, width: 7 },
    { type: 'bank', at: 2556, len: 196, deg: 62 },
    { type: 'boost', at: 2544, lane: -3 },
    { type: 'mega', at: 2702 },
  ],
}

// ─── Track Lab ─────────────────────────────────────────────────────────────

export interface LabParams {
  name: string
  seed: number
  /** 0.7 – 1.3 overall scale. */
  size: number
  /** 0 – 1 corner intensity. */
  twist: number
  /** 0 – 1 elevation change. */
  hills: number
  /** 16 – 24 m asphalt width. */
  width: number
  /** 0 – 1 share of canyon sections. */
  canyon: number
  ramps: number
  pads: number
  items: number
}

export const DEFAULT_LAB: LabParams = { name: 'Mesa Sprint', seed: 4242, size: 1, twist: 0.55, hills: 0.5, width: 20, canyon: 0.5, ramps: 2, pads: 5, items: 2 }

export function sanitizeLab(p: Partial<LabParams>): LabParams {
  const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : def)
  const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 24) : DEFAULT_LAB.name
  return {
    name,
    seed: Math.floor(num(p.seed, 0, 999999, DEFAULT_LAB.seed)),
    size: num(p.size, 0.7, 1.3, DEFAULT_LAB.size),
    twist: num(p.twist, 0, 1, DEFAULT_LAB.twist),
    hills: num(p.hills, 0, 1, DEFAULT_LAB.hills),
    width: num(p.width, 16, 24, DEFAULT_LAB.width),
    canyon: num(p.canyon, 0, 1, DEFAULT_LAB.canyon),
    ramps: Math.round(num(p.ramps, 0, 4, DEFAULT_LAB.ramps)),
    pads: Math.round(num(p.pads, 0, 10, DEFAULT_LAB.pads)),
    items: Math.round(num(p.items, 0, 4, DEFAULT_LAB.items)),
  }
}

export function labId(p: LabParams): string {
  const h = hashString(JSON.stringify({ ...p, name: '' })).toString(36)
  return `lab-${h}`
}

/** Compact share code for a Track Lab layout. */
export function encodeLab(p: LabParams): string {
  const parts = [p.seed, Math.round(p.size * 100), Math.round(p.twist * 100), Math.round(p.hills * 100), Math.round(p.width), Math.round(p.canyon * 100), p.ramps, p.pads, p.items]
  return `CC1-${parts.map(v => v.toString(36)).join('.')}-${encodeURIComponent(p.name).replace(/-/g, '%2D')}`
}

export function decodeLab(code: string): LabParams | null {
  const m = /^CC1-([0-9a-z.]+)-(.*)$/i.exec(code.trim())
  if (!m) return null
  const v = m[1].split('.').map(x => parseInt(x, 36))
  if (v.length !== 9 || v.some(x => !Number.isFinite(x))) return null
  let name = DEFAULT_LAB.name
  try { name = decodeURIComponent(m[2]) } catch { /* keep default */ }
  return sanitizeLab({ name, seed: v[0], size: v[1] / 100, twist: v[2] / 100, hills: v[3] / 100, width: v[4], canyon: v[5] / 100, ramps: v[6], pads: v[7], items: v[8] })
}

function buildLabSpec(p: LabParams, twist: number): TrackSpec {
  const r = rng(p.seed * 7919 + 17)
  const N = 12 + Math.round(twist * 4)
  const R = 380 * p.size
  const phase = r() * TAU
  const squash = 0.72 + r() * 0.26
  const points: ControlPoint[] = []
  for (let k = 0; k < N; k += 1) {
    const theta = (TAU * k) / N + (r() - 0.5) * 0.3 * (TAU / N)
    let radius = R * (1 + (r() - 0.5) * 0.8 * twist)
    if (k % 3 === 1) radius -= R * 0.22 * twist
    const x = radius * Math.cos(theta)
    const z = radius * Math.sin(theta) * squash
    const y = Math.max(2, 3 + p.hills * (22 + 22 * Math.sin(theta * 2 + phase)) + p.hills * 10 * (r() - 0.5))
    points.push({ x, y, z, w: p.width, kind: 'open' })
  }
  for (let k = 0; k < N; k += 1) {
    const roll = r()
    points[k].kind = roll < p.canyon ? 'canyon' : points[k].y > 20 ? 'ridge' : 'open'
  }
  if (p.hills > 0.35) {
    let hi = 0
    for (let k = 1; k < N; k += 1) if (points[k].y > points[hi].y) hi = k
    points[hi].kind = 'bridge'
    points[(hi + 1) % N].kind = 'bridge'
    points[(hi + N - 1) % N].kind = points[(hi + N - 1) % N].kind === 'canyon' ? 'ridge' : points[(hi + N - 1) % N].kind
  }
  const features: FeatureSpec[] = []
  // Every second ramp is a mega ramp; roller-coaster crests and dips scale with `hills`.
  for (let j = 0; j < p.ramps; j += 1) features.push({ type: j % 2 === 1 ? 'mega' : 'ramp', u: ((j + 0.5) / p.ramps) * N + 0.55 })
  if (p.hills > 0.05) {
    const count = 2 + Math.round(p.hills * 4)
    for (let j = 0; j < count; j += 1) {
      const crest = j % 3 !== 2
      const amp = 4 + p.hills * 8 + r() * 2
      // Length grows with height so grades stay drivable (peak grade ≈ π·amp/len ≤ 0.3).
      features.push({ type: 'hill', u: ((j + 0.8) / count) * N + 0.1, amp: (crest ? 1 : -1) * amp, len: Math.max(70 + r() * 40, amp * 11) })
    }
  }
  // Steep banked walls on the tightened corners, and S-bend twists on the stretches between
  // them — kept clear of ramp landings so nobody lands mid-twist.
  const rampU = features.filter(f => f.type === 'ramp' || f.type === 'mega').map(f => f.u ?? 0)
  const clearOfRamps = (u: number) => rampU.every(ru => Math.abs(((u - ru + N * 1.5) % N) - N / 2) > 1.1)
  for (let k = 1; k < N; k += 3) {
    if (points[k].kind === 'bridge') continue
    features.push({ type: 'bank', u: k, deg: 34 + 28 * twist + r() * 6, len: 110 + 50 * p.size })
  }
  if (twist > 0.25) {
    let placed = 0
    for (let k = 2; k < N && placed < (twist > 0.6 ? 2 : 1); k += 3) {
      const u = k + 0.5
      if (!clearOfRamps(u) || points[k].kind === 'bridge' || points[(k + 1) % N].kind === 'bridge') continue
      features.push({ type: 'twist', u, amp: 5 + 5 * twist, len: 130 + r() * 20 })
      placed += 1
    }
  }
  for (let j = 0; j < p.pads; j += 1) features.push({ type: 'boost', u: ((j + 0.3) / p.pads) * N + 0.35, lane: [-4, 0, 4][j % 3] })
  for (let j = 0; j < p.items; j += 1) features.push({ type: 'items', u: ((j + 0.15) / p.items) * N + 0.2 })
  return { id: labId(p), name: p.name, seed: p.seed, points, features }
}

export type TrackCheck = { ok: boolean; length: number; minRadius: number; minGap: number; maxSlope: number }

/** Geometric sanity: drivable corner radii, no overlapping sections, sane grades. */
export function checkTrack(track: Track): TrackCheck {
  let maxK = 0
  let maxSlope = 0
  for (let i = 0; i < track.n; i += 1) {
    maxK = Math.max(maxK, Math.abs(track.curv[i]))
    maxSlope = Math.max(maxSlope, Math.abs(track.slope[i]))
  }
  let minGap = Infinity
  const step = 3
  const sep = Math.round(90 / track.ds)
  for (let i = 0; i < track.n; i += step) {
    for (let j = i + sep; j < track.n; j += step) {
      if (track.n - (j - i) < sep) continue
      const dy = Math.abs(track.y[i] - track.y[j])
      if (dy > 16) continue
      const gap = Math.hypot(track.x[i] - track.x[j], track.z[i] - track.z[j]) - (track.halfW[i] + track.halfW[j] + 2 * SHOULDER)
      minGap = Math.min(minGap, gap)
    }
  }
  const minRadius = maxK > 0 ? 1 / maxK : Infinity
  return { ok: minRadius >= 24 && minGap >= 22 && maxSlope <= 0.46 && track.length >= 1400, length: track.length, minRadius, minGap, maxSlope }
}

/** Build a drivable Track Lab layout, relaxing the corner intensity until it validates. */
export function generateLabTrack(params: LabParams): { spec: TrackSpec; track: Track; check: TrackCheck } {
  const p = sanitizeLab(params)
  let twist = p.twist
  let last: { spec: TrackSpec; track: Track; check: TrackCheck } | null = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const spec = buildLabSpec(p, twist)
    const track = new Track(spec)
    const check = checkTrack(track)
    last = { spec, track, check }
    if (check.ok) return last
    twist *= 0.8
  }
  return last!
}
