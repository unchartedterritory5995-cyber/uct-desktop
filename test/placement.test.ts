import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  createPlacement,
  DEBOUNCE_MS,
  parseFeatures,
  QUIET_AFTER_SCREEN_MS,
  sizeFromFeatures,
  type PlacedWindow,
} from '../src/main/windows/placement'
import { parseWindowName } from '../src/main/windows/layout-store'
import { deskProfile, fingerprintDisplay, type DisplayInfo, type Rect, type WindowRecord } from '../src/main/windows/display'
import type { Clock } from '../src/main/load-guard'

describe('parseWindowName', () => {
  it('accepts only uct-board-<id> and uct-widget-<id> with a strict id', () => {
    expect(parseWindowName('uct-board-abc123')).toEqual({ kind: 'board', id: 'abc123' })
    expect(parseWindowName('uct-widget-a_b-9')).toEqual({ kind: 'widget', id: 'a_b-9' })
    for (const bad of ['', 'popup', 'uct-board-', 'uct-board-a b', 'uct-board-../x', 'uct-board-a/b', 'UCT-board-x', 'uct-tab-1', `uct-board-${'a'.repeat(65)}`, 'uct-board-x\n', '__proto__']) {
      expect(parseWindowName(bad)).toBeNull()
    }
  })
})

describe('parseFeatures', () => {
  it('parses a window.open feature string without trusting it', () => {
    const f = parseFeatures('popup,width=800, height=600,left=0,top=0,__proto__=1,constructor=x')
    expect(f.width).toBe('800')
    expect(f.popup).toBe('')
    expect(Object.getPrototypeOf(f)).toBeNull()
    expect(Object.keys(f)).not.toContain('__proto__')
    expect(Object.keys(f)).not.toContain('constructor')
  })
  it('survives junk and huge input', () => {
    expect(() => parseFeatures('=,,==,a=b=c,' + 'x=1,'.repeat(10000))).not.toThrow()
    expect(Object.keys(parseFeatures('x=1,'.repeat(10000))).length).toBeLessThanOrEqual(1)
  })
  it('takes only sane sizes', () => {
    expect(sizeFromFeatures('width=800,height=600')).toEqual({ width: 800, height: 600 })
    expect(sizeFromFeatures('width=5,height=99999')).toEqual({})
    expect(sizeFromFeatures('width=abc')).toEqual({})
    expect(sizeFromFeatures('width=800.5')).toEqual({ width: 800 })
  })
})

const disp = (id: number, x: number): DisplayInfo => ({
  id,
  bounds: { x, y: 0, width: 1920, height: 1080 },
  workArea: { x, y: 0, width: 1920, height: 1040 },
  scaleFactor: 1,
  label: 'M',
})

function setup(displays: DisplayInfo[] = [disp(1, 0), disp(2, 1920)]) {
  let t = 100_000
  let id = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout: (fn, ms) => (timers.set(++id, { at: t + ms, fn }), id),
    clearTimeout: (h) => void timers.delete(h as number),
  }
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const n = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!n) break
      timers.delete(n[0])
      t = n[1].at
      n[1].fn()
    }
    t = end
  }
  const saved = new Map<string, WindowRecord>()
  const store = {
    saveWindow: (p: string, n: string, r: WindowRecord) => void saved.set(`${p}/${n}`, r),
    getWindow: (p: string, n: string) => saved.get(`${p}/${n}`),
  }
  let current = displays
  const placement = createPlacement({ store, getDisplays: () => current, now: () => t, clock })
  const setDisplays = (d: DisplayInfo[]) => void (current = d)
  return { placement, saved, advance, setDisplays, now: () => t }
}

function fakeWin(bounds: Rect = { x: 50, y: 60, width: 700, height: 500 }) {
  const ee = new EventEmitter()
  const w = Object.assign(ee, {
    b: { ...bounds },
    set: [] as Rect[],
    destroyed: false,
    max: false,
    full: false,
    setBounds(r: Rect) { w.b = { ...r }; w.set.push({ ...r }) },
    getBounds: () => ({ ...w.b }),
    getNormalBounds: () => ({ ...w.b }),
    isMaximized: () => w.max,
    isFullScreen: () => w.full,
    maximize() { w.max = true },
    setFullScreen(f: boolean) { w.full = f },
    isDestroyed: () => w.destroyed,
  })
  return w as typeof w & PlacedWindow
}

const record = (d: DisplayInfo, bounds: Rect, extra: Partial<WindowRecord> = {}): WindowRecord => ({
  bounds,
  isMaximized: false,
  isFullScreen: false,
  display: { fingerprint: fingerprintDisplay(d), origin: { x: d.bounds.x, y: d.bounds.y }, scaleFactor: 1 },
  savedAt: 1,
  ...extra,
})

describe('openOptions', () => {
  it('leaves unnamed and foreign-named windows exactly as today', () => {
    const { placement } = setup()
    expect(placement.openOptions('', 'popup,width=800,height=600')).toBeUndefined()
    expect(placement.openOptions('popup', 'width=800')).toBeUndefined()
    expect(placement.openOptions('uct-board-../x', 'width=800')).toBeUndefined()
  })
  it('restores a known profile without asking', () => {
    const d = [disp(1, 0), disp(2, 1920)]
    const { placement, saved } = setup(d)
    saved.set(`${deskProfile(d)}/uct-board-a`, record(d[1], { x: 2000, y: 100, width: 800, height: 600 }))
    expect(placement.openOptions('uct-board-a', '')).toEqual({ x: 2000, y: 100, width: 800, height: 600 })
  })
  it('uses only a sane size from the features when nothing is saved', () => {
    const { placement } = setup()
    expect(placement.openOptions('uct-widget-1', 'popup,width=640,height=480,left=0,top=0')).toEqual({ width: 640, height: 480 })
    expect(placement.openOptions('uct-widget-1', 'left=0,top=0')).toBeUndefined()
  })
})

describe('did-create-window', () => {
  it('re-asserts the saved bounds and flags', () => {
    const d = [disp(1, 0), disp(2, 1920)]
    const { placement, saved } = setup(d)
    saved.set(`${deskProfile(d)}/uct-board-a`, record(d[0], { x: 10, y: 20, width: 800, height: 600 }, { isMaximized: true }))
    const w = fakeWin()
    placement.onCreated(w, 'uct-board-a')
    expect(w.set).toEqual([{ x: 10, y: 20, width: 800, height: 600 }])
    expect(w.max).toBe(true)
  })
  it('ignores windows with other names', () => {
    const { placement } = setup()
    const w = fakeWin()
    placement.onCreated(w, 'other')
    w.emit('will-move')
    w.emit('moved')
    expect(w.set).toEqual([])
    expect(w.listenerCount('moved')).toBe(0)
  })
})

describe('persistence', () => {
  it('persists only after a user move or resize armed the window', () => {
    const { placement, saved } = setup()
    const w = fakeWin()
    placement.onCreated(w, 'uct-board-a')
    w.emit('moved') // programmatic: nothing armed it
    expect(saved.size).toBe(0)
    w.emit('will-move')
    w.b = { x: 300, y: 300, width: 700, height: 500 }
    w.emit('moved')
    expect(saved.size).toBe(1)
    expect([...saved.values()][0].bounds).toEqual({ x: 300, y: 300, width: 700, height: 500 })
    const w2 = fakeWin()
    placement.onCreated(w2, 'uct-widget-b')
    w2.emit('will-resize')
    w2.emit('resized')
    expect(saved.size).toBe(2)
  })
  it('stores only the allowed fields, never anything about the page', () => {
    const { placement, saved } = setup()
    const w = fakeWin()
    placement.onCreated(w, 'uct-board-a')
    w.emit('will-move')
    w.emit('moved')
    expect(Object.keys([...saved.values()][0]).sort()).toEqual(['bounds', 'display', 'isFullScreen', 'isMaximized', 'savedAt'])
  })
  it('never persists within 5 seconds of a screen event or resume', () => {
    const { placement, saved, advance } = setup()
    const w = fakeWin()
    placement.onCreated(w, 'uct-board-a')
    w.emit('will-move')
    placement.screenEvent()
    advance(QUIET_AFTER_SCREEN_MS - 1)
    w.emit('moved')
    expect(saved.size).toBe(0)
  })
  it('persists again once the quiet period has passed', () => {
    const { placement, saved, advance } = setup()
    const w = fakeWin()
    placement.onCreated(w, 'uct-board-a')
    placement.screenEvent()
    advance(QUIET_AFTER_SCREEN_MS + 1)
    w.emit('will-move')
    w.emit('moved')
    expect(saved.size).toBe(1)
  })
})

describe('display changes', () => {
  it('debounces and reapplies once, from the saved record for the new desk', () => {
    const two = [disp(1, 0), disp(2, 1920)]
    const { placement, saved, advance, setDisplays } = setup(two)
    saved.set(`${deskProfile(two)}/uct-board-a`, record(two[1], { x: 2000, y: 100, width: 800, height: 600 }))
    const w = fakeWin()
    placement.onCreated(w, 'uct-board-a')
    w.set.length = 0
    setDisplays([two[0]]) // the second monitor was unplugged
    placement.screenEvent()
    advance(1000)
    placement.screenEvent()
    advance(DEBOUNCE_MS - 1)
    expect(w.set).toEqual([])
    advance(1)
    expect(w.set.length).toBe(1)
    const r = w.set[0]
    expect(r.x + r.width).toBeLessThanOrEqual(1920) // pulled onto the remaining monitor
    // the original two-monitor record is untouched
    expect(saved.get(`${deskProfile(two)}/uct-board-a`)!.bounds).toEqual({ x: 2000, y: 100, width: 800, height: 600 })
  })
  it('skips destroyed windows and windows that closed', () => {
    const { placement, advance } = setup()
    const a = fakeWin()
    const b = fakeWin()
    placement.onCreated(a, 'uct-board-a')
    placement.onCreated(b, 'uct-board-b')
    a.destroyed = true
    b.emit('closed')
    a.set.length = 0
    b.set.length = 0
    placement.screenEvent()
    advance(DEBOUNCE_MS)
    expect(a.set).toEqual([])
    expect(b.set).toEqual([])
  })
  it('does not treat its own reapply as a user move', () => {
    const { placement, saved, advance } = setup()
    const w = fakeWin()
    placement.onCreated(w, 'uct-board-a')
    w.emit('will-move')
    placement.screenEvent()
    advance(DEBOUNCE_MS)
    advance(QUIET_AFTER_SCREEN_MS)
    w.emit('moved') // event caused by our setBounds, not the member
    expect(saved.size).toBe(0)
  })
})
