import { CHANNELS, type DesktopInfo } from '../../shared/contract'
import { assertTrustedSender, type SenderEventLike } from './sender'

export interface IpcMainLike {
  handle(channel: string, listener: (event: SenderEventLike) => unknown): void
  on(channel: string, listener: (event: SenderEventLike) => void): void
}

export interface BridgeDeps {
  origin: string
  getInfo(): DesktopInfo
  /** Task 18 supplies the real quit sequence; until then an ack is simply handed on. */
  onAckBeforeQuit(): void
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
}
