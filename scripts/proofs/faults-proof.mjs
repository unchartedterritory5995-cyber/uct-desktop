// Fault injection on the real app against the live site (speed plan 9.5). Each row breaks one thing on
// purpose and asserts the app recovers by itself, the way a member's machine must:
//   F-renderer  the site's renderer process crashes -> the app reloads it; candles back within 20 s
//   F-gpu       the GPU process is killed -> the window keeps drawing (no reload, no error page) within 10 s
//   F-slow      every request takes 3 s for 60 s -> the page stays responsive, no error page, healthy after
//   F-deploy    the server starts reporting a new build -> the polite "Reload" notice appears, and the page
//               is NOT reloaded under the member (up to 12 min: the watcher needs two polls 5 min apart)
//   F-session   the session expires -> the sign-in page appears within 15 s, never a blank or error page
// Bench member (BENCH_EMAIL / BENCH_PASSWORD, never printed), throwaway profile, the member's own board
// (nothing is written to it). Window on the top half of display 2 unless --display says otherwise.
// Usage: node scripts/proofs/faults-proof.mjs [--display=2] [--only=F-gpu,F-slow] [--skip=F-deploy]
// Prints one `PASS|FAIL <id>: <detail>` line per row (faults-weekly.mjs collects them).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, connect, sleep, startApp, topHalf } from './launch.mjs'

const arg = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${dflt}`).split('=').slice(1).join('=')
const displayIndex = Number(arg('display', 2))
const only = arg('only', '').split(',').filter(Boolean)
const skip = arg('skip', '').split(',').filter(Boolean)
const wanted = (id) => (!only.length || only.includes(id)) && !skip.includes(id)
const PORT = 9380
const MARK = 'uct:first-chart-paint'
const display = JSON.parse(readFileSync(join('proof-output', 'displays.json'), 'utf8'))[displayIndex]
if (!display) throw new Error(`no display ${displayIndex}`)

const rows = []
const row = (id, pass, detail) => { rows.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
// Candles on screen: the site's first-chart mark, or (older site builds) a drawn chart canvas.
const CANDLES = `(performance.getEntriesByName('${MARK}','mark').length>0)||[...document.querySelectorAll('canvas')].some(c=>c.clientWidth>200&&c.clientHeight>100)`
const FRAMES = (ms) => `new Promise(r=>{let n=0;const end=performance.now()+${ms};const f=t=>{n++;if(t<end)requestAnimationFrame(f);else r(n)};requestAnimationFrame(f);setTimeout(()=>r(n),${ms + 3000})})`

const profile = mkdtempSync(join(tmpdir(), 'uct-proof-faults-'))
let app
let s // the current session on the site page (replaced after a renderer crash)
const evalS = async (expression, timeoutMs = 30000) => {
  const r = await Promise.race([
    s.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => { throw new Error(`evaluate timed out after ${timeoutMs} ms`) }),
  ])
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const sitePage = async () => {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  return list.find((t) => t.type === 'page' && t.url.startsWith(BASE))
}
async function attach() {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const t = await sitePage()
      if (t) { s = await connect(t.webSocketDebuggerUrl); await s.send('Runtime.enable'); await s.send('Page.enable'); return }
    } catch { /* coming back */ }
    await sleep(500)
  }
  throw new Error('site page did not come back')
}
async function waitTrue(expression, ms) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try { if (await evalS(expression, 5000)) return Date.now() - t0 } catch { /* navigating */ }
    await sleep(300)
  }
  return null
}
let navigations = 0
const countNavigations = () => s.on((m) => { if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) navigations++ })
const onErrorPage = async () => { try { return !(await evalS('location.origin', 5000)).startsWith(BASE) } catch { return true } }
function blackBoxHas(event) {
  const f = join(profile, 'logs', 'events.log')
  return existsSync(f) && readFileSync(f, 'utf8').split('\n').some((l) => l.includes(`"event":"${event}"`))
}
function gpuPids(rootPid) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine
$ids = @{${rootPid}=1}; $c = $true
while ($c) { $c = $false; foreach ($p in $all) { if ($ids.ContainsKey([int]$p.ParentProcessId) -and -not $ids.ContainsKey([int]$p.ProcessId)) { $ids[[int]$p.ProcessId] = 1; $c = $true } } }
($all | Where-Object { $ids.ContainsKey([int]$_.ProcessId) -and $_.CommandLine -match '--type=gpu-process' } | ForEach-Object { $_.ProcessId }) -join ','`], { encoding: 'utf8' }).trim()
  return out ? out.split(',').map(Number) : []
}

let exitCode = 0
try {
  app = await startApp('electron', PORT, [], { profile, signIn: true, bounds: topHalf(display) })
  await app.charts()
  s = app.c
  countNavigations()
  if (await waitTrue(CANDLES, 45000) == null) throw new Error('no candles on /charts before any fault')
  await sleep(5000)

  if (wanted('F-renderer')) {
    await s.send('Page.crash').catch(() => { /* the session dies with the renderer */ })
    const t0 = Date.now()
    await sleep(1500)
    await attach()
    countNavigations()
    const back = await waitTrue(`location.pathname.startsWith('/charts') && (${CANDLES})`, 20000)
    const ms = back == null ? null : Date.now() - t0
    row('F-renderer', ms != null && ms <= 20000 && blackBoxHas('render-process-gone'),
      ms == null ? 'the site did not come back with candles within 20 s' : `reloaded by the app, candles back ${ms} ms after the crash; black box logged it: ${blackBoxHas('render-process-gone')}`)
    await sleep(5000)
  }

  if (wanted('F-gpu')) {
    const pids = gpuPids(app.child.pid)
    if (!pids.length) row('F-gpu', false, 'no GPU process found under the app')
    else {
      const navBefore = navigations
      for (const pid of pids) { try { execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }
      await sleep(5000)
      const frames = await evalS(FRAMES(5000), 15000).catch(() => 0)
      const err = await onErrorPage()
      const alive = !app.exited()
      row('F-gpu', alive && !err && frames >= 150 && navigations === navBefore,
        `killed GPU process ${pids.join(',')}: app alive ${alive}, ${frames} frames in 5 s after (60 Hz = 300), page reloads ${navigations - navBefore}, error page ${err}`)
    }
    await sleep(3000)
  }

  if (wanted('F-slow')) {
    const navBefore = navigations
    await s.send('Network.enable')
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1 })
    let worstRtt = 0
    for (let i = 0; i < 12; i++) {
      const t = Date.now()
      try { await evalS('1+1', 5000) } catch { worstRtt = 5000 }
      worstRtt = Math.max(worstRtt, Date.now() - t)
      await sleep(5000)
    }
    const errDuring = await onErrorPage()
    await s.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
    await sleep(20000)
    const healthy = await evalS(`fetch('/api/auth/me',{credentials:'include'}).then(r=>r.status)`, 10000).catch(() => 0)
    const errAfter = await onErrorPage()
    row('F-slow', worstRtt < 1000 && !errDuring && !errAfter && healthy === 200,
      `60 s at +3 s per request: page answered within ${worstRtt} ms at worst, error page ${errDuring || errAfter}, sign-in check after ${healthy}, page reloads ${navigations - navBefore}`)
  }

  if (wanted('F-deploy')) {
    const navBefore = navigations
    let rewritten = 0
    s.on(async (m) => {
      if (m.method !== 'Fetch.requestPaused') return
      try {
        const body = await s.send('Fetch.getResponseBody', { requestId: m.params.requestId })
        const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
        const j = JSON.parse(text)
        j.build_id = 'fault-test-new-build'
        rewritten++
        await s.send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: m.params.responseStatusCode || 200,
          responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(j)).toString('base64') })
      } catch {
        await s.send('Fetch.continueRequest', { requestId: m.params.requestId }).catch(() => {})
      }
    })
    await s.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/health*', requestStage: 'Response' }] })
    const ms = await waitTrue(`!!document.querySelector('[data-testid="update-ready-toast"]')`, 12.5 * 60_000)
    await s.send('Fetch.disable').catch(() => {})
    row('F-deploy', ms != null && navigations === navBefore,
      ms == null ? `no update notice within 12.5 min (${rewritten} health answers rewritten)` : `notice shown ${Math.round(ms / 1000)} s after the server began reporting a new build; page reloads under the member ${navigations - navBefore}`)
  }

  if (wanted('F-session')) {
    await s.send('Network.enable')
    await s.send('Network.deleteCookies', { name: 'uct_session', url: BASE })
    await s.send('Page.reload').catch(() => {})
    await sleep(1000)
    const ms = await waitTrue(`location.pathname==='/login' || !!document.querySelector('input[type=password]')`, 15000)
    const err = await onErrorPage()
    const blank = await evalS(`document.body && document.body.innerText.trim().length < 20`, 5000).catch(() => true)
    row('F-session', ms != null && !err && !blank, ms == null ? `no sign-in page within 15 s (error page ${err}, blank ${blank})` : `sign-in page after ${ms} ms, error page ${err}, blank ${blank}`)
  }
} catch (e) {
  row('F-setup', false, String(e.message || e).split('\n')[0].slice(0, 200))
} finally {
  if (app) await app.close()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* left in temp */ }
  const failed = rows.filter((r) => !r.pass).length
  console.log(failed ? `${failed} FAILED` : 'ALL PASS')
  exitCode = failed ? 1 : 0
  process.exit(exitCode)
}
