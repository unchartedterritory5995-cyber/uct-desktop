import { CHANNELS, SITE_EVENTS, type DesktopInfo, type SiteEvent } from '../../shared/contract'
import { assertTrustedSender, type SenderEventLike } from './sender'

export interface IpcMainLike {
  handle(channel: string, listener: (event: SenderEventLike) => unknown): void
  on(channel: string, listener: (event: SenderEventLike, ...args: unknown[]) => void): void
}

export interface BridgeDeps {
  origin: string
  getInfo(): DesktopInfo
  /** Task 18 supplies the real quit sequence; until then an ack is simply handed on. */
  onAckBeforeQuit(): void
  /** A site-reported event, already checked against SITE_EVENTS. */
  onSiteEvent?(name: SiteEvent): void
}

export function registerBridgeHandlers(ipc: IpcMainLike, deps: BridgeDeps): void {
  ipc.handle(CHANNELS.getInfo, (event) => {
    assertTrustedSender(event, deps.origin)
    return deps.getInfo()
  })
  ipc.on(CHANNELS.ackBeforeQuit, (event) => {
    try {
      assertTrustedSender(event, deps.origin)
    } catch {
      return
    }
    deps.onAckBeforeQuit()
  })
  ipc.on(CHANNELS.reportEvent, (event, name) => {
    try {
      assertTrustedSender(event, deps.origin)
    } catch {
      return
    }
    // Checked again here: the preload is not the only thing that can send on this channel.
    if (typeof name === 'string' && (SITE_EVENTS as readonly string[]).includes(name)) deps.onSiteEvent?.(name as SiteEvent)
  })
}
