// Where the time goes between "navigate to /charts" and "candles on screen", phase by phase, N times.
// Plan Step 4.1. Each run navigates the signed-in app from / to /charts (warm cache, like a repeat
// launch after the process is up) and records, from the page's own clock:
//   html         the document's responseEnd
//   interactive  domInteractive (the app's code has run)
//   dcl          domContentLoadedEventEnd
//   firstCanvas  the first chart canvas wider than 200 px (Lightweight Charts creates the chart only
//                after its bars arrive, so this is "candles on screen" to within a frame)
//   api          every /api/ request: name, start, end (the waterfall: what waits on what)
// Usage: node scripts/proofs/launch-phases.mjs [electron|chrome] [--n=20]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, sleep, startApp } from './launch.mjs'

const target = process.argv[2] || 'electron'
const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '--n=20').split('=')[1])
const PORT = target === 'electron' ? 9350 : 9351

const PROBE = `(()=>{const t0=performance.now();const f=()=>{for(const c of document.querySelectorAll('canvas')){if(c.clientWidth>200&&c.clientHeight>100){window.__firstCanvasAt=performance.now();return}}if(performance.now()-t0<30000)requestAnimationFrame(f)};requestAnimationFrame(f)})()`
const READ = `(()=>{const n=performance.getEntriesByType('navigation')[0];const api=performance.getEntriesByType('resource').filter(r=>r.name.includes('/api/')).map(r=>({name:r.name.replace(/^https?:\\/\\/[^/]+/,'').split('?')[0],start:Math.round(r.startTime),end:Math.round(r.responseEnd),kb:Math.round((r.transferSize||0)/1024)}));return {html:Math.round(n.responseEnd),interactive:Math.round(n.domInteractive),dcl:Math.round(n.domContentLoadedEventEnd),firstCanvas:window.__firstCanvasAt?Math.round(window.__firstCanvasAt):null,api}})()`

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }

let app
const runs = []
try {
  app = await startApp(target, PORT, [])
  const { c, run, waitFor } = app
  await c.send('Page.navigate', { url: `${BASE}/charts` }) // first visit fills caches
  await sleep(8000)
  for (let i = 0; i < N; i++) {
    await c.send('Page.navigate', { url: `${BASE}/` })
    await sleep(2500)
    await c.send('Page.navigate', { url: `${BASE}/charts` })
    // Installed as soon as the new document commits; the first chart canvas needs bars first, so it
    // cannot appear before this runs. The probe's clock is the page's own (performance.now).
    for (let k = 0; k < 40; k++) { try { if (await run(`location.pathname === '/charts'`)) { await run(PROBE); break } } catch { /* mid-commit */ } await sleep(25) }
    await waitFor('!!window.__firstCanvasAt', 30000).catch(() => undefined)
    await sleep(1500)
    const r = await run(READ)
    runs.push(r)
    console.log(`run ${i + 1}: html ${r.html} interactive ${r.interactive} dcl ${r.dcl} firstCanvas ${r.firstCanvas} api ${r.api.length}`)
  }
} catch (e) {
  console.log(`stopped: ${String(e.message).slice(0, 160)}`)
} finally {
  if (app) await app.close()
}

// Summary: medians and p95 of each phase, and the median end time of each API call by name.
const fc = runs.map((r) => r.firstCanvas).filter((x) => x !== null)
const byName = {}
for (const r of runs) for (const a of r.api) (byName[a.name] = byName[a.name] || { start: [], end: [], n: 0 }), byName[a.name].start.push(a.start), byName[a.name].end.push(a.end), byName[a.name].n++
const summary = {
  target, runs: runs.length,
  htmlP50: pct(runs.map((r) => r.html), 0.5), interactiveP50: pct(runs.map((r) => r.interactive), 0.5),
  firstCanvasP50: pct(fc, 0.5), firstCanvasP95: pct(fc, 0.95), firstCanvasMissing: runs.length - fc.length,
  api: Object.entries(byName).map(([name, v]) => ({ name, perRun: Math.round((v.n / runs.length) * 10) / 10, startP50: pct(v.start, 0.5), endP50: pct(v.end, 0.5) })).sort((a, b) => a.startP50 - b.startP50),
}
writeFileSync(join('proof-output', `results-launch-phases-${target}.json`), JSON.stringify({ summary, runs }, null, 2))
console.log(JSON.stringify({ ...summary, api: undefined }))
for (const a of summary.api.slice(0, 40)) console.log(`  ${String(a.startP50).padStart(5)} -> ${String(a.endP50).padStart(5)} ms  x${a.perRun}  ${a.name}`)
