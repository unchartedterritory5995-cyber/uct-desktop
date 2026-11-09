// Side-by-side proofs: the packaged Electron app against an installed-style Chrome window.
// Usage: node scripts/proofs/run-proofs.mjs electron|chrome
// Popup blocking, background throttling and Cloudflare rows live in clean-proofs.mjs, because
// Playwright's own launch switches would falsify them.
// Signs in as the synthetic member account from BENCH_EMAIL / BENCH_PASSWORD. Credentials are
// read from the environment and never printed. Nothing here sends OS-level keys or clicks.
import { _electron, chromium } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
if (target !== 'electron' && target !== 'chrome') throw new Error('target must be electron or chrome')

const BASE = 'https://uctintelligence.com'
const MENU = '[data-guide="workspace.layoutsMenuBtn"]'
const BOARD = '[data-guide="workspace.popOutLayout"]'
const POP = '[aria-label="Pop out widget"]'
const OUT = 'proof-output'
mkdirSync(OUT, { recursive: true })
const results = {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (s) => console.log(s)

function rec(row, verdict, detail) {
  results[row] = { verdict, detail }
  writeFileSync(join(OUT, `results-${target}.json`), JSON.stringify(results, null, 2))
  log(`[${verdict}] ${row} ${JSON.stringify(detail).slice(0, 400)}`)
}

let lastPopup = null

async function row(name, fn) {
  try {
    await fn()
  } catch (e) {
    // A row that fails with a board popped must not strand the synthetic account's layout.
    if (lastPopup && !lastPopup.isClosed()) await lastPopup.close().catch(() => undefined)
    rec(name, 'INCONCLUSIVE', { error: `${e.name}: ${String(e.message).split('\n')[0].slice(0, 160)}` })
  }
}

const profile = mkdtempSync(join(tmpdir(), `uct-proof-${target}-`))
let app, browser, page

if (target === 'electron') {
  app = await _electron.launch({
    executablePath: join('release', 'win-unpacked', 'UCT Intelligence.exe'),
    args: [`--user-data-dir=${profile}`],
    timeout: 60000,
  })
  page = await app.firstWindow({ timeout: 60000 })
} else {
  browser = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: [`--app=${BASE}/`, '--window-size=1500,950'],
  })
  page = browser.pages()[0] || (await browser.waitForEvent('page'))
}

const seen = []
const context = page.context()
context.on('response', (r) => {
  if (r.url().startsWith(BASE)) {
    seen.push({ s: r.status(), api: r.url().includes('/api/'), cf: r.headers()['cf-mitigated'] || '', t: Date.now() })
  }
})

await page.waitForLoadState('domcontentloaded', { timeout: 60000 })
const login = await page.evaluate(
  async ([email, password]) => {
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    return r.status
  },
  [process.env.BENCH_EMAIL, process.env.BENCH_PASSWORD],
)
log(`sign-in status ${login}`)
if (login !== 200) throw new Error('sign-in refused')

async function charts() {
  await page.goto(`${BASE}/charts`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector(MENU, { timeout: 60000 })
  await sleep(9000)
}

// A real click, so Chrome counts it as a gesture. Stores the window on window.__child.
async function openChildWithGesture(name, features) {
  await page.evaluate(
    ([n, f]) => {
      const b = document.createElement('button')
      b.id = '__proof'
      b.textContent = 'proof'
      b.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;width:40px;height:40px'
      b.onclick = () => {
        window.__child = window.open('', n, f)
        b.remove()
      }
      document.body.appendChild(b)
    },
    [name, features],
  )
  await page.click('#__proof')
  await sleep(800)
}

await charts()
const base = await page.locator(POP).count()
log(`poppable widgets ${base}`)

await row('P1 portals', async () => {
  await openChildWithGesture('proof-p1', 'width=640,height=420')
  const r = await page.evaluate(async () => {
    const w = window.__child
    if (!w) return { opened: false }
    const out = { opened: true, syncDocument: !!w.document?.body }
    w.resizeTo(700, 500)
    await new Promise((d) => setTimeout(d, 600))
    out.resized = Math.abs(w.outerWidth - 700) <= 20
    out.availHeight = w.screen.availHeight
    let observed = false
    const ro = new w.ResizeObserver(() => { observed = true })
    const el = w.document.createElement('div')
    w.document.body.appendChild(el)
    ro.observe(el)
    await new Promise((d) => setTimeout(d, 300))
    ro.disconnect()
    out.resizeObserver = observed
    const st = w.document.createElement('style')
    st.textContent = 'div{color:rgb(1,2,3)}'
    w.document.head.appendChild(st)
    out.styleSync = w.getComputedStyle(el).color === 'rgb(1, 2, 3)'
    let key = false
    w.addEventListener('keydown', () => { key = true })
    w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a' }))
    out.keyForward = key
    w.close()
    return out
  })
  const ok = r.opened && r.syncDocument && r.resized && r.availHeight > 0 && r.resizeObserver && r.styleSync && r.keyForward
  rec('P1 portals', ok ? 'PASS' : 'FAIL', r)
})

async function placement(name) {
  let displays
  if (target === 'electron') {
    displays = await app.evaluate(({ screen }) =>
      screen.getAllDisplays().map((d) => ({ x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height, scale: d.scaleFactor })),
    )
    writeFileSync(join(OUT, 'displays.json'), JSON.stringify(displays))
  } else {
    if (!existsSync(join(OUT, 'displays.json'))) throw new Error('run the electron target first')
    displays = JSON.parse(readFileSync(join(OUT, 'displays.json'), 'utf8'))
    const perm = await page.evaluate(async () => {
      try { return (await navigator.permissions.query({ name: 'window-management' })).state } catch (e) { return `error ${e.name}` }
    })
    log(`window-management permission: ${perm}`)
  }
  const rows = []
  for (const [i, d] of displays.entries()) {
    const want = { x: d.x + 100, y: d.y + 100 }
    await openChildWithGesture(`proof-place-${i}`, `width=500,height=360,left=${want.x},top=${want.y}`)
    await sleep(700)
    const got = await page.evaluate(() => {
      const w = window.__child
      if (!w) return null
      const v = { x: w.screenX, y: w.screenY }
      w.close()
      return v
    })
    const off = got ? Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y)) : null
    rows.push({ display: i, scale: d.scale, want, got, off })
  }
  const bad = rows.filter((r) => r.off === null || r.off > 8)
  const scales = [...new Set(rows.map((r) => r.scale))]
  rec(name, bad.length === 0 ? (scales.length > 1 ? 'PASS' : 'PASS (one DPI only)') : 'FAIL', { displays: rows.length, scales, wrong: bad })
}

await row('Placement', () => placement('Placement'))
if (target === 'chrome') {
  await row('Placement with permission', async () => {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Browser.grantPermissions', { origin: BASE, permissions: ['windowManagement'] })
    const screens = await page.evaluate(async () => (await window.getScreenDetails()).screens.length)
    log(`window-management granted, screens seen ${screens}`)
    await placement('Placement with permission')
  })
}

await row('P7 subset', async () => {
  const r = await page.evaluate(async () => {
    const out = { notification: Notification.permission, locks: false, indexedDbAcrossWindows: false, push: 'not tried' }
    await navigator.locks.request('proof-lock', async () => { out.locks = true })
    const open = (w) => new Promise((ok, no) => {
      const q = w.indexedDB.open('proof-db', 1)
      q.onupgradeneeded = () => q.result.createObjectStore('s')
      q.onsuccess = () => ok(q.result)
      q.onerror = () => no(q.error)
    })
    const db = await open(window)
    await new Promise((ok) => { const t = db.transaction('s', 'readwrite'); t.objectStore('s').put(7, 'k'); t.oncomplete = ok })
    db.close()
    const w = window.open('', 'proof-p7', 'width=300,height=200')
    if (w) {
      try {
        const d2 = await open(w)
        out.indexedDbAcrossWindows = await new Promise((ok) => { const g = d2.transaction('s').objectStore('s').get('k'); g.onsuccess = () => ok(g.result === 7) })
        d2.close()
      } catch (e) { out.indexedDbAcrossWindows = `error ${e.name}` }
      w.close()
    }
    indexedDB.deleteDatabase('proof-db')
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg) out.push = 'no registration'
      else {
        const sub = await Promise.race([
          reg.pushManager.permissionState({ userVisibleOnly: true }),
          new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000)),
        ])
        out.push = `permissionState ${sub}`
      }
    } catch (e) { out.push = `${e.name}: ${e.message}`.slice(0, 120) }
    return out
  })
  rec('P7 subset', r.locks && r.indexedDbAcrossWindows === true ? 'PASS' : 'FAIL', r)
})

await row('P18 server load per client', async () => {
  const from = Date.now()
  await sleep(120000)
  const api = seen.filter((x) => x.api && x.t >= from).length
  rec('P18 server load per client', 'MEASURED', { apiResponsesPerMinute: api / 2, page: '/charts idle' })
})

// Pops the whole board. Attached first so a failed click cannot leave a rejection unhandled.
async function popBoard() {
  const popup = page.waitForEvent('popup', { timeout: 20000 })
  popup.catch(() => undefined)
  await page.locator(MENU).first().click()
  await page.locator(BOARD).first().click({ timeout: 10000 })
  lastPopup = await popup
  return lastPopup
}

await row('P20 route change', async () => {
  if (base === 0) throw new Error('synthetic board is empty')
  const w = await popBoard()
  await sleep(3000)
  let alive = true
  for (const r of ['/options-flow', '/journal', '/settings', '/dashboard', '/breadth']) {
    await page.locator(`a[href="${r}"]`).first().click({ timeout: 15000 })
    await page.waitForURL(`**${r}*`, { timeout: 15000 })
    await sleep(1500)
    if (w.isClosed()) { alive = false; break }
  }
  await page.locator('a[href="/charts"]').first().click({ timeout: 15000 })
  await page.waitForSelector(MENU, { timeout: 45000 })
  await sleep(3000)
  const stillOpen = !w.isClosed()
  if (stillOpen) await w.close()
  await sleep(6000)
  const back = await page.locator(POP).count()
  rec('P20 route change', alive && stillOpen && back === base ? 'PASS' : 'FAIL', { alive, stillOpen, back, base })
})

if (target === 'electron') {
  await row('Quit order', async () => {
    const w = await popBoard()
    await sleep(3000)
    const eventsFile = join(profile, 'quit-events.json')
    await app.evaluate(({ app: a, BrowserWindow }, file) => {
      const fs = process.mainModule.require('node:fs')
      const ev = []
      const mark = (n) => { ev.push({ n, t: Date.now() }); fs.writeFileSync(file, JSON.stringify(ev)) }
      a.on('before-quit', () => mark('before-quit'))
      a.on('will-quit', () => mark('will-quit'))
      a.on('quit', () => mark('quit'))
      a.on('window-all-closed', () => mark('window-all-closed'))
      BrowserWindow.getAllWindows().forEach((b, i) => {
        const tag = b.webContents.getURL().startsWith('https://') ? 'main' : `child${i}`
        b.on('close', () => mark(`close ${tag}`))
        b.on('closed', () => mark(`closed ${tag}`))
      })
    }, eventsFile)
    await page.evaluate(() => {
      window.__u = []
      addEventListener('pagehide', () => localStorage.setItem('proof-pagehide', String(Date.now())))
    })
    const recordsBefore = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('uct.desk.v1:')).length)
    await app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 200) })
    await app.waitForEvent('close', { timeout: 30000 }).catch(() => undefined)
    const events = existsSync(eventsFile) ? JSON.parse(readFileSync(eventsFile, 'utf8')) : []
    const t0 = events[0]?.t ?? 0
    rec('Quit order', events.length ? 'MEASURED' : 'INCONCLUSIVE', {
      recordsBefore,
      order: events.map((e) => `${e.n}+${e.t - t0}ms`),
      popupClosed: w.isClosed(),
    })
  })
}

if (target === 'electron') {
  // The quit left the board popped. A relaunch must offer it back, and this also returns the
  // synthetic account's board to how the run found it.
  await row('Relaunch restore', async () => {
    await sleep(3000)
    app = await _electron.launch({
      executablePath: join('release', 'win-unpacked', 'UCT Intelligence.exe'),
      args: [`--user-data-dir=${profile}`],
      timeout: 60000,
    })
    page = await app.firstWindow({ timeout: 60000 })
    await page.waitForLoadState('domcontentloaded', { timeout: 60000 })
    await charts()
    const restore = page.getByRole('button', { name: 'Restore', exact: true })
    const offered = await restore.count()
    if (offered) {
      await restore.first().click()
      await sleep(6000)
    }
    const back = await page.locator(POP).count()
    rec('Relaunch restore', offered >= 1 && back === base ? 'PASS' : 'FAIL', { offered, back, base })
  })
}

writeFileSync(join(OUT, `results-${target}.json`), JSON.stringify(results, null, 2))
log('wrote results')
try {
  if (app) await app.close().catch(() => undefined)
  if (browser) await browser.close().catch(() => undefined)
} finally {
  await sleep(2000)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* left in temp */ }
}
process.exit(0)
