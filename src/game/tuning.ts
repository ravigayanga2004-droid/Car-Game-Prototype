import { CONFIG, DEFAULT_CONFIG } from './config'
type Mode = 'LIVE' | 'NEXT_ACTION' | 'NEXT_RUN'
type Boundary = 'run'
type Control = { id: string; type: 'number'; category: string; label: string; description: string; unit: string;
  default: number; min: number; max: number; step: number; applyMode: Mode; integrity: 'COSMETIC' | 'GAMEPLAY' }
type Binding = { control: Control; boundary?: Boundary; read(): number; write(value: number): void }
const bindings: Binding[] = []
function number<S extends keyof typeof CONFIG>(section: S, key: keyof typeof CONFIG[S] & string,
  label: string, min: number, max: number, step: number, unit: string, boundary?: Boundary): void {
  const values = CONFIG[section] as Record<string, number>
  const defaults = DEFAULT_CONFIG[section] as Record<string, number>
  bindings.push({ control: Object.freeze({ id: `${section}.${key}`, type: 'number', category: section === 'car' ? 'Handling' : section === 'camera' ? 'Camera' : 'Race',
    label, description: boundary === 'run' ? 'Applies when the next race starts.' : 'Updates this preview immediately.',
    unit, default: defaults[key], min, max, step,
    applyMode: boundary === 'run' ? 'NEXT_RUN' : 'LIVE',
    integrity: section === 'camera' ? 'COSMETIC' : 'GAMEPLAY' }), boundary,
    read: () => values[key], write: value => { values[key] = value } })
}
number('car', 'maxSpeed', 'Top speed', 30, 80, 1, 'm/s')
number('car', 'accel', 'Acceleration', 10, 60, 1, 'm/s²')
number('car', 'turnHigh', 'High-speed steering', 0.4, 2, 0.05, 'rad/s')
number('car', 'grip', 'Grip', 3, 20, 0.5, '')
number('car', 'driftGrip', 'Drift grip', 1, 6, 0.1, '')
number('car', 'boostSpeed', 'Boost top speed', 40, 110, 1, 'm/s')
number('car', 'gravity', 'Gravity', 10, 60, 1, 'm/s²')
number('camera', 'fov', 'Field of view', 45, 100, 1, '°')
number('camera', 'distance', 'Camera distance', 4, 14, 0.1, 'm')
number('camera', 'height', 'Camera height', 1, 6, 0.1, 'm')
number('camera', 'follow', 'Camera follow speed', 2, 20, 1, '')
number('race', 'aiPace', 'AI cornering pace', 0.6, 1.4, 0.05, '×', 'run')
number('race', 'itemRespawn', 'Item crystal respawn', 1, 10, 0.5, 's', 'run')
const byId = new Map(bindings.map(binding => [binding.control.id, binding]))
let requested = Object.fromEntries(bindings.map(({ control }) => [control.id, control.default]))
const valid = (values: Record<string, number>) => values['car.maxSpeed'] < values['car.boostSpeed']
let unranked = false
const gameplayModified = () => bindings.some(binding => binding.control.integrity === 'GAMEPLAY' && binding.read() !== binding.control.default)
export const tuning = {
  get unranked(): boolean { return unranked },
  controls: Object.freeze(bindings.map(binding => binding.control)),
  read() {
    return { requested: { ...requested }, active: Object.fromEntries(bindings.map(binding => [binding.control.id, binding.read()])) }
  },
  apply(patch: unknown): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch')
    const entries = Object.entries(patch)
    if (entries.length > bindings.length) throw new Error('Invalid patch')
    for (const [id, value] of entries) {
      const control = byId.get(id)?.control
      if (!control || typeof value !== 'number' || !Number.isFinite(value) || value < control.min || value > control.max) throw new Error('Invalid value')
      const steps = (value - control.min) / control.step
      if (value !== control.default && Math.abs(steps - Math.round(steps)) > 1e-7) throw new Error('Invalid increment')
    }
    const candidate = { ...requested, ...patch } as Record<string, number>
    const nextActive = this.read().active
    for (const [id, value] of entries) if (byId.get(id)!.control.applyMode === 'LIVE') nextActive[id] = value
    if (!valid(candidate) || !valid(nextActive)) throw new Error('Top speed must stay below boost top speed')
    // All writes are simple assignments, synchronously committed before the next
    // simulation/render callback. No engine callbacks run during this transaction.
    requested = candidate
    for (const [id, value] of entries) {
      const binding = byId.get(id)!
      if (binding.control.applyMode === 'LIVE') binding.write(value)
    }
    unranked ||= gameplayModified()
  },
  activate(boundary: Boundary): void {
    for (const binding of bindings) if (binding.boundary === boundary) binding.write(requested[binding.control.id])
    // Reset only at a new race; resetting values mid-race cannot restore eligibility.
    unranked = boundary === 'run' ? gameplayModified() : unranked || gameplayModified()
  },
}
