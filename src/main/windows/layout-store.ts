// The desk store: where each named window sat, per monitor setup. Widget config only (bounds and
// flags): never prices, symbols or any market data (D20). The file lives under userData and is
// written as temp file plus atomic rename. Filesystem access is injected so it is unit-tested.
import type { Rect, WindowRecord } from './display'

export const MAX_ENTRIES = 200
const VERSION = 1

const NAME = /^uct-(board|widget)-([A-Za-z0-9_-]{1,64})$/
/** `uct-board-<id>` or `uct-widget-<id>` with a strict id; anything else is not ours. */
export function parseWindowName(name: string): { kind: 'board' | 'widget'; id: string } | null {
  const m = NAME.exec(name)
  return m ? { kind: m[1] as 'board' | 'widget', id: m[2] } : null
}

export interface StoreFs {
  readFile(path: string): string
  writeFile(path: string, data: string, options?: { flush?: boolean }): void
  rename(from: string, to: string): void
  mkdir(dir: string): void
}

type Profiles = Record<string, Record<string, WindowRecord>>

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isRect = (r: unknown): r is Rect =>
  !!r && typeof r === 'object' && num((r as Rect).x) && num((r as Rect).y) && num((r as Rect).width) && num((r as Rect).height)

function cleanRecord(r: unknown): WindowRecord | null {
  if (!r || typeof r !== 'object') return null
  const o = r as WindowRecord
  const d = o.display
  const ordinal = num(d?.ordinal) ? d.ordinal : undefined
  if (!isRect(o.bounds) || !d || typeof d.fingerprint !== 'string' || !d.origin || !num(d.origin.x) || !num(d.origin.y) || !num(d.scaleFactor)) return null
  if (typeof o.isMaximized !== 'boolean' || typeof o.isFullScreen !== 'boolean' || !num(o.savedAt)) return null
  const { x, y, width, height } = o.bounds
  return {
    bounds: { x, y, width, height },
    isMaximized: o.isMaximized,
    isFullScreen: o.isFullScreen,
    display: {
      fingerprint: d.fingerprint,
      origin: { x: d.origin.x, y: d.origin.y },
      scaleFactor: d.scaleFactor,
      ...(ordinal !== undefined && { ordinal }),
    },
    savedAt: o.savedAt,
  }
}

export interface LayoutStore {
  saveWindow(profile: string, name: string, record: WindowRecord): void
  getWindow(profile: string, name: string): WindowRecord | undefined
  /** The most recently saved record for this name in ANY desk profile. Read-only. */
  findNewest(name: string): WindowRecord | undefined
  count(): number
}

export function createLayoutStore(deps: { file: string; fs: StoreFs }): LayoutStore {
  const { file, fs } = deps
  const profiles: Profiles = Object.create(null)

  const quarantine = (raw: string): void => {
    try {
      fs.writeFile(`${file}.bad`, raw)
    } catch {
      /* the store simply starts empty */
    }
  }

  try {
    const raw = fs.readFile(file)
    try {
      const parsed = JSON.parse(raw) as { version?: number; profiles?: Record<string, Record<string, unknown>> }
      if (parsed.version !== VERSION || !parsed.profiles || typeof parsed.profiles !== 'object') throw new Error('shape')
      for (const [p, windows] of Object.entries(parsed.profiles)) {
        if (!windows || typeof windows !== 'object') throw new Error('shape')
        for (const [n, r] of Object.entries(windows)) {
          const rec = cleanRecord(r)
          if (!rec || !parseWindowName(n)) throw new Error('shape')
          ;(profiles[p] ??= Object.create(null))[n] = rec
        }
      }
    } catch {
      for (const k of Object.keys(profiles)) delete profiles[k]
      quarantine(raw)
    }
  } catch {
    /* no file yet */
  }

  const count = (): number => Object.values(profiles).reduce((n, w) => n + Object.keys(w).length, 0)

  // A failed write keeps the in-memory state; the next save writes everything again. It must never
  // surface as an uncaught exception in the main process.
  const flush = (): void => {
    try {
      const tmp = `${file}.tmp`
      fs.mkdir(file.replace(/[\\/][^\\/]*$/, ''))
      fs.writeFile(tmp, JSON.stringify({ version: VERSION, profiles }), { flush: true })
      fs.rename(tmp, file)
    } catch {
      /* retried on the next save */
    }
  }

  return {
    saveWindow(profile, name, record) {
      const rec = cleanRecord(record)
      if (!parseWindowName(name) || !rec || !profile) return
      ;(profiles[profile] ??= Object.create(null))[name] = rec
      while (count() > MAX_ENTRIES) {
        let oldest: [string, string, number] | undefined
        for (const [p, w] of Object.entries(profiles))
          for (const [n, r] of Object.entries(w)) if (!oldest || r.savedAt < oldest[2]) oldest = [p, n, r.savedAt]
        if (!oldest) break
        delete profiles[oldest[0]][oldest[1]]
        if (Object.keys(profiles[oldest[0]]).length === 0) delete profiles[oldest[0]]
      }
      flush()
    },
    getWindow: (profile, name) => profiles[profile]?.[name],
    findNewest(name) {
      let best: WindowRecord | undefined
      for (const w of Object.values(profiles)) {
        const r = w[name]
        if (r && (!best || r.savedAt > best.savedAt)) best = r
      }
      return best
    },
    count,
  }
}
