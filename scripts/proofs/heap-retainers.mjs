// What keeps chart data alive? Reads a V8 .heapsnapshot (soak.mjs --heap-snapshot, or DevTools > Memory)
// and, for the arrays that look like chart series data (1,000+ elements whose first element carries a
// `time` plus `open`/`value`), counts them and prints the retainer chains that hold them, grouped.
//
// Why: the 2026-11-12 market-day soak showed the renderer heap floor climbing ~150-230 MB/h; a sampling
// heap profile put the retained bytes in StockChart's per-tick memos (volData, ohlcData, closeData). Many
// generations of those arrays were alive at once; this names what holds them.
//
// Usage: node scripts/proofs/heap-retainers.mjs proof-output/heap-2026-11-12.heapsnapshot [--samples=40]
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) throw new Error('usage: heap-retainers.mjs <file.heapsnapshot>')
const SAMPLES = Number((process.argv.find((a) => a.startsWith('--samples=')) || '--samples=40').split('=')[1])

// A real snapshot is ~1 GB: past V8's string limit, so it cannot be JSON.parse'd whole. The numeric tables
// (nodes, edges) are scanned straight from the bytes into typed arrays; only the header and the strings
// table go through JSON.parse.
const buf = readFileSync(file)
const at = (key) => { const i = buf.indexOf(key); if (i < 0) throw new Error(`no ${key} in snapshot`); return i + Buffer.byteLength(key) }
function numbers(key) {
  let i = at(key)
  const out = []
  let chunk = new Uint32Array(1 << 22), k = 0, cur = 0, inNum = false
  for (; i < buf.length; i++) {
    const c = buf[i]
    if (c >= 48 && c <= 57) { cur = cur * 10 + (c - 48); inNum = true; continue }
    if (inNum) { chunk[k++] = cur; cur = 0; inNum = false; if (k === chunk.length) { out.push(chunk); chunk = new Uint32Array(1 << 22); k = 0 } }
    if (c === 93) break // ]
  }
  out.push(chunk.subarray(0, k))
  const total = out.reduce((a, b) => a + b.length, 0)
  const all = new Uint32Array(total)
  let o = 0
  for (const part of out) { all.set(part, o); o += part.length }
  return all
}
const headEnd = buf.indexOf('"nodes":')
const snapHeader = JSON.parse(buf.subarray(0, headEnd).toString('utf8').replace(/,\s*$/, '') + '}')
const strStart = at('"strings":')
const strEnd = buf.lastIndexOf(']') + 1
const snap = { snapshot: snapHeader.snapshot, nodes: numbers('"nodes":'), edges: numbers('"edges":'), strings: JSON.parse(buf.subarray(strStart, strEnd).toString('utf8')) }
const meta = snap.snapshot.meta
const NF = meta.node_fields.length
const EF = meta.edge_fields.length
const nodeTypes = meta.node_types[0]
const edgeTypes = meta.edge_types[0]
const iType = meta.node_fields.indexOf('type')
const iName = meta.node_fields.indexOf('name')
const iEdges = meta.node_fields.indexOf('edge_count')
const iSelf = meta.node_fields.indexOf('self_size')
const eType = meta.edge_fields.indexOf('type')
const eName = meta.edge_fields.indexOf('name_or_index')
const eTo = meta.edge_fields.indexOf('to_node')
const { nodes, edges, strings } = snap
const nodeCount = nodes.length / NF

const firstEdge = new Uint32Array(nodeCount + 1)
for (let i = 0, e = 0; i < nodeCount; i++) { firstEdge[i] = e; e += nodes[i * NF + iEdges] * EF }
firstEdge[nodeCount] = edges.length

const type = (n) => nodeTypes[nodes[n * NF + iType]]
const name = (n) => strings[nodes[n * NF + iName]]
const edgeLabel = (e) => {
  const t = edgeTypes[edges[e + eType]]
  const v = edges[e + eName]
  return t === 'element' || t === 'hidden' ? `[${v}]` : String(strings[v])
}

// Reverse edges (retainers), skipping weak edges.
const retCount = new Uint32Array(nodeCount)
for (let n = 0; n < nodeCount; n++) {
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF) {
    if (edgeTypes[edges[e + eType]] === 'weak') continue
    retCount[edges[e + eTo] / NF]++
  }
}
const retStart = new Uint32Array(nodeCount + 1)
for (let i = 0; i < nodeCount; i++) retStart[i + 1] = retStart[i] + retCount[i]
const retFrom = new Uint32Array(retStart[nodeCount])
const retEdge = new Uint32Array(retStart[nodeCount])
const fill = retStart.slice(0, nodeCount)
for (let n = 0; n < nodeCount; n++) {
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF) {
    if (edgeTypes[edges[e + eType]] === 'weak') continue
    const to = edges[e + eTo] / NF
    retFrom[fill[to]] = n
    retEdge[fill[to]] = e
    fill[to]++
  }
}

const propNames = (n) => {
  const out = new Set()
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF) if (edgeTypes[edges[e + eType]] === 'property') out.add(String(strings[edges[e + eName]]))
  return out
}
// An Array object's elements live in its hidden "elements" backing store.
const elementCount = (n) => {
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF) {
    if (edgeTypes[edges[e + eType]] === 'internal' && String(strings[edges[e + eName]]) === 'elements') {
      const store = edges[e + eTo] / NF
      return { store, count: (firstEdge[store + 1] - firstEdge[store]) / EF }
    }
  }
  return null
}
const firstElement = (store) => {
  for (let e = firstEdge[store]; e < firstEdge[store + 1]; e += EF) {
    if (edgeTypes[edges[e + eType]] === 'element' || edgeTypes[edges[e + eType]] === 'hidden') return edges[e + eTo] / NF
  }
  return null
}

const series = []
for (let n = 0; n < nodeCount; n++) {
  if (type(n) !== 'object' || name(n) !== 'Array') continue
  // V8 reports a JS array's items as `element` edges on the Array node itself; some builds route them
  // through an internal `elements` store instead. Count whichever is present.
  let count = 0
  for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += EF) if (edgeTypes[edges[e + eType]] === 'element') count++
  let holder = n
  if (count < 1000) {
    const el = elementCount(n)
    if (!el || el.count < 1000) continue
    holder = el.store
    count = el.count
  }
  const el = { count }
  const f = firstElement(holder)
  if (f == null || type(f) !== 'object') continue
  const p = propNames(f)
  if (!p.has('time') || !(p.has('open') || p.has('value'))) continue
  series.push({ n, count: el.count, kind: p.has('open') ? 'ohlc' : (p.has('color') ? 'value+color' : 'value') })
}
const byKind = {}
for (const s of series) byKind[s.kind] = (byKind[s.kind] || 0) + 1
console.log(`${nodeCount} nodes; chart-data arrays (>=1000 points): ${series.length}`, byKind)

// Shortest retainer chain from each sampled array to a GC root (BFS over retainers).
const isRoot = (n) => type(n) === 'synthetic' || name(n) === '(GC roots)' || name(n).startsWith('(')
function chain(start) {
  const prev = new Map([[start, null]])
  const q = [start]
  while (q.length) {
    const n = q.shift()
    if (n !== start && isRoot(n)) {
      const path = []
      let cur = n
      while (cur != null && cur !== start) { const [from, e] = prev.get(cur) || []; path.push(`${name(cur).slice(0, 40)}.${edgeLabel(e)}`); cur = from }
      return path.reverse()
    }
    for (let i = retStart[n]; i < retStart[n + 1]; i++) {
      const r = retFrom[i]
      if (prev.has(r)) continue
      prev.set(r, [n, retEdge[i]])
      if (prev.size > 200000) return ['(search limit)']
      q.push(r)
    }
  }
  return ['(no root found)']
}
const groups = new Map()
const step = Math.max(1, Math.floor(series.length / SAMPLES))
for (let i = 0; i < series.length; i += step) {
  const c = chain(series[i].n)
  // Group by the nearest retainers (what is directly holding the array), not the whole path.
  const key = c.slice(-6).join(' <- ')
  const g = groups.get(key) || { count: 0, kind: series[i].kind, example: c }
  g.count++
  groups.set(key, g)
}
for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
  console.log(`\n${g.count} sampled (${g.kind}) held by:\n  ${g.example.slice(-10).reverse().join('\n  <- ')}`)
}

// Name the closures on the chains: closure --shared--> SharedFunctionInfo --script--> Script (its name is
// the source URL), with the line/column from the snapshot's `locations` table.
if (process.argv.includes('--closures')) {
  const locs = new Map()
  try {
    const L = numbers('"locations":')
    const lf = snap.snapshot.meta.location_fields || ['object_index', 'script_id', 'line', 'column']
    for (let i = 0; i < L.length; i += lf.length) locs.set(L[i] / NF, { line: L[i + 2] + 1, col: L[i + 3] + 1 })
  } catch { /* no locations table */ }
  const scriptOf = (closure) => {
    for (let e = firstEdge[closure]; e < firstEdge[closure + 1]; e += EF) {
      if (String(strings[edges[e + eName]]) !== 'shared') continue
      const sfi = edges[e + eTo] / NF
      for (let e2 = firstEdge[sfi]; e2 < firstEdge[sfi + 1]; e2 += EF) {
        const lbl = String(strings[edges[e2 + eName]])
        if (lbl === 'script' || lbl === 'script_or_debug_info') return name(edges[e2 + eTo] / NF)
      }
    }
    return '?'
  }
  const seen = new Map()
  for (let i = 0; i < series.length; i++) {
    const prevMap = new Map([[series[i].n, null]]); const q = [series[i].n]; let steps = 0
    while (q.length && steps++ < 4000) {
      const n = q.shift()
      for (let j = retStart[n]; j < retStart[n + 1]; j++) {
        const r = retFrom[j]; if (prevMap.has(r)) continue; prevMap.set(r, n); q.push(r)
        if (type(r) === 'closure') {
          const key = `${name(r)} @ ${scriptOf(r).replace(/^.*\/assets\//, 'assets/')}:${locs.get(r)?.line ?? '?'}:${locs.get(r)?.col ?? '?'}`
          seen.set(key, (seen.get(key) || 0) + 1)
        }
      }
    }
  }
  console.log('\nclosures within reach of chart-data arrays (count of arrays reaching each):')
  for (const [k, v] of [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(String(v).padStart(5), k)
}
