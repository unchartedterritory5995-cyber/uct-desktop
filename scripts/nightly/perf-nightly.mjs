// Nightly speed check (plan Step 9.1; owner OK 2026-11-11). Runs from Task Scheduler each evening:
//   1. page-cost on the five main pages in the members' build (the newest release-out/v*/, members-build.mjs),
//      window on display 5, after a 60 s warm-up on /charts.
//   2. Compares each page with the baseline: the median of the last 7 passing nights.
//   3. Any page over a limit is measured again; only a slowdown seen twice is posted to the ops channel.
//   4. A night that cannot measure (window covered, low memory, app failed) is "blind": recorded, not
//      passed. Three blind nights in a row post one notice, so a dead check never reads as healthy.
// Everything lands in proof-output/nightly/ (history.jsonl, one JSON per night, log.txt).
//   A slowdown is posted the first night and every 7th night while it lasts. If it is an intended
//   change (a page that now does more on purpose), --accept makes the next night the new normal.
// Usage: node scripts/nightly/perf-nightly.mjs [--dry | --accept]   (--dry: measure and record, post nothing)
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { join, resolve } from 'node:path'
import {
  BLIND_ALERT_AFTER, baselineFrom, confirmedRegressions, findRegressions, formatBlindAlert,
  REMIND_EVERY, formatRegressionAlert, shouldPostRegression, trailingBlind,
} from './compare.mjs'
import { membersBuildExe } from './members-build.mjs'

const DRY = process.argv.includes('--dry')
const DIR = process.env.UCT_NIGHTLY_DIR || join('proof-output', 'nightly') // override only for trials
const HISTORY = join(DIR, 'history.jsonl')
const EXE = process.env.UCT_PROOF_EXE || membersBuildExe() || resolve('release-share', 'win-unpacked', 'UCT Intelligence.exe')
const RAILWAY_LINKED_DIR = 'C:\\Users\\Patrick\\uct-dashboard' // a directory linked to the production project
const MIN_FREE_GB = 6 // PC load rule: back off under 6 GB free
const date = new Date().toISOString().slice(0, 10)
mkdirSync(DIR, { recursive: true })
const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); appendFileSync(join(DIR, 'log.txt'), line + '\n') }

const history = existsSync(HISTORY)
  ? readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []

function appVersion() {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${EXE}').VersionInfo.ProductVersion`], { encoding: 'utf8', timeout: 30000 }).trim() || '?'
  } catch { return '?' }
}

async function siteBuild() {
  try {
    const html = await (await fetch('https://uctintelligence.com/', { headers: { 'User-Agent': 'Mozilla/5.0 uct-nightly-check' } })).text()
    return (html.match(/assets\/(index-[\w-]+\.js)/) || [])[1] || null
  } catch { return null }
}

// Monitors to try, in order (indexes into proof-output/displays.json). A window under a maximized one is
// not drawn and page-cost refuses it, so the next monitor is tried. 2 is the portrait monitor (only
// Discord across its top on 2026-11-11); 5 often has the trading platform maximized on it.
const DISPLAYS = (process.env.UCT_NIGHTLY_DISPLAYS || '2,4,0,5').split(',').map(Number)

function measureOn(display, routes, tag) {
  const out = join(DIR, `${date}-${tag}.json`)
  const args = ['scripts/proofs/page-cost.mjs', 'electron', `--display=${display}`, `--out=${out}`, ...(tag === 'main' ? ['--warm=60'] : []), ...routes]
  const r = spawnSync(process.execPath, args, { env: { ...process.env, UCT_PROOF_EXE: EXE }, encoding: 'utf8', timeout: 15 * 60 * 1000 })
  appendFileSync(join(DIR, 'log.txt'), (r.stdout || '') + (r.stderr || ''))
  if (r.status !== 0) {
    const reason = ((r.stderr || '').trim().split('\n').reverse().find((l) => /Error|refusing|not being drawn/.test(l)) || `page-cost exited ${r.status ?? r.signal}`).trim()
    return { ok: false, reason, undrawn: /not being drawn/.test(reason) }
  }
  const run = JSON.parse(readFileSync(out, 'utf8'))
  run.display = display
  return { ok: true, run }
}

function measure(routes, tag) {
  let last
  for (const display of DISPLAYS) {
    last = measureOn(display, routes, tag)
    if (last.ok || !last.undrawn) return last
    log(`display ${display} is covered; trying the next monitor`)
  }
  return { ok: false, reason: `every monitor tried (${DISPLAYS.join(',')}) was covered: ${last.reason}` }
}

/** The ops channel's webhook, read from production at send time and never printed or stored. */
function opsWebhook() {
  const raw = execFileSync('railway.cmd', ['variables', '--service', 'web', '--json'], { cwd: RAILWAY_LINKED_DIR, encoding: 'utf8', shell: true, timeout: 60000 })
  const vars = JSON.parse(raw)
  return vars.ALERT_OPS_WEBHOOK_URL || vars.DISCORD_WEBHOOK_URL || ''
}

async function post(text) {
  if (DRY) { log(`DRY, would post: ${text.replace(/\n/g, ' | ')}`); return }
  try {
    const url = opsWebhook()
    if (!url) { log('no ops webhook configured; alert written to the log only'); return }
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) })
    log(`posted to ops: ${res.status}`)
  } catch (e) {
    log(`posting failed (${String(e.message || e).slice(0, 120)}); alert is in this log`)
  }
}

function record(entry) {
  appendFileSync(HISTORY, JSON.stringify(entry) + '\n')
  writeFileSync(join(DIR, `${date}.json`), JSON.stringify(entry, null, 1))
}

async function blind(reason) {
  log(`BLIND: ${reason}`)
  record({ date, status: 'blind', reason })
  const nights = trailingBlind([...history, { status: 'blind' }])
  if (nights === BLIND_ALERT_AFTER) await post(formatBlindAlert(nights, reason))
}

if (process.argv.includes('--accept')) {
  appendFileSync(HISTORY, JSON.stringify({ date, status: 'reset', reason: 'accepted as the new normal' }) + '\n')
  log('reset: the next night becomes the new baseline')
  process.exit(0)
}
log(`start${DRY ? ' (dry)' : ''}, exe ${EXE}`)
if (!existsSync(EXE)) { await blind(`no app build at ${EXE}`); process.exit(0) }
if (freemem() < MIN_FREE_GB * 1024 ** 3) { await blind(`only ${(freemem() / 1024 ** 3).toFixed(1)} GB free`); process.exit(0) }

const meta = { date, appVersion: appVersion(), build: await siteBuild() }
const first = measure([], 'main')
if (!first.ok) { await blind(first.reason); process.exit(0) }

const baseline = baselineFrom(history)
if (!baseline) {
  record({ date, status: 'pass', meta, run: first.run, note: 'first run: becomes the baseline' })
  log('first run recorded as the baseline')
  process.exit(0)
}

const over = findRegressions(baseline, first.run)
if (!over.length) {
  record({ date, status: 'pass', meta, run: first.run, baselineRuns: baseline.runs })
  log(`pass (${first.run.routes.length} pages, baseline of ${baseline.runs} nights)`)
  process.exit(0)
}

log(`over the limit on first pass: ${over.map((r) => `${r.route} ${r.metric} ${r.cur}>${r.limit}`).join(', ')}; measuring again`)
const again = measure([...new Set(over.map((r) => r.route))], 'recheck')
if (!again.ok) { await blind(`recheck failed: ${again.reason}`); process.exit(0) }
const confirmed = confirmedRegressions(over, findRegressions(baseline, again.run))
if (!confirmed.length) {
  record({ date, status: 'pass', meta, run: first.run, baselineRuns: baseline.runs, note: 'first pass over a limit, recheck normal', firstOver: over })
  log('recheck normal: noise, not a slowdown')
  process.exit(0)
}
const post_ = shouldPostRegression(history)
record({ date, status: 'regressed', meta, run: first.run, recheck: again.run, regressions: confirmed })
if (post_) await post(formatRegressionAlert(confirmed, meta))
else log(`still slower (${confirmed.length} rows); already posted, reminder every ${REMIND_EVERY} nights`)
process.exit(0)
