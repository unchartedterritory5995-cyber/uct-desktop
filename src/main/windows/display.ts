// Which monitor is which, and where a saved window belongs now. Pure; Electron's Display objects
// are mapped onto DisplayInfo by the caller. Nothing here is market data: bounds and flags only.
import { createHash } from 'node:crypto'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  bounds: Rect
  workArea: Rect
  scaleFactor: number
  internal?: boolean
  label?: string
}

export interface WindowRecord {
  bounds: Rect
  isMaximized: boolean
  isFullScreen: boolean
  display: { fingerprint: string; origin: { x: number; y: number }; scaleFactor: number }
  savedAt: number
}

/** What a monitor IS (size, scale, kind, model), not where it sits or its volatile id. */
export function fingerprintDisplay(d: DisplayInfo): string {
  return [d.bounds.width, d.bounds.height, d.scaleFactor, d.internal ? 'int' : 'ext', d.label ?? ''].join('|')
}

/** The desk: the set of monitors, in any order. */
export function deskProfile(displays: readonly DisplayInfo[]): string {
  const sorted = displays.map(fingerprintDisplay).sort()
  return createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16)
}

function distanceToRect(px: number, py: number, r: Rect): number {
  const dx = Math.max(r.x - px, 0, px - (r.x + r.width))
  const dy = Math.max(r.y - py, 0, py - (r.y + r.height))
  return Math.hypot(dx, dy)
}

function clampInto(b: Rect, area: Rect): Rect {
  const width = Math.min(b.width, area.width)
  const height = Math.min(b.height, area.height)
  return {
    x: Math.min(Math.max(b.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(b.y, area.y), area.y + area.height - height),
    width,
    height,
  }
}

/** Never mutates `saved`: the original profile's record stays as it was. */
export function resolveBounds(saved: WindowRecord, displays: readonly DisplayInfo[]): Rect {
  if (displays.length === 0) return { ...saved.bounds }
  const same = displays.filter((d) => fingerprintDisplay(d) === saved.display.fingerprint)
  if (same.length > 0) {
    // Identical monitors are told apart by arrangement: take the one nearest the saved origin, and
    // carry the window along if that monitor has moved.
    const o = saved.display.origin
    const target = same.reduce((best, d) =>
      Math.hypot(d.bounds.x - o.x, d.bounds.y - o.y) < Math.hypot(best.bounds.x - o.x, best.bounds.y - o.y) ? d : best,
    )
    const moved = { ...saved.bounds, x: saved.bounds.x + (target.bounds.x - o.x), y: saved.bounds.y + (target.bounds.y - o.y) }
    return clampInto(moved, target.workArea)
  }
  const cx = saved.bounds.x + saved.bounds.width / 2
  const cy = saved.bounds.y + saved.bounds.height / 2
  const nearest = displays.reduce((best, d) =>
    distanceToRect(cx, cy, d.workArea) < distanceToRect(cx, cy, best.workArea) ? d : best,
  )
  return clampInto(saved.bounds, nearest.workArea)
}
