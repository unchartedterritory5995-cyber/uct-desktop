// History lake vs production: do the lake's bars equal what /api/bars serves for the same symbol,
// timeframe and window? The join between a chart's recent bars (server) and its deep history (lake)
// refuses a window whose close differs by more than 2% at the join, so the two must agree, split
// adjustment included.
//
// Server side: the real member path (production, synthetic bench account, real Chrome),
// `/api/bars/<sym>?tf=&bars=N&to=<date>` (the replay window: the N bars before that date).
// Lake side: the published packs + indexes on this PC, served by the REAL edge handler
// (edge/bars-edge-router/history.js) over a local HTTP server, read by the REAL browser reader
// (app/src/data/historyLake/source.js), split-adjusted from the index's table.
//
// Usage: node scripts/proofs/history-lake-spot-check.mjs <out.json> --repo=<uct-dashboard worktree>
//          --index=<publish dir holding v1/index> --packs=<dir>[,<dir>...] [--port=9445]
// Reads only. Sends no OS keys or clicks.
import http from 'node:http'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { registerHooks } from 'node:module'
import { startApp, BASE } from './launch.mjs'

const OUT = process.argv[2]
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
if (!OUT || OUT.startsWith('--')) { console.error('usage: history-lake-spot-check.mjs <out.json> --repo= --index= --packs='); process.exit(64) }
const REPO = arg('repo', 'C:/Users/Patrick/uct-worktrees/rt-ticks')
const INDEX = arg('index', 'D:/uct-history/publish')
const PACKS = arg('packs', 'D:/uct-history/packs-1,D:/uct-history/packs-2,D:/uct-history/packs-3').split(',')
const PORT = Number(arg('port', '9445'))

// the app's modules import without extensions (Vite resolves them); do the same here
registerHooks({ resolve(spec, ctx, next) { try { return next(spec, ctx) } catch (e) { if (spec.startsWith('.') && !/\.[a-z]+$/.test(spec)) return next(spec + '.js', ctx); throw e } } })
const { handleHistory } = await import(pathToFileURL(`${REPO}/edge/bars-edge-router/history.js`))
const { createHistorySource } = await import(pathToFileURL(`${REPO}/app/src/data/historyLake/source.js`))

// symbol, timeframe, the window's end date, bars: split weeks and ordinary ones, every series
const CASES_DEFAULT = [
  ['AAPL', '5', '2020-09-04', 400],     // across the 4:1 split of 2020-08-31
  ['NVDA', '60', '2024-06-14', 300],    // across the 10:1 split of 2024-06-10
  ['TSLA', '15', '2022-08-31', 400],    // across the 3:1 split of 2022-08-25
  ['SPY', '1', '2026-11-12', 800],
  ['QQQ', '30', '2025-03-14', 300],
  ['BRK-B', '5', '2024-02-16', 400],    // a class share (the vendor's BRK.B)
  ['F', '60', '2010-06-18', 200],
  ['MSFT', '1', '2008-10-10', 600],
]

// --cases=SYM:TF:TO:N,SYM:TF:TO:N overrides the list (a dry run against a partial lake)
const CASES = arg('cases', '') ? arg('cases', '').split(',').map((c) => { const [s, t, d, n] = c.split(':'); return [s, t, d, Number(n)] }) : CASES_DEFAULT

const bucket = {
  async get(key, opts) {
    let path = null
    if (key.startsWith('v1/index/')) path = `${INDEX}/${key}`
    else for (const root of PACKS) { const p = `${root}/${key}`; if (existsSync(p)) { path = p; break } }
    if (!path || !existsSync(path)) return null
    let b = readFileSync(path)
    if (opts && opts.range) b = b.subarray(opts.range.offset, opts.range.offset + opts.range.length)
    return { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  },
}
const server = http.createServer(async (req, out) => {
  const res = await handleHistory(new Request('http://x' + req.url, { headers: { 'accept-encoding': 'gzip, deflate, br' } }), { HISTORY: bucket }, async () => true)
  const h = {}; res.headers.forEach((v, k) => { h[k] = v })
  out.writeHead(res.status, h); out.end(Buffer.from(await res.arrayBuffer()))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const lake = createHistorySource({ base: `http://127.0.0.1:${server.address().port}/api/hist` })

const out = { proof: 'history-lake-spot-check', base: BASE, startedAt: new Date().toISOString(), cases: [] }
const app = await startApp('chrome', PORT, [])
try {
  const { run } = app
  for (const [sym, tf, to, n] of CASES) {
    const row = { sym, tf, to, asked: n }
    try {
      // the app's own older-window URL (utils/prefetchBars.barsBeforeUrl + barTime.barsSessionQuery, regular hours)
      const s = await run(`fetch('/api/bars/${encodeURIComponent(sym)}?tf=${tf}&bars=${n}&session=rth&to=${to}',{credentials:'include'}).then(r=>r.json())`)
      const sb = (s && Array.isArray(s.bars)) ? s.bars : []
      row.server = sb.length
      if (!sb.length) { row.verdict = 'NO SERVER BARS'; out.cases.push(row); continue }
      const from = sb[0].t, last = sb[sb.length - 1].t
      const l = await lake.loadBars(sym, tf, { from, to: last })
      if (!l) { row.verdict = 'NOT IN LAKE'; out.cases.push(row); continue }
      const at = new Map()
      for (let i = 0; i < l.t.length; i++) at.set(l.t[i], i)
      let both = 0, priceOk = 0, volOk = 0, worst = 0, worstAt = null
      const onlyServer = []
      for (const b of sb) {
        const i = at.get(b.t)
        if (i == null) { if (onlyServer.length < 5) onlyServer.push(b.t); continue }
        both++
        const rel = Math.max(...['o', 'h', 'l', 'c'].map((k) => Math.abs(l[k][i] - b[k]) / Math.max(1e-9, Math.abs(b[k]))))
        // the server sends split-adjusted prices rounded to 4 decimals; the lake keeps full precision (AAPL 2004
        // 1m at ~$0.49 adjusted: 0.4897 vs 0.489625). One unit in the 4th decimal, or 1 bp, is agreement.
        const absMax = Math.max(...['o', 'h', 'l', 'c'].map((k) => Math.abs(l[k][i] - b[k])))
        if (rel <= 1e-4 || absMax <= 1.0001e-4) priceOk++
        if (rel > worst) { worst = rel; worstAt = b.t; row.worstBar = { server: { o: b.o, h: b.h, l: b.l, c: b.c }, lake: { o: l.o[i], h: l.h[i], l: l.l[i], c: l.c[i] } } }
        if (Math.abs(l.v[i] - b.v) <= Math.max(1, Math.abs(b.v) * 1e-6)) volOk++
      }
      Object.assign(row, { lakeInWindow: l.t.length, both, priceOk, volOk, worstRel: worst, worstAt, onlyServer })
      row.verdict = both >= 0.95 * sb.length && priceOk >= 0.995 * both ? 'AGREE' : 'DIFFER'
    } catch (e) { row.verdict = 'ERROR'; row.error = String(e.message || e).slice(0, 300) }
    out.cases.push(row)
    console.log(`${sym} ${tf} to ${to}: ${row.verdict}  server ${row.server ?? '-'}  both ${row.both ?? '-'}  prices ${row.priceOk ?? '-'}  volume ${row.volOk ?? '-'}  worst ${row.worstRel != null ? (row.worstRel * 100).toFixed(4) + '%' : '-'}`)
  }
} finally {
  await app.close()
  server.close()
  out.finishedAt = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify(out, null, 1))
}
process.exit(out.cases.every((c) => c.verdict === 'AGREE') ? 0 : 1)
