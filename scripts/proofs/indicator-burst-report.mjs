// A held-key run: when did the landing chart's RS line arrive, and what was the lane doing?
import { readFileSync } from 'node:fs'
for (const file of process.argv.slice(2)) {
  const o = JSON.parse(readFileSync(file, 'utf8'))
  const K = 't:rsLine::rsLine'
  const f = o.flips[o.flips.length - 1]; const k = f.key
  const cf = f.frames.find((x) => x.o && x.o.c !== (f.before && f.before.c) && x.o.c !== 'none')
  const has = (x) => x && x.s && x.s[K] && !/\|none$/.test(x.s[K]) && x.s[K] !== ((f.before && f.before.s) || {})[K]
  const fill = f.frames.find((x) => has(x.o))
  const keys = o.flips.map((x) => x.key).filter((x) => x != null)
  const gaps = keys.slice(1).map((t, i) => t - keys[i]).sort((a, b) => a - b)
  let all = []
  for (const fl of o.flips) for (const r of fl.res || []) if (/signature\/columns/.test(r.u)) all.push({ sym: (r.u.match(/sym=([^&]+)/) || [])[1], s: Math.round(r.s - k), e: Math.round(r.e - k), kind: ((r.st || '').match(/rs\(([a-z]+)\)/) || [, '?'])[1], rs: ((r.st || '').match(/rs\([a-z]+\)=(\d+)/) || [, ''])[1] })
  const seen = new Set(); all = all.filter((r) => { const id = `${r.sym}|${r.s}`; if (seen.has(id)) return false; seen.add(id); return true })
  const inflight = all.filter((r) => r.s < 0 && r.e > 0)
  const during = all.filter((r) => r.s >= keys[0] - k && r.s < 0)
  console.log(`${file.split(/[\/]/).pop()}  list ${o.list && o.list.name}  pod uptime ${o.build && o.build.uptime}s  ${keys.length} keys, median step ${Math.round(gaps[Math.floor(gaps.length / 2)])} ms`)
  console.log(`  LANDING chart: candles +${cf ? Math.round(cf.t - k) : '?'} ms after the last key; RS line ${fill && cf ? '+' + Math.round(fill.t - cf.t) + ' ms after its candles' : 'NOT SEEN in the dwell'}`)
  console.log(`  lane requests started during the run: ${during.length} (${during.filter((r) => r.kind === 'cold').length} cold) | in flight when the key was released: ${inflight.length}`)
  console.log('  after the last key:', all.filter((r) => r.s >= 0).slice(0, 4).map((r) => `${r.sym} ${r.s}..${r.e} ${r.kind}${r.rs ? '=' + r.rs : ''}`).join(' | ') || 'none')
}
