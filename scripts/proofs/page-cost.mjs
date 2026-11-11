// What each page costs while a member just LOOKS at it: main-thread busy share, script time, layouts
// and style recalcs per second, requests per minute, rAF callbacks per second, DOM size and JS heap.
// Real app, signed in as the bench member, one page at a time, settle then measure.
// Usage: node scripts/proofs/page-cost.mjs [electron|chrome] [--settle=10] [--measure=30] [/route ...]
// After hours numbers show the idle floor (loops and polls); repeat in market hours for live load.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, sleep, startApp } from './launch.mjs'

const args = process.argv.slice(2)
const target = args.find((a) => a === 'electron' || a === 'chrome') || 'electron'
const opt = (k, d) => Number((args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d)
const SETTLE_S = opt('settle', 10)
const MEASURE_S = opt('measure', 30)
const WARM_S = opt('warm', 0) // sit on /charts first so one-time pack downloads finish before measuring
const routes = args.filter((a) => a.startsWith('/'))
const ROUTES = routes.length ? routes : ['/options-flow', '/live-massive', '/flow-scoreboard', '/charts', '/dashboard']
const PORT = target === 'electron' ? 9351 : 9352

// Counts rAF callbacks the PAGE schedules (wraps requestAnimationFrame once per document).
// Callers are attributed by the first app frame of the scheduling stack (assets file:line).
const RAF_PROBE = `(()=>{if(!window.__rafCount){window.__rafCount=0;window.__rafBy={};const o=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=(cb)=>{const st=(new Error().stack||'').split(String.fromCharCode(10)).slice(2).find(l=>l.includes('/assets/'))||'?';const k=st.slice(st.lastIndexOf('/assets/')+8).replace(')','').slice(0,80);return o((t)=>{window.__rafCount++;window.__rafBy[k]=(window.__rafBy[k]||0)+1;cb(t)})}}return window.__rafCount})()`
const metrics = async (c) => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))

let app
const results = { target, startedUtc: new Date().toISOString(), settleS: SETTLE_S, measureS: MEASURE_S, routes: [] }
try {
  app = await startApp(target, PORT, [])
  const { c, run } = app
  await c.send('Performance.enable', { timeDomain: 'timeTicks' })
  await c.send('Network.enable')
  let requests = []
  c.on((m) => {
    if (m.method === 'Network.requestWillBeSent') requests.push(m.params.request.url)
  })
  if (WARM_S) {
    await c.send('Page.navigate', { url: `${BASE}/charts` })
    await sleep(WARM_S * 1000)
  }
  for (const route of ROUTES) {
    await c.send('Page.navigate', { url: `${BASE}${route}` })
    await sleep(SETTLE_S * 1000)
    await run(RAF_PROBE)
    await run('window.__rafBy={}')
    const r0 = await run('window.__rafCount')
    const m0 = await metrics(c)
    requests = []
    await sleep(MEASURE_S * 1000)
    const m1 = await metrics(c)
    const r1 = await run('window.__rafCount')
    const dom = await run('document.getElementsByTagName("*").length')
    const rafBy = Object.entries(await run('window.__rafBy')).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const vis = await run('document.visibilityState + (document.hasFocus() ? "+focus" : "")')
    const per = (k) => (m1[k] - m0[k]) / MEASURE_S
    const hosts = {}
    for (const u of requests) {
      let key = u
      try { const x = new URL(u); key = x.origin === BASE ? x.pathname.split('/').slice(0, 3).join('/') : x.host } catch { /* keep */ }
      hosts[key] = (hosts[key] || 0) + 1
    }
    const top = Object.entries(hosts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    const row = {
      route,
      busyPct: Math.round(per('TaskDuration') * 1000) / 10,
      scriptPct: Math.round(per('ScriptDuration') * 1000) / 10,
      layoutsPerS: Math.round(per('LayoutCount') * 10) / 10,
      recalcsPerS: Math.round(per('RecalcStyleCount') * 10) / 10,
      rafPerS: Math.round(((r1 - r0) / MEASURE_S) * 10) / 10,
      requestsPerMin: Math.round((requests.length / MEASURE_S) * 60),
      domNodes: dom,
      heapMB: Math.round(m1.JSHeapUsedSize / 1048576),
      topRequests: top,
      rafBy,
      visibility: vis,
    }
    results.routes.push(row)
    console.log(`${route.padEnd(18)} busy ${String(row.busyPct).padStart(5)}%  script ${String(row.scriptPct).padStart(5)}%  layout/s ${String(row.layoutsPerS).padStart(5)}  recalc/s ${String(row.recalcsPerS).padStart(5)}  rAF/s ${String(row.rafPerS).padStart(5)}  req/min ${String(row.requestsPerMin).padStart(4)}  dom ${row.domNodes}  heap ${row.heapMB} MB  [${vis}]`)
    for (const [k, n] of top) console.log(`${''.padEnd(20)}${String(n).padStart(4)} x ${k}`)
    for (const [k, n] of rafBy) console.log(`${''.padEnd(20)}rAF ${String(n).padStart(5)} x ${k}`)
  }
} finally {
  writeFileSync(join('proof-output', `results-page-cost-${target}.json`), JSON.stringify(results, null, 1))
  if (app) app.close?.()
}
process.exit(0)
