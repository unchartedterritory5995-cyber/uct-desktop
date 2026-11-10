// Crash and hang recovery for the main window. Clock, time source and dialog are injected so every
// rule is unit-tested without Electron. Nothing here ever kills a renderer on its own: a crashed
// renderer is reloaded (it is already dead), a hung one only after the member picks Reload.
import type { Clock } from './load-guard'

export const MAX_RELOADS = 3
export const RELOAD_WINDOW_MS = 10 * 60_000
export const UNRESPONSIVE_MS = 20_000

export interface DialogLike {
  showMessageBox(options: {
    type: 'question'
    message: string
    detail: string
    buttons: string[]
    defaultId: number
    cancelId: number
  }): Promise<{ response: number }>
}

interface ChildLike {
  destroy(): void
  isDestroyed(): boolean
}
interface WebContentsLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown
  reload(): void
}
export interface RecoverableWindow {
  webContents: WebContentsLike
  isDestroyed(): boolean
  getChildWindows(): ChildLike[]
}

export interface RecoveryDeps {
  win: RecoverableWindow
  now(): number
  dialog: DialogLike
  clock: Clock
  /** Show the app-shell error page (its Try again button reloads the site). */
  showError(kind: 'origin-error'): void
}

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
})

/** 9:30-16:00 Eastern, Monday to Friday (D19). Holidays are not modelled: the safe error is "true". */
export function isMarketHours(epochMs: number): boolean {
  const parts = Object.fromEntries(ET.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]))
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  const minutes = Number(parts.hour) * 60 + Number(parts.minute)
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60
}

export function createRecovery(deps: RecoveryDeps): { dispose(): void } {
  const { win, clock } = deps
  const wc = win.webContents
  let reloads: number[] = []
  let hangTimer: unknown
  let hasHangTimer = false
  let hung = false
  let asking = false
  let disposed = false

  const destroyChildren = (): void => {
    for (const child of win.getChildWindows()) if (!child.isDestroyed()) child.destroy()
  }

  const reloadCapped = (): void => {
    const cutoff = deps.now() - RELOAD_WINDOW_MS
    reloads = reloads.filter((t) => t > cutoff)
    if (reloads.length >= MAX_RELOADS) return deps.showError('origin-error')
    reloads.push(deps.now())
    destroyChildren()
    wc.reload()
  }

  const clearHang = (): void => {
    if (hasHangTimer) clock.clearTimeout(hangTimer)
    hasHangTimer = false
  }

  const armHang = (): void => {
    clearHang()
    hasHangTimer = true
    hangTimer = clock.setTimeout(() => {
      hasHangTimer = false
      void ask()
    }, UNRESPONSIVE_MS)
  }

  const ask = async (): Promise<void> => {
    if (disposed || !hung || asking || win.isDestroyed()) return
    asking = true
    try {
      // In market hours Wait is the default, so a stray Enter never costs the member their desk.
      const { response } = await deps.dialog.showMessageBox({
        type: 'question',
        message: 'UCT Intelligence is not responding',
        detail: 'You can keep waiting or reload the window.',
        buttons: ['Wait', 'Reload'],
        defaultId: isMarketHours(deps.now()) ? 0 : 1,
        cancelId: 0,
      })
      if (disposed || !hung) return
      if (response === 1) {
        hung = false
        reloadCapped()
      } else armHang()
    } finally {
      asking = false
    }
  }

  const onGone = (_event: unknown, details: { reason?: string }): void => {
    if (disposed || details?.reason === 'clean-exit') return
    hung = false
    clearHang()
    reloadCapped()
  }
  const onUnresponsive = (): void => {
    if (disposed) return
    hung = true
    armHang()
  }
  const onResponsive = (): void => {
    hung = false
    clearHang()
  }

  wc.on('render-process-gone', onGone)
  wc.on('unresponsive', onUnresponsive)
  wc.on('responsive', onResponsive)

  return {
    dispose() {
      disposed = true
      clearHang()
      wc.removeListener('render-process-gone', onGone)
      wc.removeListener('unresponsive', onUnresponsive)
      wc.removeListener('responsive', onResponsive)
    },
  }
}
