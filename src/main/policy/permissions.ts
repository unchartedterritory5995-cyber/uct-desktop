// Granted only to the exact app origin: audio, full screen for video, writing to the clipboard for
// the site's Copy buttons, and notifications from the main window only, so nothing notifies twice.

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
  if (ask.permission === 'clipboard-sanitized-write' || ask.permission === 'fullscreen') return true
  if (ask.permission === 'media') {
    return ask.mediaTypes !== undefined && ask.mediaTypes.length > 0 && ask.mediaTypes.every((t) => t === 'audio')
  }
  return false
}
