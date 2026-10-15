// Dev-only online e2e: two browsers race through a local ghost service behind a latency proxy.
// node scripts/online-e2e.mjs [gameUrl] [--delay=60] [--full]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdirSync } from 'node:fs'

const gameUrl = process.argv.find(a => a.startsWith('http')) ?? 'http://localhost:3000/'
const delay = Number((process.argv.find(a => a.startsWith('--delay=')) ?? '--delay=60').split('=')[1])
const full = process.argv.includes('--full')
const real = process.argv.includes('--real')
const out = '/tmp/cc-online'
mkdirSync(out, { recursive: true })

const server = spawn(process.execPath, ['ghost_server.mjs'], { cwd: new URL('../server/', import.meta.url).pathname, env: { ...process.env, PORT: '0', HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'inherit'] })
const serverPort = await new Promise(resolve => server.stdout.on('data', d => { const l = d.toString().split('\n').find(x => x.includes('listening')); if (l) resolve(JSON.parse(l).port) }))
// One-way `delay` ms each direction => RTT ≈ 2 × delay.
const proxy = net.createServer(client => {
  const upstream = net.connect(serverPort, '127.0.0.1')
  client.on('data', c => setTimeout(() => upstream.write(c), delay))
  upstream.on('data', c => setTimeout(() => client.write(c), delay))
  const end = () => { client.destroy(); upstream.destroy() }
  client.on('close', end); upstream.on('close', end); client.on('error', end); upstream.on('error', end)
})
await new Promise(r => proxy.listen(0, '127.0.0.1', r))
const proxyPort = proxy.address().port
console.log('service', serverPort, 'proxy', proxyPort, 'delay', delay)

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const errors = []
async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } })
  await ctx.addInitScript(k => { try { const d = JSON.parse(localStorage.getItem(k) || '{}'); d.quality = 'low'; localStorage.setItem(k, JSON.stringify(d)) } catch {} }, 'canyon-circuit.save')
  const page = await ctx.newPage()
  page.setDefaultTimeout(180000)
  page.on('pageerror', e => errors.push(`[${name}] ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`) })
  if (!real) await page.route('**/multiplayer/bootstrap.json', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ build: 'canyon-ghost-v1', signalingUrl: `ws://127.0.0.1:${proxyPort}/ws` }) }))
  return page
}
const active = (p, s) => p.waitForFunction(n => document.querySelector(`[data-screen="${n}"].is-active`), s, { timeout: 240000, polling: 1000 })
const net_ = p => p.evaluate(() => { const n = window.__game.net; return { status: n.status, room: n.room, seat: n.seat, latency: n.latency, message: n.message, phase: n.lobby?.phase } })

const A = await open('A')
const B = await open('B')
await A.goto(gameUrl)
await active(A, 'title')
await A.keyboard.press('Enter')
await active(A, 'garage')
await A.click('[data-mode="online"]', { force: true })
await A.click('[data-act="onCreate"]', { force: true })
await A.waitForFunction(() => window.__game.net.status === 'connected', null, { timeout: 120000, polling: 500 })
const room = (await net_(A)).room
console.log('room', room)
await B.goto(`${gameUrl}?room=${room}`)
await active(B, 'title')
await B.keyboard.press('Enter')
await B.waitForTimeout(800)
if (!(await B.evaluate(() => window.__game.net.status === 'connected'))) {
  await B.click('[data-mode="online"]', { force: true }).catch(() => {})
  await B.fill('[data-o="code"]', room)
  await B.click('[data-act="onJoin"]', { force: true })
}
await B.waitForFunction(() => window.__game.net.status === 'connected', null, { timeout: 120000, polling: 500 })
await A.waitForFunction(() => window.__game.net.lobby?.players.length === 2, null, { timeout: 120000, polling: 500 })
await A.screenshot({ path: `${out}/lobby-A.png` })
console.log('B state', JSON.stringify(await B.evaluate(() => ({ screen: window.__game.ui.screen, net: window.__game.net.status, seat: window.__game.net.seat, players: window.__game.net.lobby?.players, lobbyHtml: document.querySelector('[data-screen="online"]')?.innerHTML.slice(0, 600) }))))
await B.screenshot({ path: `${out}/lobby-B.png`, timeout: 150000 })
await B.click('[data-act="onReady"]', { force: true })
await A.waitForFunction(() => window.__game.net.lobby?.players.every(p => p.seat === window.__game.net.seat || p.ready), null, { timeout: 120000, polling: 500 })
await A.click('[data-act="onStart"]', { force: true })
await Promise.all([active(A, 'hud'), active(B, 'hud')])
for (const p of [A, B]) await p.evaluate(() => { window.__game.app.session.autopilot[0] = true })
console.log('A', JSON.stringify(await net_(A)), 'B', JSON.stringify(await net_(B)))
await A.waitForTimeout(14000)
await A.screenshot({ path: `${out}/race-A.png` })
await B.screenshot({ path: `${out}/race-B.png` })
const probe = p => p.evaluate(() => {
  const s = window.__game.app.session
  const g = [...s.ghosts.values()].map(v => ({ visible: v.model.root.visible, x: +v.model.root.position.x.toFixed(1), z: +v.model.root.position.z.toFixed(1) }))
  const c = s.sim.cars[0]
  return { tick: s.sim.tick, gates: c.progress.gates, x: +c.x.toFixed(1), z: +c.z.toFixed(1), ghosts: g }
})
console.log('probe A', JSON.stringify(await probe(A)))
console.log('probe B', JSON.stringify(await probe(B)))
// Drop B's socket; it must resume the same seat and keep racing.
await B.evaluate(() => window.__game.net.ws.close())
await B.waitForTimeout(300)
console.log('B after drop', JSON.stringify(await net_(B)))
await B.waitForFunction(() => window.__game.net.status === 'connected', null, { timeout: 120000, polling: 500 })
console.log('B resumed', JSON.stringify(await net_(B)), JSON.stringify(await probe(B)))
await A.waitForTimeout(4000)
console.log('probe A2', JSON.stringify(await probe(A)))
if (full) {
  await Promise.all([active(A, 'results'), active(B, 'results')].map(p => p.catch(e => e)))
  await A.waitForFunction(() => !!window.__game.net.results, null, { timeout: 240000, polling: 500 })
  await B.waitForFunction(() => !!window.__game.net.results, null, { timeout: 30000, polling: 500 })
  await A.waitForTimeout(800)
  await A.screenshot({ path: `${out}/results-A.png` })
  const rows = await A.evaluate(() => window.__game.net.results)
  const local = await Promise.all([A, B].map(p => p.evaluate(() => { const c = window.__game.app.session?.sim.cars[0]; return c ? +(c.progress.finishTime + c.progress.penalty).toFixed(3) : null })))
  console.log('results', JSON.stringify(rows.map(r => ({ seat: r.seat, place: r.place, fin: r.finished, total: +r.total.toFixed(3), gates: r.gates }))), 'local totals', JSON.stringify(local))
}
console.log('errors', errors.length)
for (const e of errors.slice(0, 20)) console.log(e)
await browser.close()
proxy.close()
server.kill('SIGTERM')
