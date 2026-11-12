// Watch production through deploys: what a member waits for in the first minutes of a new web pod.
// Every second: GET /api/health (latency, uptime, build), the page (/), and two signed-in member calls as
// the synthetic admin (SMOKE_EMAIL / SMOKE_PASSWORD, never printed): /api/auth/me and
// /api/watchlists/flagged. Every 5 s: /api/ready (warm-up progress). A drop in uptime marks a new pod.
// Writes proof-output/deploy-watch/<date>.jsonl and prints a per-deploy summary: latency by seconds since
// the pod started, worst request, and when each warm-up stage finished.
// Usage: node scripts/proofs/deploy-watch.mjs [--minutes=120] [--deploys=2]
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const arg = (n, d) => Number((process.argv.find((a) => a.startsWith(`--${n}=`)) || `--${n}=${d}`).split('=')[1])
const END = Date.now() + arg('minutes', 120) * 60_000
const WANT = arg('deploys', 2)
const SITE = 'https://uctintelligence.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36 uct-deploy-watch'
const DIR = join('proof-output', 'deploy-watch')
mkdirSync(DIR, { recursive: true })
const file = join(DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let cookie = ''
async function signIn() {
  const r = await fetch(`${SITE}/api/auth/login`, { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }) })
  if (r.ok) cookie = r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  return r.status
}
async function timed(path, withCookie = false, timeoutMs = 30000) {
  const t = performance.now()
  try {
    const r = await fetch(`${SITE}${path}`, { headers: { 'User-Agent': UA, ...(withCookie && cookie ? { Cookie: cookie } : {}) }, signal: AbortSignal.timeout(timeoutMs) })
    const body = await r.text()
    const st = r.headers.get('server-timing') || ''
    const origin = Number((st.match(/cfOrigin;dur=(\d+)/) || [])[1]) || null
    return { status: r.status, ms: Math.round(performance.now() - t), origin, body }
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t), error: String(e.name || e).slice(0, 40) }
  }
}

if (!process.env.SMOKE_EMAIL) throw new Error('SMOKE_EMAIL / SMOKE_PASSWORD are not set')
console.log(`sign-in ${await signIn()}; watching until ${new Date(END).toISOString()} or ${WANT} deploys -> ${file}`)
let lastUptime = null
let pod = null // { start, build, rows: [] }
const pods = []
let tick = 0
const summarize = (p) => {
  const buckets = [[0, 30], [30, 60], [60, 120], [120, 240], [240, 600], [600, 99999]]
  const out = buckets.map(([a, b]) => {
    const rows = p.rows.filter((r) => r.age >= a && r.age < b)
    const worst = (k) => (rows.length ? Math.max(...rows.map((r) => r[k]?.ms ?? 0)) : null)
    const med = (k) => { const v = rows.map((r) => r[k]?.ms).filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null }
    return `${String(a).padStart(4)}-${b === 99999 ? '...' : b}s: page med ${med('page')} worst ${worst('page')} | me med ${med('me')} worst ${worst('me')} | flagged med ${med('flagged')} worst ${worst('flagged')} | health worst ${worst('health')}`
  })
  return [`pod ${p.build} first seen at uptime ${p.firstAge}s (${p.rows.length} samples)`, ...out, `ready stages: ${JSON.stringify(p.readyAt)}`].join('\n  ')
}

while (Date.now() < END && pods.filter((p) => p.isDeploy).length < WANT) {
  const t0 = Date.now()
  const health = await timed('/api/health', false, 30000)
  let h = null
  try { h = JSON.parse(health.body) } catch { /* 502 page during a swap */ }
  const uptime = h?.uptime_seconds ?? null
  if (uptime != null && (lastUptime == null || uptime < lastUptime)) {
    if (pod) { console.log(summarize(pod)); pods.push(pod) }
    pod = { build: h.build_id, firstAge: uptime, isDeploy: lastUptime != null, rows: [], readyAt: {} }
    if (pod.isDeploy) { console.log(`\nNEW POD at ${new Date().toISOString()} (uptime ${uptime}s, ${h.build_id})`); await signIn() }
  }
  if (uptime != null) lastUptime = uptime
  const [page, me, flagged] = await Promise.all([timed('/'), timed('/api/auth/me', true), timed('/api/watchlists/flagged', true)])
  let ready = null
  if (tick % 5 === 0) {
    const r = await timed('/api/ready')
    try { ready = JSON.parse(r.body) } catch { /* ignore */ }
    if (ready && pod) for (const s of ready.done || []) if (pod.readyAt[s] == null) pod.readyAt[s] = uptime
  }
  const row = { at: new Date().toISOString(), age: uptime, build: h?.build_id ?? null,
    health: { status: health.status, ms: health.ms }, page: { status: page.status, ms: page.ms, origin: page.origin },
    me: { status: me.status, ms: me.ms }, flagged: { status: flagged.status, ms: flagged.ms },
    ...(ready ? { ready: { ready: ready.ready, pending: ready.pending } } : {}) }
  for (const k of ['page', 'me', 'flagged']) delete row[k].body
  appendFileSync(file, JSON.stringify(row) + '\n')
  if (pod && uptime != null) pod.rows.push(row)
  if (pod?.isDeploy && uptime != null && uptime < 300 && (page.ms > 2000 || me.ms > 2000 || flagged.ms > 2000)) {
    console.log(`  slow at uptime ${uptime}s: page ${page.status}/${page.ms}ms (origin ${page.origin}) me ${me.ms}ms flagged ${flagged.ms}ms health ${health.ms}ms`)
  }
  tick++
  await sleep(Math.max(0, 1000 - (Date.now() - t0)))
}
if (pod) { console.log(summarize(pod)); pods.push(pod) }
