import type { JuiceKind, Session } from '../game/session'
import { DAMAGE_FIRE, DAMAGE_SMOKE, DRIFT_TIERS, HOLD_TIME } from '../sim/car'
import { formatTime, GATES_PER_LAP, LAPS, ordinal } from './format'
import { clamp } from '../sim/math'
import { CONFIG } from '../game/config'
import type { Track } from '../sim/track'
import { LIVERIES } from '../view/cars'
import type { UiFx } from './uifx'

/**
 * Race HUD (concept "Golden Hour" kit): gold position badge, lap + 16 gate pips, slanted timer
 * with live gate splits, gold-ring minimap, dial speedometer with boost arc / segments / drift
 * pips, item card, style-chain panel, banners and a screen-space particle layer for feedback.
 * DOM writes only happen when values change; canvases redraw once per frame.
 */
const BASE = import.meta.env.BASE_URL
const NITRO_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="nz" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#bff8ff"/><stop offset="1" stop-color="#2d8cff"/></linearGradient></defs><rect x="20" y="10" width="24" height="44" rx="9" fill="url(#nz)" stroke="#e8fdff" stroke-width="3"/><rect x="26" y="4" width="12" height="8" rx="2" fill="#e8fdff"/><path d="M32 20 L25 36 H31 L28 48 L40 30 H33 L37 20 Z" fill="#fff6c2" stroke="#1b1030" stroke-width="1.5"/></svg>`
const ITEM_INFO: Record<string, { name: string; icon: string; hint: string; color: string }> = {
  seeker: { name: 'SEEKER', icon: `<img src="${BASE}assets/ui/icon-seeker.webp" alt="">`, hint: 'Homes on the racer ahead — they get a lane warning.', color: '#ffb020' },
  mine: { name: 'DUST MINE', icon: `<img src="${BASE}assets/ui/icon-mine.webp" alt="">`, hint: 'Drops behind you. Armed mines blink red.', color: '#ff4d5e' },
  shield: { name: 'SHIELD', icon: `<img src="${BASE}assets/ui/icon-shield.webp" alt="">`, hint: 'Blocks one hit for 6 seconds.', color: '#4fd8ff' },
  canister: { name: 'NITRO', icon: NITRO_SVG, hint: 'Instant boost burst.', color: '#7ef9ff' },
}
const TIER_CSS = ['#ffe08a', '#4fb8ff', '#ff9a2a', '#c86bff']
const DIAL_MAX = 300

class Cache {
  private readonly values = new Map<string, string>()
  text(el: HTMLElement | null, key: string, v: string): void {
    if (!el || this.values.get(key) === v) return
    this.values.set(key, v)
    el.textContent = v
  }
  html(el: HTMLElement | null, key: string, v: string): void {
    if (!el || this.values.get(key) === v) return
    this.values.set(key, v)
    el.innerHTML = v
  }
  cls(el: HTMLElement | null, key: string, name: string, on: boolean): void {
    const k = `${key}:${name}`
    const v = on ? '1' : '0'
    if (!el || this.values.get(k) === v) return
    this.values.set(k, v)
    el.classList.toggle(name, on)
  }
  style(el: HTMLElement | null, key: string, prop: string, v: string): void {
    const k = `${key}:${prop}`
    if (!el || this.values.get(k) === v) return
    this.values.set(k, v)
    el.style.setProperty(prop, v)
  }
  reset(): void {
    this.values.clear()
  }
}

function viewTemplate(view: number): string {
  const pips = Array.from({ length: GATES_PER_LAP }, (_, k) => `<i data-pip="${k}"></i>`).join('')
  return `
  <div class="hud-view" data-view="${view}">
    <div class="hud-flash" data-h="flash"></div>
    <div class="speedlines" data-h="lines"></div>
    <div class="hud-tl">
      <div class="hud-place" data-h="placebox"><b data-h="place">1<sup>st</sup></b><span data-h="of">/3</span></div>
      <div class="hud-chip hud-lap" data-h="lapbox">LAP <b data-h="lap">1</b><span>/${LAPS}</span></div>
      <div class="hud-chip hud-gate">GATE <b data-h="gate">1</b><span>/${GATES_PER_LAP}</span></div>
      <div class="pips" data-h="pips">${pips}</div>
    </div>
    <div class="hud-top">
      <div class="hud-time" data-h="time">0:00.00</div>
      <div class="hud-split" data-h="split"></div>
      <div class="hud-sub"><span data-h="best">BEST LAP —</span><span class="pen" data-h="pen"></span></div>
      <div class="hud-limit" data-h="limit"></div>
    </div>
    <div class="hud-bl">
      <div class="warn seeker" data-h="wseek">SEEKER INCOMING</div>
      <div class="warn locked" data-h="wlock">LOCKED — CHANGE LANES OR SHIELD!</div>
      <div class="warn mine" data-h="wmine">MINE AHEAD</div>
      <div class="item-card" data-h="itemslot">
        <div class="item-icon" data-h="itemicon"></div>
        <div class="item-text"><b data-h="itemname">NO ITEM</b><small data-h="itemhint">Drive through a pink crystal</small></div>
        <kbd data-h="itemkey">E</kbd>
      </div>
    </div>
    <div class="hud-br">
      <div class="draft" data-h="draft">SLIPSTREAM</div>
      <div class="assist-chip" data-h="assist"><i></i>ASSIST <span data-h="assistmode">STRONG</span></div>
      <div class="hull" data-h="hull"><span data-h="hulllabel">HULL</span><div class="hull-bar"><i data-h="hullfill"></i></div><b data-h="hullpct">100%</b></div>
      <div class="wallride" data-h="wall"><span data-h="walllabel">WALL RIDE</span><div class="wall-bar"><i data-h="wallfill"></i><em></em></div><b data-h="wallg">1.0 G</b></div>
      <div class="dial" data-h="dial">
        <canvas data-h="dialc" width="260" height="260"></canvas>
        <div class="dial-read"><b data-h="speed">0</b><span>KM/H</span></div>
        <div class="dial-boost" data-h="segs"><span class="power-read">POWER <b data-h="power">0 / 3</b> <kbd data-h="boostkey">SHIFT</kbd></span><div class="power-pips" data-h="powerpips"><i></i><i></i><i></i></div><span class="nitro-read">NITRO <em class="nitro-st" data-h="nitrost">READY</em></span><div class="segs"><i></i><i></i><i></i><i></i></div></div>
        <div class="dial-drift" data-h="dpips"><i></i><i></i><i></i><span data-h="driftlabel">DRIFT</span></div>
      </div>
    </div>
    <div class="style-chain" data-h="style">
      <div class="sc-main"><b data-h="sclabel">DRIFT</b><strong data-h="scpts">+0</strong></div>
      <div class="sc-mult"><b data-h="scmult">×1</b><span>CHAIN</span></div>
      <div class="sc-timer"><i data-h="sctimer"></i></div>
    </div>
    <div class="hud-center">
      <div class="countdown" data-h="count"></div>
      <div class="banner-final" data-h="final"><i></i>FINAL LAP<i></i></div>
      <div class="banner wrong" data-h="wrong">WRONG WAY</div>
      <div class="hold" data-h="hold"><small data-h="holdlabel">RESPAWNING</small><b data-h="holdn">3</b><div class="hold-bar"><i data-h="holdp"></i></div><em data-h="holdhint">Hold tight — engine restarting</em></div>
      <div class="banner done" data-h="done"></div>
      <div class="popups" data-h="popups"></div>
    </div>
    <div class="hud-tag" data-h="tag"></div>
  </div>`
}

interface SplitState {
  gates: number
  lapStart: number
  cur: number[]
  best: number[] | null
  bestLap: number
  splitUntil: number
}

export class Hud {
  readonly root: HTMLElement
  private readonly cache = new Cache()
  private readonly views: HTMLElement[] = []
  private readonly minimap: HTMLCanvasElement
  private mapTrack: Track | null = null
  private mapPath: Path2D | null = null
  private mapXf = { s: 1, ox: 0, oz: 0 }
  private hintTimer = 0
  private readonly splits: SplitState[] = []
  private readonly lastMeterSeg = [0, 0]
  private readonly dialNeedle = [0, 0]
  private clock = 0
  private reduced = false

  constructor(parent: HTMLElement, private readonly fx: UiFx) {
    this.root = document.createElement('div')
    this.root.className = 'hud'
    this.root.innerHTML = `${viewTemplate(0)}${viewTemplate(1)}<div class="minimap-wrap"><canvas class="minimap" width="440" height="440"></canvas><b class="mm-n">N</b></div><div class="hud-hint" data-hint></div><div class="online-strip" data-online></div>`
    parent.appendChild(this.root)
    this.views = [...this.root.querySelectorAll<HTMLElement>('.hud-view')]
    this.minimap = this.root.querySelector('canvas.minimap')!
  }

  private q(view: number, key: string): HTMLElement | null {
    return this.views[view]?.querySelector(`[data-h="${key}"]`) ?? null
  }

  private retrigger(el: Element | null | undefined, cls: string): void {
    if (!el) return
    el.classList.remove(cls)
    void (el as HTMLElement).offsetWidth
    el.classList.add(cls)
  }

  setup(session: Session, names: string[], keys: { item: string; boost: string }[], showHint: boolean): void {
    const split = session.humans.length > 1
    this.cache.reset()
    this.fx.clear()
    this.root.classList.toggle('split', split)
    this.views[1].style.display = split ? '' : 'none'
    for (let v = 0; v < 2; v += 1) {
      const pops = this.q(v, 'popups')
      if (pops) pops.innerHTML = ''
      this.cache.text(this.q(v, 'tag'), `tag${v}`, split ? names[v] ?? '' : '')
      this.cache.text(this.q(v, 'itemkey'), `ik${v}`, keys[v]?.item ?? 'E')
      this.cache.text(this.q(v, 'boostkey'), `bk${v}`, keys[v]?.boost ?? 'SHIFT')
      this.q(v, 'final')?.classList.remove('show')
      this.q(v, 'style')?.classList.remove('show', 'bank')
      this.q(v, 'split')?.classList.remove('show')
      this.splits[v] = { gates: 0, lapStart: 0, cur: [], best: null, bestLap: Infinity, splitUntil: 0 }
      this.lastMeterSeg[v] = 0
      this.dialNeedle[v] = 0
    }
    this.buildMap(session.track)
    const hint = this.root.querySelector<HTMLElement>('[data-hint]')!
    clearTimeout(this.hintTimer)
    if (showHint) {
      hint.innerHTML = split
        ? '<b>P1</b> WASD · Space drift · L-Shift boost · E item · R reset &nbsp; | &nbsp; <b>P2</b> Arrows · R-Shift or / drift · . boost · , item · L reset'
        : '<b>W / ↑</b> throttle · <b>S / ↓</b> brake · <b>Space</b> drift & air tricks · <b>Shift</b> boost (Power first, Nitro fallback) · <b>E</b> item · <b>R</b> reset (3 s hold) · <b>Esc</b> pause'
      hint.classList.add('show')
      this.hintTimer = window.setTimeout(() => hint.classList.remove('show'), 9000)
    } else hint.classList.remove('show')
  }

  private buildMap(track: Track): void {
    if (this.mapTrack === track) return
    this.mapTrack = track
    const b = track.bounds
    const size = 440
    const pad = 70
    const s = (size - pad * 2) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ)
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    this.mapXf = { s, ox: size / 2 - cx * s, oz: size / 2 - cz * s }
    const path = new Path2D()
    for (let i = 0; i <= track.n; i += 4) {
      const k = i % track.n
      const [x, y] = this.mapPoint(track.x[k], track.z[k])
      if (i === 0) path.moveTo(x, y)
      else path.lineTo(x, y)
    }
    path.closePath()
    this.mapPath = path
  }

  private mapPoint(x: number, z: number): [number, number] {
    return [-x * this.mapXf.s + 440 - this.mapXf.ox, z * this.mapXf.s + this.mapXf.oz]
  }

  popup(view: number, text: string, kind: string): void {
    const box = this.q(view, 'popups')
    if (!box) return
    const el = document.createElement('div')
    el.className = `popup ${kind}`
    const span = document.createElement('span')
    span.textContent = text
    el.appendChild(span)
    box.prepend(el)
    while (box.children.length > 3) box.lastElementChild?.remove()
    window.setTimeout(() => el.remove(), 1600)
    const color = kind === 'great' ? '#7ef9ff' : kind === 'good' ? '#ffb020' : kind === 'bad' || kind === 'warn' ? '#ff4d5e' : '#ffd23f'
    requestAnimationFrame(() => this.fx.at(el, color, kind === 'great' ? 26 : 14, 420, { size: 2.2, glints: kind === 'great' ? 3 : 1 }))
  }

  /** Event pulses from the session (presentation only). */
  juice(view: number, kind: JuiceKind, value?: number): void {
    const flash = this.q(view, 'flash')
    const fx = this.fx
    switch (kind) {
      case 'gate': {
        const n = (this.splits[view]?.gates ?? 0) % GATES_PER_LAP
        const pip = this.q(view, 'pips')?.children[Math.max(0, n)] ?? null
        fx.at(pip, '#7ef9ff', 12, 260, { size: 1.8, glints: 1 })
        this.retrigger(this.q(view, 'pips'), 'bump')
        break
      }
      case 'lap':
        this.retrigger(this.q(view, 'lapbox'), 'bump')
        fx.at(this.q(view, 'lapbox'), '#ffd23f', 30, 480, { size: 2.6, glints: 3 })
        this.retrigger(flash, 'gold')
        break
      case 'final': {
        const b = this.q(view, 'final')
        this.retrigger(b, 'show')
        window.setTimeout(() => b?.classList.remove('show'), 2600)
        requestAnimationFrame(() => fx.at(b, '#ffb020', 60, 640, { size: 3, glints: 5 }))
        this.retrigger(this.q(view, 'lapbox'), 'bump')
        this.retrigger(flash, 'gold')
        break
      }
      case 'boost':
      case 'pad':
        this.retrigger(this.q(view, 'dial'), 'kick')
        fx.at(this.q(view, 'segs'), kind === 'pad' ? '#7ef9ff' : TIER_CSS[value ?? 1] ?? '#7ef9ff', 18 + (value ?? 1) * 6, 380, { size: 2.2 })
        this.retrigger(flash, 'boost')
        break
      case 'nitro': {
        const segs = this.q(view, 'segs')
        this.retrigger(this.q(view, 'dial'), 'kick')
        this.retrigger(segs, 'fire')
        fx.at(segs, '#8fb4ff', 36, 520, { size: 2.6, glints: 3 })
        this.retrigger(flash, 'nitro')
        if (!this.reduced) this.retrigger(this.views[view], 'shake-s')
        break
      }
      case 'nitroReady': {
        const segs = this.q(view, 'segs')
        this.retrigger(segs, 'ready-pop')
        fx.at(segs, '#bfe0ff', 22, 380, { size: 2, glints: 3 })
        break
      }
      case 'nitroDenied':
        this.retrigger(this.q(view, 'segs'), 'deny')
        break
      case 'power': {
        const pips = this.q(view, 'powerpips')
        this.retrigger(pips, 'ready-pop')
        fx.at(pips, '#7ef9ff', 28, 440, { size: 2.4, glints: 3 })
        this.retrigger(flash, 'boost')
        break
      }
      case 'powerBoost': {
        const segs = this.q(view, 'segs')
        this.retrigger(this.q(view, 'dial'), 'kick')
        this.retrigger(segs, 'power-fire')
        fx.at(segs, '#ffd23f', 42, 560, { size: 2.8, glints: 4 })
        this.retrigger(flash, 'power')
        if (!this.reduced) this.retrigger(this.views[view], 'shake-s')
        break
      }
      case 'cork':
        this.retrigger(flash, value === 2 ? 'gold' : 'boost')
        if (value === 2) {
          const split = this.root.classList.contains('split')
          fx.burst(window.innerWidth / 2, window.innerHeight * (split ? (view ? 0.72 : 0.22) : 0.3), '#ffd23f', 46, 620, { size: 2.6, glints: 4 })
        }
        break
      case 'tier': {
        const pip = this.q(view, 'dpips')?.children[Math.max(0, (value ?? 1) - 1)] ?? null
        this.retrigger(pip, 'pop')
        fx.at(pip, TIER_CSS[value ?? 1], 16, 300, { size: 2 })
        break
      }
      case 'hit':
        this.retrigger(flash, 'hit')
        this.retrigger(this.views[view], 'shake')
        break
      case 'wall':
        if ((value ?? 0) > 10) this.retrigger(this.views[view], 'shake-s')
        break
      case 'block':
        this.retrigger(flash, 'boost')
        fx.at(this.q(view, 'itemslot'), '#7ef9ff', 28, 420)
        break
      case 'place': {
        const box = this.q(view, 'placebox')
        this.retrigger(box, 'bump')
        fx.at(box, '#ffd23f', 26, 460, { size: 2.6, glints: 2 })
        break
      }
      case 'bank': {
        const sc = this.q(view, 'style')
        this.retrigger(sc, 'bank')
        window.setTimeout(() => sc?.classList.remove('bank'), 900)
        fx.at(sc, '#ffd23f', 40, 560, { size: 2.8, glints: 4 })
        break
      }
      case 'finish': {
        this.retrigger(flash, 'gold')
        const split = this.root.classList.contains('split')
        fx.burst(window.innerWidth / 2, window.innerHeight * (split ? (view ? 0.7 : 0.25) : 0.35), '#ffd23f', 90, 820, { size: 3.2, glints: 8 })
        break
      }
      case 'land':
        if ((value ?? 0) > 0.5) this.retrigger(this.views[view], 'shake-s')
        break
      case 'item': {
        const card = this.q(view, 'itemslot')
        this.retrigger(card, 'flip')
        fx.at(card, '#ff7ad9', 26, 420, { size: 2.4, glints: 2 })
        break
      }
      case 'go': {
        const c = this.q(view, 'count')
        requestAnimationFrame(() => fx.at(c, '#7ef9ff', 70, 760, { size: 3.2, glints: 6 }))
        break
      }
      case 'count':
        this.retrigger(this.q(view, 'count'), 'pop')
        requestAnimationFrame(() => fx.at(this.q(view, 'count'), '#ffd23f', 24, 420, { size: 2.4 }))
        break
      case 'warn':
        this.retrigger(flash, 'warn')
        break
      case 'damage': {
        const hull = this.q(view, 'hull')
        this.retrigger(flash, 'hit')
        this.retrigger(this.views[view], (value ?? 0) > 0.35 ? 'shake' : 'shake-s')
        this.retrigger(hull, 'bump')
        fx.at(hull, (value ?? 0) >= 0.7 ? '#ff3b2a' : '#ffb020', 22, 380, { size: 2.2 })
        break
      }
      case 'wreck': {
        this.retrigger(flash, 'hit')
        this.retrigger(this.views[view], 'shake')
        const split = this.root.classList.contains('split')
        fx.burst(window.innerWidth / 2, window.innerHeight * (split ? (view ? 0.75 : 0.25) : 0.45), '#ff7a2a', 110, 900, { size: 3.4, glints: 6 })
        break
      }
      case 'hold': {
        const n = this.q(view, 'holdn')
        this.retrigger(n, 'pop')
        requestAnimationFrame(() => fx.at(n, '#7ef9ff', 20, 380, { size: 2.2 }))
        break
      }
    }
  }

  update(session: Session, reducedMotion: boolean): void {
    this.reduced = reducedMotion
    this.fx.enabled = !reducedMotion
    this.clock += 1 / 60
    for (let v = 0; v < session.humans.length; v += 1) this.updateView(session, v)
    this.drawMap(session)
  }

  private trackSplits(v: number, clock: number, gates: number, lapTimes: number[]): void {
    const st = this.splits[v]
    if (!st) return
    while (st.gates < gates) {
      st.gates += 1
      const gi = (st.gates - 1) % GATES_PER_LAP
      const t = clock - st.lapStart
      st.cur[gi] = t
      if (st.best && st.best[gi] !== undefined) {
        const d = t - st.best[gi]
        const el = this.q(v, 'split')
        if (el) {
          el.textContent = `${d <= 0 ? '−' : '+'}${Math.abs(d).toFixed(2)}`
          el.className = `hud-split ${d <= 0 ? 'ahead' : 'behind'}`
          this.retrigger(el, 'show')
        }
        st.splitUntil = clock + 2.6
      }
      if (gi === GATES_PER_LAP - 1) {
        const lap = lapTimes[lapTimes.length - 1] ?? t
        if (lap < st.bestLap) {
          st.bestLap = lap
          st.best = [...st.cur]
        }
        st.cur = []
        st.lapStart = clock
      }
    }
    if (clock > st.splitUntil) this.q(v, 'split')?.classList.remove('show')
  }

  private updateView(session: Session, v: number): void {
    const h = session.hud(v)
    const car = h.car
    const c = this.cache
    const key = (k: string) => `${v}:${k}`
    const ord = ordinal(h.place)
    c.html(this.q(v, 'place'), key('place'), `${h.place}<sup>${ord.replace(/^\d+/, '')}</sup>`)
    c.text(this.q(v, 'of'), key('of'), `/${h.total}`)
    c.text(this.q(v, 'lap'), key('lap'), String(h.lap))
    c.text(this.q(v, 'gate'), key('gate'), car.progress.finished ? '—' : String(h.gate))
    const lapGates = car.progress.finished ? GATES_PER_LAP : car.progress.gates % GATES_PER_LAP
    const pipsEl = this.q(v, 'pips')
    if (pipsEl && pipsEl.dataset.n !== String(lapGates)) {
      pipsEl.dataset.n = String(lapGates)
      pipsEl.querySelectorAll('i').forEach((p, k) => {
        p.classList.toggle('done', k < lapGates)
        p.classList.toggle('next', k === lapGates && !car.progress.finished)
      })
    }
    this.trackSplits(v, h.clock, car.progress.gates, car.progress.lapTimes)
    c.text(this.q(v, 'time'), key('time'), formatTime(h.clock))
    c.text(this.q(v, 'best'), key('best'), h.bestLap > 0 ? `BEST LAP ${formatTime(h.bestLap)}` : 'BEST LAP —')
    c.text(this.q(v, 'pen'), key('pen'), car.progress.penalty > 0 ? `+${car.progress.penalty.toFixed(1)}s` : '')
    const left = 300 - h.clock
    c.text(this.q(v, 'limit'), key('limit'), left < 30 && !car.progress.finished && h.countdown <= 0 ? `TIME LIMIT ${Math.max(0, left).toFixed(0)}s` : '')
    // Speed dial + meters.
    const kmh = Math.round(Math.abs(car.vF) * 3.6)
    const boosting = car.boostTime > 0 || car.meterBoosting || car.powerBoosting
    c.text(this.q(v, 'speed'), key('speed'), String(kmh))
    c.text(this.q(v, 'power'), key('power'), `${car.power} / 3`)
    this.drawDial(v, kmh, car.meter, boosting)
    const segs = Math.floor(car.meter * 4 + 1e-6)
    const segEl = this.q(v, 'segs')
    if (segEl) {
      segEl.querySelectorAll<HTMLElement>('.segs i').forEach((s, k) => {
        const f = Math.max(0, Math.min(1, car.meter * 4 - k)).toFixed(2)
        c.style(s, key(`seg${k}`), '--f', f)
        c.cls(s, key(`segon${k}`), 'on', k < segs)
      })
      c.cls(segEl, key('segactive'), 'active', car.meterBoosting)
      c.cls(segEl, key('segready'), 'ready', car.meter >= 1 && !car.meterBoosting)
      c.cls(segEl, key('poweractive'), 'power-active', car.powerBoosting)
      c.cls(segEl, key('powerready'), 'power-ready', car.power > 0 && !car.powerBoosting)
      const st = car.meterBoosting ? 'FIRING' : car.meter >= 1 ? 'READY' : `${Math.ceil((1 - car.meter) * CONFIG.car.nitroCooldown)}s`
      c.text(this.q(v, 'nitrost'), key('nitrost'), st)
      if (segs > this.lastMeterSeg[v]) this.fx.at(segEl.querySelectorAll('.segs i')[segs - 1] ?? null, '#7ef9ff', 10, 220, { size: 1.6, ring: false, glints: 1 })
      if (car.meterBoosting && Math.random() < 0.5) this.fx.edge(segEl.querySelector('.segs'), '#9ff6ff', car.meter, 2)
    }
    const powerPips = this.q(v, 'powerpips')
    powerPips?.querySelectorAll<HTMLElement>('i').forEach((pip, k) => c.cls(pip, key(`powerpip${k}`), 'on', k < car.power))
    this.lastMeterSeg[v] = segs
    const tier = car.drift ? car.driftTier : 0
    const dp = this.q(v, 'dpips')
    if (dp) {
      dp.querySelectorAll<HTMLElement>('i').forEach((p, k) => {
        c.cls(p, key(`dp${k}`), 'lit', k < tier)
        c.style(p, key(`dpc${k}`), '--c', TIER_CSS[k + 1])
      })
      const charge = car.drift ? Math.min(1, car.driftCharge / DRIFT_TIERS[2]) : 0
      c.style(dp, key('dch'), '--p', charge.toFixed(2))
      c.cls(dp, key('drifting'), 'drifting', car.drift)
    }
    c.text(this.q(v, 'driftlabel'), key('dl'), car.drift ? ['DRIFT', 'MINI-TURBO', 'SUPER', 'ULTRA'][tier] : 'DRIFT')
    c.cls(this.q(v, 'draft'), key('draft'), 'show', car.drafting || car.draftCharge > 0.05)
    const assistEl = this.q(v, 'assist')
    const aMode = session.assistModes[v] ?? 'off'
    c.cls(assistEl, key('assistOn'), 'on', aMode !== 'off')
    c.text(this.q(v, 'assistmode'), key('assistMode'), aMode === 'light' ? 'LIGHT' : 'STRONG')
    c.cls(assistEl, key('assistAct'), 'act', aMode !== 'off' && (session.assistLevel[session.humans[v]] ?? 0) > 0.18)
    c.style(this.q(v, 'draft'), key('draftp'), '--p', car.draftCharge.toFixed(2))
    // Item card.
    const info = car.item ? ITEM_INFO[car.item] : null
    const slot = this.q(v, 'itemslot')
    c.cls(slot, key('has'), 'has', !!info)
    c.style(slot, key('ic'), '--ic', info?.color ?? '#b58cff')
    c.html(this.q(v, 'itemicon'), key('icon'), info ? info.icon : '<span class="empty">?</span>')
    c.text(this.q(v, 'itemname'), key('iname'), info ? info.name : session.sim.items ? 'NO ITEM' : 'ITEMS OFF')
    c.text(this.q(v, 'itemhint'), key('ihint'), info ? info.hint : session.sim.items ? 'Drive through a pink crystal' : 'Pure racing — no items this run')
    c.cls(slot, key('shield'), 'shielded', car.shield > 0)
    c.cls(slot, key('off'), 'off', !session.sim.items)
    // Warnings.
    c.cls(this.q(v, 'wseek'), key('ws'), 'show', car.warnSeeker >= 0 && !car.warnLocked)
    c.text(this.q(v, 'wseek'), key('wst'), car.warnSeeker >= 0 ? `SEEKER INCOMING ${Math.round(car.warnSeeker)} m` : '')
    c.cls(this.q(v, 'wlock'), key('wl'), 'show', car.warnLocked)
    c.cls(this.q(v, 'wmine'), key('wm'), 'show', car.warnMine >= 0)
    c.cls(this.q(v, 'flash'), key('lockedge'), 'locked', car.warnLocked)
    // Style chain.
    const st = session.styleOf(v)
    const sc = this.q(v, 'style')
    if (st && sc) {
      const active = st.chain > 0
      c.cls(sc, key('scshow'), 'show', active)
      if (active) {
        c.text(this.q(v, 'sclabel'), key('scl'), st.last)
        c.text(this.q(v, 'scpts'), key('scp'), `+${st.chain.toLocaleString('en-US')}`)
        c.text(this.q(v, 'scmult'), key('scm'), `×${st.mult}`)
        c.style(this.q(v, 'sctimer'), key('sct'), '--p', st.window.toFixed(3))
      }
      c.cls(sc, key('schot'), 'hot', st.mult >= 3)
    }
    // Center.
    const cd = h.countdown
    const waiting = session.online && session.online.targetTick() < 0
    const count = waiting ? 'GET READY' : cd > 0 ? String(Math.ceil(cd)) : h.clock < 1 && session.sim.phase === 'racing' ? 'GO!' : ''
    const cEl = this.q(v, 'count')
    c.text(cEl, key('count'), count)
    c.cls(cEl, key('countgo'), 'go', count === 'GO!')
    c.cls(cEl, key('countwait'), 'wait', count === 'GET READY')
    c.cls(this.q(v, 'wrong'), key('wrong'), 'show', car.wrongWay > 1.2 && car.recovering <= 0 && !car.progress.finished)
    // Respawn hold overlay (wreck → respawn → 3 s hold; manual reset → 3 s hold).
    const holding = car.wreck > 0 || car.recovering > 0 || car.hold > 0
    const hold = this.q(v, 'hold')
    c.cls(hold, key('hold'), 'show', holding && !car.progress.finished)
    if (holding) {
      const label = car.wreck > 0 ? 'WRECKED' : car.recovering > 0 ? 'RESETTING' : 'RESPAWN HOLD'
      c.text(this.q(v, 'holdlabel'), key('holdl'), label)
      c.text(this.q(v, 'holdn'), key('holdn'), String(Math.max(1, Math.ceil(car.hold > 0 ? car.hold : HOLD_TIME))))
      c.style(this.q(v, 'holdp'), key('holdp'), '--p', (car.hold > 0 ? 1 - car.hold / HOLD_TIME : 0).toFixed(3))
      c.text(this.q(v, 'holdhint'), key('holdh'), car.wreck > 0 ? 'Too much damage — rebuilding on the spot' : 'Engine restarting — keep your throttle ready')
      c.cls(hold, key('holdw'), 'wreck', car.wreck > 0)
    }
    // Hull integrity.
    const hullPct = Math.round((1 - (car.wreck > 0 ? 1 : car.damage)) * 100)
    const hullEl = this.q(v, 'hull')
    c.style(this.q(v, 'hullfill'), key('hullf'), '--p', (hullPct / 100).toFixed(3))
    c.text(this.q(v, 'hullpct'), key('hullp'), `${hullPct}%`)
    c.text(this.q(v, 'hulllabel'), key('hulll'), car.damage >= DAMAGE_FIRE || car.wreck > 0 ? 'ON FIRE' : car.damage >= DAMAGE_SMOKE ? 'SMOKING' : 'HULL')
    c.cls(hullEl, key('hullw'), 'warn', car.damage >= DAMAGE_SMOKE && car.damage < DAMAGE_FIRE)
    c.cls(hullEl, key('hullc'), 'crit', car.damage >= DAMAGE_FIRE || car.wreck > 0)
    c.cls(this.views[v], key('burning'), 'burning', !this.reduced && (car.damage >= DAMAGE_FIRE || car.wreck > 0))
    // Banked-wall grip: G-load pressing the car into the bank vs the slide-off threshold.
    const bankNow = Math.abs(session.track.bank[car.loc.i] ?? 0)
    const onWall = car.grounded && car.wreck <= 0 && (bankNow > 0.7 || car.slip > 0.05)
    const wallEl = this.q(v, 'wall')
    c.cls(wallEl, key('wallshow'), 'show', onWall)
    if (onWall) {
      const g = Math.max(0, car.anchor)
      c.style(this.q(v, 'wallfill'), key('wallf'), '--p', clamp(g / 3, 0, 1).toFixed(3))
      c.text(this.q(v, 'wallg'), key('wallg'), `${g.toFixed(1)} G`)
      c.text(this.q(v, 'walllabel'), key('walll'), car.slip > 0.25 ? 'TOO SLOW — SLIDING' : car.slip > 0.05 ? 'LOSING GRIP' : `WALL RIDE ${Math.round((Math.atan(bankNow) * 180) / Math.PI)}°`)
      c.cls(wallEl, key('walllow'), 'low', car.slip > 0.05)
    }
    const done = car.progress.finished ? `FINISHED ${ord}` : car.progress.dnf ? 'TIME LIMIT REACHED' : ''
    c.text(this.q(v, 'done'), key('done'), done)
    c.cls(this.q(v, 'done'), key('doneshow'), 'show', !!done)
    const lines = this.q(v, 'lines')
    c.cls(lines, key('lines'), 'show', !this.reduced && (boosting || kmh > 190))
    c.cls(lines, key('linesb'), 'boost', boosting)
    c.cls(lines, key('linesm'), 'meter', car.meterBoosting)
  }

  private drawDial(v: number, kmh: number, meter: number, boosting: boolean): void {
    const cv = this.q(v, 'dialc') as HTMLCanvasElement | null
    const g = cv?.getContext('2d')
    if (!cv || !g) return
    const W = 260
    const cx = W / 2
    const cy = W / 2
    const R = 104
    const a0 = Math.PI * 0.75
    const span = Math.PI * 1.5
    const ang = (k: number) => a0 + span * Math.max(0, Math.min(1, k / DIAL_MAX))
    this.dialNeedle[v] += (kmh - this.dialNeedle[v]) * 0.35
    const nk = this.dialNeedle[v]
    g.clearRect(0, 0, W, W)
    const face = g.createRadialGradient(cx, cy - 20, 10, cx, cy, R + 8)
    face.addColorStop(0, 'rgba(46,30,40,0.92)')
    face.addColorStop(1, 'rgba(14,10,18,0.92)')
    g.fillStyle = face
    g.beginPath()
    g.arc(cx, cy, R + 6, 0, Math.PI * 2)
    g.fill()
    const bez = g.createLinearGradient(0, cy - R, 0, cy + R)
    bez.addColorStop(0, '#ffe6a1')
    bez.addColorStop(0.5, '#b8862e')
    bez.addColorStop(1, '#6d4a17')
    g.strokeStyle = bez
    g.lineWidth = 5
    g.beginPath()
    g.arc(cx, cy, R + 6, 0, Math.PI * 2)
    g.stroke()
    g.lineCap = 'butt'
    g.lineWidth = 10
    g.strokeStyle = 'rgba(255,255,255,0.08)'
    g.beginPath()
    g.arc(cx, cy, R - 10, a0, a0 + span)
    g.stroke()
    const sp = g.createLinearGradient(cx - R, 0, cx + R, 0)
    sp.addColorStop(0, '#3fb6ff')
    sp.addColorStop(0.6, '#7ef9ff')
    sp.addColorStop(0.8, '#ffb020')
    sp.addColorStop(1, '#ff4d5e')
    g.strokeStyle = sp
    g.beginPath()
    g.arc(cx, cy, R - 10, a0, ang(nk))
    g.stroke()
    g.strokeStyle = 'rgba(255,77,94,0.85)'
    g.lineWidth = 4
    g.beginPath()
    g.arc(cx, cy, R + 1, ang(240), ang(300))
    g.stroke()
    g.font = '700 13px Sora, system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (let k = 0; k <= DIAL_MAX; k += 10) {
      const a = ang(k)
      const major = k % 30 === 0
      const r1 = R - (major ? 26 : 21)
      const r2 = R - 17
      g.strokeStyle = k >= 240 ? '#ff6b6b' : major ? '#fff4dc' : 'rgba(245,230,204,0.45)'
      g.lineWidth = major ? 2.5 : 1.2
      g.beginPath()
      g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1)
      g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2)
      g.stroke()
      if (k % 60 === 0) {
        g.fillStyle = k >= 240 ? '#ff8a8a' : 'rgba(245,230,204,0.85)'
        g.fillText(String(k), cx + Math.cos(a) * (R - 40), cy + Math.sin(a) * (R - 40))
      }
    }
    const b0 = Math.PI * 0.8
    const bs = Math.PI * 0.55
    g.lineCap = 'round'
    g.lineWidth = 9
    g.strokeStyle = 'rgba(126,249,255,0.12)'
    g.beginPath()
    g.arc(cx, cy, R + 17, b0, b0 + bs)
    g.stroke()
    if (meter > 0.001) {
      g.shadowColor = '#7ef9ff'
      g.shadowBlur = boosting ? 18 : 8
      g.strokeStyle = boosting ? '#c8fdff' : '#4fd8ff'
      g.beginPath()
      g.arc(cx, cy, R + 17, b0 + bs * (1 - meter), b0 + bs)
      g.stroke()
      g.shadowBlur = 0
    }
    const na = ang(nk)
    g.shadowColor = '#ff9a2a'
    g.shadowBlur = 10
    g.strokeStyle = '#ffb020'
    g.lineWidth = 4
    g.beginPath()
    g.moveTo(cx - Math.cos(na) * 12, cy - Math.sin(na) * 12)
    g.lineTo(cx + Math.cos(na) * (R - 16), cy + Math.sin(na) * (R - 16))
    g.stroke()
    g.shadowBlur = 0
    g.fillStyle = '#2a1a22'
    g.strokeStyle = '#ffd23f'
    g.lineWidth = 2
    g.beginPath()
    g.arc(cx, cy, 7, 0, Math.PI * 2)
    g.fill()
    g.stroke()
  }

  private drawMap(session: Session): void {
    const g = this.minimap.getContext('2d')
    if (!g || !this.mapPath) return
    const S = 440
    g.clearRect(0, 0, S, S)
    g.save()
    g.beginPath()
    g.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2)
    g.clip()
    const bg = g.createRadialGradient(S / 2, S / 2, 20, S / 2, S / 2, S / 2)
    bg.addColorStop(0, 'rgba(92,58,40,0.78)')
    bg.addColorStop(1, 'rgba(26,16,20,0.9)')
    g.fillStyle = bg
    g.fillRect(0, 0, S, S)
    g.lineJoin = 'round'
    g.lineCap = 'round'
    g.strokeStyle = 'rgba(10,6,10,0.8)'
    g.lineWidth = 22
    g.stroke(this.mapPath)
    g.strokeStyle = '#f7ecd8'
    g.lineWidth = 9
    g.stroke(this.mapPath)
    const t = session.track
    const h0 = session.hud(0)
    const gate = t.gates[h0.gate - 1]
    if (gate && !h0.car.progress.finished) {
      const [gx, gy] = this.mapPoint(t.x[gate.sample], t.z[gate.sample])
      const pulse = 9 + Math.sin(this.clock * 8) * 3
      g.fillStyle = 'rgba(126,249,255,0.35)'
      g.beginPath()
      g.arc(gx, gy, pulse + 6, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#7ef9ff'
      g.beginPath()
      g.arc(gx, gy, 7, 0, Math.PI * 2)
      g.fill()
    }
    const [sx, sy] = this.mapPoint(t.x[0], t.z[0])
    for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) {
      g.fillStyle = (i + j) % 2 ? '#111' : '#fff'
      g.fillRect(sx - 10 + i * 5, sy - 10 + j * 5, 5, 5)
    }
    for (const m of session.markers()) {
      const [x, y] = this.mapPoint(m.x, m.z)
      g.globalAlpha = m.ghost ? 0.6 : 1
      if (m.human) {
        g.fillStyle = 'rgba(255,255,255,0.25)'
        g.beginPath()
        g.arc(x, y, 20, 0, Math.PI * 2)
        g.fill()
      }
      g.fillStyle = LIVERIES[m.livery]?.primary ?? '#fff'
      g.strokeStyle = m.human ? '#fff' : '#1b1030'
      g.lineWidth = m.human ? 5 : 3.5
      g.beginPath()
      g.arc(x, y, m.human ? 12 : 9, 0, Math.PI * 2)
      g.fill()
      g.stroke()
    }
    g.globalAlpha = 1
    g.restore()
    const ring = g.createLinearGradient(0, 0, 0, S)
    ring.addColorStop(0, '#ffe6a1')
    ring.addColorStop(0.5, '#b8862e')
    ring.addColorStop(1, '#6d4a17')
    g.strokeStyle = ring
    g.lineWidth = 9
    g.beginPath()
    g.arc(S / 2, S / 2, S / 2 - 10, 0, Math.PI * 2)
    g.stroke()
    g.strokeStyle = 'rgba(255,230,160,0.35)'
    g.lineWidth = 2
    for (let k = 0; k < 24; k += 1) {
      const a = (k / 24) * Math.PI * 2
      const r1 = S / 2 - 26
      const r2 = S / 2 - (k % 6 === 0 ? 40 : 32)
      g.beginPath()
      g.moveTo(S / 2 + Math.cos(a) * r1, S / 2 + Math.sin(a) * r1)
      g.lineTo(S / 2 + Math.cos(a) * r2, S / 2 + Math.sin(a) * r2)
      g.stroke()
    }
  }

  setOnline(text: string): void {
    const el = this.root.querySelector<HTMLElement>('[data-online]')!
    if (el.textContent !== text) el.textContent = text
    el.classList.toggle('show', !!text)
  }
}
