// Indicator flip proof on the REAL member path (production, synthetic bench member, real Chrome).
//
// A Charts board of one chart + one watchlist on the same colour group. The run arrows down the list
// the way a member scans, and for every flip records, per animation frame, when the candles changed
// and when each indicator series the chart's own debug handle reports changed. The lag an indicator
// shows behind its candles is the number this proof exists for.
//
// The board belongs to the bench account: its version is recorded, the test board applied through
// /api/workspace/doc/apply, and the recorded version ALWAYS restored at the end.
//
// Usage: node scripts/proofs/indicator-flip-proof.mjs <out.json> [--flips=N] [--dwell=ms] [--tf=D] [--base=URL] [--set=name]
// Sends no OS keys: key presses are DevTools-dispatched into this run's own page.
import { readFileSync, writeFileSync } from 'node:fs'
import { startApp, sleep, BASE } from './launch.mjs'

const OUT = process.argv[2]
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const FLIPS = Number(arg('flips', '12'))
const DWELL = Number(arg('dwell', '2500'))
const TF = arg('tf', 'D')
const SET = arg('set', 'mixed')
const PORT = Number(arg('port', '9441'))
const PROFILE = arg('profile', '')
const WARMUP = Number(arg('warmup', '8000'))
// --last-dwell=ms: the FINAL flip waits this long instead of --dwell. A burst (--dwell=40, the key
// held down) followed by a stop: how long the chart the member lands on takes to fill in.
const LAST_DWELL = Number(arg('last-dwell', '0'))
// --cpuprofile=i,j: a CPU profile of the 700 ms after the key of those flips, saved beside the output
// (<out>.flip<i>.cpuprofile, loadable in DevTools) for indicator-cpu-report.mjs.
const PROFILE_FLIPS = new Set(arg('cpuprofile', '').split(',').filter(Boolean).map(Number))
const UPDOWN = arg('pattern', 'down') // down | downup (down N then back up N: revisits)
// --stub=ms (LOCAL SANDBOX ONLY): the chart header's small per-symbol reads (research snapshot,
// adjustment basis, event markers) are answered here from a canned body after `ms`, so a sandbox
// with no provider data still shows header values and the server makes no provider call for them.
const STUB = Number(arg('stub', '0'))
// --override=<url part>=<file>: THIS RUN'S BROWSER ONLY is handed <file> wherever it asks for a
// script whose URL contains <url part> (e.g. vendor-charts-=C:/x/vendor-charts-patched.js): a
// candidate chunk measured against live data before it is merged. Nothing is sent to the server.
// The run stops unless the page really ran the file (it sets a marker).
const OVERRIDE = arg('override', '')
// --header=mcap,earn,rating,perf5d,theme,rvol,ipoDate: the chart header's info row shows these fields
// (the default is market cap, next earnings, UCT rating). For timing the optional ones.
const HEADER = arg('header', '').split(',').filter(Boolean)
const D = { x: -1440, y: 0, w: 1440, h: 950 } // display 2 (portrait), top half

const inst = (defId, inputs = {}) => ({ instanceId: `t:${defId}`, defId, inputs, hidden: false })
const SETS = {
  // what a fresh member has: the four averages only
  base: [],
  native: ['rsi', 'macd', 'bb', 'vwap', 'relativeVolume'].map((d) => inst(d)),
  server: ['rsLine', 'rsRating', 'rsPhases', 'rsVsEma', 'rsExit'].map((d) => inst(d)),
  mixed: ['bb', 'vwap', 'rsi', 'macd', 'relativeVolume', 'rsLine', 'rsRating', 'rsPhases', 'rsVsEma', 'rsExit'].map((d) => inst(d)),
}
if (!SETS[SET]) throw new Error(`unknown --set ${SET}`)

const SAMPLER = `(()=>{
  if (window.__flip) { window.__flip.on = false }
  const F = window.__flip = { on: true, frames: [], res: [], keys: [], t0: performance.now() };
  const lastFinite = (d) => { for (let i = d.length - 1, n = 0; i >= 0 && n < 400; i--, n++) { const v = d[i] && d[i].value; if (typeof v === 'number' && Number.isFinite(v)) return d[i].time + '=' + v } return 'none' };
  const sigOf = (id) => {
    const h = (window.__uctChartDebug || {})[id]; if (!h) return null;
    const nb = h.newestBar(); const es = h.engineSeries() || [];
    const o = { c: nb ? nb.count + '|' + nb.time + '|' + nb.close : 'none', s: {} };
    for (const s of es) { const k = s.instanceId + '::' + s.plotKey; let n = s.data.length, lf = lastFinite(s.data); for (const r of s.runs) { n += r.length; if (lf === 'none') lf = lastFinite(r) } o.s[k] = n + '|' + lf }
    return o };
  F.sigOf = sigOf;
  let prev = '';
  const tick = (t) => { if (!F.on) return; const o = sigOf(F.chart); const j = JSON.stringify(o); if (j !== prev) { F.frames.push({ t: t, o: o }); prev = j } requestAnimationFrame(tick) };
  requestAnimationFrame(tick);
  try { F.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.name.indexOf('/api/') >= 0) F.res.push({ u: e.name.replace(location.origin, ''), s: Math.round(e.startTime), e: Math.round(e.responseEnd), ttfb: Math.round(e.responseStart - e.startTime), bytes: e.transferSize, st: (e.serverTiming || []).map((x) => x.name + (x.description ? '(' + x.description + ')' : '') + '=' + Math.round(x.duration)).join(',') }) } }); F.po.observe({ type: 'resource', buffered: false }) } catch (e) {}
  window.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') F.keys.push(performance.now()) }, true);
  // main-thread long tasks (>50 ms): what the page was busy with around a flip
  F.long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (F.long.length < 400) F.long.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }) } }).observe({ type: 'longtask', buffered: false }) } catch (e) {}
  // every DOM text change inside the chart widget, outside the chart canvas: what else lands after the candles
  F.dom = [];
  try { const W = document.querySelector('[data-widget-id="flip-chart"]');
    F.mo = new MutationObserver((list) => { const t = performance.now(); for (const m of list) { if (F.dom.length > 600) return; const el = m.target.nodeType === 3 ? m.target.parentElement : m.target; if (!el || el.closest('canvas') || el.closest('table')) continue; const c = el.className; const cls = String((c && c.baseVal !== undefined ? c.baseVal : c) || el.tagName).split(' ')[0].replace(/^_/, '').slice(0, 44); const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60); F.dom.push({ t: t, cls: cls, txt: txt }) } });
    F.mo.observe(W, { subtree: true, childList: true, characterData: true }) } catch (e) { F.domErr = String(e) }
  return true })()`

// Runs at the start of every new document (see --reloads): one sample per frame of what the chart holds.
const RELOAD_SAMPLER = `(()=>{
  if (window.top !== window) return;
  const R = window.__reload = { frames: [], res: [] };
  const has = (d) => { for (let i = d.length - 1, n = 0; i >= 0 && n < 400; i--, n++) { const v = d[i] && d[i].value; if (typeof v === 'number' && Number.isFinite(v)) return 1 } return 0 };
  let prev = '';
  const tick = (t) => {
    try {
      const h = (window.__uctChartDebug || {})['flip-chart'];
      if (h) {
        const nb = h.newestBar(); const es = h.engineSeries() || [];
        const o = { c: nb ? nb.count : 0, s: {} };
        for (const s of es) { let v = has(s.data); if (!v) for (const r of s.runs) { if (has(r)) { v = 1; break } } o.s[s.instanceId + '::' + s.plotKey] = v }
        const j = JSON.stringify(o);
        if (j !== prev) { R.frames.push({ t: Math.round(t), o: o }); prev = j }
      }
    } catch (e) { R.err = String(e) }
    if (R.frames.length < 400) requestAnimationFrame(tick)
  };
  requestAnimationFrame(tick);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.name.indexOf('/api/signature/') >= 0) R.res.push({ u: e.name.replace(location.origin, '').slice(0, 60), s: Math.round(e.startTime), e: Math.round(e.responseEnd) }) } }).observe({ type: 'resource', buffered: true }) } catch (e) {}
})()`

const out = { startedUtc: new Date().toISOString(), tf: TF, set: SET, flips: [], dwell: DWELL }
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 1))
const app = await startApp('chrome', PORT, ['--disable-features=CalculateNativeWinOcclusion', `--window-position=${D.x},${D.y}`], PROFILE ? { profile: PROFILE } : {})
let board = null
let originalVersion = null
let exitCode = 0
try {
  const { c, run, waitFor, charts } = app
  app.placeMainWindow(D.x, D.y, D.w, D.h)
  board = {
    head: () => run(`fetch('/api/workspace/doc?board=charts',{credentials:'include'}).then(r=>r.json()).then(j=>j.version)`),
    apply: (base, prefs) => run(`fetch('/api/workspace/doc/apply',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ base_version: base, board: 'charts', prefs }))}}).then(async r=>({status:r.status,body:await r.json().catch(()=>null)}))`),
    restore: (version, base) => run(`fetch('/api/workspace/doc/restore',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:${version},base_version:${base},board:'charts'})}).then(r=>r.status)`),
  }
  const me = await run(`fetch('/api/auth/me',{credentials:'include'}).then(r=>r.json()).then(j=>String((j.user||j).email||'').split('@')[1])`)
  const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(BASE)
  if (me !== (LOCAL ? 'local.dev' : 'uctintelligence.internal')) throw new Error('not a synthetic account')
  if (OVERRIDE) {
    if (STUB > 0) throw new Error('--override and --stub cannot be combined')
    const cut = OVERRIDE.indexOf('=')
    const part = OVERRIDE.slice(0, cut)
    const file = OVERRIDE.slice(cut + 1)
    if (cut < 1 || !/^[\w.-]+$/.test(part)) throw new Error('--override=<url part>=<file>')
    const body = Buffer.from(readFileSync(file, 'utf8') + '\n;globalThis.__uctOverride=(globalThis.__uctOverride||0)+1;\n').toString('base64')
    out.override = { part, file, served: [] }
    // A script already in the browser's disk cache is never offered to the interceptor (measured
    // 2026-11-13: fromDiskCache, zero pauses), so the cache is bypassed while the page loads.
    await c.send('Network.enable')
    await c.send('Network.setCacheDisabled', { cacheDisabled: true })
    await c.send('Fetch.enable', { patterns: [{ urlPattern: `*/assets/*${part}*` }] })
    c.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request } = m.params
      out.override.served.push(new URL(request.url).pathname)
      c.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/javascript; charset=utf-8' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body }).catch(() => {})
    })
  }
  // --dist=<dir>: THIS RUN'S BROWSER ONLY runs the frontend built in <dir> (a local `vite build`)
  // against the site's real API. The page document and every /assets/ file that exists in <dir>
  // are answered from disk; everything else (the API, other static files) goes to the site. A
  // whole candidate build measured on production before it is merged: nothing is published.
  // ⛔ Build it with the site's own VITE_* values or its flags read "off" in the candidate.
  const DIST = arg('dist', '')
  if (DIST) {
    if (OVERRIDE || STUB > 0) throw new Error('--dist cannot be combined with --override or --stub')
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
  if (STUB > 0) {
    if (!LOCAL) throw new Error('--stub is for the local sandbox only: production is measured as it is')
    out.stub = { ms: STUB, asked: [] }
    const t0 = Date.now()
    await c.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/research/snapshot/*' }, { urlPattern: '*/api/adjustment-basis/*' }, { urlPattern: '*/api/chart/markers/*' }] })
    c.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request } = m.params
      const u = new URL(request.url)
      const sym = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '')
      out.stub.asked.push({ u: u.pathname + u.search, at: Date.now() - t0 })
      let body = { earnings: [], splits: [], dividends: [] }
      if (u.pathname.includes('/research/snapshot/')) body = { sym, name: `${sym} Inc`, sector: 'Technology', industry: 'Software', composite: 40 + (sym.charCodeAt(0) % 50), components: {}, checkup: [], method: 'stub', metrics: { market_cap: `${sym.length}00.0B` }, next_earnings: '2026-12-01' }
      else if (u.pathname.includes('/adjustment-basis/')) body = { ticker: sym, tf: u.searchParams.get('tf') || 'D', adjustment_basis: { splits: true, dividends: null, as_of: '2024-06-10', applied_by: 'vendor' } }
      setTimeout(() => {
        c.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(JSON.stringify(body)).toString('base64') }).catch(() => {})
      }, STUB)
    })
  }
  out.build = await run(`fetch('/api/health').then(r=>r.json()).then(j=>({uptime:j.uptime_seconds,commit:j.commit||j.git_sha||null})).catch(()=>null)`)
  const serverDefs = await run(`fetch('/api/signature/definitions',{credentials:'include'}).then(r=>r.json()).then(j=>(j.definitions||[]).map(d=>d.id)).catch(()=>[])`)
  out.serverDefs = serverDefs
  let pick, watchKey
  if (LOCAL) {
    // the sandbox has no prebuilt lists: the run makes its own watchlist once (sandbox data only)
    const SYMS = (arg('syms', '') || 'NVDA,AAPL,MSFT,AMZN,META,GOOGL,TSLA,AMD,AVGO,NFLX,CRM,ORCL,ADBE,QCOM,MU,INTC,CSCO,IBM,TXN,AMAT,LRCX,KLAC,PANW,CRWD,SNOW,PLTR,SHOP,UBER,ABNB,COIN,HOOD,SOFI,JPM,GS,BAC,XOM,CVX,LLY,UNH,COST').split(',')
    const mine = await run(`fetch('/api/watchlists?include_items=0&include_prebuilt=0',{credentials:'include'}).then(r=>r.json())`)
    const all = Array.isArray(mine) ? mine : (mine.watchlists || mine.lists || [])
    pick = all.find((l) => l.name === 'flip-proof')
    if (!pick) {
      pick = await run(`fetch('/api/watchlists',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'flip-proof'})}).then(r=>r.json())`)
      pick = pick.watchlist || pick
      const added = await run(`fetch('/api/watchlists/${pick.id}/items/bulk',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbols:${JSON.stringify(SYMS)}})}).then(r=>r.status)`)
      if (added !== 200) throw new Error('could not fill the sandbox watchlist: ' + added)
    }
    watchKey = `user:${pick.id}`
  } else {
    const prebuilt = await run(`fetch('/api/watchlists/prebuilt?include_items=0',{credentials:'include'}).then(r=>r.json())`)
    const lists = Array.isArray(prebuilt) ? prebuilt : (prebuilt.watchlists || prebuilt.lists || prebuilt.items || [])
    out.prebuilt = lists.slice(0, 40).map((l) => ({ id: l.id, name: l.name, n: l.item_count ?? l.count ?? (l.items ? l.items.length : null) }))
    const want = arg('list', '')
    pick = (want && lists.find((l) => String(l.name).toLowerCase().includes(want.toLowerCase())))
      || lists.find((l) => { const n = l.item_count ?? l.count ?? 0; return n >= 30 && n <= 120 }) || lists[0]
    if (!pick) throw new Error('no prebuilt list to scan')
    watchKey = `community:${pick.id}`
  }
  out.list = { id: pick.id, name: pick.name }

  // A --tfs run clicks the chart's own timeframe buttons, and the bar sheds buttons that do not
  // fit: the chart is given more of the row then, so the buttons asked for are there to click.
  const CHART_W = arg('tfs', '') ? 19 : 16
  const layout = {
    widgets: [
      { id: 'flip-chart', type: 'chart', color: 'A', x: 0, y: 0, w: CHART_W, h: 20, opts: { tf: TF, settings: { indicatorInstances: SETS[SET], ...(HEADER.length ? { header: { fields: HEADER } } : {}) } } },
      { id: 'flip-wl', type: 'watchlist', color: 'A', x: CHART_W, y: 0, w: 24 - CHART_W, h: 20, opts: { watchKey, watchName: pick.name } },
    ],
    cols: 24,
    version: 1,
  }
  const groups = { A: 'SPY', B: null, C: null, D: null }
  if (LOCAL) {
    // the sandbox has no document store: the two board keys are written through the preferences door
    for (const [key, value] of [['charts_workspace_layout', JSON.stringify(layout)], ['charts_workspace_groups', JSON.stringify(groups)]]) {
      const st = await run(`fetch('/api/auth/preferences',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify({ key, value }))}}).then(r=>r.status)`)
      if (st !== 200) throw new Error(`sandbox preference ${key} refused: ${st}`)
    }
  } else {
    // --restore=<version>: put that recorded version of the bench board back and stop. For a run
    // whose own restore was refused (see the retry below).
    const only = arg('restore', '')
    if (only) { originalVersion = Number(only); out.restoreOnly = originalVersion; throw new Error('restore-only run: no measurement') }
    originalVersion = await board.head()
    out.boardVersionBefore = originalVersion
    const applied = await board.apply(originalVersion, { charts_workspace_layout: JSON.stringify(layout), charts_workspace_groups: JSON.stringify(groups) })
    if (applied.status !== 200) throw new Error(`test board refused: ${applied.status} ${JSON.stringify(applied.body).slice(0, 300)}`)
  }
  save()

  // --ls=key=value[,key=value]: localStorage set before the page under test loads (e.g. a kill switch)
  const lsArg = arg('ls', '')
  if (lsArg) {
    const pairs = lsArg.split(',').map((kv) => kv.split('='))
    out.localStorage = Object.fromEntries(pairs)
    await run(`(()=>{for(const [k,v] of ${JSON.stringify(pairs)}){ if(v==='') localStorage.removeItem(k); else localStorage.setItem(k,v) } return true})()`)
  }
  // ⛔ A persistent profile REMEMBERS the kill switch. A control run with `--ls=uct.indwarm.off=1`
  // leaves it set, and the next run then measures the OFF state while looking like a normal run
  // (it happened on 2026-11-12). The state in force is recorded and printed with every result.
  out.warmSwitch = await run(`(()=>{try{return localStorage.getItem('uct.indwarm.off')}catch(e){return 'unreadable'}})()`)
  console.log(`indicator pre-load: ${out.warmSwitch === '1' ? 'SWITCHED OFF in this profile (uct.indwarm.off=1)' : 'on'}`)
  await charts()
  await waitFor(`!!(window.__uctChartDebug && window.__uctChartDebug['flip-chart'] && window.__uctChartDebug['flip-chart'].newestBar())`, 240000)
  await waitFor(`document.querySelectorAll('[data-watch-sym]').length >= 8`, 90000)
  // The marker is read on EVERY run: a run without --override that finds it is running an
  // override left in this profile's cache, and would report it as the shipped script.
  const overrideRan = await run(`globalThis.__uctOverride || 0`)
  if (out.override) {
    out.override.ran = overrideRan
    await c.send('Network.disable') // the cache is back in use for the measured flips
    console.log(`override: ${out.override.part} served ${out.override.served.length} time(s) as ${[...new Set(out.override.served)].join(', ')}; ran ${out.override.ran}`)
    if (out.override.ran !== 1) throw new Error('the override file did not run exactly once in the page: this run would measure the shipped script')
  } else if (overrideRan !== 0) throw new Error('an override script from an earlier run is still being served to this profile: clear its cache')
  if (DIST) {
    const runsIt = await run(`!!document.querySelector('script[src*=${JSON.stringify(out.dist.entry)}]')`)
    console.log(`dist: ${out.dist.documents} document(s) and ${out.dist.served} asset(s) answered from ${DIST}; the page runs its entry script: ${runsIt}`)
    if (!runsIt) throw new Error('the page is not running the candidate build: this run would measure the shipped one')
  }
  await sleep(WARMUP) // the list's own up-front warm (and, on a new profile, the bars pack ingest)
  out.pack = await run(`(()=>{const o={};for(const k of ['barspack.version','barspack.seed','barspack.hotVersion','intradaypack.version','breadthpack.version']){try{o[k]=localStorage.getItem(k)}catch(e){o[k]='ERR'}}return o})()`)
  out.page = await run(`({hidden:document.hidden,w:innerWidth,h:innerHeight,x:screenX,y:screenY,rows:document.querySelectorAll('[data-watch-sym]').length,first:[...document.querySelectorAll('[data-watch-sym]')].slice(0,${FLIPS + 3}).map(e=>e.getAttribute('data-watch-sym')),series:(window.__uctChartDebug['flip-chart'].engineSeries()||[]).map(s=>s.instanceId+'::'+s.plotKey+'#'+s.data.length)})`)
  if (out.page.hidden) throw new Error('page is hidden: no frames would be drawn')
  console.log(`list ${pick.name}; rows ${out.page.rows}; series ${out.page.series.join(' ')}`)

  await run(SAMPLER)
  await run(`(()=>{window.__flip.chart='flip-chart';return true})()`)
  // select the first row the way a member would (a click on the row), then arrow down
  await run(`(()=>{const r=document.querySelector('[data-watch-sym]');r.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));r.click();return r.getAttribute('data-watch-sym')})()`, true)
  await sleep(DWELL + 1500)

  const total = UPDOWN === 'downup' ? FLIPS * 2 : FLIPS
  for (let i = 0; i < total; i++) {
    const K = (UPDOWN === 'downup' && i >= FLIPS) ? { key: 'ArrowUp', vk: 38 } : { key: 'ArrowDown', vk: 40 }
    const before = await run(`(()=>{const F=window.__flip;F.frames.length=0;F.res.length=0;F.keys.length=0;F.dom.length=0;F.long.length=0;return {sig:F.sigOf(F.chart),now:performance.now()}})()`)
    const profiling = PROFILE_FLIPS.has(i)
    if (profiling) { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 100 }); await c.send('Profiler.start') }
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: K.key, code: K.key, windowsVirtualKeyCode: K.vk, nativeVirtualKeyCode: K.vk })
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: K.key, code: K.key, windowsVirtualKeyCode: K.vk, nativeVirtualKeyCode: K.vk })
    if (profiling) {
      await sleep(700)
      const { profile } = await c.send('Profiler.stop')
      writeFileSync(OUT.replace(/\.json$/, '') + `.flip${i}.cpuprofile`, JSON.stringify(profile))
      await sleep(Math.max(0, DWELL - 700))
    } else await sleep(LAST_DWELL > 0 && i === total - 1 ? LAST_DWELL : DWELL)
    const got = await run(`(()=>{const F=window.__flip;const sel=document.querySelector('[data-watch-sym][aria-selected="true"],[data-watch-sym][data-selected="true"]');return {key:F.keys[0]||null,frames:F.frames.slice(),res:F.res.slice(),dom:F.dom.slice(),long:F.long.slice(),end:F.sigOf(F.chart),sym:sel?sel.getAttribute('data-watch-sym'):null,title:document.title}})()`)
    out.flips.push({ i, dir: K.key, before: before.sig, ...got })
    save()
  }
  // --tfs=1W,1D,1W: after the flips, switch the chart's timeframe through these (the labels of the
  // buttons in its timeframe bar), one per dwell, recorded exactly like a flip into <out>.tf.json
  // so the same reports read it: do the indicators arrive with the candles on a timeframe switch?
  // --peek=<js expression>: evaluated in the page after the flips (and again after the timeframe
  // switches), the JSON-able result kept as out.peek / out.peekAfterTfs. For asking the page what
  // it holds at the moment that matters (a storage key, a counter an override chunk keeps).
  const PEEK = arg('peek', '')
  const peek = async () => { try { return await run(`(()=>{try{return JSON.parse(JSON.stringify(${PEEK}))}catch(e){return 'peek threw: '+e.message}})()`) } catch (e) { return `peek failed: ${e.message}` } }
  if (PEEK) { out.peek = await peek(); save() }
  const TFS = arg('tfs', '').split(',').filter(Boolean)
  if (TFS.length) {
    const tfOut = { ...out, flips: [], tfSwitches: TFS }
    for (let i = 0; i < TFS.length; i++) {
      const before = await run(`(()=>{const F=window.__flip;F.frames.length=0;F.res.length=0;F.keys.length=0;F.dom.length=0;F.long.length=0;return {sig:F.sigOf(F.chart),now:performance.now()}})()`)
      const clicked = await run(`(()=>{const w=document.querySelector('[data-widget-id="flip-chart"]');const b=[...w.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(TFS[i])});if(!b)return null;const t=performance.now();b.click();return t})()`, true)
      if (clicked == null) {
        const have = await run(`(()=>{const w=document.querySelector('[data-widget-id="flip-chart"]');return w?[...w.querySelectorAll('button')].map(x=>x.textContent.trim()).filter(t=>t&&t.length<=4).join(' '):'no chart widget'})()`)
        throw new Error(`no timeframe button labelled ${TFS[i]} in the chart's bar (short button labels there: ${have})`)
      }
      await sleep(DWELL)
      const got = await run(`(()=>{const F=window.__flip;return {frames:F.frames.slice(),res:F.res.slice(),dom:F.dom.slice(),long:F.long.slice(),end:F.sigOf(F.chart),title:document.title}})()`)
      tfOut.flips.push({ i, dir: `tf ${TFS[i]}`, before: before.sig, key: clicked, ...got })
      writeFileSync(OUT.replace(/\.json$/, '') + '.tf.json', JSON.stringify(tfOut, null, 1))
    }
    if (PEEK) { out.peekAfterTfs = await peek(); save() }
  }
  // --reloads=N: after the flips, reload the page N times and record, from the start of each new
  // document, the frame the candles first appear in and the frame each series first has a value:
  // how long the FIRST chart of a page load waits for its indicators.
  const RELOADS = Number(arg('reloads', '0'))
  if (RELOADS > 0) {
    await sleep(2500) // the group's symbol and anything queued for this browser's stores are written
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: RELOAD_SAMPLER })
    out.reloads = []
    for (let i = 0; i < RELOADS; i++) {
      await c.send('Page.reload', {})
      await sleep(Number(arg('reload-wait', '7000')))
      const got = await run(`(()=>{const R=window.__reload;return R?{frames:R.frames,res:R.res,sym:(document.querySelector('[data-watch-sym][aria-selected="true"],[data-watch-sym][data-selected="true"]')||{getAttribute(){return null}}).getAttribute('data-watch-sym'),title:document.title}:null})()`)
      out.reloads.push(got)
      save()
    }
  }
  // --shot=<file.png>: what the page looks like at the end of the last flip
  const SHOT = arg('shot', '')
  if (SHOT) {
    const { data } = await c.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOT, Buffer.from(data, 'base64'))
    out.shot = SHOT
  }
} catch (e) {
  exitCode = 1
  out.error = String((e && e.stack) || e).slice(0, 600)
  console.log(`run stopped: ${out.error}`)
} finally {
  if (board && originalVersion !== null) {
    try {
      // ⛔ A CONFLICT IS RETRIED, AND THE RESULT IS READ BACK. The page under test autosaves the
      // board (the group's symbol changes on every flip, debounced), so a save can land between
      // reading the head and restoring: the restore then answers 409 and the bench board is left
      // on the test layout (it happened on 2026-11-12, at 0.7 s a flip). Wait out the debounce,
      // retry on 409, and exit non-zero if the recorded board is not back.
      // ⛔ AND A SITE THAT IS RESTARTING IS WAITED FOR. A deploy landed during a run on 2026-11-13:
      // the head read answered an HTML error page, the restore threw, and the bench board was
      // left on the test layout until it was put back by hand. An answer that is not a version
      // number (or a restore that is neither 200 nor 409) is retried for about two minutes.
      await sleep(1500)
      let st = null
      for (let k = 0; k < 30; k++) {
        let head = null
        try { head = await board.head() } catch { head = null }
        if (head === originalVersion) { st = 'unchanged'; break }
        if (typeof head !== 'number') { st = 'site not answering'; await sleep(5000); continue }
        try { st = await board.restore(originalVersion, head) } catch { st = 'site not answering' }
        if (st === 200) break
        await sleep(st === 409 ? 1000 : 5000)
      }
      out.boardRestore = st
      console.log(`board restore: ${out.boardRestore}`)
      if (st !== 200 && st !== 'unchanged') { exitCode = 1; console.log(`BOARD NOT RESTORED: put version ${originalVersion} back with --restore=${originalVersion}`) }
    } catch (e) {
      out.boardRestore = `FAILED: ${String(e.message).slice(0, 120)}; restore version ${originalVersion} by hand`
      console.log(out.boardRestore)
      exitCode = 1
    }
  }
  save()
  await app.close()
}
process.exit(exitCode)
