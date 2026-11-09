import { describe, expect, it } from 'vitest'
import { resolveOrigin } from '../src/main/config'
import { isPermissionAllowed } from '../src/main/policy/permissions'

const O = 'https://uctintelligence.com'

describe('isPermissionAllowed', () => {
  it('grants notifications to the exact app origin', () => {
    expect(isPermissionAllowed({ permission: 'notifications', origin: `${O}/charts` }, O)).toBe(true)
  })

  it('refuses the same permission to any other origin', () => {
    expect(isPermissionAllowed({ permission: 'notifications', origin: 'https://uctintelligence.com.evil.example/' }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'notifications', origin: 'http://uctintelligence.com/' }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'notifications', origin: '' }, O)).toBe(false)
  })

  it('grants media only when it is audio alone', () => {
    expect(isPermissionAllowed({ permission: 'media', origin: O, mediaTypes: ['audio'] }, O)).toBe(true)
    expect(isPermissionAllowed({ permission: 'media', origin: O, mediaTypes: ['video'] }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'media', origin: O, mediaTypes: ['audio', 'video'] }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'media', origin: O, mediaTypes: [] }, O)).toBe(false)
    expect(isPermissionAllowed({ permission: 'media', origin: O }, O)).toBe(false)
  })

  it('refuses everything else', () => {
    for (const permission of ['geolocation', 'clipboard-read', 'midi', 'openExternal', 'pointerLock', 'fullscreen']) {
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
