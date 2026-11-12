// A real launch, timed from the moment the process is started to candles on screen, N times.
// Speed plan Step 4.1. Unlike launch-phases.mjs (navigations inside a running app), every run here
// starts a NEW app process on one persistent, signed-in profile, exactly like a member double-clicking
// the icon the next morning. Per run, all in ms from process start:
//   ready / window / shown / loading / domReady / loaded   the app's own black box (`launch-timing`)
//   html        the website's HTML fully arrived (navigation responseEnd)
//   candles     the page's first chart had its bars (the `uct:first-chart-paint` mark; site >= 2097d8a460)
//   api         every /api call that finished before the candles (what the candles waited on)
// Usage: node scripts/proofs/launch-cold.mjs [--n=10] [--display=2] [--exe=path] [--label=name] [--ab=late-show,no-preconnect]
// Signs in once from BENCH_EMAIL / BENCH_PASSWORD (never printed); later runs reuse the profile.
// One measurement at a time: refuses to start while another proof's node process is running.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BASE, sleep, startApp, topHalf } from './launch.mjs'

const arg = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || `--${name}=${dflt}`).split('=').slice(1).join('=')
const N = Number(arg('n', 10))
// Display 2 (portrait, Discord), top half only: owner's leave 2026-11-11. Never a trading display.
const displayIndex = Number(arg('display', 2))
const label = arg('label', 'current')
const exe = arg('exe', '')
if (exe) process.env.UCT_PROOF_EXE = resolve(exe)
// --ab=late-show,no-preconnect turns the launch improvements off (the app honours it only in a debug run).
const ab = arg('ab', '')
if (ab) process.env.UCT_PROOF_AB = ab
const PORT = 9360
const OUT = 'proof-output'
const MARK = 'uct:first-chart-paint'
const profile = join(tmpdir(), 'uct-proof-launch-cold')
const signedMarker = join(profile, 'proof-signed-in.json')
mkdirSync(OUT, { recursive: true })

const others = execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'scripts[\\\\/]proofs' -and $_.ProcessId -ne ${process.pid} }).Count`], { encoding: 'utf8' }).trim()
if (Number(others) > 0) throw new Error(`${others} other proof process(es) running: one measurement at a time`)

const display = JSON.parse(readFileSync(join(OUT, 'displays.json'), 'utf8'))[displayIndex]
if (!display) throw new Error(`no display ${displayIndex}`)

const READ = `(() => {
  const n = performance.getEntriesByType('navigation')[0]
  const m = performance.getEntriesByName('${MARK}', 'mark')[0]
  const api = performance.getEntriesByType('resource').filter((r) => r.name.includes('/api/') && m && r.responseEnd <= m.startTime)
    .map((r) => ({ name: r.name.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id'), start: Math.round(r.startTime), end: Math.round(r.responseEnd) }))
  const nt = n ? Object.fromEntries(['domainLookupStart','domainLookupEnd','connectStart','secureConnectionStart','connectEnd','requestStart','firstInterimResponseStart','responseStart','finalResponseHeadersStart','responseEnd'].map((k) => [k, Math.round(n[k] || 0)])) : null
  return { timeOrigin: performance.timeOrigin, path: location.pathname, html: n ? Math.round(n.responseEnd) : null,
    navType: n?.type, navName: n ? new URL(n.name).pathname : null, nt, protocol: n?.nextHopProtocol,
    candles: m ? Math.round(m.startTime) : null, api }
})()`

function lastLaunchTiming() {
  const file = join(profile, 'logs', 'events.log')
  if (!existsSync(file)) return null
  const lines = readFileSync(file, 'utf8').trim().split('\n').reverse()
  for (const l of lines) {
    try { const e = JSON.parse(l); if (e.event === 'launch-timing') return e } catch { /* partial line */ }
  }
  return null
}

// The black box's `launch-navigation` lines for the newest launch: every full load of the site.
function launchNavigations() {
  const file = join(profile, 'logs', 'events.log')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').trim().split(/\r?\n/)
  const out = []
  for (let i = lines.length - 1; i >= 0; i--) {
    let e
    try { e = JSON.parse(lines[i]) } catch { continue }
    if (e.event === 'launch') break
    if (e.event === 'launch-navigation') out.unshift(`${e.path} ${e.code} @${e.ms}`)
  }
  return out
}

const pct = (a, p) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }

// ---- one-time setup: sign in, put the window on the measurement display, let cookies flush ----
if (!existsSync(signedMarker)) {
  console.log('setup: signing in on a fresh profile')
  const app = await startApp('electron', PORT, [], { profile, signIn: true, bounds: topHalf(display) })
  try {
    app.placeMainWindow(display.x, display.y, Math.min(display.w, 1500), Math.min(950, Math.floor(display.h / 2)))
    // Maximize then restore: a deliberate change the app saves, so every later launch reopens right here
    // (the main window remembers its place) instead of on the owner's primary monitor.
    await sleep(500)
    app.showMainWindow(3)
    await sleep(800)
    app.showMainWindow(9)
    await sleep(800)
    await app.charts()
    await app.waitFor(`performance.getEntriesByName('${MARK}','mark').length > 0`, 60000)
    console.log('setup: waiting 35 s so the session cookie is written to disk')
    await sleep(35000)
  } finally {
    await app.close()
  }
  writeFileSync(signedMarker, JSON.stringify({ at: new Date().toISOString() }))
}

const runs = []
for (let i = 0; i < N; i++) {
  const t0 = Date.now()
  const app = await startApp('electron', PORT, [], { profile, signIn: false })
  let row
  try {
    try {
      await app.waitFor(`performance.getEntriesByName('${MARK}','mark').length > 0`, 45000)
    } catch (e) {
      // A signed-out profile lands on the public page and never draws a chart: say so, never just "timed out".
      const me = await app.run(`fetch('/api/auth/me',{credentials:'include'}).then(r=>r.status)`).catch(() => 0)
      throw new Error(me === 401 ? `the profile is signed out (delete ${signedMarker} to sign in again)` : e.message)
    }
    const page = await app.run(READ)
    await sleep(500)
    const bb = lastLaunchTiming()
    const fromSpawn = (v) => (v == null ? null : Math.round(page.timeOrigin + v - t0))
    row = {
      run: i + 1,
      path: page.path,
      ready: bb?.ready ?? null, window: bb?.window ?? null, shown: bb?.shown ?? null, loading: bb?.loading ?? null,
      html: fromSpawn(page.html), domReady: bb?.domReady ?? null, loaded: bb?.loaded ?? null,
      candles: fromSpawn(page.candles),
      // The last document's own clock, made absolute: when it began (timeOrigin) and its HTML phases.
      docStart: Math.round(page.timeOrigin - t0), navType: page.navType, navName: page.navName, protocol: page.protocol, nt: page.nt,
      navigations: launchNavigations(),
      targets: (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page').map((t) => t.url.replace(BASE, '').slice(0, 40) || '/'),
      api: page.api,
    }
  } catch (e) {
    row = { run: i + 1, error: String(e.message || e) }
  } finally {
    await app.close()
  }
  runs.push(row)
  console.log(row.error ? `run ${row.run}: ERROR ${row.error}` :
    `run ${row.run}: ready ${row.ready} | window ${row.window} | shown ${row.shown} | loading ${row.loading} | html ${row.html} | domReady ${row.domReady} | loaded ${row.loaded} | CANDLES ${row.candles}  (${row.path}, ${row.api.length} api before candles)
` +
    `        doc ${row.navName} ${row.navType} ${row.protocol} began @${row.docStart}: request ${row.nt?.requestStart} hint ${row.nt?.firstInterimResponseStart} headers ${row.nt?.finalResponseHeadersStart || row.nt?.responseStart} end ${row.nt?.responseEnd} (dns ${row.nt?.domainLookupEnd - row.nt?.domainLookupStart}, connect ${row.nt?.connectEnd - row.nt?.connectStart}) | loads: ${row.navigations.join(', ')} | pages: ${row.targets.join(' ')}`)
  await sleep(2000)
}

const ok = runs.filter((r) => !r.error)
const phases = ['ready', 'window', 'shown', 'loading', 'html', 'domReady', 'loaded', 'candles']
const summary = { label, ab: ab || 'none', n: N, errors: runs.length - ok.length }
for (const p of phases) summary[p] = { p50: pct(ok.map((r) => r[p]), 0.5), p90: pct(ok.map((r) => r[p]), 0.9), max: pct(ok.map((r) => r[p]), 1) }
const lastApi = {}
for (const r of ok) for (const a of r.api) (lastApi[a.name] ||= []).push(a.end)
summary.slowestApiBeforeCandles = Object.entries(lastApi).map(([name, ends]) => ({ name, runs: ends.length, endP50: pct(ends, 0.5) }))
  .sort((a, b) => b.endP50 - a.endP50).slice(0, 8)
console.log('\nMEDIAN (p90, max) ms from process start:')
for (const p of phases) console.log(`  ${p.padEnd(9)} ${summary[p].p50}  (${summary[p].p90}, ${summary[p].max})`)
console.log('slowest /api before candles (end, page clock):', summary.slowestApiBeforeCandles.map((a) => `${a.name} ${a.endP50}`).join(' | '))
const file = join(OUT, `results-launch-cold-${label}.json`)
writeFileSync(file, JSON.stringify({ startedUtc: new Date().toISOString(), base: BASE, display: displayIndex, summary, runs }, null, 2))
console.log(`wrote ${file}`)
