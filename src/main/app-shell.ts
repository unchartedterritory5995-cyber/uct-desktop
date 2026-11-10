// The app's own offline page. Pure lookups only; the Electron wiring is in app-shell-protocol.ts.
// Files are found by NAME in a static map: no path is ever built from a request.

export const APP_SHELL_SCHEME = 'app-shell'
export const APP_SHELL_ORIGIN = 'app-shell://shell'

export interface ShellFile {
  file: string
  type: string
}

export const SHELL_FILES: Readonly<Record<string, ShellFile>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, ShellFile>, {
    'error.html': { file: 'error.html', type: 'text/html; charset=utf-8' },
    'error.js': { file: 'error.js', type: 'text/javascript; charset=utf-8' },
    'bar.html': { file: 'bar.html', type: 'text/html; charset=utf-8' },
    'bar.js': { file: 'bar.js', type: 'text/javascript; charset=utf-8' },
  }),
)

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

export function resolveShellFile(url: string): ShellFile | null {
  const u = parse(url)
  if (!u || u.protocol !== `${APP_SHELL_SCHEME}:` || u.host !== 'shell') return null
  const name = u.pathname.slice(1)
  return Object.hasOwn(SHELL_FILES, name) ? SHELL_FILES[name] : null
}

export interface ShellSenderEvent {
  senderFrame: { url: string; parent: unknown | null } | null | undefined
}

function isPageSender(event: ShellSenderEvent, pathname: string): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return false
  const u = parse(frame.url)
  return !!u && u.protocol === `${APP_SHELL_SCHEME}:` && u.host === 'shell' && u.pathname === pathname
}

/** The separate sender check for `retry`: only the top frame of the error page itself. */
export function isShellSender(event: ShellSenderEvent): boolean {
  return isPageSender(event, '/error.html')
}

/** The sender check for the title bar's `back`: only the top frame of bar.html. */
export function isBarSender(event: ShellSenderEvent): boolean {
  return isPageSender(event, '/bar.html')
}
