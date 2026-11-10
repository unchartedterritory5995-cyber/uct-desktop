import { describe, expect, it } from 'vitest'
import { deskProfile, fingerprintDisplay, ordinalOf, resolveBounds, type DisplayInfo, type WindowRecord } from '../src/main/windows/display'

const disp = (id: number, x: number, y: number, w = 1920, h = 1080, scale = 1, taskbar = 40): DisplayInfo => ({
  id,
  bounds: { x, y, width: w, height: h },
  workArea: { x, y, width: w, height: h - taskbar },
  scaleFactor: scale,
  internal: false,
  label: 'DELL U2720Q',
})

function record(d: DisplayInfo, bounds: WindowRecord['bounds'], extra: Partial<WindowRecord> = {}): WindowRecord {
  return {
    bounds,
    isMaximized: false,
    isFullScreen: false,
    display: { fingerprint: fingerprintDisplay(d), origin: { x: d.bounds.x, y: d.bounds.y }, scaleFactor: d.scaleFactor },
    savedAt: 1,
    ...extra,
  }
}

describe('fingerprintDisplay / deskProfile', () => {
  it('ignores the volatile id and the arrangement', () => {
    expect(fingerprintDisplay(disp(1, 0, 0))).toBe(fingerprintDisplay(disp(99, 5000, -300)))
  })
  it('changes with size, scale and kind', () => {
    const base = fingerprintDisplay(disp(1, 0, 0))
    expect(fingerprintDisplay(disp(1, 0, 0, 2560, 1440))).not.toBe(base)
    expect(fingerprintDisplay(disp(1, 0, 0, 1920, 1080, 1.5))).not.toBe(base)
    expect(fingerprintDisplay({ ...disp(1, 0, 0), internal: true })).not.toBe(base)
  })
  it('hashes the sorted fingerprints, so order does not matter but membership does', () => {
    const a = disp(1, 0, 0)
    const b = disp(2, 1920, 0, 2560, 1440)
    expect(deskProfile([a, b])).toBe(deskProfile([b, a]))
    expect(deskProfile([a, b])).not.toBe(deskProfile([a]))
    expect(deskProfile([a])).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe('identical monitors after a primary swap', () => {
  it('ranks same-fingerprint displays left to right', () => {
    const a = disp(1, 0, 0)
    const b = disp(2, -1920, 0)
    expect(ordinalOf(b, [a, b])).toBe(0)
    expect(ordinalOf(a, [a, b])).toBe(1)
  })
  it('keeps the window on its monitor when the primary changes and origins shift', () => {
    const left = disp(1, 0, 0) // primary, with the other monitor to its right
    const right = disp(2, 1920, 0)
    const saved = record(left, { x: 100, y: 100, width: 800, height: 600 })
    saved.display.ordinal = ordinalOf(left, [left, right]) // 0
    // The member makes the right monitor primary: it is now at 0, the old primary at -1920.
    const swappedLeft = disp(1, -1920, 0)
    const swappedRight = disp(2, 0, 0)
    // origin-only matching would pick the monitor now at (0,0), which is the OTHER monitor
    expect(resolveBounds(saved, [swappedRight, swappedLeft])).toEqual({ x: -1820, y: 100, width: 800, height: 600 })
  })
})

describe('resolveBounds', () => {
  it('restores exactly when the display is there', () => {
    const d = [disp(1, 0, 0), disp(2, 1920, 0)]
    const saved = record(d[1], { x: 2100, y: 100, width: 800, height: 600 })
    expect(resolveBounds(saved, d)).toEqual({ x: 2100, y: 100, width: 800, height: 600 })
  })
  it('keeps the window on the right one of two identical monitors when the arrangement changes', () => {
    const before = [disp(1, 0, 0), disp(2, 1920, 0)]
    const saved = record(before[1], { x: 2100, y: 100, width: 800, height: 600 })
    const after = [disp(7, 0, 0), disp(8, 1920, 1080)] // the second monitor now sits lower
    expect(resolveBounds(saved, after)).toEqual({ x: 2100, y: 1180, width: 800, height: 600 })
  })
  it('a missing display falls to the nearest, clamped in its workArea, and the saved record is untouched', () => {
    const gone = disp(3, 3840, 0)
    const saved = record(gone, { x: 4000, y: 900, width: 800, height: 600 })
    const snapshot = JSON.parse(JSON.stringify(saved))
    const now = [disp(1, 0, 0), disp(2, -1920, 0)]
    const r = resolveBounds(saved, now)
    const wa = now[0].workArea
    expect(r.x).toBeGreaterThanOrEqual(wa.x)
    expect(r.x + r.width).toBeLessThanOrEqual(wa.x + wa.width)
    expect(r.y + r.height).toBeLessThanOrEqual(wa.y + wa.height) // above the taskbar
    expect(saved).toEqual(snapshot)
  })
  it('shrinks oversized bounds to the workArea', () => {
    const d = [disp(1, 0, 0)]
    const saved = record(d[0], { x: 0, y: 0, width: 5000, height: 4000 })
    expect(resolveBounds(saved, d)).toEqual({ x: 0, y: 0, width: 1920, height: 1040 })
  })
  it('works with negative coordinates', () => {
    const d = [disp(1, 0, 0), disp(2, -1920, -200)]
    const saved = record(d[1], { x: -1800, y: -100, width: 700, height: 500 })
    expect(resolveBounds(saved, d)).toEqual({ x: -1800, y: -100, width: 700, height: 500 })
  })
  it('stays on screen after a scale change', () => {
    const old = disp(1, 0, 0, 3840, 2160, 1)
    const saved = record(old, { x: 3000, y: 1800, width: 800, height: 600 })
    const now = [disp(1, 0, 0, 2560, 1440, 1.5)]
    const r = resolveBounds(saved, now)
    expect(r.x + r.width).toBeLessThanOrEqual(2560)
    expect(r.y + r.height).toBeLessThanOrEqual(1440 - 40)
  })
  it('falls back to a safe default when there are no displays', () => {
    const saved = record(disp(1, 0, 0), { x: 10, y: 10, width: 800, height: 600 })
    expect(resolveBounds(saved, [])).toEqual({ x: 10, y: 10, width: 800, height: 600 })
  })
})
