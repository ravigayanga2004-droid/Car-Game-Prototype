// node --test server.test.mjs — spawns the service on a random port and drives it with ws clients.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { RaceSim, Track, CANYON_CIRCUIT, idleInput, packInput, unpackInput, carCheck, PROTOCOL } from './lib/sim.mjs'

let proc
let port

async function startServer(env = {}) {
  const child = spawn(process.execPath, ['ghost_server.mjs'], { cwd: fileURLToPath(new URL('.', import.meta.url)), env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ALLOWED_ORIGINS: 'https://game.example', ...env }, stdio: ['ignore', 'pipe', 'inherit'] })
  const p = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.stdout.on('data', d => {
      const line = d.toString().split('\n').find(l => l.includes('listening'))
      if (line) resolve(JSON.parse(line).port)
    })
    child.on('exit', code => reject(new Error(`server exited ${code}`)))
  })
  return { child, port: p }
}

class Client {
  constructor(url, origin = 'https://game.example') {
    this.msgs = []
    this.waiters = []
    this.ws = new WebSocket(url, { headers: { origin } })
    this.ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      this.msgs.push(m)
      this.waiters = this.waiters.filter(w => (w.pred(m) ? (w.resolve(m), false) : true))
    })
    this.closed = new Promise(r => this.ws.on('close', (code) => r(code)))
  }
  wait(pred, ms = 4000) {
    const hit = this.msgs.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const w = { pred, resolve }
      this.waiters.push(w)
      setTimeout(() => reject(new Error('timeout waiting for message')), ms)
    })
  }
  next(pred, ms) {
    this.msgs = []
    return this.wait(pred, ms)
  }
  send(m) { this.ws.send(JSON.stringify(m)) }
  close() { this.ws.close() }
}

const url = (q = '') => `ws://127.0.0.1:${port}/ws?build=${PROTOCOL}${q}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

before(async () => {
  ;({ child: proc, port } = await startServer({ START_DELAY_MS: '200' }))
})
after(() => proc?.kill('SIGTERM'))

test('health endpoint reports build', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.build, PROTOCOL)
})

test('rejects foreign origins and mismatched builds', async () => {
  const bad = new WebSocket(url(), { headers: { origin: 'https://evil.example' } })
  await new Promise(r => bad.on('error', r))
  const old = new Client(`ws://127.0.0.1:${port}/ws?build=old`)
  const err = await old.wait(m => m.t === 'error')
  assert.equal(err.code, 'build_mismatch')
  assert.equal(err.fatal, true)
})

test('creates rooms, assigns up to three seats, then spectators', async () => {
  const a = new Client(url())
  const wa = await a.wait(m => m.t === 'welcome')
  assert.match(wa.room, /^[A-HJ-NP-Z2-9]{5}$/)
  assert.equal(wa.seat, 0)
  const b = new Client(url(`&room=${wa.room}`))
  const c = new Client(url(`&room=${wa.room}`))
  const d = new Client(url(`&room=${wa.room}`))
  assert.equal((await b.wait(m => m.t === 'welcome')).seat, 1)
  assert.equal((await c.wait(m => m.t === 'welcome')).seat, 2)
  assert.equal((await d.wait(m => m.t === 'welcome')).seat, -1)
  a.send({ t: 'join', name: 'Ana<script>', chassis: 3, livery: 99 })
  const lobby = await a.wait(m => m.t === 'lobby' && m.lobby.players.some(p => p.seat === 0 && p.name === 'Anascript'))
  const me = lobby.lobby.players.find(p => p.seat === 0)
  assert.equal(me.chassis, 3)
  assert.equal(me.livery, 0, 'out-of-range livery falls back')
  assert.equal(lobby.lobby.host, 0)
  const missing = new Client(url('&room=ZZZZZ'))
  assert.equal((await missing.wait(m => m.t === 'error')).code, 'no_room')
  for (const x of [a, b, c, d]) x.close()
})

test('only the host starts, non-ready guests block, and inputs re-simulate deterministically', async () => {
  const a = new Client(url())
  const wa = await a.wait(m => m.t === 'welcome')
  const b = new Client(url(`&room=${wa.room}`))
  await b.wait(m => m.t === 'welcome')
  b.send({ t: 'start' })
  assert.equal((await b.wait(m => m.t === 'error')).code, 'not_host')
  a.send({ t: 'start' })
  assert.equal((await a.wait(m => m.t === 'error' && m.code === 'not_ready')).code, 'not_ready')
  b.send({ t: 'ready', v: true })
  await a.wait(m => m.t === 'lobby' && m.lobby.players.find(p => p.seat === 1)?.ready)
  a.send({ t: 'track', track: 'not-a-code' })
  assert.equal((await a.wait(m => m.t === 'error' && m.code === 'bad_track')).code, 'bad_track')
  a.send({ t: 'start' })
  const start = await a.wait(m => m.t === 'start')
  assert.deepEqual(start.seats, [0, 1])
  // Local mirror of seat 0: full throttle, gentle weave.
  const track = new Track(CANYON_CIRCUIT)
  const local = new RaceSim({ track, cars: 1, seed: start.seed, items: false, slots: [0] })
  const inp = idleInput()
  const packed = []
  const checks = new Map()
  for (let t = 1; t <= 240; t += 1) {
    inp.throttle = t > 150 ? 1 : 0
    inp.steer = Math.sin(t / 40) * 0.3
    inp.steer = Math.round(inp.steer * 63) / 63
    const p = packInput(inp)
    packed.push(p)
    local.step([unpackInput(p, idleInput())])
    local.drainEvents()
    if (local.tick % 30 === 0) checks.set(local.tick, carCheck(local.cars[0]))
  }
  await sleep(Math.max(0, start.startAt - Date.now()) + 4200)
  a.send({ t: 'in', raceId: start.raceId, from: 1, v: packed.slice(0, 120) })
  a.send({ t: 'in', raceId: start.raceId, from: 100, v: packed.slice(99, 240) }) // overlapping resend
  const ack = await a.wait(m => m.t === 'ack' && m.tick === 240)
  assert.deepEqual(ack.c, checks.get(240))
  const ack120 = a.msgs.find(m => m.t === 'ack' && m.tick === 120)
  assert.deepEqual(ack120.c, checks.get(120))
  // Malformed input is rejected without advancing.
  a.send({ t: 'in', raceId: start.raceId, from: 241, v: [1 << 20] })
  assert.equal((await a.wait(m => m.t === 'error' && m.code === 'bad_input')).code, 'bad_input')
  // Gap asks the client to rewind to the next needed tick.
  a.send({ t: 'in', raceId: start.raceId, from: 400, v: [0] })
  assert.equal((await a.wait(m => m.t === 'rewind')).next, 241)
  // Resync returns the authoritative snapshot.
  a.send({ t: 'resync' })
  const st = await a.wait(m => m.t === 'state')
  assert.equal(st.snap.tick, 240)
  // Ghosts include both seats.
  const g = await b.next(m => m.t === 'ghosts')
  assert.deepEqual(g.cars.map(c => c.seat).sort(), [0, 1])
  assert.equal(g.cars.find(c => c.seat === 0).tick, 240)
  // Resume token reclaims the same seat mid-race and re-announces the race.
  a.close()
  await a.closed
  const a2 = new Client(url(`&room=${wa.room}&resume=${wa.resume}`))
  const w2 = await a2.wait(m => m.t === 'welcome')
  assert.equal(w2.seat, 0)
  assert.equal(w2.nextTick, 241)
  assert.equal((await a2.wait(m => m.t === 'start')).raceId, start.raceId)
  a2.close()
  b.close()
})

test('time limit turns unfinished racers into DNF results and returns to the lobby', async () => {
  const { child, port: p2 } = await startServer({ START_DELAY_MS: String(-(303 + 9) * 1000) })
  try {
    const a = new Client(`ws://127.0.0.1:${p2}/ws?build=${PROTOCOL}`)
    await a.wait(m => m.t === 'welcome')
    a.send({ t: 'start' })
    const res = await a.wait(m => m.t === 'results', 3000)
    assert.equal(res.rows.length, 1)
    assert.equal(res.rows[0].dnf, true)
    assert.equal(res.rows[0].place, 1)
    await a.wait(m => m.t === 'lobby' && m.lobby.phase === 'lobby' && m.lobby.raceId === 1)
    a.close()
  } finally {
    child.kill('SIGTERM')
  }
})

test('rate limits floods', async () => {
  const a = new Client(url())
  await a.wait(m => m.t === 'welcome')
  for (let k = 0; k < 90; k += 1) a.send({ t: 'ping', c: k })
  const code = await a.closed
  assert.equal(code, 1008)
})
