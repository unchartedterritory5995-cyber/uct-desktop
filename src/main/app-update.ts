// The app-update hub (plan 7.1): holds the downloaded update the website may offer, tells every site
// page when it changes, and remembers a member's "Restart to update". Free of Electron so each rule is
// unit-tested (test/app-update.test.ts); index.ts wires it to electron-updater and the quit controller.
//
// Rules:
// * The website shows "A new version of the UCT app is ready" only while an update is downloaded and
//   still offered: a withdrawn (halted, pulled) version disappears from every page.
// * "Restart to update" never installs directly. It starts the NORMAL quit (onBeforeQuit, unsaved-text
//   prompt, Stay cancels), and only once the app is really quitting does index.ts start the installer
//   with run-after. electron-updater's own quitAndInstall spawns the installer first, which can close
//   the app before a member has answered the unsaved-text prompt.
// * Ignoring the prompt is safe: the update installs on the next ordinary quit (autoInstallOnAppQuit).
import type { AppUpdate } from '../shared/contract'
import type { UpdateState } from './updates'

export interface AppUpdateHubDeps {
  broadcast(update: AppUpdate): void
  report(event: 'update_downloaded' | 'update_error', errorCode?: string): void
}

export function createAppUpdateHub(deps: AppUpdateHubDeps) {
  let pending: AppUpdate = null
  let restart = false
  let sessionEnding = false
  return {
    /** The update controller's state changes (updates.ts). */
    onState(state: UpdateState): void {
      if (state.kind === 'downloaded') {
        if (pending?.version === state.version) return
        pending = { version: state.version }
        deps.report('update_downloaded')
        deps.broadcast(pending)
      } else if (state.kind === 'withdrawn') {
        pending = null
        restart = false
        deps.broadcast(null)
      } else if (state.kind === 'failed-repeatedly') {
        deps.report('update_error', state.errorClass)
      }
    },
    get(): AppUpdate {
      return pending
    },
    /** The member clicked "Restart to update". True when an update waits and the caller should quit. */
    requestRestart(): boolean {
      if (!pending) return false
      restart = true
      return true
    },
    /** At will-quit: start the installer with run-after (true) or leave it to install-on-quit (false). */
    restartRequested(): boolean {
      return restart && pending !== null && !sessionEnding
    },
    /** Windows is ending the session: no install on the way out, even one the member asked for. */
    sessionEnding(): void {
      sessionEnding = true
    },
  }
}
