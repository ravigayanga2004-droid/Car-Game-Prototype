export interface TuningManager {
  readonly controls: readonly unknown[]
  read(): { requested: Record<string, unknown>; active: Record<string, unknown> }
  apply(patch: unknown): void
}
export function registerGameTuning(store: TuningManager): Promise<() => void>
