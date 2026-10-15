/**
 * Cosmetic style chain (presentation only — never read by race rules or AI).
 * Skilful actions add points and bump a multiplier while they keep coming within the chain
 * window; the chain banks after a quiet spell and breaks on hits, crashes and hard wall scrapes.
 */
export type StyleAction = 'drift1' | 'drift2' | 'drift3' | 'pad' | 'padPerfect' | 'trick' | 'dodge' | 'block' | 'draft' | 'overtake' | 'launch' | 'air' | 'wall' | 'cork'

const POINTS: Record<StyleAction, [number, string]> = {
  drift1: [150, 'MINI-TURBO'],
  drift2: [300, 'SUPER TURBO'],
  drift3: [550, 'ULTRA TURBO'],
  pad: [60, 'BOOST PAD'],
  padPerfect: [180, 'PERFECT PAD'],
  trick: [400, 'TRICK'],
  dodge: [350, 'DODGE'],
  block: [250, 'BLOCK'],
  draft: [120, 'SLIPSTREAM'],
  overtake: [300, 'OVERTAKE'],
  launch: [250, 'PERFECT START'],
  air: [100, 'BIG AIR'],
  wall: [320, 'WALL RIDE'],
  cork: [450, 'CORKSCREW'],
}

export const CHAIN_WINDOW = 3.2

export interface StyleSnapshot {
  chain: number
  mult: number
  window: number
  last: string
  total: number
  best: number
}

export class StyleTracker {
  chain = 0
  mult = 1
  timer = 0
  last = ''
  total = 0
  best = 0
  /** Fired when a chain banks (points) or breaks (0). */
  onBank: ((points: number) => void) | null = null

  add(action: StyleAction, count = 1): void {
    const [pts, label] = POINTS[action]
    this.chain += pts * count * this.mult
    this.mult = Math.min(8, this.mult + (this.timer > 0 ? 1 : 0))
    this.timer = CHAIN_WINDOW
    this.last = count > 1 ? `${label} ×${count}` : label
  }

  break(): void {
    if (this.chain <= 0) return
    this.chain = 0
    this.mult = 1
    this.timer = 0
    this.last = 'CHAIN BROKEN'
    this.onBank?.(0)
  }

  update(dt: number): void {
    if (this.timer <= 0) return
    this.timer -= dt
    if (this.timer > 0) return
    const pts = Math.round(this.chain)
    this.total += pts
    this.best = Math.max(this.best, pts)
    this.chain = 0
    this.mult = 1
    this.onBank?.(pts)
  }

  snapshot(): StyleSnapshot {
    return { chain: Math.round(this.chain), mult: this.mult, window: Math.max(0, this.timer / CHAIN_WINDOW), last: this.last, total: this.total, best: this.best }
  }
}
