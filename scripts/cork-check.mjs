// Dev-only corkscrew + nitro visual check: node scripts/cork-check.mjs [url] [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-cork'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.setDefaultTimeout(180000)
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`) })
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
const shot = async name => { await page.screenshot({ path: `${out}/${name}.png`, timeout: 150000 }); console.log('shot', name) }
const wait = ms => page.waitForTimeout(ms)
const active = s => page.waitForFunction(n => document.querySelector(`[data-screen="${n}"].is-active`), s, { timeout: 180000, polling: 500 })

await page.goto(url)
await active('title')
await page.keyboard.press('Enter')
await active('garage')
await page.click('[data-mode="solo"]', { force: true })
await page.click('[data-act="goSolo"]', { force: true })
await active('hud')
await page.evaluate(() => { window.__game.app.session.autopilot[0] = true })

/** Bulk-step to corkscrew #n, snap the camera, then advance `ticks` with rendered frames so the camera follows. */
const cork = async (n, ticks, name) => {
  await page.evaluate(n => {
    const a = window.__game.app
    const c = a.session.sim.cars[0]
    for (let i = 0; i < 60 * 150; i += 1) { a.step(); if (c.cork === n) break }
    a.session.cams[0].reset(c.x, c.y, c.z, c.yaw)
  }, n)
  for (let t = 0; t < ticks; t += 2) { await page.evaluate(() => { const a = window.__game.app; a.step(); a.step() }); await wait(45) }
  const info = await page.evaluate(() => { const c = window.__game.app.session.sim.cars[0]; return { cork: c.cork, s: Math.round(c.loc.s), kmh: Math.round(Math.abs(c.vF) * 3.6), y: +c.y.toFixed(1) } })
  console.log(name, JSON.stringify(info))
  await shot(name)
}
if (!process.env.NITRO_ONLY) {
await cork(0, 30, '01-cork1-roll')
await cork(1, 4, '02-cork2-entry')
await cork(1, 40, '03-cork2-inverted')
await cork(0, 60, '04-cork1-late')
}
// Nitro: top up the meter on a straight and let the autopilot fire it (it taps nitro on straights).
await page.evaluate(() => {
  const a = window.__game.app
  const c = a.session.sim.cars[0]
  for (let i = 0; i < 60 * 30; i += 1) { a.step(); if (c.cork < 0 && c.grounded && Math.abs(a.session.track.curv[c.loc.i]) < 0.004 && c.loc.s > 300 && c.loc.s < 600) break }
  c.meter = 1
  a.session.cams[0].reset(c.x, c.y, c.z, c.yaw)
})
await page.evaluate(() => { const c = window.__game.app.session.sim.cars[0]; c.nitro = 1.4; c.meter = 0; c.boostTime = 1.4 })
for (let k = 0; k < 6; k += 1) { await page.evaluate(() => window.__game.app.step()); await wait(60) }
const nit = await page.evaluate(() => { const c = window.__game.app.session.sim.cars[0]; return { nitro: +c.nitro.toFixed(2), meter: +c.meter.toFixed(2), kmh: Math.round(Math.abs(c.vF) * 3.6) } })
console.log('nitro', JSON.stringify(nit))
await shot('05-nitro-flames')
for (let k = 0; k < 4; k += 1) { await page.evaluate(() => { const a = window.__game.app; for (let i = 0; i < 20; i += 1) a.step() }); await wait(120) }
await shot('06-nitro-cooldown')
console.log(errors.length ? errors.join('\n') : 'no errors')
await browser.close()
