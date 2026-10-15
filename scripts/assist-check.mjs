// Dev-only corner assist levels check: node scripts/assist-check.mjs [url] [outDir]
// Verifies per-player Off/Light/Strong settings (defaults + persistence), split-screen HUD chips
// (P1 Off hidden, P2 Light shown), live settings changes mid-race, the results ASSIST tag, and the
// personal-best tag in the garage.
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
const url = process.argv[2] ?? 'http://localhost:3000/'
const out = process.argv[3] ?? '/tmp/cc-assist'
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? '/usr/bin/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
page.setDefaultTimeout(180000)
const errors = []
const fails = []
const check = (label, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` (${extra})` : ''}`); if (!ok) fails.push(label) }
page.on('console', m => { if (m.type() === 'error') errors.push(`[error] ${m.text()}`) })
page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
const shot = async name => { await page.screenshot({ path: `${out}/${name}.png`, timeout: 150000 }); console.log('shot', name) }
const active = s => page.waitForFunction(n => document.querySelector(`[data-screen="${n}"].is-active`), s, { timeout: 180000, polling: 500 })
const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('canyon-circuit.save') ?? '{}'))
const selected = key => page.evaluate(k => document.querySelector(`[data-set="${k}"] button.sel`)?.dataset.v ?? null, key)
const openSettings = async () => {
  await page.click('[data-screen="garage"] [data-act="settings"]', { force: true })
  await page.waitForSelector('[data-modal="settings"].show', { timeout: 60000 })
}
const closeSettings = async () => {
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-modal="settings"].show'), null, { polling: 300 })
}

await page.goto(url)
await active('title')
await page.keyboard.press('Enter')
await active('garage')

// 1. Settings: both rows default to Strong; pick P1 Off, P2 Light and check they persist.
await openSettings()
check('defaults Strong/Strong', (await selected('assistP1')) === 'strong' && (await selected('assistP2')) === 'strong', `${await selected('assistP1')}/${await selected('assistP2')}`)
await page.click('[data-set="assistP1"] button[data-v="off"]', { force: true })
await page.click('[data-set="assistP2"] button[data-v="light"]', { force: true })
const s1 = await saved()
check('saved P1 off / P2 light', s1.assistP1 === 'off' && s1.assistP2 === 'light', `${s1.assistP1}/${s1.assistP2}`)
check('old boolean dropped', !('cornerAssist' in s1))
check('buttons reflect choice', (await selected('assistP1')) === 'off' && (await selected('assistP2')) === 'light')
await page.locator('[data-set="assistP2"]').scrollIntoViewIfNeeded()
await shot('01-settings-off-light')
await closeSettings()

// 2. Split-screen: P1 chip hidden (Off), P2 chip shows LIGHT.
await page.click('[data-mode="split"]', { force: true })
await page.click('[data-act="goSplit"]', { force: true })
await active('hud')
const modes = await page.evaluate(() => [...window.__game.app.session.assistModes])
check('session modes off/light', modes[0] === 'off' && modes[1] === 'light', modes.join('/'))
await page.evaluate(() => { const a = window.__game.app; for (let i = 0; i < 300; i += 1) a.step() })
// Software GPU: the HUD frame can land seconds after the sim steps, so wait for it to settle.
await page.waitForFunction(() => document.querySelector('.hud-view[data-view="1"] [data-h="assist"]')?.classList.contains('on'), null, { timeout: 60000, polling: 250 }).catch(() => {})
const chips = await page.evaluate(() => [0, 1].map(v => { const e = document.querySelector(`.hud-view[data-view="${v}"] [data-h="assist"]`); return e && { on: e.classList.contains('on'), text: e.textContent.trim() } }))
console.log('chips', JSON.stringify(chips))
check('P1 chip off', chips[0] && !chips[0].on)
check('P2 chip LIGHT', chips[1] && chips[1].on && /LIGHT/.test(chips[1].text))
await shot('02-split-chips')

// 3. Change a setting mid-race through the real save path; the live session must follow.
await page.evaluate(() => window.__game.ui.settings({ assistP1: 'strong' }))
const live = await page.evaluate(() => [...window.__game.app.session.assistModes])
check('mid-race settings reach session', live[0] === 'strong' && live[1] === 'light', live.join('/'))

// 4. Drive with assist on, end the race, and check the results tag on the human rows.
await page.keyboard.down('KeyW')
await page.keyboard.down('ArrowUp')
await page.evaluate(() => { const a = window.__game.app; for (let i = 0; i < 600; i += 1) a.step() })
await page.keyboard.up('KeyW')
await page.keyboard.up('ArrowUp')
await page.evaluate(() => window.__game.app.session.finish())
await active('results')
await page.waitForTimeout(1500)
const tags = await page.evaluate(() => document.querySelectorAll('[data-screen="results"] .assist-tag').length)
check('results show ASSIST tags', tags > 0, `${tags} tags`)
await shot('03-results-tags')

// 5. Personal bests: seed an assisted total with an unassisted lap through the save store.
await page.evaluate(() => { const s = window.__game.save; s.update({ bests: { ...s.data.bests, 'canyon-circuit': { total: 201.5, lap: 61.2, totalAssist: true } } }) })
await page.click('[data-screen="results"] [data-act="toGarage"]', { force: true })
await active('garage')
await page.waitForTimeout(800)
const bestTags = await page.evaluate(() => document.querySelectorAll('[data-g="bests"] .assist-tag').length)
check('garage best shows one ASSIST tag', bestTags === 1, `${bestTags} tags`)
await page.locator('[data-g="bests"]').screenshot({ path: `${out}/04-bests-tag.png` })
console.log('shot 04-bests-tag')

// Restore defaults so later manual testing starts from Strong/Strong.
await openSettings()
await page.click('[data-set="assistP1"] button[data-v="strong"]', { force: true })
await page.click('[data-set="assistP2"] button[data-v="strong"]', { force: true })
await closeSettings()

console.log(errors.length ? errors.join('\n') : 'no errors')
console.log(fails.length ? `FAILED: ${fails.join(', ')}` : 'ALL PASS')
await browser.close()
process.exit(fails.length ? 1 : 0)
