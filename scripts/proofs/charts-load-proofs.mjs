// P4 load row on the REAL member path: a Charts workspace board of independent chart widgets, each
// popped out through its own "Pop out widget" button, at 4, 8 and 12 windows. Replaces
// load-proofs.mjs (which opened Terminal price-chart pop-outs, a surface members do not trade on).
//
// The board belongs to the shared synthetic bench account. The script records the board's version,
// applies a test board through /api/workspace/doc/apply, and ALWAYS restores the recorded version
// through /api/workspace/doc/restore at the end, even after a failure.
//
// Usage: node scripts/proofs/charts-load-proofs.mjs electron|chrome [--display=N] [--dry]
// Signs in from BENCH_EMAIL / BENCH_PASSWORD, never printed. Sends no OS keys or mouse input:
// clicks are DevTools-dispatched on the page's own buttons.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { connect, sleep, startApp } from './launch.mjs'

const target = process.argv[2]
if (target !== 'electron' && target !== 'chrome') throw new Error('target must be electron or chrome')
const dry = process.argv.includes('--dry')
const displayIndex = Number((process.argv.find((a) => a.startsWith('--display=')) || '--display=3').split('=')[1])

const OUT = 'proof-output'
const PORT = target === 'electron' ? 9337 : 9338
// --profile=N: pop N widgets, then record a 20 s CPU profile of the page's renderer (every pop-out
// runs there) plus Chromium's own counters, instead of the frame measurement.
const profileArg = process.argv.find((a) => a.startsWith('--profile='))
const PROFILE_N = profileArg ? Number(profileArg.split('=')[1]) : 0
// --quick=N: one step of N widgets, 30 s settle, 60 s measure (for A/B tests such as monitor or GPU).
const quickArg = process.argv.find((a) => a.startsWith('--quick='))
const QUICK_N = quickArg ? Number(quickArg.split('=')[1]) : 0
const STEPS = PROFILE_N ? [PROFILE_N] : QUICK_N ? [QUICK_N] : dry ? [2] : [4, 8, 12]
const SETTLE_MS = dry ? 20000 : QUICK_N ? 30000 : 60000
const MEASURE_MS = dry ? 20000 : QUICK_N ? 60000 : 300000
const SYMBOLS = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'AVGO', 'SPY', 'QQQ', 'IWM']
const WIDTH = 480
const HEIGHT = 360
const COLUMNS = 4
const MIN_FRAMES = 30
const POP = '[aria-label="Pop out widget"]'

mkdirSync(OUT, { recursive: true })
const results = { target, surface: 'charts-widget-popouts', startedUtc: new Date().toISOString(), dry, steps: [] }
const file = join(OUT, `results-charts-load-${target}${dry ? '-dry' : ''}${QUICK_N ? `-quick-d${displayIndex}` : ''}.json`)
const save = () => writeFileSync(file, JSON.stringify(results, null, 2))

// 12 independent ("not linked", colour N) chart widgets on the 24-column, 20-row grid: 4 across, 3 down.
const COUNT = Math.max(...STEPS)
const widgets = SYMBOLS.slice(0, COUNT).map((_, i) => ({
  id: `loadproof-${i}`,
  type: 'chart',
  color: 'N',
  x: (i % 4) * 6,
  y: Math.floor(i / 4) * 6,
  w: 6,
  h: 6,
  opts: { tf: 'D' },
}))
const groups = { A: 'SPY', B: null, C: null, D: null, ...Object.fromEntries(SYMBOLS.slice(0, COUNT).map((s, i) => [`N:loadproof-${i}`, s])) }
const layout = { widgets, cols: 24, version: 1 } // the format the live board uses (read 2026-11-10)

// ---- process accounting (same as load-proofs.mjs) ----
function processTree(rootPid) {
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const all = JSON.parse(raw)
  const kids = new Map()
  for (const p of all) kids.set(p.ParentProcessId, [...(kids.get(p.ParentProcessId) || []), p])
  const tree = new Map()
  const walk = (pid) => {
    for (const p of kids.get(pid) || []) {
      if (!tree.has(p.ProcessId)) {
        tree.set(p.ProcessId, p)
        walk(p.ProcessId)
      }
    }
  }
  const root = all.find((p) => p.ProcessId === rootPid)
  if (root) tree.set(rootPid, root)
  walk(rootPid)
  return tree
}
const cpuTicks = (p) => Number(p.KernelModeTime) + Number(p.UserModeTime)
function usage(before, after, elapsedMs) {
  let ticks = 0
  let workingSet = 0
  let privateBytes = 0
  for (const [pid, p] of after) {
    ticks += cpuTicks(p) - (before.has(pid) ? cpuTicks(before.get(pid)) : 0)
    workingSet += Number(p.WorkingSetSize)
    privateBytes += Number(p.PrivatePageCount)
  }
  const percentOfOneCore = (ticks / 10000 / elapsedMs) * 100
  return {
    processes: after.size,
    percentOfOneCore: Math.round(percentOfOneCore),
    percentOfMachine: Math.round((percentOfOneCore / cpus().length) * 10) / 10,
    workingSetMb: Math.round(workingSet / 1048576),
    privateMb: Math.round(privateBytes / 1048576),
  }
}

// Frame timing per window. The pop-outs are portals: each is its own window (own rAF), all driven by
// the main page's one renderer thread, so the main page is measured too.
const START = `(()=>{const m=window.__m={frames:[],long:0,longMs:0,last:performance.now(),on:true};
  try{window.__o=new PerformanceObserver(l=>{for(const e of l.getEntries()){m.long++;m.longMs+=e.duration}});window.__o.observe({entryTypes:['longtask']})}catch{}
  const f=t=>{if(!m.on)return;m.frames.push(t-m.last);m.last=t;requestAnimationFrame(f)};requestAnimationFrame(f);return true})()`
const STOP = `(()=>{const m=window.__m;m.on=false;try{window.__o.disconnect()}catch{};const s=[...m.frames].sort((a,b)=>a-b);
  return {frames:s.length,p95:s.length>=${MIN_FRAMES}?Math.round(s[Math.floor(s.length*0.95)]):null,
  p99:s.length>=${MIN_FRAMES}?Math.round(s[Math.floor(s.length*0.99)]):null,over50:s.filter(x=>x>50).length,
  longTasks:m.long,longMs:Math.round(m.longMs),
  canvases:document.querySelectorAll('canvas').length,hidden:document.hidden,x:screenX,y:screenY,w:outerWidth,h:outerHeight}})()`

async function evalIn(session, expression) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

// Pop-out windows are blank-document portals; everything else (the site, the title bar) has a URL.
async function popoutTargets() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list.filter((t) => t.type === 'page' && (t.url === 'about:blank' || t.url === ''))
}

async function waitPopouts(count) {
  const deadline = Date.now() + 90000
  let last = []
  while (Date.now() < deadline) {
    last = await popoutTargets()
    if (last.length === count) return last
    await sleep(1000)
  }
  throw new Error(`expected ${count} pop-out windows, saw ${last.length}`)
}

const boardApi = (run) => ({
  head: () => run(`fetch('/api/workspace/doc?board=charts',{credentials:'include'}).then(r=>r.json()).then(j=>j.version)`),
  apply: (base) => {
    const body = JSON.stringify({
      base_version: base,
      board: 'charts',
      prefs: { charts_workspace_layout: JSON.stringify(layout), charts_workspace_groups: JSON.stringify(groups) },
    })
    return run(`fetch('/api/workspace/doc/apply',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(body)}})
      .then(async r=>({status:r.status,body:await r.json().catch(()=>null)}))`)
  },
  restore: (version, base) =>
    run(`fetch('/api/workspace/doc/restore',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({version:${version},base_version:${base},board:'charts'})}).then(r=>r.status)`),
})

// CPU profile of the page's renderer: self time per function (file:line), plus Chromium's counters
// (script, layout, style recalc, task time) over the same window. Answers "where does a frame go".
async function profile(c) {
  const metrics = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  await c.send('Performance.enable')
  await c.send('Profiler.enable')
  await c.send('Profiler.setSamplingInterval', { interval: 500 })
  const m0 = await metrics()
  await c.send('Profiler.start')
  await sleep(20000)
  const { profile: p } = await c.send('Profiler.stop')
  const m1 = await metrics()
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const self = new Map()
  const dt = p.timeDeltas
  for (let i = 0; i < p.samples.length; i++) {
    const n = byId.get(p.samples[i])
    const f = n.callFrame
    const file = (f.url || '').split('/').pop().split('?')[0]
    const key = `${f.functionName || '(anonymous)'} ${file}:${f.lineNumber + 1}`
    self.set(key, (self.get(key) || 0) + (dt[i] || 0))
  }
  const totalUs = [...self.values()].reduce((a, b) => a + b, 0)
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, us]) => ({ fn: k, ms: Math.round(us / 1000), pct: Math.round((us / totalUs) * 1000) / 10 }))
  const d = (k) => Math.round(((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000) / 1000
  const summary = {
    seconds: 20,
    scriptS: d('ScriptDuration'), layoutS: d('LayoutDuration'), styleS: d('RecalcStyleDuration'), taskS: d('TaskDuration'),
    layouts: d('LayoutCount'), styleRecalcs: d('RecalcStyleCount'),
    idlePct: Math.round(((self.get('(idle) :0') || 0) / totalUs) * 1000) / 10,
  }
  return { summary, top }
}

let exitCode = 0
let app
let board
let originalVersion = null
try {
  const display = JSON.parse(readFileSync(join(OUT, 'displays.json'), 'utf8'))[displayIndex]
  if (!display) throw new Error(`no display ${displayIndex}`)
  if (display.w < COLUMNS * WIDTH || display.h < Math.ceil(COUNT / COLUMNS) * HEIGHT) throw new Error('windows do not fit that display')
  app = await startApp(target, PORT, ['--disable-features=CalculateNativeWinOcclusion'])
  const { child, c, run, waitFor, charts } = app
  board = boardApi(run)

  originalVersion = await board.head()
  results.boardVersionBefore = originalVersion
  const applied = await board.apply(originalVersion)
  if (applied.status !== 200) throw new Error(`test board refused: ${applied.status} ${JSON.stringify(applied.body).slice(0, 200)}`)
  results.boardVersionTest = applied.body?.version ?? null
  save()

  await charts()
  await waitFor(`document.querySelectorAll('${POP}').length >= ${COUNT}`, 90000)
  await sleep(9000)
  // How many charts the board itself is drawing before anything pops: if this is 0, the board
  // behind the pop-outs is not part of the load and the opener numbers say nothing about it.
  results.boardCanvasesBeforePop = await run(`document.querySelectorAll('canvas').length`)
  results.boardWidgetsBeforePop = await run(`document.querySelectorAll('${POP}').length`)
  console.log(`board before pop: ${results.boardWidgetsBeforePop} widgets, ${results.boardCanvasesBeforePop} canvases`)
  if (target === 'chrome') await c.send('Browser.grantPermissions', { origin: 'https://uctintelligence.com', permissions: ['windowManagement'] })

  let opened = 0
  for (const count of STEPS) {
    for (; opened < count; opened++) {
      // The popped widget leaves the board, so the next one is always the first button left.
      const ok = await run(`(()=>{const b=document.querySelector('${POP}');if(!b)return false;b.click();return true})()`, true)
      if (!ok) throw new Error(`no pop-out button left for window ${opened}`)
      await sleep(1500)
    }
    const targets = await waitPopouts(count)
    const sessions = []
    for (const t of targets) sessions.push(await connect(t.webSocketDebuggerUrl))
    // Tile them on the measurement display, same layout for both targets.
    for (let i = 0; i < sessions.length; i++) {
      const x = display.x + (i % COLUMNS) * WIDTH
      const y = display.y + Math.floor(i / COLUMNS) * HEIGHT
      await evalIn(sessions[i], `(()=>{try{moveTo(${x},${y});resizeTo(${WIDTH},${HEIGHT})}catch{}return true})()`)
    }
    await sleep(SETTLE_MS)
    if (PROFILE_N) {
      // Redraw rate: every Lightweight Charts repaint clears its canvases first, so clearRect calls
      // per second per window (divided by that window's canvases) is how often its charts redraw.
      const COUNT_JS = `(()=>{const P=CanvasRenderingContext2D.prototype;if(!P.__orig){P.__orig=P.clearRect;window.__clears=0;P.clearRect=function(...a){window.__clears++;return P.__orig.apply(this,a)}}window.__clears=0;return true})()`
      const READ_JS = `({clears:window.__clears,canvases:document.querySelectorAll('canvas').length})`
      for (const s of [c, ...sessions]) await evalIn(s, COUNT_JS)
      await sleep(10000)
      const per = []
      for (const s of [c, ...sessions]) per.push(await evalIn(s, READ_JS))
      results.redraws = per.map((r, i) => ({ window: i === 0 ? 'main' : `popout-${i}`, clearsPerSec: Math.round(r.clears / 10), canvases: r.canvases, redrawsPerCanvasPerSec: r.canvases ? Math.round((r.clears / 10 / r.canvases) * 10) / 10 : null }))
      console.log(`[REDRAWS] ${JSON.stringify(results.redraws)}`)
      results.profile = await profile(c)
      save()
      console.log(`[PROFILE] ${count} widgets: ${JSON.stringify(results.profile.summary)}`)
      break
    }
    for (const s of sessions) await evalIn(s, START)
    await evalIn(c, START)
    const before = processTree(child.pid)
    const t0 = Date.now()
    await sleep(MEASURE_MS)
    const after = processTree(child.pid)
    const elapsed = Date.now() - t0
    const windows = []
    for (const s of sessions) windows.push(await evalIn(s, STOP))
    const opener = await evalIn(c, STOP)
    const p95s = windows.map((w) => w.p95).filter((p) => p !== null).sort((a, b) => a - b)
    const frames = windows.reduce((a, w) => a + w.frames, 0)
    const step = {
      charts: count,
      usage: usage(before, after, elapsed),
      rendered: windows.filter((w) => w.canvases > 0).length,
      painting: p95s.length,
      valid: p95s.length === count && windows.every((w) => w.canvases > 0 && !w.hidden),
      worstP95Ms: p95s[p95s.length - 1],
      medianP95Ms: p95s[Math.floor(p95s.length / 2)],
      worstP99Ms: Math.max(...windows.map((w) => w.p99 ?? 0)),
      framesOver50Pct: frames ? Math.round((windows.reduce((a, w) => a + w.over50, 0) / frames) * 1000) / 10 : null,
      longTasks: windows.reduce((a, w) => a + w.longTasks, 0),
      longMs: windows.reduce((a, w) => a + w.longMs, 0),
      opener,
      windows,
    }
    results.steps.push(step)
    save()
    console.log(`[STEP] ${count} charts ${JSON.stringify({ ...step, windows: undefined })}`)
  }
} catch (e) {
  exitCode = 1
  results.error = String(e.message).split('\n')[0].slice(0, 300)
  console.log(`run stopped: ${results.error}`)
} finally {
  // Put the bench account's board back exactly as it was, whatever happened above.
  if (board && originalVersion !== null) {
    try {
      const head = await board.head()
      const status = head === originalVersion ? 'unchanged' : await board.restore(originalVersion, head)
      results.boardRestore = status
      console.log(`board restore: ${status}`)
    } catch (e) {
      results.boardRestore = `FAILED: ${String(e.message).slice(0, 120)}; restore version ${originalVersion} by hand`
      console.log(results.boardRestore)
      exitCode = 1
    }
  }
  save()
  if (app) await app.close()
}
process.exit(exitCode)
