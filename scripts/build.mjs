import { build } from 'esbuild'

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

console.log(`built dist/main/index.js and dist/preload/index.js (${kind})`)
