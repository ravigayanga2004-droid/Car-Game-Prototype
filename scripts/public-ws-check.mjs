// Dev-only: protocol-level check of the DEPLOYED ghost service (no browsers).
// node scripts/public-ws-check.mjs [wssUrl] [origin]
// Two clients join one room over public WSS; seat 0 drives flat out into the canyon wall repeatedly
// (damage, smoke/fire thresholds, wrecks, respawn holds) and every server ack must match the local sim.
import { WebSocket } from '../server/node_modules/ws/wrapper.mjs'
import { RaceSim, Track, CANYON_CIRCUIT, idleInput, packInput, unpackInput, carCheck, PROTOCOL, INPUTS_PER_MESSAGE } from '../server/lib/sim.mjs'

const base = process.argv[2] ?? 'wss://34.21.249.159/ghost-v1/ws'
const origin = process.argv[3] ?? 'https://3000-i48bgtg93s3m0iuo4k9ha-eea5c5d1.asia1.manuspre.computer'
const url = (q = '') => `${base}?build=${PROTOCOL}${q}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

class Client {
  constructor(u) {
    this.msgs = []
    this.waiters = []
    this.ws = new WebSocket(u, { headers: { origin } })
    this.ws.on('message', raw => {
      const m = JSON.parse(raw.toString())
      this.msgs.push(m)
      this.waiters = this.waiters.filter(w => (w.pred(m) ? (w.resolve(m), false) : true))
    })
    this.ws.on('error', e => console.log('ws error', e.message))
  }
  wait(pred, ms = 8000) {
    const hit = this.msgs.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      this.waiters.push({ pred, resolve })
      setTimeout(() => reject(new Error('timeout waiting for message')), ms)
    })
  }
  send(m) { this.ws.send(JSON.stringify(m)) }
  close() { this.ws.close() }
}

const a = new Client(url())
const wa = await a.wait(m => m.t === 'welcome')
console.log('room', wa.room, 'seat', wa.seat)
const b = new Client(url(`&room=${wa.room}`))
await b.wait(m => m.t === 'welcome')
b.send({ t: 'ready', v: true })
await a.wait(m => m.t === 'lobby' && m.lobby.players.find(p => p.seat === 1)?.ready)
a.send({ t: 'start' })
const start = await a.wait(m => m.t === 'start')
console.log('race', start.raceId, 'seats', JSON.stringify(start.seats))

// Local mirror of seat 0: 3 s countdown idle, then full throttle with hard steering into the walls.
const TICKS = 60 * 40
const local = new RaceSim({ track: new Track(CANYON_CIRCUIT), cars: 1, seed: start.seed, items: false, slots: [0] })
const inp = idleInput()
const packed = []
const checks = new Map()
const seen = { damage: 0, maxDamage: 0, wrecks: 0, holds: 0, resets: 0 }
for (let t = 1; t <= TICKS; t += 1) {
  inp.throttle = t > 180 ? 1 : 0
  inp.steer = t > 180 ? (Math.floor(t / 240) % 2 ? 1 : -1) : 0
  inp.recover = t % 900 === 0
  const p = packInput(inp)
  packed.push(p)
  const car = local.cars[0]
  const wasWreck = car.wreck > 0
  local.step([unpackInput(p, idleInput())])
  for (const e of local.drainEvents()) if (e.type === 'damage') seen.damage += 1
  if (!wasWreck && car.wreck > 0) seen.wrecks += 1
  if (car.hold > 0) seen.holds += 1
  seen.maxDamage = Math.max(seen.maxDamage, car.damage)
  if (local.tick % 30 === 0) checks.set(local.tick, carCheck(car))
}
console.log('local sim', JSON.stringify(seen))

// Upload in real time-ish chunks once the race clock has passed each chunk.
const t0 = start.startAt
for (let from = 1; from <= TICKS; from += INPUTS_PER_MESSAGE) {
  const until = Math.min(TICKS, from + INPUTS_PER_MESSAGE - 1)
  const due = t0 + until * (1000 / 60) + 50
  if (due > Date.now()) await sleep(due - Date.now())
  a.send({ t: 'in', raceId: start.raceId, from, v: packed.slice(from - 1, until) })
}
await a.wait(m => m.t === 'ack' && m.tick >= TICKS - (TICKS % 30), 15000)
let compared = 0
let mismatches = 0
for (const m of a.msgs) {
  if (m.t !== 'ack' || !checks.has(m.tick)) continue
  compared += 1
  if (JSON.stringify(m.c) !== JSON.stringify(checks.get(m.tick))) {
    mismatches += 1
    if (mismatches <= 3) console.log('MISMATCH at', m.tick, JSON.stringify(m.c), JSON.stringify(checks.get(m.tick)))
  }
}
const rewinds = a.msgs.filter(m => m.t === 'rewind').length
const ghosts = b.msgs.filter(m => m.t === 'ghosts').length
console.log(`acks compared ${compared}, mismatches ${mismatches}, rewinds ${rewinds}, ghost frames at B ${ghosts}`)
a.close()
b.close()
process.exit(mismatches === 0 && compared > 20 && ghosts > 0 ? 0 : 1)
