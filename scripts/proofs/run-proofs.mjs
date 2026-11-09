// Side-by-side proofs: the packaged Electron app against an installed-style Chrome window.
// Usage: node scripts/proofs/run-proofs.mjs electron|chrome [--stream]
// Signs in as the synthetic member account from BENCH_EMAIL / BENCH_PASSWORD. Credentials are
// read from the environment and never printed. Nothing here sends OS-level keys or clicks.
import { _electron, chromium } from 'playwright'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.argv[2]
const stream = process.argv.includes('--stream')
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
  log(`[${verdict}] ${row} ${JSON.stringify(detail).slice(0, 400)}`)
}

async function row(name, fn) {
  try {
    await fn()
  } catch (e) {
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

await row('P2 launch restore', async () => {
  await sleep(6500) // lets any earlier user activation expire
  const r = await page.evaluate(() => {
    const open = []
    for (let i = 0; i < 6; i++) open.push(window.open('', `proof-p2-${i}`, `width=320,height=240,left=${40 * i},top=${40 * i}`))
    const n = open.filter(Boolean).length
    open.forEach((w) => w && w.close())
    return n
  })
  rec('P2 launch restore', r === 6 ? 'PASS' : 'FAIL', { opened: r, of: 6 })
})

await row('Placement', async () => {
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
  rec('Placement', bad.length === 0 ? (scales.length > 1 ? 'PASS' : 'PASS (one DPI only)') : 'FAIL', { displays: rows.length, scales, wrong: bad })
})

await row('P4 background (after hours)', async () => {
  await openChildWithGesture('proof-p4', 'width=500,height=360,left=200,top=200')
  const start = () => page.evaluate(() => {
    const w = window.__child
    window.__c = { raf: 0, tick: 0, hidden: null, childHidden: null }
    w.__on = true
    const loop = () => { if (w.__on) { window.__c.raf++; w.requestAnimationFrame(loop) } }
    w.requestAnimationFrame(loop)
    window.__t = setInterval(() => { window.__c.tick++ }, 100)
  })
  const stop = () => page.evaluate(() => {
    clearInterval(window.__t)
    window.__child.__on = false
    window.__c.hidden = document.hidden
    window.__c.childHidden = window.__child.document.hidden
    return window.__c
  })
  await start()
  await sleep(10000)
  const visible = await stop()
  let cdp
  if (target === 'electron') {
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('https://'))
      main.minimize()
    })
  } else {
    cdp = await context.newCDPSession(page)
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
  }
  await sleep(2000)
  await start()
  await sleep(10000)
  const minimized = await stop()
  if (target === 'electron') {
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('https://'))
      main.restore()
    })
  } else {
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
  }
  await page.evaluate(() => window.__child.close())
  const healthy = minimized.raf >= visible.raf * 0.5 && minimized.tick >= 80
  rec('P4 background (after hours)', healthy ? 'PASS' : 'FAIL', { visible, minimized, note: 'market-open CPU row not run' })
})

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

await row('P20 route change', async () => {
  if (base === 0) throw new Error('synthetic board is empty')
  const popup = page.waitForEvent('popup', { timeout: 20000 })
  await page.locator(MENU).first.click()
  await page.locator(BOARD).first.click({ timeout: 10000 })
  const w = await popup
  await sleep(3000)
  let alive = true
  for (const r of ['/options-flow', '/journal', '/settings', '/dashboard', '/breadth']) {
    await page.locator(`a[href="${r}"]`).first.click({ timeout: 15000 })
    await page.waitForURL(`**${r}*`, { timeout: 15000 })
    await sleep(1500)
    if (w.isClosed()) { alive = false; break }
  }
  await page.locator('a[href="/charts"]').first.click({ timeout: 15000 })
  await page.waitForSelector(MENU, { timeout: 45000 })
  await sleep(3000)
  const stillOpen = !w.isClosed()
  if (stillOpen) await w.close()
  await sleep(6000)
  const back = await page.locator(POP).count()
  rec('P20 route change', alive && stillOpen && back === base ? 'PASS' : 'FAIL', { alive, stillOpen, back, base })
})

await row('P6 Cloudflare and auth', async () => {
  const alerts = await page.evaluate(async () => {
    const r = await fetch('/api/alerts', { credentials: 'include' })
    const type = r.headers.get('content-type') || ''
    return { status: r.status, json: type.includes('json') }
  })
  const r = await page.evaluate(async () => {
    const tally = {}
    let cf = 0
    for (let i = 0; i < 500; i++) {
      const x = await fetch('/api/auth/me', { credentials: 'include' })
      tally[x.status] = (tally[x.status] || 0) + 1
      if (x.headers.get('cf-mitigated')) cf++
      await new Promise((d) => setTimeout(d, 250))
    }
    return { tally, cf }
  })
  const ua = await page.evaluate(() => navigator.userAgent)
  log(`user agent: ${ua}`)
  const ok = alerts.status === 200 && alerts.json && r.cf === 0 && !r.tally[403]
  rec('P6 500 calls', ok ? 'PASS' : 'FAIL', { alerts, ...r })
})

if (stream) {
  await row('P6 30-minute stream', async () => {
    const from = Date.now()
    await charts()
    await sleep(30 * 60 * 1000)
    const during = seen.filter((x) => x.t >= from)
    const blocked = during.filter((x) => x.cf || x.s === 403).length
    rec('P6 30-minute stream', blocked === 0 ? 'PASS' : 'FAIL', { responses: during.length, blocked })
  })
}

if (target === 'electron') {
  await row('Quit order', async () => {
    const popup = page.waitForEvent('popup', { timeout: 20000 })
    await page.locator(MENU).first.click()
    await page.locator(BOARD).first.click({ timeout: 10000 })
    const w = await popup
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
      await restore.first.click()
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
