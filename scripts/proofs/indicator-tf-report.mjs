// A --tfs run: on each timeframe switch, how far behind its candles was the RS line, and when
// did the weekly request for the symbol on screen leave relative to the click?
import { readFileSync } from 'node:fs'
for (const file of process.argv.slice(2)) {
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const t = JSON.parse(readFileSync(file.replace(/\.json$/, '.tf.json'), 'utf8'))
  console.log(`${file.split(/[\/]/).pop()}  pod uptime ${j.build && j.build.uptime}s`)
  const K = 't:rsLine::rsLine'
  for (const f of t.flips) {
    const cf = f.frames.find((x) => x.o && x.o.c !== (f.before && f.before.c) && x.o.c !== 'none')
    const has = (x) => x && x.s && x.s[K] && !/\|none$/.test(x.s[K]) && x.s[K] !== ((f.before && f.before.s) || {})[K]
    const fill = f.frames.find((x) => has(x.o))
    const wk = f.res.filter((r) => /signature\/columns/.test(r.u) && /tf=W/.test(r.u)).map((r) => `${(r.u.match(/sym=([^&]+)/) || [])[1]} ${Math.round(r.s - f.key)}..${Math.round(r.e - f.key)}`)
    console.log(`  ${f.dir.padEnd(6)} candles +${cf ? Math.round(cf.t - f.key) : '?'} ms; RS line ${fill && cf ? Math.max(0, Math.round(fill.t - cf.t)) + ' ms after its candles' : 'not seen'}${/1W/.test(f.dir) ? ' | weekly requests (ms from the click): ' + (wk.slice(0, 3).join(' | ') || 'none') : ''}`)
  }
}
