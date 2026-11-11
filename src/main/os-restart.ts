// Windows Update restarts (plan 7.3). Two rules, both unit-tested (test/os-restart.test.ts):
// * Register with Windows Restart Manager so that when Windows Update restarts the PC (or an
//   installer closes the app to patch something), Windows reopens UCT once the member signs back in,
//   the way it reopens a browser. Flags exclude crashes and hangs: recovering from those is the app's
//   own job (recovery.ts), and a crash loop must never be fed by the OS.
// * Never install an app update while Windows is ending the session: the installer would be killed
//   halfway through a shutdown. updates.ts holds the install (hold()), and the downloaded update
//   installs on the next ordinary quit instead.
// Registration is skipped for debug and proof runs (a proof build must not reopen after a reboot) and
// for unpackaged runs. Windows only honours it once the app has run for 60 seconds.

export const RESTART_ARG = '--restarted-by-windows'
const RESTART_NO_CRASH = 1
const RESTART_NO_HANG = 2
/** Reopen after an update or a reboot only; never after a crash or a hang. */
export const RESTART_FLAGS = RESTART_NO_CRASH | RESTART_NO_HANG

/** kernel32 RegisterApplicationRestart: an HRESULT, 0 (S_OK) on success. */
export type RegisterRestart = (commandLine: string, flags: number) => number

export type OsRestartResult = 'registered' | 'skipped' | 'unavailable' | 'failed'

export function registerOsRestart(deps: {
  register: RegisterRestart | null
  enabled: boolean
  record(event: string, fields?: Record<string, string | number | boolean | null>): void
}): OsRestartResult {
  if (!deps.enabled) return 'skipped'
  if (!deps.register) {
    deps.record('os-restart-unavailable')
    return 'unavailable'
  }
  let hr: number
  try {
    hr = deps.register(RESTART_ARG, RESTART_FLAGS)
  } catch {
    deps.record('os-restart-failed', { hr: null })
    return 'failed'
  }
  if (hr !== 0) {
    deps.record('os-restart-failed', { hr })
    return 'failed'
  }
  deps.record('os-restart-registered')
  return 'registered'
}

export function restartedByWindows(argv: readonly string[]): boolean {
  return argv.includes(RESTART_ARG)
}

/** The real call, or null where it cannot load (non-Windows, koffi missing). Never throws. */
export function loadRegisterRestart(): RegisterRestart | null {
  if (process.platform !== 'win32') return null
  try {
    const koffi = require('koffi') as typeof import('koffi')
    return koffi
      .load('kernel32.dll')
      .func('long __stdcall RegisterApplicationRestart(str16 pwzCommandline, uint32_t dwFlags)') as RegisterRestart
  } catch {
    return null
  }
}
