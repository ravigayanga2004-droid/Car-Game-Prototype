import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * Staged asset store. Nothing here touches gameplay: the simulation never waits on assets.
 *
 * - `boot`  : title essentials (UI blips). Loaded before the title screen appears.
 * - `race`  : everything the first race needs (terrain/road PBR maps, sky, particle atlas, cars,
 *             race SFX). Starts immediately in the background while the player browses menus;
 *             a race start awaits it behind a short, recoverable loading overlay.
 * - `extra` : set dressing and rare cues (gantry, light towers, item icons). Prefetched with
 *             spare bandwidth and paused while a race is heating up.
 * Music is never preloaded: tracks stream through media elements.
 */
export type Stage = 'boot' | 'race' | 'extra'
type Kind = 'tex' | 'srgb' | 'model' | 'audio' | 'image'
interface Entry { key: string; url: string; kind: Kind; stage: Stage }

const BASE = `${import.meta.env.BASE_URL}assets/`
const TEX_SETS = ['cliff', 'sand', 'asphalt', 'sandstone', 'rocks']
export const CAR_KEYS = ['mesa', 'dune', 'arroyo', 'sidewinder', 'longhorn', 'stingbolt', 'scorchquill']
const RACE_SFX = ['engine-loop', 'skid-loop', 'wind-loop', 'count', 'go', 'gate', 'lap', 'finallap', 'finish', 'boost', 'pad', 'tier', 'land', 'wall', 'overtake', 'style', 'pickup', 'launch', 'warn', 'explode', 'mine', 'shield', 'recover', 'wreck', 'crunch', 'ignite', 'nitro', 'nitro-ready', 'cork']

function manifest(): Entry[] {
  const list: Entry[] = []
  const add = (key: string, url: string, kind: Kind, stage: Stage) => list.push({ key, url: BASE + url, kind, stage })
  for (const s of ['ui-hover', 'ui-click', 'ui-back']) add(`sfx:${s}`, `audio/${s}.mp3`, 'audio', 'boot')
  add('fx', 'fx/atlas.png', 'srgb', 'race')
  add('sky', 'sky/sky.jpg', 'srgb', 'race')
  for (const set of TEX_SETS) {
    add(`${set}_diff`, `tex/${set}_diff.jpg`, 'srgb', 'race')
    add(`${set}_nor`, `tex/${set}_nor.jpg`, 'tex', 'race')
    add(`${set}_arm`, `tex/${set}_arm.jpg`, 'tex', 'race')
  }
  for (const c of CAR_KEYS) add(`car:${c}`, `models/${c}.glb`, 'model', 'race')
  for (const k of ['boulder', 'spire', 'saguaro']) add(`prop:${k}`, `models/${k}.glb`, 'model', 'race')
  for (const k of ['seeker', 'mine']) add(`prop:${k}`, `models/${k}.glb`, 'model', 'extra')
  for (const s of RACE_SFX) add(`sfx:${s}`, `audio/${s}.mp3`, 'audio', 'race')
  add('model:gantry', 'models/gantry.glb', 'model', 'extra')
  add('model:tower', 'models/tower.glb', 'model', 'extra')
  for (const i of ['seeker', 'mine', 'shield']) add(`icon:${i}`, `ui/icon-${i}.webp`, 'image', 'extra')
  return list
}

type Listener = (stage: Stage, done: number, total: number) => void

export class Assets {
  readonly textures = new Map<string, THREE.Texture>()
  readonly models = new Map<string, GLTF>()
  readonly audio = new Map<string, ArrayBuffer>()
  readonly images = new Map<string, HTMLImageElement>()
  private readonly entries = manifest()
  private readonly state = new Map<string, 'queued' | 'loading' | 'done' | 'failed'>()
  private readonly waiters = new Map<string, Array<() => void>>()
  private readonly listeners = new Set<Listener>()
  private readonly texLoader = new THREE.TextureLoader()
  private readonly gltf = new GLTFLoader()
  private active = 0
  private busy = false
  private priority: string[] = []
  /** Stages allowed to download right now (extra only in calm moments). */
  private readonly open = new Set<Stage>(['boot'])
  maxAnisotropy = 4

  constructor() {
    for (const e of this.entries) this.state.set(e.key, 'queued')
  }

  onProgress(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  has(key: string): boolean {
    return this.state.get(key) === 'done'
  }

  tex(key: string): THREE.Texture | undefined {
    return this.textures.get(key)
  }

  progress(stage: Stage): { done: number; total: number } {
    let done = 0
    let total = 0
    for (const e of this.entries) {
      if (e.stage !== stage) continue
      total += 1
      const s = this.state.get(e.key)
      if (s === 'done' || s === 'failed') done += 1
    }
    return { done, total }
  }

  stageReady(stage: Stage): boolean {
    const p = this.progress(stage)
    return p.done >= p.total
  }

  /** Load a stage (and every earlier stage). Resolves when all entries settle. */
  async load(stage: Stage): Promise<void> {
    const order: Stage[] = ['boot', 'race', 'extra']
    for (const s of order.slice(0, order.indexOf(stage) + 1)) this.open.add(s)
    this.pump()
    const keys = this.entries.filter(e => order.indexOf(e.stage) <= order.indexOf(stage)).map(e => e.key)
    await Promise.all(keys.map(k => this.whenSettled(k)))
  }

  /** Start a stage in the background without waiting. */
  prefetch(stage: Stage): void {
    this.open.add(stage)
    if (stage === 'extra') this.open.add('race')
    this.pump()
  }

  /** Move specific keys to the front of the queue (e.g. the garage car the player is viewing). */
  prioritize(keys: string[]): void {
    this.priority = [...keys, ...this.priority.filter(k => !keys.includes(k))]
    this.pump()
  }

  /** While busy (race heating up) only race-critical downloads continue, one at a time. */
  setBusy(busy: boolean): void {
    if (busy === this.busy) return
    this.busy = busy
    if (!busy) this.pump()
  }

  whenSettled(key: string): Promise<void> {
    const s = this.state.get(key)
    if (!s || s === 'done' || s === 'failed') return Promise.resolve()
    return new Promise(res => {
      const list = this.waiters.get(key) ?? []
      list.push(res)
      this.waiters.set(key, list)
    })
  }

  private next(): Entry | undefined {
    const queued = (e: Entry) => this.state.get(e.key) === 'queued' && this.open.has(e.stage) && !(this.busy && e.stage === 'extra')
    for (const k of this.priority) {
      const e = this.entries.find(x => x.key === k)
      if (e && this.state.get(e.key) === 'queued' && this.open.has(e.stage)) return e
    }
    for (const stage of ['boot', 'race', 'extra'] as Stage[]) {
      const e = this.entries.find(x => x.stage === stage && queued(x))
      if (e) return e
    }
    return undefined
  }

  private pump(): void {
    const limit = this.busy ? 1 : 4
    while (this.active < limit) {
      const e = this.next()
      if (!e) return
      this.active += 1
      this.state.set(e.key, 'loading')
      this.fetchOne(e)
        .then(() => this.state.set(e.key, 'done'))
        .catch(err => {
          console.warn(`[assets] ${e.key} failed`, err)
          this.state.set(e.key, 'failed')
        })
        .finally(() => {
          this.active -= 1
          for (const w of this.waiters.get(e.key) ?? []) w()
          this.waiters.delete(e.key)
          const p = this.progress(e.stage)
          for (const l of this.listeners) l(e.stage, p.done, p.total)
          this.pump()
        })
    }
  }

  private async fetchOne(e: Entry): Promise<void> {
    switch (e.kind) {
      case 'tex':
      case 'srgb': {
        const t = await this.texLoader.loadAsync(e.url)
        t.colorSpace = e.kind === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace
        t.wrapS = t.wrapT = e.key === 'sky' || e.key === 'fx' ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping
        if (e.key === 'sky') t.wrapS = THREE.RepeatWrapping
        t.anisotropy = e.key === 'fx' ? 1 : this.maxAnisotropy
        this.textures.set(e.key, t)
        return
      }
      case 'model': {
        const g = await this.gltf.loadAsync(e.url)
        this.models.set(e.key, g)
        return
      }
      case 'audio': {
        const res = await fetch(e.url)
        if (!res.ok) throw new Error(`${res.status}`)
        this.audio.set(e.key.slice(4), await res.arrayBuffer())
        return
      }
      case 'image': {
        const img = new Image()
        img.decoding = 'async'
        img.src = e.url
        await img.decode()
        this.images.set(e.key, img)
      }
    }
  }
}

export const assets = new Assets()
