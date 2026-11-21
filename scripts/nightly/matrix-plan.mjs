// Which acceptance-matrix slice the nightly speed check runs tonight (perf-nightly.mjs step 6). Pure, so it is
// unit-tested (test/matrix-plan.test.ts). Weeknights: the owner's CORE grid and its CADENCE motions (24 + 18
// cells) into a folder of its own each night.
// Saturday and Sunday nights: the FULL matrix in resumable slices, all into one pass folder (named by
// <root>/full-pass.json) until every one of its cells is scored; the night after that a new pass starts.

const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`

/** -> { grid, out, budgetMin, newPass } (newPass: the pointer to write, or null). `pass` = the current pointer
 * ({ dir }) or null; `status` = that pass's status.json ({ todo }) or null when it has not started. */
export function matrixPlan(now, root, pass, status, env = {}) {
  const weekend = now.getDay() === 0 || now.getDay() === 6
  if (!weekend) return { grid: 'core,cadence', out: `${root}/core-${ymd(now)}`, budgetMin: Number(env.UCT_MATRIX_CORE_MIN || 120), newPass: null }
  const done = !!(status && status.todo === 0)
  const newPass = !pass || done ? { dir: `${root}/full-${ymd(now)}`, started: now.toISOString() } : null
  return { grid: 'full', out: (newPass || pass).dir, budgetMin: Number(env.UCT_MATRIX_WEEKEND_MIN || 360), newPass }
}
