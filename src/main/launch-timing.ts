// Launch timing (speed plan 4.1): where a launch's time goes, in ms from process start, written to the
// black box once per launch as `launch-timing`. The launch proof (scripts/proofs/launch-cold.mjs) reads
// it; a member's Help > Copy Diagnostics carries it too. Numbers only.
//
//   ready      Electron finished starting (app.whenReady)
//   window     the main window and its site view exist
//   shown      the window is on screen
//   loading    the site view started its first load of the website
//   domReady   the website's HTML is parsed (its first script has run)
//   loaded     the website's load event (its code and styles are in)
//
// Written when `loaded` arrives, or after FLUSH_AFTER_MS with whatever was reached (an offline start,
// a start in the tray), so a slow or failed launch still leaves its numbers.
export const LAUNCH_PHASES = ['ready', 'window', 'shown', 'loading', 'domReady', 'loaded'] as const
export type LaunchPhase = (typeof LAUNCH_PHASES)[number]
export const FLUSH_AFTER_MS = 60_000

export interface LaunchTimingDeps {
  /** ms since the process started (perf_hooks performance.now() in the main process). */
  now(): number
  record(fields: Record<string, number | boolean>): void
  clock: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }
}

export function createLaunchTiming(deps: LaunchTimingDeps) {
  const marks: Partial<Record<LaunchPhase, number>> = {}
  let written = false
  const flush = (complete: boolean): void => {
    if (written) return
    written = true
    deps.clock.clearTimeout(timer)
    deps.record({ ...marks, complete })
  }
  const timer = deps.clock.setTimeout(() => flush(false), FLUSH_AFTER_MS)
  return {
    /** First call per phase wins; later calls (a reload, a second navigation) are ignored. */
    mark(phase: LaunchPhase): void {
      if (written || marks[phase] !== undefined) return
      marks[phase] = Math.round(deps.now())
      if (phase === 'loaded') flush(true)
    },
    marks: (): Readonly<Partial<Record<LaunchPhase, number>>> => ({ ...marks }),
  }
}
