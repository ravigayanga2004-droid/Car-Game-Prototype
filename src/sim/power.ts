import type { Track } from './track'

/** Number of stored Power charges a car can carry. */
export const MAX_POWER = 3
/** Power Cells are deliberately distributed through the middle and late parts of every lap. */
const CELL_FRACTIONS = [0.2, 0.34, 0.48, 0.63, 0.78, 0.92]
const CELL_LANES = [-0.5, 0.46, 0, -0.46, 0.5, -0.18]

export interface PowerCellPlacement {
  index: number
  s: number
  lane: number
}

/**
 * Place the same six readable cells on the road for both the fixed-step sim and the Three.js view.
 * The positions are derived only from the track, so Track Lab layouts remain deterministic too.
 */
export function powerCellPlacements(track: Track): PowerCellPlacement[] {
  return CELL_FRACTIONS.map((fraction, index) => {
    const s = track.length * fraction
    const sample = track.sampleIndex(s)
    const laneSpan = Math.max(2.6, track.halfW[sample] - 2.1)
    return { index, s, lane: CELL_LANES[index] * laneSpan }
  })
}
