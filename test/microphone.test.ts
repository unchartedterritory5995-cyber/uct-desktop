import { describe, expect, it } from 'vitest'
import { createConsentStore, createMicrophoneGate, MICROPHONE_DIALOG_DETAIL } from '../src/main/policy/microphone'
import type { StoreFs } from '../src/main/windows/layout-store'

const O = 'https://uctintelligence.com'
const FILE = 'C:/ud/microphone-consent.json'

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  const ops: string[] = []
  const flags = { failWrite: false, writeOptions: [] as unknown[] }
  const fs: StoreFs = {
    readFile: (p) => {
      if (!files.has(p)) throw new Error('ENOENT')
      return files.get(p)!
    },
    writeFile: (p, d, o) => {
      if (flags.failWrite) throw new Error('EBUSY')
      ops.push(`write ${p}`)
      flags.writeOptions.push(o)
      files.set(p, d)
    },
    rename: (a, b) => (ops.push(`rename ${a} ${b}`), files.set(b, files.get(a)!), void files.delete(a)),
    mkdir: () => undefined,
  }
  return { fs, files, ops, flags }
}

describe('consent store', () => {
  it('keeps one boolean per origin, atomically, and survives a restart', () => {
    const { fs, files, ops, flags } = memFs()
    const s = createConsentStore({ file: FILE, fs })
    expect(s.get(O)).toBeUndefined()
    s.set(O, false)
    expect(s.get(O)).toBe(false)
    expect(ops).toEqual([`write ${FILE}.tmp`, `rename ${FILE}.tmp ${FILE}`])
    expect(flags.writeOptions).toEqual([{ flush: true }])
    expect(JSON.parse(files.get(FILE)!)).toEqual({ version: 1, origins: { [O]: false } })
    expect(createConsentStore({ file: FILE, fs }).get(O)).toBe(false)
  })
  it('refuses anything that is not an origin, and stores nothing but booleans', () => {
    const { fs, files } = memFs()
    const s = createConsentStore({ file: FILE, fs })
    s.set('not a url', true)
    s.set(`${O}/path?x=1`, true)
    s.set('javascript:1', true)
    expect(files.has(FILE)).toBe(true)
    expect(JSON.parse(files.get(FILE)!).origins).toEqual({ [O]: true }) // normalised to the origin
    s.set(O, 'yes' as never)
    expect(s.get(O)).toBe(true)
  })
  it('treats a corrupt or wrong-shape file as empty and keeps it as .bad', () => {
    const a = memFs({ [FILE]: '{nope' })
    expect(createConsentStore({ file: FILE, fs: a.fs }).get(O)).toBeUndefined()
    expect(a.files.get(`${FILE}.bad`)).toBe('{nope')
    const b = memFs({ [FILE]: JSON.stringify({ version: 1, origins: { [O]: 'yes' } }) })
    expect(createConsentStore({ file: FILE, fs: b.fs }).get(O)).toBeUndefined()
    expect(b.files.has(`${FILE}.bad`)).toBe(true)
  })
  it('a failed write keeps the answer in memory and never throws', () => {
    const { fs, flags } = memFs()
    const s = createConsentStore({ file: FILE, fs })
    flags.failWrite = true
    expect(() => s.set(O, true)).not.toThrow()
    expect(s.get(O)).toBe(true)
  })
  it('clear forgets every answer, in memory and on disk (Reset app data)', () => {
    const { fs, files } = memFs()
    const s = createConsentStore({ file: FILE, fs })
    s.set(O, false)
    s.clear()
    expect(s.get(O)).toBeUndefined()
    expect(JSON.parse(files.get(FILE)!).origins).toEqual({})
  })
})

describe('microphone gate', () => {
  function make(answer: boolean | Promise<boolean> = true) {
    const { fs } = memFs()
    const store = createConsentStore({ file: FILE, fs })
    let asked = 0
    const gate = createMicrophoneGate({ store })
    const ask = () => (asked++, Promise.resolve(answer))
    return { gate, store, ask, asked: () => asked }
  }
  it('asks on first use and remembers a yes', async () => {
    const { gate, ask, asked } = make(true)
    expect(gate.isGranted(O)).toBe(false)
    expect(await gate.request(O, ask)).toBe(true)
    expect(await gate.request(O, ask)).toBe(true)
    expect(asked()).toBe(1)
    expect(gate.isGranted(O)).toBe(true)
  })
  it('a first no stays no without asking again', async () => {
    const { gate, ask, asked } = make(false)
    expect(await gate.request(O, ask)).toBe(false)
    expect(await gate.request(O, ask)).toBe(false)
    expect(asked()).toBe(1)
    expect(gate.isGranted(O)).toBe(false)
  })
  it('two requests at once share one dialog', async () => {
    const { gate, ask, asked } = make(true)
    const [a, b] = await Promise.all([gate.request(O, ask), gate.request(O, ask)])
    expect([a, b]).toEqual([true, true])
    expect(asked()).toBe(1)
  })
  it('a dialog that fails counts as no for now but is not remembered', async () => {
    const { fs } = memFs()
    const store = createConsentStore({ file: FILE, fs })
    const gate = createMicrophoneGate({ store })
    expect(await gate.request(O, () => Promise.reject(new Error('boom')))).toBe(false)
    expect(store.get(O)).toBeUndefined()
  })
  it('says in the dialog that a no lasts until Reset app data', () => {
    expect(MICROPHONE_DIALOG_DETAIL).toMatch(/Reset app data/)
  })
})
