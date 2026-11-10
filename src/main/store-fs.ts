import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import type { LogFs } from './event-log'
import type { StoreFs } from './windows/layout-store'

/** The real filesystem for the small userData stores. `flush` makes the temp file durable before the rename. */
export const nodeStoreFs: StoreFs = {
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, d, o) => writeFileSync(p, d, { encoding: 'utf8', flush: o?.flush === true }),
  rename: (a, b) => renameSync(a, b),
  mkdir: (d) => void mkdirSync(d, { recursive: true }),
}

/** The real filesystem for the event log (synchronous, so a line is on disk before a crash can follow). */
export const nodeLogFs: LogFs = {
  appendFile: (p, d) => appendFileSync(p, d, 'utf8'),
  readFile: (p) => readFileSync(p, 'utf8'),
  writeFile: (p, d) => writeFileSync(p, d, 'utf8'),
  size: (p) => statSync(p).size,
  rename: (a, b) => renameSync(a, b),
  unlink: (p) => unlinkSync(p),
  exists: (p) => existsSync(p),
  mkdir: (d) => void mkdirSync(d, { recursive: true }),
}
