// Decides when the live site is not answering and drives the error page and the retries.
// Pure and clock-injected; main-window.ts supplies the Electron side.

export type LoadVerdict = 'ok' | 'origin-error' | 'network-error' | 'ignore'

export const ERR_ABORTED = -3
export const STALL_MS = 15000
const BACKOFF_STEPS_MS = [2000, 4000, 8000, 16000, 30000]

export function classifyLoad(input: { httpResponseCode?: number; contentType?: string; errorCode?: number }): LoadVerdict {
  const { httpResponseCode, errorCode } = input
  if (errorCode !== undefined && errorCode !== 0) return errorCode === ERR_ABORTED ? 'ignore' : 'network-error'
  if (httpResponseCode === undefined) return 'ok'
  // 5xx covers 502, 503 and Cloudflare's 520-530; a 403 on the document is a challenge page.
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
  clock: Clock
  load(): void
  showError(kind: 'origin-error' | 'network-error'): void
  /** Called when the site answers after the error page was showing. */
  showApp(): void
}

export interface LoadGuard {
  start(): void
  retry(): void
  onNavigated(url: string, httpResponseCode: number, contentType?: string): void
  onFailLoad(url: string, errorCode: number): void
  dispose(): void
}

export function createLoadGuard(deps: LoadGuardDeps): LoadGuard {
  let stallTimer: unknown
  let retryTimer: unknown
  let failures = 0
  let errorShown = false
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
    deps.load()
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
    onNavigated(url, httpResponseCode, contentType) {
      if (disposed || !isApp(url)) return
      const verdict = classifyLoad({ httpResponseCode, contentType })
      if (verdict === 'origin-error') return fail('origin-error')
      if (verdict !== 'ok') return
      clearStall()
      clearRetry()
      failures = 0
      if (errorShown) {
        errorShown = false
        deps.showApp()
      }
    },
    onFailLoad(url, errorCode) {
      if (disposed || !isApp(url)) return
      const verdict = classifyLoad({ errorCode })
      if (verdict === 'network-error') fail('network-error')
    },
    dispose() {
      disposed = true
      clearStall()
      clearRetry()
    },
  }
}
