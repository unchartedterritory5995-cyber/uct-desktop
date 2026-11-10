import { describe, expect, it } from 'vitest'
import { resolveOrigin } from '../src/main/config'
import { isPermissionAllowed, mediaEligible, type MediaAsk } from '../src/main/policy/permissions'

const O = 'https://uctintelligence.com'

describe('isPermissionAllowed', () => {
  it('grants notifications to the main window on the exact app origin', () => {
    expect(isPermissionAllowed({ permission: 'notifications', origin: `${O}/charts`, fromMainWindow: true }, O)).toBe(true)
  })

  it('refuses notifications to every other window, so nothing notifies twice', () => {
    expect(isPermissionAllowed({ permission: 'notifications', origin: `${O}/terminal`, fromMainWindow: false }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'notifications', origin: `${O}/terminal` }, O)).toBe(false)
  })

  it('refuses the same permission to any other origin', () => {
    expect(isPermissionAllowed({ permission: 'notifications', origin: 'https://uctintelligence.com.evil.example/', fromMainWindow: true }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'notifications', origin: 'http://uctintelligence.com/', fromMainWindow: true }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'notifications', origin: '', fromMainWindow: true }, O)).toBe(false)
  })

  it('never decides media itself: that needs the consent gate', () => {
    expect(isPermissionAllowed({ permission: 'media', origin: O }, O)).toBe(false)
  })

  it('lets the site copy and go full screen, but never read the clipboard', () => {
    expect(isPermissionAllowed({ permission: 'clipboard-sanitized-write', origin: O }, O)).toBe(true)
    expect(isPermissionAllowed({ permission: 'fullscreen', origin: O }, O)).toBe(true)
    expect(isPermissionAllowed({ permission: 'clipboard-sanitized-write', origin: 'https://evil.example/' }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'fullscreen', origin: 'https://evil.example/' }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'clipboard-read', origin: O }, O)).toBe(false)
  })

  it('refuses everything else', () => {
    for (const permission of ['geolocation', 'clipboard-read', 'midi', 'openExternal', 'pointerLock']) {
      expect(isPermissionAllowed({ permission, origin: O }, O)).toBe(false)
    }
  })
})

describe('resolveOrigin', () => {
  it('ignores an override in a production build', () => {
    expect(resolveOrigin('production', 'https://evil.example')).toBe(O)
  })

  it('accepts an override only in a dev build', () => {
    expect(resolveOrigin('dev', 'http://localhost:5173/x')).toBe('http://localhost:5173')
    expect(resolveOrigin('dev', undefined)).toBe(O)
  })
})

describe('mediaEligible', () => {
  const ask = (over: Partial<MediaAsk> = {}): MediaAsk => ({
    requestingUrl: `${O}/journal`,
    mediaTypes: ['audio'],
    isMainFrame: true,
    windowFocused: true,
    ...over,
  })
  it('accepts a focused top-frame audio-only request from the app origin', () => {
    expect(mediaEligible(ask(), O)).toBe(true)
  })
  it('wants exactly ["audio"]', () => {
    for (const mediaTypes of [['video'], ['audio', 'video'], ['video', 'audio'], ['audio', 'audio'], [], undefined]) {
      expect(mediaEligible(ask({ mediaTypes }), O)).toBe(false)
    }
  })
  it('refuses subframes and unfocused windows', () => {
    expect(mediaEligible(ask({ isMainFrame: false }), O)).toBe(false)
    expect(mediaEligible(ask({ windowFocused: false }), O)).toBe(false)
  })
  it('matches the origin through requestingUrl, not a claimed securityOrigin', () => {
    expect(mediaEligible(ask({ requestingUrl: 'https://evil.example/', securityOrigin: O }), O)).toBe(false)
    expect(mediaEligible(ask({ requestingUrl: `${O}.evil.example/`, securityOrigin: O }), O)).toBe(false)
    expect(mediaEligible(ask({ requestingUrl: 'http://uctintelligence.com/' }), O)).toBe(false)
    expect(mediaEligible(ask({ requestingUrl: '' }), O)).toBe(false)
  })
  it('lets a focused popped-out portal (about:blank inheriting the app origin) use voice input', () => {
    expect(mediaEligible(ask({ requestingUrl: 'about:blank', securityOrigin: O }), O)).toBe(true)
    expect(mediaEligible(ask({ requestingUrl: 'about:blank', securityOrigin: 'https://evil.example' }), O)).toBe(false)
    expect(mediaEligible(ask({ requestingUrl: 'about:blank' }), O)).toBe(false)
  })
  it('does not care which window it is, so a real-URL popup on the app origin works too', () => {
    expect(mediaEligible(ask({ requestingUrl: `${O}/terminal?popout=x` }), O)).toBe(true)
  })
})
