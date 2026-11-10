import { describe, expect, it } from 'vitest'
import { createQuitController, focusExistingWindow, QUIT_WAIT_MS } from '../src/main/quit'
import { buildMenuTemplate, performReset, resetStorages } from '../src/main/menu'
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
  it('session-end notifies the site first, then closes immediately without waiting', () => {
    const { q, log, pending } = make()
    q.requestQuit('session-end')
    expect(log).toEqual(['send', 'final'])
    expect(pending()).toBe(0)
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
  it('prepareForUpdate sends, then resolves on ack or after 500 ms, and never blocks afterwards', async () => {
    const a = make()
    let done = false
    void a.q.prepareForUpdate().then(() => (done = true))
    expect(a.log).toEqual(['send'])
    a.advance(QUIT_WAIT_MS - 1)
    await Promise.resolve()
    expect(done).toBe(false)
    expect(a.q.allowClose()).toBe(false)
    a.advance(1)
    await Promise.resolve()
    expect(done).toBe(true)
    expect(a.q.allowClose()).toBe(true)
    expect(a.log).toEqual(['send']) // the updater quits; finalize is never called
    const b = make()
    const p = b.q.prepareForUpdate()
    b.q.ack()
    await p
    expect(b.q.allowClose()).toBe(true)
    expect(b.pending()).toBe(0)
    await b.q.prepareForUpdate() // already ready: resolves at once
    expect(b.log).toEqual(['send'])
  })
  it('does not notify twice when an update follows a quit request', () => {
    const { q, log } = make()
    q.requestQuit('quit')
    q.beforeQuitForUpdate()
    expect(log).toEqual(['send'])
  })
})

describe('beforeunload cancelling a quit', () => {
  it('a member close asks; Leave unloads anyway', () => {
    const { q } = make()
    q.requestQuit('quit')
    let asked = 0
    expect(q.handleUnloadPrevented(() => (asked++, true))).toBe(true)
    expect(asked).toBe(1)
  })
  it('Stay resets the quit so a later X starts over and notifies the site again', () => {
    const { q, log, advance } = make()
    q.requestQuit('quit')
    expect(q.handleUnloadPrevented(() => false)).toBe(false)
    advance(5000)
    expect(log).toEqual(['send']) // the pending finalize was cancelled
    expect(q.allowClose()).toBe(false)
    q.requestQuit('quit')
    expect(log).toEqual(['send', 'send'])
    advance(QUIT_WAIT_MS)
    expect(log).toEqual(['send', 'send', 'final'])
  })
  it('Stay after the quit already finalized also resets it', () => {
    const { q } = make()
    q.requestQuit('quit')
    q.ack()
    expect(q.allowClose()).toBe(true)
    expect(q.handleUnloadPrevented(() => false)).toBe(false)
    expect(q.allowClose()).toBe(false)
  })
  it('the update path and session-end always leave, never asking', () => {
    const a = make()
    a.q.beforeQuitForUpdate()
    expect(a.q.handleUnloadPrevented(() => { throw new Error('asked') })).toBe(true)
    const b = make()
    b.q.requestQuit('session-end')
    expect(b.q.handleUnloadPrevented(() => { throw new Error('asked') })).toBe(true)
  })
  it('outside a quit it does not interfere with the page', () => {
    const { q } = make()
    expect(q.handleUnloadPrevented(() => true)).toBe(false)
  })
  it('session-end during the 500 ms wait closes immediately', () => {
    const { q, log, advance, pending } = make()
    q.requestQuit('quit')
    q.requestQuit('session-end')
    expect(log).toEqual(['send', 'final'])
    expect(pending()).toBe(0)
    advance(5000)
    expect(log).toEqual(['send', 'final'])
  })
})

describe('reset order', () => {
  const steps = (log: string[], failClear = false) => ({
    destroyChildren: () => void log.push('children'),
    showShell: async () => void log.push('shell'),
    clearStorage: async (c: boolean) => {
      log.push(`clear:${c}`)
      if (failClear) throw new Error('boom')
    },
    loadSite: () => void log.push('site'),
  })
  it('destroys popups, shows the shell, clears, then loads the site', async () => {
    const log: string[] = []
    await performReset(steps(log), true)
    expect(log).toEqual(['children', 'shell', 'clear:true', 'site'])
  })
  it('still reloads the site when clearing fails', async () => {
    const log: string[] = []
    await expect(performReset(steps(log, true), false)).rejects.toThrow('boom')
    expect(log.at(-1)).toBe('site')
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
  it('has no Alt+F4 accelerator, so closing a popped board only closes itself', () => {
    expect(JSON.stringify(t)).not.toMatch(/Alt\+F4|accelerator/)
  })
  it('does not offer websql', () => {
    expect(resetStorages(true) as string[]).not.toContain('websql')
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
  it('scrubs Authorization: Basic and other schemes', () => {
    const basic = ['dXNlcjpwYXNzd29yZA', '=='].join('')
    const out = scrub(`Authorization: Basic ${basic}\nproxy-authorization: Digest abc123def456\nauthorization=Bearer ${'q'.repeat(30)}`)
    expect(out).not.toContain(basic)
    expect(out).not.toContain('abc123def456')
    expect(out).not.toContain('q'.repeat(30))
  })
  it('scrubs JSON-shaped secrets and common variants', () => {
    const json = `{"${['access', 'token'].join('_')}":"AAA111","${['refresh', 'token'].join('_')}": "BBB222","password":"hunter2","note":"keep me"}`
    const out = scrub(json)
    for (const v of ['AAA111', 'BBB222', 'hunter2']) expect(out).not.toContain(v)
    expect(out).toContain('keep me')
    const more = scrub(`${['refresh', 'token'].join('_')}=CCC333 pwd: DDD444 api_key='EEE555' Cookie: a=FFF666; b=GGG777 "cookie":"h=HHH888"`)
    for (const v of ['CCC333', 'DDD444', 'EEE555', 'FFF666', 'GGG777', 'HHH888']) expect(more).not.toContain(v)
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
