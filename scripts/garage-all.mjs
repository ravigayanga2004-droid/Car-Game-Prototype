// Dev-only: node scripts/garage-all.mjs [url] [outDir]
// Captures every chassis in the garage (Pearl livery for shape review, plus the house schemes) for the IP audit.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-garage'
mkdirSync(out, { recursive: true })
const KEYS = ['mesa', 'dune', 'arroyo', 'sidewinder', 'longhorn', 'stingbolt', 'scorchquill']
const HOUSE = { stingbolt: 6, scorchquill: 7 }
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.setDefaultTimeout(180000)
const errors = []
const loaded = new Set()
page.on('console', m => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`) })
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
page.on('response', r => { const m = r.url().match(/\/models\/([a-z]+)\.glb/); if (m && r.ok()) loaded.add(m[1]) })
const active = s => page.waitForFunction(n => document.querySelector(`[data-screen="${n}"].is-active`), s, { timeout: 180000, polling: 500 })
await page.addInitScript(() => { try { const k = 'canyon-circuit.save'; const d = JSON.parse(localStorage.getItem(k) || '{}'); d.chassis = 0; localStorage.setItem(k, JSON.stringify(d)) } catch {} })
await page.goto(url)
await active('title')
await page.keyboard.press('Enter')
await active('garage')
for (let i = 0; i < KEYS.length; i++) {
  const key = KEYS[i]
  if (i > 0) { await page.click('[data-screen="garage"] [data-act="nextCar"]', { force: true }); await page.waitForTimeout(200) }
  const t0 = Date.now()
  while (!loaded.has(key) && Date.now() - t0 < 240000) await page.waitForTimeout(500)
  const name = (await page.textContent('[data-screen="garage"] .car-name'))?.trim()
  await page.click('[data-g="swatches"] [data-swatch="5"]', { force: true })
  await page.waitForTimeout(6000)
  await page.screenshot({ path: `${out}/${i}-${key}-pearl.png`, timeout: 150000 })
  console.log('shot', i, key, name, loaded.has(key) ? 'glb ok' : 'GLB NOT SEEN')
  if (HOUSE[key] !== undefined) {
    await page.click(`[data-g="swatches"] [data-swatch="${HOUSE[key]}"]`, { force: true })
    await page.waitForTimeout(3000)
    await page.screenshot({ path: `${out}/${i}-${key}-house.png`, timeout: 150000 })
    console.log('shot', i, key, 'house', (await page.textContent('[data-g="livery"]'))?.trim())
  }
}
console.log(errors.length ? errors.join('\n') : 'no errors')
await browser.close()
