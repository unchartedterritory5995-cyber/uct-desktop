// Nightly chart canary: the pure rules (scoring the flip proof's output, the trailing nights, the regression
// lines, the typed-ticker rotation, latest.md). No I/O here, so every rule is unit-tested
// (test/chart-canary.test.ts). The runner is chart-canary.mjs.

/** Regression rules (coordinator brief 2026-11-20). */
export const RULES = {
  speedRatio: 1.5, // both-on-screen median above 1.5x the trailing median ...
  speedMinNights: 3, // ... once at least 3 prior nights hold that number
  retainedMBPer100: 300, // JS heap retained (after a full GC) per 100 switches
  trailingNights: 7,
}

/** The typed never-opened tickers: random36.txt (2026-11-19), six blocks of six. */
export const DEFAULT_POOL = 'APPN,NINE,PAYO,WOOF,ADPT,TSLX,EVR,AMN,AVTX,LYEL,TEL,GNK,TM,ARDT,PL,PFS,CMS,ACVA,TRMB,FISV,DAVE,SIBN,CYD,MNR,JFR,PDS,FBP,ACTG,FOA,CSW,FERA,CLBK,BGSI,MEOH,SPXC,AHRT'.split(',')
export const TYPED_TFS = ['D', '60', '5']
export const TYPED_PER_TF = 6

/** Same percentile as the hand scorers (score.py / score2.py): sorted[min(n-1, floor(n*p))]. */
export function pct(xs, p) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

export function median(xs) {
  const v = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

const round = (x) => (x == null ? null : Math.round(x))

/** The first frame of a flip in which `field` (o = chart 1, o2 = chart 2) shows a close other than `before`'s:
 * the new symbol on screen. `n` is when that frame's callback really ran; both are ms after the key. */
export function firstPaint(frames, field, before, key) {
  const parts = typeof before === 'string' ? before.split('|') : []
  const bclose = parts.length >= 3 ? parts[2] : null
  for (const x of frames || []) {
    const c = x && x[field] && x[field].c
    if (!c || c === 'none') continue
    const [bars, , close] = c.split('|')
    if (close !== bclose) return { t: x.t - key, n: (x.n ?? x.t) - key, bars: Number(bars) }
  }
  return null
}

/** Percentiles over painted flips plus the ones that never painted, which count AT the dwell: a lower bound,
 * so a night where charts stop painting reads slower, never faster (an unpainted flip dropped from a median
 * would make the median better). */
function censoredStats(painted, missed, dwell) {
  const xs = [...painted, ...Array(missed).fill(dwell)]
  return { medMs: round(median(xs)), p90Ms: round(pct(xs, 0.9)), maxMs: round(xs.length ? Math.max(...xs) : null), censored: missed > 0 }
}

/** Two linked charts (--tf2): per flip, when BOTH charts show the new symbol (the later of the two frames). */
export function scoreTwo(j) {
  const dwell = Number(j.dwell) || 0
  const both = []
  let missed = 0
  for (const f of j.flips || []) {
    const a = f.key ? firstPaint(f.frames, 'o', f.before && f.before.c, f.key) : null
    const b = f.key ? firstPaint(f.frames, 'o2', f.before2 && f.before2.c, f.key) : null
    if (a && b) both.push(Math.max(a.n, b.n))
    else missed += 1
  }
  return { flips: (j.flips || []).length, painted: both.length, missed, dwellMs: dwell, tf: j.tf, tf2: j.tf2 || null, ...censoredStats(both, missed, dwell) }
}

/** One chart, typed tickers: when the new symbol is first on screen after the Enter. */
export function scoreTyped(j) {
  const dwell = Number(j.dwell) || 0
  const firsts = []
  const perSym = []
  let missed = 0
  for (const f of j.flips || []) {
    const a = f.key ? firstPaint(f.frames, 'o', f.before && f.before.c, f.key) : null
    perSym.push({ sym: f.sym || null, ms: a ? round(a.n) : null, bars: a ? a.bars : null })
    if (a) firsts.push(a.n)
    else missed += 1
  }
  return { flips: (j.flips || []).length, painted: firsts.length, missed, dwellMs: dwell, tf: j.tf, perSym, ...censoredStats(firsts, missed, dwell) }
}

/** The soak's heap curve: MB retained per 100 switches = used(after the last reading) - used(0), scaled to 100.
 * A soak stopped early (the abort line, a crash) is scaled from what it reached, and says so. */
export function scoreSoak(j, plannedFlips) {
  const pts = (j.soak || []).filter((r) => typeof r.usedMB === 'number')
  const at = (n) => { const r = pts.find((p) => p.after === n); return r ? r.usedMB : null }
  const h0 = at(0)
  const last = pts.length ? pts[pts.length - 1] : null
  const reached = last ? last.after : 0
  const complete = reached >= plannedFlips && plannedFlips > 0
  const retained = h0 != null && reached > 0 ? ((last.usedMB - h0) * 100) / reached : null
  const mid = pts.find((p) => p.after === Math.round(plannedFlips / 2))
  const secondHalf = mid && complete && reached > mid.after ? ((last.usedMB - mid.usedMB) * 100) / (reached - mid.after) : null
  return {
    points: pts.map((p) => ({ after: p.after, usedMB: p.usedMB, backingMB: p.backingMB ?? null })),
    reached, planned: plannedFlips, complete,
    retainedMBPer100: retained == null ? null : Math.round(retained),
    secondHalfMBPer100: secondHalf == null ? null : Math.round(secondHalf),
    extrapolated: retained != null && reached < 100,
  }
}

/** Night index -> which block of the pool each timeframe types. Blocks are the pool cut into TYPED_PER_TF;
 * timeframe i takes block (k + 2i) mod B, so one night's three timeframes never share a ticker and, with the
 * default pool (6 blocks), every (ticker, timeframe) pair comes round once in 6 nights. */
export function typedForNight(pool, k) {
  const blocks = []
  for (let i = 0; i + TYPED_PER_TF <= pool.length; i += TYPED_PER_TF) blocks.push(pool.slice(i, i + TYPED_PER_TF))
  if (blocks.length < TYPED_TFS.length) throw new Error(`the typed pool needs at least ${TYPED_TFS.length * TYPED_PER_TF} tickers`)
  const out = {}
  const B = blocks.length
  // B even: steps of 2 keep the three timeframes on distinct blocks when B >= 6; otherwise step 1
  const step = B >= 2 * TYPED_TFS.length ? 2 : 1
  TYPED_TFS.forEach((tf, i) => { out[tf] = blocks[(((k + step * i) % B) + B) % B] })
  return out
}

/** Prior nights: the newest row of each earlier date, newest last, at most `n`. */
export function priorNights(rows, today, n = RULES.trailingNights) {
  const byDate = new Map()
  for (const r of rows) if (r && r.date && r.date < today) byDate.set(r.date, r)
  return [...byDate.keys()].sort().slice(-n).map((d) => byDate.get(d))
}

/** Nights a typed run has used so far (distinct earlier dates): the rotation's k, stable for re-runs on one date. */
export function nightIndex(rows, today) {
  return new Set(rows.filter((r) => r && r.date && r.date < today).map((r) => r.date)).size
}

const get = (o, path) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o)

export function trailing(prior, path) {
  const xs = prior.map((r) => get(r, path)).filter((x) => typeof x === 'number')
  return { median: xs.length ? round(median(xs)) : null, nights: xs.length }
}

/** Every REGRESSION line for tonight's row given the prior nights. Empty = none. */
export function regressions(row, prior) {
  const out = []
  for (const f of row.failures || []) out.push(`REGRESSION: ${f.step} did not complete: ${f.why}`)
  const med = get(row, 'two.medMs')
  const t = trailing(prior, 'two.medMs')
  if (typeof med === 'number' && t.nights >= RULES.speedMinNights && t.median > 0 && med > RULES.speedRatio * t.median) {
    out.push(`REGRESSION: both-on-screen median ${med} ms is ${(med / t.median).toFixed(2)}x the trailing ${t.nights}-night median ${t.median} ms (limit ${RULES.speedRatio}x)`)
  }
  const kept = get(row, 'soak.retainedMBPer100')
  if (typeof kept === 'number' && kept > RULES.retainedMBPer100) {
    out.push(`REGRESSION: memory retained ${kept} MB per 100 switches${get(row, 'soak.extrapolated') ? ` (scaled from ${get(row, 'soak.reached')} switches)` : ''}, over the ${RULES.retainedMBPer100} MB line`)
  }
  const errs = get(row, 'pageErrors.count')
  if (typeof errs === 'number' && errs > 0) {
    out.push(`REGRESSION: ${errs} page error(s) (${get(row, 'pageErrors.rejections') || 0} unhandled rejection(s)) across the runs`)
  }
  return out
}

const fmt = (x, unit = ' ms') => (x == null ? 'n/a' : `${x}${unit}`)
const cens = (s) => (s && s.censored ? ` (${s.missed} not painted within ${s.dwellMs} ms, counted at ${s.dwellMs})` : '')

/** latest.md: tonight's numbers, the trailing-7-night medians, and the verdict. */
export function formatLatest(row, prior) {
  const lines = []
  const reg = regressions(row, prior)
  const t = (p) => trailing(prior, p)
  const nightsOf = (n) => `(${n} night${n === 1 ? '' : 's'})`
  const tline = (p, unit = ' ms') => { const x = t(p); return x.nights ? `${x.median}${unit} ${nightsOf(x.nights)}` : 'no prior nights' }
  const tpair = (a, b) => { const x = t(a), y = t(b); return x.nights ? `${fmt(x.median)} / ${fmt(y.median)} ${nightsOf(x.nights)}` : 'no prior nights' }
  lines.push(`# Chart canary: ${row.date}`)
  lines.push('')
  lines.push(...(reg.length ? reg : ['No regression.']))
  const speedPrior = t('two.medMs').nights
  if (speedPrior < RULES.speedMinNights) lines.push(`(The speed rule needs ${RULES.speedMinNights} prior nights; ${speedPrior} so far.)`)
  lines.push('')
  const b = row.build || {}
  lines.push(`- Build: \`${(b.commit || 'unknown').slice(0, 12)}\`${b.buildId ? ` (${b.buildId})` : ''}${b.changedDuringRun ? ` **changed during the run** (also served: ${(b.otherCommits || []).map((c) => `\`${String(c).slice(0, 12)}\``).join(', ')})` : ''}; pod up ${b.uptimeS != null ? Math.round(b.uptimeS / 60) + ' min' : 'n/a'} at the start`)
  lines.push(`- Run: ${row.startedAt} to ${row.endedAt} (${Math.round((row.runtimeS || 0) / 60 * 10) / 10} min), ${row.trigger || 'manual'}, production, headless Chrome, the bench member`)
  lines.push('')
  lines.push('| measure | tonight | trailing median |')
  lines.push('|---|---|---|')
  const two = row.two || {}
  lines.push(`| Two charts ${two.tf || 'D'} + ${two.tf2 || '60'}, ${two.flips ?? 'n/a'} switches: BOTH on screen, median | ${fmt(two.medMs)} | ${tline('two.medMs')} |`)
  lines.push(`| ... p90 | ${fmt(two.p90Ms)} | ${tline('two.p90Ms')} |`)
  for (const tf of TYPED_TFS) {
    const s = (row.typed || {})[tf] || {}
    lines.push(`| Typed never-opened, ${tf}: first paint, median / p90 | ${fmt(s.medMs)} / ${fmt(s.p90Ms)} | ${tpair(`typed.${tf}.medMs`, `typed.${tf}.p90Ms`)} |`)
  }
  const soak = row.soak || {}
  lines.push(`| Memory: JS heap retained per 100 switches (after a full GC) | ${fmt(soak.retainedMBPer100, ' MB')} | ${tline('soak.retainedMBPer100', ' MB')} |`)
  lines.push(`| Page errors + unhandled rejections | ${row.pageErrors ? row.pageErrors.count : 'n/a'} | ${tline('pageErrors.count', '')} |`)
  lines.push('')
  if (two.censored) lines.push(`- Two charts:${cens(two)}`)
  for (const tf of TYPED_TFS) {
    const s = (row.typed || {})[tf]
    if (!s) continue
    lines.push(`- Typed ${tf}: ${(s.perSym || []).map((p) => `${p.sym} ${p.ms == null ? 'no paint' : p.ms + ' ms'}`).join(', ')}${cens(s)}`)
  }
  if (row.typedPool) lines.push(`- Typed set: night ${row.typedPool.night} of a ${row.typedPool.cycle}-night rotation over ${row.typedPool.size} tickers${row.typedPool.lastTypedNightsAgo != null ? `; the warmest of tonight's was last typed by this canary ${row.typedPool.lastTypedNightsAgo} night(s) ago` : '; none typed by this canary before'}`)
  if (soak.points && soak.points.length) {
    lines.push(`- Soak heap (used MB after GC x2): ${soak.points.map((p) => `${p.after}: ${p.usedMB}`).join(', ')}${soak.secondHalfMBPer100 != null ? `; second half alone ${soak.secondHalfMBPer100} MB per 100` : ''}${soak.complete ? '' : ` (stopped at ${soak.reached} of ${soak.planned})`}`)
  }
  if (row.pageErrors && row.pageErrors.first && row.pageErrors.first.length) {
    lines.push('- Page errors (first few):')
    for (const e of row.pageErrors.first.slice(0, 5)) lines.push(`  - [${e.run}] ${e.kind} at ${e.where}: ${String(e.text).split('\n')[0].slice(0, 200)}`)
  }
  if (row.notes && row.notes.length) for (const n of row.notes) lines.push(`- Note: ${n}`)
  lines.push('')
  lines.push(`Rows: rows.jsonl (one per night). Raw runs: runs/${row.runId}/. Rules: both-on-screen median > ${RULES.speedRatio}x the trailing median (>= ${RULES.speedMinNights} prior nights), retained > ${RULES.retainedMBPer100} MB per 100 switches, page errors > 0, or any run not completing.`)
  return lines.join('\n') + '\n'
}
