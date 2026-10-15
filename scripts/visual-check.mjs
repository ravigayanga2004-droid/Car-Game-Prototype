// Dev-only visual check: node scripts/visual-check.mjs [url] [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-shots'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
const errors = []
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`) })
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
const shot = async name => page.screenshot({ path: `${out}/${name}.png`, timeout: 120000 })
const wait = ms => page.waitForTimeout(ms)

await page.goto(url)
await page.waitForFunction(() => document.querySelector('[data-screen="title"].is-active'), null, { timeout: 60000 })
await wait(800)
await shot('01-title')
await page.keyboard.press('Enter')
await wait(900)
await shot('02-garage')
await page.click('[data-mode="solo"]')
await wait(400)
await shot('03-solo')
await page.click('[data-act="goSolo"]')
await page.waitForFunction(() => document.querySelector('[data-screen="hud"].is-active'), null, { timeout: 60000 })
await wait(1500)
await shot('04-countdown')
await page.keyboard.down('KeyW')
await wait(3200)
await shot('05-racing')
await page.keyboard.down('KeyD')
await page.keyboard.down('Space')
await wait(1400)
await shot('06-drift')
await page.keyboard.up('Space')
await page.keyboard.up('KeyD')
await wait(2500)
await shot('07-later')
const state = await page.evaluate(() => {
  const g = window.__game
  const s = g.app.session
  const c = s.sim.cars[0]
  return { tick: s.sim.tick, phase: s.sim.phase, gates: c.progress.gates, speed: c.vF, x: c.x, z: c.z, onRoad: c.loc.onRoad, place: c.place }
})
console.log('state', JSON.stringify(state))
await page.keyboard.up('KeyW')
await page.keyboard.press('Escape')
await wait(500)
await shot('08-pause')
console.log('errors', errors.length)
for (const e of errors.slice(0, 30)) console.log(e)
await browser.close()
