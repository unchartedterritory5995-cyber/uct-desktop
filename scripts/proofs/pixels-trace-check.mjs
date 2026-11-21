// Checks the FRAME-COMPLETE stamp (paint-probe.js) against Chromium's own record of that frame, on the flips a
// flip-proof run traced (--trace=i,j). For each traced flip and each linked chart:
//   draws    = the end of the chart's paint callback (`end`): the LOWER bound, the frame cannot be complete before it
//   stamp    = the probe's `complete` for the chart's first paint of the new symbol (a task posted from the paint
//              callback, run once that frame's rendering update has finished): the UPPER bound under test
//   mc       = traced runs of the user-blocking probe also record the OLD stamp (a fresh MessageChannel message,
//              default priority) on the same paint, so both are held against the same commit
//   commit   = the end of the renderer's first Commit at or after that paint (the '__lwcPaint:<chart>' mark): the
//              frame carrying the paint, finished by the main thread
//   glass    = the end of the compositor's PipelineReporter (STATE_PRESENTED_*) for that frame: on screen
//   seen     = the oldest stamp: the first sampled frame in which the debug handle already held the new series
//   after    = what the main thread ran between the commit and the stamp (its tasks, and whether a GC or an
//              IndexedDB reply was among them: the work a default-priority stamp waits behind)
// VALIDATED when at least 10 flips were traced, every stamp is within one frame (16.7 ms) of its commit, and none is
// before the chart's own paint. The residual (the largest |commit - stamp|) is printed either way, with the flips
// where a GC or an IndexedDB reply landed right after the commit (--provoke-gc on the proof queues a full GC there).
// pipeline_ms = glass - stamp, the browser/GPU/vsync time after the frame is complete: a machine constant, reported
// on its own line and never added to pixels_both.
// Page time and trace time are joined by the '__flipAlign' user-timing mark each traced flip leaves.
// usage: node scripts/proofs/pixels-trace-check.mjs <run.json>
import { existsSync, readFileSync } from 'node:fs'
import * as M from './acceptance-matrix-lib.mjs'

const MIN_FLIPS = 10
const runPath = process.argv[2]
if (!runPath) { console.log('usage: node scripts/proofs/pixels-trace-check.mjs <run.json>'); process.exit(2) }
const run = JSON.parse(readFileSync(runPath, 'utf8'))
const charts = [run.tf, run.tf2, run.tf3].filter(Boolean).length
const ids = ['flip-chart', 'flip-chart-2', 'flip-chart-3'].slice(0, charts)
const r1 = (x) => Math.round(x * 10) / 10
const GC = /^(MajorGC|MinorGC|V8\.GC_MARK_COMPACTOR|V8\.GC_SCAVENGER|V8\.GCFinalizeMC|BlinkGC\.AtomicPhase)/
const rows = []
for (const f of run.flips || []) {
  const tp = runPath.replace(/\.json$/, '') + `.flip${f.i}.trace.json`
  if (f.traceAlign == null || !existsSync(tp)) continue
  const ev = JSON.parse(readFileSync(tp, 'utf8')).traceEvents || []
  const align = ev.find((e) => e.name === '__flipAlign' && e.args && e.args.data)
  if (!align) { rows.push({ i: f.i, err: 'no __flipAlign mark in the trace' }); continue }
  const toPage = (ts) => align.args.data.startTime + (ts - align.ts) / 1000
  const toTrace = (ms) => align.ts + (ms - align.args.data.startTime) * 1000
  const pid = align.pid, tid = align.tid
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
  const main = ev.filter((e) => e.pid === pid && e.tid === tid && e.ph === 'X')
  const tasks = main.filter((e) => e.name === 'ThreadControllerImpl::RunTask').sort((a, b) => a.ts - b.ts)
  /** the main thread's work from the commit's end to `to` (trace ts): its tasks, and any GC / IndexedDB reply in it */
  const workAfter = (from, to) => {
    const inWin = (e) => e.ts >= from && e.ts < to
    const ts = tasks.filter((e) => inWin(e) && (e.dur || 0) >= 200) // the 0.0 ms scheduler bookkeeping tasks left out
    const gc = main.filter((e) => inWin(e) && GC.test(e.name) && (e.dur || 0) >= 1000)
    const idb = main.filter((e) => inWin(e) && e.name === 'FunctionCall' && /onsuccess|onupgradeneeded|oncomplete/.test(((e.args || {}).data || {}).functionName || ''))
    return { tasks: ts.length, busyMs: r1(ts.reduce((a, e) => a + (e.dur || 0), 0) / 1000), gcMs: r1(gc.reduce((a, e) => Math.max(a, (e.dur || 0) / 1000), 0)), idb: idb.length }
  }
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
    const late = Math.max(stamp, p.completeMc != null ? p.completeMc : stamp)
    rows.push({
      i: f.i, chart: c + 1, seen: s.seenMs ? s.seenMs[c] : null, paintEnd: r1(p.end - f.key), stamp: r1(stamp - f.key),
      mc: p.completeMc != null ? r1(p.completeMc - f.key) : null,
      commit: commit ? r1(toPage(commit.e) - f.key) : null, glass: glass ? r1(toPage(glass.e) - f.key) : null,
      after: commit ? workAfter(commit.e, toTrace(late)) : null, provoked: !!(f.provokedGc && f.provokedGc.length),
    })
  }
}
for (const r of rows) if (r.commit != null) { r.diff = r1(r.commit - r.stamp); if (r.mc != null) r.diffMc = r1(r.commit - r.mc) }
const ok = rows.filter((r) => r.diff != null)
const flips = new Set(ok.map((r) => r.i)).size
const via = run.stampVia || 'MessageChannel'
console.log(`${runPath}: ${ok.length} chart-switches checked on ${flips} traced flips; stamp: ${via}${ok.some((r) => r.mc != null) ? ' (and the old MessageChannel stamp beside it)' : ''}`)
console.log('flip chart | [draws done,   STAMP] | commit | commit nearest | commit - stamp | old MC stamp | commit - MC | glass | pipeline (glass - stamp) | main thread after the commit')
const pad = (x, n) => String(x ?? '-').padStart(n)
for (const r of rows) {
  if (r.err) { console.log(`#${r.i} ${r.chart ?? ''}: ${r.err}`); continue }
  const near = r.commit == null ? '?' : Math.abs(r.commit - r.paintEnd) <= Math.abs(r.commit - r.stamp) ? 'draws done' : 'STAMP'
  const a = r.after ? `${r.after.tasks} task(s) ${r.after.busyMs} ms${r.after.gcMs ? `, GC ${r.after.gcMs} ms` : ''}${r.after.idb ? `, IndexedDB reply x${r.after.idb}` : ''}${r.provoked ? ' (GC PROVOKED)' : ''}` : '?'
  console.log(`#${pad(r.i, 2)}   ${r.chart}   | [${pad(r.paintEnd, 7)}, ${pad(r.stamp, 7)}] | ${pad(r.commit, 6)} | ${pad(near, 10)} | ${pad(r.diff, 8)} ms | ${pad(r.mc, 8)} ms | ${pad(r.diffMc, 7)} ms | ${pad(r.glass, 6)} | ${r.glass != null ? r1(r.glass - r.stamp) : '?'} ms | ${a}`)
}
if (ok.length) {
  const sorted = (xs) => [...xs].sort((a, b) => a - b)
  const d = sorted(ok.map((r) => Math.abs(r.diff)))
  const early = rows.filter((r) => r.stamp != null && r.paintEnd != null && r.stamp < r.paintEnd)
  const pipe = sorted(rows.filter((r) => r.glass != null && r.stamp != null).map((r) => r1(r.glass - r.stamp)))
  const lag = sorted(ok.filter((r) => r.seen != null).map((r) => r.stamp - r.seen))
  const worst = ok.reduce((a, r) => (!a || Math.abs(r.diff) > Math.abs(a.diff) ? r : a), null)
  const stressed = ok.filter((r) => r.after && (r.after.gcMs || r.after.idb))
  console.log(`|commit - stamp|: median ${d[d.length >> 1]} ms, max ${d[d.length - 1]} ms (THE RESIDUAL: flip #${worst.i} chart ${worst.chart}); stamps before their own paint: ${early.length}${lag.length ? `; the sampled 'seen' stamp was ${r1(lag[lag.length >> 1])} ms (median) before this one` : ''}`)
  const mcs = ok.filter((r) => r.diffMc != null)
  if (mcs.length) {
    const dm = sorted(mcs.map((r) => Math.abs(r.diffMc)))
    console.log(`old MessageChannel stamp on the same paints: |commit - stamp| median ${dm[dm.length >> 1]} ms, max ${dm[dm.length - 1]} ms; it landed after the new stamp on ${mcs.filter((r) => r.mc > r.stamp).length} of ${mcs.length}`)
  }
  console.log(`after-commit stress: ${stressed.length} chart-switch(es) on ${new Set(stressed.map((r) => r.i)).size} flip(s) had a GC or an IndexedDB reply between the commit and the stamps (${ok.filter((r) => r.provoked).length} provoked); the largest |commit - stamp| among them: ${stressed.length ? Math.max(...stressed.map((r) => Math.abs(r.diff))) : 'n/a'} ms`)
  console.log(`pipeline_ms (glass - frame complete, the browser/GPU/vsync constant, NOT part of pixels_both): median ${pipe.length ? pipe[pipe.length >> 1] : '?'} ms, range ${pipe.length ? pipe[0] : '?'}-${pipe.length ? pipe[pipe.length - 1] : '?'} ms`)
  const within = d[d.length - 1] <= 16.7 && !early.length
  console.log(within && flips >= MIN_FLIPS ? `VALIDATED: every stamp within one frame (16.7 ms) of the trace's commit of its frame, and none before its chart's own paint (${flips} traced flips)`
    : within ? `NOT VALIDATED: within one frame and never early, but only ${flips} traced flips (needs ${MIN_FLIPS})`
      : 'NOT VALIDATED: a stamp is more than one frame off its frame\'s commit, or before its own paint')
}
