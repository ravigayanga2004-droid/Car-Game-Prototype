export { formatTime, LAPS, MAX_RACE_TIME, ordinal, RECOVERY_PENALTY, TOTAL_GATES } from '../sim/rules'
export { GATES_PER_LAP } from '../sim/track'

/** Escape user-supplied text before it is placed in HTML templates. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}
