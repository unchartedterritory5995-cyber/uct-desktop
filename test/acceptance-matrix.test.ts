import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import * as M from '../scripts/proofs/acceptance-matrix-lib.mjs'

// The flip proof's shapes: a chart's state per frame is { c: 'bars|newestTime|close', s: {series: 'len|last'}, m, w },
// `before`/`before2`/`before3` are the states at the key, frames { t (rAF time), n (when it ran), o, o2, o3 }.
type St = { c: string, s: Record<string, string>, m?: number, w?: number }
const st = (close: string, o: { bars?: number, time?: number, m?: number, w?: number, ma?: number } = {}): St => ({
  c: `${o.bars ?? 2012}|${o.time ?? 1763596800}|${close}`, s: { 'ovl:0::ma': `${o.ma ?? o.bars ?? 2012}|x` }, m: o.m ?? 0.5, w: o.w ?? 120,
})
const OLD = [st('10.00'), st('10.50'), st('11.00')]
/** A switch: chart c shows the new symbol `ms[c]` ms after the key (null = never), each in its own frame unless
 * two share a time; `later` appends frames after the paint (per chart index: a state). */
function flip(key: number, ms: (number | null)[], later: { at: number, chart: number, state: St }[] = [], extra: Record<string, unknown> = {}) {
  const cur = OLD.slice(0, ms.length).map((x) => ({ ...x }))
  const pack = () => (ms.length === 1 ? { o: cur[0] } : ms.length === 2 ? { o: cur[0], o2: cur[1] } : { o: cur[0], o2: cur[1], o3: cur[2] })
  const frames: Record<string, unknown>[] = [{ t: key + 3, n: key + 4, ...pack() }]
  const times = [...new Set(ms.filter((x) => x != null) as number[])].sort((a, b) => a - b)
  for (const at of times) {
    ms.forEach((m, c) => { if (m === at) cur[c] = st(`2${c}.00`, { bars: 3000 }) })
    frames.push({ t: key + at - 1, n: key + at, ...pack() })
  }
  for (const l of later) { cur[l.chart] = l.state; frames.push({ t: key + l.at - 1, n: key + l.at, ...pack() }) }
  return { i: 0, sym: 'NEW', key, before: OLD[0], before2: OLD[1], before3: OLD[2], frames, long: [], res: [], ...extra }
}

describe('a switch against the bar', () => {
  it('two linked charts in the same frame within 40 ms, one paint: pass', () => {
    const s = M.scoreSwitch(flip(1000, [30, 30]), 2, 1500)
    expect(s).toMatchObject({ pass: true, firstMs: 30, bothMs: 30, skewFrames: 0, extra: [], reasons: [] })
  })

  it('one frame apart is SYNC_SKEW 1; over 40 ms fails; three charts take the first and the last', () => {
    expect(M.scoreSwitch(flip(1000, [20, 37]), 2, 1500).reasons).toEqual(['SYNC_SKEW 1 frame(s)'])
    expect(M.scoreSwitch(flip(1000, [45, 45]), 2, 1500).reasons).toEqual(['BOTH 45 ms > 40'])
    const three = M.scoreSwitch(flip(1000, [20, 20, 70]), 3, 1500)
    expect(three).toMatchObject({ firstMs: 20, bothMs: 70, skewFrames: 3, pass: false })
    // control: the same third chart scored as a two-chart layout never sees it
    expect(M.scoreSwitch(flip(1000, [20, 20, 70]), 2, 1500).pass).toBe(true)
  })

  it('a chart that never shows the new symbol fails, named, and is not a fast paint', () => {
    const s = M.scoreSwitch(flip(1000, [25, null]), 2, 1500)
    expect(s.pass).toBe(false)
    expect(s.bothMs).toBeNull()
    expect(s.reasons[0]).toMatch(/not on screen within the 1500 ms dwell \(chart 2\)/)
    expect(M.scoreSwitch({ ...flip(1000, [25, 25]), key: null }, 2, 1500).reasons).toEqual(['no key press recorded'])
  })

  it('one paint: a deeper history, a moved or re-zoomed view, a late indicator each count; a live tick or new bar does not', () => {
    const depth = M.scoreSwitch(flip(1000, [30, 30], [{ at: 400, chart: 0, state: st('20.00', { bars: 5000, ma: 3000 }) }]), 2, 1500)
    expect(depth.extra).toEqual([{ chart: 1, ms: 400, kinds: ['depth'] }])
    expect(depth.reasons).toEqual(['1 more paint(s): depth'])
    const moved = M.scoreSwitch(flip(1000, [30, 30], [{ at: 300, chart: 1, state: st('21.00', { bars: 3000, m: 4.5 }) }]), 2, 1500)
    expect(moved.extra[0]).toEqual({ chart: 2, ms: 300, kinds: ['moved'] })
    const zoom = M.scoreSwitch(flip(1000, [30, 30], [{ at: 300, chart: 0, state: st('20.00', { bars: 3000, w: 200 }) }]), 2, 1500)
    expect(zoom.extra[0].kinds).toEqual(['zoomed'])
    const lateMa = M.scoreSwitch(flip(1000, [30, 30], [{ at: 200, chart: 0, state: st('20.00', { bars: 3000, ma: 2999 }) }]), 2, 1500)
    expect(lateMa.extra[0].kinds).toEqual(['indicators'])
    // a live tick (close only) and a live NEW bar (count +1 with a new newest time) are the market, not a repaint
    const tick = M.scoreSwitch(flip(1000, [30, 30], [{ at: 500, chart: 0, state: st('20.07', { bars: 3000 }) }, { at: 900, chart: 0, state: st('20.09', { bars: 3001, time: 1763596860, ma: 3001 }) }]), 2, 1500)
    expect(tick).toMatchObject({ pass: true, extra: [] })
  })

  it('a long task after BOTH is a heavy follow-up; one before BOTH only counts toward the time', () => {
    const before = M.scoreSwitch(flip(1000, [35, 35], [], { long: [{ s: 1005, d: 25 }] }), 2, 1500)
    expect(before).toMatchObject({ pass: true, long: { count: 1, totalMs: 25, maxMs: 25 }, followUpLong: { count: 0 } })
    const after = M.scoreSwitch(flip(1000, [35, 35], [], { long: [{ s: 1300, d: 120 }] }), 2, 1500)
    expect(after.reasons).toEqual(['1 long task(s) after BOTH (120 ms)'])
  })

  it('StockChart renders after BOTH count only when the run carries render-probe lines', () => {
    const renders = M.probeRenders(['[rprobe] 1010.5 StockChart#a sym', '[rprobe] 1400.0 StockChart#b bars', '[rprobe] 1500 ChartPane#x -', 'other line'])
    expect(renders).toHaveLength(2)
    expect(M.scoreSwitch(flip(1000, [30, 30]), 2, 1500, renders)).toMatchObject({ rendersAfter: 1, pass: false })
    expect(M.scoreSwitch(flip(1000, [30, 30]), 2, 1500, null)).toMatchObject({ rendersAfter: null, pass: true })
    expect(M.probeRenders(undefined)).toBeNull()
  })
})

describe('a cell', () => {
  const cell = { store: 'off', layout: 'D+60m', list: 'sp500', motion: 'next', id: 'off__D+60m__sp500__next' }
  const run = (o: Record<string, unknown> = {}) => ({ dwell: 1500, flips: [flip(1000, [30, 30]), flip(5000, [32, 32])], soak: [{ after: 0, usedMB: 250 }, { after: 2, usedMB: 251 }], pageErrors: { count: 0 }, ...o })

  it('every criterion met but renders not counted is PASS*, with the probe it is PASS', () => {
    const a = M.scoreCell(run(), cell)
    expect(a.verdict).toBe('PASS*')
    expect(a.unmeasured).toEqual(['StockChart renders (not a render-probe build)'])
    expect(a.summary).toMatchObject({ switches: 2, passed: 2, bothMs: { med: 31 }, heapMB: { growth: 1, perSwitch: 0.5 } })
    expect(M.scoreCell(run({ console: ['[rprobe] 1010 StockChart#a sym'] }), cell).verdict).toBe('PASS')
  })

  it('a missed switch, a page error, heap growth or a stopped run each fail it', () => {
    expect(M.scoreCell(run({ flips: [flip(1000, [30, 90])] }), cell)).toMatchObject({ verdict: 'FAIL', reasons: ['1 of 1 switches missed the bar'] })
    expect(M.scoreCell(run({ pageErrors: { count: 2 } }), cell).reasons).toEqual(['2 page error(s)'])
    expect(M.scoreCell(run({ soak: [{ after: 0, usedMB: 250 }, { after: 2, usedMB: 290 }] }), cell).reasons).toEqual(['heap +40 MB (20 MB per switch)'])
    expect(M.scoreCell(run({ error: 'Error: timed out waiting' }), cell).verdict).toBe('ERROR')
    expect(M.scoreCell(run({ flips: [] }), cell).verdict).toBe('ERROR')
    // no heap readings: not a pass on memory, it is unmeasured
    expect(M.scoreCell(run({ soak: [] }), cell).unmeasured).toContain('heap growth')
  })
})

describe('the matrix', () => {
  it('has every layout, list, motion and store the brief names, and a subset is one cell', () => {
    expect(Object.keys(M.LAYOUTS)).toEqual(['1m', '5m', '15m', '30m', '60m', 'D', 'W', 'M', 'D+1m', 'D+5m', 'D+15m', 'D+30m', 'D+60m', 'W+D', '60m+5m', 'D+60m+5m'])
    expect(M.expandCells({ stores: ['off', 'on'] })).toHaveLength(16 * 7 * 4 * 2)
    expect(Object.keys(M.STORES)).toEqual(['off', 'on', 'default'])
    const one = M.expandCells({ layouts: ['D+60m'], lists: ['sp500'], motions: ['next'], stores: ['off'] })
    expect(one).toEqual([{ store: 'off', layout: 'D+60m', list: 'sp500', motion: 'next', id: 'off__D+60m__sp500__next' }])
    expect(() => M.expandCells({ layouts: ['D+61m'] })).toThrow(/unknown: D\+61m/)
  })

  it("a cell's flip-proof arguments: its charts, list, motion and store; a list it cannot reach is SKIPPED", () => {
    const a = M.cellArgs({ store: 'on', layout: 'D+60m+5m', list: 'r2000', motion: 'jump70' }).args
    expect(a).toEqual(expect.arrayContaining(['--tf=D', '--tf2=60', '--tf3=5', '--list=Russell 2000', '--pattern=jump', '--jump=70', '--flips=15', '--ls=uct.deviceStore=1', '--wait-device=1', '--heap-ends=1', '--headless=1']))
    const t = M.cellArgs({ store: 'off', layout: 'W', list: 'bullbear', motion: 'typed' }, { renderProbe: true, dist: 'D:/x' }, ['AAA', 'BBB']).args
    expect(t).toEqual(expect.arrayContaining(['--tf=W', '--typed=AAA,BBB', '--type-gap=0', '--typed-pause=0', '--ls=uct.deviceStore=0,uct.renderprobe=1', '--console=rprobe', '--dist=D:/x']))
    expect(t.filter((x: string) => x.startsWith('--ls=')).length).toBe(1)
    expect(t.some((x: string) => x.startsWith('--tf2='))).toBe(false)
    expect(M.cellArgs({ store: 'off', layout: 'D', list: 'user', motion: 'next' })).toEqual({ skip: 'a user watchlist: pass --user-list=<...>' })
    expect(M.cellArgs({ store: 'off', layout: 'D', list: 'screener', motion: 'next' }, { screenId: 12 }).args.some((x: string) => x.includes('"source":"screen","value":"12"'))).toBe(true)
  })

  it('typed tickers: 14, rotated by the day and the cell, never repeating inside one cell', () => {
    const a = M.typedFor(M.TYPED_POOL, 20412, 0), b = M.typedFor(M.TYPED_POOL, 20412, 1), c = M.typedFor(M.TYPED_POOL, 20413, 0)
    expect(a).toHaveLength(14)
    expect(new Set(a).size).toBe(14)
    expect(a.filter((x: string) => b.includes(x))).toEqual([])
    expect(c).toEqual(b)
    expect(() => M.typedFor(M.TYPED_POOL.slice(0, 5), 0, 0)).toThrow(/at least 14/)
  })

  it('the grid shows each cell and the worst switches come first', () => {
    const cells = M.expandCells({ layouts: ['D+60m'], lists: ['sp500'], motions: ['next', 'typed'], stores: ['off'] })
    const good = M.scoreCell({ dwell: 1500, flips: [flip(1000, [30, 30])], soak: [{ after: 0, usedMB: 1 }, { after: 1, usedMB: 1 }] }, cells[0])
    const bad = M.scoreCell({ dwell: 4000, flips: [flip(1000, [30, 200]), flip(9000, [30, null]), flip(19000, [50, 50])] }, cells[1])
    const md = M.formatGrid([good, bad], cells)
    expect(md).toContain('| D+60m | S&P 500 | **PASS*** 1/1 BOTH 30/30 ms | **FAIL** 0/3')
    const w = M.worstSwitches([good, bad], 10)
    expect(w.map((s: { bothMs: number | null }) => s.bothMs)).toEqual([null, 200, 50])
    expect(M.timeline(flip(1000, [30, 30], [{ at: 400, chart: 0, state: st('20.00', { bars: 5000 }) }], { long: [{ s: 1100, d: 60 }] }), 2)).toEqual([
      '    30  chart 1 first shows it (frame ran 30 ms; frame time 29 ms)',
      '    30  chart 2 first shows it (frame ran 30 ms; frame time 29 ms)',
      '   100  long task 60 ms',
      '   400  chart 1 paints again: depth+indicators',
    ])
  })
})
