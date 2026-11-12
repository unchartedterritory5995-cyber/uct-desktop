// Decides when the live site is not answering and drives the error page and the retries.
// Pure and clock-injected; main-window.ts supplies the Electron side.

export type LoadVerdict = 'ok' | 'origin-error' | 'network-error' | 'ignore'

export const ERR_ABORTED = -3
export const STALL_MS = 15000
const BACKOFF_STEPS_MS = [2000, 4000, 8000, 16000, 30000]

export function classifyLoad(input: {
  httpResponseCode?: number
  contentType?: string
  errorCode?: number
  /** The `cf-mitigated` response header, when present. */
  cfMitigated?: string
}): LoadVerdict {
  const { httpResponseCode, errorCode } = input
  if (errorCode !== undefined && errorCode !== 0) return errorCode === ERR_ABORTED ? 'ignore' : 'network-error'
  if (httpResponseCode === undefined) return 'ok'
  // Cloudflare's interactive challenge is a 403 the member can solve: let the page render.
  if (httpResponseCode === 403 && input.cfMitigated?.trim().toLowerCase() === 'challenge') return 'ok'
  // 5xx covers 502, 503 and Cloudflare's 520-530; any other 403 document is a block page.
  if (httpResponseCode >= 500 || httpResponseCode === 403) return 'origin-error'
  return 'ok'
}

export function backoffMs(failures: number): number {
  return BACKOFF_STEPS_MS[Math.min(Math.max(failures, 0), BACKOFF_STEPS_MS.length - 1)]
}

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface LoadGuardDeps {
  appOrigin: string
  /** Where the first load goes (a path on the app origin); "/" when absent or not on the origin. */
  startPath?: string
  clock: Clock
  /** Load this URL; it is always on the app origin. */
  load(url: string): void
  showError(kind: 'origin-error' | 'network-error'): void
  /** Called when the site answers after the error page was showing. */
  showApp(): void
}

export interface LoadGuard {
  start(): void
  retry(): void
  onNavigated(url: string, httpResponseCode: number, contentType?: string, cfMitigated?: string): void
  onFailLoad(url: string, errorCode: number): void
  dispose(): void
}

export function createLoadGuard(deps: LoadGuardDeps): LoadGuard {
  let stallTimer: unknown
  let retryTimer: unknown
  let failures = 0
  let errorShown = false
  const home = new URL(deps.appOrigin).href
  let target = home
  if (deps.startPath) {
    try {
      const u = new URL(deps.startPath, deps.appOrigin)
      if (u.origin === new URL(deps.appOrigin).origin) target = u.href
    } catch {
      /* keep home */
    }
  }
  let disposed = false
  let hasStallTimer = false
  let hasRetryTimer = false

  const clearStall = () => {
    if (hasStallTimer) deps.clock.clearTimeout(stallTimer)
    hasStallTimer = false
  }
  const clearRetry = () => {
    if (hasRetryTimer) deps.clock.clearTimeout(retryTimer)
    hasRetryTimer = false
  }

  const attempt = () => {
    if (disposed) return
    clearRetry()
    clearStall()
    deps.load(target)
    hasStallTimer = true
    stallTimer = deps.clock.setTimeout(() => {
      hasStallTimer = false
      fail('origin-error')
    }, STALL_MS)
  }

  const fail = (kind: 'origin-error' | 'network-error') => {
    if (disposed) return
    clearStall()
    clearRetry()
    errorShown = true
    deps.showError(kind)
    const delay = backoffMs(failures++)
    hasRetryTimer = true
    retryTimer = deps.clock.setTimeout(() => {
      hasRetryTimer = false
      attempt()
    }, delay)
  }

  // Remember the failed route (app origin only) so a 502 on /charts returns to /charts.
  const remember = (url: string): void => {
    try {
      const u = new URL(url)
      if (u.origin === deps.appOrigin && !u.username && !u.password) target = u.href
    } catch {
      /* keep the previous target */
    }
  }

  const isApp = (url: string): boolean => {
    try {
      return new URL(url).origin === deps.appOrigin
    } catch {
      return false
    }
  }

  return {
    start: attempt,
    retry() {
      failures = 0
      attempt()
    },
    onNavigated(url, httpResponseCode, contentType, cfMitigated) {
      if (disposed || !isApp(url)) return
      const verdict = classifyLoad({ httpResponseCode, contentType, cfMitigated })
      if (verdict === 'origin-error') {
        remember(url)
        return fail('origin-error')
      }
      if (verdict !== 'ok') return
      clearStall()
      clearRetry()
      failures = 0
      target = home
      if (errorShown) {
        errorShown = false
        deps.showApp()
      }
    },
    onFailLoad(url, errorCode) {
      if (disposed || !isApp(url)) return
      const verdict = classifyLoad({ errorCode })
      if (verdict === 'network-error') {
        remember(url)
        fail('network-error')
      }
    },
    dispose() {
      disposed = true
      clearStall()
      clearRetry()
    },
  }
}
