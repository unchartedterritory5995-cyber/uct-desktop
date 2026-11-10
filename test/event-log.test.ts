import { describe, expect, it } from 'vitest'
import { createEventLog, type LogFs } from '../src/main/event-log'

function memFs(): LogFs & { files: Map<string, string>; failAppend: boolean } {
  const files = new Map<string, string>()
  return {
    files,
    failAppend: false,
    appendFile(p, d) {
      if (this.failAppend) throw new Error('EACCES')
      files.set(p, (files.get(p) ?? '') + d)
    },
    readFile(p) {
      const v = files.get(p)
      if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return v
    },
    writeFile(p, d) { files.set(p, d) },
    size(p) { return files.get(p)?.length ?? 0 },
    rename(a, b) { const v = files.get(a); if (v === undefined) throw new Error('ENOENT'); files.set(b, v); files.delete(a) },
    unlink(p) { files.delete(p) },
    exists(p) { return files.has(p) },
    mkdir() {},
  }
}

const DIR = 'C:/u/logs'
const T0 = Date.UTC(2026, 10, 10, 18, 0, 0)

describe('createEventLog', () => {
  it('appends one JSON line per event with a UTC time', () => {
    const fs = memFs()
    const log = createEventLog({ dir: DIR, fs, now: () => T0 })
    log.record('render-process-gone', { reason: 'crashed', exitCode: -1 })
    const lines = fs.files.get(`${DIR}/events.log`)!.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ t: '2026-11-10T18:00:00.000Z', event: 'render-process-gone', reason: 'crashed', exitCode: -1 })
  })

  it('scrubs secrets and emails before anything reaches the disk', () => {
    const fs = memFs()
    const log = createEventLog({ dir: DIR, fs, now: () => T0 })
    log.record('load-failed', { url: 'https://uctintelligence.com/x?token=abc123secret', who: 'bob@example.com' })
    const text = fs.files.get(`${DIR}/events.log`)!
    expect(text).not.toContain('abc123secret')
    expect(text).not.toContain('bob@example.com')
  })

  it('rotates to events.1.log past the size cap, keeping one old file', () => {
    const fs = memFs()
    const log = createEventLog({ dir: DIR, fs, now: () => T0, maxBytes: 200 })
    for (let i = 0; i < 20; i++) log.record('tick', { i })
    expect(fs.exists(`${DIR}/events.1.log`)).toBe(true)
    expect(fs.size(`${DIR}/events.log`)).toBeLessThanOrEqual(200)
    expect([...fs.files.keys()].filter((k) => k.includes('events'))).toHaveLength(2)
  })

  it('never throws, even when the disk refuses', () => {
    const fs = memFs()
    fs.failAppend = true
    const log = createEventLog({ dir: DIR, fs, now: () => T0 })
    expect(() => log.record('x')).not.toThrow()
    expect(() => log.tail(5)).not.toThrow()
  })

  it('tail returns the newest lines across the rotation boundary', () => {
    const fs = memFs()
    const log = createEventLog({ dir: DIR, fs, now: () => T0, maxBytes: 200 })
    for (let i = 0; i < 20; i++) log.record('tick', { i })
    const tail = log.tail(3).map((l) => JSON.parse(l).i)
    expect(tail).toEqual([17, 18, 19])
  })

  it('reports an unclean previous exit once, and a clean one not at all', () => {
    const fs = memFs()
    const first = createEventLog({ dir: DIR, fs, now: () => T0 })
    expect(first.startSession('0.1.2')).toEqual({ previousUnclean: false })
    // The process dies here: no endSession.
    const second = createEventLog({ dir: DIR, fs, now: () => T0 + 60_000 })
    expect(second.startSession('0.1.3')).toEqual({ previousUnclean: true, previous: { version: '0.1.2', startedAt: '2026-11-10T18:00:00.000Z' } })
    second.endSession('quit')
    const third = createEventLog({ dir: DIR, fs, now: () => T0 + 120_000 })
    expect(third.startSession('0.1.3')).toEqual({ previousUnclean: false })
    const events = third.tail(20).map((l) => JSON.parse(l).event)
    expect(events).toEqual(['launch', 'previous-exit-unclean', 'launch', 'exit', 'launch'])
  })

  it('a corrupt session marker still counts as unclean and does not throw', () => {
    const fs = memFs()
    fs.files.set(`${DIR}/running.json`, '{not json')
    const log = createEventLog({ dir: DIR, fs, now: () => T0 })
    expect(log.startSession('0.1.2')).toEqual({ previousUnclean: true, previous: null })
  })
})
