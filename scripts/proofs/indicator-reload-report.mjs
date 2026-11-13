// How long the FIRST chart of a page load waits for its indicators.
// Reads the `reloads` an indicator-flip-proof.mjs --reloads=N run recorded: for each reload, the
// frame the candles appeared in (ms from the start of the document) and how long after it each
// series first had a value.
//
// Usage: node scripts/proofs/indicator-reload-report.mjs <run.json> [<run.json> ...] [--rows]
import { readFileSync } from 'node:fs'

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const rows = process.argv.includes('--rows')
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }

for (const file of files) {
  const o = JSON.parse(readFileSync(file, 'utf8'))
  const per = []
  for (const [i, r] of (o.reloads || []).entries()) {
    if (!r || !r.frames || !r.frames.length) { per.push({ i, note: 'no frames' }); continue }
    const candle = r.frames.find((f) => f.o.c > 0)
    if (!candle) { per.push({ i, note: 'no candles' }); continue }
    const keys = new Set()
    for (const f of r.frames) for (const k of Object.keys(f.o.s)) keys.add(k)
    const behind = {}
    for (const k of keys) {
      const f = r.frames.find((x) => x.o.s[k] === 1)
      behind[k] = f ? f.t - candle.t : null
    }
    // sparse marker series (a dot only on some bars) can honestly have no value at all
    const server = Object.entries(behind).filter(([k]) => /^t:rs/.test(k) && !/::dot/.test(k))
    const native = Object.entries(behind).filter(([k]) => !/^t:rs/.test(k))
    const sig = (r.res || []).filter((x) => /columns/.test(x.u))
    per.push({
      i, sym: r.sym, candles: candle.t,
      nativeWorst: Math.max(...native.map(([, v]) => (v == null ? Infinity : v))),
      serverFirst: Math.min(...server.map(([, v]) => (v == null ? Infinity : v))),
      serverWorst: Math.max(...server.map(([, v]) => (v == null ? Infinity : v))),
      serverNever: server.filter(([, v]) => v == null).map(([k]) => k.replace('t:', '')).join(' ') || '',
      askAnswered: sig.length ? Math.max(...sig.map((x) => x.e)) - candle.t : null,
    })
  }
  const ok = per.filter((p) => p.candles != null)
  console.log(`\n${file.split(/[\\/]/).pop()}  ${o.localStorage ? JSON.stringify(o.localStorage) : 'no switch set'}  reloads ${per.length}`)
  console.log(`candles ${med(ok.map((p) => p.candles))} ms after the document started (median)`)
  console.log(`server-lane series behind their candles: first ${med(ok.map((p) => p.serverFirst))} ms, last ${med(ok.map((p) => p.serverWorst))} ms (median); the server's own answer landed ${med(ok.map((p) => p.askAnswered))} ms after the candles`)
  console.log(`browser-computed series behind their candles: ${med(ok.map((p) => p.nativeWorst))} ms (median of the slowest)`)
  if (rows) console.table(per)
}
