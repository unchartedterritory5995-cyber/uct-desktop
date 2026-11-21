// The chart RELEASE GATE (coordinator 2026-11-21): no chart change is promoted unless it is equal or faster on
// pixels_both and the core grid shows no cell worse than the production baseline. One command per SHA:
//
//   node scripts/proofs/chart-release.mjs gate <master-sha>   BEFORE PROMOTION: build that master SHA (production's
//        web-front flags, the app's own vite build, so lightweight-charts is patched), run the 24-cell CORE grid on
//        it against production's API, compare with the baseline: one line PASS / REGRESSION / INCONCLUSIVE (a
//        REGRESSION names its cells and blocks the promotion). Exit 0 / 3 / 4.
//   node scripts/proofs/chart-release.mjs pr <head-sha>       a chart PR's author: the same on the 8-cell owner
//        subset (D+30m x S&P 500, Russell 2000 x next row, 12-row, 70-row, typed)
//   node scripts/proofs/chart-release.mjs baseline <results.json | run folder>   make that run THE baseline (a copy
//        is kept, immutable; D:/uct-history/acceptance/baseline.json points at it)
//   node scripts/proofs/chart-release.mjs build <sha>         only the build, into D:/uct-history/dist-<sha>
// options: --dashboard=<uct-dashboard git repo> (read only: rev-parse, show, archive)  --node-modules=<an app's
//   node_modules whose package-lock.json matches the SHA's>  --compare=<baseline results.json>  --board-busy=<marker>
//   --budget-min=N  --redo (measure again)
// gate / pr / build take the machine's heavy lock (normal priority, never forced) unless already inside one. The
// build tree goes under D:/uct-history/buildroot and is deleted after (its node_modules junction first); only the
// dist is kept.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const REPO = resolve(dirname(SELF), '..', '..')
const MATRIX = join(REPO, 'scripts', 'proofs', 'acceptance-matrix.mjs')
const LOCK_PY = 'C:/Users/Patrick/uct-clips/tools/heavy_lock.py'
const HIST = 'D:/uct-history'
const ACC = `${HIST}/acceptance`
const POINTER = `${ACC}/baseline.json`
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const [cmd, target] = process.argv.slice(2).filter((x) => !x.startsWith('--'))
const DASH = arg('dashboard', 'C:/Users/Patrick/uct-dashboard')
const log = (m) => console.log(`${new Date().toISOString()} ${m}`)
const sha256 = (buf) => createHash('sha256').update(String(buf).replace(/\r\n/g, '\n')).digest('hex')
const git = (...a) => execFileSync('git', ['-C', DASH, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim()

function resolveSha(ref) {
  if (!ref) throw new Error(`${cmd}: name a commit`)
  try { return git('rev-parse', '--verify', `${ref}^{commit}`) } catch {
    git('fetch', '-q', 'origin')
    return git('rev-parse', '--verify', `${ref}^{commit}`)
  }
}

/** An app node_modules installed from the same lockfile as the commit (its package-lock.json beside it). */
function nodeModulesFor(sha) {
  const want = sha256(git('show', `${sha}:app/package-lock.json`))
  const given = arg('node-modules', '')
  const roots = ['C:/Users/Patrick/uct-worktrees']
  const cands = given ? [given] : [
    `${DASH}/app/node_modules`,
    ...roots.flatMap((r) => { try { return readdirSync(r).map((d) => `${r}/${d}/app/node_modules`) } catch { return [] } }),
  ]
  for (const nm of cands) {
    const lock = join(dirname(nm), 'package-lock.json')
    if (existsSync(join(nm, 'vite')) && existsSync(lock) && sha256(readFileSync(lock, 'utf8')) === want) return nm
  }
  throw new Error(`no node_modules installed from ${sha.slice(0, 10)}'s app/package-lock.json (looked in ${cands.length} places; pass --node-modules=<dir> or npm ci one)`)
}

/** Production's web-front VITE_ flags (the values are never printed). */
function viteFlags() {
  const out = execFileSync('railway.cmd', ['variables', '--service', 'web-front', '--kv'], { cwd: DASH, encoding: 'utf8', shell: true, timeout: 60000 })
  const env = {}
  for (const line of out.split(/\r?\n/)) { const i = line.indexOf('='); if (i > 0 && line.startsWith('VITE_')) env[line.slice(0, i)] = line.slice(i + 1) }
  if (Object.keys(env).length < 6) throw new Error(`only ${Object.keys(env).length} VITE_ flags read from web-front: refusing to build without production's flags`)
  return env
}

/** D:/uct-history/dist-<sha>: the commit's frontend, built the way production builds it. */
function build(sha) {
  const out = `${HIST}/dist-${sha}`
  if (existsSync(join(out, 'index.html')) && !process.argv.includes('--rebuild')) { log(`build ${sha.slice(0, 10)}: already at ${out}`); return out }
  const nm = nodeModulesFor(sha)
  const root = `${HIST}/buildroot/release-${sha.slice(0, 10)}`
  const junction = join(root, 'app', 'node_modules')
  // ⛔ the junction goes BEFORE any recursive delete of the tree: a delete that walked into it would empty the
  // node_modules it points at (someone's worktree)
  const unjunction = () => { if (existsSync(junction)) { try { execFileSync('cmd.exe', ['/c', 'rmdir', junction.replace(/\//g, '\\')], { stdio: 'ignore' }) } catch { /* not there */ } } }
  unjunction()
  if (existsSync(junction)) throw new Error(`could not remove the old junction ${junction}: refusing to delete the tree`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  try {
    log(`build ${sha.slice(0, 10)}: archive, node_modules ${nm}`)
    const r = spawnSync('bash', ['-c', `git -C "${DASH}" archive ${sha} app | tar -x -C "${root}"`], { stdio: 'inherit' })
    if (r.status !== 0 || !existsSync(join(root, 'app', 'package.json'))) throw new Error('git archive of app/ failed')
    if (existsSync(junction)) throw new Error('the archive carried a node_modules')
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction.replace(/\//g, '\\'), nm.replace(/\//g, '\\')], { stdio: 'ignore' })
    const env = { ...process.env, ...viteFlags(), NODE_OPTIONS: '--max-old-space-size=8192' }
    const logFile = `${out}.build.log`
    const b = spawnSync('npm.cmd', ['run', 'build'], { cwd: join(root, 'app'), env, encoding: 'utf8', shell: true, maxBuffer: 256 * 1024 * 1024 })
    writeFileSync(logFile, (b.stdout || '') + (b.stderr || ''))
    if (b.status !== 0) throw new Error(`the build failed (exit ${b.status}): ${logFile}`)
    rmSync(out, { recursive: true, force: true })
    cpSync(join(root, 'app', 'dist'), out, { recursive: true })
    writeFileSync(join(out, '.sha'), sha + '\n')
    log(`build ${sha.slice(0, 10)}: ${out}`)
    return out
  } finally {
    unjunction()
    if (!existsSync(junction)) rmSync(root, { recursive: true, force: true })
    else log(`JUNCTION STILL THERE: left ${root} in place`)
  }
}

function baselineFile() {
  const given = arg('compare', '')
  if (given) return existsSync(join(given, 'results.json')) ? join(given, 'results.json') : given
  try { return JSON.parse(readFileSync(POINTER, 'utf8')).file } catch { return null }
}

/** The grid on a build against the baseline; the verdict line and its exit code. */
function measure(sha, grid, kind) {
  const base = baselineFile()
  if (!base || !existsSync(base)) throw new Error(`no baseline (${POINTER}): record one with \`chart-release.mjs baseline <run folder>\``)
  const dist = build(sha)
  const out = `${ACC}/${kind}-${sha.slice(0, 10)}`
  const args = [MATRIX, `--grid=${grid}`, `--dist=${dist}`, `--compare=${base}`, `--out=${out}`,
    ...['board-busy', 'budget-min'].filter((k) => arg(k, '')).map((k) => `--${k}=${arg(k, '')}`), ...(process.argv.includes('--redo') ? ['--redo'] : [])]
  log(`${kind} ${sha.slice(0, 10)}: the ${grid} grid on ${dist} vs ${base}`)
  spawnSync(process.execPath, args, { cwd: REPO, stdio: 'inherit' })
  let st = null
  try { st = JSON.parse(readFileSync(join(out, 'status.json'), 'utf8')) } catch { /* nothing written */ }
  const line = st && st.compare ? st.compare.line : 'INCONCLUSIVE: the grid wrote no comparison'
  const verdict = st && st.compare ? st.compare.verdict : 'INCONCLUSIVE'
  const text = `${kind.toUpperCase()} ${sha.slice(0, 10)} (${grid} grid, ${st ? `${st.scored}/${st.cells} cells` : 'no cells'}) vs baseline ${base}: ${line}`
  writeFileSync(join(out, 'verdict.txt'), text + '\n')
  console.log(text)
  return verdict === 'PASS' ? 0 : verdict === 'REGRESSION' ? 3 : 4
}

function setBaseline(from) {
  const file = existsSync(join(from || '', 'results.json')) ? join(from, 'results.json') : from
  const rows = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${file}: no results`)
  if (!rows.some((r) => r.summary && r.summary.stamp === 'pixels')) throw new Error(`${file}: not measured on pixels_both (no presentation stamp): not a baseline`)
  const loaded = rows.filter((r) => r.loaded).map((r) => r.id)
  const builds = [...new Set(rows.map((r) => r.build && r.build.commit).filter(Boolean))]
  const d = new Date()
  const keep = `${ACC}/baseline-${d.toISOString().slice(0, 10)}-${(builds[0] || 'unknown').slice(0, 10)}.json`
  mkdirSync(ACC, { recursive: true })
  copyFileSync(file, keep)
  writeFileSync(POINTER, JSON.stringify({ file: keep, from: file, builds, cells: rows.length, loadedCells: loaded, setAt: d.toISOString() }, null, 1))
  console.log(`baseline: ${keep} (${rows.length} cells, build ${builds.join(', ') || '?'}${loaded.length ? `; ${loaded.length} cell(s) were measured UNDER LOAD: ${loaded.join(', ')}` : ''})`)
  return 0
}

async function main() {
  if (cmd === 'baseline') return setBaseline(target)
  if (!['gate', 'pr', 'build'].includes(cmd)) { console.log('usage: chart-release.mjs gate <master-sha> | pr <head-sha> | baseline <results.json|run folder> | build <sha>'); return 2 }
  const sha = resolveSha(target)
  if (!process.env.UCT_HEAVY_LOCK) {
    // the heavy lock first (normal priority, never forced): the build and the grid are one job
    const r = spawnSync('python', [LOCK_PY, '--label', `chart-${cmd}-${sha.slice(0, 10)}`, '--priority', 'normal', '--timeout', '14400', 'run', '--', process.execPath, SELF, cmd, sha, ...process.argv.slice(2).filter((x) => x.startsWith('--'))], { stdio: 'inherit' })
    return r.status ?? 1
  }
  if (cmd === 'build') { build(sha); return 0 }
  return measure(sha, cmd === 'gate' ? 'core' : 'pr', cmd)
}

process.exit(await main())
