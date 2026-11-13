// Reads a flip-proof result. Per flip: when the NEW symbol's candles were on the chart, and for each
// indicator series how long after that its own new-symbol data arrived, and what it showed meanwhile
// (BLANK = nothing drawn, STALE = still the previous symbol's line).
import { readFileSync } from 'node:fs'

const j = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const verbose = process.argv.includes('-v')
const quiet = process.argv.includes('-q')
if (j.warmSwitch === '1') console.log('⛔ THIS RUN HAD THE INDICATOR PRE-LOAD SWITCHED OFF (uct.indwarm.off=1): it is a CONTROL, not a result')
console.log(`set=${j.set} tf=${j.tf} list=${j.list && j.list.name} dwell=${j.dwell} restore=${j.boardRestore} pack=${JSON.stringify(j.pack || null)} ${j.error ? 'ERROR ' + j.error : ''}`)
const isBlank = (v) => v === undefined || v === null || /\|none$/.test(String(v)) || /^0\|/.test(String(v))
const stat = new Map()
const candleMs = []
const clearMs = []
let shallow = 0
for (const f of j.flips) {
  if (!f.key) { console.log(`#${f.i} no key seen`); continue }
  const t0 = f.key
  const beforeC = f.before && f.before.c
  const cf = f.frames.find((x) => x.o && x.o.c !== beforeC && x.o.c !== 'none')
  const cleared = f.frames.find((x) => x.o && x.o.c === 'none')
  if (!cf) { console.log(`#${f.i} candles never changed`); continue }
  const tC = cf.t - t0
  candleMs.push(tC)
  if (cleared && cleared.t < cf.t) clearMs.push(cf.t - cleared.t)
  const firstCount = Number(String(cf.o.c).split('|')[0])
  if (firstCount < 200) shallow++
  const keys = new Set(Object.keys((f.before && f.before.s) || {}))
  for (const x of f.frames) for (const k of Object.keys((x.o && x.o.s) || {})) keys.add(k)
  const per = []
  for (const k of [...keys].sort()) {
    const vb = f.before && f.before.s ? f.before.s[k] : undefined
    const atC = cf.o.s ? cf.o.s[k] : undefined
    const newFrame = f.frames.find((x) => { const v = x.o && x.o.s ? x.o.s[k] : undefined; return !isBlank(v) && v !== vb })
    const lag = newFrame ? (newFrame.t - t0) - tC : null
    const state = lag !== null && lag <= 0 ? 'ok' : (isBlank(atC) ? 'BLANK' : (atC === vb ? 'STALE' : 'ok'))
    per.push({ k, lag, state })
    if (!stat.has(k)) stat.set(k, { lags: [], blank: 0, stale: 0, never: 0, n: 0 })
    const s = stat.get(k)
    s.n++
    if (lag === null) s.never++
    else s.lags.push(Math.max(0, lag))
    if (state === 'BLANK') s.blank++
    if (state === 'STALE') s.stale++
  }
  if (!quiet) {
    const late = per.filter((p) => p.lag === null || p.lag > 0)
    console.log(`#${String(f.i).padStart(2)} ${f.dir || ''} candles +${tC.toFixed(0)}ms (${cf.o.c.split('|')[0]} bars${cleared && cleared.t < cf.t ? `, chart empty ${(cf.t - cleared.t).toFixed(0)}ms first` : ''}) | late: ` + (late.length ? late.map((p) => `${p.k.replace('::', ':')} ${p.lag === null ? 'NEVER' : '+' + p.lag.toFixed(0)} ${p.state}`).join('  ') : 'none'))
    if (verbose) console.log('     net: ' + f.res.filter((r) => r.s >= t0 - 5 && /bars|signature/.test(r.u)).map((r) => `${r.u.split('?')[0].replace('/api/', '')}${/defId=([^&]+)/.test(r.u) ? ':' + RegExp.$1 : ''}${/tf=([^&]+)/.test(r.u) ? '[' + RegExp.$1 + ']' : ''}@${Math.round(r.s - t0)}→${Math.round(r.e - t0)}${r.st ? ' {' + r.st + '}' : ''}`).join('  '))
  }
}
const sorted = (a) => a.filter(Number.isFinite).sort((x, y) => x - y)
const pct = (a, p) => { const s = sorted(a); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN }
console.log(`\n=== candles after key press: median ${pct(candleMs, 0.5).toFixed(0)} ms, p90 ${pct(candleMs, 0.9).toFixed(0)}, max ${pct(candleMs, 1).toFixed(0)} (${candleMs.length} flips; ${clearMs.length} went empty first, median ${pct(clearMs, 0.5).toFixed(0)} ms; ${shallow} first-painted <200 bars)`)
console.log('=== ms each series trailed its candles: median / p90 / max | flips late | blank | stale | never')
for (const [k, s] of [...stat.entries()].sort()) {
  const late = s.lags.filter((x) => x > 0).length + s.never
  console.log(`  ${k.padEnd(28)} ${pct(s.lags, 0.5).toFixed(0).padStart(5)} / ${pct(s.lags, 0.9).toFixed(0).padStart(5)} / ${pct(s.lags, 1).toFixed(0).padStart(5)} | ${String(late).padStart(2)}/${s.n} | ${s.blank} | ${s.stale} | ${s.never}`)
}
