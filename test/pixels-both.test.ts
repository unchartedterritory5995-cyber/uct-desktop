import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import * as M from '../scripts/proofs/acceptance-matrix-lib.mjs'

// paint-probe.js's record, verbatim shape: { w: widget id, t: the rAF frame time, end: when the paint callback ended,
// time / close: the newest bar it drew, present: the next frame's time }. `before` is the sampler's state at the key.
const before = (close: string, time = '2026-11-20') => ({ c: `2012|${time}|${close}`, s: {} })
const paint = (w: string, t: number, end: number, close: number, present: number | null, time = '2026-11-20') => ({ w, t, end, time, close, present })
const flip = (paints: object[], o: Record<string, unknown> = {}) => ({ i: 0, key: 1000, before: before('10'), before2: before('11'), frames: [], long: [], res: [], paints, busy: [], busyFrom: 1100, busyEnd: 2100, evt: [], ...o })

describe('pixels_both, the presentation stamp', () => {
  it("is the next frame after the LAST linked chart's first paint of the new symbol", () => {
    const s = M.scoreSwitch(flip([
      paint('flip-chart', 990, 995, 10, 1006), // the OLD symbol, before the key: not it
      paint('flip-chart', 1016.7, 1022, 20, 1033.4), paint('flip-chart-2', 1016.7, 1024, 21, 1033.4),
    ]), 2, 1500)
    expect(s).toMatchObject({ stamp: 'pixels', pixelsMs: [33.4, 33.4], pixelsBothMs: 33.4, firstPixelsMs: 33.4, skewFrames: 0, pass: true })
  })

  it('a chart that has not painted the new symbol, or whose frame was not presented, is a miss', () => {
    const s = M.scoreSwitch(flip([paint('flip-chart', 1016.7, 1022, 20, 1033.4)]), 2, 1500)
    expect(s.pass).toBe(false)
    expect(s.pixelsBothMs).toBeNull()
    expect(s.reasons[0]).toMatch(/chart 2's new candles not on screen/)
    const unpresented = M.scoreSwitch(flip([paint('flip-chart', 1016.7, 1022, 20, 1033.4), paint('flip-chart-2', 1016.7, 1022, 21, null)]), 2, 1500)
    expect(unpresented.pass).toBe(false)
  })

  it('over 40 ms on screen fails; charts painted a frame apart are SYNC_SKEW 1', () => {
    const slow = M.scoreSwitch(flip([paint('flip-chart', 1033, 1040, 20, 1050), paint('flip-chart-2', 1033, 1041, 21, 1050)]), 2, 1500)
    expect(slow.reasons).toEqual(['pixels_both 50 ms > 40'])
    const skew = M.scoreSwitch(flip([paint('flip-chart', 1000.5, 1004, 20, 1017), paint('flip-chart-2', 1017.2, 1021, 21, 1034)]), 2, 1500)
    expect(skew.reasons).toEqual(['SYNC_SKEW 1 frame(s)'])
  })

  it('post-paint budget: a second repaint of a chart in the 1 s after fails; a live new bar does not count', () => {
    const base = [paint('flip-chart', 1016.7, 1022, 20, 1033.4), paint('flip-chart-2', 1016.7, 1024, 21, 1033.4)]
    const one = M.scoreSwitch(flip([...base, paint('flip-chart', 1100, 1105, 20, 1117)]), 2, 1500)
    expect(one).toMatchObject({ repaints: [1, 0], pass: true })
    const two = M.scoreSwitch(flip([...base, paint('flip-chart', 1100, 1105, 20, 1117), paint('flip-chart', 1300, 1305, 20.5, 1317)]), 2, 1500)
    expect(two.reasons).toEqual(['repaints after the first: chart 1 x2 (> 1)'])
    const newBar = M.scoreSwitch(flip([...base, paint('flip-chart', 1100, 1105, 20, 1117), paint('flip-chart', 1300, 1305, 20.4, 1317, '2026-11-21')]), 2, 1500)
    expect(newBar).toMatchObject({ repaints: [1, 0], pass: true })
    // after the 1 s window it is not this switch's business
    expect(M.scoreSwitch(flip([...base, paint('flip-chart', 1100, 1105, 20, 1117), paint('flip-chart', 2100, 2105, 20, 2117)]), 2, 1500).repaints).toEqual([1, 0])
  })

  it('post-paint budget: any main-thread busy period over 8 ms in the 1 s after fails', () => {
    const base = [paint('flip-chart', 1016.7, 1022, 20, 1033.4), paint('flip-chart-2', 1016.7, 1024, 21, 1033.4)]
    expect(M.scoreSwitch(flip(base, { busy: [{ s: 1200, d: 8 }] }), 2, 1500).pass).toBe(true)
    const busy = M.scoreSwitch(flip(base, { busy: [{ s: 1200, d: 8.4 }, { s: 1500, d: 31 }] }), 2, 1500)
    expect(busy.reasons).toEqual(['2 main-thread busy period(s) > 8 ms in the 1 s after (max 31 ms)'])
  })

  it("Event Timing cross-check: a stamp more than 8 ms before the input's own first presentation is flagged", () => {
    const base = [paint('flip-chart', 1016.7, 1022, 20, 1033.4), paint('flip-chart-2', 1016.7, 1024, 21, 1033.4)]
    expect(M.scoreSwitch(flip(base, { evt: [{ n: 'keydown', s: 999.5, d: 32 }] }), 2, 1500)).toMatchObject({ inputPresentMs: 31.5, stampEarly: false })
    expect(M.scoreSwitch(flip(base, { evt: [{ n: 'keydown', s: 999.5, d: 48 }] }), 2, 1500).stampEarly).toBe(true)
  })

  it("the old stamp's lead is kept, and a run without the paint record is scored the old way and says so", () => {
    const frames = [{ t: 1003, n: 1004, o: before('10'), o2: before('11') }, { t: 1004, n: 1005, o: { c: '3000|2026-11-20|20', s: {} }, o2: { c: '3000|2026-11-20|21', s: {} } }]
    const px = M.scoreSwitch(flip([paint('flip-chart', 1016.7, 1022, 20, 1033.4), paint('flip-chart-2', 1016.7, 1024, 21, 1033.4)], { frames }), 2, 1500)
    expect(px).toMatchObject({ seenBothMs: 5, pixelsBothMs: 33.4, seenLeadMs: 28.4 })
    const old = M.scoreSwitch({ ...flip([], { frames }), paints: undefined }, 2, 1500)
    expect(old).toMatchObject({ stamp: 'seen', bothMs: 5 })
  })

  it('the lean probe: its own `first` mark decides the paint; unread repaints count unless the bar read after the window moved on', () => {
    // the lean record: only the first new paint carries a bar; the rest are frame, end, draws, present
    const lean = (o: Record<string, unknown> = {}) => flip([
      { w: 'flip-chart', t: 1000.1, end: 1003, draws: 40, present: 1016.7 }, // not read: before the new data
      { w: 'flip-chart', t: 1016.7, end: 1022, draws: 2400, present: 1033.4, time: '2026-11-20', close: 20, first: true },
      { w: 'flip-chart-2', t: 1016.7, end: 1024, draws: 1800, present: 1033.4, time: '2026-11-20', close: 21, first: true },
      { w: 'flip-chart', t: 1100, end: 1105, draws: 2400, present: 1117 },
      { w: 'flip-chart', t: 1300, end: 1305, draws: 2400, present: 1317 },
    ], o)
    const s = M.scoreSwitch(lean({ finals: { 'flip-chart': { time: '2026-11-20', close: 20 }, 'flip-chart-2': { time: '2026-11-20', close: 21 } } }), 2, 1500)
    expect(s).toMatchObject({ pixelsBothMs: 33.4, repaints: [2, 0], pass: false })
    expect(s.reasons).toEqual(['repaints after the first: chart 1 x2 (> 1)'])
    // the bar read once after the window is newer: one of those paints was a live new bar
    const live = M.scoreSwitch(lean({ finals: { 'flip-chart': { time: '2026-11-21', close: 20.4 }, 'flip-chart-2': { time: '2026-11-20', close: 21 } } }), 2, 1500)
    expect(live).toMatchObject({ repaints: [1, 0], pass: true })
  })

  it('a held key is held to the bar on its landing only; the symbols it passed are counted', () => {
    const cell = { store: 'default', layout: 'D+60m', list: 'sp500', motion: 'held', id: 'x' }
    const miss = flip([], { key: 1000 })
    const land = flip([paint('flip-chart', 2016.7, 2022, 20, 2033.4), paint('flip-chart-2', 2016.7, 2024, 21, 2033.4)], { key: 2000 })
    const r = M.scoreCell({ dwell: 0, flips: [miss, miss, land], soak: [{ after: 0, usedMB: 1 }, { after: 3, usedMB: 1 }] }, cell)
    expect(r.summary).toMatchObject({ switches: 1, passed: 1, passing: { painted: 0, of: 2 }, samples: [33.4] })
    expect(r.verdict).toBe('PASS*')
  })
})

describe('--compare against the production baseline', () => {
  const row = (id: string, samples: (number | null)[], o: Record<string, unknown> = {}) => ({ id, verdict: 'FAIL', loaded: false, summary: { samples, switches: samples.length, passed: samples.filter((x) => x != null && x <= 40).length, pageErrors: 0 }, ...o })
  const base = [row('a', [33, 33, 50, 33, 50, 33, 33, 50, 33, 33, 50, 33, 33, 50]), row('b', [33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33])]

  it('equal is PASS; one frame slower on a real shift is a REGRESSION; slower by noise is not', () => {
    expect(M.compareResults(base, base).line).toMatch(/^PASS: no cell worse than the baseline \(2 compared/)
    const slower = [base[0], row('b', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50])]
    const c = M.compareResults(slower, base)
    expect(c.verdict).toBe('REGRESSION')
    expect(c.line).toMatch(/^REGRESSION: 1 of 2 cell\(s\) worse than the baseline beyond noise: b$/)
    // one switch a frame slower moves no median and passes the test
    const noise = [base[0], row('b', [50, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33, 33])]
    expect(M.compareResults(noise, base).verdict).toBe('PASS')
  })

  it('switches no longer on screen in time, new page errors and a stopped run are worse; under load is UNCONFIRMED', () => {
    const misses = [base[0], row('b', [33, 33, null, null, null, 33, 33, 33, 33, 33, 33, 33, 33, 33])]
    expect(M.compareResults(misses, base).rows[1].why).toEqual(['meeting the bar 14/14 -> 11/14'])
    const errs = [base[0], row('b', base[1].summary.samples, { summary: { ...base[1].summary, pageErrors: 2 } })]
    expect(M.compareResults(errs, base).rows[1].why).toEqual(['2 page error(s), baseline none'])
    const loaded = [base[0], row('b', Array(14).fill(50), { loaded: true })]
    expect(M.compareResults(loaded, base)).toMatchObject({ verdict: 'INCONCLUSIVE' })
    expect(M.compareResults([base[0]], base).line).toMatch(/^INCONCLUSIVE: 1 baseline cell\(s\) not measured/)
  })

  it('Mann-Whitney: identical samples are not different; a clear shift is', () => {
    const a = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    expect(M.mannWhitneyGreater(a, a)).toBeGreaterThan(0.4)
    expect(M.mannWhitneyGreater(a.map((x) => x + 20), a)).toBeLessThan(0.001)
    expect(M.mannWhitneyGreater(a, a.map((x) => x + 20))).toBeGreaterThan(0.99)
  })
})
