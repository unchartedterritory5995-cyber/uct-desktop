import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { headerValue, makeRetryHandler, wireLoadEvents } from '../src/main/windows/wiring'
import { APP_SHELL_ORIGIN, isShellSender } from '../src/main/app-shell'

const O = 'https://uctintelligence.com'

function fakeGuard() {
  const calls: unknown[][] = []
  return {
    calls,
    guard: {
      start() {},
      retry: () => void calls.push(['retry']),
      onNavigated: (...a: unknown[]) => void calls.push(['nav', ...a]),
      onFailLoad: (...a: unknown[]) => void calls.push(['fail', ...a]),
      dispose() {},
    },
  }
}

describe('wireLoadEvents', () => {
  it('ignores subframe load failures and navigations', () => {
    const wc = new EventEmitter()
    const { guard, calls } = fakeGuard()
    wireLoadEvents(wc, guard, () => undefined)
    wc.emit('did-fail-load', {}, -105, 'x', `${O}/embed`, false)
    wc.emit('did-frame-navigate', {}, `${O}/embed`, 503, 'x', false)
    expect(calls).toEqual([])
  })
  it('passes main-frame events and the challenge header to the guard', () => {
    const wc = new EventEmitter()
    const { guard, calls } = fakeGuard()
    wireLoadEvents(wc, guard, (u) => (u === `${O}/` ? 'challenge' : undefined))
    wc.emit('did-fail-load', {}, -106, 'x', `${O}/`, true)
    wc.emit('did-frame-navigate', {}, `${O}/`, 403, 'x', true)
    expect(calls).toEqual([
      ['fail', `${O}/`, -106],
      ['nav', `${O}/`, 403, undefined, 'challenge'],
    ])
  })
})

describe('retry sender rule', () => {
  const wc = {}
  const ev = (sender: unknown, url: string, parent: unknown = null) => ({ sender, senderFrame: { url, parent } })
  it('accepts only the main webContents showing the error page, top frame', () => {
    const { guard, calls } = fakeGuard()
    const handle = makeRetryHandler(wc, guard, isShellSender)
    handle(ev({}, `${APP_SHELL_ORIGIN}/error.html`)) // another webContents
    handle(ev(wc, `${O}/`)) // the website
    handle(ev(wc, `${APP_SHELL_ORIGIN}/error.html`, {})) // subframe
    handle({ sender: wc, senderFrame: null })
    expect(calls).toEqual([])
    handle(ev(wc, `${APP_SHELL_ORIGIN}/error.html?k=crash`))
    expect(calls).toEqual([['retry']])
  })
})

describe('headerValue', () => {
  it('reads case-insensitively', () => {
    expect(headerValue({ 'CF-Mitigated': ['challenge'] }, 'cf-mitigated')).toBe('challenge')
    expect(headerValue({ 'cf-mitigated': 'challenge' }, 'cf-mitigated')).toBe('challenge')
    expect(headerValue({}, 'cf-mitigated')).toBeUndefined()
    expect(headerValue(undefined, 'cf-mitigated')).toBeUndefined()
  })
})
