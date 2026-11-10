// Where named pop-out windows (uct-board-<id>, uct-widget-<id>) open and how their placement is
// kept. Unnamed popups and any other name are never touched. Pure and clock-injected; the Electron
// side (screen, powerMonitor, the window objects) is in placement-electron.ts.
import type { Clock } from '../load-guard'
import { deskProfile, fingerprintDisplay, ordinalOf, resolveBounds, type DisplayInfo, type Rect, type WindowRecord } from './display'
import { parseWindowName, type LayoutStore } from './layout-store'

/** After a display change or resume, wait this long for Windows to settle, then reapply. */
export const DEBOUNCE_MS = 2500
/** Never write placement within this long of a screen event or resume: the moves are Windows', not the member's. */
export const QUIET_AFTER_SCREEN_MS = 5000

const KNOWN_FEATURES = new Set([
  'popup', 'width', 'height', 'left', 'top', 'menubar', 'toolbar', 'location', 'status', 'resizable', 'scrollbars', 'noopener', 'noreferrer',
])
const MAX_FEATURE_CHARS = 2000
const MAX_FEATURE_ENTRIES = 20

/** window.open feature string -> known keys only, in a prototype-less object. Never throws. */
export function parseFeatures(features: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  let n = 0
  for (const part of String(features ?? '').slice(0, MAX_FEATURE_CHARS).split(',')) {
    if (n >= MAX_FEATURE_ENTRIES) break
    const eq = part.indexOf('=')
    const key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase()
    if (!KNOWN_FEATURES.has(key)) continue
    out[key] = eq === -1 ? '' : part.slice(eq + 1).trim().slice(0, 16)
    n++
  }
  return out
}

function sane(v: string | undefined): number | undefined {
  if (v === undefined || !/^\d{1,5}(\.\d+)?$/.test(v)) return undefined
  const n = Math.floor(Number(v))
  return n >= 200 && n <= 10000 ? n : undefined
}

export function sizeFromFeatures(features: string): { width?: number; height?: number } {
  const f = parseFeatures(features)
  const width = sane(f.width)
  const height = sane(f.height)
  return { ...(width !== undefined && { width }), ...(height !== undefined && { height }) }
}

/** The slice of a BrowserWindow this needs. */
export interface PlacedWindow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
  setBounds(bounds: Rect): void
  getBounds(): Rect
  getNormalBounds(): Rect
  isMaximized(): boolean
  isFullScreen(): boolean
  maximize(): void
  unmaximize(): void
  setFullScreen(flag: boolean): void
  isDestroyed(): boolean
}

export interface PlacementDeps {
  store: Pick<LayoutStore, 'saveWindow' | 'getWindow' | 'findNewest'>
  getDisplays(): DisplayInfo[]
  now(): number
  clock: Clock
}

export interface Placement {
  /** Options to merge into a new window's, or undefined to leave today's behaviour alone. */
  openOptions(frameName: string, features: string): Partial<Rect> | undefined
  /** did-create-window: re-assert saved bounds and start tracking. */
  onCreated(win: PlacedWindow, frameName: string): void
  /** display-added / display-removed / display-metrics-changed / resume. */
  screenEvent(): void
}

interface Tracked {
  win: PlacedWindow
  armed: boolean
  last?: WindowRecord
}

function nearestDisplay(b: Rect, displays: readonly DisplayInfo[]): DisplayInfo | undefined {
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  const dist = (d: DisplayInfo): number => {
    const r = d.bounds
    return Math.hypot(Math.max(r.x - cx, 0, cx - (r.x + r.width)), Math.max(r.y - cy, 0, cy - (r.y + r.height)))
  }
  return displays.reduce<DisplayInfo | undefined>((best, d) => (!best || dist(d) < dist(best) ? d : best), undefined)
}

export function createPlacement(deps: PlacementDeps): Placement {
  const tracked = new Map<string, Tracked>()
  let lastScreenAt = -Infinity
  let debounce: unknown
  let hasDebounce = false

  const currentProfile = (): string => deskProfile(deps.getDisplays())

  // The current desk's record, else the newest for this name from any other desk. Read-only: the
  // original profile's record is never rewritten by a fallback.
  const lookup = (name: string): WindowRecord | undefined =>
    deps.store.getWindow(currentProfile(), name) ?? deps.store.findNewest(name)

  const apply = (t: Tracked, rec: WindowRecord): void => {
    const displays = deps.getDisplays()
    const target = resolveBounds(rec, displays)
    t.last = rec
    const maximized = t.win.isMaximized()
    const full = t.win.isFullScreen()
    if (maximized || full) {
      // Normal bounds would un-pin a maximized window. Already on the right monitor: leave it be.
      // Otherwise restore, move to the right monitor, and put the state back.
      if (nearestDisplay(target, displays)?.id === nearestDisplay(t.win.getBounds(), displays)?.id) return
      if (full) t.win.setFullScreen(false)
      if (maximized) t.win.unmaximize()
      t.win.setBounds(target)
      if (maximized) t.win.maximize()
      if (full) t.win.setFullScreen(true)
      return
    }
    t.win.setBounds(target)
  }

  // `deliberate`: maximize, restore and full screen are always the member's doing, so they need no
  // prior drag. A move or resize counts only after will-move / will-resize armed the window.
  const persist = (name: string, t: Tracked, deliberate: boolean): void => {
    if ((!t.armed && !deliberate) || t.win.isDestroyed()) return
    if (deps.now() - lastScreenAt < QUIET_AFTER_SCREEN_MS) return
    const displays = deps.getDisplays()
    const isMax = t.win.isMaximized()
    const isFull = t.win.isFullScreen()
    const bounds = isMax || isFull ? t.win.getNormalBounds() : t.win.getBounds()
    const d = nearestDisplay(bounds, displays)
    if (!d) return
    const rec: WindowRecord = {
      bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      isMaximized: isMax,
      isFullScreen: isFull,
      display: {
        fingerprint: fingerprintDisplay(d),
        origin: { x: d.bounds.x, y: d.bounds.y },
        scaleFactor: d.scaleFactor,
        ordinal: ordinalOf(d, displays),
      },
      savedAt: deps.now(),
    }
    deps.store.saveWindow(deskProfile(displays), name, rec)
    t.last = rec
    t.armed = false // one drag, one save; later programmatic moves are not the member's
  }

  const reapplyAll = (): void => {
    const profile = currentProfile()
    for (const [name, t] of tracked) {
      if (t.win.isDestroyed()) continue
      t.armed = false // any move that follows is Windows' or ours, not the member's
      const rec = deps.store.getWindow(profile, name) ?? deps.store.findNewest(name) ?? t.last
      if (rec) apply(t, rec)
    }
  }

  return {
    openOptions(frameName, features) {
      const name = parseWindowName(frameName)
      if (!name) return undefined
      const rec = lookup(frameName)
      if (rec) return resolveBounds(rec, deps.getDisplays())
      const size = sizeFromFeatures(features)
      return Object.keys(size).length ? size : undefined
    },
    onCreated(win, frameName) {
      if (!parseWindowName(frameName)) return
      const t: Tracked = { win, armed: false }
      tracked.set(frameName, t)
      const rec = lookup(frameName)
      if (rec) {
        apply(t, rec)
        if (rec.isMaximized) win.maximize()
        if (rec.isFullScreen) win.setFullScreen(true)
      }
      for (const e of ['will-move', 'will-resize']) win.on(e, () => void (t.armed = true))
      for (const e of ['moved', 'resized']) win.on(e, () => persist(frameName, t, false))
      for (const e of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
        win.on(e, () => persist(frameName, t, true))
      }
      win.on('closed', () => {
        if (tracked.get(frameName) === t) tracked.delete(frameName)
      })
    },
    screenEvent() {
      lastScreenAt = deps.now()
      if (hasDebounce) deps.clock.clearTimeout(debounce)
      hasDebounce = true
      debounce = deps.clock.setTimeout(() => {
        hasDebounce = false
        reapplyAll()
      }, DEBOUNCE_MS)
    },
  }
}
