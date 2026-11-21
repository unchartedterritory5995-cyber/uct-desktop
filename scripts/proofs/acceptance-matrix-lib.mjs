// The owner's chart ACCEPTANCE MATRIX (coordinator brief 2026-11-20): the pure part. The matrix, one cell's
// flip-proof arguments, every switch scored against the bar, a cell's verdict, the grid and the worst switches.
// No I/O here, so every rule is unit-tested (test/acceptance-matrix.test.ts). The runner is acceptance-matrix.mjs.
//
// THE BAR (owner): every list, every stock, every timeframe, every combination: linked charts show the new symbol
// in the SAME frame (SYNC_SKEW 0 frames), within 40 ms, in ONE paint, with no follow-up heavy re-render and no
// memory growth. Scoring follows the existing scorers: first paint = score2.py's rule (the first frame whose
// close differs from the chart's own `before`, timed by when the frame really ran, `n`); SYNC_SKEW = cold_flips.py's
// (rAF frame times of the first and last chart to show it, / 16.67 ms); the after-the-paint view fields (m, w)
// are cold_flips.py's VISIBLE_RANGE_DRIFT / ZOOM_CHANGED; StockChart renders are its [rprobe] console lines.

// ⭐ (2026-11-21, the independent review) THE YARDSTICK IS PRESENTATION: `pixels_both` = when the frame carrying the
// last linked chart's first paint of the new symbol was presented (paint-probe.js: lightweight-charts' own rAF
// draw, then the next frame), not when the debug handle first held the new series (`seen`, ~30 ms earlier).
// A run without the probe's record is scored the old way and says so (`stamp: 'seen'`).
export const BAR = {
  pixelsBothMs: 40, // the last linked chart's new candles ON SCREEN within this many ms of the key / click / Enter
  bothMs: 40, // (old runs, no paint record) the same rule on the `seen` stamp
  skewFrames: 0, // linked charts painted in the same frame
  repaintsPerChart: 1, // after its first paint of the new symbol, at most this many more paints per chart in 1 s
  postPaintBusyMs: 8, // no main-thread busy period longer than this in the 1 s after pixels_both
  extraPaints: 0, // (old runs) one paint, by the sampled view
  followUpLongTasks: 0, // (old runs) no long task (> 50 ms) after BOTH within the dwell
  followUpRenders: 0, // no StockChart render after pixels_both (counted only on a render-probe build)
  memMBPerSwitch: 1, // heap after a full GC, end minus start, per switch (caches fill a little; a leak is ~20)
  pageErrors: 0,
}
const CHART_IDS = ['flip-chart', 'flip-chart-2', 'flip-chart-3']
const FRAME_MS = 16.67

export const LAYOUTS = {
  '1m': ['1'], '5m': ['5'], '15m': ['15'], '30m': ['30'], '60m': ['60'], D: ['D'], W: ['W'], M: ['M'],
  'D+1m': ['D', '1'], 'D+5m': ['D', '5'], 'D+15m': ['D', '15'], 'D+30m': ['D', '30'], 'D+60m': ['D', '60'], 'W+D': ['W', 'D'], '60m+5m': ['60', '5'],
  'D+60m+5m': ['D', '60', '5'],
}
/** list id -> how the flip proof is pointed at it. `needs` = a runner option without which the list is SKIPPED. */
export const LISTS = {
  sp500: { name: 'S&P 500', args: () => ['--list=S&P 500'] },
  r2000: { name: 'Russell 2000', args: () => ['--list=Russell 2000'] },
  bullbear: { name: 'Bull & Bear ETFs', args: () => ['--list=Bull & Bear ETFs'] },
  themes: { name: 'UCT Thematic Indexes', args: () => ['--list=UCT Thematic Indexes'] },
  themeEtfs: { name: 'Industry & Thematic ETFs', args: () => ['--list=Industry & Thematic ETFs'] },
  user: { name: 'a user watchlist', needs: 'userList', args: (o) => [`--list=user:${o.userList}`] },
  screener: { name: 'screener results', needs: 'screenId', args: (o) => [`--watch-opts=${JSON.stringify({ listSub: { source: 'screen', value: String(o.screenId), mode: 'track' } })}`] },
}
export const MOTIONS = {
  next: { name: 'next row x30', flips: 30, args: (o) => ['--pattern=down', '--flips=30', `--dwell=${o.dwellNext}`] },
  jump12: { name: '12-row jump x15', flips: 15, args: (o) => ['--pattern=jump', '--jump=12', '--flips=15', '--hover=250', `--dwell=${o.dwellJump}`] },
  jump70: { name: '70-row jump x15', flips: 15, args: (o) => ['--pattern=jump', '--jump=70', '--flips=15', '--hover=250', `--dwell=${o.dwellJump}`] },
  typed: { name: 'typed never-opened x14', flips: 14, args: (o, typed) => ['--pattern=typed', `--typed=${typed.join(',')}`, '--type-gap=0', '--typed-pause=0', `--dwell=${o.dwellTyped}`] },
  // (2026-11-21) the scanning cadences: taps every 300 and 150 ms (each switch has until the next key), and a HELD
  // key at the OS repeat rate (33 ms): only the landing is held to the bar, the passing symbols are counted
  next300: { name: 'next row every 300 ms x30', flips: 30, args: () => ['--pattern=down', '--flips=30', '--cadence=300', '--last-dwell=1500'] },
  next150: { name: 'next row every 150 ms x30', flips: 30, args: () => ['--pattern=down', '--flips=30', '--cadence=150', '--last-dwell=1500'] },
  held: { name: 'held key x30 (landing)', flips: 30, landingOnly: true, args: () => ['--pattern=down', '--autorepeat=1', '--flips=30', '--cadence=33', '--last-dwell=1500'] },
}
// `default`: no override, so a fresh profile runs whatever production defaults to (the nightly core grid)
export const STORES = { off: ['--ls=uct.deviceStore=0'], on: ['--ls=uct.deviceStore=1', '--wait-device=1'], default: [] }
/** Named selections. CORE = the owner's core grid (coordinator 2026-11-21): 24 cells, the promotion gate and the
 * nightly default (with CADENCE, 18 cells: the 300 / 150 ms taps and a held key). PR = the 8-cell owner subset.
 * FULL = every layout, list and motion, device store off and on: 1,568 cells, weekends in resumable slices. */
export const GRIDS = {
  core: { layouts: ['D+60m', 'D+30m'], lists: ['sp500', 'r2000', 'bullbear'], motions: ['next', 'jump12', 'jump70', 'typed'], stores: ['default'] },
  // the scanning cadences on the same layouts and lists (run nightly after the core grid)
  cadence: { layouts: ['D+60m', 'D+30m'], lists: ['sp500', 'r2000', 'bullbear'], motions: ['next300', 'next150', 'held'], stores: ['default'] },
  // the 8-cell owner subset every chart PR runs against the baseline (its author, with --compare)
  pr: { layouts: ['D+30m'], lists: ['sp500', 'r2000'], motions: ['next', 'jump12', 'jump70', 'typed'], stores: ['default'] },
  full: { stores: ['off', 'on'] },
}
/** The cells of one or more grids (a comma list: their union, in matrix order), each narrowed the same way. */
export function gridCells(grids, f = {}) {
  const want = new Set()
  for (const g of String(grids).split(',').map((x) => x.trim()).filter(Boolean)) for (const c of expandCells(selection(g, f))) want.add(c.id)
  return expandCells({}).filter((c) => want.has(c.id))
}

/** A grid's selection; an explicit filter replaces that dimension of the grid. */
export function selection(grid, f = {}) {
  const g = GRIDS[grid]
  if (!g) throw new Error(`unknown grid ${grid} (known: ${Object.keys(GRIDS).join(', ')})`)
  const out = {}
  for (const k of ['layouts', 'lists', 'motions', 'stores']) out[k] = (f[k] && f[k].length) ? f[k] : (g[k] || [])
  return out
}
export const DEFAULTS = { dwellNext: 1500, dwellJump: 4000, dwellTyped: 4000, warmup: 60000, set: 'base', port: 9454 }
/** The cold-path tickers (the device-store agent's coldtyped.txt, 2026-11-20). --typed-pool replaces them. */
export const TYPED_POOL = 'KSPI,ORLY,MUFG,IBEX,FERG,SPH,CVS,SNAP,CABO,IX,BHVN,JOUT,BWA,ZKH,BSAC,FRA,CZNC,LPX,HLIT,XPEV,GFS,CDNS,OR,RHI,NOAH,FIVN,BAP,APO'.split(',')
export const TYPED_N = 14

export const cellId = (c) => `${c.store}__${c.layout}__${c.list}__${c.motion}`.replace(/[^\w+.-]/g, '_')

/** Every cell, in matrix order (store, layout, list, motion), narrowed by the filters (lists of ids; empty = all). */
export function expandCells(f = {}) {
  const pick = (all, want) => { const w = (want || []).filter(Boolean); const bad = w.filter((x) => !all.includes(x)); if (bad.length) throw new Error(`unknown: ${bad.join(', ')} (known: ${all.join(', ')})`); return w.length ? all.filter((x) => w.includes(x)) : all }
  const out = []
  for (const store of pick(Object.keys(STORES), f.stores))
    for (const layout of pick(Object.keys(LAYOUTS), f.layouts))
      for (const list of pick(Object.keys(LISTS), f.lists))
        for (const motion of pick(Object.keys(MOTIONS), f.motions)) out.push({ store, layout, list, motion })
  return out.map((c) => ({ ...c, id: cellId(c) }))
}

/** Today's typed tickers for a cell: TYPED_N from the pool, rotated by the day and by the cell's place among the
 * matrix's typed cells, so consecutive cells (and consecutive days) start at a different block. */
export function typedFor(pool, day, typedIndex) {
  if (pool.length < TYPED_N) throw new Error(`the typed pool needs at least ${TYPED_N} tickers`)
  const start = ((day + typedIndex) * TYPED_N) % pool.length
  return Array.from({ length: TYPED_N }, (_, i) => pool[(start + i) % pool.length])
}

/** The flip proof's arguments for one cell, or { skip: reason }. */
export function cellArgs(cell, opts = {}, typed = []) {
  const o = { ...DEFAULTS, ...opts }
  const L = LIST_OR_THROW(cell.list)
  if (L.needs && !o[L.needs]) return { skip: `${L.name}: pass --${L.needs.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}=<...>` }
  const tfs = LAYOUTS[cell.layout]
  const ls = [...STORES[cell.store]]
  const lsPairs = ls.filter((a) => a.startsWith('--ls=')).map((a) => a.slice(5))
  if (o.renderProbe) lsPairs.push('uct.renderprobe=1')
  return {
    args: [
      '--headless=1', '--light-sampler=1', '--heap-ends=1', `--port=${o.port}`, `--set=${o.set}`, `--warmup=${o.warmup}`,
      `--tf=${tfs[0]}`, ...(tfs[1] ? [`--tf2=${tfs[1]}`] : []), ...(tfs[2] ? [`--tf3=${tfs[2]}`] : []),
      ...L.args(o), ...MOTIONS[cell.motion].args(o, typed),
      ...(lsPairs.length ? [`--ls=${lsPairs.join(',')}`] : []), ...ls.filter((a) => !a.startsWith('--ls=')),
      ...(o.renderProbe ? ['--console=rprobe'] : []), ...(o.dist ? [`--dist=${o.dist}`] : []),
    ],
  }
}
function LIST_OR_THROW(id) { const L = LISTS[id]; if (!L) throw new Error(`unknown list ${id}`); return L }

const FIELDS = ['o', 'o2', 'o3']
const BEFORE = ['before', 'before2', 'before3']
const closeOf = (c) => (typeof c === 'string' && c.split('|').length >= 3 ? c.split('|')[2] : null)

/** One chart's first paint of the new symbol in a flip: { idx, t, n } (ms after the key) or null. */
export function firstPaintOf(frames, field, beforeC, key) {
  const bclose = closeOf(beforeC)
  for (let i = 0; i < (frames || []).length; i++) {
    const c = frames[i] && frames[i][field] && frames[i][field].c
    if (!c || c === 'none') continue
    if (closeOf(c) !== bclose) return { idx: i, t: frames[i].t - key, n: (frames[i].n ?? frames[i].t) - key }
  }
  return null
}

/** What changed in one chart's picture after its first paint: each later frame where the bar COUNT changed with the
 * newest bar's time unchanged (a deeper history joined: a live new bar is not counted), the view moved (m) or
 * re-zoomed (w), or an indicator series' length changed (an indicator painted late). Close-only changes are
 * live ticks and are not counted. */
export function extraPaintsOf(frames, field, from) {
  const out = []
  const st = (x) => x && x[field]
  let prev = st(frames[from])
  for (let i = from + 1; i < frames.length; i++) {
    const cur = st(frames[i])
    if (!cur || !prev || cur.c === 'none') { prev = cur || prev; continue }
    const [pc, pt] = String(prev.c).split('|'), [cc, ct] = String(cur.c).split('|')
    const kinds = []
    if (cc !== pc && ct === pt) kinds.push('depth')
    if (typeof cur.m === 'number' && typeof prev.m === 'number' && Math.abs(cur.m - prev.m) > 0.01) kinds.push('moved')
    if (typeof cur.w === 'number' && typeof prev.w === 'number' && Math.abs(cur.w - prev.w) > 0.05) kinds.push('zoomed')
    const lens = (o) => Object.fromEntries(Object.entries(o.s || {}).map(([k, v]) => [k, String(v).split('|')[0]]))
    const pl = lens(prev), cl = lens(cur)
    if (ct === pt && Object.keys({ ...pl, ...cl }).some((k) => pl[k] !== cl[k])) kinds.push('indicators')
    if (kinds.length) out.push({ n: frames[i].n ?? frames[i].t, kinds })
    prev = cur
  }
  return out
}

/** StockChart renders from a render-probe build's console lines ("[rprobe] <ms> StockChart#<id> <why>"). */
export function probeRenders(consoleLines) {
  if (!Array.isArray(consoleLines)) return null
  const out = []
  for (const l of consoleLines) {
    const m = /^\[rprobe\] (\d+(?:\.\d+)?) (StockChart#\S+)(?: (.*))?$/.exec(typeof l === 'string' ? l : (l && l.text) || '')
    if (m) out.push({ t: Number(m[1]), who: m[2], why: m[3] || '' })
  }
  return out
}

/** Each linked chart's FIRST PAINT of the new symbol (paint-probe.js records): its first paint that ended after
 * the key and drew a newest bar other than the one it held at the key. null for a chart that did not paint it. */
export function newPaintsOf(f, charts) {
  return CHART_IDS.slice(0, charts).map((id, c) => {
    const b = String((f[BEFORE[c]] && f[BEFORE[c]].c) || '').split('|')
    return (f.paints || []).find((p) => p.w === id && p.end >= f.key && !(String(p.time) === b[1] && String(p.close) === b[2])) || null
  })
}

/** One switch against the bar, on the PRESENTATION stamp when the run carries the paint record. */
export function scoreSwitch(f, charts, dwell, renders = null, bar = BAR) {
  const key = f.key
  const s = { i: f.i, sym: f.sym || null, reasons: [] }
  if (!key) { s.reasons.push('no key press recorded'); s.pass = false; return s }
  const seen = FIELDS.slice(0, charts).map((fld, c) => firstPaintOf(f.frames, fld, f[BEFORE[c]] && f[BEFORE[c]].c, key))
  s.seenMs = seen.map((p) => (p ? Math.round(p.n) : null))
  s.seenBothMs = seen.every(Boolean) ? Math.round(Math.max(...seen.map((p) => p.n))) : null
  if (Array.isArray(f.paints)) return scorePixels(f, charts, dwell, renders, bar, s)
  s.stamp = 'seen'
  const paints = seen
  s.chartMs = paints.map((p) => (p ? Math.round(p.n) : null))
  if (paints.some((p) => !p)) {
    s.reasons.push(`not on screen within the ${dwell} ms dwell (chart ${paints.findIndex((p) => !p) + 1})`)
    s.firstMs = paints.some(Boolean) ? Math.round(Math.min(...paints.filter(Boolean).map((p) => p.n))) : null
    s.bothMs = null
    s.pass = false
    return s
  }
  const ns = paints.map((p) => p.n), ts = paints.map((p) => p.t)
  s.firstMs = Math.round(Math.min(...ns))
  s.bothMs = Math.round(Math.max(...ns))
  s.skewFrames = Math.round((Math.max(...ts) - Math.min(...ts)) / FRAME_MS)
  s.extra = []
  paints.forEach((p, c) => { for (const e of extraPaintsOf(f.frames, FIELDS[c], p.idx)) s.extra.push({ chart: c + 1, ms: Math.round(e.n - key), kinds: e.kinds }) })
  const lts = (f.long || []).filter((x) => x.s >= key && x.s <= key + dwell)
  s.long = { count: lts.length, totalMs: lts.reduce((a, x) => a + x.d, 0), maxMs: lts.reduce((a, x) => Math.max(a, x.d), 0) }
  const after = lts.filter((x) => x.s >= key + s.bothMs)
  s.followUpLong = { count: after.length, totalMs: after.reduce((a, x) => a + x.d, 0) }
  s.rendersAfter = renders == null ? null : renders.filter((r) => r.t > key + s.bothMs && r.t <= key + dwell).length
  if (s.skewFrames > bar.skewFrames) s.reasons.push(`SYNC_SKEW ${s.skewFrames} frame(s)`)
  if (s.bothMs > bar.bothMs) s.reasons.push(`BOTH ${s.bothMs} ms > ${bar.bothMs}`)
  if (s.extra.length > bar.extraPaints) s.reasons.push(`${s.extra.length} more paint(s): ${[...new Set(s.extra.flatMap((e) => e.kinds))].join('+')}`)
  if (s.followUpLong.count > bar.followUpLongTasks) s.reasons.push(`${s.followUpLong.count} long task(s) after BOTH (${s.followUpLong.totalMs} ms)`)
  if (s.rendersAfter != null && s.rendersAfter > bar.followUpRenders) s.reasons.push(`${s.rendersAfter} StockChart render(s) after BOTH`)
  s.pass = !s.reasons.length
  return s
}

function scorePixels(f, charts, dwell, renders, bar, s) {
  const key = f.key
  s.stamp = 'pixels'
  const paints = newPaintsOf(f, charts)
  s.paints = paints
  s.pixelsMs = paints.map((p) => (p && p.present != null ? Math.round((p.present - key) * 10) / 10 : null))
  const missing = s.pixelsMs.findIndex((x) => x == null)
  // the record of the rest of the switch, kept for the grid whether or not it reached the screen
  const lts = (f.long || []).filter((x) => x.s >= key && x.s <= key + Math.max(dwell, 1500))
  s.long = { count: lts.length, totalMs: lts.reduce((a, x) => a + x.d, 0), maxMs: lts.reduce((a, x) => Math.max(a, x.d), 0) }
  if (missing >= 0) {
    s.reasons.push(`chart ${missing + 1}'s new candles not on screen ${f.paints.length ? 'before the next key / the end of the dwell' : '(no paint recorded)'}`)
    s.firstPixelsMs = s.pixelsMs.some((x) => x != null) ? Math.min(...s.pixelsMs.filter((x) => x != null)) : null
    s.pixelsBothMs = null
    s.pass = false
    return s
  }
  s.firstPixelsMs = Math.min(...s.pixelsMs)
  s.pixelsBothMs = Math.max(...s.pixelsMs)
  // the old stamp's lead over the screen, per switch (the review's ~30 ms)
  s.seenLeadMs = s.seenBothMs != null ? Math.round((s.pixelsBothMs - s.seenBothMs) * 10) / 10 : null
  const ts = paints.map((p) => p.t)
  s.skewFrames = Math.round((Math.max(...ts) - Math.min(...ts)) / FRAME_MS)
  // POST-PAINT BUDGET: each chart's further paints in the 1 s after its first (a newer newest bar, a live new
  // bar, is not counted; a changed close on the same bar is: off hours it is a correction, not a tick)
  s.repaints = paints.map((p) => (f.paints || []).filter((q) => q !== p && q.w === p.w && q.end > p.end && q.end <= p.end + 1000 && String(q.time) === String(p.time)).length)
  const busy = (f.busy || []).filter((b) => b.d > bar.postPaintBusyMs)
  s.postBusy = f.busyFrom == null ? null : { count: busy.length, maxMs: busy.reduce((a, b) => Math.max(a, b.d), 0), windowMs: f.busyEnd != null ? Math.round(f.busyEnd - f.busyFrom) : null }
  // Event Timing's own first presentation after the key: the charts cannot be on screen before it
  const ev = (f.evt || []).find((e) => (e.n === 'keydown' || e.n === 'click' || e.n === 'pointerdown') && Math.abs(e.s - key) <= 5)
  s.inputPresentMs = ev ? Math.round((ev.s + ev.d - key) * 10) / 10 : null
  s.stampEarly = s.inputPresentMs != null && s.pixelsBothMs < s.inputPresentMs - 8
  s.rendersAfter = renders == null ? null : renders.filter((r) => r.t > key + s.pixelsBothMs && r.t <= key + Math.max(dwell, 1500)).length
  if (s.skewFrames > bar.skewFrames) s.reasons.push(`SYNC_SKEW ${s.skewFrames} frame(s)`)
  if (s.pixelsBothMs > bar.pixelsBothMs) s.reasons.push(`pixels_both ${s.pixelsBothMs} ms > ${bar.pixelsBothMs}`)
  const over = s.repaints.map((n, c) => [n, c]).filter(([n]) => n > bar.repaintsPerChart)
  if (over.length) s.reasons.push(`repaints after the first: ${over.map(([n, c]) => `chart ${c + 1} x${n}`).join(', ')} (> ${bar.repaintsPerChart})`)
  if (s.postBusy && s.postBusy.count) s.reasons.push(`${s.postBusy.count} main-thread busy period(s) > ${bar.postPaintBusyMs} ms in the 1 s after (max ${s.postBusy.maxMs} ms)`)
  if (s.rendersAfter != null && s.rendersAfter > bar.followUpRenders) s.reasons.push(`${s.rendersAfter} StockChart render(s) after pixels_both`)
  s.pass = !s.reasons.length
  return s
}

const median = (xs) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const pct = (xs, p) => { const v = xs.filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null }

/** A cell: every switch, the summary, and its verdict. PASS = every criterion measured and met; PASS* = every
 * measured one met but StockChart renders were not counted (not a render-probe build); FAIL = any miss;
 * ERROR = the run did not complete. */
export function scoreCell(j, cell, bar = BAR) {
  const charts = (LAYOUTS[cell.layout] || ['D']).length
  const dwell = Number(j.dwell) || 0
  const renders = probeRenders(j.console)
  const switches = (j.flips || []).map((f) => scoreSwitch(f, charts, dwell, renders, bar))
  // a held key: only the LANDING (the last switch) is held to the bar; the symbols it passed are counted
  const landingOnly = !!(MOTIONS[cell.motion] && MOTIONS[cell.motion].landingOnly)
  switches.forEach((s, k) => { s.gated = !landingOnly || k === switches.length - 1 })
  const gated = switches.filter((s) => s.gated)
  const keys = (j.flips || []).map((f) => f.key).filter((k) => typeof k === 'number')
  const gaps = keys.slice(1).map((k, x) => k - keys[x])
  const heap = (j.soak || []).filter((r) => typeof r.usedMB === 'number')
  const h0 = heap.length ? heap[0] : null, h1 = heap.length > 1 ? heap[heap.length - 1] : null
  const growth = h0 && h1 ? Math.round((h1.usedMB - h0.usedMB) * 10) / 10 : null
  const perSwitch = growth != null && switches.length ? Math.round((growth / switches.length) * 100) / 100 : null
  const errs = (j.pageErrors && j.pageErrors.count) || 0
  const sum = (k) => switches.map((s) => s[k])
  const px = switches.filter((s) => s.stamp === 'pixels')
  const m = j.machine || null
  const summary = {
    stamp: px.length ? 'pixels' : 'seen',
    switches: gated.length, passed: gated.filter((s) => s.pass).length,
    pixelsBothMs: { med: median(gated.map((s) => s.pixelsBothMs)), p90: pct(gated.map((s) => s.pixelsBothMs), 0.9), max: pct(gated.map((s) => s.pixelsBothMs), 1) },
    firstPixelsMs: { med: median(gated.map((s) => s.firstPixelsMs)) },
    // every gated switch's pixels_both (null = not on screen in time): what --compare tests
    samples: gated.map((s) => (s.stamp === 'pixels' ? s.pixelsBothMs : s.bothMs)),
    seenLeadMs: { med: median(px.map((s) => s.seenLeadMs)) },
    repaintsMax: px.reduce((a, s) => Math.max(a, ...(s.repaints || [0])), 0),
    postBusy: { count: px.reduce((a, s) => a + (s.postBusy ? s.postBusy.count : 0), 0), maxMs: px.reduce((a, s) => Math.max(a, s.postBusy ? s.postBusy.maxMs : 0), 0) },
    stampEarly: px.filter((s) => s.stampEarly).length,
    passing: landingOnly ? { painted: switches.slice(0, -1).filter((s) => s.pixelsBothMs != null || s.bothMs != null).length, of: Math.max(0, switches.length - 1) } : null,
    cadenceMs: gaps.length ? { med: Math.round(median(gaps)), p90: Math.round(pct(gaps, 0.9)) } : null,
    machine: m ? { underLoad: !!m.underLoad, othersCores: m.othersCores, cpuMedPct: m.cpuMedPct, freeMinMB: m.freeMinMB, why: m.why || [] } : null,
    lwcPatched: j.lwcPatch ? j.lwcPatch.patched : null,
    firstMs: { med: median(sum('firstMs')), p90: pct(sum('firstMs'), 0.9) }, bothMs: { med: median(sum('bothMs')), p90: pct(sum('bothMs'), 0.9), max: pct(sum('bothMs'), 1) },
    skewFrames: { max: pct(sum('skewFrames'), 1), inOneFrame: switches.filter((s) => s.skewFrames === 0).length },
    extraPaints: switches.reduce((a, s) => a + (s.extra ? s.extra.length : 0), 0),
    long: { count: switches.reduce((a, s) => a + (s.long ? s.long.count : 0), 0), totalMs: switches.reduce((a, s) => a + (s.long ? s.long.totalMs : 0), 0), maxMs: switches.reduce((a, s) => Math.max(a, s.long ? s.long.maxMs : 0), 0) },
    rendersAfterPerSwitch: renders == null ? null : median(sum('rendersAfter')),
    heapMB: { start: h0 ? h0.usedMB : null, end: h1 ? h1.usedMB : null, growth, perSwitch },
    pageErrors: errs,
  }
  const reasons = []
  if (j.error) reasons.push(`run stopped: ${String(j.error).split('\n')[0].slice(0, 160)}`)
  if (!switches.length) reasons.push('no switch recorded')
  const missed = summary.switches - summary.passed
  if (missed) reasons.push(`${missed} of ${summary.switches} ${landingOnly ? 'landing' : 'switches'} missed the bar`)
  if (j.lwcPatch && j.lwcPatch.patched === false) reasons.push('the page ran an UNPATCHED lightweight-charts')
  if (errs > bar.pageErrors) reasons.push(`${errs} page error(s)`)
  if (perSwitch != null && perSwitch > bar.memMBPerSwitch) reasons.push(`heap +${growth} MB (${perSwitch} MB per switch)`)
  const unmeasured = []
  if (renders == null) unmeasured.push('StockChart renders (not a render-probe build)')
  if (perSwitch == null) unmeasured.push('heap growth')
  const verdict = j.error || !switches.length ? 'ERROR' : reasons.length ? 'FAIL' : unmeasured.length ? 'PASS*' : 'PASS'
  // a run taken while the shared PC was busy is flagged: its numbers are not a measurement of the app alone
  const loaded = !!(m && m.underLoad)
  return { id: cell.id || cellId(cell), cell, verdict, loaded, reasons, unmeasured, summary, switches, build: j.build || null, dist: j.dist ? j.dist.dir : null }
}

/** The grid: one table per store arm, rows = layout x list, columns = motions. */
export function formatGrid(results, cells, meta = {}) {
  const by = new Map(results.map((r) => [r.id, r]))
  const motions = [...new Set(cells.map((c) => c.motion))]
  const lines = [`# Chart acceptance matrix${meta.name ? `: ${meta.name}` : ''}`, '']
  const counts = {}
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1
  lines.push(`Bar: every linked chart's new candles ON SCREEN (pixels_both, the presentation stamp) <= ${BAR.pixelsBothMs} ms after the key, painted in the same frame (SYNC_SKEW ${BAR.skewFrames}); then at most ${BAR.repaintsPerChart} more paint per chart and no main-thread busy period > ${BAR.postPaintBusyMs} ms in the 1 s after; no StockChart render after it (probe builds); heap growth <= ${BAR.memMBPerSwitch} MB per switch; no page error. A held key is held to the bar on its landing.`)
  lines.push(`Cells: ${cells.length} in this selection; ${results.length} scored (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}). PASS* = every measured criterion met, StockChart renders not counted (run with --render-probe on a probe build).`)
  if (meta.builds && meta.builds.length) lines.push(`Builds measured: ${meta.builds.map((b) => '`' + String(b).slice(0, 12) + '`').join(', ')}`)
  if (meta.dist) lines.push(`Frontend measured: the --dist build in \`${meta.dist}\`${meta.renderProbe ? ' (render probe on: StockChart renders counted)' : ''}, against production's API.`)
  for (const store of [...new Set(cells.map((c) => c.store))]) {
    lines.push('', `## Device store: ${store === 'default' ? "production's own setting" : store.toUpperCase()}`, '', `| layout | list | ${motions.map((m) => MOTIONS[m].name).join(' | ')} |`, `|---|---|${motions.map(() => '---').join('|')}|`)
    const rows = []
    for (const c of cells) if (c.store === store && !rows.some((r) => r.layout === c.layout && r.list === c.list)) rows.push({ layout: c.layout, list: c.list })
    for (const r of rows) {
      const tds = motions.map((m) => {
        const c = cells.find((x) => x.store === store && x.layout === r.layout && x.list === r.list && x.motion === m)
        const res = c && by.get(c.id)
        if (!c) return ''
        if (!res) return 'not run'
        if (res.verdict === 'SKIP') return `SKIP (${res.reasons[0]})`
        const s = res.summary
        const px = s.stamp === 'pixels'
        const t = px ? (s.pixelsBothMs && s.pixelsBothMs.med != null ? ` pixels ${s.pixelsBothMs.med}/${s.pixelsBothMs.p90} ms` : '') : (s.bothMs && s.bothMs.med != null ? ` BOTH(seen) ${s.bothMs.med}/${s.bothMs.p90} ms` : '')
        const pass = s.passing ? ` (passed ${s.passing.painted}/${s.passing.of} painted)` : ''
        return `**${res.verdict}**${res.loaded ? ' (UNDER LOAD)' : ''} ${s.passed}/${s.switches}${t}${pass}${res.verdict === 'FAIL' || res.verdict === 'ERROR' ? `: ${res.reasons[0]}` : ''}`
      })
      lines.push(`| ${r.layout} | ${LISTS[r.list].name} | ${tds.join(' | ')} |`)
    }
  }
  return lines.join('\n') + '\n'
}

/** The worst switches over every scored cell: unpainted first, then the slowest BOTH, then the widest skew. */
export function worstSwitches(results, n = 10) {
  const all = []
  for (const r of results) for (const s of r.switches || []) if (!s.pass && s.gated !== false) all.push({ cell: r.id, ...s })
  const ms = (s) => (s.stamp === 'pixels' ? s.pixelsBothMs : s.bothMs)
  const score = (s) => (ms(s) == null ? 1e9 : ms(s)) + (s.skewFrames || 0) * 1000
  return all.sort((a, b) => score(b) - score(a)).slice(0, n)
}

/** One switch's per-phase timeline from the raw flip (ms after the key). */
export function timeline(f, charts, renders = null) {
  const key = f.key
  const ev = []
  FIELDS.slice(0, charts).forEach((fld, c) => {
    const p = firstPaintOf(f.frames, fld, f[BEFORE[c]] && f[BEFORE[c]].c, key)
    if (p) {
      ev.push([p.n, `chart ${c + 1} first shows it (frame ran ${Math.round(p.n)} ms; frame time ${Math.round(p.t)} ms)`])
      for (const e of extraPaintsOf(f.frames, fld, p.idx)) ev.push([e.n - key, `chart ${c + 1} paints again: ${e.kinds.join('+')}`])
    } else ev.push([Number.MAX_SAFE_INTEGER, `chart ${c + 1}: not on screen within the dwell`])
  })
  if (Array.isArray(f.paints)) {
    const first = newPaintsOf(f, charts)
    for (const p of f.paints) {
      if (p.end < key - 1) continue
      const c = CHART_IDS.indexOf(p.w) + 1
      const tag = first.includes(p) ? 'FIRST PAINT of the new symbol' : 'paints'
      ev.push([p.end - key, `chart ${c} ${tag} (frame ${Math.round(p.t - key)} ms; bar ${p.time} close ${p.close})`])
      if (first.includes(p) && p.present != null) ev.push([p.present - key, `chart ${c} new candles ON SCREEN (next frame)`])
    }
    for (const b of f.busy || []) ev.push([b.s - key, `main thread busy ${b.d} ms`])
    for (const e of f.evt || []) if (e.s >= key - 5) ev.push([e.s + e.d - key, `${e.n}: the input's first presentation (Event Timing)`])
  }
  for (const x of f.long || []) if (x.s >= key - 5) ev.push([x.s - key, `long task ${x.d} ms`])
  for (const r of f.res || []) if (r.s >= key - 5) ev.push([r.e - key, `<- ${String(r.u).split('?')[0].slice(0, 70)} (${r.e - r.s} ms${r.st ? ', ' + String(r.st).slice(0, 60) : ''})`])
  for (const r of renders || []) if (r.t >= key - 1 && r.t <= key + 10000) ev.push([r.t - key, `${r.who} renders (${r.why.slice(0, 60)})`])
  return ev.sort((a, b) => a[0] - b[0]).map(([t, e]) => `${t === Number.MAX_SAFE_INTEGER ? '   --' : String(Math.round(t)).padStart(6)}  ${e}`)
}

// ── --compare: the release rule (coordinator 2026-11-21): no chart change ships unless the core grid shows NO cell
// worse than the production baseline. A cell is WORSE, beyond noise, when any of:
//   speed:  its median pixels_both is at least one frame (16.7 ms) above the baseline's AND a one-sided
//           Mann-Whitney U test says its per-switch pixels_both are higher with p < 0.05 (a switch not on screen
//           in time ranks above every number);
//   misses: its share of switches meeting the bar fell by 15 points or more (and by at least 2 switches);
//   errors: it shows page errors where the baseline showed none, or it did not complete where the baseline did.
// A worse cell measured while the PC was under load (either run) is UNCONFIRMED, and a cell the baseline has but
// this run did not measure leaves the comparison INCONCLUSIVE: neither reads as PASS.
export const NOISE = { frameMs: 16.7, p: 0.05, passDrop: 0.15, passDropMin: 2 }

const cmp = (x, y) => (x === y ? 0 : x < y ? -1 : 1)
function normCdf(z) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2
}
/** One-sided Mann-Whitney U: the p-value that `a` is stochastically GREATER than `b`. null = not on screen in
 * time, ranked above every number. Normal approximation with tie and continuity corrections. */
export function mannWhitneyGreater(a, b) {
  const v = (x) => (x == null ? Infinity : x)
  const n1 = a.length, n2 = b.length
  if (!n1 || !n2) return null
  const all = [...a.map((x) => ({ v: v(x), g: 0 })), ...b.map((x) => ({ v: v(x), g: 1 }))].sort((x, y) => cmp(x.v, y.v))
  const n = all.length, ranks = new Array(n)
  let tie = 0
  for (let i = 0; i < n;) {
    let j = i
    while (j + 1 < n && all[j + 1].v === all[i].v) j++
    for (let k = i; k <= j; k++) ranks[k] = (i + j) / 2 + 1
    const t = j - i + 1
    if (t > 1) tie += t ** 3 - t
    i = j + 1
  }
  const U1 = all.reduce((s, x, k) => s + (x.g === 0 ? ranks[k] : 0), 0) - (n1 * (n1 + 1)) / 2
  const mu = (n1 * n2) / 2
  const sigma = Math.sqrt(((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1))))
  if (!(sigma > 0)) return U1 > mu ? 0 : 1
  return 1 - normCdf((U1 - mu - 0.5) / sigma)
}
const medInf = (xs) => { const s = xs.map((x) => (x == null ? Infinity : x)).sort(cmp); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

/** Each cell of `current` against the same cell of `baseline` (results.json rows), and the one-line verdict. */
export function compareResults(current, baseline, noise = NOISE) {
  const B = new Map(baseline.map((r) => [r.id, r]))
  const C = new Map(current.map((r) => [r.id, r]))
  const rows = []
  for (const b of baseline) {
    if (b.verdict === 'SKIP') continue
    const r = C.get(b.id)
    if (!r || r.verdict === 'SKIP') { rows.push({ id: b.id, status: 'not measured' }); continue }
    const cs = (r.summary && r.summary.samples) || [], bs = (b.summary && b.summary.samples) || []
    const cm = medInf(cs), bm = medInf(bs)
    const d = cm != null && bm != null ? cm - bm : null
    const pWorse = mannWhitneyGreater(cs, bs), pBetter = mannWhitneyGreater(bs, cs)
    const rate = (x) => (x.summary && x.summary.switches ? x.summary.passed / x.summary.switches : null)
    const why = []
    if (d != null && d >= noise.frameMs && pWorse != null && pWorse < noise.p) why.push(`pixels_both median ${fmtMs(bm)} -> ${fmtMs(cm)} (p ${pWorse.toFixed(3)})`)
    const rb = rate(b), rc = rate(r)
    if (rb != null && rc != null && rb - rc >= noise.passDrop && b.summary.passed - r.summary.passed >= noise.passDropMin) why.push(`meeting the bar ${b.summary.passed}/${b.summary.switches} -> ${r.summary.passed}/${r.summary.switches}`)
    if ((r.summary.pageErrors || 0) > 0 && !(b.summary.pageErrors > 0)) why.push(`${r.summary.pageErrors} page error(s), baseline none`)
    if (r.verdict === 'ERROR' && b.verdict !== 'ERROR') why.push('did not complete')
    const better = !why.length && d != null && d <= -noise.frameMs && pBetter != null && pBetter < noise.p
    const status = why.length ? (r.loaded || b.loaded ? 'worse, UNCONFIRMED (under load)' : 'WORSE') : better ? 'better' : 'same'
    rows.push({ id: b.id, status, why, baseMs: bm, curMs: cm, dMs: d, pWorse })
  }
  const worse = rows.filter((x) => x.status === 'WORSE'), unconfirmed = rows.filter((x) => x.status.startsWith('worse, UNCONFIRMED')), missing = rows.filter((x) => x.status === 'not measured')
  const compared = rows.length - missing.length
  const verdict = worse.length ? 'REGRESSION' : unconfirmed.length || missing.length ? 'INCONCLUSIVE' : 'PASS'
  const line = verdict === 'REGRESSION'
    ? `REGRESSION: ${worse.length} of ${compared} cell(s) worse than the baseline beyond noise: ${worse.map((x) => x.id).join(', ')}`
    : verdict === 'INCONCLUSIVE'
      ? `INCONCLUSIVE: ${unconfirmed.length ? `${unconfirmed.length} cell(s) worse but measured under load (re-run): ${unconfirmed.map((x) => x.id).join(', ')}` : ''}${unconfirmed.length && missing.length ? '; ' : ''}${missing.length ? `${missing.length} baseline cell(s) not measured` : ''}`
      : `PASS: no cell worse than the baseline (${compared} compared; ${rows.filter((x) => x.status === 'better').length} better)`
  return { verdict, line, rows }
}
const fmtMs = (x) => (x == null ? 'n/a' : x === Infinity ? 'not on screen' : `${Math.round(x * 10) / 10} ms`)

export function formatCompare(c, meta = {}) {
  const lines = [`# Compare: ${meta.current || 'this run'} vs baseline ${meta.baseline || ''}`, '', c.line, '',
    `Noise rule: WORSE = median pixels_both up >= ${NOISE.frameMs} ms (one frame) with a one-sided Mann-Whitney p < ${NOISE.p}, or the share meeting the bar down >= ${NOISE.passDrop * 100} points (>= ${NOISE.passDropMin} switches), or new page errors, or the run not completing. Under load = UNCONFIRMED; a baseline cell not measured = INCONCLUSIVE.`,
    '', '| cell | status | baseline median | this run median | p (worse) | why |', '|---|---|---|---|---|---|']
  for (const r of c.rows) lines.push(`| ${r.id} | ${r.status} | ${fmtMs(r.baseMs)} | ${fmtMs(r.curMs)} | ${r.pWorse == null ? '' : r.pWorse.toFixed(3)} | ${(r.why || []).join('; ')} |`)
  return lines.join('\n') + '\n'
}
