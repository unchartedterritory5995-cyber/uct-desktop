// The Electron-free half of main-window wiring, so it can be tested with fakes.
import type { ShellSenderEvent } from '../app-shell'
import type { LoadGuard } from '../load-guard'

export interface EventSource {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
}

/** Case-insensitive first value of a response header, as Electron hands them over. */
export function headerValue(headers: Record<string, string | string[]> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  if (!key) return undefined
  const v = headers[key]
  return Array.isArray(v) ? v[0] : v
}

/** Only main-frame loads reach the guard; a failing subframe or widget must never show the error page. */
export function wireLoadEvents(wc: EventSource, guard: LoadGuard, challengeHeader: (url: string) => string | undefined): void {
  wc.on('did-fail-load', (_e: unknown, code: number, _desc: string, url: string, isMainFrame: boolean) => {
    if (isMainFrame) guard.onFailLoad(url, code)
  })
  wc.on('did-frame-navigate', (_e: unknown, url: string, httpResponseCode: number, _text: string, isMainFrame: boolean) => {
    if (isMainFrame) guard.onNavigated(url, httpResponseCode, undefined, challengeHeader(url))
  })
}

/** `retry` is honoured only from the main window's own error page. */
export function makeRetryHandler(
  wc: unknown,
  guard: Pick<LoadGuard, 'retry'>,
  isShellSender: (event: ShellSenderEvent) => boolean,
): (event: { sender: unknown } & ShellSenderEvent) => void {
  return (event) => {
    if (event.sender !== wc || !isShellSender(event)) return
    guard.retry()
  }
}
