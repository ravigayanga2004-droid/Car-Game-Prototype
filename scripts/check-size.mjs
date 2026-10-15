// Fails the build when the shipped bundle grows past the budget, so starter projects stay fast
// to load on mobile networks. JS/CSS are measured gzipped (what the CDN sends); fonts are already
// compressed woff2 and budgeted separately because CJK coverage is large.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const MB = 1024 * 1024
// transfer = everything fetched by the staged loader (boot stage first, the rest prefetched in the
// background); music = streamed on demand by <audio> decks, never blocking a stage.
// boot = what must arrive before the title screen (code, CSS, fonts, logo, loading art, UI SFX).
// transfer covers the photoreal car/prop GLBs, which stream in after the title is already interactive.
// share/ holds the OG social card and favicon copies for link-preview crawlers; the game never fetches them.
const BUDGET = { boot: 1.8 * MB, js: 2.0 * MB, fonts: 2.2 * MB, transfer: 9.0 * MB, music: 7.0 * MB }
const walk = dir => readdirSync(dir).flatMap(name => {
  const p = join(dir, name)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
const files = walk('dist').map(path => {
  const raw = readFileSync(path)
  const text = /\.(js|css|html|json|svg)$/.test(path)
  return { path, size: raw.length, wire: text ? gzipSync(raw).length : raw.length }
})
const sum = pred => files.filter(pred).reduce((n, f) => n + f.wire, 0)
const js = sum(f => f.path.endsWith('.js'))
const fonts = sum(f => f.path.endsWith('.woff2'))
const isMusic = f => /assets\/audio\/m-[^/]+\.mp3$/.test(f.path)
const isShare = f => /^dist\/share\//.test(f.path)
const transfer = sum(f => !f.path.endsWith('.txt') && !isMusic(f) && !isShare(f))
const music = sum(isMusic)
const boot = sum(f => /\.(js|css|html|woff2)$/.test(f.path) || /assets\/ui\/(logo|loading-bg)[^/]*$/.test(f.path) || /assets\/audio\/ui-[^/]+\.mp3$/.test(f.path))
const mb = n => `${(n / MB).toFixed(2)} MB`
console.log(`bundle (gzip): boot ${mb(boot)} / js ${mb(js)} / fonts ${mb(fonts)} / staged transfer ${mb(transfer)} / streamed music ${mb(music)}`)
const over = Object.entries({ boot, js, fonts, transfer, music }).filter(([k, v]) => v > BUDGET[k])
if (over.length) {
  for (const [k, v] of over) console.error(`over budget: ${k} ${mb(v)} > ${mb(BUDGET[k])}`)
  process.exit(1)
}
