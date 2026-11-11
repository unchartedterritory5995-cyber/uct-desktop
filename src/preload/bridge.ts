import { BRIDGE_VERSION, CAPABILITIES, CHANNELS, SITE_EVENTS, type DeskVisibility, type DesktopInfo, type UctDesktop, type Unsubscribe, type WindowState } from '../shared/contract'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

function subscribe(ipc: IpcRendererLike, channel: string, cb: (...args: unknown[]) => void): Unsubscribe {
  const listener = (_event: unknown, ...args: unknown[]): void => cb(...args)
  ipc.on(channel, listener)
  return () => {
    ipc.removeListener(channel, listener)
  }
}

/** The error page's own tiny bridge: just `retry`, and only on the app-shell origin. */
export function buildShellBridge(ipc: IpcRendererLike, locationOrigin: string): { retry(): void } | null {
  if (locationOrigin !== 'app-shell://shell') return null
  return { retry: () => ipc.send(CHANNELS.retry) }
}

/** The title bar page's own bridge: just `back()`, no arguments, only on the app-shell origin. */
export function buildBarBridge(ipc: IpcRendererLike, locationOrigin: string): { back(): void } | null {
  if (locationOrigin !== 'app-shell://shell') return null
  return { back: () => ipc.send(CHANNELS.barBack) }
}

/** Null unless the page is on the app origin: the preload exposes nothing anywhere else. */
export function buildBridge(ipc: IpcRendererLike, locationOrigin: string, appOrigin: string): UctDesktop | null {
  if (!appOrigin || locationOrigin !== appOrigin) return null
  return {
    bridgeVersion: BRIDGE_VERSION,
    capabilities: [...CAPABILITIES],
    getInfo: () => ipc.invoke(CHANNELS.getInfo) as Promise<DesktopInfo>,
    onWindowState: (cb) => subscribe(ipc, CHANNELS.windowState, (s) => cb(s as WindowState)),
    onDeskVisibility: (cb) => subscribe(ipc, CHANNELS.deskVisibility, (s) => cb(s as DeskVisibility)),
    onBeforeQuit: (cb) => subscribe(ipc, CHANNELS.beforeQuit, () => cb()),
    ackBeforeQuit: () => ipc.send(CHANNELS.ackBeforeQuit),
    // Only a name from SITE_EVENTS crosses; anything else (including a non-string) is dropped here.
    reportEvent: (name) => {
      if (typeof name === 'string' && (SITE_EVENTS as readonly string[]).includes(name)) ipc.send(CHANNELS.reportEvent, name)
    },
  }
}
