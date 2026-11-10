import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createRecovery, isMarketHours, MAX_RELOADS, UNRESPONSIVE_MS, type DialogLike } from '../src/main/recovery'
import type { Clock } from '../src/main/load-guard'

// 2026-11-09 is a Monday; 15:00 UTC = 10:00 ET (market open), 23:00 UTC = 18:00 ET (closed).
const MON_OPEN = Date.UTC(2026, 10, 9, 15, 0, 0)
const MON_CLOSED = Date.UTC(2026, 10, 9, 23, 0, 0)
const SAT = Date.UTC(2026, 10, 14, 16, 0, 0)

function setup(startAt = MON_CLOSED, answers: number[] = []) {
  let t = startAt
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout: (fn, ms) => (timers.set(++id, { at: t + ms, fn }), id),
    clearTimeout: (h) => void timers.delete(h as number),
  }
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const next = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      timers.delete(next[0])
      t = next[1].at
      next[1].fn()
    }
    t = end
  }
  const wc = Object.assign(new EventEmitter(), { reloads: 0, reload() { this.reloads++ } })
  const children = [0, 1, 2].map(() => ({ destroyed: false, destroy() { this.destroyed = true }, isDestroyed() { return this.destroyed } }))
  const win = { webContents: wc, isDestroyed: () => false, getChildWindows: () => children }
  const asked: { buttons: string[]; defaultId?: number }[] = []
  const dialog: DialogLike = {
    showMessageBox: async (o) => {
      asked.push({ buttons: o.buttons, defaultId: o.defaultId })
      return { response: answers.shift() ?? 0 }
    },
  }
  const errors: string[] = []
  const rec = createRecovery({ win, now: () => t, dialog, clock, showError: (k) => void errors.push(k) })
  return { rec, wc, children, advance, asked, errors, setNow: (n: number) => void (t = n) }
}

const gone = (wc: EventEmitter, reason = 'crashed') => wc.emit('render-process-gone', {}, { reason })
const flush = () => new Promise((r) => setImmediate(r))

describe('isMarketHours', () => {
  it('is 9:30-16:00 ET on weekdays only', () => {
    expect(isMarketHours(MON_OPEN)).toBe(true)
    expect(isMarketHours(Date.UTC(2026, 10, 9, 14, 29))).toBe(false) // 9:29 ET
    expect(isMarketHours(Date.UTC(2026, 10, 9, 14, 30))).toBe(true) // 9:30 ET
    expect(isMarketHours(Date.UTC(2026, 10, 9, 20, 59))).toBe(true) // 15:59 ET
    expect(isMarketHours(Date.UTC(2026, 10, 9, 21, 0))).toBe(false) // 16:00 ET
    expect(isMarketHours(MON_CLOSED)).toBe(false)
    expect(isMarketHours(SAT)).toBe(false)
  })
})

describe('render-process-gone', () => {
  it('destroys every child window, then reloads', () => {
    const { wc, children } = setup()
    gone(wc)
    expect(children.every((c) => c.destroyed)).toBe(true)
    expect(wc.reloads).toBe(1)
  })
  it('ignores a clean exit', () => {
    const { wc, children } = setup()
    gone(wc, 'clean-exit')
    expect(wc.reloads).toBe(0)
    expect(children.some((c) => c.destroyed)).toBe(false)
  })
  it('allows 3 reloads in 10 minutes, then shows the error page instead', () => {
    const { wc, advance, errors } = setup()
    for (let i = 0; i < MAX_RELOADS; i++) {
      gone(wc)
      advance(60_000)
    }
    expect(wc.reloads).toBe(3)
    gone(wc)
    expect(wc.reloads).toBe(3)
    expect(errors).toEqual(['origin-error'])
  })
  it('forgets crashes older than 10 minutes', () => {
    const { wc, advance, errors } = setup()
    for (let i = 0; i < 3; i++) gone(wc)
    advance(10 * 60_000 + 1)
    gone(wc)
    expect(wc.reloads).toBe(4)
    expect(errors).toEqual([])
  })
})

describe('unresponsive', () => {
  it('does nothing for 20 seconds, then asks Wait or Reload', async () => {
    const { wc, advance, asked } = setup()
    wc.emit('unresponsive')
    advance(UNRESPONSIVE_MS - 1)
    await flush()
    expect(asked).toEqual([])
    advance(1)
    await flush()
    expect(asked.length).toBe(1)
    expect(asked[0].buttons).toEqual(['Wait', 'Reload'])
  })
  it('cancels the timer when the page recovers', async () => {
    const { wc, advance, asked } = setup()
    wc.emit('unresponsive')
    advance(10_000)
    wc.emit('responsive')
    advance(60_000)
    await flush()
    expect(asked).toEqual([])
  })
  it('reloads only when the member chooses Reload, and destroys children first', async () => {
    const { wc, advance, children } = setup(MON_CLOSED, [1])
    wc.emit('unresponsive')
    advance(UNRESPONSIVE_MS)
    await flush()
    expect(wc.reloads).toBe(1)
    expect(children.every((c) => c.destroyed)).toBe(true)
  })
  it('Wait never reloads and asks again 20 seconds later if still stuck', async () => {
    const { wc, advance, asked } = setup(MON_CLOSED, [0, 0])
    wc.emit('unresponsive')
    advance(UNRESPONSIVE_MS)
    await flush()
    expect(wc.reloads).toBe(0)
    advance(UNRESPONSIVE_MS)
    await flush()
    expect(asked.length).toBe(2)
    expect(wc.reloads).toBe(0)
  })
  it('never kills on its own in market hours: Wait is the default and nothing reloads unasked', async () => {
    const { wc, advance, asked } = setup(MON_OPEN)
    wc.emit('unresponsive')
    advance(10 * 60_000)
    await flush()
    expect(wc.reloads).toBe(0)
    expect(asked[0].defaultId).toBe(0)
  })
  it('stops asking once responsive again', async () => {
    const { wc, advance, asked } = setup(MON_CLOSED, [0])
    wc.emit('unresponsive')
    advance(UNRESPONSIVE_MS)
    await flush()
    wc.emit('responsive')
    advance(UNRESPONSIVE_MS * 3)
    await flush()
    expect(asked.length).toBe(1)
  })
})

describe('dispose', () => {
  it('detaches the listeners and timers', () => {
    const { rec, wc, advance } = setup()
    wc.emit('unresponsive')
    rec.dispose()
    advance(UNRESPONSIVE_MS * 2)
    gone(wc)
    expect(wc.reloads).toBe(0)
  })
})
