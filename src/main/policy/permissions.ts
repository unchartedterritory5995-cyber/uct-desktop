// Granted only to the exact app origin: full screen for video, writing to the clipboard for the
// site's Copy buttons, and notifications from the main window only, so nothing notifies twice.
// The microphone is separate: see mediaEligible and policy/microphone.ts.

export interface PermissionAsk {
  permission: string
  origin: string
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
  // 'media' is decided by mediaEligible plus the consent gate, never here.
  return false
}

export interface MediaAsk {
  /** The last URL the requesting frame loaded. The origin is matched through this. */
  requestingUrl: string
  /** Browser-process origin, trusted only to name the app for a popup that is still about:blank. */
  securityOrigin?: string
  mediaTypes?: readonly string[]
  isMainFrame: boolean
  windowFocused: boolean
}

/**
 * Everything about a microphone request except the member's consent: audio only (exactly
 * ['audio']), top frame, app origin, and a focused window. It deliberately does not care WHICH
 * window, so a popped-out board or portal on the app origin can use voice input too.
 */
export function mediaEligible(ask: MediaAsk, appOrigin: string): boolean {
  if (!ask.isMainFrame || !ask.windowFocused) return false
  if (!ask.mediaTypes || ask.mediaTypes.length !== 1 || ask.mediaTypes[0] !== 'audio') return false
  let origin = originOf(ask.requestingUrl)
  // A popped-out portal is about:blank until the site writes it, but carries the app's origin.
  if (ask.requestingUrl === 'about:blank') origin = ask.securityOrigin ? originOf(ask.securityOrigin) : null
  return origin === appOrigin
}
