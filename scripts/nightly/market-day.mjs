// One trading day of measurement on the members' build (members-build.mjs), top half of display 2:
//   1. the all-day soak (scripts/proofs/soak.mjs) until 15:30 ET. Light: no heavy lock, so it never blocks
//      renders or test suites all day.
//   2. the 12-chart board under live ticks near the close (charts-load-proofs.mjs --quick=12, 3 across),
//      then a CPU profile of the same board (--profile=12), each under the heavy lock.
// Started once by a one-time Task Scheduler entry (run-market-day.cmd); output in proof-output/market-day/.
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { membersBuildExe } from './members-build.mjs'

const DIR = join('proof-output', 'market-day')
mkdirSync(DIR, { recursive: true })
const exe = process.env.UCT_PROOF_EXE || membersBuildExe()
if (!exe) throw new Error('no released build under release-out/')
const env = { ...process.env, UCT_PROOF_EXE: exe }
const log = (m) => appendFileSync(join(DIR, 'log.txt'), `${new Date().toISOString()} ${m}\n`)
const run = (file, cmd, args, timeoutMin) => {
  log(`start ${args.join(' ')} (${exe})`)
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: timeoutMin * 60_000 })
  appendFileSync(join(DIR, file), (r.stdout || '') + (r.stderr || ''))
  log(`end exit ${r.status ?? r.signal}`)
}
const node = process.execPath
const lock = (label, args) => ['C:/Users/Patrick/uct-clips/tools/heavy_lock.py','--label', label, 'run', '--', node, ...args]
run('soak.txt', node, ['scripts/proofs/soak.mjs', '--until=15:30', '--display=2'], 8 * 60)
run('charts.txt', 'python', lock('desktop 12-chart market test', ['scripts/proofs/charts-load-proofs.mjs', 'electron', '--quick=12', '--display=2', '--columns=3']), 20)
run('charts.txt', 'python', lock('desktop 12-chart market profile', ['scripts/proofs/charts-load-proofs.mjs', 'electron', '--profile=12', '--display=2', '--columns=3']), 20)
