import type { CarInput, CarState } from './car'

/**
 * Online ghost protocol helpers shared by the browser client and the Node service (bundled into
 * server/sim.mjs). Inputs are quantized before the local simulation uses them so the service can
 * re-simulate exactly the same numbers.
 */
export const PROTOCOL = 'canyon-ghost-v1'
export const MAX_SEATS = 3
export const INPUTS_PER_MESSAGE = 240
export const GHOST_HZ = 10

const STEER_STEPS = 63
const PEDAL_STEPS = 15

/** Quantize in place (steer 1/63, pedals 1/15). */
export function quantizeInput(inp: CarInput): CarInput {
  inp.steer = Math.round(Math.max(-1, Math.min(1, inp.steer)) * STEER_STEPS) / STEER_STEPS
  inp.throttle = Math.round(Math.max(0, Math.min(1, inp.throttle)) * PEDAL_STEPS) / PEDAL_STEPS
  inp.brake = Math.round(Math.max(0, Math.min(1, inp.brake)) * PEDAL_STEPS) / PEDAL_STEPS
  return inp
}

/** 19-bit packing: throttle 4, brake 4, steer 7 (offset 63), flags 4. */
export function packInput(inp: CarInput): number {
  const t = Math.round(inp.throttle * PEDAL_STEPS)
  const b = Math.round(inp.brake * PEDAL_STEPS)
  const s = Math.round(inp.steer * STEER_STEPS) + STEER_STEPS
  const f = (inp.drift ? 1 : 0) | (inp.boost ? 2 : 0) | (inp.item ? 4 : 0) | (inp.recover ? 8 : 0)
  return t | (b << 4) | (s << 8) | (f << 15)
}

export function isPackedInput(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1 << 19 && ((v >> 8) & 127) <= STEER_STEPS * 2
}

export function unpackInput(v: number, out: CarInput): CarInput {
  out.throttle = (v & 15) / PEDAL_STEPS
  out.brake = ((v >> 4) & 15) / PEDAL_STEPS
  out.steer = (((v >> 8) & 127) - STEER_STEPS) / STEER_STEPS
  const f = v >> 15
  out.drift = (f & 1) !== 0
  out.boost = (f & 2) !== 0
  out.item = (f & 4) !== 0
  out.recover = (f & 8) !== 0
  return out
}

/** Bounded ghost frame: pose, progress and presentation flags only. */
export interface GhostFrame {
  seat: number
  tick: number
  x: number
  y: number
  z: number
  yaw: number
  v: number
  gates: number
  /** bit0 drift, bit1 boost, bit2 airborne, bit3 finished, bit4 recovering, bit5 lagging, bit6 dnf */
  f: number
  trick: number
}

const r2 = (v: number) => Math.round(v * 100) / 100

export function ghostFrame(seat: number, tick: number, car: CarState, lagging: boolean): GhostFrame {
  const f = (car.drift ? 1 : 0) | (car.boostTime > 0 || car.meterBoosting || car.powerBoosting ? 2 : 0) | (!car.grounded ? 4 : 0) | (car.progress.finished ? 8 : 0) | (car.recovering > 0 ? 16 : 0) | (lagging ? 32 : 0) | (car.progress.dnf ? 64 : 0)
  return { seat, tick, x: r2(car.x), y: r2(car.y), z: r2(car.z), yaw: Math.round(car.yaw * 1000) / 1000, v: r2(car.vF), gates: car.progress.gates, f, trick: car.trick }
}

/** Compact position checksum used to detect client/service divergence. */
export function carCheck(car: CarState): [number, number, number] {
  return [r2(car.x), r2(car.y), r2(car.z)]
}

export function checksMatch(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((v, k) => Math.abs(v - b[k]) <= 0.011)
}

/** Room codes: 4–6 uppercase letters/digits without ambiguous characters. */
export const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function isRoomCode(v: unknown): v is string {
  return typeof v === 'string' && /^[A-HJ-NP-Z2-9]{4,6}$/.test(v)
}
export function randomRoomCode(rand: () => number = Math.random): string {
  let s = ''
  for (let k = 0; k < 5; k += 1) s += ROOM_ALPHABET[Math.floor(rand() * ROOM_ALPHABET.length)]
  return s
}

export function sanitizeName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[^\w .-]/g, '').trim().slice(0, 14) : ''
  return s || 'Racer'
}
