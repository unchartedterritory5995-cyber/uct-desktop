// Who is responsible? Total time under each APP-level frame (StockChart / engine chunks), split by
// which library entry it went into (setData, data, applyOptions, ...).
// usage: node cpu_tree.mjs <file.cpuprofile> [minMs=4]
import { readFileSync } from 'node:fs'
const p = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const minMs = Number(process.argv[3] || 4)
const byId = new Map(p.nodes.map((n) => [n.id, n]))
const parent = new Map()
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id)
const self = new Map()
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) || 0) + (p.timeDeltas[i + 1] ?? 0))
const lab = (n) => { const f = n.callFrame; const u = (f.url || '').split('?')[0].split('/').pop().replace(/-[A-Za-z0-9_]{8}\.js$/, ''); return `${f.functionName || '(anon)'}@${u}:${f.lineNumber + 1}:${f.columnNumber + 1}` }
const isLib = (n) => /vendor-charts/.test(n.callFrame.url || '')
const isApp = (n) => /(StockChart|lineIdentity|interpret|index)-/.test(n.callFrame.url || '') && !/vendor/.test(n.callFrame.url)
const agg = new Map()
for (const [id, us] of self) {
  // walk up: the first library frame entered from an app frame (the library ENTRY), and that app frame
  const chain = []
  for (let x = id; x != null; x = parent.get(x)) chain.push(byId.get(x))
  let entry = null, caller = null
  for (let i = chain.length - 1; i >= 0; i--) {           // from the root down
    if (isLib(chain[i]) && i + 1 < chain.length && !isLib(chain[i + 1])) { entry = chain[i]; caller = chain.slice(i + 1).find(isApp) || null }
  }
  // the innermost such transition wins (it is overwritten going down)
  const k = entry ? `${lab(entry)}  <=  ${caller ? lab(caller) : '?'}` : `(no library)  ${lab(chain.find(isApp) || chain[0])}`
  agg.set(k, (agg.get(k) || 0) + us)
}
const rows = [...agg].map(([k, us]) => [us / 1000, k]).filter(([ms]) => ms >= minMs).sort((a, b) => b[0] - a[0])
for (const [ms, k] of rows) console.log(ms.toFixed(1).padStart(7), k)
