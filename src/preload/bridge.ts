import { BRIDGE_VERSION, CAPABILITIES, CHANNELS, type DesktopInfo, type UctDesktop, type Unsubscribe, type WindowState } from '../shared/contract'

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

/** Null unless the page is on the app origin: the preload exposes nothing anywhere else. */
export function buildBridge(ipc: IpcRendererLike, locationOrigin: string, appOrigin: string): UctDesktop | null {
  if (!appOrigin || locationOrigin !== appOrigin) return null
  return {
    bridgeVersion: BRIDGE_VERSION,
    capabilities: [...CAPABILITIES],
    getInfo: () => ipc.invoke(CHANNELS.getInfo) as Promise<DesktopInfo>,
    onWindowState: (cb) => subscribe(ipc, CHANNELS.windowState, (s) => cb(s as WindowState)),
    onBeforeQuit: (cb) => subscribe(ipc, CHANNELS.beforeQuit, () => cb()),
    ackBeforeQuit: () => ipc.send(CHANNELS.ackBeforeQuit),
  }
}
