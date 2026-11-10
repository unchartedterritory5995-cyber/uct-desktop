import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

const kind = process.env.UCT_BUILD_KIND === 'dev' ? 'dev' : 'production'

await build({
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'koffi'],
  sourcemap: true,
  define: { __BUILD_KIND__: JSON.stringify(kind) },
})

// The preload runs sandboxed: one self-contained CJS file that requires only 'electron'.
await build({
  entryPoints: ['src/preload/index.ts'],
  outfile: 'dist/preload/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
})

// The title bar page gets its own tiny sandboxed preload, separate from the website bridge.
await build({
  entryPoints: ['src/preload/bar.ts'],
  outfile: 'dist/preload/bar.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
})

// The offline page is plain static files, served by name from dist/pages.
mkdirSync('dist/pages', { recursive: true })
cpSync('pages', 'dist/pages', { recursive: true })

console.log(`built dist/main/index.js and dist/preload/index.js (${kind})`)
