// Dev-only damage/airtime visual check: node scripts/damage-check.mjs [url] [outDir]
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-dmg'
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
const step = n => page.evaluate(k => { const a = window.__game.app; for (let i = 0; i < k; i += 1) a.step(); return a.session.sim.tick }, n)
await step(420)
// 1) Smoking (moderate damage).
await page.evaluate(() => { window.__game.app.session.sim.cars[0].damage = 0.5 })
for (let k = 0; k < 6; k += 1) { await step(3); await wait(250) }
await shot('01-smoking')
// 2) On fire (heavy damage).
await page.evaluate(() => { window.__game.app.session.sim.cars[0].damage = 0.85 })
for (let k = 0; k < 6; k += 1) { await step(3); await wait(250) }
await shot('02-fire')
// 3) Mega ramp flight: run until the player is high in the air.
const air = await page.evaluate(() => {
  const a = window.__game.app
  const c = a.session.sim.cars[0]
  c.damage = 0
  let best = 0
  for (let i = 0; i < 60 * 150; i += 1) {
    a.step()
    const h = c.y - c.loc.roadY
    if (!c.grounded && h > 9) return { tick: a.session.sim.tick, h, s: c.loc.s }
    best = Math.max(best, c.grounded ? 0 : h)
  }
  return { best }
})
console.log('air', JSON.stringify(air))
await wait(600)
await shot('03-airtime')
// 4) Wreck: force a big hit with the sim's damage path (car-car cause), then capture the burning wreck.
await page.evaluate(() => {
  const s = window.__game.app.session
  const c = s.sim.cars[0]
  c.damage = 0.95
})
await page.evaluate(() => { window.__game.app.session.autopilot[0] = false })
await page.keyboard.down('KeyW')
await page.keyboard.down('KeyD')
await wait(200)
const wrecked = await page.evaluate(() => {
  const a = window.__game.app
  const c = a.session.sim.cars[0]
  for (let i = 0; i < 60 * 20; i += 1) { a.step(); if (c.wreck > 0) return { tick: a.session.sim.tick } }
  return { wreck: c.wreck, damage: c.damage }
})
await page.keyboard.up('KeyW')
await page.keyboard.up('KeyD')
console.log('wreck', JSON.stringify(wrecked))
for (let k = 0; k < 4; k += 1) { await step(4); await wait(250) }
await shot('04-wreck')
await page.evaluate(() => { const a = window.__game.app; const c = a.session.sim.cars[0]; for (let i = 0; i < 200 && !(c.hold > 0 && c.hold < 2.6); i += 1) a.step() })
await wait(500)
await shot('05-hold')
console.log(errors.length ? errors.join('\n') : 'no errors')
await browser.close()
