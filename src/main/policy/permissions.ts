// The proof build grants exactly two things, to the exact app origin: notifications and audio.

export interface PermissionAsk {
  permission: string
  origin: string
  /** For a media request: which devices it wants. Undefined or empty is treated as asking for all. */
  mediaTypes?: readonly string[]
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
  if (ask.permission === 'notifications') return true
  if (ask.permission === 'media') {
    return ask.mediaTypes !== undefined && ask.mediaTypes.length > 0 && ask.mediaTypes.every((t) => t === 'audio')
  }
  return false
}
