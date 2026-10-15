#!/usr/bin/env node
// Canyon Circuit ghost race service.
// Owns rooms, seats, race start, deterministic re-simulation of every racer's uploaded inputs,
// ghost broadcast and final results. Clients only upload quantized inputs and present ghosts.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import {
  RaceSim, Track, CANYON_CIRCUIT, decodeLab, generateLabTrack, idleInput, bestLap, COUNTDOWN, MAX_RACE_TIME,
  carCheck, ghostFrame, GHOST_HZ, INPUTS_PER_MESSAGE, isPackedInput, isRoomCode, MAX_SEATS, PROTOCOL, randomRoomCode, sanitizeName, unpackInput,
} from './lib/sim.mjs'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 8791)
const TICK_MS = 1000 / 60
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 2500)
const RECONNECT_GRACE_MS = 60_000
const ROOM_IDLE_MS = 10 * 60_000
const FINISH_GRACE_TICKS = 8 * 60
const LEAD_TICKS = 30
const LAG_TICKS = 120
const ACK_EVERY = 30
const MAX_ROOMS = 128
const MAX_CLIENTS = 256
const MAX_SPECTATORS = 8
const MAX_BUFFERED_BYTES = 256 * 1024
const MAX_PAYLOAD = 4096
const MAX_MSGS_PER_SEC = 60
const CHASSIS = 7
const LIVERIES = 8
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean))
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('Invalid PORT')

const mainTrack = new Track(CANYON_CIRCUIT)
const rooms = new Map()
const token = () => randomBytes(18).toString('base64url')
const clampInt = (v, lo, hi, d) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d)

function send(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.terminate(); return }
  ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
}

/** Resolve a track code to a Track, or null when the code is invalid / not drivable. */
function resolveTrack(code) {
  if (code === 'main') return mainTrack
  if (typeof code !== 'string' || code.length > 200) return null
  const lab = decodeLab(code)
  if (!lab) return null
  const gen = generateLabTrack(lab)
  return gen.check.ok ? gen.track : null
}

class Room {
  constructor(code) {
    this.code = code
    this.rev = 0
    this.phase = 'lobby'
    this.trackCode = 'main'
    this.players = new Map() // seat -> player
    this.spectators = new Set()
    this.lastActivity = Date.now()
    this.race = null
    this.raceId = 0
  }

  get host() {
    let best = -1
    for (const p of this.players.values()) if (p.socket && (best < 0 || p.seat < best)) best = p.seat
    if (best < 0) for (const p of this.players.values()) if (best < 0 || p.seat < best) best = p.seat
    return best
  }

  claim(ws, resume) {
    this.lastActivity = Date.now()
    let player = null
    if (resume) {
      for (const p of this.players.values()) {
        if (p.token === resume) {
          if (p.socket && p.socket !== ws) p.socket.close(4001, 'seat resumed elsewhere')
          player = p
          break
        }
      }
    }
    if (!player) {
      for (let seat = 0; seat < MAX_SEATS; seat += 1) {
        if (!this.players.has(seat)) {
          player = { seat, token: token(), socket: null, name: 'Racer', chassis: seat % CHASSIS, livery: (seat * 2) % LIVERIES, ready: false, disconnectedAt: 0 }
          this.players.set(seat, player)
          break
        }
      }
    }
    ws.room = this
    if (!player) {
      if (this.spectators.size >= MAX_SPECTATORS) { ws.close(1013, 'room full'); return false }
      this.spectators.add(ws)
      ws.seat = -1
    } else {
      player.socket = ws
      player.disconnectedAt = 0
      ws.seat = player.seat
    }
    const racer = player && this.race ? this.race.racers.get(player.seat) : null
    send(ws, {
      t: 'welcome', build: PROTOCOL, room: this.code, seat: ws.seat, resume: player ? player.token : '', now: Date.now(),
      raceId: this.race ? this.race.raceId : 0, nextTick: racer ? racer.sim.tick + 1 : 0,
    })
    if (this.race && (this.phase === 'racing')) {
      const r = this.race
      send(ws, { t: 'start', raceId: r.raceId, startAt: r.startAt, track: r.trackCode, seats: [...r.racers.keys()], seed: r.seed })
    }
    this.broadcastLobby()
    return true
  }

  release(ws) {
    this.lastActivity = Date.now()
    if (ws.seat >= 0) {
      const p = this.players.get(ws.seat)
      if (p && p.socket === ws) {
        p.socket = null
        p.ready = false
        p.disconnectedAt = Date.now()
      }
    } else this.spectators.delete(ws)
    this.broadcastLobby()
  }

  leave(ws) {
    if (ws.seat >= 0) {
      const p = this.players.get(ws.seat)
      if (p && p.socket === ws) {
        if (this.race && this.race.racers.has(p.seat)) {
          // Keep the seat's race entry so results stay fair; mark it gone.
          p.socket = null
          p.disconnectedAt = Date.now() - RECONNECT_GRACE_MS
        } else this.players.delete(p.seat)
      }
    } else this.spectators.delete(ws)
    ws.seat = -2
    this.broadcastLobby()
  }

  lobbyState() {
    return {
      rev: this.rev, room: this.code, phase: this.phase, host: this.host, track: this.trackCode,
      players: [...this.players.values()].sort((a, b) => a.seat - b.seat).map(p => ({ seat: p.seat, name: p.name, chassis: p.chassis, livery: p.livery, ready: p.ready, connected: !!p.socket })),
      raceId: this.race ? this.race.raceId : this.raceId, startAt: this.race ? this.race.startAt : 0, spectators: this.spectators.size,
    }
  }

  broadcast(payload) {
    const raw = JSON.stringify(payload)
    for (const p of this.players.values()) send(p.socket, raw)
    for (const s of this.spectators) send(s, raw)
  }

  broadcastLobby() {
    this.rev += 1
    this.broadcast({ t: 'lobby', lobby: this.lobbyState() })
  }

  error(ws, code, message, fatal = false) {
    send(ws, { t: 'error', code, message, fatal })
  }

  handle(ws, msg) {
    this.lastActivity = Date.now()
    const seat = ws.seat
    const player = seat >= 0 ? this.players.get(seat) : null
    if (player && player.socket !== ws) return
    switch (msg.t) {
      case 'ping':
        if (typeof msg.c === 'number' && Number.isFinite(msg.c)) send(ws, { t: 'pong', c: msg.c, s: Date.now() })
        return
      case 'join':
        if (!player) return
        player.name = sanitizeName(msg.name)
        player.chassis = clampInt(msg.chassis, 0, CHASSIS - 1, player.chassis)
        player.livery = clampInt(msg.livery, 0, LIVERIES - 1, player.livery)
        this.broadcastLobby()
        return
      case 'ready':
        if (!player || this.phase !== 'lobby' || typeof msg.v !== 'boolean') return
        player.ready = msg.v
        this.broadcastLobby()
        return
      case 'track': {
        if (!player || seat !== this.host || this.phase !== 'lobby') return
        if (!resolveTrack(msg.track)) return this.error(ws, 'bad_track', 'That track code is not a valid, drivable layout.')
        this.trackCode = msg.track
        for (const p of this.players.values()) if (p.seat !== seat) p.ready = false
        this.broadcastLobby()
        return
      }
      case 'start':
        if (!player || seat !== this.host) return this.error(ws, 'not_host', 'Only the room host can start the race.')
        if (this.phase !== 'lobby') return
        for (const p of this.players.values()) {
          if (p.seat !== seat && p.socket && !p.ready) return this.error(ws, 'not_ready', 'Wait until every racer is ready.')
        }
        this.startRace()
        return
      case 'in':
        if (player) this.input(player, msg)
        return
      case 'resync': {
        const racer = player && this.race ? this.race.racers.get(seat) : null
        if (!racer) return
        const now = Date.now()
        if (now - racer.lastResync < 1500) return
        racer.lastResync = now
        send(ws, { t: 'state', snap: racer.sim.exportState() })
        return
      }
      case 'leave':
        this.leave(ws)
        return
    }
  }

  startRace() {
    const track = resolveTrack(this.trackCode) ?? mainTrack
    const seats = [...this.players.values()].filter(p => p.socket).map(p => p.seat).sort((a, b) => a - b)
    if (!seats.length) return
    this.raceId += 1
    const seed = 1 + (randomBytes(4).readUInt32BE(0) % 100000)
    const racers = new Map()
    for (const s of seats) {
      const sim = new RaceSim({ track, cars: 1, seed, items: false, slots: [s] })
      racers.set(s, { seat: s, sim, pending: [], lastResync: 0, lagging: false, done: false })
    }
    this.race = { raceId: this.raceId, startAt: Date.now() + START_DELAY_MS, seed, trackCode: this.trackCode, track, racers, lastGhost: 0 }
    this.phase = 'racing'
    for (const p of this.players.values()) p.ready = false
    this.broadcast({ t: 'start', raceId: this.raceId, startAt: this.race.startAt, track: this.trackCode, seats, seed })
    this.broadcastLobby()
  }

  realtimeTick(now = Date.now()) {
    return this.race ? Math.floor((now - this.race.startAt) / TICK_MS) : 0
  }

  input(player, msg) {
    const race = this.race
    if (!race || msg.raceId !== race.raceId) return
    const racer = race.racers.get(player.seat)
    if (!racer || racer.done) return
    const from = msg.from
    const v = msg.v
    if (!Number.isInteger(from) || from < 1 || !Array.isArray(v) || v.length === 0 || v.length > INPUTS_PER_MESSAGE) return
    const sim = racer.sim
    let start = sim.tick + 1
    const rewind = () => {
      const now = Date.now()
      if (now - (racer.lastRewind || 0) < 250) return
      racer.lastRewind = now
      send(player.socket, { t: 'rewind', raceId: race.raceId, next: sim.tick + 1 })
    }
    if (from > start) return rewind()
    const limit = this.realtimeTick() + LEAD_TICKS
    const inp = idleInput()
    for (let t = from; t < from + v.length; t += 1) {
      if (t < start) continue
      if (t > limit) { rewind(); break }
      const packed = v[t - from]
      if (!isPackedInput(packed)) return this.error(player.socket, 'bad_input', 'Malformed input ignored.')
      unpackInput(packed, inp)
      sim.step([inp])
      sim.drainEvents()
      start = sim.tick + 1
      if (sim.tick % ACK_EVERY === 0) send(player.socket, { t: 'ack', tick: sim.tick, c: carCheck(sim.cars[0]) })
      const p = sim.cars[0].progress
      if (p.finished || p.dnf) { racer.done = true; break }
    }
  }

  tick(now) {
    // Expire abandoned seats outside races.
    for (const p of [...this.players.values()]) {
      if (!p.socket && p.disconnectedAt && now - p.disconnectedAt > RECONNECT_GRACE_MS && !(this.race && this.race.racers.has(p.seat))) this.players.delete(p.seat)
    }
    const race = this.race
    if (!race || this.phase !== 'racing') return
    const rt = this.realtimeTick(now)
    const deadline = (COUNTDOWN + MAX_RACE_TIME) * 60 + FINISH_GRACE_TICKS
    for (const racer of race.racers.values()) {
      if (racer.done) continue
      const car = racer.sim.cars[0]
      racer.lagging = racer.sim.tick < rt - LAG_TICKS
      const p = this.players.get(racer.seat)
      const gone = !p || (!p.socket && now - p.disconnectedAt > RECONNECT_GRACE_MS)
      if (rt > deadline || gone) {
        if (!car.progress.finished) car.progress.dnf = true
        racer.done = true
      }
    }
    if (now - race.lastGhost >= 1000 / GHOST_HZ) {
      race.lastGhost = now
      const cars = [...race.racers.values()].map(r => ghostFrame(r.seat, r.sim.tick, r.sim.cars[0], r.lagging))
      this.broadcast({ t: 'ghosts', cars })
    }
    if ([...race.racers.values()].every(r => r.done)) this.finishRace()
  }

  finishRace() {
    const race = this.race
    const rows = [...race.racers.values()].map(r => {
      const p = r.sim.cars[0].progress
      const pl = this.players.get(r.seat)
      return {
        seat: r.seat, name: pl ? pl.name : 'Racer', chassis: pl ? pl.chassis : 0, livery: pl ? pl.livery : 0, place: 0,
        finished: p.finished, dnf: !p.finished, total: p.finished ? p.finishTime + p.penalty : 0, penalty: p.penalty,
        bestLap: bestLap(p), gates: p.gates, lapTimes: p.lapTimes.slice(0, 3),
      }
    })
    rows.sort((a, b) => (a.finished !== b.finished ? (a.finished ? -1 : 1) : a.finished ? a.total - b.total : b.gates - a.gates))
    rows.forEach((r, k) => { r.place = k + 1 })
    this.broadcast({ t: 'results', rows })
    this.race = null
    this.phase = 'lobby'
    for (const [seat, p] of [...this.players]) if (!p.socket && Date.now() - p.disconnectedAt > RECONNECT_GRACE_MS) this.players.delete(seat)
    this.broadcastLobby()
  }

  get empty() {
    return this.spectators.size === 0 && [...this.players.values()].every(p => !p.socket)
  }
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === '/healthz' || url.pathname === '/ws/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({ ok: true, build: PROTOCOL, rooms: rooms.size, clients: wss.clients.size, uptime: Math.round(process.uptime()) }))
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })

httpServer.on('upgrade', (req, socket, head) => {
  let url
  try { url = new URL(req.url || '/', 'http://localhost') } catch { socket.destroy(); return }
  const origin = req.headers.origin
  if (url.pathname !== '/ws' || wss.clients.size >= MAX_CLIENTS) { socket.destroy(); return }
  if (origin && allowedOrigins.size && !allowedOrigins.has(origin) && !allowedOrigins.has('*')) { socket.destroy(); return }
  if (url.searchParams.get('build') !== PROTOCOL) {
    wss.handleUpgrade(req, socket, head, ws => {
      send(ws, { t: 'error', code: 'build_mismatch', message: 'This game version does not match the ghost service. Refresh the page.', fatal: true })
      ws.close(4000, 'build mismatch')
    })
    return
  }
  let code = String(url.searchParams.get('room') || '').toUpperCase()
  if (code && !isRoomCode(code)) { socket.destroy(); return }
  if (code && !rooms.has(code)) {
    wss.handleUpgrade(req, socket, head, ws => {
      send(ws, { t: 'error', code: 'no_room', message: `Room ${code} does not exist (it may have expired). Create a new room instead.`, fatal: true })
      ws.close(4004, 'no room')
    })
    return
  }
  if (!code) {
    if (rooms.size >= MAX_ROOMS) { socket.destroy(); return }
    do { code = randomRoomCode() } while (rooms.has(code))
    rooms.set(code, new Room(code))
  }
  const resume = String(url.searchParams.get('resume') || '').slice(0, 64)
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, rooms.get(code), resume))
})

wss.on('connection', (ws, room, resume) => {
  ws.alive = true
  ws.on('pong', () => { ws.alive = true })
  let windowStart = Date.now()
  let count = 0
  if (!room.claim(ws, resume)) return
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const now = Date.now()
    if (now - windowStart >= 1000) { windowStart = now; count = 0 }
    if (++count > MAX_MSGS_PER_SEC) { ws.close(1008, 'rate limit'); return }
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return room.error(ws, 'invalid_json', 'Malformed message.') }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return
    if (ws.seat === -2) return
    room.handle(ws, msg)
  })
  ws.on('close', () => room.release(ws))
  ws.on('error', () => room.release(ws))
})

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue }
    ws.alive = false
    ws.ping()
  }
}, 15_000).unref()

setInterval(() => {
  const now = Date.now()
  for (const [code, room] of rooms) {
    room.tick(now)
    if (room.empty && now - room.lastActivity > ROOM_IDLE_MS) rooms.delete(code)
  }
}, 25).unref()

httpServer.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ service: 'canyon-ghost', build: PROTOCOL, status: 'listening', host: HOST, port: httpServer.address().port, origins: [...allowedOrigins] }))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const ws of wss.clients) ws.close(1012, 'server restart')
    httpServer.close(() => process.exit(0))
    setTimeout(() => process.exit(1), 3000).unref()
  })
}

export { httpServer, rooms }
