// The proof build grants exactly two things, to the exact app origin: audio, and notifications
// from the main window only, so a popped-out page cannot notify a second time.

export interface PermissionAsk {
  permission: string
  origin: string
  /** For a media request: which devices it wants. Undefined or empty is treated as asking for all. */
  mediaTypes?: readonly string[]
  fromMainWindow?: boolean
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

export function isPermissionAllowed(ask: PermissionAsk, appOrigin: string): boolean {
  if (originOf(ask.origin) !== appOrigin) return false
  if (ask.permission === 'notifications') return ask.fromMainWindow === true
  if (ask.permission === 'media') {
    return ask.mediaTypes !== undefined && ask.mediaTypes.length > 0 && ask.mediaTypes.every((t) => t === 'audio')
  }
  return false
}
