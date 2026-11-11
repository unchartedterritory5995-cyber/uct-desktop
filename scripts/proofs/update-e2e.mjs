// The whole update loop on the INSTALLED app (plan 7.1). Rows:
//   E-toast    the installed app downloads the feed's newer version and the site shows
//              "A new version of the UCT app is ready"
//   E-restart  clicking Restart to update closes the app through the normal quit
//   E-version  the installed exe is now the feed's version
//   E-relaunch the app reopened by itself after the install
// It changes the installed app on purpose, so it refuses to run without --installed and an
// --expect=<version> that the feed actually offers. The relaunched app is closed gracefully (WM_CLOSE).
// Usage: MSYS_NO_PATHCONV=1 node scripts/proofs/update-e2e.mjs --installed --expect=0.1.7 [--display=2]
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep, startApp } from './launch.mjs'

const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1]
if (!process.argv.includes('--installed') || !/^\d+\.\d+\.\d+$/.test(arg('expect') || '')) {
  console.error('refusing: pass --installed and --expect=X.Y.Z (this updates the installed app)')
  process.exit(2)
}
const EXPECT = arg('expect')
// --via-bridge: make the call the site's Restart button makes, for a run before the button is deployed.
const VIA_BRIDGE = process.argv.includes('--via-bridge')
const DISPLAY = Number(arg('display') || 2)
const EXE = join(process.env.LOCALAPPDATA, 'Programs', 'uct-desktop', 'UCT Intelligence.exe')
process.env.UCT_PROOF_EXE = EXE
process.env.UCT_PROOF_UPDATES = '1'
const rows = []
const row = (id, pass, detail) => { rows.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim()
const version = () => ps(`(Get-Item '${EXE}').VersionInfo.ProductVersion`).replace(/\.0$/, '')
const appPids = () => ps(`@(Get-Process 'UCT Intelligence' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${EXE}' } | ForEach-Object { $_.Id }) -join ','`).split(',').filter(Boolean)

const before = version()
console.log(`installed before: ${before}, feed should offer ${EXPECT}`)
if (appPids().length) { console.error('refusing: the installed app is already running'); process.exit(2) }
const profile = mkdtempSync(join(tmpdir(), 'uct-update-e2e-'))
let app
try {
  app = await startApp('electron', 9367, [], { profile })
  const d = JSON.parse(readFileSync(join('proof-output', 'displays.json'), 'utf8'))[DISPLAY]
  if (d) app.placeMainWindow(d.x + 40, d.y + 40, 1500, 950)
  const { run } = app
  let shown = ''
  for (let i = 0; i < 60 && !shown; i++) {
    await sleep(5000)
    shown = VIA_BRIDGE
      ? await run(`window.uctDesktop.getAppUpdate().then(u=>u&&u.version===${JSON.stringify(EXPECT)}?'downloaded '+u.version:'')`).catch(() => '')
      : await run(`(document.querySelector('[data-testid="app-update-toast"]')||{}).textContent||''`).catch(() => '')
  }
  if (VIA_BRIDGE) row('E-toast', !!shown, shown ? `shell reports ${shown} (site button not deployed yet; calling the same bridge method it calls)` : 'no download within 5 min')
  else row('E-toast', /new version of the UCT app is ready/i.test(shown), shown ? `"${shown}"` : 'no toast within 5 min')
  if (!shown) throw new Error('no update offered')
  const t0 = Date.now()
  await run(VIA_BRIDGE
    ? 'window.uctDesktop.restartToUpdate()'
    : `[...document.querySelectorAll('[data-testid="app-update-toast"] button')].find(b=>/Restart to update/.test(b.textContent)).click()`, true).catch(() => {})
  // Watch the app's PROCESSES, never the DevTools socket: a socket to an app that has already quit can
  // hang until the command timeout (2026-11-11: it reported "closed after 301 s" for an app whose own
  // log shows it quit 0.14 s after the click and reopened as the new version 18 s after it).
  const secs = () => ((Date.now() - t0) / 1000).toFixed(1)
  let closedAt = null
  for (let i = 0; i < 240 && closedAt === null; i++) { await sleep(250); if (!appPids().length) closedAt = secs() }
  row('E-restart', closedAt !== null, closedAt !== null ? `app closed ${closedAt} s after the click` : 'app still open 60 s after the click')
  let reopenedAt = null
  let pids = []
  for (let i = 0; i < 240 && reopenedAt === null; i++) { await sleep(500); pids = appPids(); if (pids.length) reopenedAt = secs() }
  let v = before
  for (let i = 0; i < 30 && v !== EXPECT; i++) { try { v = version() } catch { /* mid-install */ } if (v !== EXPECT) await sleep(1000) }
  row('E-version', v === EXPECT, `installed exe ${before} -> ${v}`)
  row('E-relaunch', reopenedAt !== null, reopenedAt !== null ? `reopened ${reopenedAt} s after the click` : 'did not reopen within 2 min')
  if (reopenedAt !== null) {
    await sleep(8000)
    // WM_CLOSE to the MAIN process (no --type= switch), so the app runs its normal quit.
    const main = ps(`(Get-CimInstance Win32_Process -Filter "Name='UCT Intelligence.exe'" | Where-Object { $_.ExecutablePath -eq '${EXE}' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1).ProcessId`)
    if (main) try { execFileSync('taskkill', ['/PID', main], { stdio: 'ignore' }) } catch { /* already closing */ }
  }
} catch (e) {
  if (!rows.length) row('E-toast', false, String(e.message || e))
} finally {
  if (app) await app.close?.({ keepProfile: false })
}
const failed = rows.filter((r) => !r.pass).length + (rows.length < 4 ? 4 - rows.length : 0)
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
