// Proof rows that test-tool launch switches would falsify: popup blocking (P2), background
// throttling (P4) and how Cloudflare treats the app (P6).
// Playwright launches with --disable-popup-blocking and the background-throttling switches, and
// turns on focus emulation, which keeps a minimized page "visible". So this runner starts the real
// app with only a debugging port, in a throwaway profile, and speaks plain DevTools protocol.
// Usage: node scripts/proofs/clean-proofs.mjs electron|chrome [--stream]
// Signs in from BENCH_EMAIL / BENCH_PASSWORD, never printed. Sends no OS keys or clicks; the only
// OS call minimizes and restores the window this run started.
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const target = process.argv[2]
const stream = process.argv.includes('--stream')
if (target !== 'electron' && target !== 'chrome') throw new Error('target must be electron or chrome')

const BASE = 'https://uctintelligence.com'
const MENU = '[data-guide="workspace.layoutsMenuBtn"]'
const OUT = 'proof-output'
const PORT = target === 'electron' ? 9333 : 9334
const CHILD_TITLE = 'proof-child'
const STREAM_MS = 30 * 60 * 1000
const SWITCHES_ABSENT = ['--disable-popup-blocking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = {}
const file = join(OUT, `results-clean-${target}.json`)

function rec(name, verdict, detail) {
  results[name] = { verdict, detail }
  writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`[${verdict}] ${name} ${JSON.stringify(detail).slice(0, 500)}`)
}

async function row(name, fn) {
  try {
    await fn()
  } catch (e) {
    rec(name, 'INCONCLUSIVE', { error: String(e.message).split('\n')[0].slice(0, 200) })
  }
}

const profile = mkdtempSync(join(tmpdir(), `uct-clean-${target}-`))
const exe =
  target === 'electron'
    ? resolve('release', 'win-unpacked', 'UCT Intelligence.exe')
    : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`]
if (target === 'chrome') args.push(`--app=${BASE}/`, '--window-size=1500,950', '--no-first-run', '--no-default-browser-check')
const child = spawn(exe, args, { stdio: 'ignore' })

function cleanup() {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
}

// Finds this run's own top-level window, never one that belongs to another process.
function showMainWindow(command) {
  const script = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  public delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E e, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
}
'@
$hits = New-Object System.Collections.ArrayList
[W]::EnumWindows({ param($h, $l)
  $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq ${child.pid} -and [W]::IsWindowVisible($h)) {
    $s = New-Object System.Text.StringBuilder 256; [void][W]::GetWindowText($h, $s, 256)
    if ($s.Length -gt 0 -and $s.ToString() -notlike '*${CHILD_TITLE}*') { [void]$hits.Add($h) }
  }
  $true }, [IntPtr]::Zero) | Out-Null
foreach ($h in $hits) { [void][W]::ShowWindow($h, ${command}) }
$hits.Count`
  return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim())
}

async function findPage() {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const hit = list.find((t) => t.type === 'page' && t.url.startsWith(BASE))
      if (hit) return hit
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error('app page did not appear')
}

function connect(url) {
  return new Promise((ok, no) => {
    const ws = new WebSocket(url)
    let id = 0
    const pending = new Map()
    const listeners = []
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id) {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error) p.no(new Error(m.error.message))
        else p.ok(m.result)
      } else listeners.forEach((l) => l(m))
    }
    ws.onerror = () => no(new Error('debug socket failed'))
    ws.onopen = () =>
      ok({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            pending.set(++id, { ok: res, no: rej })
            ws.send(JSON.stringify({ id, method, params }))
          }),
        on: (l) => listeners.push(l),
      })
  })
}

let exitCode = 0
try {
  const pageTarget = await findPage()
  const c = await connect(pageTarget.webSocketDebuggerUrl)
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  await c.send('Network.enable')

  const seen = []
  c.on((m) => {
    if (m.method !== 'Network.responseReceived') return
    const { url, status, headers } = m.params.response
    if (!url.startsWith(BASE)) return
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    seen.push({ s: status, cf: lower['cf-mitigated'] || '', t: Date.now() })
  })

  const run = async (expression, gesture = false) => {
    const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: gesture })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  const waitFor = async (expression, ms) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      try { if (await run(expression)) return } catch { /* mid navigation */ }
      await sleep(500)
    }
    throw new Error(`timed out waiting for ${expression}`)
  }
  const charts = async () => {
    await c.send('Page.navigate', { url: `${BASE}/charts` })
    await sleep(1500)
    await waitFor(`!!document.querySelector('${MENU}')`, 60000)
  }

  await waitFor(`document.readyState !== 'loading'`, 60000)
  const creds = JSON.stringify({ email: process.env.BENCH_EMAIL, password: process.env.BENCH_PASSWORD })
  const login = await run(`fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(creds)}}).then(r=>r.status)`)
  console.log(`sign-in status ${login}`)
  if (login !== 200) throw new Error('sign-in refused')
  await charts()
  await sleep(9000)
  rec('Launch switches', 'NOTE', { absent: SWITCHES_ABSENT, focusEmulation: false, userAgent: await run('navigator.userAgent') })

  await row('P2 launch restore', async () => {
    const open = (prefix) => `(()=>{const o=[];for(let i=0;i<6;i++)o.push(window.open('','${prefix}'+i,'width=320,height=240,left='+(60+40*i)+',top='+(60+40*i)));const n=o.filter(Boolean).length;o.forEach(w=>w&&w.close());return n})()`
    const noGesture = await run(open('proof-a'))
    await sleep(1500)
    const oneGesture = await run(open('proof-b'), true)
    await sleep(6000)
    rec('P2 launch restore', noGesture === 6 ? 'PASS' : 'FAIL', { noGesture, oneGesture, of: 6 })
  })

  await row('P4 background (after hours)', async () => {
    const opened = await run(`(()=>{const w=window.open('','proof-p4','width=500,height=360,left=240,top=240');window.__child=w;if(w)w.document.title='${CHILD_TITLE}';return !!w})()`, true)
    if (!opened) throw new Error('child window did not open')
    await sleep(1500)
    const start = `(()=>{const w=window.__child;const c=window.__c={childRaf:0,openerRaf:0,tick:0};window.__on=true;
      const a=()=>{if(window.__on){c.childRaf++;w.requestAnimationFrame(a)}};w.requestAnimationFrame(a);
      const b=()=>{if(window.__on){c.openerRaf++;requestAnimationFrame(b)}};requestAnimationFrame(b);
      window.__t=setInterval(()=>{c.tick++},100);return true})()`
    const stop = `(()=>{window.__on=false;clearInterval(window.__t);return {...window.__c,hidden:document.hidden,childHidden:window.__child.document.hidden}})()`
    await run(start)
    await sleep(10000)
    const visible = await run(stop)
    const minimizedWindows = showMainWindow(6)
    if (minimizedWindows !== 1) {
      if (minimizedWindows > 0) showMainWindow(9)
      throw new Error(`expected to minimize 1 window, found ${minimizedWindows}`)
    }
    await sleep(2000)
    await run(start)
    await sleep(10000)
    const minimized = await run(stop)
    showMainWindow(9)
    await sleep(1500)
    await run('window.__child.close()')
    const childKeepsPainting = minimized.childRaf >= visible.childRaf * 0.5
    const openerTimersRun = minimized.tick >= 80
    rec('P4 background (after hours)', childKeepsPainting && openerTimersRun ? 'PASS' : 'FAIL', {
      visible, minimized, childKeepsPainting, openerTimersRun, note: 'minimized only; market-open CPU and memory row not run',
    })
  })

  await row('P6 500 calls', async () => {
    const alerts = await run(`fetch('/api/alerts',{credentials:'include'}).then(r=>({status:r.status,json:(r.headers.get('content-type')||'').includes('json')}))`)
    const r = await run(`(async()=>{const tally={};let cf=0;for(let i=0;i<500;i++){const x=await fetch('/api/auth/me',{credentials:'include'});tally[x.status]=(tally[x.status]||0)+1;if(x.headers.get('cf-mitigated'))cf++;await new Promise(d=>setTimeout(d,250))}return {tally,cf}})()`)
    const ok = alerts.status === 200 && alerts.json && r.cf === 0 && !r.tally[403]
    rec('P6 500 calls', ok ? 'PASS' : 'FAIL', { alerts, ...r })
  })

  if (stream) {
    await row('P6 30-minute stream', async () => {
      const from = Date.now()
      await charts()
      await sleep(STREAM_MS)
      const during = seen.filter((x) => x.t >= from)
      const blocked = during.filter((x) => x.cf || x.s === 403).length
      const me = await run(`fetch('/api/auth/me',{credentials:'include'}).then(r=>r.status)`)
      rec('P6 30-minute stream', blocked === 0 && me === 200 ? 'PASS' : 'FAIL', { minutes: 30, responses: during.length, blocked, authAtEnd: me })
    })
  }
} catch (e) {
  exitCode = 1
  console.log(`run stopped: ${String(e.message).split('\n')[0].slice(0, 200)}`)
} finally {
  cleanup()
  await sleep(2500)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* left in temp */ }
}
process.exit(exitCode)
