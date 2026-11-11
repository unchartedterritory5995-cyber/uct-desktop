// Starts the real app with only a debugging port, in a throwaway profile, and signs in over plain
// DevTools protocol. Playwright is not used here because its launch switches and focus emulation
// would falsify popup, background and load measurements.
// Signs in from BENCH_EMAIL / BENCH_PASSWORD, never printed. Sends no OS keys or clicks; the only
// OS call minimizes and restores the window this run started.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const BASE = 'https://uctintelligence.com'
export const MENU = '[data-guide="workspace.layoutsMenuBtn"]'
export const CHILD_TITLE = 'proof-child'
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const COMMAND_TIMEOUT_MS = 300000

// A leftover app on this port would answer in place of the one this run starts.
async function refuseBusyPort(port) {
  const answered = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)
  if (answered) throw new Error(`port ${port} is already in use`)
}

export function connect(url) {
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
    ws.onclose = () => {
      for (const p of pending.values()) p.no(new Error('debug socket closed'))
      pending.clear()
    }
    ws.onopen = () =>
      ok({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const callId = ++id
            const timer = setTimeout(() => {
              pending.delete(callId)
              rej(new Error(`${method} timed out`))
            }, COMMAND_TIMEOUT_MS)
            const settle = (fn) => (v) => {
              clearTimeout(timer)
              fn(v)
            }
            pending.set(callId, { ok: settle(res), no: settle(rej) })
            ws.send(JSON.stringify({ id: callId, method, params }))
          }),
        on: (l) => listeners.push(l),
      })
  })
}

export async function startApp(target, port, extraArgs = [], options = {}) {
  await refuseBusyPort(port)
  const profile = options.profile ?? mkdtempSync(join(tmpdir(), `uct-clean-${target}-`))
  const signIn = options.signIn ?? true
  const exe =
    target === 'electron'
      ? process.env.UCT_PROOF_EXE || resolve('release', 'win-unpacked', 'UCT Intelligence.exe')
      : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  const args = [...(process.env.UCT_PROOF_APP ? [process.env.UCT_PROOF_APP] : []), `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, ...extraArgs]
  if (target === 'chrome') args.push(`--app=${BASE}/`, '--window-size=1500,950', '--no-first-run', '--no-default-browser-check')
  const child = spawn(exe, args, { stdio: 'ignore' })
  let exit = null
  child.on('exit', (code, signal) => { exit = { code, signal, at: new Date().toISOString() } })

  function cleanup() {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* already gone */ }
  }

  // Finds this run's own top-level window, never one that belongs to another process.
  function showMainWindow(command) {
    const script = `
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class W {
  public struct R { public int L, T, X, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  public delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E e, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
# Every window's title is forced to the app name, so the main window is the largest one.
$script:best = [IntPtr]::Zero; $script:bestArea = 0
[W]::EnumWindows({ param($h, $l)
  $p = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq ${child.pid} -and [W]::IsWindowVisible($h)) {
    $r = New-Object W+R; [void][W]::GetWindowRect($h, [ref]$r); $area = ($r.X - $r.L) * ($r.B - $r.T)
    if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:best = $h }
  }
  $true }, [IntPtr]::Zero) | Out-Null
$hits = @(); if ($script:bestArea -gt 0) { $hits = @($script:best) }
foreach ($h in $hits) { [void][W]::ShowWindow($h, ${command}) }
Start-Sleep -Milliseconds 400
$wantIconic = ${command === 6 ? '$true' : '$false'}
@($hits | Where-Object { [W]::IsIconic($_) -eq $wantIconic }).Count`
    return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim())
  }

  // Moves this run's main window (largest visible window of the child process) to x,y with size w,h.
  // A window under a full-screen window on another app is not drawn at all (no frames, no rAF), so
  // every measurement must put its window on a display the owner is not covering.
  function placeMainWindow(x, y, w, h) {
    const script = `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class M {
  public struct R { public int L, T, X, B; }
  public delegate bool E(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(E e, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
}
'@
$script:best = [IntPtr]::Zero; $script:bestArea = 0
[M]::EnumWindows({ param($h, $l)
  $p = 0; [void][M]::GetWindowThreadProcessId($h, [ref]$p)
  if ($p -eq ${child.pid} -and [M]::IsWindowVisible($h)) {
    $r = New-Object M+R; [void][M]::GetWindowRect($h, [ref]$r); $area = ($r.X - $r.L) * ($r.B - $r.T)
    if ($area -gt $script:bestArea) { $script:bestArea = $area; $script:best = $h }
  }
  $true }, [IntPtr]::Zero) | Out-Null
if ($script:bestArea -gt 0) { [void][M]::ShowWindow($script:best, 9); [void][M]::MoveWindow($script:best, ${x}, ${y}, ${w}, ${h}, $true); 1 } else { 0 }`
    return Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim())
  }

  async function findPage() {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const hit = list.find((t) => t.type === 'page' && t.url.startsWith(BASE))
        if (hit) return hit
      } catch { /* not up yet */ }
      await sleep(500)
    }
    throw new Error('app page did not appear')
  }

  const close = async ({ keepProfile = false } = {}) => {
    cleanup()
    await sleep(2500)
    if (keepProfile || options.profile) return
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* left in temp */ }
  }
  async function boot() {
    const pageTarget = await findPage()
    const c = await connect(pageTarget.webSocketDebuggerUrl)
    await c.send('Runtime.enable')
    await c.send('Page.enable')
    await c.send('Network.enable')

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

    await waitFor(`location.origin === '${BASE}' && document.readyState !== 'loading'`, 60000)
    if (signIn) {
      const creds = JSON.stringify({ email: process.env.BENCH_EMAIL, password: process.env.BENCH_PASSWORD })
      const login = await run(`fetch('/api/auth/login',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:${JSON.stringify(creds)}}).then(r=>r.status)`)
      console.log(`sign-in status ${login}`)
      if (login !== 200) throw new Error('sign-in refused')
    }
    return { c, run, waitFor, charts }
  }

  try {
    return { child, showMainWindow, placeMainWindow, close, exited: () => exit, ...(await boot()) }
  } catch (e) {
    await close()
    throw e
  }
}

// A Chromium trace across every process (browser, GPU, renderers), written as JSON for analysis.
export async function recordTrace(port, file, ms) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(v.webSocketDebuggerUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pending = new Map()
  const events = []
  let done
  const complete = new Promise((r) => { done = r })
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
    else if (m.method === 'Tracing.dataCollected') events.push(...m.params.value)
    else if (m.method === 'Tracing.tracingComplete') done()
  })
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
  await send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['toplevel', 'blink', 'cc', 'gpu', 'viz', 'v8', 'renderer.scheduler', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'devtools.timeline', 'benchmark', 'input', 'ipc', 'mojom', 'disabled-by-default-gpu.service', 'disabled-by-default-viz.surface_id_flow'],
    },
  })
  await sleep(ms)
  await send('Tracing.end')
  await Promise.race([complete, sleep(60000)])
  ws.close()
  writeFileSync(file, JSON.stringify({ traceEvents: events }))
}
