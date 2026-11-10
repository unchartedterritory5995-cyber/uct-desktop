// The app's black box: one JSON line per lifecycle event under userData/logs, so an exit or a crash
// leaves a trail a member can paste into support (Help > Copy Diagnostics) instead of nothing.
// Rules: every string is scrubbed before it reaches the disk; nothing here ever throws; the log is
// capped (one rotated file kept); a session marker tells the next launch that this one died.
import { scrub } from './diagnostics'

export interface LogFs {
  appendFile(path: string, data: string): void
  readFile(path: string): string
  writeFile(path: string, data: string): void
  size(path: string): number
  rename(from: string, to: string): void
  unlink(path: string): void
  exists(path: string): boolean
  mkdir(dir: string): void
}

export type Fields = Record<string, string | number | boolean | null | undefined>

export const DEFAULT_MAX_BYTES = 1_000_000

export function createEventLog(deps: { dir: string; fs: LogFs; now(): number; maxBytes?: number }) {
  const { dir, fs, now } = deps
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES
  const current = `${dir}/events.log`
  const previous = `${dir}/events.1.log`
  const marker = `${dir}/running.json`
  let dirReady = false

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }

  const ensureDir = () => {
    if (!dirReady) {
      fs.mkdir(dir)
      dirReady = true
    }
  }

  function record(event: string, fields: Fields = {}): void {
    safe(() => {
      ensureDir()
      const clean: Record<string, string | number | boolean | null> = { t: new Date(now()).toISOString(), event: scrub(event) }
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || k === 't' || k === 'event') continue
        clean[k] = typeof v === 'string' ? scrub(v).slice(0, 500) : v
      }
      const line = JSON.stringify(clean) + '\n'
      if (fs.exists(current) && fs.size(current) + line.length > maxBytes) {
        if (fs.exists(previous)) fs.unlink(previous)
        fs.rename(current, previous)
      }
      fs.appendFile(current, line)
    }, undefined)
  }

  function tail(n: number): string[] {
    return safe(() => {
      const read = (p: string) => (fs.exists(p) ? fs.readFile(p) : '')
      const lines = (read(previous) + read(current)).split('\n').filter(Boolean)
      return lines.slice(-n)
    }, [])
  }

  /** Call once at launch. Reports (and logs) whether the previous run ended without endSession. */
  function startSession(version: string):
    | { previousUnclean: false }
    | { previousUnclean: true; previous: { version: string; startedAt: string } | null } {
    const result = safe(() => {
      if (!fs.exists(marker)) return { previousUnclean: false as const }
      const prev = safe(() => {
        const p = JSON.parse(fs.readFile(marker))
        return typeof p?.version === 'string' && typeof p?.startedAt === 'string' ? { version: p.version, startedAt: p.startedAt } : null
      }, null)
      return { previousUnclean: true as const, previous: prev }
    }, { previousUnclean: false as const })
    if (result.previousUnclean) {
      record('previous-exit-unclean', { previousVersion: result.previous?.version ?? null, previousStart: result.previous?.startedAt ?? null })
    }
    record('launch', { version })
    safe(() => {
      ensureDir()
      fs.writeFile(marker, JSON.stringify({ version, startedAt: new Date(now()).toISOString() }))
    }, undefined)
    return result
  }

  /** Call when the process is about to exit on purpose (will-quit). */
  function endSession(reason: string): void {
    record('exit', { reason })
    safe(() => fs.exists(marker) && fs.unlink(marker), false)
  }

  return { record, tail, startSession, endSession }
}
