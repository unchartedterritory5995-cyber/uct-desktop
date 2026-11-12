// All-day soak (speed plan 5.2): the real app left open through a trading day, as a member would,
// sampled once a minute so a slow leak, a chart that silently stops updating, a crash or a creeping
// slowdown is seen before members feel it.
//
// Board: 4 chart widgets on the bench account (SPY daily, NVDA 1m, QQQ 5m, AAPL 15m), two of them popped
// out into their own windows (the member path). The board is applied through /api/workspace/doc/apply
// and ALWAYS restored to the recorded version at the end, even after a failure.
//
// Every minute: memory of every app process (working set, private), CPU share, each window's JS heap and
// DOM size, and each chart's newest candle (time + close, from the site's read-only
// __uctChartDebug[...].newestBar(); site >= the commit that added it). Every 5 minutes: a 10 s frame
// sample per window. Throughout: renderer crashes, page reloads, uncaught errors.
// Liveness during regular hours (09:30-16:00 ET): an intraday chart is STALE when its newest candle is
// older than its timeframe + 2 minutes; the daily chart is QUIET when its close has not moved for 5 min.
//
// Usage: node scripts/proofs/soak.mjs [--until=16:15] [--hours=N] [--display=2] [--sample-s=60]
// Output: proof-output/soak-<date>.jsonl (one line per sample) and soak-<date>-summary.json (rewritten
// every 30 minutes and at the end). Signs in from BENCH_EMAIL / BENCH_PASSWORD (never printed).
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect, sleep, startApp, topHalf } from './launch.mjs'

const arg = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${dflt}`).split('=').slice(1).join('=')
const PORT = 9370
const OUT = 'proof-output'
const SAMPLE_MS = Number(arg('sample-s', 60)) * 1000
const FRAME_EVERY = 5 // samples
// Display 2 (the portrait monitor, Discord) by owner's leave 2026-11-11: only its TOP half, so the newest
// Discord messages and the message box at the bottom stay visible. Never a trading display.
const displayIndex = Number(arg('display', 2))
const POP = '[aria-label="Pop out widget"]'
mkdirSync(OUT, { recursive: true })

const etParts = (d = new Date()) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d).map((p) => [p.type, p.value]))
const etMinutes = (d = new Date()) => { const p = etParts(d); return Number(p.hour) % 24 * 60 + Number(p.minute) }
const isRegularHours = (d = new Date()) => { const p = etParts(d); const m = etMinutes(d); return !['Sat', 'Sun'].includes(p.weekday) && m >= 570 && m < 960 }
const day = (() => { const p = etParts(); return `${p.year}-${p.month}-${p.day}` })()
const [untilH, untilM] = arg('until', '16:15').split(':').map(Number)
const hours = Number(arg('hours', 0))
const endAt = hours ? Date.now() + hours * 3600_000 : Date.now() + Math.max(0, (untilH * 60 + untilM - etMinutes()) * 60_000)
if (endAt <= Date.now() + 60_000) throw new Error('nothing to soak: the end time has passed (use --hours=N)')

const others = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts[\\\\/]proofs' -and $_.CommandLine -notmatch 'deploy-watch' -and $_.ProcessId -ne ${process.pid} }).Count`], { encoding: 'utf8' }).trim()
if (Number(others) > 0) throw new Error(`${others} other proof process(es) running: one measurement at a time`)
const display = JSON.parse(readFileSync(join(OUT, 'displays.json'), 'utf8'))[displayIndex]
if (!display) throw new Error(`no display ${displayIndex}`)

const CHARTS = [
  { id: 'soak-spy', sym: 'SPY', tf: 'D', x: 0, y: 0 },
  { id: 'soak-nvda', sym: 'NVDA', tf: '1', x: 12, y: 0 },
  { id: 'soak-qqq', sym: 'QQQ', tf: '5', x: 0, y: 10 },
  { id: 'soak-aapl', sym: 'AAPL', tf: '15', x: 12, y: 10 },
]
/** Now as New York wall-clock time, expressed as UTC epoch seconds (the charts' bar-time clock). */
function etWallSeconds(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now).map((x) => [x.type, x.value]))
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) / 1000
}

const layout = { widgets: CHARTS.map((c) => ({ id: c.id, type: 'chart', color: 'N', x: c.x, y: c.y, w: 12, h: 10, opts: { tf: c.tf } })), cols: 24, version: 1 }
const groups = { A: 'SPY', B: null, C: null, D: null, ...Object.fromEntries(CHARTS.map((c) => [`N:${c.id}`, c.sym])) }
const tfSeconds = { 1: 60, 5: 300, 15: 900 }

const samplesFile = join(OUT, `soak-${day}.jsonl`)
const summaryFile = join(OUT, `soak-${day}-summary.json`)
const events = { crashes: [], reloads: [], errors: 0, errorSamples: [], appExit: null }

const evalIn = async (s, expression) => {
  const r = await s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const watch = (s, name) => {
  s.on((m) => {
    if (m.method === 'Inspector.targetCrashed') events.crashes.push({ at: new Date().toISOString(), window: name })
    if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) events.reloads.push({ at: new Date().toISOString(), window: name })
    if (m.method === 'Runtime.exceptionThrown') {
      events.errors++
      if (events.errorSamples.length < 20) events.errorSamples.push({ at: new Date().toISOString(), window: name, text: String(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || '').split('\n')[0].slice(0, 200) })
    }
  })
}

// In each window: long-task total since the soak began, heap, DOM size, every chart's newest candle.
const INSTALL = `(()=>{if(!window.__soak){window.__soak={longMs:0,longTasks:0};try{new PerformanceObserver(l=>{for(const e of l.getEntries()){window.__soak.longMs+=e.duration;window.__soak.longTasks++}}).observe({type:'longtask',buffered:false})}catch{}}return true})()`
const READ = `(()=>{const d=window.__uctChartDebug||{};const charts={};for(const [k,v] of Object.entries(d)){try{charts[k]=v.newestBar?v.newestBar():'no-probe'}catch{charts[k]=null}}
  return {visible:document.visibilityState,heapMb:performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):null,dom:document.getElementsByTagName('*').length,
  longMs:Math.round(window.__soak?.longMs||0),longTasks:window.__soak?.longTasks||0,charts}})()`
const FRAMES = `new Promise(r=>{const t=[];let last=performance.now();const end=last+10000;const f=n=>{t.push(n-last);last=n;if(n<end)requestAnimationFrame(f);else{t.sort((a,b)=>a-b);const q=p=>t.length?Math.round(t[Math.min(t.length-1,Math.floor(t.length*p))]):null;r({frames:t.length,p95:q(.95),p99:q(.99),over50:t.filter(x=>x>50).length})}};requestAnimationFrame(f);setTimeout(()=>r({frames:t.length,p95:null,p99:null,over50:null,undrawn:true}),15000)})`

function processTree(rootPid) {
  const script = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime
$ids = @{${rootPid}=1}; $changed = $true
while ($changed) { $changed = $false; foreach ($p in $all) { if ($ids.ContainsKey([int]$p.ParentProcessId) -and -not $ids.ContainsKey([int]$p.ProcessId)) { $ids[[int]$p.ProcessId] = 1; $changed = $true } } }
$mine = $all | Where-Object { $ids.ContainsKey([int]$_.ProcessId) }
"{0} {1} {2} {3}" -f @($mine).Count, [math]::Round(($mine | Measure-Object WorkingSetSize -Sum).Sum/1MB), [math]::Round(($mine | Measure-Object PrivatePageCount -Sum).Sum/1MB), [math]::Round((($mine | Measure-Object KernelModeTime -Sum).Sum + ($mine | Measure-Object UserModeTime -Sum).Sum)/10000)`
  const [count, wsMb, privMb, cpuMs] = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim().split(/\s+/).map(Number)
  return { count, wsMb, privMb, cpuMs }
}

const chartState = {} // id -> { lastClose, lastChangeAt, staleMinutes, quietMinutes, missing }
function judgeCharts(charts, now) {
  const rth = isRegularHours(now)
  const out = {}
  for (const c of CHARTS) {
    const key = Object.keys(charts).find((k) => k.includes(c.id)) // chartId is derived from the widget id
    const bar = key ? charts[key] : undefined
    const st = (chartState[c.id] ||= { lastClose: null, lastChangeAt: now.getTime(), staleMinutes: 0, quietMinutes: 0, missing: 0 })
    if (!bar || bar === 'no-probe') { st.missing++; out[c.id] = { missing: true }; continue }
    if (bar.close !== st.lastClose) { st.lastClose = bar.close; st.lastChangeAt = now.getTime() }
    const row = { time: bar.time, close: bar.close }
    if (c.tf !== 'D' && typeof bar.time === 'number') {
      // The charts store intraday bar times as New York WALL CLOCK written as UTC seconds (so the
      // axis reads ET). Comparing them to real UTC read every bar as ~5 h old: the 2026-11-12
      // market day reported 1m/5m/15m charts "NOT LIVE" all session while each sample's bar
      // advanced. Age is measured on the same clock the bar uses.
      row.ageS = Math.round(etWallSeconds(now) - bar.time)
      if (rth && row.ageS > tfSeconds[c.tf] + 120) { row.stale = true; st.staleMinutes += SAMPLE_MS / 60000 }
    }
    if (c.tf === 'D' && rth && now.getTime() - st.lastChangeAt > 300_000) { row.quiet = true; st.quietMinutes += SAMPLE_MS / 60000 }
    out[c.id] = row
  }
  return out
}

let samples = []
function writeSummary(final) {
  const first = samples.find((s) => s.proc)
  const last = [...samples].reverse().find((s) => s.proc)
  const hoursRun = first && last ? (Date.parse(last.at) - Date.parse(first.at)) / 3600_000 : 0
  const frames = samples.flatMap((s) => (s.frames || []).filter((f) => f.p95 != null))
  const worst = (k) => (frames.length ? Math.max(...frames.map((f) => f[k])) : null)
  const summary = {
    day, final, startedUtc: samples[0]?.at, lastSampleUtc: last?.at, samples: samples.length, hoursRun: Math.round(hoursRun * 100) / 100,
    memory: first && last ? { startWsMb: first.proc.wsMb, endWsMb: last.proc.wsMb, peakWsMb: Math.max(...samples.filter((s) => s.proc).map((s) => s.proc.wsMb)),
      startPrivMb: first.proc.privMb, endPrivMb: last.proc.privMb, privMbPerHour: hoursRun > 0.5 ? Math.round((last.proc.privMb - first.proc.privMb) / hoursRun) : null } : null,
    cpuPctOfOneCore: first && last && hoursRun > 0 ? Math.round((last.proc.cpuMs - first.proc.cpuMs) / (hoursRun * 3600_000) * 100) : null,
    frames: { samples: frames.length, worstP95: worst('p95'), worstP99: worst('p99'), undrawnSamples: samples.flatMap((s) => s.frames || []).filter((f) => f.undrawn).length },
    charts: Object.fromEntries(Object.entries(chartState).map(([k, v]) => [k, { staleMinutes: v.staleMinutes, quietMinutes: v.quietMinutes, missingSamples: v.missing }])),
    crashes: events.crashes, reloads: events.reloads.length, errors: events.errors, errorSamples: events.errorSamples, appExit: events.appExit,
  }
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2))
  return summary
}

let app
let board
let originalVersion = null
let exitCode = 0
try {
  app = await startApp('electron', PORT, [], { signIn: true, bounds: { ...topHalf(display), height: Math.min(720, Math.floor(display.h / 2) - 300) } })
  const { c, run, waitFor } = app
  // Top half of the display: main window across the top, the two pop-outs side by side beneath it.
  const half = Math.floor(display.h / 2)
  const mainH = Math.min(720, half - 300)
  app.placeMainWindow(display.x, display.y, Math.min(display.w, 1500), mainH)
  board = {
    head: () => run(`fetch('/api/workspace/doc?board=charts',{credentials:'include'}).then(r=>r.json()).then(j=>j.version)`),
    apply: (base) => {
      const body = JSON.stringify({ base_version: base, board: 'charts', prefs: { charts_workspace_layout: JSON.stringify(layout), charts_workspace_groups: JSON.stringify(groups) } })
      return run(`fetch('/api/workspace/doc/apply',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(body)}}).then(r=>r.status)`)
    },
    restore: (version, base) => run(`fetch('/api/workspace/doc/restore',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:${version},base_version:${base},board:'charts'})}).then(r=>r.status)`),
  }
  originalVersion = await board.head()
  const applied = await board.apply(originalVersion)
  if (applied !== 200) throw new Error(`soak board refused: ${applied}`)
  await app.charts()
  await waitFor(`document.querySelectorAll('${POP}').length >= ${CHARTS.length}`, 90000)
  await sleep(8000)
  // Pop out two widgets (the last button each time), as a member would; the other two stay on the board.
  for (let i = 0; i < 2; i++) {
    const ok = await run(`(()=>{const b=document.querySelectorAll('${POP}');const x=b[b.length-1];if(!x)return false;x.click();return true})()`, true)
    if (!ok) throw new Error('no pop-out button')
    await sleep(2000)
  }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const pops = list.filter((t) => t.type === 'page' && (t.url === 'about:blank' || t.url === ''))
  const windows = [{ name: 'main', s: c }]
  for (const [i, t] of pops.entries()) windows.push({ name: `popout-${i + 1}`, s: await connect(t.webSocketDebuggerUrl) })
  for (const [i, w] of windows.entries()) {
    await w.s.send('Runtime.enable').catch(() => {})
    await w.s.send('Page.enable').catch(() => {})
    await w.s.send('Inspector.enable').catch(() => {})
    watch(w.s, w.name)
    if (i > 0) {
      const popW = Math.floor(Math.min(display.w, 1500) / 2)
      await evalIn(w.s, `(()=>{try{moveTo(${display.x + (i - 1) * popW},${display.y + mainH + 10});resizeTo(${popW},${half - mainH - 10})}catch{}return true})()`)
    }
  }
  // Pop-outs render in the main page's renderer: their charts appear in the main window's debug map.
  for (const w of windows) await evalIn(w.s, INSTALL).catch(() => {})
  console.log(`soak running until ${new Date(endAt).toISOString()} with ${windows.length} windows; samples -> ${samplesFile}`)

  let n = 0
  let lastSummary = Date.now()
  while (Date.now() < endAt) {
    if (app.exited()) { events.appExit = app.exited(); throw new Error('the app exited') }
    const now = new Date()
    const row = { at: now.toISOString(), rth: isRegularHours(now) }
    try { row.proc = processTree(app.child.pid) } catch (e) { row.procError = String(e.message).slice(0, 100) }
    row.windows = {}
    let allCharts = {}
    for (const w of windows) {
      try { const r = await evalIn(w.s, READ); allCharts = { ...allCharts, ...r.charts }; delete r.charts; row.windows[w.name] = r } catch (e) { row.windows[w.name] = { error: String(e.message).slice(0, 100) } }
    }
    row.charts = judgeCharts(allCharts, now)
    if (n % FRAME_EVERY === 0) {
      row.frames = []
      for (const w of windows) row.frames.push({ window: w.name, ...(await evalIn(w.s, FRAMES).catch((e) => ({ error: String(e.message).slice(0, 80) }))) })
    }
    samples.push(row)
    appendFileSync(samplesFile, JSON.stringify(row) + '\n')
    if (Date.now() - lastSummary > 30 * 60_000) { writeSummary(false); lastSummary = Date.now() }
    n++
    const stale = Object.entries(row.charts).filter(([, v]) => v.stale || v.quiet || v.missing).map(([k]) => k)
    console.log(`${row.at.slice(11, 16)}Z ws ${row.proc?.wsMb ?? '?'} MB priv ${row.proc?.privMb ?? '?'} MB | errors ${events.errors} crashes ${events.crashes.length} reloads ${events.reloads.length}${stale.length ? ` | NOT LIVE: ${stale.join(',')}` : ''}`)
    await sleep(Math.max(1000, SAMPLE_MS - (Date.now() - now.getTime())))
  }
} catch (e) {
  exitCode = 1
  console.log(`soak stopped: ${String(e.message).split('\n')[0]}`)
  events.stopped = String(e.message).split('\n')[0].slice(0, 300)
} finally {
  if (board && originalVersion !== null) {
    try {
      const head = await board.head()
      console.log(`board restore: ${head === originalVersion ? 'unchanged' : await board.restore(originalVersion, head)}`)
    } catch (e) {
      console.log(`board restore FAILED: restore version ${originalVersion} by hand (${String(e.message).slice(0, 100)})`)
      exitCode = 1
    }
  }
  const s = writeSummary(true)
  console.log(JSON.stringify(s, null, 2))
  if (app) await app.close()
  process.exit(exitCode)
}
