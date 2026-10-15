import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { previewResourceId } from './identity.mjs'

// Response-only development injection. Vite build and vite preview do not install it.
export function manusGameTuning() {
  let root

  const parent = readFileSync(new URL('../__manus__/preview-parent.js', import.meta.url), 'utf8')
  const bridge = readFileSync(new URL('../__manus__/game-tuning.js', import.meta.url), 'utf8')
  return {
    name: 'manus-game-tuning',
    apply: 'serve',
    configResolved(config) { root = config.root },
    transformIndexHtml: {
      order: 'pre',
      async handler() {
        const resourceId = await previewResourceId(root)
        if (!resourceId) return []
        return [
          { tag: 'meta', attrs: { name: 'manus-game-preview-resource', content: resourceId }, injectTo: 'head-prepend' },
          { tag: 'meta', attrs: { name: 'manus-game-preview-generation', content: randomBytes(32).toString('hex') }, injectTo: 'head-prepend' },
          { tag: 'script', children: parent + '\n;\n' + bridge, injectTo: 'head-prepend' },
        ]
      },
    },
    // The game is the parameter-store owner. A source edit replaces its runtime so
    // pending values and adapters can never survive against changed definitions.
    handleHotUpdate(ctx) {
      if (!ctx.modules.length) return
      ctx.server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}
