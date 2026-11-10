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
  /** Call before quitAndInstall: notify, then resolve on ack or after the wait. Nothing blocks after. */
  prepareForUpdate(): Promise<void>
  /** autoUpdater's before-quit-for-update: notify, but never hold the quit back. */
  beforeQuitForUpdate(): void
  /**
   * The page cancelled the close through beforeunload (will-prevent-unload). Returns true when the
   * caller must preventDefault so the page unloads anyway. Updates and session-end always leave;
   * a member-initiated close asks `confirmLeave`, and Stay resets the quit so a later X works.
   */
  handleUnloadPrevented(confirmLeave: () => boolean): boolean
  /** True once a close/quit may go straight through (quit finished, or an update is installing). */
  allowClose(): boolean
}

export function createQuitController(deps: QuitDeps): QuitController {
  const waitMs = deps.waitMs ?? QUIT_WAIT_MS
  let phase: 'idle' | 'waiting' | 'done' = 'idle'
  let updating = false
  let forced = false // session-end: nothing may stop or ask
  let notified = false
  let updatePromise: Promise<void> | undefined
  let updateDone: (() => void) | undefined
  let updateTimer: unknown
  let hasUpdateTimer = false
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
      // Windows is ending the session: there is no time to wait, even mid-wait. Checked first.
      if (reason === 'session-end') {
        forced = true
        notify() // so the site marks itself closing before any popup closes; no waiting
        return finish()
      }
      if (phase !== 'idle') return
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
      updateDone?.()
    },
    prepareForUpdate() {
      if (updating) return Promise.resolve()
      if (updatePromise) return updatePromise
      notify()
      updatePromise = new Promise<void>((resolve) => {
        updateDone = () => {
          if (hasUpdateTimer) deps.clock.clearTimeout(updateTimer)
          hasUpdateTimer = false
          updating = true // from here nothing may hold the updater back
          updateDone = undefined
          resolve()
        }
        hasUpdateTimer = true
        updateTimer = deps.clock.setTimeout(() => {
          hasUpdateTimer = false
          updateDone?.()
        }, waitMs)
      })
      return updatePromise
    },
    beforeQuitForUpdate() {
      updating = true
      notify()
    },
    handleUnloadPrevented(confirmLeave) {
      if (updating || forced) return true
      if (phase === 'idle') return false // not a quit: leave the page's own guard alone
      if (confirmLeave()) return true
      // Stay: forget this quit so the next X starts a fresh one (and tells the site again).
      if (hasTimer) deps.clock.clearTimeout(timer)
      hasTimer = false
      phase = 'idle'
      notified = false
      return false
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
