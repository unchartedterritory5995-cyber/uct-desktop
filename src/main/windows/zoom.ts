import type { Event, Input, WebContents } from 'electron'

export type ZoomAction = 'in' | 'out' | 'reset'
type KeyPress = Pick<Input, 'type' | 'key' | 'control' | 'alt' | 'meta'>

const STEP = 0.5
const MAX_LEVEL = 3

/** Chrome's zoom keys. Electron's default menu only answers Ctrl+Shift+= for zooming in. */
export function zoomAction(input: KeyPress): ZoomAction | null {
  if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null
  if (input.key === '=' || input.key === '+') return 'in'
  if (input.key === '-' || input.key === '_') return 'out'
  if (input.key === '0') return 'reset'
  return null
}

export function nextZoomLevel(level: number, action: ZoomAction): number {
  if (action === 'reset') return 0
  const next = level + (action === 'in' ? STEP : -STEP)
  return Math.min(MAX_LEVEL, Math.max(-MAX_LEVEL, next))
}

/** `enabled` lets the title bar page opt out: only the site zooms. */
export function installZoomKeys(contents: WebContents, enabled: () => boolean = () => true): void {
  contents.on('before-input-event', (event: Event, input: Input) => {
    if (!enabled()) return
    const action = zoomAction(input)
    if (!action) return
    event.preventDefault()
    contents.setZoomLevel(nextZoomLevel(contents.getZoomLevel(), action))
  })
}
