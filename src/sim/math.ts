/**
 * Deterministic math helpers shared by the simulation and presentation layers.
 * Nothing here reads clocks, the DOM or Math.random: identical inputs give identical outputs.
 */
export const TAU = Math.PI * 2

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}

/** Wrap a track distance difference into (-L/2, L/2]. */
export function wrapDelta(ds: number, length: number): number {
  ds = (ds + length / 2) % length
  if (ds < 0) ds += length
  return ds - length / 2
}

/** Positive modulo. */
export function mod(v: number, m: number): number {
  const r = v % m
  return r < 0 ? r + m : r
}

/** Approach `target` by at most `step`. */
export function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(target, v + step) : Math.max(target, v - step)
}

/** Mulberry32 seeded PRNG in [0, 1). */
export type Rng = () => number
export function rng(seed: number): Rng {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable integer hash of up to three integers and a seed, in [0, 1). */
export function hash3(a: number, b: number, c: number, seed = 0): number {
  let h = (seed ^ 0x9e3779b9) >>> 0
  h = Math.imul(h ^ (a | 0), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13) ^ (b | 0), 0xc2b2ae35) >>> 0
  h = Math.imul(h ^ (h >>> 16) ^ (c | 0), 0x27d4eb2f) >>> 0
  h ^= h >>> 15
  return (h >>> 0) / 4294967296
}

/** Smooth 2D value noise in [-1, 1]. */
export function noise2(x: number, z: number, seed = 0): number {
  const xi = Math.floor(x)
  const zi = Math.floor(z)
  const fx = x - xi
  const fz = z - zi
  const u = fx * fx * (3 - 2 * fx)
  const v = fz * fz * (3 - 2 * fz)
  const a = hash3(xi, zi, 0, seed)
  const b = hash3(xi + 1, zi, 0, seed)
  const c = hash3(xi, zi + 1, 0, seed)
  const d = hash3(xi + 1, zi + 1, 0, seed)
  return (lerp(lerp(a, b, u), lerp(c, d, u), v)) * 2 - 1
}

/** Fractal value noise, roughly in [-1, 1]. */
export function fbm2(x: number, z: number, octaves: number, seed = 0): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  let norm = 0
  for (let i = 0; i < octaves; i += 1) {
    sum += noise2(x * freq, z * freq, seed + i * 101) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.03
  }
  return sum / norm
}

/** 32-bit FNV-1a over a string, for seeds derived from names/codes. */
export function hashString(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
