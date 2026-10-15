import type { Input } from '../engine/input'

/**
 * On-screen racing controls for touch devices: a drag steering zone on the left, pedals and
 * action buttons on the right. They write into `input.touch`, which merges into the `auto` device.
 */
export class TouchControls {
  private readonly root: HTMLElement
  private steerId = -1
  private steerX = 0

  constructor(parent: HTMLElement, private readonly input: Input, private readonly active: () => boolean) {
    this.root = document.createElement('div')
    this.root.className = 'touch'
    this.root.innerHTML = `
      <div class="t-steer" data-steer><div class="t-knob" data-knob></div><span>STEER</span></div>
      <div class="t-buttons">
        <button type="button" class="t-btn t-item" data-k="item">ITEM</button>
        <button type="button" class="t-btn t-recover" data-k="recover">RESET</button>
        <button type="button" class="t-btn t-boost" data-k="boost">BOOST</button>
        <button type="button" class="t-btn t-drift" data-k="drift">DRIFT</button>
        <button type="button" class="t-btn t-brake" data-k="brake">BRAKE</button>
        <button type="button" class="t-btn t-gas" data-k="throttle">GAS</button>
      </div>
      <button type="button" class="t-pause" data-pause aria-label="Pause">II</button>`
    parent.appendChild(this.root)
    const steer = this.root.querySelector<HTMLElement>('[data-steer]')!
    const knob = this.root.querySelector<HTMLElement>('[data-knob]')!
    const setSteer = (clientX: number) => {
      const r = steer.getBoundingClientRect()
      const v = Math.max(-1, Math.min(1, (clientX - (r.left + r.width / 2)) / (r.width * 0.38)))
      this.input.touch.steer = v
      knob.style.transform = `translateX(${v * r.width * 0.34}px)`
    }
    steer.addEventListener('pointerdown', e => {
      this.steerId = e.pointerId
      this.steerX = e.clientX
      steer.setPointerCapture(e.pointerId)
      setSteer(e.clientX)
    })
    steer.addEventListener('pointermove', e => {
      if (e.pointerId === this.steerId) setSteer(e.clientX)
    })
    const release = (e: PointerEvent) => {
      if (e.pointerId !== this.steerId) return
      this.steerId = -1
      this.input.touch.steer = 0
      knob.style.transform = ''
    }
    steer.addEventListener('pointerup', release)
    steer.addEventListener('pointercancel', release)
    void this.steerX
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-k]')) {
      const k = btn.dataset.k as keyof Input['touch']
      const set = (on: boolean) => {
        ;(this.input.touch as Record<string, boolean | number>)[k] = on
        btn.classList.toggle('on', on)
      }
      btn.addEventListener('pointerdown', e => {
        e.preventDefault()
        btn.setPointerCapture(e.pointerId)
        set(true)
      })
      btn.addEventListener('pointerup', () => set(false))
      btn.addEventListener('pointercancel', () => set(false))
      btn.addEventListener('lostpointercapture', () => set(false))
    }
    this.root.querySelector('[data-pause]')!.addEventListener('click', () => window.dispatchEvent(new Event('game:pause')))
    const tick = () => {
      const show = this.active() && (this.input.method === 'touch' || matchMedia('(pointer: coarse)').matches)
      this.root.classList.toggle('show', show)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
}
