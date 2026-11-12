// Weekly fault check (speed plan 9.5; owner OK 2026-11-11 "lets do all that yes"). Task Scheduler runs it
// every Saturday morning, when the market is closed. It breaks the members' build (the newest release-out/v*/, the last
// installer) on purpose, one fault at a time, and asserts it recovers by itself:
//   faults-proof.mjs    renderer crash, GPU process killed, slow server, new build deployed mid-use, session expired
//   recovery-proof.mjs  network drop: offline banner, sign-in re-checked first, streams back within 5 s, banner clears
//   blackbox-proof.mjs  the black box records launches, a hard kill as an unclean exit, and a clean quit
// Results land in proof-output/faults/ (history.jsonl, one JSON per run, log.txt). Any FAIL is posted to the
// ops channel; a run that could not measure (low memory, a proof that died before reporting) is "blind",
// recorded, and posted when it happens twice in a row, so a dead check never reads as healthy.
// Usage: node scripts/nightly/faults-weekly.mjs [--dry]   (--dry: run and record, post nothing)
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { join, resolve } from 'node:path'
import { parseRows } from './fault-rows.mjs'
import { membersBuildExe } from './members-build.mjs'

const DRY = process.argv.includes('--dry')
const DIR = process.env.UCT_FAULTS_DIR || join('proof-output', 'faults')
const HISTORY = join(DIR, 'history.jsonl')
const EXE = process.env.UCT_PROOF_EXE || membersBuildExe() || resolve('release-share', 'win-unpacked', 'UCT Intelligence.exe')
const RAILWAY_LINKED_DIR = 'C:\\Users\\Patrick\\uct-dashboard'
const MIN_FREE_GB = 6
const date = new Date().toISOString().slice(0, 10)
mkdirSync(DIR, { recursive: true })
const log = (msg) => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); appendFileSync(join(DIR, 'log.txt'), line + '\n') }

const PROOFS = [
  { name: 'faults', args: ['scripts/proofs/faults-proof.mjs', '--display=2'], timeoutMin: 30 },
  { name: 'recovery', args: ['scripts/proofs/recovery-proof.mjs', '--display=2'], timeoutMin: 15 },
  { name: 'blackbox', args: ['scripts/proofs/blackbox-proof.mjs'], timeoutMin: 15 },
]

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
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900), allowed_mentions: { parse: [] } }) })
    log(`posted to ops: ${res.status}`)
  } catch (e) {
    log(`posting failed (${String(e.message || e).slice(0, 120)}); alert is in this log`)
  }
}

const history = existsSync(HISTORY)
  ? readFileSync(HISTORY, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  : []
const entry = { date, startedUtc: new Date().toISOString(), exe: EXE, rows: [], blind: [] }

if (freemem() / 2 ** 30 < MIN_FREE_GB) {
  entry.blind.push(`only ${(freemem() / 2 ** 30).toFixed(1)} GB free (needs ${MIN_FREE_GB})`)
} else if (!existsSync(EXE)) {
  entry.blind.push(`members' build not found at ${EXE}`)
} else {
  const env = { ...process.env, UCT_PROOF_EXE: EXE }
  for (const p of PROOFS) {
    log(`running ${p.name}`)
    const r = spawnSync(process.execPath, p.args, { env, encoding: 'utf8', timeout: p.timeoutMin * 60_000 })
    appendFileSync(join(DIR, 'log.txt'), (r.stdout || '') + (r.stderr || ''))
    const rows = parseRows(r.stdout).map((x) => ({ ...x, proof: p.name }))
    entry.rows.push(...rows)
    if (!rows.length) entry.blind.push(`${p.name} reported nothing (exit ${r.status ?? r.signal})`)
  }
}
entry.finishedUtc = new Date().toISOString()
const failed = entry.rows.filter((r) => !r.pass)
entry.verdict = failed.length ? 'FAIL' : entry.blind.length ? 'BLIND' : 'PASS'
appendFileSync(HISTORY, JSON.stringify(entry) + '\n')
writeFileSync(join(DIR, `${date}.json`), JSON.stringify(entry, null, 1))
log(`${entry.verdict}: ${entry.rows.length - failed.length}/${entry.rows.length} rows passed${entry.blind.length ? `; blind: ${entry.blind.join('; ')}` : ''}`)

if (failed.length) {
  await post([`**UCT desktop weekly fault check: ${failed.length} of ${entry.rows.length} FAILED** (members' build)`,
    ...failed.map((f) => `- ${f.id}: ${f.detail}`), 'Details: uct-desktop proof-output/faults/'].join('\n'))
} else if (entry.blind.length && history.length && history[history.length - 1].verdict === 'BLIND') {
  await post(`**UCT desktop weekly fault check could not run two weeks in a row**: ${entry.blind.join('; ')}`)
}
process.exit(failed.length ? 1 : 0)
