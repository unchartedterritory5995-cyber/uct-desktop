import { describe, expect, it } from 'vitest'
import { createQuitController, focusExistingWindow, QUIT_WAIT_MS } from '../src/main/quit'
import { buildMenuTemplate, resetStorages } from '../src/main/menu'
import { buildDiagnostics, scrub } from '../src/main/diagnostics'
import type { Clock } from '../src/main/load-guard'

function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout: (fn, ms) => (timers.set(++id, { at: now + ms, fn }), id),
    clearTimeout: (h) => void timers.delete(h as number),
  }
  const advance = (ms: number) => {
    now += ms
    for (const [k, t] of [...timers]) if (t.at <= now) (timers.delete(k), t.fn())
  }
  return { clock, advance, pending: () => timers.size }
}

function make() {
  const c = fakeClock()
  const log: string[] = []
  const q = createQuitController({ sendBeforeQuit: () => void log.push('send'), finalize: () => void log.push('final'), clock: c.clock })
  return { q, log, ...c }
}

describe('quit controller', () => {
  it('sends onBeforeQuit, waits up to 500 ms for the ack, then closes', () => {
    const { q, log, advance } = make()
    expect(q.allowClose()).toBe(false)
    q.requestQuit('quit')
    expect(log).toEqual(['send'])
    advance(QUIT_WAIT_MS - 1)
    expect(log).toEqual(['send'])
    advance(1)
    expect(log).toEqual(['send', 'final'])
    expect(q.allowClose()).toBe(true)
  })
  it('closes as soon as the ack arrives, once', () => {
    const { q, log, advance, pending } = make()
    q.requestQuit('quit')
    q.ack()
    q.ack()
    q.requestQuit('quit')
    advance(5000)
    expect(log).toEqual(['send', 'final'])
    expect(pending()).toBe(0)
  })
  it('an ack with no quit pending does nothing', () => {
    const { q, log } = make()
    q.ack()
    expect(log).toEqual([])
  })
  it('session-end closes immediately without waiting or notifying', () => {
    const { q, log } = make()
    q.requestQuit('session-end')
    expect(log).toEqual(['final'])
    expect(q.allowClose()).toBe(true)
  })
  it('before-quit-for-update notifies once and never blocks a close', () => {
    const { q, log, advance } = make()
    q.beforeQuitForUpdate()
    q.beforeQuitForUpdate()
    expect(q.allowClose()).toBe(true)
    expect(log).toEqual(['send'])
    advance(5000)
    expect(log).toEqual(['send']) // the updater does the quitting; we never call finalize
  })
  it('does not notify twice when an update follows a quit request', () => {
    const { q, log } = make()
    q.requestQuit('quit')
    q.beforeQuitForUpdate()
    expect(log).toEqual(['send'])
  })
})

describe('single instance', () => {
  it('restores, shows and focuses the existing window', () => {
    const calls: string[] = []
    focusExistingWindow({
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => void calls.push('restore'),
      show: () => void calls.push('show'),
      focus: () => void calls.push('focus'),
    })
    expect(calls).toEqual(['restore', 'show', 'focus'])
    expect(() => focusExistingWindow(undefined)).not.toThrow()
  })
})

describe('app menu', () => {
  const t = buildMenuTemplate({ onAbout() {}, onCopyDiagnostics() {}, onResetAppData() {}, onQuit() {} })
  const roles = (label: string) => (t.find((m) => m.label === label)?.submenu as { role?: string }[]).map((i) => i.role)
  it('keeps the standard Edit roles so Ctrl+C and Ctrl+V work', () => {
    expect(roles('Edit')).toEqual(expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']))
  })
  it('leaves zoom to windows/zoom.ts', () => {
    expect(JSON.stringify(t)).not.toMatch(/zoomIn|zoomOut|resetZoom/)
  })
  it('has the Help items', () => {
    const labels = (t.find((m) => m.label === 'Help')?.submenu as { label?: string }[]).map((i) => i.label)
    expect(labels).toEqual(expect.arrayContaining(['About UCT Intelligence', 'Copy Diagnostics', 'Reset app data...']))
  })
  it('reset clears cookies only when asked', () => {
    expect(resetStorages(false)).not.toContain('cookies')
    expect(resetStorages(true)).toContain('cookies')
    expect(resetStorages(false)).toContain('localstorage')
  })
})

describe('diagnostics', () => {
  // Fixtures are assembled at runtime so a secret scan of the repo never matches them.
  const key = ['sk', 'live', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('_')
  const email = ['member', 'example.com'].join('@')
  const bearer = ['Bearer', 'abcdefghijklmnopqrstuvwxyz0123456789ABCD'].join(' ')
  it('scrubs secrets, emails, cookies and query strings', () => {
    const out = scrub(`k=${key} mail ${email} ${bearer} cookie: sid=abc123 url https://uctintelligence.com/a?token=zzz&x=1`)
    expect(out).not.toContain(key)
    expect(out).not.toContain(email)
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('token=zzz')
    expect(out).toContain('https://uctintelligence.com/a')
  })
  it('reports versions, process metrics and cache size, scrubbed', () => {
    const text = buildDiagnostics({
      appVersion: '0.1.1',
      versions: { electron: '45.2.3', chrome: '1', node: '2' },
      platform: 'win32 x64',
      metrics: [{ type: 'Tab', pid: 4, memoryKb: 1000, cpuPercent: 1.5, note: key }],
      cacheBytes: 2048,
    })
    expect(text).toContain('0.1.1')
    expect(text).toContain('Tab')
    expect(text).toContain('2048')
    expect(text).not.toContain(key)
  })
})
