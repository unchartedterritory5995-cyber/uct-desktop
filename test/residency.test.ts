import { describe, expect, it } from 'vitest'
import { createResidency, IDLE_BEFORE_INSTALL_MS, INSTALL_CHECK_MS, launchedHidden } from '../src/main/residency'
import type { Clock } from '../src/main/load-guard'

// 2026-11-10 is a Tuesday. 15:00 UTC = 10:00 ET (open); 23:00 UTC = 18:00 ET (after-hours trading);
// Wed 03:00 UTC = Tue 22:00 ET (quiet: outside the 4:00-20:00 extended session).
const OPEN = Date.UTC(2026, 10, 10, 15, 0)
const AFTER_HOURS = Date.UTC(2026, 10, 10, 23, 0)
const CLOSED = Date.UTC(2026, 10, 11, 3, 0)

function setup(start: number, pending = true) {
  let t = start
  let id = 0
  const timers = new Map<number, { at: number; every: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout: (fn, ms) => (timers.set(++id, { at: t + ms, every: 0, fn }), id),
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
  const log: string[] = []
  const state = { pending, visible: true, busy: false }
  const r = createResidency({
    clock,
    now: () => t,
    hideAll: () => { state.visible = false; log.push('hide') },
    showAll: () => { state.visible = true; log.push('show') },
    hasPendingUpdate: () => state.pending,
    isBusy: () => state.busy,
    installUpdate: () => log.push('install'),
  })
  return { r, log, advance, state, timers }
}

describe('createResidency', () => {
  it('closing the window hides the whole desk instead of quitting', () => {
    const { r, log } = setup(CLOSED)
    expect(r.onClose()).toBe('hide')
    expect(log).toEqual(['hide'])
  })

  it('a real Quit lets the close through', () => {
    const { r, log } = setup(CLOSED)
    r.quitRequested()
    expect(r.onClose()).toBe('allow')
    expect(log).toEqual([])
  })

  it('open from the tray shows everything again', () => {
    const { r, log } = setup(CLOSED)
    r.onClose()
    r.open()
    expect(log).toEqual(['hide', 'show'])
  })

  it('installs a pending update after hours once the app has been hidden long enough', () => {
    const { r, log, advance } = setup(CLOSED)
    r.onClose()
    advance(IDLE_BEFORE_INSTALL_MS - 1)
    expect(log).not.toContain('install')
    advance(INSTALL_CHECK_MS + 1)
    expect(log.filter((x) => x === 'install')).toHaveLength(1)
    advance(10 * INSTALL_CHECK_MS)
    expect(log.filter((x) => x === 'install')).toHaveLength(1)
  })

  it('never installs in market hours, even hidden for hours', () => {
    const { r, log, advance } = setup(OPEN)
    r.onClose()
    advance(4 * 60 * 60_000) // 10:00 to 14:00 ET
    expect(log).not.toContain('install')
  })

  it('never installs while a window is showing', () => {
    const { r, log, advance } = setup(CLOSED)
    r.onClose()
    r.open()
    advance(5 * IDLE_BEFORE_INSTALL_MS)
    expect(log).not.toContain('install')
  })

  it('never installs during after-hours trading (18:00 ET)', () => {
    const { r, log, advance } = setup(AFTER_HOURS)
    r.onClose()
    advance(60 * 60_000) // 18:00 to 19:00 ET
    expect(log).not.toContain('install')
  })

  it('never installs while something is at stake, and installs once it clears', () => {
    const { r, log, advance, state } = setup(CLOSED)
    state.busy = true
    r.onClose()
    advance(3 * IDLE_BEFORE_INSTALL_MS)
    expect(log).not.toContain('install')
    state.busy = false
    advance(INSTALL_CHECK_MS)
    expect(log.filter((x) => x === 'install')).toHaveLength(1)
  })

  it('a cancelled quit (Stay) makes the app resident again', () => {
    const { r, log, advance } = setup(CLOSED)
    r.quitRequested()
    r.quitCancelled()
    expect(r.onClose()).toBe('hide')
    advance(IDLE_BEFORE_INSTALL_MS + INSTALL_CHECK_MS)
    expect(log).toContain('install')
  })

  it('opening the app restarts the idle wait', () => {
    const { r, log, advance } = setup(CLOSED)
    r.onClose()
    advance(IDLE_BEFORE_INSTALL_MS - INSTALL_CHECK_MS)
    r.open()
    r.onClose()
    advance(IDLE_BEFORE_INSTALL_MS - INSTALL_CHECK_MS)
    expect(log).not.toContain('install')
  })

  it('with nothing pending, nothing installs', () => {
    const { r, log, advance } = setup(CLOSED, false)
    r.onClose()
    advance(5 * IDLE_BEFORE_INSTALL_MS)
    expect(log).not.toContain('install')
  })

  it('dispose stops the check timer', () => {
    const { r, timers } = setup(CLOSED)
    r.dispose()
    expect(timers.size).toBe(0)
  })
})

describe('launchedHidden', () => {
  it('is true only for the start-with-Windows flag', () => {
    expect(launchedHidden(['app.exe', '--hidden'])).toBe(true)
    expect(launchedHidden(['app.exe'])).toBe(false)
    expect(launchedHidden(['app.exe', '--hidden=no'])).toBe(false)
  })
})
