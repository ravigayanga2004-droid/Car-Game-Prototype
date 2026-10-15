import type { OnlineLink } from '../game/session'
import { checksMatch, isRoomCode, PROTOCOL, type GhostFrame } from '../sim/netcodec'
import type { SimSnapshot } from '../sim/race'

/**
 * Client for the Canyon Circuit ghost service. The service owns rooms, seats, race start,
 * authoritative re-simulation of every racer's inputs, and results. This client only runs the
 * owner's local simulation, uploads its quantized inputs and presents other racers as ghosts.
 */
export type NetStatus = 'idle' | 'loading' | 'unavailable' | 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface LobbyPlayer { seat: number; name: string; chassis: number; livery: number; ready: boolean; connected: boolean }
export interface LobbyState {
  rev: number
  room: string
  phase: 'lobby' | 'racing' | 'results'
  host: number
  track: string
  players: LobbyPlayer[]
  raceId: number
  startAt: number
  spectators: number
}
export interface OnlineResult { seat: number; name: string; chassis: number; livery: number; place: number; finished: boolean; dnf: boolean; total: number; penalty: number; bestLap: number; gates: number; lapTimes: number[] }
export interface RaceStart { raceId: number; startAt: number; track: string; seats: number[]; seed: number }

type Bootstrap = { build: string; signalingUrl: string }

const TICK_MS = 1000 / 60
const RESUME_KEY = 'canyon-circuit.resume'

export class GhostNet implements OnlineLink {
  status: NetStatus = 'idle'
  message = ''
  room = ''
  seat = -1
  lobby: LobbyState | null = null
  results: OnlineResult[] | null = null
  race: RaceStart | null = null
  onChange: () => void = () => {}
  onRaceStart: (r: RaceStart) => void = () => {}
  onResults: (r: OnlineResult[]) => void = () => {}
  private ws: WebSocket | null = null
  private url = ''
  private offset = 0
  private rtt = 120
  private pingTimer = 0
  private flushTimer = 0
  private retryTimer = 0
  private retries = 0
  private wanted = false
  private profile = { name: 'Racer', chassis: 0, livery: 0 }
  private readonly inputs: number[] = []
  private sentUpTo = 0
  private readonly frames = new Map<number, GhostFrame[]>()
  private readonly checks = new Map<number, string>()
  private resync: SimSnapshot | null = null
  private lastResyncAsk = 0

  // ─── connection ──────────────────────────────────────────────────────

  private async discover(): Promise<Bootstrap | null> {
    try {
      const res = await fetch(new URL('multiplayer/bootstrap.json', document.baseURI).toString(), { cache: 'no-store' })
      if (!res.ok) return null
      const data = (await res.json()) as Partial<Bootstrap>
      if (typeof data.signalingUrl !== 'string' || !data.signalingUrl || data.build !== PROTOCOL) return null
      return { build: data.build, signalingUrl: data.signalingUrl }
    } catch {
      return null
    }
  }

  /** Join `room` (or create a new one when empty). */
  async connect(room: string, profile: { name: string; chassis: number; livery: number }): Promise<void> {
    this.disconnect()
    this.profile = profile
    this.status = 'loading'
    this.message = 'Finding the ghost service…'
    this.onChange()
    const boot = await this.discover()
    if (!boot) {
      this.status = 'unavailable'
      this.message = 'Online ghost racing is not configured for this build. Solo, split-screen and Track Lab still work offline.'
      this.onChange()
      return
    }
    const code = room.trim().toUpperCase()
    if (code && !isRoomCode(code)) {
      this.status = 'idle'
      this.message = 'Room codes are 4–6 letters or digits.'
      this.onChange()
      return
    }
    this.url = boot.signalingUrl
    this.room = code
    this.wanted = true
    this.retries = 0
    this.open()
  }

  private open(): void {
    const params = new URLSearchParams({ build: PROTOCOL })
    if (this.room) params.set('room', this.room)
    const resume = this.room ? this.readResume(this.room) : ''
    if (resume) params.set('resume', resume)
    this.status = this.retries > 0 ? 'reconnecting' : 'connecting'
    this.message = this.retries > 0 ? 'Connection lost — reconnecting…' : 'Connecting…'
    this.onChange()
    let ws: WebSocket
    try {
      ws = new WebSocket(`${this.url}${this.url.includes('?') ? '&' : '?'}${params.toString()}`)
    } catch {
      this.fail('Could not open a connection to the ghost service.')
      return
    }
    this.ws = ws
    ws.onmessage = ev => this.receive(ev.data)
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      clearInterval(this.pingTimer)
      clearInterval(this.flushTimer)
      if (!this.wanted) return
      this.retries += 1
      if (this.retries > 6) {
        this.fail('The ghost service is unreachable right now. Try again in a moment.')
        return
      }
      this.status = 'reconnecting'
      this.message = 'Connection lost — reconnecting…'
      this.onChange()
      this.retryTimer = window.setTimeout(() => this.open(), Math.min(8000, 500 * 2 ** this.retries))
    }
  }

  private fail(msg: string): void {
    this.wanted = false
    this.status = 'closed'
    this.message = msg
    this.onChange()
  }

  disconnect(): void {
    this.wanted = false
    clearTimeout(this.retryTimer)
    clearInterval(this.pingTimer)
    clearInterval(this.flushTimer)
    if (this.ws) {
      try { this.send({ t: 'leave' }) } catch { /* closing */ }
      this.ws.close()
    }
    this.ws = null
    this.status = 'idle'
    this.message = ''
    this.lobby = null
    this.seat = -1
    this.race = null
    this.results = null
    this.frames.clear()
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private readResume(room: string): string {
    try {
      const raw = sessionStorage.getItem(RESUME_KEY)
      const data = raw ? (JSON.parse(raw) as { room: string; token: string }) : null
      return data && data.room === room ? data.token : ''
    } catch {
      return ''
    }
  }

  private writeResume(room: string, token: string): void {
    try { sessionStorage.setItem(RESUME_KEY, JSON.stringify({ room, token })) } catch { /* private mode */ }
  }

  // ─── messages ────────────────────────────────────────────────────────

  private receive(raw: unknown): void {
    if (typeof raw !== 'string' || raw.length > 200_000) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }
    switch (msg.t) {
      case 'welcome': {
        if (msg.build !== PROTOCOL) return this.fail('This game version does not match the ghost service. Refresh the page.')
        this.room = String(msg.room)
        this.seat = Number(msg.seat)
        if (typeof msg.resume === 'string') this.writeResume(this.room, msg.resume)
        this.retries = 0
        this.status = 'connected'
        this.message = this.seat < 0 ? 'Room is full — watching as a spectator.' : ''
        this.offset = Number(msg.now) - performance.now()
        this.send({ t: 'join', name: this.profile.name, chassis: this.profile.chassis, livery: this.profile.livery })
        this.ping()
        this.pingTimer = window.setInterval(() => this.ping(), 1000)
        this.flushTimer = window.setInterval(() => this.flush(), 50)
        // Resume: re-send inputs the service has not processed yet.
        const next = Number(msg.nextTick)
        if (Number.isFinite(next) && next > 0 && this.race && Number(msg.raceId) === this.race.raceId) this.sentUpTo = next - 1
        this.onChange()
        break
      }
      case 'pong': {
        const c = Number(msg.c)
        const s = Number(msg.s)
        const now = performance.now()
        const rtt = now - c
        if (!(rtt >= 0 && rtt < 5000)) return
        this.rtt = this.rtt * 0.8 + rtt * 0.2
        const est = s + rtt / 2 - now
        this.offset = Math.abs(est - this.offset) > 250 ? est : this.offset * 0.85 + est * 0.15
        break
      }
      case 'lobby':
        this.lobby = msg.lobby as LobbyState
        if (this.lobby.phase === 'lobby' && this.race && this.results) this.race = null
        this.onChange()
        break
      case 'start': {
        const r = msg as unknown as RaceStart & { t: string }
        // A resumed connection re-announces the running race; keep the local session going.
        if (this.race && this.race.raceId === r.raceId) break
        this.race = { raceId: r.raceId, startAt: r.startAt, track: r.track, seats: r.seats, seed: r.seed }
        this.results = null
        this.inputs.length = 0
        this.sentUpTo = 0
        this.frames.clear()
        this.checks.clear()
        this.resync = null
        if (this.seat >= 0 && r.seats.includes(this.seat)) this.onRaceStart(this.race)
        this.onChange()
        break
      }
      case 'ghosts': {
        const list = msg.cars as GhostFrame[]
        if (!Array.isArray(list)) return
        for (const f of list.slice(0, 3)) {
          if (!f || typeof f.seat !== 'number') continue
          const arr = this.frames.get(f.seat) ?? []
          if (arr.length && arr[arr.length - 1].tick >= f.tick) continue
          arr.push(f)
          if (arr.length > 40) arr.splice(0, arr.length - 40)
          this.frames.set(f.seat, arr)
        }
        break
      }
      case 'ack': {
        const tick = Number(msg.tick)
        const c = msg.c as number[]
        const mine = this.checks.get(tick)
        if (mine && Array.isArray(c) && !checksMatch(mine.split(',').map(Number), c)) this.askResync()
        break
      }
      case 'state':
        this.resync = msg.snap as SimSnapshot
        break
      case 'rewind': {
        // The service asks to resume the input stream from `next` (gap or ran ahead of real time).
        const next = Number(msg.next)
        if (this.race && Number(msg.raceId) === this.race.raceId && Number.isInteger(next) && next >= 1) this.sentUpTo = Math.min(this.sentUpTo, next - 1)
        break
      }
      case 'results':
        this.results = msg.rows as OnlineResult[]
        this.onResults(this.results)
        this.onChange()
        break
      case 'error':
        this.message = typeof msg.message === 'string' ? msg.message : 'The ghost service rejected a message.'
        if (msg.fatal) this.fail(this.message)
        else this.onChange()
        break
    }
  }

  private ping(): void {
    this.send({ t: 'ping', c: performance.now() })
  }

  private flush(): void {
    if (!this.race || this.seat < 0) return
    const from = this.sentUpTo + 1
    const to = Math.min(this.inputs.length - 1, this.sentUpTo + 240)
    if (to < from) return
    const v: number[] = []
    for (let t = from; t <= to; t += 1) v.push(this.inputs[t] ?? 0)
    this.send({ t: 'in', raceId: this.race.raceId, from, v })
    this.sentUpTo = to
  }

  private askResync(): void {
    const now = performance.now()
    if (now - this.lastResyncAsk < 2000) return
    this.lastResyncAsk = now
    this.send({ t: 'resync' })
  }

  // ─── lobby actions ───────────────────────────────────────────────────

  setReady(ready: boolean): void { this.send({ t: 'ready', v: ready }) }
  setTrack(track: string): void { this.send({ t: 'track', track }) }
  start(): void { this.send({ t: 'start' }) }
  updateProfile(profile: { name: string; chassis: number; livery: number }): void {
    this.profile = profile
    this.send({ t: 'join', ...profile })
  }

  get isHost(): boolean {
    return !!this.lobby && this.lobby.host === this.seat
  }

  get latency(): number {
    return Math.round(this.rtt)
  }

  serverNow(): number {
    return performance.now() + this.offset
  }

  // ─── OnlineLink ──────────────────────────────────────────────────────

  targetTick(): number {
    if (!this.race) return 0
    return Math.floor((this.serverNow() - this.race.startAt) / TICK_MS)
  }

  pushInput(tick: number, packed: number): void {
    this.inputs[tick] = packed
  }

  ghostFrames(): Map<number, GhostFrame[]> {
    return this.frames
  }

  ghostProfile(seat: number): { name: string; chassis: number; livery: number } | null {
    const p = this.lobby?.players.find(q => q.seat === seat)
    return p ? { name: p.name, chassis: p.chassis, livery: p.livery } : null
  }

  takeResync(): SimSnapshot | null {
    const s = this.resync
    this.resync = null
    return s
  }

  recordCheck(tick: number, check: [number, number, number]): void {
    this.checks.set(tick, check.join(','))
    if (this.checks.size > 1200) {
      const cut = tick - 1100
      for (const k of this.checks.keys()) if (k < cut) this.checks.delete(k)
    }
  }
}
