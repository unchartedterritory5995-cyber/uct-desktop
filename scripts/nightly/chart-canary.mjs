// Chart speed + memory canary (coordinator brief 2026-11-20). Production, the synthetic bench member, headless
// Chrome on the canary's own persistent profile, driven by scripts/proofs/indicator-flip-proof.mjs:
//   1. two linked charts (D + 60m) on the S&P 500 list, 30 switches: BOTH on screen and first candles,
//      median and p90 (an over-the-limit median is measured again before it counts)
//   2. typed never-opened tickers on D, 60 and 5, six each (a block rotation of the pool, chart-canary-rules.mjs)
//   3. a memory soak: 100 switches on the two charts, JS heap after a full GC (twice) at 0 / 50 / 100
//   4. every page error and unhandled rejection the runs saw; 5. the live build (/api/health `commit`)
// One JSON row per night is appended to <dir>/rows.jsonl and <dir>/latest.md is rewritten: tonight, the
// baseline medians and a REGRESSION line per rule broken (chart-canary-rules.mjs).
// ⚰️ Why: a base-app leak (~20 MB kept per symbol switch, the page hung near 150) was live for days on
// 2026-11-20 and was found only by a hand-run soak; switch speed was measured by hand.
//
// NIGHTLY: the nightly speed check (perf-nightly.mjs, Task Scheduler 23:40 CT) runs this after its pages,
// inside its heavy lock: one task, one baseline rule, one --accept, one alert path (its ops post).
// BY HAND: node scripts/nightly/chart-canary.mjs [--dir=D:/uct-history/canary] [--board-busy=<marker>]
//   queues for the heavy lock itself (normal priority) unless already inside one. `--rescore=<runId>`
//   scores a recorded run's raw files again (after a rules change) and rewrites its row and latest.md.
// Rows, raw runs and the profile stay on D:, never in the repo. The bench board is put back after every run
// (the proof restores it; the canary checks, and restores it itself if a run could not). No --ls key is
// set, so the profile's localStorage is left as the app keeps it.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { freemem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as R from './chart-canary-rules.mjs'
import * as Board from '../proofs/bench-board.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SELF), '..', '..')
export const SITE = 'https://uctintelligence.com'
export const DEFAULT_DIR = process.env.UCT_CANARY_DIR || 'D:/uct-history/canary'
const DEFAULT_PROOF = join(REPO, 'scripts', 'proofs', 'indicator-flip-proof.mjs')
const DEFAULT_HISTORY = join(process.env.UCT_NIGHTLY_DIR || join(REPO, 'proof-output', 'nightly'), 'history.jsonl')
const LOCK_PY = 'C:/Users/Patrick/uct-clips/tools/heavy_lock.py'
const BUDGET_MIN = 25
const MIN_FREE_GB = 6 // PC load rule: back off under 6 GB free
const ABORT_HEAP_MB = 1500 // the soak stops past this (a leaking page grows by GBs); the rule still reads it
const BUSY = 75 // exit code: the bench board was busy, the lock was handed back
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const pad = (n) => String(n).padStart(2, '0')
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const makeRunId = (d = new Date()) => `${localDate(d).replace(/-/g, '')}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
const writeAtomic = (p, text) => { writeFileSync(p + '.tmp', text); renameSync(p + '.tmp', p) }

function paths(dir) {
  mkdirSync(dir, { recursive: true })
  return { rows: join(dir, 'rows.jsonl'), latest: join(dir, 'latest.md'), log: join(dir, 'log.txt') }
}
const logTo = (dir) => (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(paths(dir).log, line + '\n') }

/** Give the row its verdict against the baseline, append it (or replace the row of the same runId), rewrite
 * latest.md. Returns the regression lines and whether they are to be posted tonight. */
function record(dir, row, history, { replace = false } = {}) {
  const p = paths(dir)
  const all = readJsonl(p.rows)
  const others = all.filter((r) => r.runId !== row.runId)
  const since = R.lastAccept(history)
  const prior = R.priorNights(others, row.date, R.RULES.trailingNights, since)
  const regressions = R.regressions(row, prior)
  row.verdict = { regressions, speed: regressions.some((l) => l.includes('both-on-screen')), baselineNights: prior.length, since }
  if (replace) writeAtomic(p.rows, [...others, row].map((r) => JSON.stringify(r)).join('\n') + '\n')
  else appendFileSync(p.rows, JSON.stringify(row) + '\n')
  writeAtomic(p.latest, R.formatLatest(row, prior))
  return { regressions, post: regressions.length > 0 && R.shouldPost(R.nightsBefore(others, row.date)), latestPath: p.latest }
}

// ── the bench-board marker (--board-busy): scripts/proofs/bench-board.mjs. The canary waits while another
// user's marker exists (never while holding the heavy lock), takes its own inside the lock and gives it back
// once every run's board is back. LABEL marks the canary's own (its stale ones are cleared).
const LABEL = 'chart-canary'
const boardIsBusy = (f, log) => Board.boardIsBusy(f, LABEL, log)
const removeOwnMarker = (f, runId) => Board.releaseBoard(f, LABEL, runId)
const markerText = Board.markerText

async function health() {
  try {
    const r = await fetch(`${SITE}/api/health`, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) })
    const j = await r.json()
    return { commit: j.commit || j.git_sha || null, buildId: j.build_id || null, uptimeS: j.uptime_seconds ?? null }
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 160) } }
}

/** Scores every run's raw result into the row (two, twoRecheck, typed, soak, pageErrors) and returns the
 * builds the runs saw and what each run says about itself (switches set, sampler throws). */
function scoreInto(row, results) {
  const two = results.two
  if (two && two.j) row.two = R.scoreTwo(two.j)
  const re = results['two-recheck']
  if (re && re.j) { const s = R.scoreTwo(re.j); row.twoRecheck = { medMs: s.medMs, p90Ms: s.p90Ms, painted: s.painted, missed: s.missed } }
  row.typed = {}
  for (const tf of R.TYPED_TFS) { const res = results[`typed-${tf}`]; if (res && res.j) row.typed[tf] = R.scoreTyped(res.j) }
  const soak = results.soak
  if (soak && soak.j) row.soak = R.scoreSoak(soak.j, 100)
  row.pageErrors = { count: 0, rejections: 0, byRun: {}, first: [] }
  const builds = new Set()
  const said = []
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
    if (set.length) said.push({ step: name, failure: `the profile holds ${set.map(([k, v]) => `${k}=${v}`).join(', ')}: not production's defaults` })
    if (j.sampleErrs) said.push({ step: name, note: `${name}: the frame sampler threw ${j.sampleErrs} time(s)` })
    if (j.build && j.build.commit) builds.add(j.build.commit)
  }
  return { builds, said }
}

/** One canary run. The caller holds the heavy lock (perf-nightly's, or the CLI's). onBusy: 'handBack' returns
 * { busy: true } when the board marker is held; 'record' records the night as incomplete instead. */
export async function runCanary(opts = {}) {
  const o = { dir: DEFAULT_DIR, port: '9447', trigger: 'manual', pool: '', boardBusy: '', onBusy: 'record', stepTimeoutMin: 0, proof: DEFAULT_PROOF, nightlyHistory: DEFAULT_HISTORY, ...opts }
  const profile = o.profile || join(o.dir, 'profile')
  const log = logTo(o.dir)
  const runId = o.runId || makeRunId()
  const started = new Date()
  const today = localDate(started)
  const history = readJsonl(o.nightlyHistory)
  const failures = []
  const notes = []
  const row = { v: 2, runId, date: today, startedAt: started.toISOString(), trigger: o.trigger, status: 'ok', site: SITE }
  const finish = (results = {}) => {
    const ended = new Date()
    row.endedAt = ended.toISOString()
    row.runtimeS = Math.round((ended - started) / 1000)
    row.failures = failures
    row.notes = notes
    row.steps = Object.fromEntries(Object.entries(results).map(([k, r]) => [k, { code: r.code, timedOut: r.timedOut, seconds: r.seconds }]))
    if (failures.length) row.status = 'incomplete'
    const RUN_DIR = join(o.dir, 'runs', runId)
    mkdirSync(RUN_DIR, { recursive: true })
    writeFileSync(join(RUN_DIR, 'row.json'), JSON.stringify(row, null, 1))
    const out = record(o.dir, row, history)
    log(`${runId}: ${row.runtimeS} s; ${out.regressions.length ? out.regressions.join(' | ') : 'no regression'}`)
    return { row, ...out }
  }

  if (o.boardBusy && !Board.takeBoard(o.boardBusy, LABEL, runId, 'flip-proof runs on the bench board (uct-desktop scripts/nightly/chart-canary.mjs)')) {
    const held = String(markerText(o.boardBusy)).slice(0, 160)
    if (o.onBusy === 'handBack') { log(`canary ${runId}: the bench board is busy (${held}): handing the lock back`); return { busy: true } }
    failures.push({ step: 'canary', why: `the bench board was busy (${o.boardBusy}: ${held})` })
    return finish()
  }

  const RUN_DIR = join(o.dir, 'runs', runId)
  mkdirSync(RUN_DIR, { recursive: true })
  const elapsedMin = () => (Date.now() - started.getTime()) / 60000
  const childEnv = { ...process.env }
  delete childEnv.UCT_PROOF_BASE // production only

  const runProof = (name, args, timeoutMin) => {
    const out = join(RUN_DIR, `${name}.json`)
    const fd = openSync(join(RUN_DIR, `${name}.log`), 'a')
    return new Promise((done) => {
      const t0 = Date.now()
      const child = spawn(process.execPath, [o.proof, out, ...args], { cwd: REPO, env: childEnv, stdio: ['ignore', fd, fd], windowsHide: true })
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
  const COMMON = ['--headless=1', '--cheap-sampler=1', `--profile=${profile}`, `--port=${o.port}`, '--graceful-close=1']

  // The proof records boardVersionBefore just before it applies its test board and saves its result right
  // after: a run with no version recorded never changed the board. A killed run, or a refused restore, has
  // not put it back, so the canary does.
  const ensureBoard = async (res) => {
    const j = res.j || {}
    if (j.boardRestore === 200 || j.boardRestore === 'unchanged') return
    const v = j.boardVersionBefore
    if (typeof v !== 'number') { notes.push(`${res.name}: stopped before its test board was applied (nothing to restore)`); return }
    log(`${res.name}: board restore not confirmed (${JSON.stringify(j.boardRestore ?? null)}); restoring version ${v}`)
    const r = await runProof(`${res.name}-restore`, [`--restore=${v}`, '--headless=1', `--profile=${profile}`, `--port=${o.port}`, '--graceful-close=1'], 5)
    const st = r.j && r.j.boardRestore
    if (st === 200 || st === 'unchanged') notes.push(`${res.name}: the bench board was put back by the canary (version ${v})`)
    else failures.push({ step: res.name, why: `the bench board was NOT restored (version ${v}; ${JSON.stringify(st ?? null)}): run the proof with --restore=${v}` })
  }
  const why = (res) => {
    if (res.timedOut) return `timed out and was stopped (${res.seconds} s)`
    const e = res.j && res.j.error
    if (e) return String(e).split('\n')[0].slice(0, 200)
    if (!res.j) return `exited ${res.code} without a result file`
    return `exited ${res.code}`
  }
  const step = async (s, results) => {
    const left = BUDGET_MIN - elapsedMin()
    if (left < 3) { failures.push({ step: s.name, why: `skipped: the canary was at ${elapsedMin().toFixed(1)} of its ${BUDGET_MIN} min` }); return null }
    log(`${runId} ${s.name}: start`)
    const res = await runProof(s.name, [...s.args, ...COMMON], Math.min(o.stepTimeoutMin || s.timeoutMin, left))
    log(`${runId} ${s.name}: exit ${res.code}${res.timedOut ? ' (timed out)' : ''} in ${res.seconds} s`)
    results[s.name] = res
    await ensureBoard(res)
    return res
  }

  const results = {}
  try {
    // memory first: a canary that starts on a loaded box measures the box
    for (let k = 0; freemem() / 2 ** 30 < MIN_FREE_GB && k < 20; k++) {
      if (k === 0) log(`free RAM ${(freemem() / 2 ** 30).toFixed(1)} GB < ${MIN_FREE_GB} GB: waiting (up to 10 min)`)
      await new Promise((r) => setTimeout(r, 30000))
    }
    if (freemem() / 2 ** 30 < MIN_FREE_GB) throw Object.assign(new Error(`free RAM stayed under ${MIN_FREE_GB} GB for 10 min`), { step: 'canary' })

    const rows = readJsonl(paths(o.dir).rows)
    const pool = o.pool ? readFileSync(o.pool, 'utf8').split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean) : R.DEFAULT_POOL
    const night = R.nightIndex(rows, today)
    const typed = R.typedForNight(pool, night)
    const tonight = new Set(Object.values(typed).flat())
    const earlier = R.nightsBefore(rows, today).reverse()
    const lastIdx = earlier.findIndex((r) => Object.values(r.typed || {}).some((s) => (s.perSym || []).some((p) => tonight.has(p.sym))))
    row.typedPool = { size: pool.length, night, cycle: Math.floor(pool.length / R.TYPED_PER_TF), lastTypedNightsAgo: lastIdx < 0 ? null : lastIdx + 1 }

    const b0 = await health()
    const firstWarmup = existsSync(profile) ? 90000 : 150000 // a new profile ingests the bars pack first
    const TWO = ['--tf=D', '--tf2=60', '--set=mixed', '--dwell=800', '--list=S&P 500']
    await step({ name: 'two', args: [...TWO, '--flips=30', `--warmup=${firstWarmup}`], timeoutMin: 9 }, results)
    for (const tf of R.TYPED_TFS) await step({ name: `typed-${tf}`, args: [`--tf=${tf}`, '--set=base', '--pattern=typed', `--typed=${typed[tf].join(',')}`, '--dwell=3000', '--warmup=20000'], timeoutMin: 6 }, results)
    await step({ name: 'soak', args: [...TWO, '--flips=100', '--soak-every=50', `--abort-heap-mb=${ABORT_HEAP_MB}`, '--warmup=20000'], timeoutMin: 10 }, results)
    // an over-the-limit both-on-screen median is measured again before it counts (the nightly check's rule)
    if (results.two && results.two.j) {
      const since = R.lastAccept(history)
      const first = R.scoreTwo(results.two.j)
      if (R.speedOver(first.medMs, R.priorNights(rows, today, R.RULES.trailingNights, since)).over) {
        log(`${runId}: both on screen ${first.medMs} ms is over the limit; measuring again`)
        await step({ name: 'two-recheck', args: [...TWO, '--flips=30', '--warmup=20000'], timeoutMin: 6 }, results)
      }
    }
    if (o.boardBusy) removeOwnMarker(o.boardBusy, runId) // every run's board is back: free for the others

    const { builds, said } = scoreInto(row, results)
    for (const s of said) { if (s.failure) failures.push({ step: s.step, why: s.failure }); if (s.note) notes.push(s.note) }
    const usable = (res, scored) => res && res.j && !res.timedOut && res.code === 0 && !res.j.error && scored && scored.painted > 0
    for (const name of ['two', 'two-recheck']) {
      const res = results[name]
      const scored = res && res.j ? R.scoreTwo(res.j) : null
      if (res && !usable(res, scored)) failures.push({ step: name, why: why(res) + (scored && !scored.painted ? '; no switch painted' : '') })
    }
    for (const tf of R.TYPED_TFS) {
      const res = results[`typed-${tf}`]
      if (res && !usable(res, row.typed[tf])) failures.push({ step: `typed-${tf}`, why: why(res) + (row.typed[tf] && !row.typed[tf].painted ? '; nothing painted' : '') })
    }
    const soak = results.soak
    if (soak) {
      const aborted = soak.j && /over the \d+ MB abort line/.test(String(soak.j.error || ''))
      // stopping at the abort line IS the measurement (the rule reads the scaled number); anything else fails
      if (aborted) notes.push(`the soak stopped at the ${ABORT_HEAP_MB} MB abort line after ${row.soak.reached} switches`)
      else if (!soak.j || soak.timedOut || soak.code !== 0 || soak.j.error || !row.soak.complete) failures.push({ step: 'soak', why: why(soak) })
    }

    const b1 = await health()
    const firstBuild = b0.commit || [...builds][0] || null
    row.build = { commit: firstBuild, buildId: b0.buildId || null, uptimeS: b0.uptimeS ?? null, ...(b0.error ? { healthError: b0.error } : {}) }
    const seen = new Set([...builds, ...(b1.commit ? [b1.commit] : [])])
    if (firstBuild) seen.delete(firstBuild)
    if (seen.size) { row.build.changedDuringRun = true; row.build.otherCommits = [...seen]; notes.push('a deploy landed during the run: tonight mixes two builds') }
  } catch (e) {
    failures.push({ step: e.step || 'canary', why: String((e && e.message) || e).slice(0, 300) })
  } finally {
    if (o.boardBusy) removeOwnMarker(o.boardBusy, runId)
  }
  const out = finish(results)
  // raw runs older than 30 days go (only folders this canary made: a runs/<id>/row.json beside them)
  try {
    for (const name of readdirSync(join(o.dir, 'runs'))) {
      const p = join(o.dir, 'runs', name)
      if (!/^\d{8}-\d{6}$/.test(name) || name === runId || !existsSync(join(p, 'row.json'))) continue
      if (Date.now() - statSync(join(p, 'row.json')).mtimeMs > 30 * 86400000) rmSync(p, { recursive: true, force: true })
    }
  } catch { /* housekeeping only */ }
  return out
}

/** Score a recorded run's raw files again (the rules changed): its row's measures are rebuilt, its
 * failures, notes, build and times are kept, and the row and latest.md are rewritten. */
export function rescore(runId, opts = {}) {
  const o = { dir: DEFAULT_DIR, nightlyHistory: DEFAULT_HISTORY, ...opts }
  const RUN_DIR = join(o.dir, 'runs', runId)
  const row = JSON.parse(readFileSync(join(RUN_DIR, 'row.json'), 'utf8'))
  const results = {}
  for (const f of readdirSync(RUN_DIR)) {
    const m = f.match(/^(two|two-recheck|typed-\w+|soak)\.json$/)
    if (m) { try { results[m[1]] = { j: JSON.parse(readFileSync(join(RUN_DIR, f), 'utf8')) } } catch { /* unreadable */ } }
  }
  scoreInto(row, results)
  row.rescoredAt = new Date().toISOString()
  writeFileSync(join(RUN_DIR, 'row.json'), JSON.stringify(row, null, 1))
  return { row, ...record(o.dir, row, readJsonl(o.nightlyHistory), { replace: true }) }
}

// ── by hand: queue for the heavy lock (unless already inside one), then measure ──
async function cli() {
  const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
  const opts = {
    dir: arg('dir', DEFAULT_DIR),
    profile: arg('profile', ''),
    port: arg('port', '9447'), // not the proof's default 9441, so a hand run elsewhere never collides
    trigger: arg('trigger', 'manual'),
    pool: arg('pool', ''), // comma/newline-separated tickers instead of the default 36
    boardBusy: arg('board-busy', ''),
    stepTimeoutMin: Number(arg('step-timeout-min', '0')), // (smoke tests) cap every run's timeout
    proof: arg('proof', DEFAULT_PROOF), // (smoke tests) a stand-in for the flip proof
  }
  const log = logTo(opts.dir)
  const re = arg('rescore', '')
  if (re) { const r = rescore(re, opts); console.log(readFileSync(r.latestPath, 'utf8')); return 0 }
  if (process.env.UCT_HEAVY_LOCK) {
    const r = await runCanary({ ...opts, runId: process.env.CANARY_RUN_ID || undefined, onBusy: 'handBack' })
    if (r.busy) return BUSY
    console.log(readFileSync(r.latestPath, 'utf8'))
    return r.regressions.length ? 3 : 0
  }
  const lockMin = Number(arg('lock-timeout-min', '75'))
  const runId = makeRunId()
  const t0 = new Date()
  const deadline = t0.getTime() + lockMin * 60000
  let code = 1
  let busyAtDeadline = false
  for (;;) {
    let said = false
    while (boardIsBusy(opts.boardBusy, log) && Date.now() < deadline) {
      if (!said) { log(`canary ${runId}: the bench board is busy (${opts.boardBusy}: ${String(markerText(opts.boardBusy)).slice(0, 160)}); waiting`); said = true }
      await new Promise((r) => setTimeout(r, 60000))
    }
    const left = Math.round((deadline - Date.now()) / 1000)
    if (boardIsBusy(opts.boardBusy, log) || left < 60) { busyAtDeadline = boardIsBusy(opts.boardBusy, log); code = busyAtDeadline ? BUSY : 1; break }
    log(`canary ${runId}: queueing for the heavy lock (normal priority, up to ${Math.round(left / 60)} min)`)
    const r = spawnSync('python', [LOCK_PY, '--label', 'chart-canary', '--priority', 'normal', '--timeout', String(left), 'run', '--', process.execPath, SELF, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, CANARY_RUN_ID: runId } })
    code = r.status ?? 1
    removeOwnMarker(opts.boardBusy, runId) // a run killed inside the lock cannot remove its own
    if (code !== BUSY) break
    log(`canary ${runId}: the board was taken while queued; lock handed back, waiting again`)
  }
  if (!readJsonl(paths(opts.dir).rows).some((x) => x.runId === runId)) {
    // the canary never wrote its row: the lock wait ran out, the board stayed busy, or the run died. Recorded.
    const now = new Date()
    const why = busyAtDeadline
      ? `the bench board stayed busy until the deadline (${lockMin} min; ${opts.boardBusy}: ${String(markerText(opts.boardBusy)).slice(0, 120)})`
      : `the heavy-lock run exited ${code} before the canary recorded anything (the wait is ${lockMin} min; see log.txt)`
    const row = { v: 2, runId, date: localDate(t0), startedAt: t0.toISOString(), endedAt: now.toISOString(), runtimeS: Math.round((now - t0) / 1000), trigger: opts.trigger, status: 'incomplete', failures: [{ step: 'canary', why }], notes: [] }
    record(opts.dir, row, readJsonl(DEFAULT_HISTORY))
    log(`canary ${runId}: no row from the locked run (exit ${code}); recorded as incomplete`)
  }
  return code
}

if (process.argv[1] && resolve(process.argv[1]) === SELF) process.exit(await cli())
