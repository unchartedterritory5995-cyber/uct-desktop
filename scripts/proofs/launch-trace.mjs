// One launch, watched from the first moment the app answers on its debugging port: every page target, every
// main-frame navigation and every document request, in ms from process start. Answers "what happened
// between starting the page load and the page beginning" when launch-cold.mjs shows a gap.
// Usage: node scripts/proofs/launch-trace.mjs [--n=3] [--display=2] [--profile=<dir>]  (default: the
// signed-in profile launch-cold.mjs keeps). Prints the timeline; nothing is written to the account.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sleep, topHalf } from './launch.mjs'

const arg = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${dflt}`).split('=').slice(1).join('=')
const N = Number(arg('n', 3))
const PORT = 9365
const profile = arg('profile', join(tmpdir(), 'uct-proof-launch-cold'))
const display = JSON.parse(readFileSync(join('proof-output', 'displays.json'), 'utf8'))[Number(arg('display', 2))]
const exe = process.env.UCT_PROOF_EXE || resolve('release', 'win-unpacked', 'UCT Intelligence.exe')
const b = topHalf(display)

for (let run = 1; run <= N; run++) {
  const t0 = performance.now()
  const ms = () => Math.round(performance.now() - t0)
  const env = { ...process.env, UCT_PROOF_WINDOW_BOUNDS: `${b.x},${b.y},${b.width},${b.height}` }
  // --netlog: Chromium's own network log for this launch (proof-output/netlog-<run>.json).
  const netlog = process.argv.includes('--netlog') ? [`--log-net-log=${resolve('proof-output', `netlog-${run}.json`)}`, '--net-log-capture-mode=Default'] : []
  // --switch=<chromium switch> (repeatable): an experiment, e.g. --switch=no-proxy-server.
  const extra = process.argv.filter((a) => a.startsWith('--switch=')).map((a) => `--${a.slice('--switch='.length)}`)
  const child = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, ...netlog, ...extra], { stdio: 'ignore', env })
  const log = []
  const note = (s) => log.push(`${String(ms()).padStart(6)}  ${s}`)
  let ws
  while (ms() < 15000) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
      ws = new WebSocket(v.webSocketDebuggerUrl)
      await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no })
      break
    } catch { await sleep(25) }
  }
  note('debugger connected')
  let id = 0
  const send = (method, params = {}, sessionId) => { const i = ++id; ws.send(JSON.stringify({ id: i, method, params, ...(sessionId && { sessionId }) })); return i }
  const kinds = new Map()
  let reqs = 0
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    const p = m.params || {}
    if (m.method === 'Target.attachedToTarget') {
      const t = p.targetInfo
      kinds.set(p.sessionId, `${t.type}`)
      note(`attached ${t.type} ${t.url.slice(0, 70)}`)
      if (t.type === 'page') {
        for (const md of ['Network.enable', 'Page.enable']) send(md, {}, p.sessionId)
        send('Page.setLifecycleEventsEnabled', { enabled: true }, p.sessionId)
      }
      send('Runtime.runIfWaitingForDebugger', {}, p.sessionId)
    } else if (m.method === 'Target.targetInfoChanged') {
      note(`target ${p.targetInfo.type} now ${p.targetInfo.url.slice(0, 70)}`)
    } else if (m.method === 'Page.frameStartedNavigating' && !p.frameId?.includes('.')) {
      note(`  [${kinds.get(m.sessionId)}] start navigating ${String(p.url).slice(0, 70)} (${p.navigationType || ''})`)
    } else if (m.method === 'Page.frameNavigated' && !p.frame.parentId) {
      note(`  [${kinds.get(m.sessionId)}] NAVIGATED ${p.frame.url.slice(0, 70)} type=${p.type || ''}`)
    } else if (m.method === 'Page.lifecycleEvent' && ['init', 'DOMContentLoaded', 'load', 'firstContentfulPaint'].includes(p.name)) {
      note(`  [${kinds.get(m.sessionId)}] ${p.name}`)
    } else if (m.method === 'Network.requestWillBeSent' && p.type === 'Document') {
      note(`  [${kinds.get(m.sessionId)}] doc request ${p.request.url.slice(0, 70)}${p.redirectResponse ? ` (redirected from ${p.redirectResponse.status})` : ''}`)
    } else if (m.method === 'Network.responseReceived' && p.type === 'Document') {
      note(`  [${kinds.get(m.sessionId)}] doc response ${p.response.status} ${p.response.url.slice(0, 60)} cf-mitigated=${p.response.headers['cf-mitigated'] || '-'} from-cache=${p.response.fromDiskCache}`)
    } else if (m.method === 'Network.loadingFailed' && p.type === 'Document') {
      note(`  [${kinds.get(m.sessionId)}] doc FAILED ${p.errorText} canceled=${p.canceled}`)
    } else if (m.method === 'Network.requestWillBeSent' && p.type !== 'Document' && kinds.get(m.sessionId) === 'page' && !String(p.request.url).startsWith('app-shell') && reqs++ < 12) {
      note(`  [${kinds.get(m.sessionId)}] ${p.request.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 50)}`)
    }
  }
  send('Target.setDiscoverTargets', { discover: true })
  send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await sleep(Number(arg('watch-s', 25)) * 1000)
  // When each of this run's processes started, relative to the main process (Windows' own clock).
  try {
    const rows = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "Name='UCT Intelligence.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' }
$main = ($p | Sort-Object CreationDate | Select-Object -First 1).CreationDate
$p | Sort-Object CreationDate | ForEach-Object { $t = 'main'; if ($_.CommandLine -match '--type=(\S+)') { $t = $Matches[1] }; if ($_.CommandLine -match '--utility-sub-type=(\S+)') { $t += ':' + $Matches[1] }; '{0,6} {1}' -f [int](($_.CreationDate - $main).TotalMilliseconds), $t }`], { encoding: 'utf8' })
    note(`processes (ms after main):\n${rows.trimEnd()}`)
  } catch (e) { note('process list failed') }
  // --end=clean: quit the app the normal way (Browser.close closes every window; the app quits), so the
  // next launch starts after a CLEAN exit. Default: a hard kill (taskkill /F), i.e. an unclean exit.
  const clean = arg('end', 'kill') === 'clean' || (arg('end', 'kill') === 'alternate' && run % 2 === 1)
  if (clean) { send('Browser.close'); await sleep(4000) }
  ws.close()
  console.log(`(launch ${run} ended ${clean ? 'CLEAN' : 'by hard kill'})`)
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
  // Wait until every process of this run has exited (the single-instance lock goes with the last one).
  for (let i = 0; i < 40; i++) {
    const left = execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='UCT Intelligence.exe'" | Where-Object { $_.ExecutablePath -eq '${exe.replace(/'/g, "''")}' }).Count`], { encoding: 'utf8' }).trim()
    if (left === '0') break
    await sleep(500)
  }
  console.log(`\n=== launch ${run}`)
  console.log(log.join('\n'))
  await sleep(3000)
}
