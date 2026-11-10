// Tray residency (owner decision 2026-11-10): closing the window hides the whole desk and the app
// keeps running, so the next open is instant. A real Quit (tray or menu) still goes through the quit
// controller. A pending update installs only after hours, with no window showing, after the app has
// been hidden for IDLE_BEFORE_INSTALL_MS, so it can never interrupt a trader.
import type { Clock } from './load-guard'
import { isMarketHours } from './market-hours'

export const INSTALL_CHECK_MS = 5 * 60_000
export const IDLE_BEFORE_INSTALL_MS = 10 * 60_000
/** Passed by the Start with Windows login item: start in the tray, no window. */
export const HIDDEN_FLAG = '--hidden'

export function launchedHidden(argv: string[]): boolean {
  return argv.includes(HIDDEN_FLAG)
}

export interface ResidencyDeps {
  clock: Clock
  now(): number
  /** Hide the main window and every pop-out board; the website hears `hidden` and goes idle. */
  hideAll(): void
  showAll(): void
  hasPendingUpdate(): boolean
  /** Notify the site, then quitAndInstall. Called at most once. */
  installUpdate(): void
}

export function createResidency(deps: ResidencyDeps) {
  let quitting = false
  let hiddenSince: number | null = null
  let installed = false
  let timer: unknown
  let hasTimer = false
  let disposed = false

  const schedule = () => {
    if (disposed) return
    hasTimer = true
    timer = deps.clock.setTimeout(() => {
      hasTimer = false
      check()
      schedule()
    }, INSTALL_CHECK_MS)
  }

  const check = () => {
    if (installed || quitting || hiddenSince === null) return
    const now = deps.now()
    if (now - hiddenSince < IDLE_BEFORE_INSTALL_MS) return
    if (isMarketHours(now)) return
    if (!deps.hasPendingUpdate()) return
    installed = true
    deps.installUpdate()
  }

  schedule()

  return {
    /** The main window's close: 'hide' means preventDefault and stay resident. */
    onClose(): 'hide' | 'allow' {
      if (quitting) return 'allow'
      if (hiddenSince === null) hiddenSince = deps.now()
      deps.hideAll()
      return 'hide'
    },
    /** Started in the tray (login item): counts as hidden from launch. */
    startHidden(): void {
      hiddenSince = deps.now()
    },
    open(): void {
      hiddenSince = null
      deps.showAll()
    },
    quitRequested(): void {
      quitting = true
    },
    isQuitting: () => quitting,
    isHidden: () => hiddenSince !== null,
    dispose(): void {
      disposed = true
      if (hasTimer) deps.clock.clearTimeout(timer)
      hasTimer = false
    },
  }
}
