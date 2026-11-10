// Tray residency on the real app (dev build, UCT_DESKTOP_TRAY=1). Run `UCT_BUILD_KIND=dev npm run build`
// first. Checks, each a PASS/FAIL row:
//   T-close     closing the main window hides it; the app keeps running; the black box logs it
//   T-reopen    a REAL second launch (separate process, same profile) shows it again; time to visible
//   T-quit      Quit exits the process within the quit wait; the black box logs a single exit
//   T-hidden    a --hidden (Start with Windows) launch loads the site and stays hidden
//   T-offline   a --hidden launch with the network unreachable stays hidden (error page behind it)
//   T-hidden2   a second --hidden launch does not pop a window; a plain second launch does
// The unsaved-text Stay path blocks the main process on a native dialog and is covered by unit tests.
// Signs in to nothing; sends no OS keys or clicks.
import { _electron } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ELECTRON = require('electron') // path to the electron binary
const OUT = 'proof-output'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
mkdirSync(OUT, { recursive: true })
const rows = []
const row = (id, pass, detail) => {
  rows.push({ id, verdict: pass ? 'PASS' : 'FAIL', detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`)
}
const env = { ...process.env, UCT_DESKTOP_TRAY: '1' }

async function launch(profile, extra = []) {
  return _electron.launch({ executablePath: ELECTRON, args: ['.', `--user-data-dir=${profile}`, ...extra], env, timeout: 60000 })
}
const mainState = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length > 0)
    if (!main) return null
    const site = main.contentView.children[0]?.webContents
    return { visible: main.isVisible(), url: site ? site.getURL().split(/[?#]/)[0] : null, loading: site ? site.isLoading() : null }
  })
async function waitFor(fn, ms, step = 100) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const v = await fn().catch(() => null)
    if (v) return { v, ms: Date.now() - t0 }
    await sleep(step)
  }
  return null
}
const events = (profile) => {
  const f = join(profile, 'logs', 'events.log')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
// A real second launch: a separate OS process on the same profile. It must hand off to the first
// instance through the single-instance lock and exit by itself.
function secondLaunch(profile, extra = []) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const p = spawn(ELECTRON, ['.', `--user-data-dir=${profile}`, ...extra], { env, stdio: 'ignore' })
    p.on('exit', (code) => resolve({ code, ms: Date.now() - t0 }))
    setTimeout(() => { try { p.kill() } catch { /* gone */ } resolve({ code: 'timeout', ms: Date.now() - t0 }) }, 20000)
  })
}

const profiles = []
const newProfile = () => {
  const p = mkdtempSync(join(tmpdir(), 'uct-proof-tray-'))
  profiles.push(p)
  return p
}

try {
  // ---- close, reopen, quit ----
  {
    const profile = newProfile()
    const app = await launch(profile)
    const shown = await waitFor(async () => (await mainState(app))?.visible, 30000)
    if (!shown) throw new Error('main window never showed')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.contentView.children.length > 0).close())
    await sleep(1500)
    const s = await mainState(app)
    const hid = events(profile).some((e) => e.event === 'hidden-to-tray')
    row('T-close', !!s && s.visible === false && hid, `main ${s ? (s.visible ? 'visible' : 'hidden') : 'gone'}, process alive, log hidden-to-tray=${hid}`)

    const t0 = Date.now()
    const second = await secondLaunch(profile)
    const back = await waitFor(async () => (await mainState(app))?.visible, 20000, 20)
    row('T-reopen', !!back && second.code === 0, `second process exited ${second.code} after ${second.ms} ms; main visible ${back ? `${Date.now() - t0} ms after the launch started` : 'NEVER'}`)

    const tq = Date.now()
    const closed = new Promise((r) => app.process().once('exit', () => r(Date.now() - tq)))
    await app.evaluate(({ app: a }) => setTimeout(() => a.quit(), 50)).catch(() => undefined)
    const exitMs = await Promise.race([closed, sleep(10000).then(() => null)])
    const exits = events(profile).filter((e) => e.event === 'exit')
    row('T-quit', exitMs !== null && exits.length === 1, `process exited ${exitMs === null ? 'NOT within 10 s' : `in ${exitMs} ms`}; exit lines=${exits.length}`)
    if (exitMs === null) await app.close().catch(() => undefined)
  }

  // ---- hidden start (Start with Windows), then second launches ----
  {
    const profile = newProfile()
    const app = await launch(profile, ['--hidden'])
    const loaded = await waitFor(async () => {
      const s = await mainState(app)
      return s && s.url && s.url.startsWith('https://') && s.loading === false ? s : null
    }, 45000, 250)
    await sleep(3000)
    const s = await mainState(app)
    const tray = events(profile).some((e) => e.event === 'started-in-tray')
    row('T-hidden', !!loaded && s?.visible === false && tray, `site ${loaded ? `loaded (${loaded.v.url})` : 'NOT loaded'}; window ${s?.visible ? 'VISIBLE' : 'hidden'}; log started-in-tray=${tray}`)

    const h2 = await secondLaunch(profile, ['--hidden'])
    await sleep(1500)
    const afterHidden = await mainState(app)
    const p2 = await secondLaunch(profile)
    const shown = await waitFor(async () => (await mainState(app))?.visible, 20000, 20)
    row('T-hidden2', afterHidden?.visible === false && !!shown, `second --hidden launch (exit ${h2.code}) left it ${afterHidden?.visible ? 'VISIBLE' : 'hidden'}; plain second launch (exit ${p2.code}) showed it ${shown ? 'yes' : 'NO'}`)
    await app.close().catch(() => undefined)
  }

  // ---- hidden start with the network unreachable ----
  {
    const profile = newProfile()
    const app = await launch(profile, ['--hidden', '--proxy-server=127.0.0.1:9'])
    await sleep(25000) // past the load guard's stall and first retries
    const s = await mainState(app)
    row('T-offline', !!s && s.visible === false, `window ${s ? (s.visible ? 'VISIBLE (popped at login)' : 'hidden') : 'gone'}; page ${s?.url ?? 'none'}`)
    await app.close().catch(() => undefined)
  }
} catch (e) {
  row('run', false, String(e.message).slice(0, 200))
} finally {
  writeFileSync(join(OUT, 'results-tray.json'), JSON.stringify({ startedUtc: new Date().toISOString(), rows }, null, 2))
  await sleep(1500)
  for (const p of profiles) { try { rmSync(p, { recursive: true, force: true }) } catch { /* temp */ } }
}
const failed = rows.filter((r) => r.verdict !== 'PASS').length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
