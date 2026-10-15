import { sanitizeLab, type LabParams } from '../sim/tracks'

/**
 * Versioned local save. Settings, cosmetic choices, best times and Track Lab layouts live in
 * one JSON record. Corrupt or foreign data falls back to defaults instead of crashing.
 */
export type Quality = 'low' | 'medium' | 'high'
export type Device = 'auto' | 'kbLeft' | 'kbRight' | 'pad0' | 'pad1'
export type AiSkillSetting = 'relaxed' | 'pro'
export type AssistMode = 'off' | 'light' | 'strong'
/** `totalAssist` / `lapAssist` mark a best driven with corner assist on (a marker, not an invalidation). */
export type BestTime = { total: number; lap: number; totalAssist?: boolean; lapAssist?: boolean }

export type SaveData = {
  version: 2
  musicVolume: number
  sfxVolume: number
  muted: boolean
  quality: Quality
  reducedMotion: boolean
  cameraShake: boolean
  /** Corner assist strength for player 1 (solo, online, split-screen left). Strong by default. */
  assistP1: AssistMode
  /** Corner assist strength for player 2 in split-screen. */
  assistP2: AssistMode
  playerName: string
  chassis: number
  livery: number
  p2Chassis: number
  p2Livery: number
  p1Device: Device
  p2Device: Device
  aiSkill: AiSkillSetting
  items: boolean
  controlsSeen: boolean
  bests: Record<string, BestTime>
  customTracks: LabParams[]
}

export const SAVE_KEY = 'canyon-circuit.save'
export const MAX_CUSTOM_TRACKS = 12
export const CHASSIS_COUNT = 7
export const LIVERY_COUNT = 8

export function defaultSave(): SaveData {
  return {
    version: 2,
    musicVolume: 0.7,
    sfxVolume: 0.8,
    muted: false,
    quality: 'high',
    reducedMotion: false,
    cameraShake: true,
    assistP1: 'strong',
    assistP2: 'strong',
    playerName: 'RACER',
    chassis: 0,
    livery: 0,
    p2Chassis: 1,
    p2Livery: 2,
    p1Device: 'kbLeft',
    p2Device: 'kbRight',
    aiSkill: 'pro',
    items: true,
    controlsSeen: false,
    bests: {},
    customTracks: [],
  }
}

const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const index = (v: unknown, count: number, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < count ? v : fallback)
const DEVICES: Device[] = ['auto', 'kbLeft', 'kbRight', 'pad0', 'pad1']
const ASSIST_MODES: AssistMode[] = ['off', 'light', 'strong']
/** Valid mode, else migrate the old boolean `cornerAssist` (false -> off, otherwise strong). */
const assistMode = (v: unknown, legacy: unknown): AssistMode => (ASSIST_MODES.includes(v as AssistMode) ? (v as AssistMode) : legacy === false ? 'off' : 'strong')

/** Parse untrusted stored JSON into a valid SaveData (pure; unit tested). */
export function parseSave(raw: string | null): SaveData {
  const base = defaultSave()
  if (!raw) return base
  let data: Record<string, unknown>
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
    data = parsed as Record<string, unknown>
  } catch {
    return base
  }
  if (data.version !== 2) return base
  const bests: Record<string, BestTime> = {}
  if (data.bests && typeof data.bests === 'object' && !Array.isArray(data.bests)) {
    for (const [id, v] of Object.entries(data.bests as Record<string, unknown>).slice(0, 64)) {
      const b = v as BestTime
      if (typeof id === 'string' && id.length <= 40 && b && Number.isFinite(b.total) && b.total > 0 && Number.isFinite(b.lap) && b.lap >= 0) bests[id] = { total: b.total, lap: b.lap, ...(b.totalAssist === true ? { totalAssist: true } : {}), ...(b.lapAssist === true ? { lapAssist: true } : {}) }
    }
  }
  const tracks = Array.isArray(data.customTracks) ? data.customTracks.filter(t => t && typeof t === 'object').slice(0, MAX_CUSTOM_TRACKS).map(t => sanitizeLab(t as Partial<LabParams>)) : []
  return {
    version: 2,
    musicVolume: clamp01(data.musicVolume, base.musicVolume),
    sfxVolume: clamp01(data.sfxVolume, base.sfxVolume),
    muted: data.muted === true,
    quality: data.quality === 'low' || data.quality === 'medium' || data.quality === 'high' ? data.quality : base.quality,
    reducedMotion: data.reducedMotion === true,
    cameraShake: data.cameraShake !== false,
    assistP1: assistMode(data.assistP1, data.cornerAssist),
    assistP2: assistMode(data.assistP2, data.cornerAssist),
    playerName: typeof data.playerName === 'string' && data.playerName.trim() ? data.playerName.trim().replace(/[^\w .-]/g, '').slice(0, 14) || base.playerName : base.playerName,
    chassis: index(data.chassis, CHASSIS_COUNT, base.chassis),
    livery: index(data.livery, LIVERY_COUNT, base.livery),
    p2Chassis: index(data.p2Chassis, CHASSIS_COUNT, base.p2Chassis),
    p2Livery: index(data.p2Livery, LIVERY_COUNT, base.p2Livery),
    p1Device: DEVICES.includes(data.p1Device as Device) ? (data.p1Device as Device) : base.p1Device,
    p2Device: DEVICES.includes(data.p2Device as Device) ? (data.p2Device as Device) : base.p2Device,
    aiSkill: data.aiSkill === 'relaxed' ? 'relaxed' : 'pro',
    items: data.items !== false,
    controlsSeen: data.controlsSeen === true,
    bests,
    customTracks: tracks,
  }
}

/**
 * Returns the improved best record, or null when the run is not a new best. Each improved part
 * carries whether that run (total) or that lap was driven with assist on; kept parts keep their flag.
 */
export function improveBest(prev: BestTime | undefined, total: number, lap: number, totalAssist = false, lapAssist = false): BestTime | null {
  if (!(total > 0)) return null
  const newTotal = !prev || total < prev.total
  const newLap = lap > 0 && (!prev || !(prev.lap > 0) || lap < prev.lap)
  if (prev && !newTotal && !newLap) return null
  const next: BestTime = { total: newTotal ? total : prev!.total, lap: newLap ? lap : (prev?.lap ?? 0) }
  const ta = newTotal ? totalAssist : prev?.totalAssist === true
  const la = newLap ? lapAssist : prev?.lapAssist === true
  if (ta) next.totalAssist = true
  if (la) next.lapAssist = true
  return next
}

export class SaveStore {
  data: SaveData
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {
    let raw: string | null = null
    try {
      raw = this.storage?.getItem(SAVE_KEY) ?? null
    } catch {
      raw = null
    }
    this.data = parseSave(raw)
  }
  update(patch: Partial<SaveData>): void {
    this.data = { ...this.data, ...patch }
    try {
      this.storage?.setItem(SAVE_KEY, JSON.stringify(this.data))
    } catch {
      // Private browsing or quota: the game keeps working with in-memory settings.
    }
  }
}
