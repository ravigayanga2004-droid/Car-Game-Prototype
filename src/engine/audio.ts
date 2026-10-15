import { assets } from './assets'

/**
 * Web Audio mixer: music and SFX buses into a limiter.
 * - SFX are generated samples streamed by the asset store (decoded on first use); any cue whose
 *   sample is not ready yet falls back to a tiny synthesized version, so audio never blocks.
 * - Engine voices layer a pitched engine loop, tyre-skid loop and wind loop per car.
 * - Music streams through media elements (never preloaded) with crossfades between the title,
 *   race, final-lap and results themes.
 * Bus gains follow the project's mix rule (music ×3, SFX ×2 over 0.55 / 0.8 bases) with a
 * brick-wall compressor guarding the 0 dBFS ceiling.
 */
export type Sfx =
  | 'ui' | 'confirm' | 'back' | 'count' | 'go' | 'gate' | 'lap' | 'finalLap' | 'finish' | 'pad' | 'padPerfect'
  | 'boost' | 'driftTier' | 'item' | 'box' | 'seeker' | 'warn' | 'lock' | 'hit' | 'shield' | 'blocked' | 'mine'
  | 'trick' | 'trickLand' | 'crash' | 'land' | 'wall' | 'bump' | 'recover' | 'wrong' | 'launchPerfect' | 'launchEarly'
  | 'draft' | 'dodge' | 'canister' | 'fizzle' | 'overtake' | 'style' | 'wreck' | 'crunch' | 'ignite' | 'nitro' | 'nitroReady' | 'nitroDenied' | 'cork'

export type MusicMode = 'off' | 'menu' | 'race' | 'final' | 'results'

const MUSIC_BASE = 0.55 * 3
const SFX_BASE = 0.8 * 2

/** Cue → [sample, gain, playbackRate]. Missing entries use the synth fallback only. */
const SAMPLES: Partial<Record<Sfx, [string, number, number][]>> = {
  ui: [['ui-hover', 0.35, 1]],
  confirm: [['ui-click', 0.55, 1]],
  back: [['ui-back', 0.5, 1]],
  count: [['count', 0.7, 1]],
  go: [['go', 0.8, 1]],
  gate: [['gate', 0.42, 1]],
  lap: [['lap', 0.6, 1]],
  finalLap: [['finallap', 0.75, 1]],
  finish: [['finish', 0.8, 1]],
  pad: [['pad', 0.55, 1]],
  padPerfect: [['pad', 0.6, 1.12], ['tier', 0.4, 1.25]],
  boost: [['boost', 0.62, 1]],
  driftTier: [['tier', 0.45, 1]],
  item: [['pickup', 0.55, 1]],
  box: [['pickup', 0.35, 1.3]],
  seeker: [['launch', 0.6, 1]],
  warn: [['warn', 0.5, 1]],
  lock: [['warn', 0.6, 1.18]],
  hit: [['explode', 0.75, 1]],
  wreck: [['wreck', 1, 1], ['explode', 0.5, 0.7]],
  crunch: [['crunch', 0.85, 1]],
  ignite: [['ignite', 0.8, 1]],
  nitro: [['nitro', 0.95, 1]],
  nitroReady: [['nitro-ready', 0.55, 1]],
  nitroDenied: [['ui-back', 0.35, 0.8]],
  cork: [['cork', 0.8, 1]],
  shield: [['shield', 0.55, 1]],
  blocked: [['shield', 0.6, 1.35], ['wall', 0.35, 1.4]],
  mine: [['mine', 0.55, 1]],
  trick: [['style', 0.3, 1.25]],
  trickLand: [['style', 0.55, 1], ['land', 0.4, 1]],
  crash: [['wall', 0.6, 0.72], ['land', 0.5, 0.8]],
  land: [['land', 0.55, 1]],
  wall: [['wall', 0.55, 1]],
  bump: [['wall', 0.35, 1.25]],
  recover: [['recover', 0.55, 1]],
  launchPerfect: [['boost', 0.6, 1.1], ['tier', 0.45, 1.4]],
  dodge: [['style', 0.4, 1.45]],
  canister: [['boost', 0.55, 0.9]],
  overtake: [['overtake', 0.55, 1]],
  style: [['style', 0.5, 1]],
}

export class EngineVoice {
  private readonly osc: OscillatorNode
  private readonly sub: OscillatorNode
  private readonly filter: BiquadFilterNode
  private readonly gain: GainNode
  private readonly pan: StereoPannerNode
  private readonly loops: { key: string; src: AudioBufferSourceNode | null; gain: GainNode }[]
  private stopped = false

  constructor(private readonly audio: Audio, out: AudioNode, private readonly level = 1) {
    const ctx = audio.ctx
    this.pan = ctx.createStereoPanner()
    this.pan.connect(out)
    // Quiet synth body underneath the sampled loop keeps pitch movement readable.
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.filter = ctx.createBiquadFilter()
    this.filter.type = 'lowpass'
    this.filter.frequency.value = 600
    this.filter.Q.value = 3
    this.osc = ctx.createOscillator()
    this.osc.type = 'sawtooth'
    this.sub = ctx.createOscillator()
    this.sub.type = 'square'
    this.osc.connect(this.filter)
    this.sub.connect(this.filter)
    this.filter.connect(this.gain).connect(this.pan)
    this.osc.start()
    this.sub.start()
    this.loops = ['engine-loop', 'skid-loop', 'wind-loop'].map(key => {
      const gain = ctx.createGain()
      gain.gain.value = 0
      gain.connect(this.pan)
      return { key, src: null, gain }
    })
  }

  private ensureLoops(): void {
    for (const l of this.loops) {
      if (l.src) continue
      const buf = this.audio.buffer(l.key)
      if (!buf) continue
      const src = this.audio.ctx.createBufferSource()
      src.buffer = buf
      src.loop = true
      src.connect(l.gain)
      src.start(this.audio.ctx.currentTime, Math.random() * buf.duration)
      l.src = src
    }
  }

  /** speed in m/s, throttle 0..1. */
  update(speed: number, throttle: number, boost: boolean, drift: boolean, grounded: boolean, pan = 0, volume = 1): void {
    if (this.stopped) return
    this.ensureLoops()
    const ctx = this.audio.ctx
    const t = ctx.currentTime
    const v = Math.max(0, speed)
    // Fake gearbox: rpm climbs within each gear band.
    const gear = Math.min(5, Math.floor(v / 15))
    const within = (v - gear * 15) / 15
    const rpm = 0.25 + within * 0.6 + gear * 0.05 + throttle * 0.08 + (grounded ? 0 : 0.2)
    const f = 55 + rpm * 150
    this.osc.frequency.setTargetAtTime(f, t, 0.05)
    this.sub.frequency.setTargetAtTime(f / 2, t, 0.05)
    this.filter.frequency.setTargetAtTime(300 + rpm * 900 + (boost ? 600 : 0), t, 0.06)
    const sampled = this.loops[0].src !== null
    const lv = this.level * volume
    this.gain.gain.setTargetAtTime((sampled ? 0.018 : 0.06 + throttle * 0.05) * lv, t, 0.06)
    const [eng, skid, wind] = this.loops
    if (eng.src) {
      eng.src.playbackRate.setTargetAtTime(0.62 + rpm * 0.95 + (boost ? 0.08 : 0), t, 0.05)
      eng.gain.gain.setTargetAtTime((0.22 + throttle * 0.16 + (boost ? 0.08 : 0)) * lv, t, 0.06)
    }
    if (skid.src) skid.gain.gain.setTargetAtTime(drift && grounded && v > 6 ? 0.26 * lv : 0, t, 0.05)
    if (wind.src) {
      wind.src.playbackRate.setTargetAtTime(0.8 + Math.min(0.6, v / 120), t, 0.1)
      wind.gain.gain.setTargetAtTime((Math.min(0.2, v / 320) + (boost ? 0.14 : 0)) * lv, t, 0.08)
    }
    this.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), t, 0.1)
  }

  silence(): void {
    const t = this.audio.ctx.currentTime
    this.gain.gain.setTargetAtTime(0, t, 0.05)
    for (const l of this.loops) l.gain.gain.setTargetAtTime(0, t, 0.05)
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    this.silence()
    const t = this.audio.ctx.currentTime + 0.3
    this.osc.stop(t)
    this.sub.stop(t)
    for (const l of this.loops) l.src?.stop(t)
    window.setTimeout(() => this.pan.disconnect(), 500)
  }
}

export class Audio {
  readonly ctx: AudioContext
  private readonly master: GainNode
  private readonly limiter: DynamicsCompressorNode
  private readonly music: GainNode
  readonly sfx: GainNode
  readonly noise: AudioBuffer
  private readonly lastPlay = new Map<Sfx, number>()
  private readonly buffers = new Map<string, AudioBuffer>()
  private readonly decoding = new Set<string>()
  private musicMode: MusicMode = 'off'
  private readonly decks: { el: HTMLAudioElement; gain: GainNode; mode: MusicMode }[] = []
  private deck = 0

  constructor() {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.9
    this.limiter = this.ctx.createDynamicsCompressor()
    this.limiter.threshold.value = -4
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.2
    this.music = this.ctx.createGain()
    this.sfx = this.ctx.createGain()
    this.music.connect(this.master)
    this.sfx.connect(this.master)
    this.master.connect(this.limiter).connect(this.ctx.destination)
    const len = this.ctx.sampleRate * 2
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    let seed = 12345
    for (let i = 0; i < len; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      data[i] = (seed / 4294967296) * 2 - 1
    }
  }

  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    // Resume a deck whose play() was rejected before the first gesture.
    const d = this.decks[this.deck]
    if (d && this.musicMode !== 'off' && d.el.paused) void d.el.play().catch(() => {})
  }

  /** Volumes in 0..1. */
  setVolumes(music: number, sfx: number, muted = false): void {
    const t = this.ctx.currentTime
    this.music.gain.setTargetAtTime(muted ? 0 : music * MUSIC_BASE * 0.42, t, 0.05)
    this.sfx.gain.setTargetAtTime(muted ? 0 : sfx * SFX_BASE, t, 0.05)
  }

  engine(level = 1): EngineVoice {
    return new EngineVoice(this, this.sfx, level)
  }

  /** Decoded sample buffer, decoding lazily from the asset store (null until ready). */
  buffer(key: string): AudioBuffer | null {
    const b = this.buffers.get(key)
    if (b) return b
    if (this.decoding.has(key)) return null
    const raw = assets.audio.get(key)
    if (!raw) return null
    this.decoding.add(key)
    void this.ctx.decodeAudioData(raw.slice(0)).then(buf => { this.buffers.set(key, buf) }).catch(() => {})
    return null
  }

  /** Decode everything already downloaded (called after stage loads, off the hot path). */
  warm(): void {
    for (const k of assets.audio.keys()) this.buffer(k)
  }

  private sample(key: string, vol: number, rate: number): boolean {
    const buf = this.buffer(key)
    if (!buf) return false
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate * (0.97 + Math.random() * 0.06)
    const g = this.ctx.createGain()
    g.gain.value = vol
    src.connect(g).connect(this.sfx)
    src.start()
    return true
  }

  play(name: Sfx, volume = 1): void {
    if (this.ctx.state !== 'running') return
    const now = this.ctx.currentTime
    if (now - (this.lastPlay.get(name) ?? -1) < 0.05) return
    this.lastPlay.set(name, now)
    const layers = SAMPLES[name]
    let ok = false
    if (layers) for (const [key, g, r] of layers) ok = this.sample(key, g * volume, r) || ok
    if (!ok) this.synth(name, volume)
  }

  private tone(freq: number, end: number, dur: number, type: OscillatorType, vol: number, delay = 0, dest: AudioNode = this.sfx): void {
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(end, 20), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(dest)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private burst(dur: number, freq: number, q: number, vol: number, delay = 0, type: BiquadFilterType = 'bandpass', sweepTo = 0): void {
    const t = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.setValueAtTime(freq, t)
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur)
    f.Q.value = q
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(this.sfx)
    src.start(t, Math.random() * 1.5)
    src.stop(t + dur + 0.05)
  }

  /** Synthesized fallback for cues whose sample has not streamed in (or has none). */
  private synth(name: Sfx, volume: number): void {
    const v = volume
    switch (name) {
      case 'ui': this.tone(660, 720, 0.06, 'triangle', 0.14 * v); break
      case 'confirm': this.tone(660, 990, 0.1, 'triangle', 0.2 * v); this.tone(990, 1320, 0.12, 'sine', 0.14 * v, 0.05); break
      case 'back': this.tone(520, 380, 0.1, 'triangle', 0.16 * v); break
      case 'count': this.tone(620, 620, 0.18, 'square', 0.12 * v); break
      case 'go': this.tone(1240, 1240, 0.45, 'square', 0.14 * v); this.tone(620, 620, 0.45, 'triangle', 0.16 * v); break
      case 'gate': this.tone(1320, 1580, 0.09, 'sine', 0.13 * v); break
      case 'lap': [784, 988, 1175].forEach((f, i) => this.tone(f, f, 0.16, 'triangle', 0.18 * v, i * 0.08)); break
      case 'finalLap': [784, 988, 1175, 1568].forEach((f, i) => this.tone(f, f, 0.2, 'square', 0.12 * v, i * 0.09)); break
      case 'finish': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, f * 1.01, 0.4, 'triangle', 0.2 * v, i * 0.1)); break
      case 'pad': this.burst(0.35, 800, 1, 0.22 * v, 0, 'bandpass', 3200); this.tone(300, 900, 0.25, 'sawtooth', 0.06 * v); break
      case 'padPerfect': this.burst(0.45, 900, 1, 0.26 * v, 0, 'bandpass', 4200); this.tone(440, 1320, 0.3, 'sawtooth', 0.08 * v); this.tone(1760, 2093, 0.18, 'sine', 0.14 * v, 0.08); break
      case 'boost': this.burst(0.5, 600, 0.9, 0.24 * v, 0, 'bandpass', 2600); this.tone(180, 520, 0.35, 'sawtooth', 0.08 * v); break
      case 'driftTier': this.tone(900, 1400, 0.1, 'square', 0.08 * v); break
      case 'item': [880, 1175, 1568].forEach((f, i) => this.tone(f, f, 0.08, 'triangle', 0.14 * v, i * 0.05)); break
      case 'box': this.tone(1568, 2349, 0.12, 'sine', 0.12 * v); this.burst(0.12, 5000, 2, 0.08 * v); break
      case 'seeker': this.tone(300, 1200, 0.3, 'sawtooth', 0.09 * v); this.burst(0.4, 1500, 1, 0.12 * v); break
      case 'warn': this.tone(880, 880, 0.09, 'square', 0.1 * v); this.tone(880, 880, 0.09, 'square', 0.1 * v, 0.14); break
      case 'lock': [1320, 1320, 1320].forEach((f, i) => this.tone(f, f, 0.06, 'square', 0.12 * v, i * 0.09)); break
      case 'hit': this.burst(0.6, 300, 0.7, 0.35 * v, 0, 'lowpass', 80); this.tone(160, 40, 0.5, 'sine', 0.35 * v); break
      case 'shield': this.tone(400, 1200, 0.35, 'sine', 0.16 * v); this.tone(600, 1800, 0.35, 'triangle', 0.08 * v, 0.05); break
      case 'blocked': this.tone(1800, 900, 0.3, 'triangle', 0.2 * v); this.burst(0.25, 3000, 1.5, 0.15 * v); break
      case 'mine': this.tone(260, 200, 0.14, 'square', 0.1 * v); break
      case 'trick': this.tone(700, 1400, 0.12, 'triangle', 0.14 * v); break
      case 'trickLand': [988, 1319, 1760].forEach((f, i) => this.tone(f, f, 0.1, 'sine', 0.16 * v, i * 0.05)); this.burst(0.4, 700, 1, 0.2 * v, 0, 'bandpass', 2800); break
      case 'nitro': this.burst(0.9, 900, 0.6, 0.4 * v, 0, 'bandpass', 3); this.tone(180, 620, 0.5, 'sawtooth', 0.12 * v); break
      case 'nitroReady': this.tone(880, 1320, 0.12, 'sine', 0.18 * v); break
      case 'nitroDenied': this.tone(220, 160, 0.12, 'square', 0.08 * v); break
      case 'cork': this.burst(1.6, 500, 1.2, 0.3 * v, 0, 'bandpass', 2); break
      case 'wreck': this.burst(1.1, 260, 0.9, 0.45 * v, 0, 'lowpass', 60); this.tone(90, 30, 0.9, 'sine', 0.4 * v); break
      case 'crunch': this.burst(0.3, 900, 0.5, 0.3 * v, 0, 'bandpass', 400); break
      case 'ignite': this.burst(0.9, 1400, 0.4, 0.22 * v, 0, 'bandpass', 900); break
      case 'crash': this.burst(0.5, 400, 0.6, 0.32 * v, 0, 'lowpass', 90); this.tone(120, 50, 0.4, 'sine', 0.3 * v); break
      case 'land': this.tone(140, 60, 0.18, 'sine', 0.28 * v); this.burst(0.2, 300, 0.8, 0.14 * v, 0, 'lowpass'); break
      case 'wall': this.burst(0.25, 1800, 1.2, 0.2 * v, 0, 'bandpass', 600); this.tone(110, 60, 0.15, 'sine', 0.2 * v); break
      case 'bump': this.tone(180, 90, 0.12, 'sine', 0.24 * v); this.burst(0.12, 900, 1, 0.12 * v); break
      case 'recover': this.tone(440, 880, 0.35, 'sine', 0.14 * v); this.tone(660, 1320, 0.35, 'sine', 0.08 * v, 0.1); break
      case 'wrong': this.tone(330, 300, 0.25, 'square', 0.1 * v); break
      case 'launchPerfect': this.burst(0.6, 700, 0.9, 0.26 * v, 0, 'bandpass', 3000); [1047, 1319, 1568].forEach((f, i) => this.tone(f, f, 0.12, 'triangle', 0.16 * v, i * 0.06)); break
      case 'launchEarly': this.burst(0.7, 2200, 3, 0.16 * v); this.tone(200, 160, 0.5, 'sawtooth', 0.06 * v); break
      case 'draft': this.burst(0.5, 400, 0.7, 0.16 * v, 0, 'bandpass', 1600); break
      case 'dodge': this.tone(900, 1600, 0.15, 'triangle', 0.15 * v); break
      case 'canister': this.tone(300, 1500, 0.4, 'triangle', 0.14 * v); break
      case 'fizzle': this.burst(0.3, 2000, 1, 0.1 * v, 0, 'bandpass', 300); break
    }
  }

  // ─── Streamed music ────────────────────────────────────────────────────
  setMusic(mode: MusicMode): void {
    if (mode === this.musicMode) return
    this.musicMode = mode
    const t = this.ctx.currentTime
    const cur = this.decks[this.deck]
    if (cur) {
      cur.gain.gain.cancelScheduledValues(t)
      cur.gain.gain.setTargetAtTime(0, t, mode === 'final' ? 0.25 : 0.5)
      const el = cur.el
      window.setTimeout(() => { if (this.decks[this.deck]?.el !== el) el.pause() }, 2500)
    }
    if (mode === 'off') return
    const file = { menu: 'm-title', race: 'm-race', final: 'm-final', results: 'm-results' }[mode]
    this.deck = (this.deck + 1) % 2
    let d = this.decks[this.deck]
    if (!d) {
      const el = new window.Audio()
      el.preload = 'none'
      el.crossOrigin = 'anonymous'
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      this.ctx.createMediaElementSource(el).connect(gain).connect(this.music)
      d = { el, gain, mode }
      this.decks[this.deck] = d
    }
    d.mode = mode
    d.el.loop = mode !== 'results'
    d.el.src = `${import.meta.env.BASE_URL}assets/audio/${file}.mp3`
    d.el.currentTime = 0
    d.gain.gain.cancelScheduledValues(t)
    d.gain.gain.setValueAtTime(0, t)
    d.gain.gain.setTargetAtTime(1, t + 0.05, mode === 'final' ? 0.2 : 0.6)
    void d.el.play().catch(() => {})
  }
}
