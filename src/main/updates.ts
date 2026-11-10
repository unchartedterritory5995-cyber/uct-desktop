// Updater client (plan Task 28). Pure logic with the updater, PowerShell and the feed injected, so
// every rule is unit-tested without Electron or a network. Wiring to electron-updater is separate.
//
// Rules:
// * Download in the background, install on a real quit. With tray residency a real quit is rare, so
//   the residency module also installs when the desk is hidden and idle outside the extended session
//   (residency.ts). This controller itself NEVER calls quitAndInstall: a trader is never interrupted.
// * NOT YET WIRED: index.ts still uses Electron's built-in autoUpdater for the before-quit-for-update
//   hook only; the electron-updater client, the feed (Task 27) and signing come before any install.
// * Never downgrade, including after a channel change (electron-updater sets allowDowngrade when the
//   channel is assigned, so it is put back every time).
// * A downloaded version that the feed stops offering (halted, pulled) is not installed on quit.
// * The signature check fails CLOSED: anything but Status 0 from the expected publisher refuses.
// * After REPEAT_FAILURES consecutive errors of one class, tell the member to download the latest.
// * min_shell_version is checked at launch only, and fails OPEN: an outage must never lock anyone out.

export const REPEAT_FAILURES = 3
export const STABLE_INSTALLER_URL = 'https://updates.uctintelligence.com/stable/UCT-Intelligence-Setup.exe'

export interface UpdateInfoLike {
  version?: string
}

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  channel: string | null
  checkForUpdates(): Promise<unknown>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown
}

export type ErrorClass = 'network' | 'signature' | 'integrity' | 'feed' | 'other'

export type UpdateState =
  | { kind: 'downloaded'; version: string }
  | { kind: 'withdrawn'; version: string }
  | { kind: 'failed-repeatedly'; errorClass: ErrorClass; downloadUrl: string }

export function classifyUpdateError(err: unknown): ErrorClass {
  const code = typeof err === 'object' && err !== null ? String((err as { code?: unknown }).code ?? '') : ''
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (/SIGNATURE|PUBLISHER/i.test(code) || /signature|publisher/i.test(message)) return 'signature'
  if (/sha512|checksum|integrity/i.test(message)) return 'integrity'
  if (/net::|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(message)) return 'network'
  if (/CHANNEL_FILE|LATEST_VERSION/i.test(code) || /channel|\.yml|HttpError/i.test(message)) return 'feed'
  return 'other'
}

export function createUpdateController(deps: { updater: UpdaterLike; onState(state: UpdateState): void }) {
  const { updater, onState } = deps
  let pending: string | null = null
  let failClass: ErrorClass | null = null
  let failCount = 0

  const keepSafe = () => {
    updater.allowDowngrade = false
  }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  keepSafe()

  const succeeded = () => {
    failClass = null
    failCount = 0
  }
  const failed = (err: unknown) => {
    const cls = classifyUpdateError(err)
    if (cls === failClass) failCount++
    else {
      failClass = cls
      failCount = 1
    }
    if (failCount === REPEAT_FAILURES) onState({ kind: 'failed-repeatedly', errorClass: cls, downloadUrl: STABLE_INSTALLER_URL })
  }

  updater.on('update-downloaded', (info: UpdateInfoLike) => {
    succeeded()
    pending = info?.version ?? null
    updater.autoInstallOnAppQuit = true
    if (pending) onState({ kind: 'downloaded', version: pending })
  })
  updater.on('update-available', (info: UpdateInfoLike) => {
    succeeded()
    // A different version is replacing the pending one: do not install the old one meanwhile.
    if (pending && info?.version !== pending) updater.autoInstallOnAppQuit = false
  })
  updater.on('update-not-available', () => {
    succeeded()
    if (pending) {
      const version = pending
      pending = null
      updater.autoInstallOnAppQuit = false
      onState({ kind: 'withdrawn', version })
    }
  })
  updater.on('error', (err: unknown) => failed(err))

  return {
    async check(): Promise<void> {
      keepSafe()
      try {
        await updater.checkForUpdates()
      } catch (err) {
        failed(err)
      }
    },
    setChannel(channel: string): void {
      updater.channel = channel
      keepSafe()
    },
  }
}

// --- Signature check --------------------------------------------------------------------------------

/** The path arrives in $env:UCT_VERIFY_PATH, never in the script text, so no path can inject code. */
export const VERIFY_SCRIPT =
  "$s = Get-AuthenticodeSignature -LiteralPath $env:UCT_VERIFY_PATH; " +
  "[pscustomobject]@{ Status = [int]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress"

export type RunPowerShell = (script: string, env: Record<string, string>) => Promise<{ code: number; stdout: string }>

function commonName(subject: string): string | null {
  const m = /(?:^|,\s*)CN=("([^"]*)"|[^,]*)/.exec(subject)
  if (!m) return null
  return (m[2] ?? m[1]).trim()
}

/** electron-updater's verifyUpdateCodeSignature contract: resolve null to accept, a reason to refuse. */
export function createSignatureVerifier(deps: {
  runPowerShell: RunPowerShell
  expectedPublisher: string
  report?: (reason: string) => void
}) {
  const refuse = (reason: string) => {
    deps.report?.(reason)
    return reason
  }
  return async (publisherNames: string[], path: string): Promise<string | null> => {
    if (Array.isArray(publisherNames) && publisherNames.length > 0 && !publisherNames.includes(deps.expectedPublisher)) {
      return refuse('feed names an unexpected publisher')
    }
    let out: { code: number; stdout: string }
    try {
      out = await deps.runPowerShell(VERIFY_SCRIPT, { UCT_VERIFY_PATH: path })
    } catch (err) {
      return refuse(`signature check could not run: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (out.code !== 0) return refuse(`signature check exited ${out.code}`)
    let parsed: { Status?: unknown; Subject?: unknown }
    try {
      parsed = JSON.parse(out.stdout)
    } catch {
      return refuse('signature check output unreadable')
    }
    if (parsed?.Status !== 0) return 'signature not valid'
    const cn = typeof parsed.Subject === 'string' ? commonName(parsed.Subject) : null
    if (cn !== deps.expectedPublisher) return 'signed by an unexpected publisher'
    return null
  }
}

// --- Minimum shell version -------------------------------------------------------------------------

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

/** 1, 0 or -1 for plain X.Y.Z versions; null if either is not X.Y.Z. */
export function compareVersions(a: string, b: string): 1 | 0 | -1 | null {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) return null
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i])
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export async function checkMinShell(deps: {
  fetchControl(): Promise<{ min_shell_version?: unknown } | null>
  shellVersion: string
}): Promise<'ok' | 'update-required'> {
  try {
    const control = await deps.fetchControl()
    const min = control && typeof control === 'object' ? control.min_shell_version : undefined
    if (typeof min !== 'string' || !min) return 'ok'
    return compareVersions(deps.shellVersion, min) === -1 ? 'update-required' : 'ok'
  } catch {
    return 'ok'
  }
}
