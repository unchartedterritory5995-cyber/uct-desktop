// The one description of what the website may call. contract/bridge.json is the released surface;
// test/surface.test.ts keeps this file and that JSON in step. No method here accepts a URL.

export const BRIDGE_VERSION = 1
export const CAPABILITIES = ['window-state', 'before-quit'] as const

export const CHANNELS = {
  getInfo: 'uct:get-info',
  windowState: 'uct:window-state',
  beforeQuit: 'uct:before-quit',
  ackBeforeQuit: 'uct:ack-before-quit',
  retry: 'uct:retry',
} as const

export interface DesktopInfo {
  appVersion: string
  platform: string
}

export type WindowState = 'normal' | 'maximized' | 'minimized' | 'fullscreen' | 'hidden'
export type Unsubscribe = () => void

export interface UctDesktop {
  bridgeVersion: number
  capabilities: string[]
  getInfo(): Promise<DesktopInfo>
  onWindowState(cb: (state: WindowState) => void): Unsubscribe
  onBeforeQuit(cb: () => void): Unsubscribe
  ackBeforeQuit(): void
}

const FEATURE_METHODS: Record<string, string[]> = {
  'window-state': ['onWindowState'],
  'before-quit': ['onBeforeQuit', 'ackBeforeQuit'],
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
