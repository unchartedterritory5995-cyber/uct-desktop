import { describe, expect, it, vi } from 'vitest'
import { createDeskVisibilityReporter, deskVisibility, type WindowLike } from '../src/main/desk-visibility'

const win = (visible: boolean, minimized = false, destroyed = false): WindowLike & { v: boolean; m: boolean; d: boolean } => ({
  v: visible, m: minimized, d: destroyed,
  isVisible() { return this.v }, isMinimized() { return this.m }, isDestroyed() { return this.d },
})

describe('deskVisibility', () => {
  it('is visible while any window shows, even with the main window minimized', () => {
    expect(deskVisibility([win(true, true), win(true)])).toBe('visible') // main minimized, a board up
  })
  it('is hidden only when every window is hidden or minimized', () => {
    expect(deskVisibility([win(true, true), win(false), win(true, true)])).toBe('hidden')
  })
  it('ignores destroyed windows, and an empty desk is hidden', () => {
    expect(deskVisibility([win(true, false, true), win(false)])).toBe('hidden')
    expect(deskVisibility([])).toBe('hidden')
  })
})

describe('createDeskVisibilityReporter', () => {
  it('sends once at start and then only on a change', () => {
    const ws = [win(true), win(true)]
    const send = vi.fn()
    const r = createDeskVisibilityReporter({ windows: () => ws, send })
    r.update()
    r.update()
    expect(send.mock.calls).toEqual([['visible']])
    ws[0].m = true
    r.update() // still a board up
    expect(send).toHaveBeenCalledTimes(1)
    ws[1].v = false
    r.update()
    expect(send.mock.calls.at(-1)).toEqual(['hidden'])
    ws[0].m = false
    r.update()
    expect(send.mock.calls.at(-1)).toEqual(['visible'])
    expect(send).toHaveBeenCalledTimes(3)
  })
  it('resend repeats the current answer for a freshly loaded page', () => {
    const send = vi.fn()
    const r = createDeskVisibilityReporter({ windows: () => [win(false)], send })
    r.update()
    r.resend()
    expect(send.mock.calls).toEqual([['hidden'], ['hidden']])
  })
})
