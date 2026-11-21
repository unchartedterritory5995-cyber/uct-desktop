// The reviewer's frame-cost check on traced flip-proof runs (--trace=i,j, light sampler): per traced flip,
//   rAF work = the summed FireAnimationFrame time on the page's main thread from BOTH (the sampler's `seen`, when
//              both charts already hold the new symbol) to the first Commit after it: the frame callbacks the
//              paint has to wait through;
//   paints   = lightweight-charts paint callbacks per chart in the flip (paint-probe.js), from the key to the end
//              of the dwell.
// usage: node scripts/proofs/raf-cost-check.mjs <run.json>
import { existsSync, readFileSync } from 'node:fs'
import * as M from './acceptance-matrix-lib.mjs'

const runPath = process.argv[2]
const run = JSON.parse(readFileSync(runPath, 'utf8'))
const charts = [run.tf, run.tf2, run.tf3].filter(Boolean).length
const ids = ['flip-chart', 'flip-chart-2', 'flip-chart-3'].slice(0, charts)
const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const rows = []
for (const f of run.flips || []) {
  const s = M.scoreSwitch(f, charts, run.dwell || 0)
  const paints = ids.map((id) => (f.paints || []).filter((p) => p.w === id && p.end >= f.key).length)
  const row = { i: f.i, seen: s.seenBothMs, pixels: s.pixelsBothMs, paints, raf: null }
  const tp = runPath.replace(/\.json$/, '') + `.flip${f.i}.trace.json`
  if (f.traceAlign != null && existsSync(tp) && s.seenBothMs != null) {
    const ev = JSON.parse(readFileSync(tp, 'utf8')).traceEvents || []
    const al = ev.find((e) => e.name === '__flipAlign' && e.args && e.args.data)
    if (al) {
      const toTs = (pageMs) => al.ts + (pageMs - al.args.data.startTime) * 1000
      const from = toTs(f.key + s.seenBothMs)
      const commit = ev.filter((e) => e.name === 'Commit' && e.pid === al.pid && e.ts >= from).sort((a, b) => a.ts - b.ts)[0]
      if (commit) {
        const faf = ev.filter((e) => e.name === 'FireAnimationFrame' && e.ph === 'X' && e.pid === al.pid && e.tid === al.tid && e.ts + (e.dur || 0) >= from && e.ts <= commit.ts)
        row.raf = Math.round(faf.reduce((a, e) => a + Math.min(e.ts + (e.dur || 0), commit.ts) - Math.max(e.ts, from), 0) / 100) / 10
        row.rafCalls = faf.length
        row.toCommit = Math.round((commit.ts - from) / 100) / 10
      }
    }
  }
  rows.push(row)
}
console.log(`${runPath}`)
console.log('flip | seen BOTH | pixels_both | rAF work BOTH->Commit (callbacks) | paints per chart')
for (const r of rows) console.log(`#${String(r.i).padStart(2)} | ${String(r.seen ?? '-').padStart(8)} | ${String(r.pixels ?? '-').padStart(10)} | ${r.raf == null ? '        -' : `${String(r.raf).padStart(6)} ms (${r.rafCalls}) to commit ${r.toCommit} ms`} | ${r.paints.join(' / ')}`)
const traced = rows.filter((r) => r.raf != null)
console.log(`traced flips ${traced.length}: rAF work BOTH->Commit median ${med(traced.map((r) => r.raf)) == null ? "-" : Math.round(med(traced.map((r) => r.raf)) * 10) / 10} ms (range ${traced.length ? Math.min(...traced.map((r) => r.raf)) : '-'}-${traced.length ? Math.max(...traced.map((r) => r.raf)) : '-'}); paints per chart median ${ids.map((_, c) => med(rows.map((r) => r.paints[c]))).join(' / ')} over ${rows.length} flips; pixels_both median ${med(rows.map((r) => r.pixels))} ms`)
