// Nightly chart speed + memory canary (coordinator brief 2026-11-20). Production, the synthetic bench member,
// headless Chrome on THIS canary's own persistent profile, driven by scripts/proofs/indicator-flip-proof.mjs:
//   1. two linked charts (D + 60m) on the S&P 500 list, 30 switches: BOTH on screen, median and p90
//   2. typed never-opened tickers on D, 60 and 5, six each (a block rotation of the pool, chart-canary-rules.mjs)
//   3. a memory soak: 100 switches on the two charts, JS heap after a full GC (twice) at 0 / 50 / 100
//   4. every page error and unhandled rejection the runs saw; 5. the live build (/api/health `commit`)
// One JSON row per night is appended to <dir>/rows.jsonl and <dir>/latest.md is rewritten: tonight, the
// trailing-7-night medians and a REGRESSION line per rule broken (chart-canary-rules.mjs RULES).
// ⚰️ Why: a base-app leak (~20 MB kept per symbol switch, the page hung near 150) was live for days on
// 2026-11-20 and was found only by a hand-run soak; switch speed is measured by hand.
//
// Usage: node scripts/nightly/chart-canary.mjs [--dir=D:/uct-history/canary] [--trigger=scheduled] [--board-busy=<marker file>]
//   Takes the machine's heavy lock itself (normal priority) unless it is already running inside one, so
//   this one command is the whole job. Rows, raw runs and the profile stay on D:, never in the repo.
//   The bench board is put back after every run (the proof restores it; the canary checks, and restores it
//   itself if a run could not). No --ls key is set, so the profile's localStorage is left as the app keeps it.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as R from './chart-canary-rules.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SELF), '..', '..')
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
// --proof=<file>: a stand-in for the flip proof (the runner's own smoke test); the real one otherwise
const PROOF = arg('proof', join(REPO, 'scripts', 'proofs', 'indicator-flip-proof.mjs'))
const DIR = arg('dir', 'D:/uct-history/canary')
const PROFILE = arg('profile', join(DIR, 'profile'))
const PORT = arg('port', '9447') // not the proof's default 9441, so a hand run elsewhere never collides
const TRIGGER = arg('trigger', 'manual')
const POOL_FILE = arg('pool', '') // comma/newline-separated tickers instead of the default 36
const STEP_TIMEOUT_MIN = Number(arg('step-timeout-min', '0')) // (smoke tests) cap every run's timeout
const SITE = 'https://uctintelligence.com'
const LOCK_PY = 'C:/Users/Patrick/uct-clips/tools/heavy_lock.py'
// the 17:30 CT start must finish before the 20:15 ET seed build (19:15 CT): 75 min of queue + ~25 of run
const LOCK_TIMEOUT_MIN = Number(arg('lock-timeout-min', '75'))
const BUDGET_MIN = 25
const MIN_FREE_GB = 6 // PC load rule: back off under 6 GB free
const ABORT_HEAP_MB = 1500 // the soak stops past this (a leaking page grows by GBs); the rule still reads it
const ROWS = join(DIR, 'rows.jsonl')
const LATEST = join(DIR, 'latest.md')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const makeRunId = (d = new Date()) => `${localDate(d).replace(/-/g, '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const readRows = () => (existsSync(ROWS) ? readFileSync(ROWS, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
mkdirSync(DIR, { recursive: true })
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(DIR, 'log.txt'), line + '\n') }

/** Append the night's row and rewrite latest.md (written beside it, then renamed over it). */
function record(row) {
  appendFileSync(ROWS, JSON.stringify(row) + '\n')
  const prior = R.priorNights(readRows(), row.date)
  const tmp = LATEST + '.tmp'
  writeFileSync(tmp, R.formatLatest(row, prior))
  renameSync(tmp, LATEST)
  return R.regressions(row, prior)
}

// --board-busy=<file>: a marker other bench-board users keep (2026-11-20: proofs run beside the heavy lock with
// --force-concurrent). While it exists the canary does not queue; inside the lock it creates the marker
// itself (O_EXCL: {label, runId, pid, startedUtc}) and removes it after the last board restore. A marker
// found inside the lock sends the lock straight back (exit BUSY) rather than holding the machine's queue
// while it waits. A canary marker whose pid is dead is stale and is cleared; any other marker is waited on.
// The heavy lock (never forced here) is what orders every proof that honours it.
const BOARD_BUSY = arg('board-busy', '')
const BUSY = 75
const markerText = () => { try { return readFileSync(BOARD_BUSY, 'utf8').trim() } catch { return null } }
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function staleCanaryMarker() {
  try { const m = JSON.parse(markerText() || ''); return m && m.label === 'chart-canary' && Number.isInteger(m.pid) && !pidAlive(m.pid) ? m : null } catch { return null }
}
function boardIsBusy() {
  if (!BOARD_BUSY || !existsSync(BOARD_BUSY)) return false
  const stale = staleCanaryMarker()
  if (stale) { try { rmSync(BOARD_BUSY) } catch { /* raced */ } log(`cleared a stale canary board marker (${stale.runId}, pid ${stale.pid} dead)`); return existsSync(BOARD_BUSY) }
  return true
}
function removeOwnMarker(runId) {
  try { const m = JSON.parse(markerText() || ''); if (m && m.label === 'chart-canary' && m.runId === runId) rmSync(BOARD_BUSY) } catch { /* not ours, or gone */ }
}

// ── outer: take the heavy lock, then run this same file inside it ──
if (!process.env.UCT_HEAVY_LOCK) {
  const runId = makeRunId()
  const t0 = new Date()
  const deadline = t0.getTime() + LOCK_TIMEOUT_MIN * 60000
  let code = 1
  let busyUntilDeadline = false
  for (;;) {
    let said = false
    while (boardIsBusy() && Date.now() < deadline) {
      if (!said) { log(`canary ${runId}: the bench board is busy (${BOARD_BUSY}: ${String(markerText()).slice(0, 160)}); waiting`); said = true }
      await new Promise((r) => setTimeout(r, 60000))
    }
    const left = Math.round((deadline - Date.now()) / 1000)
    if (boardIsBusy() || left < 60) { busyUntilDeadline = boardIsBusy(); code = busyUntilDeadline ? BUSY : 1; break }
    log(`canary ${runId}: queueing for the heavy lock (normal priority, up to ${Math.round(left / 60)} min)`)
    const r = spawnSync('python', [LOCK_PY, '--label', 'chart-canary', '--priority', 'normal', '--timeout', String(left), 'run', '--', process.execPath, SELF, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, CANARY_RUN_ID: runId } })
    code = r.status ?? 1
    removeOwnMarker(runId) // a run killed inside the lock cannot remove its own
    if (code !== BUSY) break
    log(`canary ${runId}: the board was taken while queued; lock handed back, waiting again`)
  }
  if (!readRows().some((x) => x.runId === runId)) {
    // The canary never wrote its row: the lock wait ran out, the board stayed busy, or the run died. Recorded.
    const now = new Date()
    const why = busyUntilDeadline
      ? `the bench board stayed busy until the deadline (${LOCK_TIMEOUT_MIN} min; ${BOARD_BUSY}: ${String(markerText()).slice(0, 120)})`
      : `the heavy-lock run exited ${code} before the canary recorded anything (the wait is ${LOCK_TIMEOUT_MIN} min; see log.txt)`
    record({ v: 1, runId, date: localDate(t0), startedAt: t0.toISOString(), endedAt: now.toISOString(), runtimeS: Math.round((now - t0) / 1000), trigger: TRIGGER, status: 'incomplete',
      failures: [{ step: 'canary', why }] })
    log(`canary ${runId}: no row from the locked run (exit ${code}); recorded as incomplete`)
  }
  process.exit(code)
}

// ── inner: the measurement, inside the heavy lock ──
const runId = process.env.CANARY_RUN_ID || makeRunId()
if (BOARD_BUSY) {
  boardIsBusy() // clears a dead canary's marker
  try {
    const fd = openSync(BOARD_BUSY, 'wx')
    writeFileSync(fd, JSON.stringify({ label: 'chart-canary', runId, pid: process.pid, startedUtc: new Date().toISOString(), what: 'flip-proof runs on the bench board (uct-desktop scripts/nightly/chart-canary.mjs)' }) + '\n')
    closeSync(fd)
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
    log(`canary ${runId}: the bench board is busy (${String(markerText()).slice(0, 160)}): handing the lock back`)
    process.exit(BUSY)
  }
  process.on('exit', () => removeOwnMarker(runId))
}
const RUN_DIR = join(DIR, 'runs', runId)
mkdirSync(RUN_DIR, { recursive: true })
const started = new Date()
const today = localDate(started)
const elapsedMin = () => (Date.now() - started.getTime()) / 60000
const childEnv = { ...process.env }
delete childEnv.UCT_PROOF_BASE // production only
const failures = []
const notes = []
const row = { v: 1, runId, date: today, startedAt: started.toISOString(), trigger: TRIGGER, status: 'ok', site: SITE }

async function health() {
  try {
    const r = await fetch(`${SITE}/api/health`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
    const j = await r.json()
    return { commit: j.commit || j.git_sha || null, buildId: j.build_id || null, uptimeS: j.uptime_seconds ?? null }
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 160) } }
}

function runProof(name, args, timeoutMin) {
  const out = join(RUN_DIR, `${name}.json`)
  const fd = openSync(join(RUN_DIR, `${name}.log`), 'a')
  return new Promise((done) => {
    const t0 = Date.now()
    const child = spawn(process.execPath, [PROOF, out, ...args], { cwd: REPO, env: childEnv, stdio: ['ignore', fd, fd], windowsHide: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ }
    }, timeoutMin * 60000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      closeSync(fd)
      let j = null
      try { j = JSON.parse(readFileSync(out, 'utf8')) } catch { /* never written, or cut mid-write */ }
      done({ name, code, timedOut, seconds: Math.round((Date.now() - t0) / 1000), j })
    })
  })
}

// The bench board: every proof run applies its test board and puts the recorded version back. A run that
// was killed (or whose restore was refused) has not, so the canary puts it back here.
// (The proof records boardVersionBefore just before it applies its test board, and saves its result file
// right after: a run with no version recorded never changed the board.)
async function ensureBoard(res) {
  const j = res.j || {}
  if (j.boardRestore === 200 || j.boardRestore === 'unchanged') return
  const v = j.boardVersionBefore
  if (typeof v !== 'number') { notes.push(`${res.name}: stopped before its test board was applied (nothing to restore)`); return }
  log(`${res.name}: board restore not confirmed (${JSON.stringify(j.boardRestore ?? null)}); restoring version ${v}`)
  const r = await runProof(`${res.name}-restore`, [`--restore=${v}`, '--headless=1', `--profile=${PROFILE}`, `--port=${PORT}`, '--graceful-close=1'], 5)
  const st = r.j && r.j.boardRestore
  if (st === 200 || st === 'unchanged') notes.push(`${res.name}: the bench board was put back by the canary (version ${v})`)
  else failures.push({ step: res.name, why: `the bench board was NOT restored (version ${v}; ${JSON.stringify(st ?? null)}): run the proof with --restore=${v}` })
}

function why(res) {
  if (res.timedOut) return `timed out and was stopped (${res.seconds} s)`
  const e = res.j && res.j.error
  if (e) return String(e).split('\n')[0].slice(0, 200)
  if (!res.j) return `exited ${res.code} without a result file`
  return `exited ${res.code}`
}

let exitCode = 0
try {
  // memory first: a canary that starts on a loaded box measures the box
  for (let k = 0; freemem() / 2 ** 30 < MIN_FREE_GB && k < 20; k++) {
    if (k === 0) log(`free RAM ${(freemem() / 2 ** 30).toFixed(1)} GB < ${MIN_FREE_GB} GB: waiting (up to 10 min)`)
    await new Promise((r) => setTimeout(r, 30000))
  }
  if (freemem() / 2 ** 30 < MIN_FREE_GB) throw Object.assign(new Error(`free RAM stayed under ${MIN_FREE_GB} GB for 10 min`), { step: 'canary' })

  const rows = readRows()
  const pool = POOL_FILE ? readFileSync(POOL_FILE, 'utf8').split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean) : R.DEFAULT_POOL
  const night = R.nightIndex(rows, today)
  const typed = R.typedForNight(pool, night)
  const tonight = new Set(Object.values(typed).flat())
  const prior = R.priorNights(rows, today, Infinity).reverse()
  const lastIdx = prior.findIndex((r) => Object.values(r.typed || {}).some((s) => (s.perSym || []).some((p) => tonight.has(p.sym))))
  row.typedPool = { size: pool.length, night, cycle: Math.floor(pool.length / R.TYPED_PER_TF), lastTypedNightsAgo: lastIdx < 0 ? null : lastIdx + 1 }

  const b0 = await health()
  const firstWarmup = existsSync(PROFILE) ? 90000 : 150000 // a new profile ingests the bars pack first
  const COMMON = ['--headless=1', '--cheap-sampler=1', `--profile=${PROFILE}`, `--port=${PORT}`, '--graceful-close=1']
  const TWO = ['--tf=D', '--tf2=60', '--set=mixed', '--dwell=800', '--list=S&P 500']
  const steps = [
    { name: 'two', args: [...TWO, '--flips=30', `--warmup=${firstWarmup}`], timeoutMin: 9 },
    ...R.TYPED_TFS.map((tf) => ({ name: `typed-${tf}`, args: [`--tf=${tf}`, '--set=base', '--pattern=typed', `--typed=${typed[tf].join(',')}`, '--dwell=3000', '--warmup=20000'], timeoutMin: 6 })),
    { name: 'soak', args: [...TWO, '--flips=100', '--soak-every=50', `--abort-heap-mb=${ABORT_HEAP_MB}`, '--warmup=20000'], timeoutMin: 10 },
  ]
  const results = {}
  for (const s of steps) {
    const left = BUDGET_MIN - elapsedMin()
    if (left < 3) { failures.push({ step: s.name, why: `skipped: the canary was at ${elapsedMin().toFixed(1)} of its ${BUDGET_MIN} min` }); continue }
    log(`${runId} ${s.name}: start`)
    const res = await runProof(s.name, [...s.args, ...COMMON], Math.min(STEP_TIMEOUT_MIN || s.timeoutMin, left))
    log(`${runId} ${s.name}: exit ${res.code}${res.timedOut ? ' (timed out)' : ''} in ${res.seconds} s`)
    results[s.name] = res
    await ensureBoard(res)
  }
  if (BOARD_BUSY) removeOwnMarker(runId) // every run's board is back: the board is free for the others

  // ── score ──
  const usable = (res, scored) => res && res.j && !res.timedOut && res.code === 0 && !res.j.error && scored && scored.painted > 0
  const two = results.two
  if (two && two.j) {
    row.two = R.scoreTwo(two.j)
    if (!usable(two, row.two)) failures.push({ step: 'two', why: why(two) + (row.two.painted ? '' : '; no switch painted') })
  }
  row.typed = {}
  for (const tf of R.TYPED_TFS) {
    const res = results[`typed-${tf}`]
    if (!res) continue
    if (res.j) row.typed[tf] = R.scoreTyped(res.j)
    if (!usable(res, row.typed[tf])) failures.push({ step: `typed-${tf}`, why: why(res) + (row.typed[tf] && !row.typed[tf].painted ? '; nothing painted' : '') })
  }
  const soak = results.soak
  if (soak && soak.j) {
    row.soak = R.scoreSoak(soak.j, 100)
    const aborted = /over the \d+ MB abort line/.test(String(soak.j.error || ''))
    // stopping at the abort line IS the measurement (the rule reads the scaled number); anything else is a failure
    if (!aborted && (soak.timedOut || soak.code !== 0 || soak.j.error || !row.soak.complete)) failures.push({ step: 'soak', why: why(soak) })
    if (aborted) notes.push(`the soak stopped at the ${ABORT_HEAP_MB} MB abort line after ${row.soak.reached} switches`)
  }
  for (const [name, res] of Object.entries(results)) if (!res.j && !failures.some((f) => f.step === name)) failures.push({ step: name, why: why(res) })

  // page errors, the profile's switches, the build each run saw
  row.pageErrors = { count: 0, rejections: 0, byRun: {}, first: [] }
  const builds = new Set()
  for (const [name, res] of Object.entries(results)) {
    const j = res.j
    if (!j) continue
    const pe = j.pageErrors
    if (pe) {
      row.pageErrors.count += pe.count
      row.pageErrors.rejections += pe.rejections
      row.pageErrors.byRun[name] = pe.count
      for (const e of pe.first || []) if (row.pageErrors.first.length < 10) row.pageErrors.first.push({ run: name, ...e })
    }
    const set = Object.entries(j.switches || {}).filter(([, v]) => v != null)
    if (set.length) failures.push({ step: name, why: `the profile holds ${set.map(([k, v]) => `${k}=${v}`).join(', ')}: not production's defaults` })
    if (j.sampleErrs) notes.push(`${name}: the frame sampler threw ${j.sampleErrs} time(s)`)
    if (j.build && j.build.commit) builds.add(j.build.commit)
  }
  const b1 = await health()
  const first = b0.commit || [...builds][0] || null
  row.build = { commit: first, buildId: b0.buildId || null, uptimeS: b0.uptimeS ?? null, ...(b0.error ? { healthError: b0.error } : {}) }
  const seen = new Set([...builds, ...(b1.commit ? [b1.commit] : [])])
  if (first) seen.delete(first)
  if (seen.size) { row.build.changedDuringRun = true; row.build.otherCommits = [...seen] }
  if (row.build.changedDuringRun) notes.push('a deploy landed during the run: tonight mixes two builds')
} catch (e) {
  failures.push({ step: e.step || 'canary', why: String((e && e.message) || e).slice(0, 300) })
  exitCode = 1
}

const ended = new Date()
row.endedAt = ended.toISOString()
row.runtimeS = Math.round((ended - started) / 1000)
row.failures = failures
row.notes = notes
if (failures.length) row.status = 'incomplete'
writeFileSync(join(RUN_DIR, 'row.json'), JSON.stringify(row, null, 1))
const reg = record(row)
log(`${runId}: ${row.runtimeS} s; ${reg.length ? reg.join(' | ') : 'no regression'}`)
console.log(readFileSync(LATEST, 'utf8'))

// raw runs older than 30 days go (only folders this canary made: a runs/<id>/row.json beside them)
try {
  for (const name of readdirSync(join(DIR, 'runs'))) {
    const p = join(DIR, 'runs', name)
    if (!/^\d{8}-\d{6}$/.test(name) || name === runId || !existsSync(join(p, 'row.json'))) continue
    if (Date.now() - statSync(join(p, 'row.json')).mtimeMs > 30 * 86400000) rmSync(p, { recursive: true, force: true })
  }
} catch { /* housekeeping only */ }

process.exit(exitCode || (reg.length ? 3 : 0))
