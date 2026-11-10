import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { StoreFs } from './windows/layout-store'

/** The real filesystem for the small userData stores. `flush` makes the temp file durable before the rename. */
export const nodeStoreFs: StoreFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, d, o) => writeFileSync(p, d, { encoding: 'utf8', flush: o?.flush === true }),
  rename: (a, b) => renameSync(a, b),
  mkdir: (d) => void mkdirSync(d, { recursive: true }),
}
