// Lean telemetry (desktop plan 5.1, v2 Task 30): a fixed set of lifecycle events, sent to the
// website's POST /api/desktop/event. Enum-only by construction: an event is a name from TelemetryEvent,
// an optional error code from a fixed set or `net_<n>`, the shell version and the OS release. No
// message, URL, path, account or window content is ever sent. The install id is a random 32-hex string
// made on first run; the server stores only a salted hash of it, so it can count machines.
//
// Events wait in a small queue on disk (userData/telemetry.json), so a crash, an offline launch or a
// load failure is still reported on the next successful send. The queue is capped; the oldest go first.
// If the server answers `enabled: false` (its kill switch), the shell stops sending and drops the queue
// for the rest of the run. Filesystem, network and clock are injected so it is unit-tested.
import type { StoreFs } from './windows/layout-store'

export type TelemetryEvent =
  | 'launch_ok'
  | 'load_failed'
  | 'unclean_exit'
  | 'renderer_crash'
  | 'gpu_crash'
  | 'site_unresponsive'
  | 'update_downloaded'
  | 'update_installed'
  | 'update_error'
  | 'first_signin'
  | 'desk_restored'

export interface QueuedEvent {
  event: TelemetryEvent
  shell_version: string
  os: string
  error_code?: string
  install: string
  ts: number
}

interface State {
  install: string
  lastVersion: string | null
  queue: QueuedEvent[]
  signedInOnce?: boolean
}

export type SendResult = { enabled: boolean } | null // null: the request failed, keep the queue

export interface TelemetryDeps {
  file: string
  fs: StoreFs
  send: (body: string) => Promise<SendResult>
  version: string
  os: string
  now: () => number
  randomHex32: () => string
  clock: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
  flushDelayMs?: number
}

export const MAX_QUEUE = 50
const INSTALL_RE = /^[0-9a-f]{32}$/
const ERROR_CODES = new Set([
  'clean_exit', 'abnormal_exit', 'killed', 'crashed', 'oom', 'launch_failed', 'integrity_failure',
  'memory_eviction', 'signature', 'integrity', 'network', 'feed', 'other',
])

/** Chromium net error (negative number) to the wire form, e.g. -105 -> net_105. */
export function netCode(code: number): string | undefined {
  return Number.isInteger(code) && code !== 0 && Math.abs(code) < 10000 ? `net_${Math.abs(code)}` : undefined
}

/** Electron's process-gone reason (e.g. 'abnormal-exit') to the wire form, or undefined if unknown. */
export function reasonCode(reason: string): string | undefined {
  const c = String(reason).replace(/-/g, '_')
  return ERROR_CODES.has(c) ? c : undefined
}

export function createTelemetry(deps: TelemetryDeps) {
  const delay = deps.flushDelayMs ?? 3000
  let state = load()
  let stopped = false
  let inFlight = false
  let timer: unknown

  function load(): State {
    try {
      const raw = JSON.parse(deps.fs.readFile(deps.file))
      const install = typeof raw?.install === 'string' && INSTALL_RE.test(raw.install) ? raw.install : deps.randomHex32()
      const queue = Array.isArray(raw?.queue) ? (raw.queue as QueuedEvent[]).filter((e) => e && typeof e.event === 'string').slice(-MAX_QUEUE) : []
      return { install, lastVersion: typeof raw?.lastVersion === 'string' ? raw.lastVersion : null, queue, signedInOnce: raw?.signedInOnce === true }
    } catch {
      return { install: deps.randomHex32(), lastVersion: null, queue: [] }
    }
  }

  function save(): void {
    try {
      const dir = deps.file.replace(/[\\/][^\\/]*$/, '')
      if (dir && dir !== deps.file) deps.fs.mkdir(dir)
      const tmp = `${deps.file}.tmp`
      deps.fs.writeFile(tmp, JSON.stringify(state), { flush: true })
      deps.fs.rename(tmp, deps.file)
    } catch {
      // Telemetry must never break the app; an unsaved queue only loses reports.
    }
  }

  function schedule(): void {
    if (stopped || timer !== undefined) return
    timer = deps.clock.setTimeout(() => {
      timer = undefined
      void flush()
    }, delay)
  }

  /** Queue one event and send soon. Unknown error codes are dropped from the event, never sent. */
  function report(event: TelemetryEvent, errorCode?: string): void {
    if (stopped) return
    const e: QueuedEvent = { event, shell_version: deps.version, os: deps.os, install: state.install, ts: Math.floor(deps.now() / 1000) }
    if (errorCode && (ERROR_CODES.has(errorCode) || /^net_\d{1,4}$/.test(errorCode))) e.error_code = errorCode
    state.queue.push(e)
    if (state.queue.length > MAX_QUEUE) state.queue = state.queue.slice(-MAX_QUEUE)
    save()
    schedule()
  }

  /** Call once at launch: reports update_installed on the first launch of a new version only. */
  function noteLaunch(): void {
    const previous = state.lastVersion
    if (previous !== deps.version) {
      state.lastVersion = deps.version
      if (previous !== null) report('update_installed')
      else save()
    }
  }

  /** The site reports a signed-in member: first_signin is sent once per install, ever. */
  function noteSignedIn(): void {
    if (state.signedInOnce) return
    state.signedInOnce = true
    report('first_signin')
  }

  let deskRestoredSent = false
  /** The site re-opened a saved desk at launch: once per run. */
  function noteDeskRestored(): void {
    if (deskRestoredSent) return
    deskRestoredSent = true
    report('desk_restored')
  }

  async function flush(): Promise<void> {
    if (stopped || inFlight || state.queue.length === 0) return
    inFlight = true
    const batch = state.queue.slice(0, MAX_QUEUE)
    try {
      const result = await deps.send(JSON.stringify({ events: batch }))
      if (result === null) return // offline or server error: keep everything for the next try
      if (!result.enabled) {
        stopped = true
        state.queue = []
        save()
        return
      }
      state.queue = state.queue.slice(batch.length)
      save()
    } catch {
      // A thrown send is treated like a failed one.
    } finally {
      inFlight = false
    }
    if (state.queue.length > 0) schedule()
  }

  function stop(): void {
    stopped = true
    if (timer !== undefined) deps.clock.clearTimeout(timer)
    timer = undefined
  }

  return {
    report,
    noteLaunch,
    noteSignedIn,
    noteDeskRestored,
    flush,
    stop,
    isStopped: () => stopped,
    queued: () => state.queue.length,
    installId: () => state.install,
  }
}
