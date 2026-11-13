// What else in the chart widget changes after the candles are on screen (DOM text, outside the canvas).
import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const agg = new Map()
for (const f of j.flips) {
  if (!f.key) continue
  const cf = f.frames.find((x) => x.o && x.o.c !== (f.before && f.before.c) && x.o.c !== 'none'); if (!cf) continue
  const tC = cf.t
  const last = new Map()
  for (const d of f.dom || []) { const k = d.cls; const e = last.get(k) || { first: d.t - tC, n: 0 }; e.last = d.t - tC; e.txt = d.txt; e.n++; last.set(k, e) }
  for (const [k, e] of last) { const a = agg.get(k) || { lasts: [], firsts: [], txt: e.txt, n: 0 }; a.lasts.push(e.last); a.firsts.push(e.first); a.txt = e.txt; a.n += e.n; agg.set(k, a) }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
console.log('element class | flips | first change vs candles (median ms) | LAST change vs candles (median / max ms) | sample text')
for (const [k, a] of [...agg.entries()].sort((x, y) => med(y[1].lasts) - med(x[1].lasts))) {
  if (med(a.lasts) < 60) continue
  console.log(`${k.padEnd(44)} ${String(a.lasts.length).padStart(2)} | ${med(a.firsts).toFixed(0).padStart(6)} | ${med(a.lasts).toFixed(0).padStart(6)} / ${Math.max(...a.lasts).toFixed(0).padStart(6)} | ${a.txt}`)
}
