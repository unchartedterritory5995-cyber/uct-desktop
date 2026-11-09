import { build } from 'esbuild'

const kind = process.env.UCT_BUILD_KIND === 'dev' ? 'dev' : 'production'

await build({
  entryPoints: ['src/main/index.ts'],
  outfile: 'dist/main/index.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  sourcemap: true,
  define: { __BUILD_KIND__: JSON.stringify(kind) },
})

console.log(`built dist/main/index.js (${kind})`)
