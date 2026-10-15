/**
 * Screen-space UI particles (HUD + menus): sparks, glints, shock rings and flying chips drawn on
 * one pointer-transparent 2D canvas above the interface. Purely cosmetic; capped and pooled.
 */
interface P {
  x: number; y: number; vx: number; vy: number
  life: number; max: number; size: number
  color: string; kind: 0 | 1 | 2 | 3 // 0 spark streak, 1 glow dot, 2 ring, 3 star glint
  drag: number; grav: number
}

const MAX = 700

export interface BurstOpts { up?: number; spread?: number; size?: number; ring?: boolean; glints?: number }

export class UiFx {
  readonly canvas: HTMLCanvasElement
  private readonly g: CanvasRenderingContext2D
  private readonly ps: P[] = []
  private readonly free: P[] = []
  private dpr = 1
  private w = 0
  private h = 0
  enabled = true
  scale = 1

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'uifx'
    parent.appendChild(this.canvas)
    this.g = this.canvas.getContext('2d')!
    this.resize()
    window.addEventListener('resize', () => this.resize())
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.w = window.innerWidth
    this.h = window.innerHeight
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
  }

  private spawn(): P | null {
    if (this.ps.length >= MAX * this.scale) return null
    const p = this.free.pop() ?? ({} as P)
    this.ps.push(p)
    return p
  }

  /** Radial spark burst at a screen point. */
  burst(x: number, y: number, color: string, count = 18, speed = 380, opts: BurstOpts = {}): void {
    if (!this.enabled) return
    const n = Math.round(count * this.scale)
    const spread = opts.spread ?? Math.PI * 2
    const base = opts.up !== undefined ? -Math.PI / 2 : 0
    for (let i = 0; i < n; i += 1) {
      const p = this.spawn()
      if (!p) break
      const a = base + (opts.up !== undefined ? (Math.random() - 0.5) * spread : Math.random() * spread)
      const v = speed * (0.35 + Math.random() * 0.75)
      p.x = x; p.y = y
      p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v - (opts.up ?? 0)
      p.max = p.life = 0.35 + Math.random() * 0.45
      p.size = (opts.size ?? 2.4) * (0.6 + Math.random() * 0.8)
      p.color = color
      p.kind = Math.random() < 0.7 ? 0 : 1
      p.drag = 2.6
      p.grav = 520
    }
    if (opts.ring !== false) this.ring(x, y, color, 70 * (opts.size ?? 2.4) / 2.4)
    for (let i = 0; i < (opts.glints ?? 2); i += 1) this.glint(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 30, '#ffffff', 16 + Math.random() * 14)
  }

  ring(x: number, y: number, color: string, radius = 70, life = 0.45): void {
    if (!this.enabled) return
    const p = this.spawn()
    if (!p) return
    p.x = x; p.y = y; p.vx = 0; p.vy = 0
    p.max = p.life = life
    p.size = radius
    p.color = color
    p.kind = 2
    p.drag = 0; p.grav = 0
  }

  glint(x: number, y: number, color: string, size = 22): void {
    if (!this.enabled) return
    const p = this.spawn()
    if (!p) return
    p.x = x; p.y = y; p.vx = 0; p.vy = 0
    p.max = p.life = 0.35 + Math.random() * 0.2
    p.size = size
    p.color = color
    p.kind = 3
    p.drag = 0; p.grav = 0
  }

  /** Burst centred on an element (no-op if hidden). */
  at(el: Element | null, color: string, count = 18, speed = 380, opts: BurstOpts = {}): void {
    if (!el) return
    const r = el.getBoundingClientRect()
    if (!r.width) return
    this.burst(r.left + r.width / 2, r.top + r.height / 2, color, count, speed, opts)
  }

  /** Sparks streaming along an element's edge (e.g. a filling bar). */
  edge(el: Element | null, color: string, frac: number, count = 6): void {
    if (!el || !this.enabled) return
    const r = el.getBoundingClientRect()
    if (!r.width) return
    const x = r.left + r.width * Math.max(0, Math.min(1, frac))
    for (let i = 0; i < count; i += 1) {
      const p = this.spawn()
      if (!p) break
      p.x = x; p.y = r.top + Math.random() * r.height
      p.vx = -40 - Math.random() * 120; p.vy = -60 - Math.random() * 160
      p.max = p.life = 0.3 + Math.random() * 0.3
      p.size = 1.6 + Math.random() * 1.6
      p.color = color
      p.kind = 0
      p.drag = 3; p.grav = 380
    }
  }

  get count(): number {
    return this.ps.length
  }

  update(dt: number): void {
    const g = this.g
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, this.w, this.h)
    if (!this.ps.length) return
    g.globalCompositeOperation = 'lighter'
    for (let i = this.ps.length - 1; i >= 0; i -= 1) {
      const p = this.ps[i]
      p.life -= dt
      if (p.life <= 0) {
        this.ps[i] = this.ps[this.ps.length - 1]
        this.ps.pop()
        this.free.push(p)
        continue
      }
      const k = Math.exp(-p.drag * dt)
      p.vx *= k
      p.vy = p.vy * k + p.grav * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      const t = p.life / p.max
      g.globalAlpha = Math.min(1, t * 1.6)
      switch (p.kind) {
        case 0: {
          g.strokeStyle = p.color
          g.lineWidth = p.size
          g.lineCap = 'round'
          g.beginPath()
          g.moveTo(p.x, p.y)
          g.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035)
          g.stroke()
          break
        }
        case 1: {
          const r = p.size * 2.2
          const grad = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r)
          grad.addColorStop(0, '#ffffff')
          grad.addColorStop(0.35, p.color)
          grad.addColorStop(1, 'rgba(0,0,0,0)')
          g.fillStyle = grad
          g.fillRect(p.x - r, p.y - r, r * 2, r * 2)
          break
        }
        case 2: {
          const e = 1 - t
          g.strokeStyle = p.color
          g.lineWidth = 5 * t + 0.5
          g.beginPath()
          g.arc(p.x, p.y, p.size * (0.25 + e * 0.9), 0, Math.PI * 2)
          g.stroke()
          break
        }
        case 3: {
          const s = p.size * Math.sin(t * Math.PI)
          g.fillStyle = p.color
          g.beginPath()
          g.moveTo(p.x, p.y - s)
          g.quadraticCurveTo(p.x, p.y, p.x + s * 0.22, p.y)
          g.quadraticCurveTo(p.x, p.y, p.x, p.y + s)
          g.quadraticCurveTo(p.x, p.y, p.x - s * 0.22, p.y)
          g.quadraticCurveTo(p.x, p.y, p.x, p.y - s)
          g.moveTo(p.x - s, p.y)
          g.quadraticCurveTo(p.x, p.y, p.x, p.y + s * 0.22)
          g.quadraticCurveTo(p.x, p.y, p.x + s, p.y)
          g.quadraticCurveTo(p.x, p.y, p.x, p.y - s * 0.22)
          g.quadraticCurveTo(p.x, p.y, p.x - s, p.y)
          g.fill()
          break
        }
      }
    }
    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
  }

  clear(): void {
    while (this.ps.length) this.free.push(this.ps.pop()!)
  }
}
