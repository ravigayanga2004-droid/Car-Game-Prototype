import { defineConfig } from 'vite'

// Bundles the deterministic simulation for the Node ghost service (no three.js, no DOM).
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'src/sim/server-entry.ts',
    outDir: 'server/lib',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'sim.mjs', format: 'es' } },
  },
})
