import { describe, expect, it } from 'vitest'
import { classifyLoad, createLoadGuard, backoffMs, STALL_MS, type Clock } from '../src/main/load-guard'
import { APP_SHELL_ORIGIN, isShellSender, resolveShellFile, SHELL_FILES } from '../src/main/app-shell'
import { classifyNavigation, classifyNewWindow } from '../src/main/policy/classify'

const O = 'https://uctintelligence.com'
const ERR_ABORTED = -3
const ERR_INTERNET_DISCONNECTED = -106

describe('classifyLoad', () => {
  it('passes a 200 HTML page', () => {
    expect(classifyLoad({ httpResponseCode: 200, contentType: 'text/html; charset=utf-8' })).toBe('ok')
    expect(classifyLoad({ httpResponseCode: 200 })).toBe('ok')
  })
  it('calls origin trouble an origin-error', () => {
    for (const code of [502, 503, 520, 521, 522, 523, 524, 525, 526, 527, 528, 529, 530]) {
      expect(classifyLoad({ httpResponseCode: code, contentType: 'text/html' })).toBe('origin-error')
    }
    expect(classifyLoad({ httpResponseCode: 503, contentType: 'application/json' })).toBe('origin-error')
    expect(classifyLoad({ httpResponseCode: 403, contentType: 'text/html; charset=UTF-8' })).toBe('origin-error')
  })
  it('lets a Cloudflare interactive challenge render so the member can solve it', () => {
    expect(classifyLoad({ httpResponseCode: 403, contentType: 'text/html', cfMitigated: 'challenge' })).toBe('ok')
    expect(classifyLoad({ httpResponseCode: 403, contentType: 'text/html', cfMitigated: 'Challenge' })).toBe('ok')
    expect(classifyLoad({ httpResponseCode: 403, contentType: 'text/html', cfMitigated: 'block' })).toBe('origin-error')
    expect(classifyLoad({ httpResponseCode: 503, cfMitigated: 'challenge' })).toBe('origin-error')
  })
  it('ignores an aborted load and reports a dead network', () => {
    expect(classifyLoad({ errorCode: ERR_ABORTED })).toBe('ignore')
    expect(classifyLoad({ errorCode: ERR_INTERNET_DISCONNECTED })).toBe('network-error')
    expect(classifyLoad({ errorCode: -105 })).toBe('network-error')
  })
})

describe('the app-shell page', () => {
  it('cannot be reached by the web', () => {
    expect(classifyNavigation(`${APP_SHELL_ORIGIN}/error.html`, O)).toBe('deny')
    expect(classifyNewWindow(`${APP_SHELL_ORIGIN}/error.html`, O, `${O}/`)).toBe('deny')
  })
  it('serves only a static map of names, never a path', () => {
    expect(resolveShellFile(`${APP_SHELL_ORIGIN}/error.html?k=network-error`)).toBe(SHELL_FILES['error.html'])
    expect(resolveShellFile(`${APP_SHELL_ORIGIN}/error.js`)).toBe(SHELL_FILES['error.js'])
    for (const bad of [
      `${APP_SHELL_ORIGIN}/../package.json`,
      `${APP_SHELL_ORIGIN}/%2e%2e/package.json`,
      `${APP_SHELL_ORIGIN}/error.html/../../x`,
      `${APP_SHELL_ORIGIN}/constructor`,
      `${APP_SHELL_ORIGIN}/__proto__`,
      'app-shell://other/error.html',
      `${O}/error.html`,
      'nonsense',
    ]) {
      expect(resolveShellFile(bad)).toBeNull()
    }
  })
  it('accepts retry only from the top frame of the error page', () => {
    const f = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } })
    expect(isShellSender(f(`${APP_SHELL_ORIGIN}/error.html?k=origin-error`))).toBe(true)
    expect(isShellSender(f(`${APP_SHELL_ORIGIN}/error.html`, {}))).toBe(false)
    expect(isShellSender(f(`${O}/`))).toBe(false)
    expect(isShellSender(f(`${APP_SHELL_ORIGIN}/error.js`))).toBe(false)
    expect(isShellSender({ senderFrame: null })).toBe(false)
  })
})

function fakeClock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout: (fn, ms) => {
      timers.set(++id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      timers.delete(next[0])
      now = next[1].at
      next[1].fn()
    }
    now = end
  }
  return { clock, advance, pending: () => timers.size }
}

function makeGuard() {
  const c = fakeClock()
  const log: string[] = []
  const loaded: string[] = []
  const guard = createLoadGuard({
    appOrigin: O,
    clock: c.clock,
    load: (url) => (log.push('load'), void loaded.push(url)),
    showError: (k) => void log.push(`error:${k}`),
    showApp: () => void log.push('app'),
  })
  return { ...c, log, guard, loaded }
}

describe('createLoadGuard', () => {
  it('shows the error page after a 15 second stall', () => {
    const { guard, advance, log } = makeGuard()
    guard.start()
    advance(STALL_MS - 1)
    expect(log).toEqual(['load'])
    advance(1)
    expect(log).toEqual(['load', 'error:origin-error'])
  })
  it('shows the error page on a 503 and a dead network, and ignores aborts', () => {
    const a = makeGuard()
    a.guard.start()
    a.guard.onNavigated(`${O}/`, 503, 'application/json')
    expect(a.log).toEqual(['load', 'error:origin-error'])
    const b = makeGuard()
    b.guard.start()
    b.guard.onFailLoad(`${O}/`, ERR_ABORTED)
    expect(b.log).toEqual(['load'])
    b.guard.onFailLoad(`${O}/`, ERR_INTERNET_DISCONNECTED)
    expect(b.log).toEqual(['load', 'error:network-error'])
  })
  it('treats a challenge response as a page, not an outage', () => {
    const { guard, log } = makeGuard()
    guard.start()
    guard.onNavigated(`${O}/`, 403, 'text/html', 'challenge')
    expect(log).toEqual(['load'])
  })
  it('retries the route that failed, never another origin', () => {
    const { guard, advance, loaded } = makeGuard()
    guard.start()
    expect(loaded).toEqual([`${O}/`])
    guard.onNavigated(`${O}/charts?x=1`, 502)
    advance(2000)
    expect(loaded.at(-1)).toBe(`${O}/charts?x=1`)
    guard.onFailLoad('https://evil.example/x', -106)
    guard.onNavigated(`${O}/charts?x=1`, 200, 'text/html')
    guard.onNavigated(`${O}/journal`, 503)
    advance(2000)
    expect(loaded.at(-1)).toBe(`${O}/journal`)
  })
  it('falls back to the origin after a success', () => {
    const { guard, loaded } = makeGuard()
    guard.start()
    guard.onNavigated(`${O}/charts`, 502)
    guard.onNavigated(`${O}/charts`, 200, 'text/html')
    guard.retry()
    expect(loaded.at(-1)).toBe(`${O}/`)
  })
  it('ignores events about the app-shell page itself', () => {
    const { guard, log } = makeGuard()
    guard.start()
    guard.onNavigated(`${APP_SHELL_ORIGIN}/error.html`, 200, 'text/html')
    guard.onFailLoad(`${APP_SHELL_ORIGIN}/error.html`, -2)
    expect(log).toEqual(['load'])
  })
  it('retries with backoff up to 30 seconds and recovers', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000])
    const { guard, advance, log } = makeGuard()
    guard.start()
    guard.onNavigated(`${O}/`, 503)
    advance(1999)
    expect(log).toEqual(['load', 'error:origin-error'])
    advance(1)
    expect(log.slice(-1)).toEqual(['load'])
    guard.onNavigated(`${O}/`, 503)
    advance(3999)
    expect(log.filter((e) => e === 'load').length).toBe(2)
    advance(1)
    expect(log.filter((e) => e === 'load').length).toBe(3)
    guard.onNavigated(`${O}/`, 200, 'text/html')
    expect(log.slice(-1)).toEqual(['app'])
    advance(60000)
    expect(log.filter((e) => e === 'load').length).toBe(3)
  })
  it('a manual retry loads at once and starts the backoff over', () => {
    const { guard, advance, log, pending } = makeGuard()
    guard.start()
    guard.onNavigated(`${O}/`, 502)
    guard.onNavigated(`${O}/`, 502)
    guard.retry()
    expect(log.filter((e) => e === 'load').length).toBe(2)
    guard.onNavigated(`${O}/`, 502)
    advance(2000)
    expect(log.filter((e) => e === 'load').length).toBe(3)
    guard.dispose()
    expect(pending()).toBe(0)
  })
})

describe('the first load opens the last page', () => {
  const clock: Clock = { setTimeout: () => 0, clearTimeout: () => undefined }
  const firstLoad = (startPath?: string) => {
    const loads: string[] = []
    createLoadGuard({ appOrigin: O, startPath, clock, load: (u) => loads.push(u), showError: () => undefined, showApp: () => undefined }).start()
    return loads[0]
  }
  it('starts at the given page, on the app origin only', () => {
    expect(firstLoad('/charts')).toBe(`${O}/charts`)
    expect(firstLoad()).toBe(`${O}/`)
    expect(firstLoad('https://evil.test/charts')).toBe(`${O}/`)
    expect(firstLoad('//evil.test/x')).toBe(`${O}/`)
  })
})
