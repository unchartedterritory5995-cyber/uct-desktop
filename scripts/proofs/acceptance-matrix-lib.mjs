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

export const BAR = {
  bothMs: 40, // the later linked chart on screen within this many ms of the key / click / Enter
  skewFrames: 0, // linked charts in the same frame
  extraPaints: 0, // one paint: nothing about the new symbol's picture changes after its first frame
  followUpLongTasks: 0, // no long task (> 50 ms) after BOTH within the dwell: a heavy follow-up
  followUpRenders: 0, // no StockChart render after BOTH (counted only on a render-probe build)
  memMBPerSwitch: 1, // heap after a full GC, end minus start, per switch (caches fill a little; a leak is ~20)
  pageErrors: 0,
}
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
}
// `default`: no override, so a fresh profile runs whatever production defaults to (the nightly core grid)
export const STORES = { off: ['--ls=uct.deviceStore=0'], on: ['--ls=uct.deviceStore=1', '--wait-device=1'], default: [] }
/** Named selections. CORE = the owner's core grid (coordinator 2026-11-21), the nightly default: 24 cells.
 * FULL = every layout, list and motion, device store off and on: 896 cells, weekends in resumable slices. */
export const GRIDS = {
  core: { layouts: ['D+60m', 'D+30m'], lists: ['sp500', 'r2000', 'bullbear'], motions: ['next', 'jump12', 'jump70', 'typed'], stores: ['default'] },
  full: { stores: ['off', 'on'] },
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
      '--headless=1', '--cheap-sampler=1', '--heap-ends=1', `--port=${o.port}`, `--set=${o.set}`, `--warmup=${o.warmup}`,
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

/** One switch against the bar. `charts` = how many linked charts the layout has. */
export function scoreSwitch(f, charts, dwell, renders = null, bar = BAR) {
  const key = f.key
  const s = { i: f.i, sym: f.sym || null, reasons: [] }
  if (!key) { s.reasons.push('no key press recorded'); s.pass = false; return s }
  const paints = FIELDS.slice(0, charts).map((fld, c) => firstPaintOf(f.frames, fld, f[BEFORE[c]] && f[BEFORE[c]].c, key))
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
  const heap = (j.soak || []).filter((r) => typeof r.usedMB === 'number')
  const h0 = heap.length ? heap[0] : null, h1 = heap.length > 1 ? heap[heap.length - 1] : null
  const growth = h0 && h1 ? Math.round((h1.usedMB - h0.usedMB) * 10) / 10 : null
  const perSwitch = growth != null && switches.length ? Math.round((growth / switches.length) * 100) / 100 : null
  const errs = (j.pageErrors && j.pageErrors.count) || 0
  const sum = (k) => switches.map((s) => s[k])
  const summary = {
    switches: switches.length, passed: switches.filter((s) => s.pass).length,
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
  const missed = switches.length - summary.passed
  if (missed) reasons.push(`${missed} of ${switches.length} switches missed the bar`)
  if (errs > bar.pageErrors) reasons.push(`${errs} page error(s)`)
  if (perSwitch != null && perSwitch > bar.memMBPerSwitch) reasons.push(`heap +${growth} MB (${perSwitch} MB per switch)`)
  const unmeasured = []
  if (renders == null) unmeasured.push('StockChart renders (not a render-probe build)')
  if (perSwitch == null) unmeasured.push('heap growth')
  const verdict = j.error || !switches.length ? 'ERROR' : reasons.length ? 'FAIL' : unmeasured.length ? 'PASS*' : 'PASS'
  return { id: cell.id || cellId(cell), cell, verdict, reasons, unmeasured, summary, switches, build: j.build || null, dist: j.dist ? j.dist.dir : null }
}

/** The grid: one table per store arm, rows = layout x list, columns = motions. */
export function formatGrid(results, cells, meta = {}) {
  const by = new Map(results.map((r) => [r.id, r]))
  const motions = [...new Set(cells.map((c) => c.motion))]
  const lines = [`# Chart acceptance matrix${meta.name ? `: ${meta.name}` : ''}`, '']
  const counts = {}
  for (const r of results) counts[r.verdict] = (counts[r.verdict] || 0) + 1
  lines.push(`Bar: linked charts in the same frame (SYNC_SKEW ${BAR.skewFrames}), BOTH <= ${BAR.bothMs} ms, one paint, no long task or StockChart render after BOTH, heap growth <= ${BAR.memMBPerSwitch} MB per switch, no page error.`)
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
        const both = s.bothMs.med != null ? ` BOTH ${s.bothMs.med}/${s.bothMs.p90} ms` : ''
        return `**${res.verdict}** ${s.passed}/${s.switches}${both}${res.verdict === 'FAIL' || res.verdict === 'ERROR' ? `: ${res.reasons[0]}` : ''}`
      })
      lines.push(`| ${r.layout} | ${LISTS[r.list].name} | ${tds.join(' | ')} |`)
    }
  }
  return lines.join('\n') + '\n'
}

/** The worst switches over every scored cell: unpainted first, then the slowest BOTH, then the widest skew. */
export function worstSwitches(results, n = 10) {
  const all = []
  for (const r of results) for (const s of r.switches || []) if (!s.pass) all.push({ cell: r.id, ...s })
  const score = (s) => (s.bothMs == null ? 1e9 : s.bothMs) + (s.skewFrames || 0) * 1000
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
  for (const x of f.long || []) if (x.s >= key - 5) ev.push([x.s - key, `long task ${x.d} ms`])
  for (const r of f.res || []) if (r.s >= key - 5) ev.push([r.e - key, `<- ${String(r.u).split('?')[0].slice(0, 70)} (${r.e - r.s} ms${r.st ? ', ' + String(r.st).slice(0, 60) : ''})`])
  for (const r of renders || []) if (r.t >= key - 1 && r.t <= key + 10000) ev.push([r.t - key, `${r.who} renders (${r.why.slice(0, 60)})`])
  return ev.sort((a, b) => a[0] - b[0]).map(([t, e]) => `${t === Number.MAX_SAFE_INTEGER ? '   --' : String(Math.round(t)).padStart(6)}  ${e}`)
}
