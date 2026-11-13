// How long each small per-symbol request took in a capture (median / max / calls).
import { readFileSync } from 'node:fs'
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
for (const file of process.argv.slice(2)) {
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const dur = new Map()
  for (const f of j.flips) for (const r of f.res) {
    if (/signature|\/bars|preferences|beacon|community|alerts|voice|j2|live-prices/.test(r.u)) continue
    const k = r.u.split('?')[0].replace(/\/[A-Z][A-Z0-9.-]{0,6}$/, '/:sym')
    const e = dur.get(k) || []; e.push(r.e - r.s); dur.set(k, e)
  }
  console.log(`${file.split(/[\/]/).pop()}  pod uptime ${j.build && j.build.uptime}s`)
  for (const [k, v] of [...dur].sort((a, b) => med(b[1]) - med(a[1]))) console.log('  ', k.padEnd(36), 'took', String(Math.round(med(v))).padStart(5), 'ms median,', String(Math.round(Math.max(...v))).padStart(5), 'max,', v.length, 'calls')
}
