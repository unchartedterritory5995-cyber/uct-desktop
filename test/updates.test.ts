import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  checkMinShell,
  classifyUpdateError,
  compareVersions,
  createSignatureVerifier,
  createUpdateController,
  REPEAT_FAILURES,
  STABLE_INSTALLER_URL,
  VERIFY_SCRIPT,
} from '../src/main/updates'

function fakeUpdater() {
  const ee = new EventEmitter()
  return Object.assign(ee, {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowDowngrade: true,
    channel: null as string | null,
    checks: 0,
    installs: 0,
    async checkForUpdates() { this.checks++; return null },
    quitAndInstall() { this.installs++ },
  })
}

describe('createUpdateController', () => {
  it('downloads in the background, installs on quit, never downgrades', () => {
    const u = fakeUpdater()
    createUpdateController({ updater: u, onState: () => {} })
    expect(u.autoDownload).toBe(true)
    expect(u.autoInstallOnAppQuit).toBe(true)
    expect(u.allowDowngrade).toBe(false)
  })

  it('hold() (Windows ending the session) stops install-on-quit, including for a download that lands after it', () => {
    const u = fakeUpdater()
    const c = createUpdateController({ updater: u, onState: () => {} })
    u.emit('update-downloaded', { version: '0.2.0' })
    expect(u.autoInstallOnAppQuit).toBe(true)
    c.hold()
    expect(u.autoInstallOnAppQuit).toBe(false)
    u.emit('update-downloaded', { version: '0.2.1' })
    expect(u.autoInstallOnAppQuit).toBe(false)
    expect(u.installs).toBe(0)
  })

  it('never calls quitAndInstall by itself, whatever happens', async () => {
    const u = fakeUpdater()
    const c = createUpdateController({ updater: u, onState: () => {} })
    await c.check()
    u.emit('update-available', { version: '0.2.0' })
    u.emit('update-downloaded', { version: '0.2.0' })
    u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'))
    await c.check()
    expect(u.installs).toBe(0)
  })

  it('keeps allowDowngrade false after a channel change (electron-updater turns it on)', () => {
    const u = fakeUpdater()
    const c = createUpdateController({ updater: u, onState: () => {} })
    // Simulate the library's own setter side effect.
    Object.defineProperty(u, 'channel', {
      get() { return this._ch ?? null },
      set(v) { this._ch = v; this.allowDowngrade = true },
      configurable: true,
    })
    c.setChannel('beta')
    expect(u.channel).toBe('beta')
    expect(u.allowDowngrade).toBe(false)
  })

  it('stops installing a downloaded version that is no longer admitted', () => {
    const u = fakeUpdater()
    const states: string[] = []
    createUpdateController({ updater: u, onState: (s) => states.push(s.kind) })
    u.emit('update-downloaded', { version: '0.2.0' })
    expect(u.autoInstallOnAppQuit).toBe(true)
    // The feed was halted or the release pulled: the next check finds nothing to install.
    u.emit('update-not-available', { version: '0.1.2' })
    expect(u.autoInstallOnAppQuit).toBe(false)
    expect(states).toContain('withdrawn')
  })

  it('holds install while a different version replaces the pending one, then re-arms', () => {
    const u = fakeUpdater()
    createUpdateController({ updater: u, onState: () => {} })
    u.emit('update-downloaded', { version: '0.2.0' })
    u.emit('update-available', { version: '0.2.1' })
    expect(u.autoInstallOnAppQuit).toBe(false)
    u.emit('update-downloaded', { version: '0.2.1' })
    expect(u.autoInstallOnAppQuit).toBe(true)
  })

  it('a re-announce of the same pending version keeps install armed', () => {
    const u = fakeUpdater()
    createUpdateController({ updater: u, onState: () => {} })
    u.emit('update-downloaded', { version: '0.2.0' })
    u.emit('update-available', { version: '0.2.0' })
    expect(u.autoInstallOnAppQuit).toBe(true)
  })

  it(`reports after ${REPEAT_FAILURES} consecutive errors of one class, with the stable download`, () => {
    const u = fakeUpdater()
    const onState = vi.fn()
    createUpdateController({ updater: u, onState })
    for (let i = 0; i < REPEAT_FAILURES - 1; i++) u.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed-repeatedly' }))
    u.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    expect(onState).toHaveBeenCalledWith({ kind: 'failed-repeatedly', errorClass: 'network', downloadUrl: STABLE_INSTALLER_URL })
  })

  it('a different error class or a success restarts the count', () => {
    const u = fakeUpdater()
    const onState = vi.fn()
    createUpdateController({ updater: u, onState })
    u.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    u.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    u.emit('error', Object.assign(new Error('bad sig'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }))
    u.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    u.emit('update-not-available', {})
    u.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    u.emit('error', new Error('net::ERR_CONNECTION_RESET'))
    expect(onState).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed-repeatedly' }))
  })

  it('a check that throws counts as an error and never escapes', async () => {
    const u = fakeUpdater()
    u.checkForUpdates = async () => { throw new Error('getaddrinfo ENOTFOUND updates.uctintelligence.com') }
    const onState = vi.fn()
    const c = createUpdateController({ updater: u, onState })
    for (let i = 0; i < REPEAT_FAILURES; i++) await expect(c.check()).resolves.toBeUndefined()
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed-repeatedly', errorClass: 'network' }))
  })
})

describe('classifyUpdateError', () => {
  it('uses the updater code first, then the message', () => {
    expect(classifyUpdateError(Object.assign(new Error('x'), { code: 'ERR_UPDATER_INVALID_SIGNATURE' }))).toBe('signature')
    expect(classifyUpdateError(new Error('net::ERR_TIMED_OUT'))).toBe('network')
    expect(classifyUpdateError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('network')
    expect(classifyUpdateError(new Error('sha512 checksum mismatch'))).toBe('integrity')
    expect(classifyUpdateError(new Error('Cannot find channel "beta.yml" update info: HttpError: 404'))).toBe('feed')
    expect(classifyUpdateError('weird')).toBe('other')
  })
  it('reads electron-updater HTTP_ERROR_<status> codes: 4xx is the feed, 5xx the network (measured: a missing feed is 404)', () => {
    const http = (status: string) => Object.assign(new Error('404 Not Found'), { code: `HTTP_ERROR_${status}` })
    expect(classifyUpdateError(http('404'))).toBe('feed')
    expect(classifyUpdateError(http('403'))).toBe('feed')
    expect(classifyUpdateError(http('500'))).toBe('network')
    expect(classifyUpdateError(http('503'))).toBe('network')
    expect(classifyUpdateError(Object.assign(new Error('x'), { code: 'HTTP_ERROR_' }))).toBe('other')
  })
})

describe('createSignatureVerifier (fail closed)', () => {
  const PUBLISHER = 'UCT Intelligence LLC'
  const ok = JSON.stringify({ Status: 0, Subject: `CN=${PUBLISHER}, O=${PUBLISHER}, L=Austin, S=Texas, C=US` })

  it('accepts only a valid signature from the expected publisher', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: ok }))
    const verify = createSignatureVerifier({ runPowerShell: run, expectedPublisher: PUBLISHER })
    await expect(verify([PUBLISHER], 'C:\\t\\setup.exe')).resolves.toBeNull()
  })

  it('passes the path through the environment, never inside the script text', async () => {
    const run = vi.fn(async (_script: string, _env: Record<string, string>) => ({ code: 0, stdout: ok }))
    const verify = createSignatureVerifier({ runPowerShell: run, expectedPublisher: PUBLISHER })
    const evil = "C:\\t\\a'; Remove-Item -Recurse C:\\ ;'.exe"
    await verify([PUBLISHER], evil)
    const [script, env] = run.mock.calls[0]
    expect(script).toBe(VERIFY_SCRIPT)
    expect(script).not.toContain(evil)
    expect(env.UCT_VERIFY_PATH).toBe(evil)
  })

  it.each([
    ['an invalid status', { Status: 1, Subject: `CN=${PUBLISHER}` }],
    ['a string status', { Status: 'Valid', Subject: `CN=${PUBLISHER}` }],
    ['another publisher', { Status: 0, Subject: 'CN=Someone Else, O=Someone Else' }],
    ['a publisher that only starts the same', { Status: 0, Subject: `CN=${PUBLISHER} Evil, O=x` }],
    ['no subject', { Status: 0 }],
  ])('refuses %s', async (_label, body) => {
    const verify = createSignatureVerifier({ runPowerShell: async () => ({ code: 0, stdout: JSON.stringify(body) }), expectedPublisher: PUBLISHER })
    expect(await verify([PUBLISHER], 'x.exe')).toEqual(expect.any(String))
  })

  it('refuses when the feed names a different publisher than the one built in', async () => {
    const verify = createSignatureVerifier({ runPowerShell: async () => ({ code: 0, stdout: ok }), expectedPublisher: PUBLISHER })
    expect(await verify(['Someone Else'], 'x.exe')).toEqual(expect.any(String))
  })

  it.each([
    ['a non-zero exit', async () => ({ code: 1, stdout: ok })],
    ['unparseable output', async () => ({ code: 0, stdout: 'not json' })],
    ['PowerShell missing', async () => { throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }) }],
  ])('refuses and reports on %s', async (_label, run) => {
    const report = vi.fn()
    const verify = createSignatureVerifier({ runPowerShell: run, expectedPublisher: PUBLISHER, report })
    expect(await verify([PUBLISHER], 'x.exe')).toEqual(expect.any(String))
    expect(report).toHaveBeenCalledOnce()
  })
})

describe('checkMinShell (launch only)', () => {
  it('asks for an update when the shell is below the minimum', async () => {
    expect(await checkMinShell({ fetchControl: async () => ({ min_shell_version: '0.2.0' }), shellVersion: '0.1.9' })).toBe('update-required')
    expect(await checkMinShell({ fetchControl: async () => ({ min_shell_version: '1.0.0' }), shellVersion: '0.10.0' })).toBe('update-required')
  })

  it('is ok at or above the minimum', async () => {
    expect(await checkMinShell({ fetchControl: async () => ({ min_shell_version: '0.2.0' }), shellVersion: '0.2.0' })).toBe('ok')
    expect(await checkMinShell({ fetchControl: async () => ({ min_shell_version: '0.2.0' }), shellVersion: '0.10.0' })).toBe('ok')
  })

  it.each([
    ['a failed fetch', async () => { throw new Error('offline') }],
    ['an empty value', async () => ({ min_shell_version: '' })],
    ['a missing value', async () => ({})],
    ['a malformed value', async () => ({ min_shell_version: 'v2-beta' })],
    ['a non-object', async () => null],
  ])('is ok on %s, so an outage never locks members out', async (_label, fetchControl) => {
    expect(await checkMinShell({ fetchControl: fetchControl as never, shellVersion: '0.1.2' })).toBe('ok')
  })
})

describe('compareVersions', () => {
  it('compares X.Y.Z numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.2', '0.1.10')).toBe(-1)
    expect(compareVersions('1.0', '1.0.0')).toBeNull()
  })
})
