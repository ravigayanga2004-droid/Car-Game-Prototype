import { wrapDelta } from './math'
import { GATES_PER_LAP } from './track'

/** Pure race rules. No rendering, input or network code may decide any of these outcomes. */
export const LAPS = 3
export const TOTAL_GATES = LAPS * GATES_PER_LAP
export const MAX_RACE_TIME = 300
export const RECOVERY_PENALTY = 3
export const COUNTDOWN = 3

export interface Progress {
  /** Valid ordered gate crossings so far (0 – 48). */
  gates: number
  lapStart: number
  lapTimes: number[]
  gateTimes: number[]
  penalty: number
  recoveries: number
  finished: boolean
  dnf: boolean
  /** Race clock at the 48th gate (excludes penalties). */
  finishTime: number
}

export function newProgress(): Progress {
  return { gates: 0, lapStart: 0, lapTimes: [], gateTimes: [], penalty: 0, recoveries: 0, finished: false, dnf: false, finishTime: 0 }
}

export const lapOf = (p: Progress): number => Math.min(LAPS, Math.floor(p.gates / GATES_PER_LAP) + 1)
export const nextGateIndex = (p: Progress): number => p.gates % GATES_PER_LAP
export const totalTime = (p: Progress): number => p.finishTime + p.penalty

/**
 * True when a move from `sPrev` by the signed along-track distance `ds` crosses the gate at
 * `sGate` in the forward direction. Backwards crossings never count.
 */
export function crossesForward(sPrev: number, ds: number, sGate: number, length: number): boolean {
  if (ds <= 0) return false
  const rel = wrapDelta(sPrev - sGate, length)
  return rel < 0 && rel + ds >= 0
}

export type GateResult = 'none' | 'gate' | 'lap' | 'finish'

/** Register a valid crossing of the next expected gate at race clock `time`. */
export function passGate(p: Progress, time: number): GateResult {
  if (p.finished || p.dnf) return 'none'
  p.gates += 1
  p.gateTimes.push(time)
  if (p.gates % GATES_PER_LAP === 0) {
    p.lapTimes.push(time - p.lapStart)
    p.lapStart = time
    if (p.gates >= TOTAL_GATES) {
      p.finished = true
      p.finishTime = time
      return 'finish'
    }
    return 'lap'
  }
  return 'gate'
}

/**
 * Recovery penalty: the RECOVERY_PENALTY seconds are served on track as a respawn hold
 * countdown (the race clock keeps running), so nothing is added to the finish time.
 */
export function addRecoveryPenalty(p: Progress): void {
  if (p.finished || p.dnf) return
  p.recoveries += 1
}

/** Apply the 300-second limit; returns true when this call marked the car DNF. */
export function applyTimeLimit(p: Progress, time: number): boolean {
  if (p.finished || p.dnf || time < MAX_RACE_TIME) return false
  p.dnf = true
  return true
}

export interface Standing {
  id: number
  progress: Progress
  /** Distance still to travel to the next gate (m); tie-break for unfinished cars. */
  toNext: number
}

/** Finishers by total time (clock + penalties), then unfinished cars by gates and distance. */
export function compareStandings(a: Standing, b: Standing): number {
  const fa = a.progress.finished, fb = b.progress.finished
  if (fa && fb) return totalTime(a.progress) - totalTime(b.progress) || a.id - b.id
  if (fa !== fb) return fa ? -1 : 1
  if (a.progress.dnf !== b.progress.dnf) return a.progress.dnf ? 1 : -1
  return b.progress.gates - a.progress.gates || a.toNext - b.toNext || a.id - b.id
}

export function bestLap(p: Progress): number {
  return p.lapTimes.length ? Math.min(...p.lapTimes) : 0
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`
}

export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
