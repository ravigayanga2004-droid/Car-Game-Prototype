// Dev-only: node scripts/ws-car-check.mjs [wssUrl] [origin]
// Joins the DEPLOYED ghost service with the newest chassis/livery and checks the lobby echoes them unclamped.
import { WebSocket } from '../server/node_modules/ws/wrapper.mjs'
import { PROTOCOL } from '../server/lib/sim.mjs'
const base = process.argv[2] ?? 'wss://34.21.249.159/ghost-v1/ws'
const origin = process.argv[3] ?? 'https://canyon-circuit.manustest.game'
const want = { chassis: 6, livery: 7 }
const ws = new WebSocket(`${base}?build=${PROTOCOL}`, { headers: { origin } })
const t = setTimeout(() => { console.log('timeout'); process.exit(1) }, 10000)
ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'CarCheck', ...want })))
ws.on('message', d => {
  const m = JSON.parse(String(d))
  if (process.env.DEBUG) console.log('msg', JSON.stringify(m).slice(0, 300))
  const me = (m.lobby?.players ?? m.players)?.find(p => p.name === 'CarCheck')
  if (!me) return
  const ok = me.chassis === want.chassis && me.livery === want.livery
  console.log(`lobby echo chassis=${me.chassis} livery=${me.livery} -> ${ok ? 'OK' : 'CLAMPED'}`)
  clearTimeout(t); ws.close(); process.exit(ok ? 0 : 2)
})
ws.on('error', e => { console.log('error', e.message); process.exit(1) })
