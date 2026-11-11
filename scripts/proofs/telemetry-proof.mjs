// Telemetry on the PACKAGED app against the LIVE server (plan 5.1). Launched WITHOUT a debugging port,
// so telemetry is on exactly as on a member's machine. Rows:
//   T-launch     a launch is counted by the server as launch_ok for this version (admin read, before/after)
//   T-drain      the on-disk queue is empty after the send (the server accepted it)
//   T-unclean    a hard kill (taskkill /F) is counted as unclean_exit on the next launch
//   T-off        with UCT_DESKTOP_TELEMETRY=0 nothing is sent (count unchanged, no telemetry.json queue sent)
// Needs SMOKE_EMAIL / SMOKE_PASSWORD (the admin smoke account) for the admin read. Counts the owner's
// own machine once per row; the install id is a fresh random one per profile.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXE = process.env.UCT_PROOF_EXE || resolve('release', 'win-unpacked', 'UCT Intelligence.exe')
const BASE = 'https://uctintelligence.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const row = (id, pass, detail) => {
  rows.push({ id, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`)
}

async function adminCookie() {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify({ email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD }),
  })
  if (!r.ok) throw new Error(`admin login ${r.status}`)
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

async function count(cookie, event, version) {
  const r = await fetch(`${BASE}/api/admin/desktop-events?hours=2`, { headers: { cookie, 'user-agent': UA } })
  if (!r.ok) throw new Error(`admin read ${r.status}`)
  const j = await r.json()
  return j.rows.filter((x) => x.event === event && x.shell_version === version).reduce((n, x) => n + x.n, 0)
}

function launch(profile, env = {}) {
  const child = spawn(EXE, [`--user-data-dir=${profile}`], { stdio: 'ignore', env: { ...process.env, UCT_DESKTOP_TELEMETRY: undefined, ...env } })
  return child
}
const kill = (child, force) => {
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' })
  } catch { /* gone */ }
}
const state = (profile) => {
  const f = join(profile, 'telemetry.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}
async function waitFor(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await fn()
    if (v) return v
    await sleep(1000)
  }
  return null
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const cookie = await adminCookie()
const profile = mkdtempSync(join(tmpdir(), 'uct-proof-telemetry-'))
let child
try {
  const before = await count(cookie, 'launch_ok', version)
  child = launch(profile)
  const got = await waitFor(async () => (await count(cookie, 'launch_ok', version)) > before, 60000)
  row('T-launch', !!got, `launch_ok for ${version}: before ${before}, after ${await count(cookie, 'launch_ok', version)}`)
  const s = state(profile)
  row('T-drain', !!s && s.queue.length === 0 && /^[0-9a-f]{32}$/.test(s.install), `queue ${s?.queue?.length}, install id ${s ? 'present' : 'missing'}`)

  const uBefore = await count(cookie, 'unclean_exit', version)
  kill(child, true)
  await sleep(2000)
  child = launch(profile)
  const u = await waitFor(async () => (await count(cookie, 'unclean_exit', version)) > uBefore, 60000)
  row('T-unclean', !!u, `unclean_exit for ${version}: before ${uBefore}, after ${await count(cookie, 'unclean_exit', version)}`)
  kill(child, false)
  await sleep(4000)
  kill(child, true)

  const offProfile = mkdtempSync(join(tmpdir(), 'uct-proof-telemetry-off-'))
  const oBefore = await count(cookie, 'launch_ok', version)
  child = launch(offProfile, { UCT_DESKTOP_TELEMETRY: '0' })
  await sleep(25000)
  const oAfter = await count(cookie, 'launch_ok', version)
  row('T-off', oAfter === oBefore && !existsSync(join(offProfile, 'telemetry.json')), `launch_ok ${oBefore} -> ${oAfter}, telemetry.json ${existsSync(join(offProfile, 'telemetry.json')) ? 'EXISTS' : 'absent'}`)
} finally {
  if (child) {
    kill(child, false)
    await sleep(3000)
    kill(child, true)
  }
}
const failed = rows.filter((r) => !r.pass).length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
