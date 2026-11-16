// Reads production's own ingest timing (the web pod's vendor socket): for each trade, exchange time to
// the pod receiving it (recv_lag_ms) and to the pod processing it (trade_lag_ms), per wall-clock minute.
// With the browser-side proof (tick-latency-proof.mjs, trade -> page receive) this splits the server leg
// into vendor-to-pod and pod-to-browser. Admin route, so it signs in as the synthetic admin account
// (PROOF_EMAIL / PROOF_PASSWORD from the operator's environment), in its own Chrome profile.
// Usage: node scripts/proofs/ingest-lag-read.mjs <out.json> [--samples=4] [--every=30] [--port=9447]
// Reads only.
import { writeFileSync } from 'node:fs'
import { startApp } from './launch.mjs'

const OUT = process.argv[2]
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d }
if (!OUT || OUT.startsWith('--')) { console.error('usage: ingest-lag-read.mjs <out.json> [--samples=4] [--every=30]'); process.exit(64) }
const SAMPLES = Number(arg('samples', '4')), EVERY = Number(arg('every', '30')), PORT = Number(arg('port', '9447'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const out = { proof: 'ingest-lag-read', startedAt: new Date().toISOString(), samples: [] }
const app = await startApp('chrome', PORT, [])
try {
  for (let i = 0; i < SAMPLES; i++) {
    if (i) await sleep(EVERY * 1000)
    const s = await app.run(`fetch('/api/admin/bars-stream-status',{credentials:'include'}).then(async r=>({status:r.status, body: r.ok ? await r.json() : null}))`)
    const ws = s.body && s.body.websocket
    const ing = ws && ws.ingest
    const row = { at: new Date().toISOString(), status: s.status, ingest: ing || null, liveness: ws ? ws.liveness : null, am_lag_ms: ws ? ws.am_lag_ms : null }
    out.samples.push(row)
    const lm = ing && ing.last_minute
    console.log(`${row.at} status ${s.status}` + (lm ? `  last minute: trades ${lm.recv_lag_ms.n}  exchange->pod receive p50 ${lm.recv_lag_ms.p50} p90 ${lm.recv_lag_ms.p90} max ${lm.recv_lag_ms.max} ms  ->processed p50 ${lm.trade_lag_ms.p50} p90 ${lm.trade_lag_ms.p90} ms  busy ${lm.busy_ratio}  queue max ${lm.recv_queue_max}` : '  (no ingest block)'))
  }
} finally {
  await app.close()
  out.finishedAt = new Date().toISOString()
  writeFileSync(OUT, JSON.stringify(out, null, 1))
}
