// Checks the presentation stamp (paint-probe.js) against Chromium's own record of when each frame was presented,
// on the flips a flip-proof run traced (--trace=i,j). For each traced flip and each linked chart:
//   stamp  = the probe's `present` for the chart's first paint of the new symbol (the frame after the paint)
//   trace  = the end of the compositor's PipelineReporter (STATE_PRESENTED_*) for the frame that carried that
//            paint: the frame whose pipeline began last before the paint's '__lwcPaint:<chart>' mark
//   seen   = the old stamp: the first sampled frame in which the debug handle already held the new series
// Page time and trace time are joined by the '__flipAlign' user-timing mark each traced flip leaves.
// usage: node scripts/proofs/pixels-trace-check.mjs <run.json>
import { existsSync, readFileSync } from 'node:fs'
import * as M from './acceptance-matrix-lib.mjs'

const runPath = process.argv[2]
if (!runPath) { console.log('usage: node scripts/proofs/pixels-trace-check.mjs <run.json>'); process.exit(2) }
const run = JSON.parse(readFileSync(runPath, 'utf8'))
const charts = [run.tf, run.tf2, run.tf3].filter(Boolean).length
const ids = ['flip-chart', 'flip-chart-2', 'flip-chart-3'].slice(0, charts)
const rows = []
for (const f of run.flips || []) {
  const tp = runPath.replace(/\.json$/, '') + `.flip${f.i}.trace.json`
  if (f.traceAlign == null || !existsSync(tp)) continue
  const ev = JSON.parse(readFileSync(tp, 'utf8')).traceEvents || []
  const align = ev.find((e) => e.name === '__flipAlign' && e.args && e.args.data)
  if (!align) { rows.push({ i: f.i, err: 'no __flipAlign mark in the trace' }); continue }
  const toPage = (ts) => align.args.data.startTime + (ts - align.ts) / 1000
  const pid = align.pid
  // presented frames on this renderer: PipelineReporter begin/end pairs
  const open = new Map(), frames = []
  for (const e of ev) {
    if (e.name !== 'PipelineReporter' || e.pid !== pid) continue
    const id = (e.id2 && (e.id2.local || e.id2.global)) || e.id
    if (e.ph === 'b') open.set(id, e)
    else if (e.ph === 'e' && open.has(id)) {
      const b = open.get(id); open.delete(id)
      const st = b.args && b.args.frame_reporter && b.args.frame_reporter.state
      if (/^STATE_PRESENTED/.test(st || '')) frames.push({ b: b.ts, e: e.ts, st, seq: b.args.frame_reporter.frame_sequence })
    }
  }
  frames.sort((a, b) => a.b - b.b)
  const marks = ev.filter((e) => e.cat && e.cat.includes('blink.user_timing') && e.pid === pid && /^__lwcPaint:/.test(e.name))
  const s = M.scoreSwitch(f, charts, run.dwell || 0)
  for (let c = 0; c < charts; c++) {
    const p = (s.paints || [])[c]
    if (!p) { rows.push({ i: f.i, chart: c + 1, err: 'no new-symbol paint recorded' }); continue }
    // the trace mark of that paint: the one closest to its page time
    let best = null
    for (const m of marks) if (m.name === `__lwcPaint:${ids[c]}`) { const d = Math.abs(toPage(m.ts) - p.end); if (!best || d < best.d) best = { m, d } }
    if (!best || best.d > 3) { rows.push({ i: f.i, chart: c + 1, err: `no matching paint mark in the trace (nearest ${best ? best.d.toFixed(1) + ' ms' : 'none'})` }); continue }
    const ts = best.m.ts
    const carrier = frames.filter((x) => x.b <= ts && x.e > ts).sort((a, b) => b.b - a.b)[0] || frames.find((x) => x.b > ts)
    if (!carrier) { rows.push({ i: f.i, chart: c + 1, err: 'no presented frame after the paint in the trace' }); continue }
    const trace = toPage(carrier.e) - f.key
    rows.push({ i: f.i, chart: c + 1, seen: s.seenMs ? s.seenMs[c] : null, paintEnd: Math.round((p.end - f.key) * 10) / 10, stamp: Math.round((p.present - f.key) * 10) / 10, trace: Math.round(trace * 10) / 10, diff: Math.round((trace - (p.present - f.key)) * 10) / 10, frameState: carrier.st })
  }
}
const ok = rows.filter((r) => r.diff != null)
console.log(`${runPath}: ${ok.length} chart-switches checked on ${new Set(rows.map((r) => r.i)).size} traced flips`)
console.log('flip chart |  seen (old) | paint ends | STAMP (present) | TRACE presented | trace - stamp | frame')
for (const r of rows) {
  if (r.err) { console.log(`#${r.i} ${r.chart ?? ''}: ${r.err}`); continue }
  console.log(`#${String(r.i).padStart(2)}   ${r.chart}   | ${String(r.seen ?? '?').padStart(8)} ms | ${String(r.paintEnd).padStart(7)} ms | ${String(r.stamp).padStart(12)} ms | ${String(r.trace).padStart(12)} ms | ${String(r.diff).padStart(10)} ms | ${r.frameState}`)
}
if (ok.length) {
  const d = ok.map((r) => Math.abs(r.diff)).sort((a, b) => a - b)
  const lag = ok.filter((r) => r.seen != null).map((r) => r.stamp - r.seen).sort((a, b) => a - b)
  console.log(`|trace - stamp|: median ${d[d.length >> 1]} ms, max ${d[d.length - 1]} ms; the old stamp was ${lag.length ? lag[lag.length >> 1].toFixed(1) : '?'} ms (median) before the presentation stamp`)
  console.log(d[d.length - 1] <= 17 ? 'VALIDATED: every stamp within one frame (16.7 ms) of the trace\'s own presentation' : 'NOT VALIDATED: a stamp is more than one frame off the trace')
}
