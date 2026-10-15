// Dev-only banked-wall / twist visual check: node scripts/bank-check.mjs [url] [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-bank'
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
/** Step the sim until the player's car reaches arc position `s` (first lap), then let frames render. */
const driveTo = async (s, name) => {
  const info = await page.evaluate(target => {
    const a = window.__game.app
    const c = a.session.sim.cars[0]
    for (let i = 0; i < 60 * 120; i += 1) {
      a.step()
      if (c.loc.s > target && c.loc.s < target + 30 && c.grounded && c.hold <= 0 && c.wreck <= 0) break
    }
    // Bulk stepping skips render frames: snap the chase camera so it is not easing in from far away.
    a.session.cams[0].reset(c.x, c.y, c.z, c.yaw)
    const b = a.session.track.bank[c.loc.i]
    return { s: Math.round(c.loc.s), kmh: Math.round(Math.abs(c.vF) * 3.6), bankDeg: Math.round(Math.atan(Math.abs(b)) * 57.3), anchor: +c.anchor.toFixed(2), slip: +c.slip.toFixed(2) }
  }, s)
  for (let k = 0; k < 3; k += 1) { await page.evaluate(() => { const a = window.__game.app; for (let i = 0; i < 2; i += 1) a.step() }); await wait(220) }
  console.log(name, JSON.stringify(info))
  await shot(name)
}
await driveTo(606, '01-canyon-wall')
await driveTo(915, '02-hairpin-64deg')
await driveTo(1100, '03-ridge-twist')
await driveTo(1350, '04-bridge-approach-bank')
await driveTo(2490, '05-sweeper-62deg')
// Low-speed slide warning: on the next lap's hairpin, kill the speed and let the car slip.
await page.evaluate(() => {
  const a = window.__game.app
  const c = a.session.sim.cars[0]
  for (let i = 0; i < 60 * 120; i += 1) { a.step(); if (c.loc.s > 925 && c.loc.s < 945 && c.grounded && c.hold <= 0) break }
  a.session.autopilot[0] = false
  c.vx *= 0.3
  c.vz *= 0.3
  c.vF *= 0.3
})
for (let k = 0; k < 3; k += 1) { await page.evaluate(() => { const a = window.__game.app; for (let i = 0; i < 3; i += 1) a.step() }); await wait(150) }
const slip = await page.evaluate(() => { const c = window.__game.app.session.sim.cars[0]; return { slip: +c.slip.toFixed(2), anchor: +c.anchor.toFixed(2), kmh: Math.round(Math.abs(c.vF) * 3.6) } })
console.log('slide', JSON.stringify(slip))
await shot('06-slide-warning')
console.log(errors.length ? errors.join('\n') : 'no errors')
await browser.close()
