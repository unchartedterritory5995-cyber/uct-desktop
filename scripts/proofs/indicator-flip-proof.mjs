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
// Usage: node scripts/proofs/indicator-flip-proof.mjs <out.json> [--flips=N] [--dwell=ms] [--tf=D] [--tf2=60] [--set=name] [--soak-every=N]
// Every run records the page's uncaught exceptions and unhandled rejections (out.pageErrors).
// Sends no OS keys: key presses are DevTools-dispatched into this run's own page.
import { readFileSync, writeFileSync } from 'node:fs'
import { startApp, sleep, BASE } from './launch.mjs'
import { execFileSync } from 'node:child_process'
import { cpus, freemem } from 'node:os'

// THIS PC IS SHARED (coordinator 2026-11-21): every run logs the machine's CPU and free RAM each second, and how
// much of the CPU was NOT this run (system busy time minus this run's browser tree and this process). A run is
// UNDER LOAD when other processes averaged more than 4 cores (this 24-core PC idles at ~2 with the owner's apps
// open, measured 2026-11-21; a heavy job beside a run reads 13), or free RAM fell under 6 GB.
function startMachineLog(chromePid) {
  const sys = () => cpus().reduce((a, c) => { const t = c.times; a.busy += t.user + t.nice + t.sys + t.irq; a.all += t.user + t.nice + t.sys + t.irq + t.idle; return a }, { busy: 0, all: 0 })
  const tree = () => {
    const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime; $ids = New-Object 'System.Collections.Generic.HashSet[int]'; [void]$ids.Add(${chromePid}); do { $n = $ids.Count; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId)) { [void]$ids.Add([int]$p.ProcessId) } } } while ($ids.Count -ne $n); $s = 0; foreach ($p in $all) { if ($ids.Contains([int]$p.ProcessId)) { $s += $p.KernelModeTime + $p.UserModeTime } }; [math]::Round($s / 10000)`
    try { return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 30000 }).trim()) } catch { return null }
  }
  const n = cpus().length
  const t0 = Date.now(), s0 = sys(), c0 = tree(), p0 = process.cpuUsage()
  const samples = []
  let prev = s0
  const timer = setInterval(() => { const cur = sys(); const all = cur.all - prev.all; samples.push({ t: Math.round((Date.now() - t0) / 1000), cpu: all > 0 ? Math.round(((cur.busy - prev.busy) / all) * 1000) / 10 : null, freeMB: Math.round(freemem() / 1048576) }); prev = cur }, 1000)
  timer.unref()
  return {
    stop() {
      clearInterval(timer)
      const wall = (Date.now() - t0) / 1000, s1 = sys(), c1 = tree(), pu = process.cpuUsage(p0)
      const sysCoreS = (s1.busy - s0.busy) / 1000 // cpus() times are ms per core
      const mineS = (c0 != null && c1 != null ? (c1 - c0) / 1000 : 0) + (pu.user + pu.system) / 1e6
      const cpu = samples.map((x) => x.cpu).filter((x) => x != null).sort((a, b) => a - b)
      const q = (p) => (cpu.length ? cpu[Math.min(cpu.length - 1, Math.floor(cpu.length * p))] : null)
      const free = samples.map((x) => x.freeMB)
      const othersCores = wall > 0 ? Math.round(((sysCoreS - mineS) / wall) * 100) / 100 : null
      const freeMinMB = free.length ? Math.min(...free) : Math.round(freemem() / 1048576)
      const why = []
      if (othersCores != null && othersCores > 4) why.push(`other processes averaged ${othersCores} cores`)
      if (freeMinMB < 6144) why.push(`free RAM fell to ${freeMinMB} MB`)
      return { cores: n, wallS: Math.round(wall), cpuMedPct: q(0.5), cpuP90Pct: q(0.9), freeMinMB, runCpuS: Math.round(mineS * 10) / 10, systemBusyCoreS: Math.round(sysCoreS * 10) / 10, othersCores, underLoad: why.length > 0, why, samples: samples.slice(0, 900) }
    },
  }
}

const OUT = process.argv[2]
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const FLIPS = Number(arg('flips', '12'))
const DWELL = Number(arg('dwell', '2500'))
const TF = arg('tf', 'D')
// --tf2=<tf>: a SECOND chart on the same colour group at this timeframe, beside the first (the owner's
// scan: daily + an intraday chart linked to one watchlist). Each frame then also records `o2`, chart 2's state.
const TF2 = arg('tf2', '')
// --tf3=<tf> (with --tf2): a THIRD chart on the same colour group (D + 60m + 5m). Each frame also records `o3`.
const TF3 = arg('tf3', '')
if (TF3 && !TF2) throw new Error('--tf3 needs --tf2')
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
const UPDOWN = arg('pattern', 'down') // down | downup (down N then back up N: revisits) | typed | jump
// --pattern=typed --typed=AAA,BBB,...: with the chart focused, TYPE each ticker (one key-down per
// character, --type-gap ms apart, as a member types), pause --typed-pause ms, then Enter. The flip's
// key time is the ENTER: what a member waits on after deciding. The type-to-search warm (if any)
// runs during the typing, exactly as for a member.
// --pattern=jump: POINT at a row --jump rows below the selection (outside the ±6 the list holds),
// --hover ms, then click it. The flip's key time is the CLICK.
const TYPED = arg('typed', '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
const TYPE_GAP = Number(arg('type-gap', '90'))
const TYPED_PAUSE = Number(arg('typed-pause', '300'))
const JUMP = Number(arg('jump', '9'))
const HOVER = Number(arg('hover', '250'))
const AUTOREPEAT = arg('autorepeat', '') === '1' // a held key (repeat key-downs, one key-up), not taps
// --cadence=ms (arrow-key patterns): the next key is pressed this long after the previous one (the per-flip reads
// are inside it), instead of a dwell AFTER each read: 150 / 300 ms taps, or 33 ms with --autorepeat=1 (a held key
// at the OS repeat rate). --last-dwell still sets how long the final flip is watched.
const CADENCE = Number(arg('cadence', '0'))
// --light-sampler=1: the per-frame sample reads only each chart's newest bar and view, never its indicator series
// (engineSeries copies every series each call): the instrument stays out of the frame it measures. Implies the
// cheap bar count. The presentation stamp (paint-probe.js) needs neither.
const LIGHT_SAMPLER = arg('light-sampler', '') === '1' || arg('stamp-only', '') === '1'
// --stamp-only=1 (the matrix's default): the frame sampler's per-frame loop does not run at all, so nothing is read
// from the charts per frame (the old `seen` stamp is then unavailable); the switch is judged on the presentation
// stamp, and each chart's state is read once before the key and once after the post-paint window.
const STAMP_ONLY = arg('stamp-only', '') === '1'
// --no-paint-probe=1: leave the presentation probe out (the probe-on vs probe-off check of its own cost)
const NO_PAINT_PROBE = arg('no-paint-probe', '') === '1'
// --trace=i,j (arrow-key patterns; ported from the device-store agent's copy, 2026-11-20): a Chromium trace of
// those flips, <out>.flip<i>.trace.json, with `traceAlign` (a user-timing mark's page time) and the paint probe's
// marks on, for pixels-trace-check.mjs.
const TRACE_FLIPS = new Set(arg('trace', '').split(',').filter(Boolean).map(Number))
const TRACE_CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel', 'blink.user_timing', 'latencyInfo', 'input', 'cc', 'gpu', 'viz', 'benchmark', 'blink', 'scheduler']
// --stub=ms (LOCAL SANDBOX ONLY): the chart header's small per-symbol reads (research snapshot,
// adjustment basis, event markers) are answered here from a canned body after `ms`, so a sandbox
// with no provider data still shows header values and the server makes no provider call for them.
const STUB = Number(arg('stub', '0'))
// --delay-bars=MS: hold every /api/bars/<SYM> answer MS in the browser (a cold bar-server read, e.g.
// FROG 5m bars(sqlite)=1523 on 2026-11-17) to prove what a chart shows while its first answer is slow.
const DELAY_BARS = Number(arg('delay-bars', '0'))
// --override=<url part>=<file>: THIS RUN'S BROWSER ONLY is handed <file> wherever it asks for a
// script whose URL contains <url part> (e.g. vendor-charts-=C:/x/vendor-charts-patched.js): a
// candidate chunk measured against live data before it is merged. Nothing is sent to the server.
// The run stops unless the page really ran the file (it sets a marker).
const OVERRIDE = arg('override', '')
// --header=mcap,earn,rating,perf5d,theme,rvol,ipoDate: the chart header's info row shows these fields
// (the default is market cap, next earnings, UCT rating). For timing the optional ones.
const HEADER = arg('header', '').split(',').filter(Boolean)
// --ext=0|1: the chart's own extended-hours setting, written into the test board's chart. Without
// it the board's chart carries a PARTIAL settings blob, and the app resolves a missing
// `extendedHoursShading` two ways (the widget: default ON; the chart: the account's global
// setting), so the symbol handoff prepared the extended-hours 60m series while the chart drew the
// regular-hours one (found 2026-11-15: a wasted round trip before every 60m paint).
const EXT = arg('ext', '')
// --soak-every=N (arrow-key patterns): the page's JS heap after a full garbage collection (twice) before the
// first flip and after every N flips, into out.soak; the flips are then kept slim (no res/dom/long). What a
// switch RETAINS: on 2026-11-20 a base-app leak kept ~20 MB per switch until the page hung near 150.
// --abort-heap-mb=N: a reading over N MB stops the run (the box's safety: a leaking page grows by GBs).
const SOAK_EVERY = Number(arg('soak-every', '0'))
// --heap-ends=1: the same heap-after-GC reading before the first flip and after the last, for every pattern
const HEAP_ENDS = arg('heap-ends', '') === '1'
const ABORT_HEAP_MB = Number(arg('abort-heap-mb', '0'))
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

// --cheap-sampler=1: read the chart's bar COUNT only when its newest bar (time|close) changes, or every 30th
// frame. `count` is series.data().length, a copy of every row: read per frame it cost 80-136 ms of each
// 60m flip's first 700 ms (2026-11-19 CPU profiles), inflating every long task this proof reports. Use
// it for freeze (long-task) runs; leave it off where a count-only change must be timed to the frame.
const CHEAP_SAMPLER = arg('cheap-sampler', '') === '1' || LIGHT_SAMPLER
const SAMPLER = `(()=>{
  const CHEAP = ${CHEAP_SAMPLER ? 'true' : 'false'};
  const LIGHT = ${LIGHT_SAMPLER ? 'true' : 'false'};
  if (window.__flip) { window.__flip.on = false }
  const F = window.__flip = { on: true, frames: [], res: [], keys: [], t0: performance.now() };
  const lastFinite = (d) => { for (let i = d.length - 1, n = 0; i >= 0 && n < 400; i--, n++) { const v = d[i] && d[i].value; if (typeof v === 'number' && Number.isFinite(v)) return d[i].time + '=' + v } return 'none' };
  const sigOf = (id) => {
    const h = (window.__uctChartDebug || {})[id]; if (!h) return null;
    const nb = h.newestBar(); const es = LIGHT ? [] : (h.engineSeries() || []);
    const tc = nb ? nb.time + '|' + nb.close : null; F.fc = (F.fc || 0) + 1;
    let cnt;
    const st = (F.st = F.st || {})[id] || (F.st[id] = {}); cnt = st.count;
    if (!CHEAP || !nb || tc !== st.tc || F.fc % 30 === 0 || cnt == null) { cnt = nb ? nb.count : null; st.tc = tc; st.count = cnt }
    const o = { c: nb ? cnt + '|' + nb.time + '|' + nb.close : 'none', s: {} };
    // (ported 2026-11-20 from the device-store agent's copy) the newest candle's distance from the right edge
    // (m: visibleRange().to - newestIndex(), invariant to a left prepend) and the visible width (w): a change
    // after the first paint is the picture moving (VISIBLE_RANGE_DRIFT / a zoom change), not a deeper history
    try { const vr = h.visibleRange(); const ni = h.newestIndex(); if (vr && Number.isFinite(ni)) { o.m = Math.round((vr.to - ni) * 100) / 100; o.w = Math.round((vr.to - vr.from) * 10) / 10 } } catch (e) {}
    for (const s of es) { const k = s.instanceId + '::' + s.plotKey; let n = s.data.length, lf = lastFinite(s.data); for (const r of s.runs) { n += r.length; if (lf === 'none') lf = lastFinite(r) } o.s[k] = n + '|' + lf }
    return o };
  F.sigOf = sigOf;
  // ── the presentation stamp's per-flip state (paint-probe.js records every chart paint and when it was presented)
  const PP = window.__paintProbe || null;
  F.evt = []; F.busy = []; F.gen = 0; F.pp0 = 0; F.arm = null;
  // Event Timing: the input's own first presentation (a cross-check: the charts cannot be on screen before it)
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (F.evt.length < 200 && (e.name === 'keydown' || e.name === 'keyup' || e.name === 'click' || e.name === 'pointerdown')) F.evt.push({ n: e.name, s: e.startTime, ps: e.processingStart, pe: e.processingEnd, d: e.duration }) } }).observe({ type: 'event', durationThreshold: 16, buffered: false }) } catch (e) {}
  // THE POST-PAINT BUDGET: once every linked chart has PRESENTED the new symbol, a message-channel ping runs for
  // 1 s (or until the next key): any gap over 8 ms between its turns is the main thread busy that long.
  F.startBusy = (from, gen) => { try { const ch = new MessageChannel(); let last = performance.now(); const end = from + 1000; ch.port1.onmessage = () => { const now = performance.now(); if (now - last > 8 && F.busy.length < 500) F.busy.push({ s: Math.round(last * 10) / 10, d: Math.round((now - last) * 10) / 10 }); last = now; if (now < end && F.gen === gen) ch.port2.postMessage(0); else { ch.port1.close(); F.busyEnd = now } }; F.busyFrom = from; ch.port2.postMessage(0) } catch (e) {} };
  const idsOf = () => [F.chart, F.chart2, F.chart3].filter(Boolean);
  const newest = (id) => { try { const nb = window.__uctChartDebug[id].newestBar(); return nb ? { time: nb.time, close: nb.close } : { time: null, close: null } } catch (e) { return { time: null, close: null } } };
  F.arm0 = () => { F.gen++; F.busy = []; F.evt = []; F.busyFrom = null; F.busyEnd = null; F.pp0 = PP ? PP.paints.length : 0; const need = {}; for (const id of idsOf()) need[id] = newest(id); const gen = F.gen; F.arm = { gen, need, found: {}, presented: {}, done: false, key: () => (F.gen === gen && F.keys.length ? F.keys[0] : Infinity) }; if (PP) PP.armed = F.arm };
  F.take = () => { const finals = {}; for (const id of idsOf()) finals[id] = newest(id); if (PP && PP.armed === F.arm) PP.armed = null; return { paints: PP ? PP.paints.slice(F.pp0) : null, evt: F.evt.slice(), busy: F.busy.slice(), busyFrom: F.busyFrom, busyEnd: F.busyEnd, finals } };
  if (PP) PP.onComplete = (p) => { const A = F.arm; if (!A || A.gen !== F.gen || A.done || !p.first || A.found[p.w] !== p) return; A.presented[p.w] = p.complete; if (Object.keys(A.presented).length === Object.keys(A.need).length) { A.done = true; F.startBusy(Math.max(...Object.values(A.presented)), A.gen) } };
  let prev = '';
  const STAMP_ONLY = ${STAMP_ONLY ? 'true' : 'false'};
  // a sample that throws (a chart handle mid-remount) is counted, never left to stop the loop or to read as a page error
  const tick = (t) => { if (!F.on) return; try { const n = performance.now(); const o = sigOf(F.chart); const o2 = F.chart2 ? sigOf(F.chart2) : null; const o3 = F.chart3 ? sigOf(F.chart3) : null; const j = JSON.stringify([o, o2, o3]); if (j !== prev) { F.frames.push(o3 ? { t: t, n: n, o: o, o2: o2, o3: o3 } : o2 ? { t: t, n: n, o: o, o2: o2 } : { t: t, n: n, o: o }); prev = j } } catch (e) { F.sampleErrs = (F.sampleErrs || 0) + 1 } requestAnimationFrame(tick) };
  if (!STAMP_ONLY) requestAnimationFrame(tick);
  try { F.po = new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.name.indexOf('/api/') >= 0) F.res.push({ u: e.name.replace(location.origin, ''), s: Math.round(e.startTime), e: Math.round(e.responseEnd), ttfb: Math.round(e.responseStart - e.startTime), bytes: e.transferSize, st: (e.serverTiming || []).map((x) => x.name + (x.description ? '(' + x.description + ')' : '') + '=' + Math.round(x.duration)).join(',') }) } }); F.po.observe({ type: 'resource', buffered: false }) } catch (e) {}
  window.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || (F.enterKeys && e.key === 'Enter')) F.keys.push(performance.now()) }, true);
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

const out = { startedUtc: new Date().toISOString(), tf: TF, set: SET, flips: [], dwell: DWELL, cheapSampler: CHEAP_SAMPLER }
const save = () => writeFileSync(OUT, JSON.stringify(out, null, 1))
// --headless=1 (+ --chrome-version=<x.y.z.w>): an OFF-SCREEN Chrome (headless=new draws real frames) for a run
// while every display holds the owner's windows (same option as tick-latency-proof, 2026-11-19).
const HEADLESS = arg('headless', '') === '1'
const CHROME_VERSION = arg('chrome-version', '')
const launchArgs = HEADLESS
  ? ['--headless=new', '--window-size=1440,950', ...(CHROME_VERSION ? [`--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`] : [])]
  : ['--disable-features=CalculateNativeWinOcclusion', `--window-position=${D.x},${D.y}`]
const app = await startApp('chrome', PORT, launchArgs, PROFILE ? { profile: PROFILE } : {})
const machine = startMachineLog(app.child.pid)
let board = null
let originalVersion = null
let exitCode = 0
try {
  const { c, run, waitFor, charts } = app
  if (!HEADLESS) app.placeMainWindow(D.x, D.y, D.w, D.h)
  out.headless = HEADLESS
  // EVERY uncaught page exception and unhandled promise rejection from sign-in on, into out.pageErrors. They
  // are the page's own: this proof's evaluations hand their errors back to the caller, and its frame sampler
  // catches its own. A rejection handled later (Runtime.exceptionRevoked) is taken back off the count.
  out.pageErrors = { count: 0, rejections: 0, revoked: 0, first: [] }
  const pageErrorIds = new Map()
  c.on((m) => {
    if (m.method === 'Runtime.exceptionRevoked') {
      const kind = pageErrorIds.get(m.params.exceptionId)
      if (!kind) return
      pageErrorIds.delete(m.params.exceptionId)
      out.pageErrors.count -= 1
      out.pageErrors.revoked += 1
      if (kind === 'rejection') out.pageErrors.rejections -= 1
      return
    }
    if (m.method !== 'Runtime.exceptionThrown') return
    const d = m.params.exceptionDetails || {}
    const kind = /in promise/i.test(String(d.text || '')) ? 'rejection' : 'error'
    pageErrorIds.set(d.exceptionId, kind)
    out.pageErrors.count += 1
    if (kind === 'rejection') out.pageErrors.rejections += 1
    const frame = (d.stackTrace && d.stackTrace.callFrames && d.stackTrace.callFrames[0]) || {}
    if (out.pageErrors.first.length < 20) {
      out.pageErrors.first.push({
        at: new Date().toISOString(), kind,
        text: String((d.exception && d.exception.description) || d.text || '').slice(0, 400),
        where: `${String(d.url || frame.url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 120)}:${(d.lineNumber ?? frame.lineNumber ?? -1) + 1}`,
      })
    }
  })
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
    await c.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}/assets/*` }, { urlPattern: `${origin}/*`, resourceType: 'Document' },
      ...(DELAY_BARS > 0 ? [{ urlPattern: '*/api/bars/*' }] : [])] })
    const answer = (requestId, type, buf) => c.send('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Cache-Control', value: 'no-store' }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: Buffer.from(buf).toString('base64') }).catch(() => {})
    c.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request, resourceType } = m.params
      const u = new URL(request.url)
      if (DELAY_BARS > 0 && u.pathname.startsWith('/api/bars/')) return    // the --delay-bars handler owns these
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
  if (DELAY_BARS > 0) {
    out.delayBars = { ms: DELAY_BARS, held: 0 }
    if (!DIST) await c.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/bars/*' }] })
    c.on((m) => {
      if (m.method !== 'Fetch.requestPaused') return
      const { requestId, request } = m.params
      if (!new URL(request.url).pathname.startsWith('/api/bars/')) return
      out.delayBars.held += 1
      setTimeout(() => c.send('Fetch.continueRequest', { requestId }).catch(() => {}), DELAY_BARS)
    })
  }
  // --console=<regex>: print (and keep in the result) every page console message matching it, e.g. a
  // throwaway instrumented build's `[lakedbg]` lines. Messages carry their own page clock if they need one.
  const CONSOLE = arg('console', '')
  if (CONSOLE) {
    const re = new RegExp(CONSOLE)
    out.console = []
    await c.send('Runtime.enable')
    c.on((m) => {
      if (m.method !== 'Runtime.consoleAPICalled') return
      const text = (m.params.args || []).map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description || a.type))).join(' ')
      if (!re.test(text)) return
      out.console.push(text)
      console.log(`console ${text}`)
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
  out.build = await run(`fetch('/api/health').then(r=>r.json()).then(j=>({uptime:j.uptime_seconds,commit:j.commit||j.git_sha||null,buildId:j.build_id||null})).catch(()=>null)`)
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
    if (want.startsWith('user:')) {
      // --list=user:<name>: the bench member's OWN list of that name (refused when there is none)
      const name = want.slice(5).toLowerCase()
      const mine = await run(`fetch('/api/watchlists?include_items=0&include_prebuilt=0',{credentials:'include'}).then(r=>r.json())`)
      const own = Array.isArray(mine) ? mine : (mine.watchlists || mine.lists || [])
      out.ownLists = own.slice(0, 40).map((l) => ({ id: l.id, name: l.name, n: l.item_count ?? l.count ?? null }))
      pick = own.find((l) => String(l.name).toLowerCase() === name) || own.find((l) => String(l.name).toLowerCase().includes(name))
      if (!pick) throw new Error(`the bench member has no list named ${want.slice(5)} (it has: ${own.map((l) => l.name).join(', ') || 'none'})`)
      watchKey = `user:${pick.id}`
    } else {
      pick = (want && lists.find((l) => String(l.name).toLowerCase().includes(want.toLowerCase())))
        || lists.find((l) => { const n = l.item_count ?? l.count ?? 0; return n >= 30 && n <= 120 }) || lists[0]
      if (!pick) throw new Error('no prebuilt list to scan')
      watchKey = `community:${pick.id}`
    }
  }
  out.list = { id: pick.id, name: pick.name }

  // A --tfs run clicks the chart's own timeframe buttons, and the bar sheds buttons that do not
  // fit: the chart is given more of the row then, so the buttons asked for are there to click.
  const CHART_W = arg('tfs', '') ? 19 : 16
  const layout = {
    widgets: [
      { id: 'flip-chart', type: 'chart', color: 'A', x: 0, y: 0, w: TF3 ? 6 : TF2 ? 8 : CHART_W, h: 20, opts: { tf: TF, settings: { indicatorInstances: SETS[SET], ...(EXT !== '' ? { extendedHoursShading: EXT === '1' } : {}), ...(HEADER.length ? { header: { fields: HEADER } } : {}) } } },
      ...(TF2 ? [{ id: 'flip-chart-2', type: 'chart', color: 'A', x: TF3 ? 6 : 8, y: 0, w: TF3 ? 6 : 8, h: 20, opts: { tf: TF2, settings: { indicatorInstances: SETS[SET], ...(EXT !== '' ? { extendedHoursShading: EXT === '1' } : {}) } } }] : []),
      ...(TF3 ? [{ id: 'flip-chart-3', type: 'chart', color: 'A', x: 12, y: 0, w: 6, h: 20, opts: { tf: TF3, settings: { indicatorInstances: SETS[SET], ...(EXT !== '' ? { extendedHoursShading: EXT === '1' } : {}) } } }] : []),
      // --watch-opts=<json>: the watchlist widget's opts given whole (e.g. a saved screen: {"listSub":{...}})
      { id: 'flip-wl', type: 'watchlist', color: 'A', x: TF3 ? 18 : TF2 ? 16 : CHART_W, y: 0, w: TF3 ? 6 : TF2 ? 8 : 24 - CHART_W, h: 20, opts: arg('watch-opts', '') ? JSON.parse(arg('watch-opts', '')) : { watchKey, watchName: pick.name } },
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
    // ⛔ The active-layout pointer is cleared with the board (2026-11-16): Signature Release 2
    // moves an account whose pointer is still 'uct-default' to a BLANK board on load
    // (ChartsWorkspace applyUctDefault), so a test board applied under that pointer never
    // mounts ("reading 'engineSeries'" of undefined). The restore puts the pointer back.
    const applied = await board.apply(originalVersion, { charts_workspace_layout: JSON.stringify(layout), charts_workspace_groups: JSON.stringify(groups), charts_active_template: 'null' })
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
  // every per-browser switch this work reads, as this profile holds it for THIS run
  out.switches = await run(`(()=>{const o={};for(const k of ['uct.indwarm.off','uct.rsdisk.off','uct.restgate.off','uct.plotwindow.off','uct.deviceStore','uct.neighborframes']){try{o[k]=localStorage.getItem(k)}catch(e){o[k]='unreadable'}}return o})()`)
  console.log(`switches: ${JSON.stringify(out.switches)}`)
  // ⛔ EVERY REQUEST FROM THE PAGE LOAD ON, not only those inside a flip (2026-11-15). Each flip's
  // `res` starts empty, so what the page asked for before the first key press (a list's up-front
  // warm) was invisible: a run with no server-lane request in it read as "zero requests" while
  // the warm had answered every row before the walk began. The browser keeps 250 entries by
  // default; the buffer is raised before the page loads and the whole timeline is kept as
  // out.allRes after the flips (same clock as each flip's `key`).
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `try{performance.setResourceTimingBufferSize(50000)}catch(e){}` })
  // THE PRESENTATION STAMP: every chart paint (lightweight-charts' rAF draw) and when its frame was presented
  if (!NO_PAINT_PROBE) await c.send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(new URL('./paint-probe.js', import.meta.url), 'utf8') })
  out.stampOnly = STAMP_ONLY
  out.noPaintProbe = NO_PAINT_PROBE
  // --idbtrace: every IndexedDB transaction the page opens (database, mode, stores, when it was
  // created, when it finished) and every get/put request inside it (store, key, how long), into
  // out.idbTrace for idb-trace-report.mjs. Installed before the page loads; times are the page's
  // performance.now(), the same clock the flips' `key` uses. Observes only: nothing is changed.
  if (arg('idbtrace', '')) {
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
      if (window.__idbTrace) return
      const T = window.__idbTrace = { tx: [], req: [] }
      const now = () => performance.now()
      const keyOf = (k) => { try { return typeof k === 'string' ? k.slice(0, 40) : JSON.stringify(k).slice(0, 40) } catch (e) { return '?' } }
      const tx0 = IDBDatabase.prototype.transaction
      IDBDatabase.prototype.transaction = function (stores, mode, opts) {
        const tx = tx0.call(this, stores, mode, opts)
        const rec = { db: this.name, mode: mode || 'readonly', stores: [].concat(stores).join(','), t0: now(), end: null, how: null, n: 0 }
        if (T.tx.length < 60000) T.tx.push(rec)
        tx.__rec = rec
        tx.addEventListener('complete', () => { rec.end = now(); rec.how = 'complete' })
        tx.addEventListener('abort', () => { rec.end = now(); rec.how = 'abort' })
        tx.addEventListener('error', () => { if (!rec.end) { rec.end = now(); rec.how = 'error' } })
        return tx
      }
      for (const op of ['get', 'put', 'getAll', 'delete', 'add', 'openCursor', 'count', 'clear']) {
        const f = IDBObjectStore.prototype[op]
        if (!f) continue
        IDBObjectStore.prototype[op] = function (...a) {
          const r = f.apply(this, a)
          const tx = this.transaction && this.transaction.__rec
          if (tx) tx.n++
          const rec = { op, store: this.name, key: keyOf(op === 'put' || op === 'add' ? a[1] ?? (a[0] && (a[0].key || a[0].id)) : a[0]), t0: now(), end: null, tx: tx ? T.tx.indexOf(tx) : -1 }
          if (T.req.length < 200000) T.req.push(rec)
          r.addEventListener('success', () => { rec.end = now() })
          r.addEventListener('error', () => { rec.end = now(); rec.err = 1 })
          return r
        }
      }
    })()` })
    out.idbtrace = true
  }
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
  if (arg('wait-device', '') === '1') {
    const OPFS_JS = `(async()=>{const o={ok:0,files:0};try{const root=await navigator.storage.getDirectory();let dir=null;try{dir=await root.getDirectoryHandle('uct-device-store')}catch(e){}if(dir){for await(const [name,h] of dir.entries()){if(h.kind!=='file')continue;o.files++;if(name.endsWith('.ok'))o.ok++}}}catch(e){o.err=String(e)}return o})()`
    const t0 = Date.now()
    for (;;) {
      const st = await run(OPFS_JS)
      if (st.ok >= 6) { out.deviceWait = { msAfterWarmup: Date.now() - t0, ok: st.ok, files: st.files }; break }
      if (Date.now() - t0 > 480000) { out.deviceWait = { timeout: true, ok: st.ok, files: st.files, err: st.err || null }; break }
      await sleep(3000)
    }
    console.log(`device seed: ${JSON.stringify(out.deviceWait)}`)
    save()
  }
  out.pack = await run(`(()=>{const o={};for(const k of ['barspack.version','barspack.seed','barspack.hotVersion','intradaypack.version','breadthpack.version']){try{o[k]=localStorage.getItem(k)}catch(e){o[k]='ERR'}}return o})()`)
  out.page = await run(`({hidden:document.hidden,w:innerWidth,h:innerHeight,x:screenX,y:screenY,rows:document.querySelectorAll('[data-watch-sym]').length,first:[...document.querySelectorAll('[data-watch-sym]')].slice(0,${FLIPS + 3}).map(e=>e.getAttribute('data-watch-sym')),series:(window.__uctChartDebug['flip-chart'].engineSeries()||[]).map(s=>s.instanceId+'::'+s.plotKey+'#'+s.data.length)})`)
  if (out.page.hidden) throw new Error('page is hidden: no frames would be drawn')
  console.log(`list ${pick.name}; rows ${out.page.rows}; series ${out.page.series.join(' ')}`)

  out.paintProbe = await run(`!!window.__paintProbe`)
  if (!out.paintProbe && !NO_PAINT_PROBE) throw new Error('the paint probe is not in the page: no presentation stamp')
  if (STAMP_ONLY && NO_PAINT_PROBE) throw new Error('--stamp-only with --no-paint-probe measures nothing')
  // ⛔ (coordinator 2026-11-21) every measurement is of the PATCHED lightweight-charts (the app's build applies
  // app/scripts/chartLibraryPatch.mjs): the page's chart chunk must carry the patch's own marks
  out.lwcPatch = await run(`(async()=>{const js=[...new Set(performance.getEntriesByType('resource').map(e=>e.name).filter(u=>/\\/assets\\/[^?]+\\.js/.test(u)))];const order=js.filter(u=>/vendor|chart/i.test(u)).concat(js.filter(u=>!/vendor|chart/i.test(u)));const LIB=(t)=>t.indexOf('time must be of type BusinessDay')>=0;for(const u of order.slice(0,600)){try{const t=await (await fetch(u)).text();if(LIB(t)){const a=t.indexOf('dataByIndex(-9007199254740991,1)')>=0,b=t.indexOf('size<5e4')>=0||t.indexOf('uctDayMemo')>=0;return {chunk:u.replace(location.origin,''),patched:a&&b,marks:(a?'markers-dataByIndex ':'')+(b?'day-memo':'')}}}catch(e){}}return {chunk:null,patched:null,scanned:js.length}})()`)
  console.log(`chart library: ${out.lwcPatch.patched ? 'PATCHED' : out.lwcPatch.patched === false ? 'NOT PATCHED' : 'not found'} (${out.lwcPatch.chunk})`)
  if (out.lwcPatch.patched === false) throw new Error(`the page runs an UNPATCHED lightweight-charts (${out.lwcPatch.chunk}): build it with the app's vite build`)
  await run(SAMPLER)
  if (TF2) await waitFor(`!!(window.__uctChartDebug && window.__uctChartDebug['flip-chart-2'] && window.__uctChartDebug['flip-chart-2'].newestBar())`, 240000)
  if (TF3) await waitFor(`!!(window.__uctChartDebug && window.__uctChartDebug['flip-chart-3'] && window.__uctChartDebug['flip-chart-3'].newestBar())`, 240000)
  await run(`(()=>{window.__flip.chart='flip-chart';window.__flip.chart2=${TF2 ? "'flip-chart-2'" : 'null'};window.__flip.chart3=${TF3 ? "'flip-chart-3'" : 'null'};return true})()`)
  out.tf2 = TF2 || null
  out.tf3 = TF3 || null
  // select the first row the way a member would (a click on the row), then arrow down
  await run(`(()=>{const r=document.querySelector('[data-watch-sym]');r.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));r.click();return r.getAttribute('data-watch-sym')})()`, true)
  await sleep(DWELL + 1500)

  const total = UPDOWN === 'typed' || UPDOWN === 'jump' ? 0 : (UPDOWN === 'downup' ? FLIPS * 2 : FLIPS)
  // (--soak-every) the heap after a full collection: what the page RETAINS, not garbage it has yet to collect
  const soakSample = async (after) => {
    const t0 = Date.now()
    await c.send('HeapProfiler.enable')
    await c.send('HeapProfiler.collectGarbage'); await sleep(300); await c.send('HeapProfiler.collectGarbage')
    const heap = await c.send('Runtime.getHeapUsage')
    const mb = (v) => (typeof v === 'number' ? +(v / 1048576).toFixed(1) : null)
    const rec = { after, usedMB: mb(heap.usedSize), totalMB: mb(heap.totalSize), backingMB: mb(heap.backingStorageSize), embedderMB: mb(heap.embedderHeapUsedSize), gcMs: Date.now() - t0, at: new Date().toISOString() }
    ;(out.soak = out.soak || []).push(rec)
    save()
    console.log(`soak after ${after} flips: ${rec.usedMB} MB used (after a full GC), ${rec.backingMB} MB array buffers`)
    if (ABORT_HEAP_MB && rec.usedMB != null && rec.usedMB > ABORT_HEAP_MB) throw new Error(`heap ${rec.usedMB} MB over the ${ABORT_HEAP_MB} MB abort line after ${after} flips`)
  }
  if (UPDOWN === 'typed' || UPDOWN === 'jump') {
    if (HEAP_ENDS) await soakSample(0)
    if (UPDOWN === 'typed' && !TYPED.length) throw new Error('--pattern=typed needs --typed=AAA,BBB,...')
    const n = UPDOWN === 'typed' ? TYPED.length : FLIPS
    const CHART = '[data-widget-id="flip-chart"]'
    for (let i = 0; i < n; i++) {
      await run(`(()=>{const F=window.__flip;F.arm0&&F.arm0();F.frames.length=0;F.res.length=0;F.keys.length=0;F.dom.length=0;F.long.length=0;F.enterKeys=${UPDOWN === 'typed'};return true})()`)
      let target = null
      if (UPDOWN === 'typed') {
        target = TYPED[i]
        // focus the chart region (type-to-search opens on a printable key there)
        // the CHART SURFACE (the focusable element holding the canvas), as a member's click on the chart focuses it;
        // 2026-11-17: the first [tabindex="0"] in the widget became a header button (chartMetaItemBtn) and typing went nowhere
        const focused = await run(`(()=>{const W=document.querySelector('${CHART}');const all=W?[...W.querySelectorAll('[tabindex="0"]')]:[];const el=all.find(e=>e.querySelector('canvas'))||all[0]||W;if(el&&el.focus){el.focus({preventScroll:true});return document.activeElement===el}return false})()`)
        if (!focused) throw new Error('could not focus the chart for type-to-search')
        for (const ch of target) {
          const vk = ch.charCodeAt(0)
          await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, code: /[A-Z]/.test(ch) ? `Key${ch}` : '', text: ch, unmodifiedText: ch, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
          await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: /[A-Z]/.test(ch) ? `Key${ch}` : '', windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
          await sleep(TYPE_GAP)
        }
        await sleep(TYPED_PAUSE)
        if (process.argv.includes('--debug-typed')) {
          const dbg = await run(`(()=>{const a=document.activeElement;const ins=[...document.querySelectorAll('input')].filter(x=>x.offsetParent).map(x=>({ph:x.placeholder||'',v:x.value,cls:String(x.className).slice(0,40)}));const opts=[...document.querySelectorAll('[role=option],[class*="result"],[class*="Result"]')].filter(x=>x.offsetParent).slice(0,4).map(x=>x.textContent.trim().slice(0,30));return {active:(a&&a.tagName)+'.'+String(a&&a.className).slice(0,50),val:a&&a.value,inputs:ins.slice(0,4),opts}})()`)
          console.log(`typed ${target}: ${JSON.stringify(dbg)}`)
        }
        const before = await run(`(()=>{const F=window.__flip;F.arm0&&F.arm0();F.frames.length=0;F.keys.length=0;return {sig:F.sigOf(F.chart),sig2:F.chart2?F.sigOf(F.chart2):null,sig3:F.chart3?F.sigOf(F.chart3):null}})()`)
        await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
        await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
        await sleep(DWELL)
        const got = await run(`(()=>{const F=window.__flip;return {key:F.keys[0]||null,frames:F.frames.slice(),res:F.res.slice(),dom:F.dom.slice(),long:F.long.slice(),end:F.sigOf(F.chart),end2:F.chart2?F.sigOf(F.chart2):null,end3:F.chart3?F.sigOf(F.chart3):null,title:document.title,...(F.take?F.take():{})}})()`)
        // --dump-times: every candle time the chart holds at the end of the dwell (to find a hole in its history)
        if (process.argv.includes('--dump-times')) {
          got.times = await run(`(()=>{const h=(window.__uctChartDebug||{})['flip-chart'];const t=h&&h.renderedTail?h.renderedTail(100000):null;return t?t.map(b=>b.time):null})()`)
        }
        out.flips.push({ i, dir: 'typed', sym: target, before: before.sig, before2: before.sig2, before3: before.sig3, ...got })
      } else {
        // point at a row JUMP below the selection (wrapping), wait like a member, click it
        // (ported 2026-11-20 from the device-store agent's copy, the owner's 70-row jumps) A VIRTUALIZED list renders
        // only its window (+12 overscan), so a jump past it is SCROLLED to first, as a member scrolls before
        // clicking: the target is found by the virtualizer's own `data-index`, scrolled into the window, pointed at.
        const pick2 = JUMP > 12 ? await run(`(async()=>{const W=document.querySelector('[data-widget-id="flip-wl"]')||document;const sel=W.querySelector('[data-watch-sym][aria-selected="true"],[data-watch-sym][data-selected="true"],[data-watch-sym][class*="listRowSelected"]');const wrapOf=(el)=>el&&el.closest('[data-index]');const sw=wrapOf(sel)||W.querySelector('[data-index]');if(!sw)return null;const from=Number(sw.getAttribute('data-index'));const total=Number(W.querySelectorAll('[data-index]').length);const scr=(()=>{for(let p=sw.parentElement;p;p=p.parentElement){const cs=getComputedStyle(p);if((cs.overflowY==='auto'||cs.overflowY==='scroll')&&p.scrollHeight>p.clientHeight)return p}return null})();if(!scr)return null;const h=sw.getBoundingClientRect().height||30;const want=from+${JUMP};const frame=()=>new Promise((r)=>requestAnimationFrame(()=>r()));let tw=null;for(let i=0;i<40&&!tw;i++){tw=W.querySelector('[data-index="'+want+'"]');if(tw)break;const max=scr.scrollHeight-scr.clientHeight;if(scr.scrollTop>=max-1){break}scr.scrollTop=Math.min(max,scr.scrollTop+Math.max(h*20,scr.clientHeight*0.8));await frame();await frame()}if(!tw){scr.scrollTop=0;await frame();await frame();tw=W.querySelector('[data-index="'+(${JUMP}%Math.max(1,total))+'"]')||W.querySelector('[data-index]')}const r=tw.querySelector('[data-watch-sym]')||tw;r.scrollIntoView({block:'center'});await frame();for(const t of ['pointerover','pointerenter','mouseover','mouseenter'])r.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t,{bubbles:t.endsWith('over')}));return r.getAttribute('data-watch-sym')})()`) : await run(`(()=>{const rows=[...document.querySelectorAll('[data-watch-sym]')];const sel=rows.findIndex(r=>/listRowSelected/.test(String(r.className))||r.getAttribute('aria-selected')==='true');const at=((sel<0?0:sel)+${JUMP})%rows.length;const r=rows[at];r.scrollIntoView({block:'center'});for(const t of ['pointerover','pointerenter','mouseover','mouseenter'])r.dispatchEvent(new (t.startsWith('pointer')?PointerEvent:MouseEvent)(t,{bubbles:t.endsWith('over')}));return r.getAttribute('data-watch-sym')})()`)
        target = pick2
        await sleep(HOVER)
        const before = await run(`(()=>{const F=window.__flip;F.arm0&&F.arm0();F.frames.length=0;F.keys.length=0;return {sig:F.sigOf(F.chart),sig2:F.chart2?F.sigOf(F.chart2):null,sig3:F.chart3?F.sigOf(F.chart3):null}})()`)
        await run(`(()=>{const r=document.querySelector('[data-watch-sym=${JSON.stringify(String(target))}]');window.__flip.keys.push(performance.now());r.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));r.click();return true})()`)
        await sleep(DWELL)
        const got = await run(`(()=>{const F=window.__flip;return {key:F.keys[0]||null,frames:F.frames.slice(),res:F.res.slice(),dom:F.dom.slice(),long:F.long.slice(),end:F.sigOf(F.chart),end2:F.chart2?F.sigOf(F.chart2):null,end3:F.chart3?F.sigOf(F.chart3):null,title:document.title,...(F.take?F.take():{})}})()`)
        out.flips.push({ i, dir: 'jump', sym: target, before: before.sig, before2: before.sig2, before3: before.sig3, ...got })
      }
      save()
    }
  }
  if ((SOAK_EVERY && total) || (HEAP_ENDS && total)) await soakSample(0)
  let cadOverhead = 8, cadSleepEnd = null
  out.cadence = CADENCE || null
  for (let i = 0; i < total; i++) {
    const K = (UPDOWN === 'downup' && i >= FLIPS) ? { key: 'ArrowUp', vk: 38 } : { key: 'ArrowDown', vk: 40 }
    const tracing = TRACE_FLIPS.has(i)
    let traceAlign = null
    if (tracing) {
      if (!globalThis.__traceSink) {
        globalThis.__traceSink = { on: false, events: [], done: null }
        const T = globalThis.__traceSink
        c.on((m) => {
          if (!T.on) return
          if (m.method === 'Tracing.dataCollected') { for (const e of m.params.value) T.events.push(e) }
          else if (m.method === 'Tracing.tracingComplete') { T.on = false; if (T.done) T.done() }
        })
      }
      const T = globalThis.__traceSink
      T.events = []; T.on = true; T.done = null
      await c.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: TRACE_CATS } })
      await sleep(50)
      traceAlign = await run(`(()=>{const t=performance.now();performance.mark('__flipAlign');if(window.__paintProbe)window.__paintProbe.marks=true;return t})()`)
    }
    const before = await run(`(()=>{const F=window.__flip;F.arm0&&F.arm0();F.frames.length=0;F.res.length=0;F.keys.length=0;F.dom.length=0;F.long.length=0;return {sig:F.sigOf(F.chart),sig2:F.chart2?F.sigOf(F.chart2):null,sig3:F.chart3?F.sigOf(F.chart3):null,now:performance.now()}})()`)
    const profiling = PROFILE_FLIPS.has(i)
    if (profiling) { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 100 }); await c.send('Profiler.start') }
    // --autorepeat=1: a HELD key, as the OS sends it: the first press, then auto-repeated key-downs
    // (`repeat: true` in the page), and ONE key-up after the last (or before a direction change).
    if (CADENCE && cadSleepEnd != null) cadOverhead = 0.7 * cadOverhead + 0.3 * Math.max(0, Date.now() - cadSleepEnd)
    const keyAt = Date.now()
    const firstOfKey = i === 0 || (UPDOWN === 'downup' && i === FLIPS)
    const lastOfKey = i === total - 1 || (UPDOWN === 'downup' && i === FLIPS - 1)
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: K.key, code: K.key, windowsVirtualKeyCode: K.vk, nativeVirtualKeyCode: K.vk, ...(AUTOREPEAT && !firstOfKey ? { autoRepeat: true } : {}) })
    if (!AUTOREPEAT || lastOfKey) await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: K.key, code: K.key, windowsVirtualKeyCode: K.vk, nativeVirtualKeyCode: K.vk })
    if (profiling) {
      await sleep(700)
      const { profile } = await c.send('Profiler.stop')
      writeFileSync(OUT.replace(/\.json$/, '') + `.flip${i}.cpuprofile`, JSON.stringify(profile))
      await sleep(Math.max(0, DWELL - 700))
    } else if (LAST_DWELL > 0 && i === total - 1) await sleep(LAST_DWELL)
    else if (CADENCE) { await sleep(Math.max(0, keyAt + CADENCE - Date.now() - cadOverhead)); cadSleepEnd = Date.now() }
    else await sleep(DWELL)
    if (tracing) {
      const T = globalThis.__traceSink
      await run(`(()=>{if(window.__paintProbe)window.__paintProbe.marks=false;return true})()`)
      const fin = new Promise((r) => { T.done = r })
      await c.send('Tracing.end')
      await Promise.race([fin, sleep(30000)])
      T.on = false
      writeFileSync(OUT.replace(/\.json$/, '') + `.flip${i}.trace.json`, JSON.stringify({ traceEvents: T.events }))
      T.events = []
    }
    const got = await run(`(()=>{const F=window.__flip;const sel=document.querySelector('[data-watch-sym][aria-selected="true"],[data-watch-sym][data-selected="true"],[data-watch-sym][class*="listRowSelected"]');return {key:F.keys[0]||null,frames:F.frames.slice(),res:F.res.slice(),dom:F.dom.slice(),long:F.long.slice(),end:F.sigOf(F.chart),end2:F.chart2?F.sigOf(F.chart2):null,end3:F.chart3?F.sigOf(F.chart3):null,sym:sel?sel.getAttribute('data-watch-sym'):null,title:document.title,...(F.take?F.take():{})}})()`)
    if (SOAK_EVERY) {
      // slim (a long soak's full res/dom/long would be rewritten on every save)
      out.flips.push({ i, dir: K.key, before: before.sig, before2: before.sig2, before3: before.sig3, key: got.key, frames: got.frames, end: got.end, end2: got.end2, end3: got.end3, sym: got.sym, paints: got.paints, evt: got.evt, busy: got.busy, busyFrom: got.busyFrom, busyEnd: got.busyEnd })
      if ((i + 1) % SOAK_EVERY === 0 || i === total - 1) await soakSample(i + 1)
    } else {
      out.flips.push({ i, dir: K.key, before: before.sig, before2: before.sig2, before3: before.sig3, ...got, ...(traceAlign != null ? { traceAlign } : {}) })
      save()
    }
  }
  // (--heap-ends) the closing reading: after the last flip of any pattern (a soak has just taken it)
  if (HEAP_ENDS && !(SOAK_EVERY && total)) await soakSample(UPDOWN === 'typed' ? TYPED.length : UPDOWN === 'jump' ? FLIPS : total)
  out.sampleErrs = await run(`(window.__flip && window.__flip.sampleErrs) || 0`)
  // --tfs=1W,1D,1W: after the flips, switch the chart's timeframe through these (the labels of the
  // buttons in its timeframe bar), one per dwell, recorded exactly like a flip into <out>.tf.json
  // so the same reports read it: do the indicators arrive with the candles on a timeframe switch?
  // --peek=<js expression>: evaluated in the page after the flips (and again after the timeframe
  // switches), the JSON-able result kept as out.peek / out.peekAfterTfs. For asking the page what
  // it holds at the moment that matters (a storage key, a counter an override chunk keeps).
  out.allRes = await run(`performance.getEntriesByType('resource').filter((e)=>e.name.indexOf('/api/')>=0).map((e)=>({u:e.name.replace(location.origin,''),s:Math.round(e.startTime),e:Math.round(e.responseEnd),ttfb:Math.round(e.responseStart-e.startTime),st:(e.serverTiming||[]).map((x)=>x.name+(x.description?'('+x.description+')':'')+'='+Math.round(x.duration)).join(',')}))`)
  save()
  if (out.idbtrace) {
    out.idbTrace = await run(`(()=>{const T=window.__idbTrace;return T?{tx:T.tx,req:T.req}:null})()`)
    save()
  }
  const PEEK = arg('peek', '')
  const peek = async () => { try { return await run(`(()=>{try{return JSON.parse(JSON.stringify(${PEEK}))}catch(e){return 'peek threw: '+e.message}})()`) } catch (e) { return `peek failed: ${e.message}` } }
  if (PEEK) { out.peek = await peek(); save() }
  // --act=<js expression, may be a promise>: evaluated in the page after the flips and AWAITED,
  // the JSON-able result kept as out.act. For doing something to the chart that takes time to
  // answer (zoom out, wait for the repaint, read what the series hold now).
  // (--act=@<file> reads the expression from a file: a long one does not survive a shell's quoting)
  const actArg = arg('act', '')
  const ACT = actArg.startsWith('@') ? readFileSync(actArg.slice(1), 'utf8').trim() : actArg
  if (ACT) {
    try { out.act = await run(`(async()=>{try{return JSON.parse(JSON.stringify(await (${ACT})))}catch(e){return 'act threw: '+e.message}})()`) } catch (e) { out.act = `act failed: ${e.message}` }
    save()
  }
  const TFS = arg('tfs', '').split(',').filter(Boolean)
  if (TFS.length) {
    const tfOut = { ...out, flips: [], tfSwitches: TFS }
    for (let i = 0; i < TFS.length; i++) {
      const before = await run(`(()=>{const F=window.__flip;F.arm0&&F.arm0();F.frames.length=0;F.res.length=0;F.keys.length=0;F.dom.length=0;F.long.length=0;return {sig:F.sigOf(F.chart),sig2:F.chart2?F.sigOf(F.chart2):null,sig3:F.chart3?F.sigOf(F.chart3):null,now:performance.now()}})()`)
      const clicked = await run(`(()=>{const w=document.querySelector('[data-widget-id="flip-chart"]');const b=[...w.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(TFS[i])});if(!b)return null;const t=performance.now();b.click();return t})()`, true)
      if (clicked == null) {
        const have = await run(`(()=>{const w=document.querySelector('[data-widget-id="flip-chart"]');return w?[...w.querySelectorAll('button')].map(x=>x.textContent.trim()).filter(t=>t&&t.length<=4).join(' '):'no chart widget'})()`)
        throw new Error(`no timeframe button labelled ${TFS[i]} in the chart's bar (short button labels there: ${have})`)
      }
      await sleep(DWELL)
      const got = await run(`(()=>{const F=window.__flip;return {frames:F.frames.slice(),res:F.res.slice(),dom:F.dom.slice(),long:F.long.slice(),end:F.sigOf(F.chart),end2:F.chart2?F.sigOf(F.chart2):null,end3:F.chart3?F.sigOf(F.chart3):null,title:document.title,...(F.take?F.take():{})}})()`)
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
  out.machine = machine.stop()
  console.log(`machine: ${out.machine.cores} cores, system CPU median ${out.machine.cpuMedPct}% (p90 ${out.machine.cpuP90Pct}%), others ~${out.machine.othersCores} cores, free RAM min ${out.machine.freeMinMB} MB${out.machine.underLoad ? ' -- UNDER LOAD: ' + out.machine.why.join('; ') : ''}`)
  save()
  // --graceful-close: the browser quits on its own (and writes its pending localStorage) before the kill
  await app.close({ graceful: !!arg('graceful-close', '') })
}
process.exit(exitCode)
