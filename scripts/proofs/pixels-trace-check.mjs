// Checks the FRAME-COMPLETE stamp (paint-probe.js) against Chromium's own record of that frame, on the flips a
// flip-proof run traced (--trace=i,j). For each traced flip and each linked chart:
//   stamp    = the probe's `complete` for the chart's first paint of the new symbol (a task posted from the paint
//              callback, run once that frame's rendering update has finished)
//   commit   = the end of the renderer's first Commit at or after that paint (the '__lwcPaint:<chart>' mark): the
//              frame carrying the paint, finished by the main thread
//   glass    = the end of the compositor's PipelineReporter (STATE_PRESENTED_*) for that frame: on screen
//   seen     = the old stamp: the first sampled frame in which the debug handle already held the new series
// VALIDATED when every stamp is within one frame (16.7 ms) of its commit and never before the chart's own paint.
// pipeline_ms = glass - stamp, the browser/GPU/vsync time after the frame is complete: a machine constant, reported
// on its own line and never added to pixels_both.
// Page time and trace time are joined by the '__flipAlign' user-timing mark each traced flip leaves.
// usage: node scripts/proofs/pixels-trace-check.mjs <run.json>
import { existsSync, readFileSync } from 'node:fs'
import * as M from './acceptance-matrix-lib.mjs'

const runPath = process.argv[2]
if (!runPath) { console.log('usage: node scripts/proofs/pixels-trace-check.mjs <run.json>'); process.exit(2) }
const run = JSON.parse(readFileSync(runPath, 'utf8'))
const charts = [run.tf, run.tf2, run.tf3].filter(Boolean).length
const ids = ['flip-chart', 'flip-chart-2', 'flip-chart-3'].slice(0, charts)
const r1 = (x) => Math.round(x * 10) / 10
const rows = []
for (const f of run.flips || []) {
  const tp = runPath.replace(/\.json$/, '') + `.flip${f.i}.trace.json`
  if (f.traceAlign == null || !existsSync(tp)) continue
  const ev = JSON.parse(readFileSync(tp, 'utf8')).traceEvents || []
  const align = ev.find((e) => e.name === '__flipAlign' && e.args && e.args.data)
  if (!align) { rows.push({ i: f.i, err: 'no __flipAlign mark in the trace' }); continue }
  const toPage = (ts) => align.args.data.startTime + (ts - align.ts) / 1000
  const pid = align.pid
  const commits = ev.filter((e) => e.name === 'Commit' && e.pid === pid && e.ph === 'X').map((e) => ({ b: e.ts, e: e.ts + (e.dur || 0) })).sort((a, b) => a.b - b.b)
  const open = new Map(), frames = []
  for (const e of ev) {
    if (e.name !== 'PipelineReporter' || e.pid !== pid) continue
    const id = (e.id2 && (e.id2.local || e.id2.global)) || e.id
    if (e.ph === 'b') open.set(id, e)
    else if (e.ph === 'e' && open.has(id)) {
      const b = open.get(id); open.delete(id)
      const st = b.args && b.args.frame_reporter && b.args.frame_reporter.state
      if (/^STATE_PRESENTED/.test(st || '')) frames.push({ b: b.ts, e: e.ts })
    }
  }
  frames.sort((a, b) => a.b - b.b)
  const marks = ev.filter((e) => e.cat && e.cat.includes('blink.user_timing') && e.pid === pid && /^__lwcPaint:/.test(e.name))
  const s = M.scoreSwitch(f, charts, run.dwell || 0)
  for (let c = 0; c < charts; c++) {
    const p = (s.paints || [])[c]
    const stamp = p ? (p.complete != null ? p.complete : p.present) : null
    if (!p || stamp == null) { rows.push({ i: f.i, chart: c + 1, err: 'no new-symbol paint with a stamp recorded' }); continue }
    let best = null
    for (const m of marks) if (m.name === `__lwcPaint:${ids[c]}`) { const d = Math.abs(toPage(m.ts) - p.end); if (!best || d < best.d) best = { m, d } }
    if (!best || best.d > 3) { rows.push({ i: f.i, chart: c + 1, err: `no matching paint mark in the trace (nearest ${best ? best.d.toFixed(1) + ' ms' : 'none'})` }); continue }
    const ts = best.m.ts
    const commit = commits.find((x) => x.b >= ts)
    const glass = frames.filter((x) => x.b <= ts && x.e > ts).sort((a, b) => b.b - a.b)[0] || frames.find((x) => x.b > ts)
    rows.push({
      i: f.i, chart: c + 1, seen: s.seenMs ? s.seenMs[c] : null, paintEnd: r1(p.end - f.key), stamp: r1(stamp - f.key),
      commit: commit ? r1(toPage(commit.e) - f.key) : null, glass: glass ? r1(toPage(glass.e) - f.key) : null,
    })
  }
}
for (const r of rows) if (r.commit != null) r.diff = r1(r.commit - r.stamp)
const ok = rows.filter((r) => r.diff != null)
console.log(`${runPath}: ${ok.length} chart-switches checked on ${new Set(rows.map((r) => r.i)).size} traced flips`)
console.log('flip chart |  seen (old) | paint ends |  STAMP (frame complete) | trace COMMIT end | commit - stamp | glass (presented) | pipeline (glass - stamp)')
for (const r of rows) {
  if (r.err) { console.log(`#${r.i} ${r.chart ?? ''}: ${r.err}`); continue }
  console.log(`#${String(r.i).padStart(2)}   ${r.chart}   | ${String(r.seen ?? '?').padStart(8)} ms | ${String(r.paintEnd).padStart(7)} ms | ${String(r.stamp).padStart(18)} ms | ${String(r.commit ?? '?').padStart(12)} ms | ${String(r.diff ?? '?').padStart(10)} ms | ${String(r.glass ?? '?').padStart(13)} ms | ${r.glass != null ? r1(r.glass - r.stamp) : '?'} ms`)
}
if (ok.length) {
  const sorted = (xs) => [...xs].sort((a, b) => a - b)
  const d = sorted(ok.map((r) => Math.abs(r.diff)))
  const early = rows.filter((r) => r.stamp != null && r.paintEnd != null && r.stamp < r.paintEnd)
  const pipe = sorted(rows.filter((r) => r.glass != null && r.stamp != null).map((r) => r1(r.glass - r.stamp)))
  const lag = sorted(ok.filter((r) => r.seen != null).map((r) => r.stamp - r.seen))
  console.log(`|commit - stamp|: median ${d[d.length >> 1]} ms, max ${d[d.length - 1]} ms; stamps before their own paint: ${early.length}; the old stamp was ${lag.length ? r1(lag[lag.length >> 1]) : '?'} ms (median) before this one`)
  console.log(`pipeline_ms (glass - frame complete, the browser/GPU/vsync constant, NOT part of pixels_both): median ${pipe.length ? pipe[pipe.length >> 1] : '?'} ms, range ${pipe.length ? pipe[0] : '?'}-${pipe.length ? pipe[pipe.length - 1] : '?'} ms`)
  console.log(d[d.length - 1] <= 16.7 && !early.length ? "VALIDATED: every stamp within one frame (16.7 ms) of the trace's commit of its frame, and none before its chart's own paint" : 'NOT VALIDATED: a stamp is more than one frame off its frame\'s commit, or before its own paint')
}
