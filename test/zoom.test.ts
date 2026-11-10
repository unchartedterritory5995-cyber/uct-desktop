import { describe, expect, it } from 'vitest'
import { nextZoomLevel, zoomAction } from '../src/main/windows/zoom'

const key = (over: Partial<Parameters<typeof zoomAction>[0]>) => ({
  type: 'keyDown',
  key: '=',
  control: true,
  alt: false,
  meta: false,
  ...over,
})

describe('zoomAction', () => {
  it('zooms in on plain Ctrl and =, Ctrl+Shift+= and numpad plus', () => {
    expect(zoomAction(key({ key: '=' }))).toBe('in')
    expect(zoomAction(key({ key: '+' }))).toBe('in')
  })

  it('zooms out and resets the way Chrome does', () => {
    expect(zoomAction(key({ key: '-' }))).toBe('out')
    expect(zoomAction(key({ key: '_' }))).toBe('out')
    expect(zoomAction(key({ key: '0' }))).toBe('reset')
  })

  it('leaves every other key to the site', () => {
    expect(zoomAction(key({ key: 'a' }))).toBeNull()
    expect(zoomAction(key({ control: false }))).toBeNull()
    expect(zoomAction(key({ alt: true }))).toBeNull()
    expect(zoomAction(key({ type: 'keyUp' }))).toBeNull()
  })
})

describe('nextZoomLevel', () => {
  it('steps by half a level and resets to zero', () => {
    expect(nextZoomLevel(0, 'in')).toBe(0.5)
    expect(nextZoomLevel(0, 'out')).toBe(-0.5)
    expect(nextZoomLevel(2.5, 'reset')).toBe(0)
  })

  it('stops at the limits', () => {
    expect(nextZoomLevel(3, 'in')).toBe(3)
    expect(nextZoomLevel(-3, 'out')).toBe(-3)
  })
})
