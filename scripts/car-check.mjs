// Dev-only new-car check: node scripts/car-check.mjs [url] [outDir]
// Captures the newest chassis (the last one, reached with prevCar from the first) in the garage in its
// factory livery and a second livery, then on track. CAR = model key, SWATCH = factory livery index.
// e.g. CAR=scorchquill SWATCH=7 node scripts/car-check.mjs   (defaults: stingbolt / 6)
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-car'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.setDefaultTimeout(180000)
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`) })
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
const shot = async name => { await page.screenshot({ path: `${out}/${name}.png`, timeout: 150000 }); console.log('shot', name) }
const active = s => page.waitForFunction(n => document.querySelector(`[data-screen="${n}"].is-active`), s, { timeout: 180000, polling: 500 })
const CAR = process.env.CAR ?? 'stingbolt'
const SWATCH = process.env.SWATCH ?? '6'
const glb = page.waitForResponse(r => r.url().includes(`/models/${CAR}.glb`) && r.ok(), { timeout: 240000 })
await page.goto(url)
await active('title')
await page.keyboard.press('Enter')
await active('garage')
for (let i = 0; i < Number(process.env.PREV ?? (CAR === 'stingbolt' ? 2 : 1)); i++) {
  await page.click('[data-screen="garage"] [data-act="prevCar"]', { force: true })
  await page.waitForTimeout(150)
}
await page.click(`[data-g="swatches"] [data-swatch="${SWATCH}"]`, { force: true })
console.log('car name', await page.textContent('[data-screen="garage"] .car-name'))
console.log('livery', await page.textContent('[data-g="livery"]'))
console.log('swatch count', await page.locator('[data-g="swatches"] .swatch').count())
await glb
console.log(`${CAR}.glb downloaded`)
await page.waitForTimeout(8000)
await shot('01-garage-factory')
if (process.env.GARAGE_ONLY) { console.log(errors.length ? errors.join('\n') : 'no errors'); await browser.close(); process.exit(0) }
await page.click('[data-g="swatches"] [data-swatch="0"]', { force: true })
await page.waitForTimeout(3000)
await shot('02-garage-crimson')
await page.click(`[data-g="swatches"] [data-swatch="${SWATCH}"]`, { force: true })
const saved = await page.evaluate(() => { const d = JSON.parse(localStorage.getItem('canyon-circuit.save')); return { chassis: d.chassis, livery: d.livery } })
console.log('saved', saved)
await page.click('[data-mode="solo"]', { force: true })
await page.click('[data-act="goSolo"]', { force: true })
await active('hud')
await page.evaluate(() => { const a = window.__game.app; for (let i = 0; i < 260; i += 1) a.step() })
await page.waitForTimeout(2500)
await shot('03-race-grid')
await page.keyboard.down('ArrowUp')
await page.evaluate(() => { const a = window.__game.app; for (let i = 0; i < 240; i += 1) a.step() })
await page.waitForTimeout(1500)
await shot('04-race-driving')
await page.keyboard.up('ArrowUp')
console.log(errors.length ? errors.join('\n') : 'no errors')
await browser.close()
