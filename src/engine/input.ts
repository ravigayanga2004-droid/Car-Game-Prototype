import type { CarInput } from '../sim/car'
import type { Device } from './save'

/**
 * Keyboard (two halves for local split-screen), gamepads and touch, mapped to CarInput per
 * device. Menu actions (confirm/back/pause) are edge-latched until consumed.
 */
export type Method = 'keyboard' | 'gamepad' | 'touch'
export type MenuAction = 'confirm' | 'back' | 'pause'

type KeyMap = { up: string[]; down: string[]; left: string[]; right: string[]; drift: string[]; boost: string[]; item: string[]; recover: string[] }

export const KEYS_LEFT: KeyMap = {
  up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  drift: ['Space'], boost: ['ShiftLeft'], item: ['KeyE'], recover: ['KeyR'],
}
export const KEYS_RIGHT: KeyMap = {
  up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
  drift: ['ShiftRight', 'Slash', 'Numpad0'], boost: ['Period', 'Numpad1'], item: ['Comma', 'Numpad2', 'NumpadEnter'], recover: ['KeyL', 'Numpad3'],
}

const GAME_KEYS = new Set([...Object.values(KEYS_LEFT), ...Object.values(KEYS_RIGHT)].flat())

export type TouchState = { steer: number; throttle: boolean; brake: boolean; drift: boolean; boost: boolean; item: boolean; recover: boolean }

const DEAD = 0.14

export class Input {
  method: Method = 'keyboard'
  /** While racing, game keys never scroll or activate focused buttons. */
  gameplayActive = false
  readonly touch: TouchState = { steer: 0, throttle: false, brake: false, drift: false, boost: false, item: false, recover: false }
  /** Gamepad menu stick (x right, y up). */
  readonly move = { x: 0, y: 0 }
  private readonly keys = new Set<string>()
  private readonly latched = new Set<MenuAction>()
  private pads: Gamepad[] = []
  private prevButtons = new Map<number, boolean[]>()

  constructor() {
    window.addEventListener('keydown', e => {
      if (this.gameplayActive && GAME_KEYS.has(e.code)) e.preventDefault()
      if (e.repeat) return
      this.keys.add(e.code)
      this.method = 'keyboard'
      if (e.code === 'Escape' || e.code === 'KeyP') this.latched.add('pause')
    })
    window.addEventListener('keyup', e => this.keys.delete(e.code))
    window.addEventListener('blur', () => this.keys.clear())
    window.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') this.method = 'touch'
    })
  }

  /** Poll gamepads once per frame. */
  update(): void {
    const list = navigator.getGamepads ? navigator.getGamepads() : []
    this.pads = []
    for (const p of list) if (p && p.connected) this.pads.push(p)
    this.move.x = 0
    this.move.y = 0
    for (const pad of this.pads) {
      const prev = this.prevButtons.get(pad.index) ?? []
      const now = pad.buttons.map(b => b.pressed)
      const edge = (i: number) => now[i] && !prev[i]
      if (edge(0)) this.latched.add('confirm')
      if (edge(1)) this.latched.add('back')
      if (edge(9)) this.latched.add('pause')
      const ax = pad.axes[0] ?? 0
      const ay = pad.axes[1] ?? 0
      const dx = (now[15] ? 1 : 0) - (now[14] ? 1 : 0)
      const dy = (now[12] ? 1 : 0) - (now[13] ? 1 : 0)
      if (Math.abs(ax) > Math.abs(this.move.x)) this.move.x = ax
      if (Math.abs(ay) > Math.abs(this.move.y)) this.move.y = -ay
      if (dx) this.move.x = dx
      if (dy) this.move.y = dy
      if (now.some(Boolean) || Math.abs(ax) > 0.5 || Math.abs(ay) > 0.5) this.method = 'gamepad'
      this.prevButtons.set(pad.index, now)
    }
  }

  consume(action: MenuAction): boolean {
    const had = this.latched.has(action)
    this.latched.delete(action)
    return had
  }

  get gamepadCount(): number {
    return this.pads.length
  }

  held(code: string): boolean {
    return this.keys.has(code)
  }

  private any(codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true
    return false
  }

  private readKeys(map: KeyMap, out: CarInput): void {
    if (this.any(map.up)) out.throttle = 1
    if (this.any(map.down)) out.brake = 1
    const steer = (this.any(map.right) ? 1 : 0) - (this.any(map.left) ? 1 : 0)
    if (steer) out.steer = steer
    out.drift ||= this.any(map.drift)
    out.boost ||= this.any(map.boost)
    out.item ||= this.any(map.item)
    out.recover ||= this.any(map.recover)
  }

  private readPad(pad: Gamepad | undefined, out: CarInput): void {
    if (!pad) return
    const b = (i: number) => pad.buttons[i]?.pressed ?? false
    const v = (i: number) => pad.buttons[i]?.value ?? 0
    let ax = pad.axes[0] ?? 0
    ax = Math.abs(ax) < DEAD ? 0 : (ax - Math.sign(ax) * DEAD) / (1 - DEAD)
    const dpad = (b(15) ? 1 : 0) - (b(14) ? 1 : 0)
    const steer = dpad || ax
    if (Math.abs(steer) > Math.abs(out.steer)) out.steer = steer
    out.throttle = Math.max(out.throttle, v(7), b(0) ? 1 : 0)
    out.brake = Math.max(out.brake, v(6), b(2) ? 1 : 0)
    out.drift ||= b(5) || b(4)
    out.boost ||= b(1)
    out.item ||= b(3)
    out.recover ||= b(8) || b(11)
  }

  private readTouch(out: CarInput): void {
    const t = this.touch
    if (Math.abs(t.steer) > Math.abs(out.steer)) out.steer = t.steer
    if (t.throttle) out.throttle = 1
    if (t.brake) out.brake = 1
    out.drift ||= t.drift
    out.boost ||= t.boost
    out.item ||= t.item
    out.recover ||= t.recover
  }

  /** Fill `out` with the current input for one device (`auto` merges everything). */
  carInput(device: Device, out: CarInput): CarInput {
    out.throttle = 0
    out.brake = 0
    out.steer = 0
    out.drift = out.boost = out.item = out.recover = false
    if (device === 'auto') {
      this.readKeys(KEYS_LEFT, out)
      this.readKeys(KEYS_RIGHT, out)
      for (const pad of this.pads) this.readPad(pad, out)
      this.readTouch(out)
    } else if (device === 'kbLeft') this.readKeys(KEYS_LEFT, out)
    else if (device === 'kbRight') this.readKeys(KEYS_RIGHT, out)
    else if (device === 'pad0') this.readPad(this.pads[0], out)
    else this.readPad(this.pads[1], out)
    out.steer = Math.max(-1, Math.min(1, out.steer))
    return out
  }
}
