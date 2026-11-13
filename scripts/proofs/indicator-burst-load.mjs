// A held-key run: what did the browser ask the pod for, and how long did the pod take?
import { readFileSync } from 'node:fs'
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null }
for (const file of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(file, 'utf8'))
  const last = o.flips[o.flips.length - 1]; const k = last.key
  const all = []; const seen = new Set()
  for (const f of o.flips) for (const r of f.res || []) { const id = r.u + '|' + r.s; if (seen.has(id)) continue; seen.add(id); all.push(r) }
  const t0 = o.flips.find((f) => f.key != null).key
  const run = all.filter((r) => r.s >= t0 - 200 && r.s < k + 6000)
  const by = new Map()
  for (const r of run) { const kk = r.u.split('?')[0].replace(/\/[A-Z][A-Z0-9.^-]{0,7}$/, '/:sym'); const e = by.get(kk) || []; e.push(r.e - r.s); by.set(kk, e) }
  // the most requests the pod held for this browser at one moment
  const ev = []; for (const r of run) { ev.push([r.s, 1]); ev.push([r.e, -1]) }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]); let cur = 0, peak = 0, atRelease = 0
  for (const [t, d] of ev) { cur += d; if (cur > peak) peak = cur; if (t <= k) atRelease = cur }
  console.log(`\n${file.split(/[\/]/).pop()} | pre-load ${o.warmSwitch === '1' ? 'OFF' : 'on'} | run ${Math.round((k - t0) / 100) / 10} s | requests from first key to 6 s after the last: ${run.length} | most in flight at once: ${peak} | in flight when the key was released: ${atRelease}`)
  for (const [kk, v] of [...by].sort((a, b) => b[1].length - a[1].length).slice(0, 10)) console.log('   ', String(v.length).padStart(4), 'x', kk.padEnd(38), 'median', String(med(v)).padStart(5), 'ms  max', Math.round(Math.max(...v)))
}
