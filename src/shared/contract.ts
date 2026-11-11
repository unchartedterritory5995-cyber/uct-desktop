// The one description of what the website may call. contract/bridge.json is the released surface;
// test/surface.test.ts keeps this file and that JSON in step. No method here accepts a URL.

export const BRIDGE_VERSION = 1
export const CAPABILITIES = ['window-state', 'before-quit', 'desk-visibility', 'site-events', 'app-update'] as const

/** The only names the website may report (telemetry plan 5.1). Anything else is dropped, in the
 * preload AND in the main process. The shell turns them into enum-only telemetry events. */
export const SITE_EVENTS = ['signed_in', 'desk_restored'] as const
export type SiteEvent = (typeof SITE_EVENTS)[number]

export const CHANNELS = {
  getInfo: 'uct:get-info',
  windowState: 'uct:window-state',
  deskVisibility: 'uct:desk-visibility',
  beforeQuit: 'uct:before-quit',
  ackBeforeQuit: 'uct:ack-before-quit',
  reportEvent: 'uct:report-event',
  appUpdate: 'uct:app-update',
  getAppUpdate: 'uct:get-app-update',
  restartToUpdate: 'uct:restart-to-update',
  retry: 'uct:retry',
  barBack: 'uct:bar-back',
} as const

export interface DesktopInfo {
  appVersion: string
  platform: string
}

export type WindowState = 'normal' | 'maximized' | 'minimized' | 'fullscreen' | 'hidden'
/** The WHOLE desk: 'hidden' only when every app window is hidden or minimized (pop-outs count). */
export type DeskVisibility = 'visible' | 'hidden'
export type Unsubscribe = () => void
/** A downloaded app update waiting to install, or null when there is none (or it was withdrawn). */
export type AppUpdate = { version: string } | null

export interface UctDesktop {
  bridgeVersion: number
  capabilities: string[]
  getInfo(): Promise<DesktopInfo>
  onWindowState(cb: (state: WindowState) => void): Unsubscribe
  onDeskVisibility(cb: (state: DeskVisibility) => void): Unsubscribe
  onBeforeQuit(cb: () => void): Unsubscribe
  ackBeforeQuit(): void
  reportEvent(name: SiteEvent): void
  /** The update waiting now (a page that loads after the download asks instead of waiting). */
  getAppUpdate(): Promise<AppUpdate>
  onAppUpdate(cb: (update: AppUpdate) => void): Unsubscribe
  /** The member clicked "Restart to update": the shell runs the normal quit, then installs. No arguments. */
  restartToUpdate(): void
}

const FEATURE_METHODS: Record<string, string[]> = {
  'window-state': ['onWindowState'],
  'desk-visibility': ['onDeskVisibility'],
  'before-quit': ['onBeforeQuit', 'ackBeforeQuit'],
  'site-events': ['reportEvent'],
  'app-update': ['getAppUpdate', 'onAppUpdate', 'restartToUpdate'],
}

/** True only when the bridge exists, lists the capability, and has the functions that back it. */
export function hasDesktopFeature(name: string, bridge: unknown = (globalThis as { uctDesktop?: unknown }).uctDesktop): boolean {
  if (!bridge || typeof bridge !== 'object') return false
  const caps = (bridge as { capabilities?: unknown }).capabilities
  if (!Array.isArray(caps) || !caps.includes(name)) return false
  const backing = FEATURE_METHODS[name]
  if (!backing) return false
  return backing.every((m) => typeof (bridge as Record<string, unknown>)[m] === 'function')
}
