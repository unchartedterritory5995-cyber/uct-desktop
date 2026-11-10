import { describe, expect, it } from 'vitest'
import { createLayoutStore, MAX_ENTRIES, type StoreFs } from '../src/main/windows/layout-store'
import type { WindowRecord } from '../src/main/windows/display'

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const ops: string[] = []
  const fs: StoreFs = {
    readFile: (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(p)!
    },
    writeFile: (p, d) => (ops.push(`write ${p}`), void files.set(p, d)),
    rename: (a, b) => {
      ops.push(`rename ${a} ${b}`)
      files.set(b, files.get(a)!)
      files.delete(a)
    },
    mkdir: () => void ops.push('mkdir'),
  }
  return { fs, files, ops }
}

const rec = (n = 0, savedAt = 1): WindowRecord => ({
  bounds: { x: n, y: 0, width: 800, height: 600 },
  isMaximized: false,
  isFullScreen: false,
  display: { fingerprint: 'f', origin: { x: 0, y: 0 }, scaleFactor: 1 },
  savedAt,
})
const FILE = 'C:/ud/desk-layout.json'

describe('layout store', () => {
  it('round-trips a record by profile and name', () => {
    const { fs } = memFs()
    const s = createLayoutStore({ file: FILE, fs })
    s.saveWindow('p1', 'uct-board-a', rec(5))
    expect(s.getWindow('p1', 'uct-board-a')).toEqual(rec(5))
    expect(s.getWindow('p2', 'uct-board-a')).toBeUndefined()
    const again = createLayoutStore({ file: FILE, fs })
    expect(again.getWindow('p1', 'uct-board-a')).toEqual(rec(5))
  })
  it('writes a temp file then renames it over the real one', () => {
    const { fs, ops } = memFs()
    createLayoutStore({ file: FILE, fs }).saveWindow('p', 'uct-widget-1', rec())
    expect(ops.filter((o) => o !== 'mkdir')).toEqual([`write ${FILE}.tmp`, `rename ${FILE}.tmp ${FILE}`])
  })
  it('treats a corrupt file as empty and keeps it as .bad', () => {
    const { fs, files } = memFs({ [FILE]: '{not json' })
    const s = createLayoutStore({ file: FILE, fs })
    expect(s.getWindow('p', 'uct-board-a')).toBeUndefined()
    expect(files.get(`${FILE}.bad`)).toBe('{not json')
    s.saveWindow('p', 'uct-board-a', rec())
    expect(JSON.parse(files.get(FILE)!).version).toBe(1)
  })
  it('treats a wrong-shape file as corrupt', () => {
    const { fs, files } = memFs({ [FILE]: JSON.stringify({ version: 1, profiles: { p: { n: { bounds: 'x' } } } }) })
    expect(createLayoutStore({ file: FILE, fs }).getWindow('p', 'n')).toBeUndefined()
    expect(files.has(`${FILE}.bad`)).toBe(true)
  })
  it('caps the store at 200 entries, dropping the oldest', () => {
    const { fs } = memFs()
    const s = createLayoutStore({ file: FILE, fs })
    for (let i = 0; i < MAX_ENTRIES + 5; i++) s.saveWindow('p', `uct-board-${i}`, rec(i, i + 1))
    expect(s.count()).toBe(MAX_ENTRIES)
    expect(s.getWindow('p', 'uct-board-0')).toBeUndefined()
    expect(s.getWindow('p', `uct-board-${MAX_ENTRIES + 4}`)).toBeDefined()
  })
  it('refuses names that are not board or widget names, and stores only the allowed fields', () => {
    const { fs, files } = memFs()
    const s = createLayoutStore({ file: FILE, fs })
    s.saveWindow('p', '../evil', rec())
    s.saveWindow('p', '__proto__', rec())
    expect(s.count()).toBe(0)
    const noisy = { ...rec(), price: 123.45, symbol: 'AAPL' } as unknown as WindowRecord
    s.saveWindow('p', 'uct-board-a', noisy)
    expect(files.get(FILE)).not.toContain('AAPL')
    expect(files.get(FILE)).not.toContain('price')
  })
})
