// Inside one subtree: self time by function, for the samples whose stack contains a frame matching <needle>
// (and, with --not=<needle2>, none matching needle2).
// usage: node cpu_under.mjs <file.cpuprofile> <needle e.g. :135141> [top=14] [--not=x]
import { readFileSync } from 'node:fs'
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const needle = process.argv[3]
const top = Number(process.argv[4] || 14)
const notA = (process.argv.find((a) => a.startsWith('--not=')) || '').slice(6)
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id)
const lab = (n) => { const f = n.callFrame; const u = (f.url || '').split('?')[0].split('/').pop().replace(/-[A-Za-z0-9_]{8}\.js$/, ''); return `${f.functionName || '(anon)'}@${u}:${f.lineNumber + 1}:${f.columnNumber + 1}` }
const selfBy = new Map(); const under = new Map(); let total = 0
for (let i = 0; i < p.samples.length; i++) {
  const dt = p.timeDeltas[i + 1] ?? 0
  const chain = []
  for (let x = p.samples[i]; x != null; x = parent.get(x)) chain.push(lab(byId.get(x)))
  if (!chain.some((l) => l.includes(needle))) continue
  if (notA && chain.some((l) => l.includes(notA))) continue
  total += dt
  selfBy.set(chain[0], (selfBy.get(chain[0]) || 0) + dt)
  for (const l of new Set(chain)) under.set(l, (under.get(l) || 0) + dt)
}
console.log(`under ${needle}${notA ? ' (not ' + notA + ')' : ''}: ${(total / 1000).toFixed(1)} ms`)
console.log(' self:'); for (const [k, us] of [...selfBy].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log((us / 1000).toFixed(1).padStart(8), k)
console.log(' total (frames in these stacks):'); for (const [k, us] of [...under].sort((a, b) => b[1] - a[1]).slice(0, top + 10)) console.log((us / 1000).toFixed(1).padStart(8), k)
