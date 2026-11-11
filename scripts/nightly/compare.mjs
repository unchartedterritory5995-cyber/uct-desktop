// Nightly speed check (plan Step 9.1): the pure rules. A run is page-cost.mjs's results file; a
// baseline is one row per route. No I/O here, so every rule is unit-tested (test/nightly-compare.test.ts).

/** Per metric: how far above the baseline counts as slower. Absolute floors keep a near-zero baseline
 * (idle rAF 0, layouts 0) from alarming on noise; ratios scale with busy pages. */
export const TOLERANCE = {
  busyPct: { ratio: 1.5, plus: 2 }, // main-thread busy share, percentage points
  layoutsPerS: { ratio: 1, plus: 3 },
  recalcsPerS: { ratio: 1, plus: 5 },
  rafPerS: { ratio: 1, plus: 10 }, // an idle page should schedule ~0; a loop that never rests is ~60
  requestsPerMin: { ratio: 1.5, plus: 10 },
  heapMB: { ratio: 1.3, plus: 20 },
}
export const METRICS = Object.keys(TOLERANCE)
/** Baseline = per-metric median of the last BASELINE_RUNS passing runs. */
export const BASELINE_RUNS = 7

export function limitFor(metric, base) {
  const t = TOLERANCE[metric]
  return Math.max(base * t.ratio, base + t.plus)
}

/** Rows of `run` worse than `baseline` beyond tolerance. A route missing from the baseline is new: no verdict. */
export function findRegressions(baseline, run) {
  const out = []
  for (const row of run.routes || []) {
    const base = (baseline.routes || []).find((b) => b.route === row.route)
    if (!base) continue
    for (const metric of METRICS) {
      const b = base[metric]
      const cur = row[metric]
      if (typeof b !== 'number' || typeof cur !== 'number') continue
      const limit = limitFor(metric, b)
      if (cur > limit) out.push({ route: row.route, metric, base: b, cur, limit: Math.round(limit * 10) / 10 })
    }
  }
  return out
}

/** A regression counts only if the re-measure of that route is also over the limit (one noisy minute is not a slowdown). */
export function confirmedRegressions(first, recheck) {
  return first.filter((r) => recheck.some((x) => x.route === r.route && x.metric === r.metric))
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** Baseline from history entries `{ status, run }`: median of the last BASELINE_RUNS with status 'pass'
 * since the last 'reset' (a run that alarmed never becomes the yardstick; a reset, from --accept, makes
 * the next night the new normal). null when there is none. */
export function baselineFrom(history) {
  const reset = history.map((h) => h.status).lastIndexOf('reset')
  const passing = history.slice(reset + 1).filter((h) => h.status === 'pass' && h.run?.routes?.length).slice(-BASELINE_RUNS)
  if (!passing.length) return null
  const routes = [...new Set(passing.flatMap((h) => h.run.routes.map((r) => r.route)))]
  return {
    runs: passing.length,
    routes: routes.map((route) => {
      const rows = passing.map((h) => h.run.routes.find((r) => r.route === route)).filter(Boolean)
      const row = { route }
      for (const metric of METRICS) {
        const xs = rows.map((r) => r[metric]).filter((v) => typeof v === 'number')
        if (xs.length) row[metric] = median(xs)
      }
      return row
    }),
  }
}

/** How many runs at the end of history could not measure at all (window covered, app failed). */
export function trailingBlind(history) {
  let n = 0
  for (let i = history.length - 1; i >= 0 && history[i].status === 'blind'; i--) n++
  return n
}
/** Post a "the check is blind" notice on exactly this many blind nights in a row (once, not nightly). */
export const BLIND_ALERT_AFTER = 3

/** A slowdown is posted the first night, then again every REMIND_EVERY nights while it lasts. */
export const REMIND_EVERY = 7
export function shouldPostRegression(history) {
  let n = 0
  for (let i = history.length - 1; i >= 0 && history[i].status === 'regressed'; i--) n++
  return n % REMIND_EVERY === 0
}

const LABEL = {
  busyPct: 'main thread busy %',
  layoutsPerS: 'layouts/s',
  recalcsPerS: 'style recalcs/s',
  rafPerS: 'animation frames/s',
  requestsPerMin: 'requests/min',
  heapMB: 'memory MB',
}

export function formatRegressionAlert(regressions, meta) {
  const lines = regressions.map((r) => `- \`${r.route}\` ${LABEL[r.metric]}: ${r.cur} (normal ${r.base}, limit ${r.limit})`)
  return [
    `**Desktop nightly speed check: slower than normal** (${meta.date}, app ${meta.appVersion}, site build ${meta.build || '?'})`,
    ...lines,
    'Measured twice, both over the limit. Results: `uct-desktop/proof-output/nightly/`.',
  ].join('\n').slice(0, 1900)
}

export function formatBlindAlert(nights, reason) {
  return `**Desktop nightly speed check could not measure** for ${nights} nights in a row (last reason: ${String(reason).slice(0, 200)}). Until it measures again it is not watching for slowdowns. Log: \`uct-desktop/proof-output/nightly/log.txt\`.`
}
