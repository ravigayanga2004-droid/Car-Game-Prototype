// Dev-only flow check: node scripts/flow-check.mjs [url] [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-flow'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`) })
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
const shot = async name => page.screenshot({ path: `${out}/${name}.png`, timeout: 150000 })
const wait = ms => page.waitForTimeout(ms)
const active = s => page.waitForFunction(n => document.querySelector(`[data-screen="${n}"].is-active`), s, { timeout: 180000 })

await page.goto(url)
await active('title')
await page.keyboard.press('Enter')
await active('garage')
if (!process.env.SKIP_RACE) {
await page.click('[data-mode="solo"]', { force: true })
await page.click('[data-act="goSolo"]', { force: true })
await active('hud')
// Autopilot the player and fast-forward the simulation in bursts, snapshotting mid-race.
await page.evaluate(() => { window.__game.app.session.autopilot[0] = true })
const ff = ticks => page.evaluate(n => { const a = window.__game.app; for (let i = 0; i < n && a.session && !a.session.sim.cars.every(c => c.progress.finished || c.progress.dnf); i += 1) a.step(); return a.session?.sim.tick }, ticks)
for (let k = 0; k < 6; k += 1) {
  const tick = await ff(1400)
  await wait(400)
  await shot(`race-${k}`)
  const st = await page.evaluate(() => { const s = window.__game.app.session; return s ? s.sim.cars.map(c => ({ g: c.progress.gates, lap: c.progress.lap, fin: c.progress.finished, pen: c.progress.penalty, t: c.progress.finishTime })) : null })
  console.log('tick', tick, JSON.stringify(st))
}
await ff(20000)
await active('results').catch(() => console.log('results screen late'))
await wait(1500)
await shot('results')
console.log('screen', await page.evaluate(() => window.__game.ui.screen))
// Back to garage, split-screen
await page.click('[data-act="toGarage"]', { force: true }).catch(e => console.log('no garage btn', e.message))
await active('garage')
}
await page.click('[data-mode="split"]', { force: true })
await wait(300)
await shot('split-setup')
await page.click('[data-act="goSplit"]', { force: true })
await active('hud')
await wait(5000)
await shot('split-race')
await page.keyboard.press('Escape')
await wait(400)
await shot('split-pause')
await page.click('[data-act="quit"]', { force: true }).catch(e => console.log('no quit', e.message))
await wait(600)
await page.click('[data-mode="lab"]', { force: true }).catch(e => console.log('no lab', e.message))
await wait(500)
await shot('lab')
await page.click('[data-act="labTest"]', { force: true }).catch(e => console.log('no labTest', e.message))
await wait(6000)
await shot('lab-race')
await page.click('[data-mode="online"]', { force: true }).catch(() => {})
console.log('errors', errors.length)
for (const e of errors.slice(0, 30)) console.log(e)
await browser.close()
