// Quit and lifecycle rules, free of Electron so each one is unit-tested.
// Close means quit. The website gets 500 ms to run its onBeforeQuit work (markAppClosing) and call
// ackBeforeQuit; the website does not ack yet, so for now the wait always runs out. That is expected.
import type { Clock } from './load-guard'

export const QUIT_WAIT_MS = 500

export type QuitReason = 'quit' | 'session-end'

export interface QuitDeps {
  sendBeforeQuit(): void
  /** Really quit (app.quit()); only called once, and the caller must let it through allowClose(). */
  finalize(): void
  clock: Clock
  waitMs?: number
}

export interface QuitController {
  requestQuit(reason: QuitReason): void
  ack(): void
  /** autoUpdater's before-quit-for-update: notify, but never hold the quit back. */
  beforeQuitForUpdate(): void
  /** True once a close/quit may go straight through (quit finished, or an update is installing). */
  allowClose(): boolean
}

export function createQuitController(deps: QuitDeps): QuitController {
  const waitMs = deps.waitMs ?? QUIT_WAIT_MS
  let phase: 'idle' | 'waiting' | 'done' = 'idle'
  let updating = false
  let notified = false
  let timer: unknown
  let hasTimer = false

  const notify = (): void => {
    if (notified) return
    notified = true
    deps.sendBeforeQuit()
  }
  const finish = (): void => {
    if (phase === 'done') return
    phase = 'done'
    if (hasTimer) deps.clock.clearTimeout(timer)
    hasTimer = false
    deps.finalize()
  }

  return {
    requestQuit(reason) {
      if (phase !== 'idle') return
      // Windows is ending the session: there is no time to wait.
      if (reason === 'session-end') return finish()
      phase = 'waiting'
      notify()
      hasTimer = true
      timer = deps.clock.setTimeout(() => {
        hasTimer = false
        finish()
      }, waitMs)
    },
    ack() {
      if (phase === 'waiting') finish()
    },
    beforeQuitForUpdate() {
      updating = true
      notify()
    },
    allowClose: () => phase === 'done' || updating,
  }
}

export interface FocusableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

/** The single-instance lock: a second launch brings the existing window forward. */
export function focusExistingWindow(win: FocusableWindow | undefined): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
