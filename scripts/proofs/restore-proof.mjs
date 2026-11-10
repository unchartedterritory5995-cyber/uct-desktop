// Task 21 on the real site: pop a board, move it to another monitor, quit, relaunch with no click.
// The board must reopen by itself at the saved position, then close back onto the board.
// Usage: node scripts/proofs/restore-proof.mjs [--display=N]
// Signs in from BENCH_EMAIL / BENCH_PASSWORD, never printed. Sends no OS keys or clicks: the window
// is moved by the app itself after arming it the way a real drag would.
import { _electron } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'https://uctintelligence.com'
const MENU = '[data-guide="workspace.layoutsMenuBtn"]'
const BOARD = '[data-guide="workspace.popOutLayout"]'
const POP = '[aria-label="Pop out widget"]'
const OUT = 'proof-output'
const WAIT_FOR_WINDOW_MS = 30000
const TOLERANCE_PX = 8
const displayIndex = Number((process.argv.find((a) => a.startsWith('--display=')) || '--display=3').split('=')[1])
const display = JSON.parse(readFileSync(join(OUT, 'displays.json'), 'utf8'))[displayIndex]
const target = { x: display.x + 200, y: display.y + 100, width: 900, height: 600 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const profile = mkdtempSync(join(tmpdir(), 'uct-proof-restore-'))
const launch = () =>
  _electron.launch({ executablePath: join('release', 'win-unpacked', 'UCT Intelligence.exe'), args: [`--user-data-dir=${profile}`], timeout: 60000 })

async function sitePage(app) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const hit = app.windows().find((p) => p.url().startsWith(BASE))
    if (hit) return hit
    await sleep(250)
  }
  throw new Error('site page did not appear')
}

const openCharts = async (page) => {
  await page.goto(`${BASE}/charts`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector(MENU, { timeout: 60000 })
}

// The main window is the one hosting the site in a child view. Every other window is popped out.
const popupBounds = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const popups = BrowserWindow.getAllWindows().filter((w) => w.contentView.children.length === 0)
    return popups.length ? popups.map((w) => w.getBounds()) : null
  })

const result = { target, startedUtc: new Date().toISOString() }
let verdict = 'INCONCLUSIVE'
let app
try {
  app = await launch()
  let page = await sitePage(app)
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 })
  const status = await page.evaluate(
    async ([email, password]) => (await fetch('/api/auth/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).status,
    [process.env.BENCH_EMAIL, process.env.BENCH_PASSWORD],
  )
  if (status !== 200) throw new Error(`sign-in ${status}`)
  await openCharts(page)
  await sleep(9000)
  result.widgetsBefore = await page.locator(POP).count()
  if (!result.widgetsBefore) throw new Error('synthetic board is empty')

  const popup = page.waitForEvent('popup', { timeout: 20000 })
  popup.catch(() => undefined)
  await page.locator(MENU).first().click()
  await page.locator(BOARD).first().click({ timeout: 10000 })
  await popup
  await sleep(3000)

  await app.evaluate(({ BrowserWindow }, bounds) => {
    const child = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length === 0)
    child.emit('will-move', { preventDefault() {} }, bounds)
    child.setBounds(bounds)
    child.emit('moved') // Windows reports this only when a real drag ends
  }, target)
  await sleep(2500)
  result.boundsBeforeQuit = await popupBounds(app)

  await app.evaluate(({ app: a }) => setTimeout(() => a.quit(), 200))
  await app.waitForEvent('close', { timeout: 30000 }).catch(() => undefined)
  await sleep(3000)

  app = await launch()
  page = await sitePage(app)
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 })
  const t0 = Date.now()
  let bounds = null
  while (Date.now() - t0 < WAIT_FOR_WINDOW_MS) {
    bounds = await popupBounds(app)
    if (bounds) break
    await sleep(500)
  }
  result.reopenedAfterMs = bounds ? Date.now() - t0 : null
  await sleep(3000)
  result.boundsAfterRelaunch = await popupBounds(app)
  const b = result.boundsAfterRelaunch?.[0]
  result.offPx = b ? Math.max(Math.abs(b.x - target.x), Math.abs(b.y - target.y), Math.abs(b.width - target.width), Math.abs(b.height - target.height)) : null

  // Return the synthetic account's board to how this run found it.
  if (b) {
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().filter((w) => w.contentView.children.length === 0).forEach((w) => w.close())
    })
    await sleep(6000)
  }
  await openCharts(page)
  await sleep(9000)
  result.widgetsAfter = await page.locator(POP).count()
  verdict = b && result.offPx <= TOLERANCE_PX && result.widgetsAfter === result.widgetsBefore ? 'PASS' : 'FAIL'
} catch (e) {
  result.error = String(e.message).split('\n')[0].slice(0, 200)
} finally {
  result.verdict = verdict
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, 'results-restore.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  if (app) await app.close().catch(() => undefined)
  await sleep(2000)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp */ }
}
process.exit(verdict === 'PASS' ? 0 : 1)
