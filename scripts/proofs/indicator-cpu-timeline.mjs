// A flip's CPU profile as a timeline: per 50 ms, how much main-thread time, and how much of it
// was under the chart library's setData, under React, in GC, and in the lane's landing code.
import { readFileSync } from 'node:fs'
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id)
const tagOf = new Map()
const tags = (id) => {
  if (tagOf.has(id)) return tagOf.get(id)
  const set = new Set(parent.has(id) ? tags(parent.get(id)) : [])
  const cf = byId.get(id).callFrame
  const f = cf.functionName || ''; const u = cf.url || ''
  if (f === 'setData' && /vendor-charts/.test(u)) set.add('setData')
  if (/vendor-react/.test(u)) set.add('react')
  if (f === '(garbage collector)') set.add('gc')
  if (f === 'Line' && /vendor-charts/.test(u)) set.add('drawLines')
  if (/onsuccess|IDB/.test(f)) set.add('idb')
  tagOf.set(id, set)
  return set
}
const B = 50
const buckets = []
let t = 0
for (let i = 0; i < p.samples.length; i++) {
  const dt = (p.timeDeltas[i + 1] ?? 0) / 1000
  const id = p.samples[i]
  const f = byId.get(id).callFrame.functionName
  const b = Math.floor(t / B)
  buckets[b] = buckets[b] || { busy: 0, setData: 0, react: 0, gc: 0, drawLines: 0, idb: 0 }
  if (f !== '(idle)' && f !== '(program)') {
    buckets[b].busy += dt
    for (const k of tags(id)) buckets[b][k] += dt
  }
  t += dt
}
console.log('ms from profile start | busy | under setData | under React | GC | drawing lines | idb callbacks')
buckets.forEach((b, i) => { if (b && b.busy > 2) console.log(String(i * B).padStart(5), '|', String(Math.round(b.busy)).padStart(4), '|', String(Math.round(b.setData)).padStart(4), '|', String(Math.round(b.react)).padStart(4), '|', String(Math.round(b.gc)).padStart(3), '|', String(Math.round(b.drawLines)).padStart(3), '|', String(Math.round(b.idb)).padStart(3)) })
const tot = buckets.reduce((a, b) => { if (b) for (const k in b) a[k] = (a[k] || 0) + b[k]; return a }, {})
console.log('totals', Object.entries(tot).map(([k, v]) => `${k} ${Math.round(v)}`).join(' | '))
