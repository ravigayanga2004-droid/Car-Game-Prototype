import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import type { Renderer, View } from '../engine/renderer'
import type { SaveStore } from '../engine/save'
import { improveBest, type AssistMode } from '../engine/save'
import type { AiSkill } from '../sim/ai'
import { hashString } from '../sim/math'
import type { GhostNet, RaceStart } from '../net/ghostnet'
import { Track } from '../sim/track'
import { CANYON_CIRCUIT, decodeLab, encodeLab, generateLabTrack, labId, type LabParams } from '../sim/tracks'
import { CarModel, CHASSIS, LIVERIES } from '../view/cars'
import { SUN_DIR, TrackWorld } from '../view/world'
import { buildEnvironment } from '../view/materials'
import { assets, CAR_KEYS } from '../engine/assets'
import { Session, type JuiceKind, type Mode, type PopupKind, type RacerSpec, type ResultRow } from './session'
import { tuning } from './tuning'

/** Per human: whether this run set a new best total / best lap, and whether assist was on for it. */
export interface BestFlags { total: boolean; lap: boolean; totalAssist: boolean; lapAssist: boolean }
export interface TrackRef {
  id: string
  name: string
  lab?: LabParams
}

export interface RaceConfig {
  mode: Mode
  track: TrackRef
  items: boolean
  aiSkill: AiSkill
}

export interface AppHooks {
  popup(view: number, text: string, kind: PopupKind): void
  finished(results: ResultRow[], cfg: RaceConfig, bests: BestFlags[]): void
  loading(text: string | null): void
  localFinished(view: number): void
  juice?(view: number, kind: JuiceKind, value?: number): void
}

const AI_NAMES = ['Vega', 'Juno', 'Sable', 'Rook', 'Mica']

export const MAIN_TRACK: TrackRef = { id: 'canyon-circuit', name: 'Canyon Charge' }

export class App {
  session: Session | null = null
  config: RaceConfig | null = null
  mode: 'menu' | 'race' | 'paused' | 'results' = 'menu'
  private readonly worlds = new Map<string, { track: Track; world: TrackWorld }>()
  private garageWorld: TrackWorld | null = null
  private garageCar: CarModel | null = null
  private readonly garageCam = new THREE.PerspectiveCamera(42, 1, 0.3, 4200)
  private garageTime = 0
  private garageKey = ''
  reducedMotion = false
  /** Corner assist per human player (P1 / solo / online, P2 in split-screen). */
  assistModes: [AssistMode, AssistMode] = ['strong', 'strong']
  private env: THREE.Texture | null = null

  constructor(
    readonly renderer: Renderer,
    readonly input: Input,
    readonly audio: Audio,
    readonly save: SaveStore,
    readonly net: GhostNet,
    private readonly hooks: AppHooks,
  ) {}

  // ─── tracks ────────────────────────────────────────────────────────────

  trackRefs(): TrackRef[] {
    return [MAIN_TRACK, ...this.save.data.customTracks.map(lab => ({ id: labId(lab), name: lab.name, lab }))]
  }

  /** Online rooms name tracks as 'main' or a Track Lab share code. */
  onlineCode(ref: TrackRef): string {
    return ref.lab ? encodeLab(ref.lab) : 'main'
  }

  refFromOnline(code: string): TrackRef {
    if (code === 'main') return MAIN_TRACK
    const lab = decodeLab(code)
    return lab ? { id: labId(lab), name: lab.name, lab } : MAIN_TRACK
  }

  private buildTrack(ref: TrackRef): Track {
    if (!ref.lab) return new Track(CANYON_CIRCUIT)
    return generateLabTrack(ref.lab).track
  }

  /** Get (or build) the world for a track; keeps the main circuit plus one custom world cached. */
  async worldFor(ref: TrackRef): Promise<{ track: Track; world: TrackWorld }> {
    const cached = this.worlds.get(ref.id)
    if (cached) return cached
    this.hooks.loading(`Carving ${ref.name}…`)
    await new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)))
    for (const [id, w] of this.worlds) {
      if (id !== MAIN_TRACK.id && id !== ref.id && w.world !== this.garageWorld) {
        w.world.dispose()
        this.worlds.delete(id)
      }
    }
    const track = this.buildTrack(ref)
    const world = new TrackWorld(track, this.renderer.shadowMapSize, this.renderer.shadowsEnabled)
    world.scene.environment = this.environment()
    world.scene.environmentIntensity = 0.8
    const entry = { track, world }
    this.worlds.set(ref.id, entry)
    // Compile shaders now so the first race frame does not hitch.
    this.renderer.gl.compile(world.scene, this.garageCam)
    this.hooks.loading(null)
    return entry
  }

  /** Soft image-based lighting from the sky panorama (rebuilt once the panorama streams in). */
  private environment(): THREE.Texture {
    if (this.env) return this.env
    this.env = buildEnvironment(this.renderer.gl, SUN_DIR)
    if (!assets.has('sky')) {
      void assets.whenSettled('sky').then(() => {
        const old = this.env
        this.env = buildEnvironment(this.renderer.gl, SUN_DIR)
        for (const w of this.worlds.values()) w.world.scene.environment = this.env
        old?.dispose()
      })
    }
    return this.env
  }

  /** Make sure the first race's assets are in; show a short recoverable loading state if not. */
  private async ensureRaceAssets(chassis: number[]): Promise<void> {
    assets.prioritize(chassis.map(c => `car:${CAR_KEYS[c] ?? CAR_KEYS[0]}`))
    if (assets.stageReady('race')) return
    const off = assets.onProgress((stage, done, total) => {
      if (stage === 'race') this.hooks.loading(`Loading race assets… ${Math.round((done / total) * 100)}%`)
    })
    const p = assets.progress('race')
    this.hooks.loading(`Loading race assets… ${Math.round((p.done / p.total) * 100)}%`)
    // Never hard-block: after 15 s the race starts with placeholders that swap in when ready.
    await Promise.race([assets.load('race'), new Promise(r => setTimeout(r, 15000))])
    off()
    this.hooks.loading(null)
    this.audio.warm()
  }

  // ─── garage ────────────────────────────────────────────────────────────

  async enterGarage(): Promise<void> {
    const { world } = await this.worldFor(MAIN_TRACK)
    this.garageWorld = world
    this.mode = 'menu'
    this.previewCar(this.save.data.chassis, this.save.data.livery)
  }

  previewCar(chassis: number, livery: number): void {
    const key = `${chassis}:${livery}`
    if (key === this.garageKey && this.garageCar) return
    this.garageKey = key
    assets.prioritize([`car:${CAR_KEYS[chassis] ?? CAR_KEYS[0]}`])
    if (this.garageCar) {
      this.garageWorld?.scene.remove(this.garageCar.root)
      this.garageCar.dispose()
    }
    this.garageCar = new CarModel(chassis, livery, false, '')
    this.garageCar.tag.visible = false
    const t = this.worlds.get(MAIN_TRACK.id)?.track
    if (t && this.garageWorld) {
      const f = { x: 0, y: 0, z: 0, tx: 0, tz: 1, rx: -1, rz: 0, halfW: 10, bank: 0 }
      t.frameAt(t.length - 22, f)
      this.garageCar.root.position.set(f.x, f.y, f.z)
      this.garageCar.root.userData.heading = Math.atan2(f.tx, f.tz)
      this.garageWorld.scene.add(this.garageCar.root)
    }
  }

  private hideGarageCar(): void {
    if (this.garageCar) this.garageCar.root.visible = false
  }

  // ─── races ─────────────────────────────────────────────────────────────

  private racers(mode: Mode): RacerSpec[] {
    const d = this.save.data
    const p1: RacerSpec = { name: d.playerName, chassis: d.chassis, livery: d.livery, human: true, device: mode === 'split' ? d.p1Device : 'auto' }
    if (mode === 'test' || mode === 'online') return [p1]
    const used = new Set([`${d.chassis}`])
    const usedLiv = new Set([d.livery])
    const list: RacerSpec[] = [p1]
    if (mode === 'split') {
      list.push({ name: 'Player 2', chassis: d.p2Chassis, livery: d.p2Livery, human: true, device: d.p2Device })
      used.add(`${d.p2Chassis}`)
      usedLiv.add(d.p2Livery)
    }
    let k = 0
    while (list.length < 3) {
      const chassis = [...Array(CHASSIS.length).keys()].find(c => !used.has(`${c}`)) ?? k % CHASSIS.length
      const livery = [...Array(LIVERIES.length).keys()].find(l => !usedLiv.has(l)) ?? k % LIVERIES.length
      used.add(`${chassis}`)
      usedLiv.add(livery)
      list.push({ name: AI_NAMES[k % AI_NAMES.length], chassis, livery, human: false })
      k += 1
    }
    return list
  }

  async startRace(cfg: RaceConfig, online?: RaceStart): Promise<void> {
    this.endSession()
    this.config = cfg
    const racers = this.racers(cfg.mode)
    await this.ensureRaceAssets(racers.map(r => r.chassis))
    const { track, world } = await this.worldFor(cfg.track)
    this.hideGarageCar()
    // Preview Tweak: run-boundary parameters activate here; tuned gameplay makes the run unranked.
    tuning.activate('run')
    const seed = online ? online.seed : (hashString(`${cfg.track.id}:${Date.now()}`) % 100000) + 1
    this.session = new Session(
      { mode: cfg.mode, track, trackId: cfg.track.id, racers, items: cfg.items && cfg.mode !== 'online' && cfg.mode !== 'test', seed, aiSkill: cfg.aiSkill, online: online ? this.net : undefined },
      world,
      this.input,
      this.audio,
      {
        popup: (v, text, kind) => this.hooks.popup(v, text, kind),
        finished: rows => this.onFinished(rows),
        localFinished: v => this.hooks.localFinished(v),
        juice: (v, kind, value) => this.hooks.juice?.(v, kind, value),
      },
    )
    this.session.reducedMotion = this.reducedMotion
    this.session.assistModes[0] = this.assistModes[0]
    this.session.assistModes[1] = this.assistModes[1]
    this.mode = 'race'
    this.input.gameplayActive = true
    // A pause key pressed in the menus (e.g. Esc to close Settings) must not pause the new race.
    this.input.consume('pause')
    this.audio.setMusic('race')
  }

  private onFinished(rows: ResultRow[]): void {
    const cfg = this.config
    if (!cfg) return
    this.mode = 'results'
    this.input.gameplayActive = false
    const bests: BestFlags[] = []
    const all = { ...this.save.data.bests }
    let changed = false
    for (const r of rows) {
      if (!r.human || tuning.unranked) continue
      const prev = all[cfg.track.id]
      const lapAssisted = r.bestLap > 0 && r.lapAssist[r.lapTimes.indexOf(r.bestLap)] === true
      const next = r.finished ? improveBest(prev, r.total, r.bestLap, r.assisted, lapAssisted) : null
      bests[r.humanIndex] = {
        total: !!next && (!prev || next.total < prev.total),
        lap: !!next && (!prev || (r.bestLap > 0 && next.lap < prev.lap)),
        totalAssist: r.assisted,
        lapAssist: lapAssisted,
      }
      if (next) {
        all[cfg.track.id] = next
        changed = true
      }
    }
    if (changed) this.save.update({ bests: all })
    this.audio.setMusic('results')
    this.hooks.finished(rows, cfg, bests)
  }

  endSession(): void {
    if (this.session) {
      this.session.dispose()
      this.session = null
    }
    this.input.gameplayActive = false
  }

  async rematch(): Promise<void> {
    if (this.config && this.config.mode !== 'online') await this.startRace(this.config)
  }

  toGarage(): void {
    this.endSession()
    this.mode = 'menu'
    this.audio.setMusic('menu')
    if (this.garageCar) this.garageCar.root.visible = true
    void this.enterGarage()
  }

  pause(): void {
    if (this.mode !== 'race' || !this.session) return
    this.mode = 'paused'
    this.session.paused = true
    this.input.gameplayActive = false
  }

  resume(): void {
    if (this.mode !== 'paused' || !this.session) return
    this.mode = 'race'
    this.session.paused = false
    this.input.gameplayActive = true
  }

  // ─── loop ──────────────────────────────────────────────────────────────

  step(): void {
    const s = this.session
    if (!s) return
    // Online races keep running while the menu is open (inputs are idle).
    if (this.mode === 'race' || this.mode === 'results' || (this.mode === 'paused' && s.online)) {
      if (this.mode === 'paused' && s.online) s.paused = true
      s.step()
    }
  }

  render(alpha: number, dt: number): void {
    const s = this.session
    if (s) {
      const views = s.render(alpha, dt)
      this.renderer.render(this.worldOf(s), views)
      return
    }
    const world = this.garageWorld
    if (!world) return
    this.garageTime += dt
    const car = this.garageCar
    if (car) {
      const t = this.garageTime
      const heading = (car.root.userData.heading as number) ?? 0
      car.pose(car.root.position.x, car.root.position.y, car.root.position.z, heading + t * 0.35, null, dt, t, 0, 0)
      const r = 8.2
      const a = heading + Math.PI * 0.8
      const p = car.root.position
      this.garageCam.position.set(p.x + Math.sin(a) * r, p.y + 2.6, p.z + Math.cos(a) * r)
      this.garageCam.lookAt(p.x - Math.sin(a) * 1.5, p.y + 0.9, p.z - Math.cos(a) * 1.5)
      world.focus(p.x, p.y, p.z)
    }
    world.setHighlight(-1)
    world.update(this.garageTime)
    const view: View = { camera: this.garageCam, x: 0, y: 0, w: 1, h: 1 }
    this.renderer.render(world.scene, [view])
  }

  private worldOf(s: Session): THREE.Scene {
    const w = this.worlds.get(s.trackId)
    return (w?.world ?? this.garageWorld!).scene
  }

  setQuality(): void {
    // Shadows/bloom are applied by the renderer; rebuild worlds so shadow maps match.
    for (const w of this.worlds.values()) {
      w.world.sun.castShadow = this.renderer.shadowsEnabled
      w.world.sun.shadow.map?.dispose()
      w.world.sun.shadow.map = null
      w.world.sun.shadow.mapSize.set(this.renderer.shadowMapSize, this.renderer.shadowMapSize)
    }
  }
}
