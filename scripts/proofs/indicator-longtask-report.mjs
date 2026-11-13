// What the main thread paid for each flip: the long tasks (>50 ms) in the 400 ms after the key,
// when the first text of the new chart reached the page, and when the last series changed.
// One column per run, so a before and an after read side by side.
//
// Usage: node scripts/proofs/indicator-longtask-report.mjs <run.json> [<run.json> ...] [--rows]
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const rows = process.argv.includes('--rows')
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const p90 = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : null }
const max = (xs) => { const s = xs.filter((x) => x != null); return s.length ? Math.max(...s) : null }

for (const file of files) {
  const o = JSON.parse(readFileSync(file, 'utf8'))
  const per = o.flips.map((f) => {
    const k = f.key
    const long = (f.long || []).filter((x) => x.s >= k - 5 && x.s < k + 400)
    const first = long[0]
    const dom = (f.dom || []).find((d) => d.t >= k)
    const frames = (f.frames || []).filter((x) => x.t >= k)
    // the frame in which the candles changed, and the last frame in which any series changed
    const candle = frames.find((x) => x.o && f.before && x.o.c !== f.before.c)
    const last = frames[frames.length - 1]
    return {
      i: f.i,
      // the bars the chart FIRST painted with (a chart can paint 600 and deepen later in the dwell)
      bars: Number(String((candle && candle.o.c) || '').split('|')[0]) || null,
      endBars: Number(String((f.end && f.end.c) || '').split('|')[0]) || null,
      firstLong: first ? first.d : 0,
      longTotal: long.reduce((a, x) => a + x.d, 0),
      longCount: long.length,
      text: dom ? Math.round(dom.t - k) : null,
      candles: candle ? Math.round(candle.t - k) : null,
      settled: last ? Math.round(last.t - k) : null,
    }
  })
  const deep = per.filter((r) => r.bars && r.bars >= 3000)
  const line = (name, set) => `${name.padEnd(22)} first task ${String(med(set.map((r) => r.firstLong))).padStart(4)} ms median (${p90(set.map((r) => r.firstLong))} p90, ${max(set.map((r) => r.firstLong))} max)`
    + ` | all long tasks ${String(med(set.map((r) => r.longTotal))).padStart(4)} ms`
    + ` | new text on page ${String(med(set.map((r) => r.text))).padStart(4)} ms`
    + ` | candles ${String(med(set.map((r) => r.candles))).padStart(4)} ms | last series change ${String(med(set.map((r) => r.settled))).padStart(4)} ms`
  console.log(`\n${file.split(/[\\/]/).pop()}  list "${o.list && o.list.name}"  dwell ${o.dwell}  ${o.override ? `OVERRIDE ${o.override.part} (ran ${o.override.ran})` : 'as shipped'}  pre-load ${o.warmSwitch === '1' ? 'OFF' : 'on'}  pod uptime ${o.build && o.build.uptime}s`)
  console.log(line(`all ${per.length} flips`, per))
  console.log(line(`${deep.length} with 3,000+ bars`, deep))
  console.log(`flips with no long task at all: ${per.filter((r) => r.longCount === 0).length} of ${per.length}`)
  if (rows) console.table(per)
}
