// Where did the main thread spend the 700 ms after a flip? Reads a .cpuprofile written by
// indicator-flip-proof.mjs --cpuprofile=i and prints the heaviest functions, by time spent IN them
// (self) and by time spent in them and everything they call (total).
//
// Usage: node scripts/proofs/indicator-cpu-report.mjs <file.cpuprofile> [top=30] [--from=ms --to=ms]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const top = Number(process.argv.find((a) => /^\d+$/.test(a)) || 30)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d }
const p = JSON.parse(readFileSync(file, 'utf8'))
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id)

// time per sample: the delta to the next sample
const from = arg('from', 0) * 1000
const to = arg('to', Infinity) * 1000
const self = new Map()
let t = 0
let total = 0
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i + 1] ?? 0
  t += p.timeDeltas[i] ?? 0
  if (t < from || t > to) continue
  self.set(p.samples[i], (self.get(p.samples[i]) || 0) + dt)
  total += dt
}
const label = (n) => {
  const f = n.callFrame
  const url = (f.url || '').split('?')[0].split('/').slice(-2).join('/')
  return `${f.functionName || '(anonymous)'}  ${url}:${f.lineNumber + 1}:${f.columnNumber + 1}`
}
const idle = new Set(['(idle)', '(program)', '(garbage collector)'])
const selfBy = new Map()
const totalBy = new Map()
for (const [id, us] of self) {
  const n = byId.get(id)
  const k = label(n)
  selfBy.set(k, (selfBy.get(k) || 0) + us)
  // total: credit every DISTINCT function on the stack once
  const seen = new Set()
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const kk = label(byId.get(cur))
    if (seen.has(kk)) continue
    seen.add(kk)
    totalBy.set(kk, (totalBy.get(kk) || 0) + us)
  }
}
const ms = (us) => (us / 1000).toFixed(1).padStart(7)
const busy = [...selfBy].filter(([k]) => !idle.has(k.split('  ')[0])).reduce((a, [, v]) => a + v, 0)
console.log(`profile ${(total / 1000).toFixed(0)} ms sampled; busy ${(busy / 1000).toFixed(0)} ms (excluding idle/program)`)
console.log('\n=== SELF time (ms) ===')
for (const [k, v] of [...selfBy].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(ms(v), k)
console.log('\n=== TOTAL time, the function and everything under it (ms) ===')
for (const [k, v] of [...totalBy].filter(([k]) => !/^\(root\)|^\(program\)|^\(idle\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(ms(v), k)
