// The owner's chart ACCEPTANCE MATRIX runner (coordinator brief 2026-11-20). Every cell = one flip-proof run
// (scripts/proofs/indicator-flip-proof.mjs) on production as the synthetic bench member, headless Chrome, a FRESH
// throwaway profile (deleted after the run), scored switch by switch against the owner's bar
// (acceptance-matrix-lib.mjs BAR): linked charts in the same frame, within 40 ms, one paint, no follow-up heavy
// re-render, no memory growth, no page error.
//
//   node scripts/proofs/acceptance-matrix.mjs [selection] [options]      measure what is not yet measured
//   node scripts/proofs/acceptance-matrix.mjs --report [selection]       rewrite grid.md from what is recorded
//   node scripts/proofs/acceptance-matrix.mjs --plan [selection]         list the cells and the time they take
// selection: --grid=core (DEFAULT: the owner's core grid, 24 cells: D+60m and D+30m x S&P 500, Russell 2000,
//   Bull & Bear ETFs x every motion, production's own device-store setting) | --grid=full (896 cells: every layout,
//   list and motion, store off and on); then any of --layouts=D+60m,W --lists=sp500 --motions=next,typed
//   --stores=off,on,default replaces that dimension (ids: acceptance-matrix-lib.mjs LAYOUTS / LISTS / MOTIONS / STORES)
// options: --out=<dir> (default D:/uct-history/acceptance/<--name, default today's date>)  --redo (measure again)
//   --budget-min=N (start no cell after N minutes; the next run resumes)  --dist=<dir> (a candidate build)
//   --render-probe-dist=<dir> (measure a RENDER-PROBE build: its StockChart renders are counted; the same as
//   --dist=<dir> --render-probe=1)  --user-list=<name> (the bench
//   member's own list for the `user` row)  --screen-id=<n> (a saved screen for `screener`)  --typed-pool=<file>
//   --board-busy=<marker file>  --dwell-next/--dwell-jump/--dwell-typed=ms  --warmup=ms  --set=base
// RESUMABLE: each cell writes cells/<id>.json (the raw run) and cells/<id>.score.json; a cell with a score is not
// run again (unless --redo). EACH CELL is its own heavy_lock job (normal priority, never forced), so the machine's
// other jobs interleave; inside an existing heavy-lock hold the cells run back to back instead. The bench board is
// put back after every run (the proof restores it; a run that could not is restored here with --restore).
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as M from './acceptance-matrix-lib.mjs'
import * as Board from './bench-board.mjs'

const SELF = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SELF), '..', '..')
const LOCK_PY = 'C:/Users/Patrick/uct-clips/tools/heavy_lock.py'
const LABEL = 'chart-acceptance'
const BUSY = 75
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
const pad = (n) => String(n).padStart(2, '0')
const now = new Date()
const today = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
const OUT = arg('out', `D:/uct-history/acceptance/${arg('name', today)}`)
const CELLS = join(OUT, 'cells')
mkdirSync(CELLS, { recursive: true })
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(OUT, 'log.txt'), line + '\n') }
const list = (k) => arg(k, '').split(',').map((s) => s.trim()).filter(Boolean)
const GRID = arg('grid', 'core')
const filters = M.selection(GRID, { layouts: list('layouts'), lists: list('lists'), motions: list('motions'), stores: list('stores') })
const opts = {
  dwellNext: Number(arg('dwell-next', M.DEFAULTS.dwellNext)), dwellJump: Number(arg('dwell-jump', M.DEFAULTS.dwellJump)), dwellTyped: Number(arg('dwell-typed', M.DEFAULTS.dwellTyped)),
  warmup: Number(arg('warmup', M.DEFAULTS.warmup)), set: arg('set', M.DEFAULTS.set), port: Number(arg('port', M.DEFAULTS.port)),
  dist: arg('render-probe-dist', '') || arg('dist', ''), renderProbe: !!arg('render-probe-dist', '') || arg('render-probe', '') === '1', userList: arg('user-list', ''), screenId: arg('screen-id', ''),
}
const BOARD_BUSY = arg('board-busy', '')
// --proof=<file>: a stand-in for the flip proof (the runner's own smoke test); the real one otherwise
const PROOF = arg('proof', join(REPO, 'scripts', 'proofs', 'indicator-flip-proof.mjs'))
const pool = arg('typed-pool', '') ? readFileSync(arg('typed-pool', ''), 'utf8').split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean) : M.TYPED_POOL
const day = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000)
const typedOrder = M.expandCells({}).filter((c) => c.motion === 'typed').map((c) => c.id) // a subset types what the full run would
const scorePath = (id) => join(CELLS, `${id}.score.json`)
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

function planFor(cell) {
  const typed = cell.motion === 'typed' ? M.typedFor(pool, day, typedOrder.indexOf(cell.id)) : []
  return { typed, ...M.cellArgs(cell, opts, typed) }
}
// a rough cell time: boot + warm-up + each switch's dwell and its own overhead (+ the device store's seed wait)
const estimateS = (cell) => { const m = M.MOTIONS[cell.motion]; const dw = { next: opts.dwellNext, jump12: opts.dwellJump, jump70: opts.dwellJump, typed: opts.dwellTyped }[cell.motion]; return 25 + opts.warmup / 1000 + (cell.store === 'on' ? 90 : 0) + m.flips * (dw / 1000 + (cell.motion === 'next' ? 0.3 : 0.9)) + 10 }

function runProof(out, args, timeoutMin) {
  const fd = openSync(out.replace(/\.json$/, '.log'), 'a')
  const profiles = () => { try { return new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('uct-clean-chrome-'))) } catch { return new Set() } }
  const before = profiles()
  return new Promise((done) => {
    const t0 = Date.now()
    const env = { ...process.env }
    delete env.UCT_PROOF_BASE // production only
    const child = spawn(process.execPath, [PROOF, out, ...args], { cwd: REPO, env, stdio: ['ignore', fd, fd], windowsHide: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* gone */ } }, timeoutMin * 60000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      closeSync(fd)
      // the throwaway profile: the proof deletes it; one it left (a killed run) is deleted here
      for (const n of profiles()) if (!before.has(n)) { try { rmSync(join(tmpdir(), n), { recursive: true, force: true }); log(`deleted a profile the run left: ${n}`) } catch { /* held */ } }
      done({ code, timedOut, seconds: Math.round((Date.now() - t0) / 1000), j: readJson(out) })
    })
  })
}

/** One cell, inside the heavy lock: run, put the board back if the run could not, score, record. */
async function measureCell(cell) {
  const plan = planFor(cell)
  if (plan.skip) { writeFileSync(scorePath(cell.id), JSON.stringify({ id: cell.id, cell, verdict: 'SKIP', reasons: [plan.skip], summary: {}, switches: [] }, null, 1)); log(`${cell.id}: SKIP (${plan.skip})`); return 0 }
  if (BOARD_BUSY && !Board.takeBoard(BOARD_BUSY, LABEL, cell.id, `acceptance-matrix cell ${cell.id}`)) { log(`${cell.id}: the bench board is busy (${String(Board.markerText(BOARD_BUSY)).slice(0, 120)}): handing the lock back`); return BUSY }
  try {
    const out = join(CELLS, `${cell.id}.json`)
    log(`${cell.id}: start${plan.typed.length ? ` (typed ${plan.typed.join(',')})` : ''}`)
    const res = await runProof(out, plan.args, 25)
    const v = Board.boardToRestore(res.j)
    if (v != null) {
      log(`${cell.id}: board restore not confirmed; restoring version ${v}`)
      const r = await runProof(join(CELLS, `${cell.id}.restore.json`), [`--restore=${v}`, '--headless=1', `--port=${opts.port}`], 5)
      if (Board.boardToRestore(r.j) != null || !r.j) log(`${cell.id}: BOARD NOT RESTORED: run the proof with --restore=${v}`)
    }
    const j = res.j || { error: res.timedOut ? `timed out after ${res.seconds} s` : `exited ${res.code} without a result`, flips: [] }
    if (res.timedOut && !j.error) j.error = `timed out after ${res.seconds} s`
    const scored = M.scoreCell(j, cell)
    scored.typed = plan.typed
    scored.seconds = res.seconds
    scored.exit = res.code
    writeFileSync(scorePath(cell.id), JSON.stringify(scored, null, 1))
    log(`${cell.id}: ${scored.verdict} ${scored.summary.passed}/${scored.summary.switches} in ${res.seconds} s${scored.reasons.length ? ': ' + scored.reasons.join('; ') : ''}`)
    return 0
  } finally {
    if (BOARD_BUSY) Board.releaseBoard(BOARD_BUSY, LABEL, cell.id)
  }
}

/** grid.md and results.json from every recorded cell score (the worst switches with their timelines). */
function report() {
  const cells = M.expandCells(filters)
  const results = cells.map((c) => readJson(scorePath(c.id))).filter(Boolean)
  const builds = [...new Set(results.map((r) => r.build && r.build.commit).filter(Boolean))]
  const lines = [M.formatGrid(results, cells, { name: OUT.split(/[\\/]/).pop(), builds, dist: opts.dist, renderProbe: opts.renderProbe })]
  const worst = M.worstSwitches(results, 10)
  if (worst.length) {
    lines.push('## The worst switches', '')
    for (const w of worst) {
      const raw = readJson(join(CELLS, `${w.cell}.json`))
      const f = raw && (raw.flips || []).find((x) => x.i === w.i && (x.sym || null) === w.sym)
      lines.push(`### ${w.cell} #${w.i}${w.sym ? ' ' + w.sym : ''}: ${w.reasons.join('; ')}`, '', '```')
      if (f) lines.push(...M.timeline(f, M.LAYOUTS[w.cell.split('__')[1]].length, M.probeRenders(raw.console)))
      else lines.push('(raw run not found)')
      lines.push('```', '')
    }
  }
  writeFileSync(join(OUT, 'grid.md'), lines.join('\n'))
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(results.map(({ switches, ...r }) => r), null, 1))
  // status.json: what a scheduler reads (is this pass complete, and how did it go)
  const verdicts = {}
  for (const r of results) verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1
  writeFileSync(join(OUT, 'status.json'), JSON.stringify({ grid: GRID, cells: cells.length, scored: results.length, todo: cells.length - results.length, verdicts, builds, updated: new Date().toISOString() }, null, 1))
  return join(OUT, 'grid.md')
}

async function main() {
  const cells = M.expandCells(filters)
  if (has('report')) { console.log(readFileSync(report(), 'utf8')); return 0 }
  const todo = cells.filter((c) => has('redo') || !existsSync(scorePath(c.id)))
  const estMin = Math.round(todo.reduce((a, c) => a + estimateS(c), 0) / 60)
  if (has('plan')) {
    for (const c of todo) { const p = planFor(c); console.log(`${c.id}  ${p.skip ? 'SKIP: ' + p.skip : '~' + Math.round(estimateS(c)) + ' s'}`) }
    console.log(`${todo.length} of ${cells.length} cells to measure, about ${estMin} min (${(estMin / 60).toFixed(1)} h)`)
    return 0
  }
  const inner = arg('inner-cell', '')
  if (inner) {
    if (!process.env.UCT_HEAVY_LOCK) { log('refusing: --inner-cell runs only inside the heavy lock'); return 2 }
    const cell = cells.find((c) => c.id === inner) || M.expandCells({}).find((c) => c.id === inner)
    if (!cell) { log(`unknown cell ${inner}`); return 2 }
    return measureCell(cell)
  }
  log(`${todo.length} of ${cells.length} cells to measure (about ${estMin} min) into ${OUT}`)
  const budget = Number(arg('budget-min', '0'))
  const t0 = Date.now()
  for (const cell of todo) {
    if (budget && (Date.now() - t0) / 60000 > budget) { log(`over the ${budget} min budget: stopping; the next run resumes`); break }
    if (process.env.UCT_HEAVY_LOCK) {
      // already inside a hold (a scheduled job wrapped in one lock): back to back, the board marker asked each time
      if ((await measureCell(cell)) === BUSY) { log('the bench board is busy inside this lock hold: stopping (resume later)'); break }
    } else {
      for (let attempt = 1; attempt <= 6; attempt++) {
        let said = false
        while (BOARD_BUSY && Board.boardIsBusy(BOARD_BUSY, LABEL, log)) {
          if (!said) { log(`${cell.id}: the bench board is busy (${String(Board.markerText(BOARD_BUSY)).slice(0, 120)}); waiting`); said = true }
          await new Promise((r) => setTimeout(r, 60000))
        }
        const r = spawnSync('python', [LOCK_PY, '--label', `accept-${cell.id}`.slice(0, 60), '--priority', 'normal', '--timeout', '14400', 'run', '--', process.execPath, SELF, `--inner-cell=${cell.id}`, ...process.argv.slice(2)], { stdio: 'inherit' })
        if (r.status !== BUSY) break
        log(`${cell.id}: the board was taken while queued; waiting again`)
      }
    }
    report()
  }
  const g = report()
  console.log(readFileSync(g, 'utf8'))
  return 0
}

process.exit(await main())
