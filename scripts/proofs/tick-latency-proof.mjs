// Tick latency proof on the REAL member path (production, synthetic bench member, real Chrome).
//
// The number this proof exists for: how long after a trade prints on the exchange does the chart's
// newest candle show that price. It is measured in three legs, each on the page's own clock:
//
//   trade -> receive   exchange trade time (the feed's own trade_ts) to the stream message arriving
//                      in the page. Needs this PC's clock offset from true time, which the run
//                      measures by NTP (w32tm against time.cloudflare.com) before and after, and
//                      ties to the page's clock. (Cloudflare's /cdn-cgi/trace `ts` is whole
//                      seconds: useless for this. On 2026-11-15 this PC was 465 ms slow.)
//   receive -> paint   the message arriving to the first animation frame in which the chart's own
//                      debug handle reports that price as its newest close. No clock offset needed.
//   trade -> paint     the sum, per matched trade.
//
// It also records every stream the page opened (which answers "is the bar push stream on for
// members"), every stream message kind and its rate, and gaps between messages.
//
// A Charts board of N charts on separate colour groups (1 to 4). The board belongs to the bench
// account: its version is recorded, the test board applied, and the recorded version ALWAYS restored.
//
// Usage: node scripts/proofs/tick-latency-proof.mjs <out.json> [--syms=SPY,QQQ,NVDA,AAPL] [--tf=1]
//          [--seconds=120] [--warmup=8000] [--profile=<dir>] [--port=9443] [--ls=key=value,...]
//          [--restore=<version>] [--ext=0|1]
// Sends no OS keys or clicks. Needs live ticks: premarket (04:00 ET on) or the regular session.
// With the market closed it still runs and reports "no priced stream messages" (exit 2).
import { writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { startApp, sleep, BASE, recordTrace } from './launch.mjs'

const OUT = process.argv[2]
if (!OUT || OUT.startsWith('--')) { console.error('usage: tick-latency-proof.mjs <out.json> [options]'); process.exit(64) }
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const SYMS = arg('syms', 'SPY').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 4)
const TF = arg('tf', '1')
const SECONDS = Number(arg('seconds', '120'))
const WARMUP = Number(arg('warmup', '8000'))
const PORT = Number(arg('port', '9443'))
const PROFILE = arg('profile', '')
// --ext=0|1: the charts' own extended-hours setting. Premarket and after-hours ticks reach the
// candles only with it ON; without the flag the account's global setting decides (2026-11-16: the
// bench account has it off, and a premarket run painted nothing: 1,822 messages, 0 candle changes).
const EXT = arg('ext', '')
// --cpuprofile: a sampled CPU profile of the page's main thread for the whole measured window, saved as
// <out>.cpuprofile (loadable in DevTools; summarise with indicator-cpu-report.mjs). Sampling costs a
// little CPU itself, so a profiled run's frame numbers are not the baseline's.
const CPU = process.argv.includes('--cpuprofile')
// --trace=MS: a Chromium trace of the first MS of the measured window, saved as <out>.trace.json for
// analyze-trace.py (which thread is busy, GPU presents vs raster). Tracing costs CPU too.
const TRACE_MS = Number(arg('trace', '0')) || 0
const D = { x: -1440, y: 0, w: 1440, h: 950 } // display 2 (portrait), top half: never the trading monitors
const COLORS = ['A', 'B', 'C', 'D']
const chartId = (i) => `tick-chart-${i}`

// Installed BEFORE the page's own scripts: every EventSource the page opens is recorded, and every
// message on it is stamped with the page clock at arrival. Observes only: the page's own listeners
// get every event exactly as before (ours are added first and never stop propagation).
const TAP = `(()=>{
  if (window.__tick) return
  const T = window.__tick = { on: false, opens: [], msgs: [], frames: [], closes: {}, dropped: 0, t0: null }
  const wall = () => performance.timeOrigin + performance.now()
  const ES = window.EventSource
  if (!ES) return
  const KINDS = ['message', 'tick', 'bar', 'bar_close', 'bar_correction', 'stale', 'fresh', 'heartbeat', 'resume']
  function Tapped(url, init) {
    const es = new ES(url, init)
    const u = String(url)
    const path = u.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0]
    const rec = { path, n: (u.split('?')[1] || '').length, at: wall(), opened: null, closedAt: null, errors: 0 }
    T.opens.push(rec)
    es.addEventListener('open', () => { rec.opened = wall() })
    es.addEventListener('error', () => { rec.errors++ })
    const close0 = es.close.bind(es)
    es.close = () => { rec.closedAt = wall(); return close0() }
    if (path.indexOf('/api/stream/') === 0) {
      for (const k of KINDS) es.addEventListener(k, (e) => {
        if (!T.on) return
        if (T.msgs.length >= 400000) { T.dropped++; return }
        T.msgs.push([wall(), path, k, e.data])
      })
    }
    return es
  }
  Tapped.prototype = ES.prototype
  Tapped.CONNECTING = ES.CONNECTING; Tapped.OPEN = ES.OPEN; Tapped.CLOSED = ES.CLOSED
  window.EventSource = Tapped
})()`

// Per animation frame: each chart's newest close, recorded only when it changed. One rAF loop for
// the whole run, armed for the measured window only and stopped after it.
const SAMPLER = (ids) => `(()=>{
  const T = window.__tick
  const ids = ${JSON.stringify(ids)}
  const wall = () => performance.timeOrigin + performance.now()
  T.frames = []; T.frameCount = 0; T.longFrames = 0
  let last = {}, prev = performance.now()
  const step = () => {
    if (!T.on) return
    const now = performance.now()
    T.frameCount++
    if (now - prev > 50) T.longFrames++
    prev = now
    for (const id of ids) {
      const h = (window.__uctChartDebug || {})[id]
      if (!h) continue
      const nb = h.newestBar()
      if (!nb) continue
      const key = nb.time + '|' + nb.close
      if (last[id] !== key) { last[id] = key; T.frames.push([wall(), id, nb.time, nb.close]) }
    }
    requestAnimationFrame(step)
  }
  T.on = true; T.t0 = wall()
  requestAnimationFrame(step)
  return true
})()`

// True time minus this PC's clock, in ms, by NTP: the median of N samples and their spread.
function ntpOffset(samples = 7) {
  const txt = execFileSync('w32tm', ['/stripchart', '/computer:time.cloudflare.com', `/samples:${samples}`, '/dataonly'], { encoding: 'utf8', timeout: 60000 })
  const xs = [...txt.matchAll(/,\s*([+-]\d+\.\d+)s/g)].map((m) => Number(m[1]) * 1000).sort((x, y) => x - y)
  if (xs.length < 3) return null
  return { samples: xs.length, offset: xs[Math.floor(xs.length / 2)], spread: xs[xs.length - 1] - xs[0] }
}
// The page's clock (performance.timeOrigin + now) against this process's Date.now(): the page clock
// is fixed at page start and never steps, the system clock can.
const PAGE_WALL = `performance.timeOrigin + performance.now()`

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) }
const dist = (xs) => ({ n: xs.length, p50: pct(xs, 0.5), p90: pct(xs, 0.9), p95: pct(xs, 0.95), p99: pct(xs, 0.99), max: xs.length ? Math.round(Math.max(...xs)) : null, min: xs.length ? Math.round(Math.min(...xs)) : null })

const out = { proof: 'tick-latency', base: BASE, syms: SYMS, tf: TF, seconds: SECONDS, startedAt: new Date().toISOString() }
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 1))

// --headless=1: an OFF-SCREEN Chrome (headless=new renders real frames, rAF included) for a run while every
// display holds the owner's own windows (2026-11-19 08:40 CT: the portrait display was covered by Discord and
// Webull at the open, 0 frames drawn, no measurement). The user agent is the regular Chrome one (the edge
// refuses a headless signature). What it does NOT include: the display's own scan-out after the frame.
const HEADLESS = arg('headless', '') === '1'
const CHROME_VERSION = arg('chrome-version', '')
const headlessArgs = HEADLESS
  ? ['--headless=new', '--window-size=1440,950', ...(CHROME_VERSION ? [`--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`] : [])]
  : ['--disable-features=CalculateNativeWinOcclusion', `--window-position=${D.x},${D.y}`]
const app = await startApp('chrome', PORT, headlessArgs, PROFILE ? { profile: PROFILE } : {})
let board = null
let originalVersion = null
let exitCode = 0
try {
  const { c, run, waitFor, charts } = app
  if (!HEADLESS) app.placeMainWindow(D.x, D.y, D.w, D.h)
  out.headless = HEADLESS
  board = {
    head: () => run(`fetch('/api/workspace/doc?board=charts',{credentials:'include'}).then(r=>r.json()).then(j=>j.version)`),
    apply: (base, prefs) => run(`fetch('/api/workspace/doc/apply',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ base_version: base, board: 'charts', prefs }))}}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}))`),
    restore: (version, base) => run(`fetch('/api/workspace/doc/restore',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:${version},base_version:${base},board:'charts'})}).then(r=>r.status)`),
  }
  const me = await run(`fetch('/api/auth/me',{credentials:'include'}).then(r=>r.json()).then(j=>String((j.user||j).email||'').split('@')[1])`)
  const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE)
  if (me !== (LOCAL ? 'local.dev' : 'uctintelligence.internal')) throw new Error('not a synthetic account')
  if (LOCAL) throw new Error('this proof measures the production path: a sandbox has no live feed')

  const only = arg('restore', '')
  if (only) { originalVersion = Number(only); out.restoreOnly = originalVersion; throw new Error('restore-only run: no measurement') }

  out.build = await run(`Promise.all([fetch('/api/health').then(r=>r.json()).catch(()=>null), fetch('/build.json').then(r=>r.json()).catch(()=>null)]).then(([h,b])=>({apiCommit:h&&h.commit,apiUptime:h&&h.uptime_seconds,frontCommit:b&&b.commit}))`)
  out.streamStatus = await run(`fetch('/api/stream/status',{credentials:'include'}).then(r=>r.json()).catch(e=>({error:String(e)}))`)

  const lsArg = arg('ls', '')
  if (lsArg) {
    const pairs = lsArg.split(',').map((kv) => kv.split('='))
    out.localStorage = Object.fromEntries(pairs)
    await run(`(()=>{for(const [k,v] of ${JSON.stringify(pairs)}){ if(v==='') localStorage.removeItem(k); else localStorage.setItem(k,v) } return true})()`)
  }
  out.switches = await run(`(()=>{const o={};for(const k of ['uct.barsPool.disabled','uct.indwarm.off','uct.rsdisk.off']){try{o[k]=localStorage.getItem(k)}catch(e){o[k]='unreadable'}}return o})()`)
  console.log(`switches: ${JSON.stringify(out.switches)}`)

  // the test board: one chart per symbol, each on its own colour group, side by side
  const n = SYMS.length
  const w = Math.floor(24 / n)
  const layout = {
    widgets: SYMS.map((_, i) => ({ id: chartId(i), type: 'chart', color: COLORS[i], x: i * w, y: 0, w, h: 20, opts: { tf: TF, settings: { indicatorInstances: [], ...(EXT !== '' ? { extendedHoursShading: EXT === '1' } : {}) } } })),
    cols: 24,
    version: 1,
  }
  const groups = Object.fromEntries(COLORS.map((col, i) => [col, SYMS[i] || null]))
  originalVersion = await board.head()
  out.boardVersionBefore = originalVersion
  // ⛔ Pointer cleared with the board: an account whose active layout is still 'uct-default' is
  // moved to a BLANK board on load (Signature Release 2, applyUctDefault). Restore puts it back.
  const applied = await board.apply(originalVersion, { charts_workspace_layout: JSON.stringify(layout), charts_workspace_groups: JSON.stringify(groups), charts_active_template: 'null' })
  if (applied.status !== 200) throw new Error(`test board refused: ${applied.status} ${JSON.stringify(applied.body).slice(0, 300)}`)
  save()

  // --dist=<dir> (ported from indicator-flip-proof, 2026-11-19): THIS RUN'S BROWSER ONLY runs a local candidate
  // build against production's live stream and API (an A/B of a frontend change on real ticks; nothing published).
  const DIST = arg('dist', '')
  if (DIST) {
    const { existsSync } = await import('node:fs')
    const { join, extname } = await import('node:path')
    const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
    const indexHtml = readFileSync(join(DIST, 'index.html'))
    const entry = (String(indexHtml).match(/\/assets\/index-[\w-]+\.js/) || [''])[0]
    if (!entry) throw new Error('--dist: no /assets/index-*.js in its index.html (is it a vite build?)')
    out.dist = { dir: DIST, entry, documents: 0, served: 0, passedOn: [] }
    const origin = new URL(BASE).origin
    await c.send('Network.enable')
    await c.send('Network.setCacheDisabled', { cacheDisabled: true })
    await c.send('Network.setBypassServiceWorker', { bypass: true })
    await c.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/assets/*` }, { urlPattern: `${origin}/*`, resourceType: 'Document' }] })
    const answer = (requestId, type, buf) => c.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(buf).toString('base64') }).catch(() => {})
    c.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request, resourceType } = m.params
      const u = new URL(request.url)
      if (u.pathname.startsWith('/assets/')) {
        const f = join(DIST, decodeURIComponent(u.pathname))
        if (existsSync(f)) { out.dist.served += 1; answer(requestId, TYPES[extname(f).toLowerCase()] || 'application/octet-stream', readFileSync(f)); return }
        if (out.dist.passedOn.length < 40) out.dist.passedOn.push(u.pathname)
      } else if (resourceType === 'Document' && !u.pathname.startsWith('/api/')) {
        out.dist.documents += 1
        answer(requestId, TYPES['.html'], indexHtml)
        return
      }
      c.send('Fetch.continueRequest', { requestId }).catch(() => {})
    })
  }
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: TAP })
  await charts()
  const ids = SYMS.map((_, i) => chartId(i))
  for (const id of ids) await waitFor(`!!(window.__uctChartDebug && window.__uctChartDebug[${JSON.stringify(id)}] && window.__uctChartDebug[${JSON.stringify(id)}].newestBar())`, 240000)
  if (!(await run(`!!window.__tick`))) throw new Error('the stream tap did not install before the page: nothing would be recorded')
  await sleep(WARMUP)
  out.page = await run(`({hidden:document.hidden,w:innerWidth,h:innerHeight,x:screenX,y:screenY,secure:isSecureContext})`)
  if (out.page.hidden) throw new Error('page is hidden: no frames would be drawn')

  const clockNow = async () => {
    const ntp = ntpOffset()
    if (!ntp) return null
    const a = Date.now(); const pageWall = await run(PAGE_WALL); const b = Date.now()
    // true time = page clock + pageOffset
    return { ...ntp, pageBehindSystem: (a + b) / 2 - pageWall, cdpMs: b - a, pageOffset: ntp.offset + ((a + b) / 2 - pageWall) }
  }
  out.clock = await clockNow()
  if (!out.clock) throw new Error('could not read true time by NTP: trade-to-receive would be unmeasurable')
  if (out.clock.spread > 40) throw new Error(`NTP samples disagree by ${Math.round(out.clock.spread)} ms: the clock correction would be worse than the thing measured`)
  console.log(`clock: this PC is ${Math.round(Math.abs(out.clock.offset))} ms ${out.clock.offset > 0 ? 'slow' : 'fast'} against NTP (spread ${Math.round(out.clock.spread)} ms over ${out.clock.samples}); page clock correction ${Math.round(out.clock.pageOffset)} ms`)

  await run(SAMPLER(ids))
  // rAF must be firing, or every number below would read as "no paint"
  await sleep(1500)
  const fc = await run(`window.__tick.frameCount`)
  if (!(fc > 30)) throw new Error(`only ${fc} frames in 1.5 s: the window is not being drawn (covered or minimised)`)
  console.log(`measuring ${SECONDS} s on ${SYMS.join(', ')} @ ${TF} ...`)
  if (CPU) { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 1000 }); await c.send('Profiler.start') }
  if (TRACE_MS > 0) {
    const t0 = Date.now()
    await recordTrace(PORT, OUT.replace(/\.json$/, '') + '.trace.json', Math.min(TRACE_MS, SECONDS * 1000))
    out.trace = true
    await sleep(Math.max(0, SECONDS * 1000 - (Date.now() - t0)))
  } else await sleep(SECONDS * 1000)
  if (CPU) {
    const { profile } = await c.send('Profiler.stop')
    writeFileSync(OUT.replace(/\.json$/, '') + '.cpuprofile', JSON.stringify(profile))
    out.cpuprofile = true
  }
  const raw = await run(`(()=>{const T=window.__tick; T.on=false; return {t0:T.t0, end:performance.timeOrigin+performance.now(), msgs:T.msgs, frames:T.frames, opens:T.opens, dropped:T.dropped, frameCount:T.frameCount, longFrames:T.longFrames}})()`)
  out.clockAfter = await clockNow()

  // ── analysis ────────────────────────────────────────────────────────────────
  const offset = out.clock.pageOffset // true time - page clock
  const dur = (raw.end - raw.t0) / 1000
  out.window = { seconds: Math.round(dur * 10) / 10, frames: raw.frameCount, fps: Math.round(raw.frameCount / dur), longFrames: raw.longFrames, droppedMsgs: raw.dropped }
  out.streams = raw.opens.map((o) => ({ path: o.path, queryChars: o.n, openedAfterMs: o.opened ? Math.round(o.opened - o.at) : null, closedAfterS: o.closedAt ? Math.round((o.closedAt - o.at) / 100) / 10 : null, errors: o.errors }))
  const byPath = {}
  for (const o of raw.opens) byPath[o.path] = (byPath[o.path] || 0) + 1
  out.streamOpens = byPath
  out.barsPushOnTheWire = !!byPath['/api/stream/bars']

  const kinds = {}
  const gaps = {}
  const lastAt = {}
  const bytes = {}
  const priced = [] // {at, sym, price, tradeTs, src}
  const want = new Set(SYMS)
  for (const [at, path, kind, data] of raw.msgs) {
    const key = `${path} ${kind}`
    kinds[key] = (kinds[key] || 0) + 1
    bytes[key] = (bytes[key] || 0) + (data ? data.length : 0)
    if (kind !== 'heartbeat') {
      if (lastAt[path] != null) (gaps[path] ||= []).push(at - lastAt[path])
      lastAt[path] = at
    }
    let j = null
    try { j = JSON.parse(data) } catch { continue }
    if (!j) continue
    if (path === '/api/stream/prices' && kind === 'message') {
      for (const sym of Object.keys(j)) {
        const e = j[sym]
        if (!want.has(sym) || !e || typeof e.price !== 'number') continue
        priced.push({ at, sym, price: e.price, tradeTs: typeof e.trade_ts === 'number' ? e.trade_ts : null, src: 'prices' })
      }
    } else if (path === '/api/stream/prices' && kind === 'tick') {
      if (want.has(j.sym) && typeof j.price === 'number') priced.push({ at, sym: j.sym, price: j.price, tradeTs: typeof j.ts === 'number' ? (j.ts > 1e11 ? j.ts : j.ts * 1000) : null, src: 'tick' })
    } else if (path === '/api/stream/bars' && kind === 'bar') {
      const b = j.bar || {}
      if (want.has(j.sym) && String(j.tf) === String(TF) && typeof b.c === 'number') priced.push({ at, sym: j.sym, price: b.c, tradeTs: typeof b.trade_ts === 'number' ? b.trade_ts : null, src: 'bar', final: !!b.final })
    }
  }
  out.messages = Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { n: v, perSecond: Math.round((v / dur) * 100) / 100, avgBytes: Math.round(bytes[k] / v) }]))
  out.gapsMs = Object.fromEntries(Object.entries(gaps).map(([k, v]) => [k, dist(v)]))

  // receive -> paint: the first frame AT OR AFTER the message in which that chart's newest close is
  // that price. A message whose price the chart already shows (an earlier message carried it) is
  // counted as already painted, not as an instant paint. A price never painted within 5 s is a miss.
  const framesBy = {}
  for (const [at, id, time, close] of raw.frames) (framesBy[id] ||= []).push({ at, time, close })
  const idOf = Object.fromEntries(SYMS.map((s, i) => [s, chartId(i)]))
  const legs = { tradeToReceive: [], receiveToPaint: [], tradeToPaint: [] }
  const bySrc = {}
  let already = 0, missed = 0, noTradeTs = 0
  const same = (a, b) => Math.abs(a - b) < 1e-6
  for (const m of priced) {
    const s = (bySrc[m.src] ||= { n: 0, tradeToReceive: [], receiveToPaint: [], tradeToPaint: [], already: 0, missed: 0 })
    s.n++
    const tr = m.tradeTs != null ? (m.at + offset) - m.tradeTs : null
    if (tr == null) noTradeTs++
    else if (tr > -250 && tr < 60000) { legs.tradeToReceive.push(tr); s.tradeToReceive.push(tr) }
    const fr = framesBy[idOf[m.sym]] || []
    // what the chart showed just before the message arrived
    let before = null
    for (const f of fr) { if (f.at < m.at) before = f; else break }
    if (before && same(before.close, m.price)) { already++; s.already++; continue }
    const hit = fr.find((f) => f.at >= m.at && f.at - m.at <= 5000 && same(f.close, m.price))
    if (!hit) { missed++; s.missed++; continue }
    const rp = hit.at - m.at
    legs.receiveToPaint.push(rp); s.receiveToPaint.push(rp)
    if (tr != null && tr > -250 && tr < 60000) { legs.tradeToPaint.push(tr + rp); s.tradeToPaint.push(tr + rp) }
  }
  // receive -> FRESH: how long until the chart shows this message's price OR a newer one for the
  // same symbol. In a fast market most prices are replaced before any paint (the page coalesces),
  // so "this exact price painted" misses them, and a price that RECURS seconds later is matched
  // late (2026-11-16 regular session: 37% never painted, receive->paint p95 2.5 s). This leg has
  // neither problem: it is the staleness a member sees. A frame counts when its close equals the
  // price of a message for that symbol that arrived at or after this one and no later than the frame.
  {
    const bySym = {}
    for (const m of priced) (bySym[m.sym] ||= []).push(m)
    const fresh = [], tradeFresh = []
    let stale = 0
    for (const sym of Object.keys(bySym)) {
      const ms = bySym[sym].sort((x, y) => x.at - y.at)
      const fr = framesBy[idOf[sym]] || []
      let fi = 0
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i]
        while (fi < fr.length && fr[fi].at < m.at) fi++
        // the chart ALREADY shows this price when the message arrives: fresh at once (frames are
        // recorded only when the candle changes, so there is no later frame to find)
        if (fi > 0 && same(fr[fi - 1].close, m.price)) { fresh.push(0); const tr0 = m.tradeTs != null ? (m.at + offset) - m.tradeTs : null; if (tr0 != null && tr0 > -250 && tr0 < 60000) tradeFresh.push(tr0); continue }
        let hit = null
        for (let k = fi; k < fr.length && fr[k].at - m.at <= 5000 && !hit; k++) {
          for (let j = i; j < ms.length && ms[j].at <= fr[k].at; j++) if (same(ms[j].price, fr[k].close)) { hit = fr[k]; break }
        }
        if (!hit) { stale++; continue }
        fresh.push(hit.at - m.at)
        const tr = m.tradeTs != null ? (m.at + offset) - m.tradeTs : null
        if (tr != null && tr > -250 && tr < 60000) tradeFresh.push(tr + (hit.at - m.at))
      }
    }
    // the raw material, so a leg can be recomputed later without another live run
    try { writeFileSync(OUT.replace(/\.json$/, '') + '.raw.json', JSON.stringify({ offset, priced: priced.map((m) => [Math.round(m.at), m.sym, m.price, m.tradeTs, m.src]), frames: raw.frames.map(([at, id, time, close]) => [Math.round(at), id, time, close]), idOf })) } catch (e) { console.log('raw save failed: ' + e.message) }
    out.freshMs = { receiveToFresh: dist(fresh), tradeToFresh: dist(tradeFresh), notWithin5s: stale }
    console.log(`receiveToFresh   n=${fresh.length} p50=${out.freshMs.receiveToFresh.p50} p90=${out.freshMs.receiveToFresh.p90} p95=${out.freshMs.receiveToFresh.p95} p99=${out.freshMs.receiveToFresh.p99} max=${out.freshMs.receiveToFresh.max}  (not within 5 s: ${stale})`)
    console.log(`tradeToFresh     n=${tradeFresh.length} p50=${out.freshMs.tradeToFresh.p50} p90=${out.freshMs.tradeToFresh.p90} p95=${out.freshMs.tradeToFresh.p95} p99=${out.freshMs.tradeToFresh.p99} max=${out.freshMs.tradeToFresh.max}`)
  }
  // each chart's newest candle at the first and last change seen: says at a glance whether the
  // candles moved at all, and which session the newest one belongs to
  out.ext = EXT === '' ? 'account setting' : EXT === '1'
  out.newestCandle = Object.fromEntries(SYMS.map((sym) => { const fr = framesBy[idOf[sym]] || []; const a = fr[0], z = fr[fr.length - 1]; return [sym, a ? { changes: fr.length, firstTime: a.time, firstClose: a.close, lastTime: z.time, lastClose: z.close } : null] }))
  out.priced = { messages: priced.length, withoutTradeTime: noTradeTs, alreadyOnChart: already, neverPainted: missed, chartCloseChanges: raw.frames.length }
  out.legsMs = { tradeToReceive: dist(legs.tradeToReceive), receiveToPaint: dist(legs.receiveToPaint), tradeToPaint: dist(legs.tradeToPaint) }
  out.bySource = Object.fromEntries(Object.entries(bySrc).map(([k, v]) => [k, { n: v.n, alreadyOnChart: v.already, neverPainted: v.missed, tradeToReceive: dist(v.tradeToReceive), receiveToPaint: dist(v.receiveToPaint), tradeToPaint: dist(v.tradeToPaint) }]))
  out.clockDriftMs = out.clockAfter ? Math.round(out.clockAfter.pageOffset - offset) : null
  save()

  console.log(`streams opened: ${JSON.stringify(out.streamOpens)}; bar push on the wire: ${out.barsPushOnTheWire}`)
  console.log(`messages: ${JSON.stringify(out.messages)}`)
  console.log(`frames ${out.window.frames} (${out.window.fps}/s), long frames ${out.window.longFrames}`)
  console.log(`priced messages ${priced.length}: already on chart ${already}, never painted ${missed}, without a trade time ${noTradeTs}`)
  for (const [k, v] of Object.entries(out.legsMs)) console.log(`${k.padEnd(16)} n=${v.n} p50=${v.p50} p90=${v.p90} p95=${v.p95} p99=${v.p99} max=${v.max}`)
  if (!priced.length) { console.log('NO PRICED STREAM MESSAGES: the market is closed or the feed is down. Nothing was measured.'); exitCode = 2 }
  else if (!legs.tradeToPaint.length) { console.log('INCONCLUSIVE: messages arrived but none could be matched to a paint with a trade time.'); exitCode = 2 }
} catch (e) {
  out.error = String(e && e.message || e)
  console.error(out.error)
  if (!out.restoreOnly) exitCode = 1
} finally {
  // the bench board goes back to the version recorded before the run, whatever happened
  try {
    if (board && originalVersion != null) {
      let st = null
      for (let i = 0; i < 4; i++) {
        const head = await board.head()
        st = await board.restore(originalVersion, head)
        if (st === 200) break
        await sleep(1500)
      }
      out.boardRestored = st
      console.log(st === 200 ? `bench board restored to version ${originalVersion}` : `RESTORE FAILED (${st}): restore version ${originalVersion} by hand with --restore=${originalVersion}`)
      if (st !== 200) exitCode = exitCode || 3
    }
  } catch (e) { out.boardRestored = String(e); console.error(`RESTORE FAILED: restore version ${originalVersion} by hand with --restore=${originalVersion}`); exitCode = exitCode || 3 }
  out.finishedAt = new Date().toISOString()
  save()
  await app.close()
}
process.exit(exitCode)
