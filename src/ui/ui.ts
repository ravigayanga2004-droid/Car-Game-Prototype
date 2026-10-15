import type { App, BestFlags, RaceConfig, TrackRef } from '../game/app'
import { MAIN_TRACK } from '../game/app'
import type { ResultRow } from '../game/session'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import { CHASSIS_COUNT, LIVERY_COUNT, MAX_CUSTOM_TRACKS, type AssistMode, type Device, type Quality, type SaveData, type SaveStore } from '../engine/save'
import type { GhostNet, OnlineResult } from '../net/ghostnet'
import { sanitizeName } from '../sim/netcodec'
import { DEFAULT_LAB, decodeLab, encodeLab, generateLabTrack, labId, sanitizeLab, type LabParams } from '../sim/tracks'
import { CHASSIS, LIVERIES } from '../view/cars'
import { esc, formatTime, LAPS, ordinal, TOTAL_GATES } from './format'
import { Hud } from './hud'
import { UiFx } from './uifx'
import { DEVICE_LABEL, swatch, uiTemplate, type Screen, type UiActions } from './templates'

export type { Screen, UiActions }

/** Small tag marking a time or lap driven with corner assist on. */
const ASSIST_TAG = ' <em class="assist-tag" title="Driven with corner assist on">ASSIST</em>'
export class Ui {
  screen: Screen = 'boot'
  private readonly root: HTMLElement
  readonly hud: Hud
  readonly fx: UiFx
  private hoverEl: Element | null = null
  private hoverAt = 0
  private lab: LabParams = { ...DEFAULT_LAB }
  private labTimer = 0
  private labEditing: string | null = null
  private soloTrack: TrackRef = MAIN_TRACK
  private splitTrack: TrackRef = MAIN_TRACK
  private lastResults: { rows: ResultRow[]; cfg: RaceConfig } | null = null
  private modal: 'settings' | 'controls' | null = null
  private navCooldown = 0
  private toastTimer = 0
  private pendingRoom = ''

  constructor(private readonly app: App, private readonly save: SaveStore, private readonly audio: Audio, private readonly input: Input, private readonly net: GhostNet, private readonly actions: UiActions) {
    this.root = document.getElementById('ui')!
    this.root.innerHTML = uiTemplate()
    this.fx = new UiFx(document.body)
    this.hud = new Hud(this.el('[data-screen="hud"]'), this.fx)
    this.bind()
    this.refreshSettings()
    const room = new URLSearchParams(location.search).get('room')
    if (room) this.pendingRoom = room.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  }

  private el<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!
  }

  // ─── binding ───────────────────────────────────────────────────────────

  private bind(): void {
    // Interaction juice: hover glints + blips, click spark bursts coloured by button role.
    this.root.addEventListener('pointerover', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button, .mode-card, .swatch')
      if (!t || t === this.hoverEl || this.screen === 'hud') return
      this.hoverEl = t
      const now = performance.now()
      if (now - this.hoverAt < 70) return
      this.hoverAt = now
      const r = t.getBoundingClientRect()
      this.fx.glint(r.right - 10, r.top + 8, '#fff4dc', 14)
      this.fx.edge(t, '#ffd23f', Math.random(), 3)
      this.audio.play('ui', 0.45)
    })
    this.root.addEventListener('pointerdown', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button, .mode-card, .swatch')
      if (!t || this.screen === 'hud') return
      const primary = t.classList.contains('primary') || t.classList.contains('big')
      const color = primary ? '#ff9a4a' : t.classList.contains('mode-card') ? '#7ef9ff' : '#ffd23f'
      this.fx.burst(e.clientX, e.clientY, color, primary ? 34 : 18, primary ? 520 : 360, { size: primary ? 2.8 : 2, glints: primary ? 3 : 1 })
    })
    this.root.addEventListener('click', e => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('button')
      if (!t || !this.root.contains(t) || t.closest('.seg')) return
      this.audio.unlock()
      const act = t.dataset.act
      if (act) {
        this.audio.play(act === 'back' || act === 'onBack' || act === 'closeModal' ? 'back' : 'confirm')
        this.act(act)
        return
      }
      if (t.dataset.mode) {
        this.audio.play('confirm')
        this.openMode(t.dataset.mode)
        return
      }
      if (t.dataset.swatch !== undefined || t.dataset.sw1 !== undefined) {
        this.audio.play('ui')
        this.settings({ livery: Number(t.dataset.swatch ?? t.dataset.sw1) })
      } else if (t.dataset.sw2 !== undefined) {
        this.audio.play('ui')
        this.settings({ p2Livery: Number(t.dataset.sw2) })
      }
    })
    const name = this.el<HTMLInputElement>('[data-g="name"]')
    name.addEventListener('change', () => this.settings({ playerName: sanitizeName(name.value) }))
    this.root.querySelectorAll<HTMLElement>('.seg').forEach(seg => {
      seg.addEventListener('click', e => {
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-v]')
        if (!b) return
        this.audio.unlock()
        this.audio.play('ui')
        const v = b.dataset.v!
        if (seg.dataset.s === 'skill') this.settings({ aiSkill: v as SaveData['aiSkill'] })
        if (seg.dataset.s === 'items' || seg.dataset.sp === 'items') this.settings({ items: v === 'on' })
        if (seg.dataset.set === 'quality') this.settings({ quality: v as Quality })
        if (seg.dataset.set === 'assistP1') this.settings({ assistP1: v as AssistMode })
        if (seg.dataset.set === 'assistP2') this.settings({ assistP2: v as AssistMode })
        this.refreshSettings()
      })
    })
    this.root.querySelectorAll<HTMLInputElement>('input[data-set]').forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.set as keyof SaveData
        if (inp.type === 'checkbox') this.settings({ [key]: inp.checked } as Partial<SaveData>)
        else this.settings({ [key]: Number(inp.value) } as Partial<SaveData>)
        this.refreshSettings()
      })
    })
    for (const k of ['d1', 'd2'] as const) {
      const sel = this.el<HTMLSelectElement>(`[data-sp="${k}"]`)
      sel.innerHTML = (['kbLeft', 'kbRight', 'pad0', 'pad1'] as Device[]).map(d => `<option value="${d}">${DEVICE_LABEL[d]}</option>`).join('')
      sel.addEventListener('change', () => this.settings(k === 'd1' ? { p1Device: sel.value as Device } : { p2Device: sel.value as Device }))
    }
    this.root.querySelectorAll<HTMLInputElement>('input[data-lab]').forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.lab as keyof LabParams
        this.lab = sanitizeLab({ ...this.lab, [key]: Number(inp.value) })
        this.labChanged()
      })
    })
    const labName = this.el<HTMLInputElement>('[data-l="name"]')
    labName.addEventListener('input', () => {
      this.lab = sanitizeLab({ ...this.lab, name: labName.value })
      this.refreshLabCode()
    })
    this.el<HTMLInputElement>('[data-o="code"]').addEventListener('keydown', e => {
      if (e.key === 'Enter') this.act('onJoin')
    })
    window.addEventListener('keydown', e => {
      if (e.repeat) return
      const typing = e.target instanceof HTMLInputElement && e.target.type === 'text'
      const arrows: Record<string, [number, number]> = { ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }
      const dir = arrows[e.key]
      if (dir && !typing && this.screen !== 'hud' && this.screen !== 'boot') {
        const t = e.target as HTMLElement
        const native = (t instanceof HTMLInputElement && t.type === 'range' && dir[0] !== 0) || t instanceof HTMLSelectElement
        if (!native) {
          e.preventDefault()
          this.moveFocus(dir[0], dir[1])
          return
        }
      }
      if (e.key === 'Enter' && this.screen === 'title') {
        e.preventDefault()
        this.act('enter')
      }
      else if (e.key === 'Escape' && this.modal) this.act('closeModal')
      else if (e.key === 'Escape' && ['solo', 'split', 'lab'].includes(this.screen)) this.act('back')
      else if (e.key === 'Escape' && this.screen === 'online') this.act('onBack')
      else if (this.screen === 'results' && !this.modal && !typing && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        this.act('rematch')
      }
    })
  }

  private settings(patch: Partial<SaveData>): void {
    this.actions.settings(patch)
    this.refreshGarage()
    this.refreshSetups()
  }

  private act(act: string): void {
    const d = this.save.data
    switch (act) {
      case 'enter':
        this.show('garage')
        if (this.pendingRoom) {
          this.el<HTMLInputElement>('[data-o="code"]').value = this.pendingRoom
          this.pendingRoom = ''
          this.openMode('online')
        }
        break
      case 'controls': this.openModal('controls'); break
      case 'settings': this.openModal('settings'); break
      case 'closeModal': this.closeModal(); break
      case 'prevCar': case 'p1Prev': this.settings({ chassis: (d.chassis + CHASSIS_COUNT - 1) % CHASSIS_COUNT }); break
      case 'nextCar': case 'p1Next': this.settings({ chassis: (d.chassis + 1) % CHASSIS_COUNT }); break
      case 'p2Prev': this.settings({ p2Chassis: (d.p2Chassis + CHASSIS_COUNT - 1) % CHASSIS_COUNT }); break
      case 'p2Next': this.settings({ p2Chassis: (d.p2Chassis + 1) % CHASSIS_COUNT }); break
      case 'back': this.show('garage'); break
      case 'goSolo': this.actions.startRace({ mode: 'solo', track: this.soloTrack, items: d.items, aiSkill: d.aiSkill }); break
      case 'goSplit':
        if (d.p1Device === d.p2Device) return this.toast('Players need different control devices.')
        this.actions.startRace({ mode: 'split', track: this.splitTrack, items: d.items, aiSkill: d.aiSkill })
        break
      case 'labRandom':
        this.lab = sanitizeLab({ ...this.lab, seed: Math.floor(Math.random() * 999999) })
        this.labEditing = null
        this.refreshLab()
        break
      case 'labCopy': this.copy(encodeLab(this.lab), 'Share code copied'); break
      case 'labImport': {
        const inp = this.el<HTMLInputElement>('[data-l="import"]')
        const lab = decodeLab(inp.value.trim())
        if (!lab) return this.toast('That share code is not valid.')
        this.lab = lab
        this.labEditing = null
        inp.value = ''
        this.refreshLab()
        this.toast(`Loaded “${lab.name}”`)
        break
      }
      case 'labSave': this.saveLab(); break
      case 'labTest': this.startLab('test'); break
      case 'labRace': this.startLab('solo'); break
      case 'onCreate': this.actions.online(''); break
      case 'onJoin': {
        const code = this.el<HTMLInputElement>('[data-o="code"]').value.trim().toUpperCase()
        if (!code) return this.toast('Enter a room code first.')
        this.actions.online(code)
        break
      }
      case 'onBack': this.actions.leaveOnline(); this.show('garage'); break
      case 'onReady': this.net.setReady(!this.net.lobby?.players.find(p => p.seat === this.net.seat)?.ready); break
      case 'onStart': this.net.start(); break
      case 'onInvite': this.copy(`${location.origin}${location.pathname}?room=${this.net.room}`, 'Invite link copied'); break
      case 'resume': this.actions.resume(); break
      case 'restart': this.actions.restart(); break
      case 'quit': case 'toGarage': this.actions.garage(); break
      case 'rematch': this.actions.rematch(); break
      case 'editLab': {
        const lab = this.lastResults?.cfg.track.lab
        this.actions.garage()
        if (lab) {
          this.lab = { ...lab }
          this.labEditing = labId(lab)
          this.openMode('lab')
        }
        break
      }
      default:
        if (act.startsWith('labLoad:')) {
          const lab = this.save.data.customTracks.find(t => labId(t) === act.slice(8))
          if (lab) {
            this.lab = { ...lab }
            this.labEditing = labId(lab)
            this.refreshLab()
          }
        } else if (act.startsWith('labDel:')) {
          const id = act.slice(7)
          this.actions.settings({ customTracks: this.save.data.customTracks.filter(t => labId(t) !== id) })
          if (this.labEditing === id) this.labEditing = null
          this.refreshLab()
          this.refreshSetups()
        } else if (act.startsWith('track:')) {
          const [, which, id] = act.split(':')
          const ref = this.app.trackRefs().find(r => r.id === id) ?? MAIN_TRACK
          if (which === 'solo') this.soloTrack = ref
          else if (which === 'split') this.splitTrack = ref
          else if (which === 'online') this.net.setTrack(this.app.onlineCode(ref))
          this.refreshSetups()
        }
    }
  }

  private openMode(mode: string): void {
    if (mode === 'solo' || mode === 'split') {
      this.refreshSetups()
      this.show(mode)
    } else if (mode === 'lab') {
      this.refreshLab()
      this.show('lab')
    } else if (mode === 'online') {
      this.refreshOnline()
      this.show('online')
    }
  }

  private startLab(mode: 'test' | 'solo'): void {
    const res = generateLabTrack(this.lab)
    if (!res.check.ok) return this.toast('This layout overlaps itself — try a new layout or less twist.')
    const ref: TrackRef = { id: labId(this.lab), name: this.lab.name, lab: { ...this.lab } }
    this.actions.startRace({ mode, track: ref, items: mode === 'solo' && this.save.data.items, aiSkill: this.save.data.aiSkill })
  }

  private saveLab(): void {
    const res = generateLabTrack(this.lab)
    if (!res.check.ok) return this.toast('Fix the overlap before saving.')
    const id = labId(this.lab)
    const list = this.save.data.customTracks.filter(t => labId(t) !== id && labId(t) !== this.labEditing)
    if (list.length >= MAX_CUSTOM_TRACKS) return this.toast(`You can keep ${MAX_CUSTOM_TRACKS} tracks. Delete one first.`)
    list.unshift({ ...this.lab })
    this.actions.settings({ customTracks: list })
    this.labEditing = id
    this.refreshLab()
    this.refreshSetups()
    this.toast(`Saved “${this.lab.name}”`)
  }

  private copy(text: string, ok: string): void {
    if (!navigator.clipboard) return this.toast(text)
    navigator.clipboard.writeText(text).then(() => this.toast(ok), () => this.toast(text))
  }

  toast(text: string): void {
    const t = this.el('[data-toast]')
    t.textContent = text
    t.classList.add('show')
    clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600)
  }

  // ─── screens ───────────────────────────────────────────────────────────

  show(screen: Screen): void {
    this.screen = screen
    this.root.querySelectorAll<HTMLElement>('.screen').forEach(s => s.classList.toggle('is-active', s.dataset.screen === screen))
    this.root.classList.toggle('in-race', screen === 'hud' || screen === 'pause')
    document.body.dataset.screen = screen
    if (screen === 'garage') this.refreshGarage()
    if (screen === 'hud' || this.input.method === 'touch') (document.activeElement as HTMLElement | null)?.blur?.()
    else this.focusDefault()
  }

  private focusDefault(): void {
    const scope = this.root.querySelector(`[data-screen="${this.screen}"]`)
    const target = scope?.querySelector<HTMLElement>('[data-autofocus]') ?? this.focusables()[0]
    target?.focus({ preventScroll: true })
  }

  private openModal(m: 'settings' | 'controls'): void {
    this.modal = m
    this.refreshSettings()
    this.root.querySelectorAll<HTMLElement>('[data-modal]').forEach(o => o.classList.toggle('show', o.dataset.modal === m))
    this.focusables()[0]?.focus({ preventScroll: true })
  }

  private closeModal(): void {
    this.modal = null
    this.root.querySelectorAll<HTMLElement>('[data-modal]').forEach(o => o.classList.remove('show'))
    if (this.input.method !== 'touch') this.focusDefault()
  }

  get modalOpen(): boolean {
    return this.modal !== null
  }

  setBootProgress(p: number): void {
    this.el('[data-boot]').style.width = `${Math.round(p * 100)}%`
  }

  loading(text: string | null): void {
    this.el('[data-loading]').classList.toggle('show', !!text)
    if (text) this.el('[data-loading-text]').textContent = text
  }

  pauseNote(online: boolean): void {
    this.el('[data-p="note"]').textContent = online ? 'Online races keep running — your car coasts while this menu is open.' : 'The race clock is stopped.'
    this.el('[data-act="restart"]').style.display = online ? 'none' : ''
  }

  // ─── refreshers ────────────────────────────────────────────────────────

  refreshGarage(): void {
    const d = this.save.data
    const c = CHASSIS[d.chassis]
    this.el('[data-g="chassis"]').textContent = c.name
    this.el('[data-g="blurb"]').textContent = c.blurb
    this.el('[data-g="swatches"]').innerHTML = Array.from({ length: LIVERY_COUNT }, (_, i) => swatch(i, d.livery, 'swatch')).join('')
    this.el('[data-g="livery"]').textContent = `Livery: ${LIVERIES[d.livery].name}`
    const name = this.el<HTMLInputElement>('[data-g="name"]')
    if (document.activeElement !== name) name.value = d.playerName
    const bests = this.app.trackRefs().slice(0, 5).map(r => {
      const b = d.bests[r.id]
      return `<div class="best"><span>${esc(r.name)}</span><b>${b ? formatTime(b.total) : '—'}${b?.totalAssist ? ASSIST_TAG : ''}</b><small>${b && b.lap ? `best lap ${formatTime(b.lap)}${b.lapAssist ? ASSIST_TAG : ''}` : 'no finish yet'}</small></div>`
    }).join('')
    this.el('[data-g="bests"]').innerHTML = `<h3>Personal bests</h3>${bests}`
    this.app.previewCar(d.chassis, d.livery)
  }

  private trackChoices(which: string, current: TrackRef): string {
    return this.app.trackRefs().map(r => `<button type="button" class="chip${r.id === current.id ? ' sel' : ''}" data-act="track:${which}:${r.id}">${esc(r.name)}</button>`).join('')
  }

  refreshSetups(): void {
    const d = this.save.data
    const refs = this.app.trackRefs()
    if (!refs.some(r => r.id === this.soloTrack.id)) this.soloTrack = MAIN_TRACK
    if (!refs.some(r => r.id === this.splitTrack.id)) this.splitTrack = MAIN_TRACK
    this.el('[data-s="tracks"]').innerHTML = this.trackChoices('solo', this.soloTrack)
    this.el('[data-sp="tracks"]').innerHTML = this.trackChoices('split', this.splitTrack)
    const seg = (sel: string, v: string) => this.root.querySelectorAll<HTMLButtonElement>(`${sel} button`).forEach(b => b.classList.toggle('sel', b.dataset.v === v))
    seg('[data-s="skill"]', d.aiSkill)
    seg('[data-s="items"]', d.items ? 'on' : 'off')
    seg('[data-sp="items"]', d.items ? 'on' : 'off')
    this.el('[data-sp="c1"]').textContent = CHASSIS[d.chassis].name
    this.el('[data-sp="c2"]').textContent = CHASSIS[d.p2Chassis].name
    this.el('[data-sp="s1"]').innerHTML = Array.from({ length: LIVERY_COUNT }, (_, i) => swatch(i, d.livery, 'sw1')).join('')
    this.el('[data-sp="s2"]').innerHTML = Array.from({ length: LIVERY_COUNT }, (_, i) => swatch(i, d.p2Livery, 'sw2')).join('')
    this.el<HTMLSelectElement>('[data-sp="d1"]').value = d.p1Device
    this.el<HTMLSelectElement>('[data-sp="d2"]').value = d.p2Device
    const pads = this.input.gamepadCount
    const needs = [d.p1Device, d.p2Device].filter(x => x === 'pad0' || x === 'pad1').length
    this.el('[data-sp="note"]').textContent =
      d.p1Device === d.p2Device
        ? 'Both players are on the same device — pick different controls.'
        : needs > pads
          ? `Connect ${needs} gamepad${needs > 1 ? 's' : ''} (press any button to wake it). ${pads} detected.`
          : 'Sharing a keyboard works: P1 uses WASD + Space / L-Shift / E / R, P2 uses Arrows + R-Shift / . / , / L.'
  }

  refreshSettings(): void {
    const d = this.save.data
    for (const key of ['musicVolume', 'sfxVolume'] as const) {
      this.el<HTMLInputElement>(`input[data-set="${key}"]`).value = String(d[key])
      this.el(`[data-set-out="${key}"]`).textContent = `${Math.round(d[key] * 100)}%`
    }
    for (const key of ['muted', 'reducedMotion', 'cameraShake'] as const) this.el<HTMLInputElement>(`input[data-set="${key}"]`).checked = d[key]
    this.root.querySelectorAll<HTMLButtonElement>('[data-set="quality"] button').forEach(b => b.classList.toggle('sel', b.dataset.v === d.quality))
    for (const key of ['assistP1', 'assistP2'] as const) this.root.querySelectorAll<HTMLButtonElement>(`[data-set="${key}"] button`).forEach(b => b.classList.toggle('sel', b.dataset.v === d[key]))
  }

  private labChanged(): void {
    for (const inp of this.root.querySelectorAll<HTMLInputElement>('input[data-lab]')) {
      const key = inp.dataset.lab as keyof LabParams
      const v = this.lab[key] as number
      this.el(`[data-lab-out="${key}"]`).textContent = key === 'width' ? `${v} m` : ['ramps', 'pads', 'items'].includes(key) ? String(v) : `${Math.round(v * 100)}%`
    }
    this.el('[data-l="seed"]').textContent = String(this.lab.seed)
    this.refreshLabCode()
    clearTimeout(this.labTimer)
    this.labTimer = window.setTimeout(() => this.drawLab(), 120)
  }

  private refreshLabCode(): void {
    this.el('[data-l="code"]').textContent = encodeLab(this.lab)
  }

  refreshLab(): void {
    for (const inp of this.root.querySelectorAll<HTMLInputElement>('input[data-lab]')) inp.value = String(this.lab[inp.dataset.lab as keyof LabParams])
    this.el<HTMLInputElement>('[data-l="name"]').value = this.lab.name
    this.labChanged()
    const saved = this.save.data.customTracks
    this.el('[data-l="saved"]').innerHTML = saved.length
      ? saved
        .map(t => {
          const id = labId(t)
          const best = this.save.data.bests[id]
          return `<div class="saved${id === this.labEditing ? ' sel' : ''}"><button type="button" class="link" data-act="labLoad:${id}">${esc(t.name)}</button><small>${best ? formatTime(best.total) : 'untimed'}${best?.totalAssist ? ASSIST_TAG : ''}</small><button type="button" class="btn icon small" data-act="labDel:${id}" aria-label="Delete ${esc(t.name)}">✕</button></div>`
        })
        .join('')
      : '<p class="muted">No saved tracks yet. Saved tracks appear in the Solo, Split-Screen and Online track lists.</p>'
  }

  private drawLab(): void {
    const res = generateLabTrack(this.lab)
    const cv = this.el<HTMLCanvasElement>('[data-l="map"]')
    const g = cv.getContext('2d')
    if (!g) return
    const t = res.track
    const b = t.bounds
    const size = 360
    const s = (size - 40) / Math.max(b.maxX - b.minX, b.maxZ - b.minZ)
    const cx = (b.minX + b.maxX) / 2
    const cz = (b.minZ + b.maxZ) / 2
    const P = (i: number): [number, number] => [size / 2 - (t.x[i] - cx) * s, size / 2 + (t.z[i] - cz) * s]
    g.clearRect(0, 0, size, size)
    g.lineCap = 'round'
    g.lineJoin = 'round'
    for (let i = 0; i < t.n; i += 2) {
      const j = (i + 2) % t.n
      const [x0, y0] = P(i)
      const [x1, y1] = P(j)
      g.strokeStyle = '#1b1030'
      g.lineWidth = 10
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
      g.strokeStyle = t.bridge[i] > 0.5 ? '#7ef9ff' : t.canyon[i] > 0.5 ? '#e07a45' : t.ridge[i] > 0.5 ? '#ffd23f' : '#f5e6cc'
      g.lineWidth = 5
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke()
    }
    g.font = '700 11px Figtree, sans-serif'
    g.textAlign = 'center'
    for (const gate of t.gates) {
      const [x, y] = P(gate.sample)
      g.fillStyle = '#1b1030'
      g.beginPath(); g.arc(x, y, 8, 0, Math.PI * 2); g.fill()
      g.fillStyle = gate.index === t.gates.length - 1 ? '#ffd23f' : '#ffffff'
      g.fillText(String(gate.index + 1), x, y + 4)
    }
    for (const r of t.ramps) {
      const [x, y] = P(t.sampleIndex(r.s0))
      g.fillStyle = '#ff6b35'
      g.fillRect(x - 5, y - 5, 10, 10)
    }
    const c = res.check
    this.el('[data-l="check"]').innerHTML = c.ok
      ? `<b class="ok">Layout OK</b> · ${(c.length / 1000).toFixed(2)} km lap · tightest turn ${Math.round(c.minRadius)} m · ${t.pads.length} pads · ${t.ramps.length} ramps`
      : `<b class="bad">Overlap detected</b> · sections come within ${Math.round(c.minGap)} m. Try a new layout, less twist or a bigger size.`
  }

  // ─── online lobby ──────────────────────────────────────────────────────

  refreshOnline(): void {
    const n = this.net
    const status = this.el('[data-o="status"]')
    status.textContent = n.message
    status.className = `net-status ${n.status}`
    const inRoom = n.status === 'connected' && !!n.lobby
    this.el('[data-o="join"]').style.display = inRoom ? 'none' : ''
    const lobby = this.el('[data-o="lobby"]')
    if (!inRoom || !n.lobby) {
      lobby.innerHTML = ''
      return
    }
    const L = n.lobby
    const me = L.players.find(p => p.seat === n.seat)
    const seats = [0, 1, 2]
      .map(s => {
        const p = L.players.find(q => q.seat === s)
        if (!p) return `<div class="seat empty"><span>Seat ${s + 1}</span><small>Open — share the room code</small></div>`
        const liv = LIVERIES[p.livery] ?? LIVERIES[0]
        const tags = `${p.seat === L.host ? ' <em>HOST</em>' : ''}${p.seat === n.seat ? ' <em>YOU</em>' : ''}`
        const state = p.connected ? (p.ready ? '<b class="ok">Ready</b>' : 'Not ready') : 'Reconnecting…'
        return `<div class="seat${p.seat === n.seat ? ' me' : ''}"><i style="--a:${liv.primary};--b:${liv.secondary}"></i><span>${esc(p.name)}${tags}</span><small>${esc(CHASSIS[p.chassis]?.name ?? '')} · ${state}</small></div>`
      })
      .join('')
    const trackRef = this.app.refFromOnline(L.track)
    const tracks =
      n.isHost && L.phase === 'lobby'
        ? `<div class="row"><span class="label">Track</span><div class="choices">${this.app.trackRefs().map(r => `<button type="button" class="chip${r.id === trackRef.id ? ' sel' : ''}" data-act="track:online:${r.id}">${esc(r.name)}</button>`).join('')}</div></div>`
        : `<div class="row"><span class="label">Track</span><b>${esc(trackRef.name)}</b></div>`
    const phase = L.phase === 'racing' ? '<p class="note">A race is in progress. You will join the next one.</p>' : ''
    const results = n.results ? this.onlineTable(n.results) : ''
    const ready = me ? `<button type="button" class="btn${me.ready ? '' : ' primary'}" data-act="onReady">${me.ready ? 'Not ready' : 'Ready'}</button>` : '<span class="muted">Spectating — all three seats are taken.</span>'
    const start = n.isHost ? `<button type="button" class="btn primary" data-act="onStart"${L.phase !== 'lobby' ? ' disabled' : ''}>Start race</button>` : '<span class="muted">The host starts the race.</span>'
    const focusedAct = (document.activeElement as HTMLElement | null)?.dataset?.act
    lobby.innerHTML = `
      <div class="room"><span>Room</span><b>${esc(L.room)}</b><button type="button" class="btn small" data-act="onInvite">Copy invite link</button><small>Ping ${n.latency} ms</small></div>
      <div class="seats">${seats}</div>
      ${tracks}${phase}${results}
      <div class="row">${ready}${start}</div>`
    if (focusedAct && this.screen === 'online') lobby.querySelector<HTMLElement>(`[data-act="${focusedAct}"]`)?.focus({ preventScroll: true })
  }

  private onlineTable(rows: OnlineResult[]): string {
    const body = rows
      .map(r => `<tr class="${r.seat === this.net.seat ? 'me' : ''}"><td>${r.finished ? ordinal(r.place) : 'DNF'}</td><td>${esc(r.name)}</td><td>${r.finished ? formatTime(r.total) : `${r.gates}/${TOTAL_GATES} gates`}</td><td>${r.penalty ? `+${r.penalty.toFixed(1)}s` : ''}</td><td>${r.bestLap ? formatTime(r.bestLap) : '—'}</td></tr>`)
      .join('')
    return `<div class="mini-results"><h3>Last race</h3><table class="standings"><tr><th></th><th>Racer</th><th>Total</th><th>Penalty</th><th>Best lap</th></tr>${body}</table></div>`
  }

  // ─── results ───────────────────────────────────────────────────────────

  showResults(rows: ResultRow[], cfg: RaceConfig, bests: BestFlags[]): void {
    this.lastResults = { rows, cfg }
    const humans = rows.filter(r => r.human).sort((a, b) => a.humanIndex - b.humanIndex)
    const lead = humans[0]
    const winner = rows[0]
    const headline =
      cfg.mode === 'test'
        ? lead.finished ? 'Test drive complete' : 'Out of time'
        : cfg.mode === 'split'
          ? `${esc(winner.name)} wins!`
          : lead.finished ? (lead.place === 1 ? 'Victory!' : `You finished ${ordinal(lead.place)}`) : 'Did not finish'
    const table = rows
      .map(r => {
        const liv = LIVERIES[r.livery]
        return `<tr class="${r.human ? 'me' : ''}"><td class="pl">${r.finished ? ordinal(r.place) : 'DNF'}</td><td><i class="dot" style="--a:${liv.primary}"></i>${esc(r.name)}${r.human && r.assisted ? ASSIST_TAG : ''} <small>${esc(CHASSIS[r.chassis].name)}</small></td><td>${r.finished ? formatTime(r.total) : `${r.gates}/${TOTAL_GATES}`}</td><td>${r.penalty ? `+${r.penalty.toFixed(1)}s` : '—'}</td><td>${r.bestLap ? formatTime(r.bestLap) : '—'}</td></tr>`
      })
      .join('')
    const recap = humans
      .map(h => {
        const s = h.stats
        const b = bests[h.humanIndex] ?? { total: false, lap: false, totalAssist: false, lapAssist: false }
        const laps = h.lapTimes.map((t, i) => `<span>Lap ${i + 1} · ${formatTime(t)}${h.lapAssist[i] ? ASSIST_TAG : ''}</span>`).join('')
        const badge = b.total ? ` <em class="new">NEW BEST</em>${b.totalAssist ? ASSIST_TAG : ''}` : b.lap ? ` <em class="new">BEST LAP</em>${b.lapAssist ? ASSIST_TAG : ''}` : h.assisted ? ASSIST_TAG : ''
        return `<div class="recap"><h3>${esc(h.name)}${badge}</h3>
          <div class="laps">${laps || '<span>No laps completed</span>'}</div>
          <div class="stats">
            <div><b>${s.launch === 'perfect' ? 'Perfect' : s.launch === 'early' ? 'Early' : 'Clean'}</b><small>Launch</small></div>
            <div><b>${s.driftBoosts}</b><small>Drift boosts</small></div>
            <div><b>${s.perfectPads}/${s.pads}</b><small>Perfect pads</small></div>
            <div><b>${s.tricks}</b><small>Tricks landed</small></div>
            <div><b>${s.draftTime.toFixed(1)}s</b><small>Slipstream</small></div>
            <div><b>${Math.round(s.topSpeed * 3.6)}</b><small>Top km/h</small></div>
            <div><b>${s.hits}</b><small>Hits taken</small></div>
            <div><b>${s.dodges + s.blocks}</b><small>Dodges & blocks</small></div>
            <div><b>${h.recoveries}${h.penalty ? ` (+${h.penalty.toFixed(0)}s)` : ''}</b><small>Resets &amp; respawns</small></div>
          </div></div>`
      })
      .join('')
    this.el('[data-r="body"]').innerHTML = `<h2>${headline}</h2><p class="sub">${esc(cfg.track.name)} · ${LAPS} laps · ${TOTAL_GATES} gates</p>
      <table class="standings"><tr><th></th><th>Racer</th><th>Total</th><th>Penalty</th><th>Best lap</th></tr>${table}</table>
      <div class="recaps">${recap}</div><p class="hint">Press <kbd>R</kbd> or <kbd>A</kbd> for an instant rematch.</p>`
    this.el('[data-r="edit"]').style.display = cfg.track.lab ? '' : 'none'
    this.el('[data-r="rematch"]').textContent = cfg.mode === 'test' ? 'Drive again' : 'Rematch'
    this.show('results')
  }

  showOnlineResults(rows: OnlineResult[], track: string, pending: boolean): void {
    const me = rows.find(r => r.seat === this.net.seat)
    const headline = pending ? 'Finished — waiting for the other racers…' : me ? (me.finished ? (me.place === 1 ? 'Ghost race won!' : `You finished ${ordinal(me.place)}`) : 'Did not finish') : 'Race over'
    const sub = pending ? 'Your run is being confirmed by the ghost service.' : 'Results confirmed by the ghost service.'
    this.el('[data-r="body"]').innerHTML = `<h2>${headline}</h2><p class="sub">${esc(this.app.refFromOnline(track).name)} · ${sub}</p>${rows.length ? this.onlineTable(rows) : ''}`
    this.el('[data-r="edit"]').style.display = 'none'
    this.el('[data-r="rematch"]').textContent = 'Back to lobby'
    this.show('results')
  }

  // ─── gamepad navigation ────────────────────────────────────────────────

  private focusables(): HTMLElement[] {
    const scope = this.modal ? this.root.querySelector(`[data-modal="${this.modal}"]`) : this.root.querySelector(`[data-screen="${this.screen}"]`)
    if (!scope) return []
    return [...scope.querySelectorAll<HTMLElement>('button:not([disabled]), input, select')].filter(e => e.offsetParent !== null)
  }

  frame(dt: number): void {
    this.navCooldown -= dt
    this.fx.update(Math.min(0.05, dt))
    if (this.screen === 'hud' || this.screen === 'boot') return
    const m = this.input.move
    const mag = Math.max(Math.abs(m.x), Math.abs(m.y))
    if (mag < 0.5) this.navCooldown = Math.min(this.navCooldown, 0)
    else if (this.navCooldown <= 0) {
      this.navCooldown = 0.2
      const active = document.activeElement as HTMLElement | null
      if (active instanceof HTMLInputElement && active.type === 'range' && Math.abs(m.x) > Math.abs(m.y)) {
        const step = Number(active.step) || 0.05
        active.value = String(Number(active.value) + Math.sign(m.x) * step)
        active.dispatchEvent(new Event('input', { bubbles: true }))
      } else this.moveFocus(m.x, m.y)
    }
    if (this.input.consume('confirm')) {
      this.audio.unlock()
      if (this.screen === 'title') this.act('enter')
      else (document.activeElement as HTMLElement | null)?.click()
    }
    if (this.input.consume('back')) {
      if (this.modal) this.act('closeModal')
      else if (['solo', 'split', 'lab'].includes(this.screen)) this.act('back')
      else if (this.screen === 'online') this.act('onBack')
      else if (this.screen === 'results') this.act('toGarage')
      else if (this.screen === 'pause') this.act('resume')
    }
  }

  private moveFocus(dx: number, dy: number): void {
    const list = this.focusables()
    if (!list.length) return
    const cur = document.activeElement as HTMLElement | null
    if (!cur || !list.includes(cur)) {
      list[0].focus()
      return
    }
    const a = cur.getBoundingClientRect()
    const ax = a.left + a.width / 2
    const ay = a.top + a.height / 2
    const horiz = Math.abs(dx) > Math.abs(dy)
    const sx = Math.sign(dx)
    const sy = -Math.sign(dy)
    let best: HTMLElement | null = null
    let bestScore = Infinity
    for (const el of list) {
      if (el === cur) continue
      const r = el.getBoundingClientRect()
      const x = r.left + r.width / 2 - ax
      const y = r.top + r.height / 2 - ay
      const along = horiz ? x * sx : y * sy
      if (along <= 4) continue
      const score = along + (horiz ? Math.abs(y) : Math.abs(x)) * 2.2
      if (score < bestScore) {
        bestScore = score
        best = el
      }
    }
    if (best) {
      best.focus()
      this.audio.play('ui', 0.6)
      const r = best.getBoundingClientRect()
      this.fx.glint(r.right - 10, r.top + 8, '#fff4dc', 16)
      this.fx.ring(r.left + r.width / 2, r.top + r.height / 2, '#ffd23f', Math.max(40, r.width * 0.45), 0.35)
    }
  }
}
