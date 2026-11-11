// Desk visibility on the real app (run `npm run build` first; launches the built app with electron .).
// The site page subscribes through the real bridge; rows:
//   V-start      the page hears 'visible' at start
//   V-min        minimizing the only window -> 'hidden'; restoring -> 'visible'
//   V-board      with a pop-out open, minimizing the MAIN window keeps 'visible' (a board is up)
//   V-allmin     minimizing the pop-out as well -> 'hidden'
import { _electron } from 'playwright'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ELECTRON = require('electron')
const BASE = 'https://uctintelligence.com'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const row = (id, pass, detail) => { rows.push({ id, verdict: pass ? 'PASS' : 'FAIL', detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
const profile = mkdtempSync(join(tmpdir(), 'uct-proof-desk-'))
let app
try {
  app = await _electron.launch({ executablePath: ELECTRON, args: ['.', `--user-data-dir=${profile}`], timeout: 60000 })
  let page = null
  for (let i = 0; i < 120 && !page; i++) { page = app.windows().find((p) => p.url().startsWith(BASE)) || null; if (!page) await sleep(250) }
  if (!page) throw new Error('site page did not appear')
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => {
    window.__desk = []
    window.uctDesktop.onDeskVisibility((s) => window.__desk.push(s))
  })
  const last = async () => (await page.evaluate(() => window.__desk.at(-1) ?? null))
  const mainCall = (fn) => app.evaluate(({ BrowserWindow }, f) => {
    const main = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length > 0)
    // eslint-disable-next-line no-new-func
    new Function('w', f)(main)
  }, fn)
  const waitFor = async (want, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if ((await last()) === want) return true; await sleep(100) } return false }

  // A fresh subscriber hears the next change; nudge one so the start state is observable.
  await mainCall('w.minimize()'); await waitFor('hidden'); await mainCall('w.restore()')
  row('V-start', await waitFor('visible'), `last=${await last()}`)

  await mainCall('w.minimize()')
  const hid = await waitFor('hidden')
  await mainCall('w.restore()')
  const back = await waitFor('visible')
  row('V-min', hid && back, `minimize -> ${hid ? 'hidden' : 'NOT hidden'}, restore -> ${back ? 'visible' : 'NOT visible'}`)

  await page.evaluate(() => { window.__pop = window.open('', 'proof-board', 'popup,width=400,height=300,left=60,top=60'); window.__pop.document.body.textContent = 'board' })
  await sleep(1500)
  await mainCall('w.minimize()')
  await sleep(1500)
  const withBoard = await last()
  row('V-board', withBoard === 'visible', `main minimized with a board up -> ${withBoard}`)

  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().filter((w) => w.contentView.children.length === 0 && !w.isDestroyed()).forEach((w) => w.minimize()) })
  row('V-allmin', await waitFor('hidden'), `every window minimized -> ${await last()}`)
} catch (e) {
  row('run', false, String(e.message).slice(0, 200))
} finally {
  writeFileSync(join('proof-output', 'results-desk-visibility.json'), JSON.stringify({ startedUtc: new Date().toISOString(), rows }, null, 2))
  if (app) await app.close().catch(() => undefined)
  await sleep(1000)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp */ }
}
const failed = rows.filter((r) => r.verdict !== 'PASS').length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
