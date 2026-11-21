// Does the presentation probe load what it measures? Interleaved flip-proof runs on ONE build:
//   off = the light frame sampler WITHOUT the paint probe (--no-paint-probe=1)
//   on  = the light frame sampler WITH the paint probe
//   lean (optional) = --stamp-only=1: the probe and no per-frame sampler at all
// The same instrument (the sampler's `seen` BOTH, and Event Timing's first presentation after the key) is read in
// `off` and `on`; the probe passes when their medians differ by less than one frame. `lean` shows what the
// per-frame sampler itself costs pixels_both.
// usage: node scripts/proofs/probe-cost-check.mjs off=a.json,b.json on=c.json,d.json [lean=e.json]
import { readFileSync } from 'node:fs'
import * as M from './acceptance-matrix-lib.mjs'

const arms = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).map(([k, v]) => [k, v.split(',')]))
const med = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const stats = {}
for (const [arm, files] of Object.entries(arms)) {
  const seen = [], input = [], pixels = []
  for (const f of files) {
    const run = JSON.parse(readFileSync(f, 'utf8'))
    const charts = [run.tf, run.tf2, run.tf3].filter(Boolean).length
    for (const fl of run.flips || []) {
      const s = M.scoreSwitch(fl, charts, run.dwell || 0)
      if (s.seenBothMs != null) seen.push(s.seenBothMs)
      if (s.pixelsBothMs != null) pixels.push(s.pixelsBothMs)
      const ev = (fl.evt || []).find((e) => e.n === 'keydown' && Math.abs(e.s - fl.key) <= 5)
      if (ev) input.push(ev.s + ev.d - fl.key)
    }
  }
  stats[arm] = { switches: seen.length || pixels.length, seen: med(seen), input: med(input), pixels: med(pixels) }
  console.log(`${arm.padEnd(5)} ${String(stats[arm].switches).padStart(3)} switches | seen BOTH median ${stats[arm].seen ?? 'n/a'} ms | Event Timing first presentation median ${stats[arm].input ?? 'n/a'} ms | pixels_both median ${stats[arm].pixels ?? 'n/a'} ms`)
}
if (stats.off && stats.on && stats.off.seen != null && stats.on.seen != null) {
  const d = Math.round((stats.on.seen - stats.off.seen) * 10) / 10
  const di = stats.off.input != null && stats.on.input != null ? Math.round((stats.on.input - stats.off.input) * 10) / 10 : null
  console.log(`probe on - off: seen BOTH ${d} ms${di != null ? `, first presentation ${di} ms` : ''}`)
  console.log(Math.abs(d) < 16.7 && (di == null || Math.abs(di) < 16.7) ? 'PROBE COST UNDER ONE FRAME: the probe does not move what it measures' : 'PROBE COST ONE FRAME OR MORE: the probe moves what it measures')
}
if (stats.on && stats.lean && stats.on.pixels != null && stats.lean.pixels != null) console.log(`per-frame sampler's own cost on pixels_both (on - lean): ${Math.round((stats.on.pixels - stats.lean.pixels) * 10) / 10} ms`)
