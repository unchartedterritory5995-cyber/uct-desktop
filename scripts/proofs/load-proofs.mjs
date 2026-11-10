// P4 load row: real Terminal price-chart windows at 4, 8 and 12, in the real app.
// Records, per step, the app's whole process tree (CPU, memory) and each chart window's frame
// timing and long tasks. Run once per target, then compare the two results files.
// Usage: node scripts/proofs/load-proofs.mjs electron|chrome [--display=N] [--dry]
// --display picks the monitor for the chart windows, as an index into proof-output/displays.json.
// --dry is a short rehearsal with 2 windows and is never a result.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { BASE, connect, sleep, startApp } from './launch.mjs'

const target = process.argv[2]
if (target !== 'electron' && target !== 'chrome') throw new Error('target must be electron or chrome')
const dry = process.argv.includes('--dry')
const displayIndex = Number((process.argv.find((a) => a.startsWith('--display=')) || '--display=3').split('=')[1])

const OUT = 'proof-output'
const PORT = target === 'electron' ? 9335 : 9336
const STEPS = dry ? [2] : [4, 8, 12]
const SETTLE_MS = dry ? 20000 : 60000
const MEASURE_MS = dry ? 20000 : 300000
const SYMBOLS = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'AVGO', 'SPY', 'QQQ', 'IWM']
const WIDTH = 480
const HEIGHT = 360
const COLUMNS = 4
const MIN_FRAMES = 30

mkdirSync(OUT, { recursive: true })
const results = { target, startedUtc: new Date().toISOString(), dry, steps: [] }
const file = join(OUT, `results-load-${target}${dry ? '-dry' : ''}.json`)
const save = () => writeFileSync(file, JSON.stringify(results, null, 2))

const token = (symbol) => Buffer.from(JSON.stringify({ c: 'GP', s: symbol, a: [] })).toString('base64url')

function processTree(rootPid) {
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress"],
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

const START = `(()=>{const m=window.__m={frames:[],long:0,longMs:0,last:performance.now(),on:true};
  window.__o=new PerformanceObserver(l=>{for(const e of l.getEntries()){m.long++;m.longMs+=e.duration}});
  window.__o.observe({entryTypes:['longtask']});
  const f=t=>{if(!m.on)return;m.frames.push(t-m.last);m.last=t;requestAnimationFrame(f)};requestAnimationFrame(f);return true})()`
const STOP = `(()=>{const m=window.__m;m.on=false;window.__o.disconnect();const s=[...m.frames].sort((a,b)=>a-b);
  return {frames:s.length,p95:s.length>=${MIN_FRAMES}?Math.round(s[Math.floor(s.length*0.95)]):null,longTasks:m.long,longMs:Math.round(m.longMs),
  canvases:document.querySelectorAll('canvas').length,hidden:document.hidden,x:screenX,y:screenY,w:outerWidth,h:outerHeight}})()`

async function evalIn(session, expression) {
  const r = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}

async function attachCharts(count) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const charts = list.filter((t) => t.type === 'page' && t.url.includes('popout='))
    if (charts.length === count) return charts
    await sleep(1000)
  }
  throw new Error(`expected ${count} chart windows`)
}

let exitCode = 0
let app
try {
  const display = JSON.parse(readFileSync(join(OUT, 'displays.json'), 'utf8'))[displayIndex]
  if (!display) throw new Error(`no display ${displayIndex}`)
  if (display.w < COLUMNS * WIDTH || display.h < Math.ceil(12 / COLUMNS) * HEIGHT) throw new Error('chart windows do not fit that display')
  // Applied equally to both apps: a window covered by something else on the monitor would
  // otherwise report hidden and stop painting, which would measure the desktop, not the app.
  app = await startApp(target, PORT, ['--disable-features=CalculateNativeWinOcclusion'])
  const { child, c, run, charts } = app
  await charts()
  await sleep(9000)

  if (target === 'chrome') {
    await c.send('Browser.grantPermissions', { origin: BASE, permissions: ['windowManagement'] })
    console.log(`screens seen ${await run('window.getScreenDetails().then(s=>s.screens.length)')}`)
  }

  let opened = 0
  for (const count of STEPS) {
    for (; opened < count; opened++) {
      const url = `${BASE}/terminal?popout=${token(SYMBOLS[opened])}`
      const x = display.x + (opened % COLUMNS) * WIDTH
      const y = display.y + Math.floor(opened / COLUMNS) * HEIGHT
      const ok = await run(`!!window.open(${JSON.stringify(url)},'proof-load-${opened}','popup,width=${WIDTH},height=${HEIGHT},left=${x},top=${y}')`, true)
      if (!ok) throw new Error(`window ${opened} did not open`)
      await sleep(1200)
    }
    const targets = await attachCharts(count)
    await sleep(SETTLE_MS)
    const sessions = []
    for (const t of targets) sessions.push(await connect(t.webSocketDebuggerUrl))
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
    const step = {
      charts: count,
      usage: usage(before, after, elapsed),
      rendered: windows.filter((w) => w.canvases > 0).length,
      painting: p95s.length,
      valid: p95s.length === count && windows.every((w) => w.canvases > 0),
      worstP95Ms: p95s[p95s.length - 1],
      medianP95Ms: p95s[Math.floor(p95s.length / 2)],
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
  console.log(`run stopped: ${String(e.message).split('\n')[0].slice(0, 200)}`)
} finally {
  if (app) await app.close()
}
process.exit(exitCode)
