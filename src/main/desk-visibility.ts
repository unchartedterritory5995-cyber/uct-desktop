// Whether the WHOLE desk can be seen, for the website's idle mode (plan Task 22 / 6.1).
//
// Why the shell has to say it: the app sets backgroundThrottling:false on every window, so a
// minimized page still reports `document.hidden === false` and keeps polling at full rate (measured
// in Task 12 P4: a minimized opener ran 100 of 100 timer ticks). And the main window alone is the
// wrong question on a trading desk: it is often minimized while pop-out boards stay up on other
// monitors. So the desk is 'hidden' only when EVERY app window is hidden or minimized.
import type { DeskVisibility } from '../shared/contract'

export interface WindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
}

export function deskVisibility(windows: WindowLike[]): DeskVisibility {
  for (const w of windows) {
    if (w.isDestroyed()) continue
    if (w.isVisible() && !w.isMinimized()) return 'visible'
  }
  return 'hidden'
}

/** Sends only on a change (and once at start), so a burst of window events is one message. */
export function createDeskVisibilityReporter(deps: { windows(): WindowLike[]; send(state: DeskVisibility): void }) {
  let last: DeskVisibility | null = null
  return {
    /** Recompute and send if the answer changed. Call on any window's show/hide/minimize/restore/close. */
    update(): DeskVisibility {
      const now = deskVisibility(deps.windows())
      if (now !== last) {
        last = now
        deps.send(now)
      }
      return now
    },
    /** Send the current answer again (a page that just loaded has not heard it). */
    resend(): void {
      last = null
      this.update()
    },
    current: () => last,
  }
}
