// End-to-end smoke test: builds must already exist in dist/ (`npm run build`).
// Serves dist/, boots the game in headless Chromium, plays a few seconds, walks the menus in
// English and Chinese, fails on any console error, and writes screenshots to ./shots/.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', detached: false })
let browser
const guard = setTimeout(() => fail('timed out'), 120_000)

function cleanup() {
  clearTimeout(guard)
  try { server.kill('SIGTERM') } catch {}
}
async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('preview server did not start')
}

async function openGame(context, errors) {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && errors.push(m.text()))
  page.on('pageerror', e => errors.push(String(e)))
  page.on('response', r => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${r.url()}`))
  await page.goto(url)
  await page.waitForSelector('[data-screen="title"].is-active', { timeout: 30_000 })
  await page.evaluate(async () => {
    await document.fonts.ready
    const expected = document.documentElement.lang === 'zh-CN' ? 'ManusCC0 Sans CJK SC' : 'ManusCC0'
    for (const selector of ['.logo-text', '.tagline']) {
      const family = getComputedStyle(document.querySelector(selector)).fontFamily
      if (!family.startsWith(`"${expected}"`) && !family.startsWith(expected + ',')) {
        throw new Error(`Unexpected game font: ${family}`)
      }
    }
    if (![...document.fonts].some(face => face.family.replaceAll('"', '').replaceAll("'", '') === expected && face.status === 'loaded')) {
      throw new Error(`Bundled font did not load: ${expected}`)
    }
  })
  await page.waitForTimeout(900)
  return page
}

const state = page => page.evaluate(() => {
  const { game } = window.__game
  const p = game['player'].root.position
  return { mode: game.mode, run: game.run, pos: { x: p.x, y: p.y, z: p.z } }
})

try {
  await waitForServer()
  // Prefer Playwright's bundled Chromium; fall back to an installed Google Chrome.
  const args = ['--ignore-gpu-blocklist']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []

  const en = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const page = await openGame(en, errors)
  await page.screenshot({ path: `${out}/01-title-en.png` })

  await page.click('[data-action="play"]')
  await page.waitForSelector('[data-screen="hud"].is-active')
  const before = await state(page)
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(700)
  await page.keyboard.press('Space')
  await page.waitForTimeout(900)
  await page.keyboard.up('KeyW')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/02-gameplay.png` })
  const after = await state(page)
  const moved = Math.hypot(after.pos.x - before.pos.x, after.pos.z - before.pos.z)
  if (after.mode !== 'playing') throw new Error(`expected playing, got ${after.mode}`)
  if (!(after.run.timeLeft < before.run.timeLeft)) throw new Error('clock did not run')
  if (moved < 2) throw new Error(`player barely moved (${moved.toFixed(2)} m)`)
  console.log(`smoke: moved ${moved.toFixed(1)} m, clock ${after.run.timeLeft.toFixed(1)} s`)

  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-screen="pause"].is-active')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/03-pause.png` })
  await page.click('[data-screen="pause"] [data-action="settings"]')
  await page.waitForSelector('[data-screen="settings"].is-active')
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${out}/04-settings.png` })
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-screen="pause"].is-active')
  await page.waitForTimeout(300)
  if ((await state(page)).mode !== 'paused') throw new Error('leaving Settings with Escape resumed the run')

  // Results: finish the run through the real rules by collecting the remaining cores.
  await page.evaluate(() => {
    const { game } = window.__game
    const cores = game['cores']
    game.resume()
    for (const p of cores.remaining()) {
      game['player'].teleport(p)
      game.step(1 / 60)
    }
  })
  await page.waitForSelector('[data-screen="results"].is-active', { timeout: 10_000 })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/05-results.png` })
  const done = await state(page)
  if (done.run.phase !== 'won') throw new Error(`expected a won run, got ${done.run.phase}`)
  await en.close()

  const zh = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' })
  const zhPage = await openGame(zh, errors)
  const lang = await zhPage.evaluate(() => document.documentElement.lang)
  if (lang !== 'zh-CN') throw new Error(`browser language not detected (lang=${lang})`)
  await zhPage.screenshot({ path: `${out}/06-title-zh.png` })
  await zh.close()

  const phone = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' })
  const phonePage = await openGame(phone, errors)
  await phonePage.tap('[data-action="play"]')
  await phonePage.waitForSelector('[data-screen="hud"].is-active')
  await phonePage.waitForTimeout(1200)
  await phonePage.screenshot({ path: `${out}/07-phone-hud.png` })
  await phone.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  await browser.close()
  cleanup()
  console.log(`smoke: OK — screenshots in ${out}/`)
} catch (err) {
  await fail(err?.message ?? String(err))
}
