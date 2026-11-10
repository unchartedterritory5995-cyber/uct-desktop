// Every IPC handler calls this first. Exact origin, top frame, https only. A frame is judged by its
// own URL, so about:blank and blob: documents that merely inherit the app's origin are refused.

export interface FrameLike {
  url: string
  parent: unknown | null
}
export interface SenderEventLike {
  senderFrame: FrameLike | null | undefined
}

export function isTrustedSender(event: SenderEventLike, origin: string): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return false
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return false
  }
  return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password
}

export function assertTrustedSender(event: SenderEventLike, origin: string): void {
  if (!isTrustedSender(event, origin)) throw new Error('Untrusted IPC sender')
}
