// What held IndexedDB busy at the moment a chart asked it for bars (a run with --idbtrace).
//
// For every flip: the chart's own bars read (the first `get` on the bars store after the key),
// how long it took, and every READWRITE transaction on the same database that was open while it
// waited (created before it and finished after it was asked): its stores, how many requests it
// carried, how long it had been open, and what it was writing. Then totals over the run: which
// writers are the ones a read waits behind.
//
// usage: node scripts/proofs/idb-trace-report.mjs <run.json> [--store=bars] [--slow=100]
import { readFileSync } from 'node:fs'

const j = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const SLOW = Number(arg('slow', '100'))
const T = j.idbTrace
if (!T) { console.log('no idbTrace in this run (record it with --idbtrace)'); process.exit(1) }
const tx = T.tx
const req = T.req
const storeArg = arg('store', '')
// the bars store: the store most `get`s go to, unless named
const counts = {}
for (const r of req) if (r.op === 'get') counts[r.store] = (counts[r.store] || 0) + 1
const BARS = storeArg || Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]
console.log(`${process.argv[2].split(/[\\/]/).pop()} | flips ${j.flips.length} | transactions ${tx.length} | requests ${req.length} | bars store "${BARS}"`)
const byStore = {}
for (const t of tx) {
  const k = `${t.db}/${t.stores} ${t.mode}`
  const s = byStore[k] || (byStore[k] = { n: 0, ms: [], reqs: 0 })
  s.n++; s.reqs += t.n
  if (t.end != null) s.ms.push(t.end - t.t0)
}
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN }
console.log('\ntransactions by database/store and mode:  count | requests | open ms median / p90 / max')
for (const [k, s] of Object.entries(byStore).sort((a, b) => b[1].n - a[1].n).slice(0, 14)) {
  console.log(`   ${k.padEnd(52)} ${String(s.n).padStart(5)} | ${String(s.reqs).padStart(6)} | ${pct(s.ms, 0.5).toFixed(0)} / ${pct(s.ms, 0.9).toFixed(0)} / ${Math.max(0, ...s.ms).toFixed(0)}`)
}

const blockers = {}
const reads = []
for (const f of j.flips) {
  const t0 = f.key
  const g = req.find((r) => r.op === 'get' && r.store === BARS && r.t0 >= t0 - 5 && r.t0 <= t0 + 400)
  if (!g) continue
  const took = g.end != null ? g.end - g.t0 : null
  const gtx = tx[g.tx]
  const open = tx.filter((t) => t !== gtx && t.mode === 'readwrite' && gtx && t.db === gtx.db
    && t.t0 <= g.t0 && (t.end == null || t.end > g.t0))
  reads.push({ i: f.i, took, open })
  for (const t of open) {
    const k = `${t.stores} (${t.n} req)`
    const w = req.filter((r) => r.tx === tx.indexOf(t) && r.op !== 'get').map((r) => `${r.op} ${r.key}`)
    const b = blockers[t.stores] || (blockers[t.stores] = { flips: 0, reqs: 0, keys: new Set() })
    b.flips++; b.reqs += t.n; for (const x of w.slice(0, 3)) b.keys.add(x)
    void k
  }
}
const tooks = reads.map((r) => r.took).filter((x) => x != null)
console.log(`\nthe chart's bars read after the key: ${reads.length} flips | median ${pct(tooks, 0.5).toFixed(0)} ms, p90 ${pct(tooks, 0.9).toFixed(0)}, max ${Math.max(...tooks).toFixed(0)}`)
console.log(`reads over ${SLOW} ms: ${reads.filter((r) => r.took > SLOW).length}; of those, waiting on an open readwrite transaction: ${reads.filter((r) => r.took > SLOW && r.open.length).length}`)
for (const r of reads.filter((x) => x.took > SLOW)) {
  console.log(`  #${r.i} read ${r.took.toFixed(0)} ms | open writers: ${r.open.map((t) => `${t.stores} ${t.n}req open ${((t.end ?? NaN) - t.t0).toFixed(0)}ms`).join('; ') || 'none'}`)
}
console.log('\nwriters a read waited behind (any flip):')
for (const [k, b] of Object.entries(blockers).sort((a, b) => b[1].flips - a[1].flips)) {
  console.log(`   ${k.padEnd(30)} on ${b.flips} reads | ${b.reqs} requests | e.g. ${[...b.keys].slice(0, 3).join(', ')}`)
}
