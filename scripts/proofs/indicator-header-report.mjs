// When did the chart header's info row stop changing after each flip, relative to the candles?
import { readFileSync } from 'node:fs'
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
for (const file of process.argv.slice(2)) {
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const settle = []; const dashes = []; const starts = new Map()
  for (const f of j.flips) {
    if (!f.key) continue
    const cf = f.frames.find((x) => x.o && x.o.c !== (f.before && f.before.c) && x.o.c !== 'none'); if (!cf) continue
    const vals = (f.dom || []).filter((d) => /^chartMetaVal/.test(d.cls))
    settle.push(vals.length ? Math.round(vals[vals.length - 1].t - cf.t) : 0)
    // a dash written at or after the candle frame = a field that was not ready with the candles
    dashes.push(vals.filter((d) => d.t >= cf.t - 20 && d.txt === '\u2014').length)
    for (const r of f.res) {
      if (/signature|\/bars|preferences|beacon|community|alerts|voice|j2|live-prices/.test(r.u)) continue
      const k = r.u.split('?')[0].replace(/\/[A-Z][A-Z0-9.-]{0,6}$/, '/:sym')
      const e = starts.get(k) || []; e.push(Math.round(r.s - f.key)); starts.set(k, e)
    }
  }
  console.log(`\n${file.split(/[\/]/).pop()}  pre-load ${j.warmSwitch === '1' ? 'OFF' : 'on'}  flips ${settle.length}  pod uptime ${j.build && j.build.uptime}s`)
  console.log(`info row last changed ${med(settle)} ms after the candles (median; worst ${Math.max(...settle)}); dashes written with or after the candles: median ${med(dashes)} per flip, flips with none: ${dashes.filter((d) => d === 0).length} of ${dashes.length}`)
  console.log('request starts relative to the key (median ms; negative = asked before the member arrived):')
  for (const [k, v] of [...starts].sort()) console.log('  ', k.padEnd(38), String(med(v)).padStart(7), `(${v.length} calls)`)
}
