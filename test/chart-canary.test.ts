import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import * as R from '../scripts/nightly/chart-canary-rules.mjs'

// The flip proof's own shapes: a chart's state is { c: 'bars|time|close', s: {...} }, `before`/`before2` are
// the states at the key press, each frame is { t, n, o, o2? } on the page clock, `key` on the same clock.
const st = (close: string, bars = 2012) => ({ c: `${bars}|1763596800|${close}`, s: {} })
// chart 1 (D) shows the new symbol `d` ms after the key, chart 2 (60) `h` ms after it (null: never); the proof
// keeps a frame only when the pair's state changed, in time order
const twoFlip = (key: number, d: number | null, h: number | null) => {
  const frames = [{ t: key + 5, n: key + 6, o: st('10.00'), o2: st('10.50') }]
  let o = st('10.00'), o2 = st('10.50')
  const events = [[d, 'o'], [h, 'o2']].filter((e) => e[0] != null).sort((a, b) => (a[0] as number) - (b[0] as number))
  for (const [ms, which] of events) {
    if (which === 'o') o = st('20.00')
    else o2 = st('20.40')
    frames.push({ t: key + (ms as number) - 2, n: key + (ms as number), o, o2 })
  }
  return { i: 0, dir: 'ArrowDown', key, before: st('10.00'), before2: st('10.50'), frames }
}
const typedFlip = (sym: string, key: number, ms: number | null) => ({
  i: 0, dir: 'typed', sym, key, before: st('10.00'),
  frames: ms == null ? [{ t: key + 4, n: key + 5, o: st('10.00') }] : [{ t: key + 4, n: key + 5, o: st('10.00') }, { t: key + ms - 1, n: key + ms, o: st('31.20', 3000) }],
})
const okRow = (date: string, medMs: number, o: Record<string, unknown> = {}) => ({
  date, two: { medMs, p90Ms: medMs + 60 }, soak: { retainedMBPer100: 40 }, pageErrors: { count: 0, rejections: 0 }, failures: [], ...o,
})
const nights = (n: number, medMs: number) => Array.from({ length: n }, (_, i) => okRow(`2026-11-${String(10 + i).padStart(2, '0')}`, medMs))

describe('chart canary scoring', () => {
  it('both on screen is the LATER of the two charts, timed by when the frame ran', () => {
    const s = R.scoreTwo({ dwell: 800, tf: 'D', tf2: '60', flips: [twoFlip(1000, 120, 180), twoFlip(5000, 200, 90), twoFlip(9000, 100, 140)] })
    expect(s).toMatchObject({ flips: 3, painted: 3, missed: 0, medMs: 180, maxMs: 200, censored: false })
  })

  it('a switch that never paints counts AT the dwell, so it can only make the night read slower', () => {
    const painted = [twoFlip(1000, 100, 120), twoFlip(5000, 100, 130), twoFlip(9000, 100, 140)]
    const base = R.scoreTwo({ dwell: 800, flips: painted })
    // chart 2 never shows the new symbol on two more switches
    const worse = R.scoreTwo({ dwell: 800, flips: [...painted, twoFlip(13000, 100, null), twoFlip(17000, 100, null)] })
    expect(worse.missed).toBe(2)
    expect(worse.censored).toBe(true)
    expect(worse.medMs).toBeGreaterThan(base.medMs)
    expect(worse.maxMs).toBe(800)
    // control: dropping the unpainted switches instead would have left the median unchanged at 130
    expect(base.medMs).toBe(130)
  })

  it('typed: the first frame whose close is not the old one; no key press is a miss, not a fast paint', () => {
    const s = R.scoreTyped({ dwell: 3000, tf: '60', flips: [typedFlip('AAA', 100, 250), typedFlip('BBB', 9000, 400), typedFlip('CCC', 20000, null), { ...typedFlip('DDD', 30000, 300), key: null }] })
    expect(s.painted).toBe(2)
    expect(s.missed).toBe(2)
    expect(s.perSym).toEqual([{ sym: 'AAA', ms: 250, bars: 3000 }, { sym: 'BBB', ms: 400, bars: 3000 }, { sym: 'CCC', ms: null, bars: null }, { sym: 'DDD', ms: null, bars: null }])
    expect(s.medMs).toBe((400 + 3000) / 2)
  })

  it('soak: retained per 100 = last reading minus the first, and a soak stopped early is scaled and says so', () => {
    const full = R.scoreSoak({ soak: [{ after: 0, usedMB: 250 }, { after: 50, usedMB: 270 }, { after: 100, usedMB: 280 }] }, 100)
    expect(full).toMatchObject({ complete: true, reached: 100, retainedMBPer100: 30, secondHalfMBPer100: 20, extrapolated: false })
    // 2026-11-20's leak: 235 MB at 0, 1,687 MB at 50, then the abort line
    const leak = R.scoreSoak({ soak: [{ after: 0, usedMB: 235 }, { after: 50, usedMB: 1687 }], error: 'heap over the abort line' }, 100)
    expect(leak).toMatchObject({ complete: false, reached: 50, retainedMBPer100: 2904, extrapolated: true })
    expect(R.scoreSoak({ soak: [] }, 100).retainedMBPer100).toBeNull()
  })
})

describe('chart canary regression lines', () => {
  it('a healthy night after seven healthy nights: no regression (the rules can pass)', () => {
    expect(R.regressions(okRow('2026-11-20', 150), nights(7, 140))).toEqual([])
  })

  it('speed: over 1.5x the trailing median fires; exactly 1.5x does not', () => {
    const prior = nights(7, 140)
    expect(R.regressions(okRow('2026-11-20', 210), prior)).toEqual([])
    const out = R.regressions(okRow('2026-11-20', 211), prior)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/^REGRESSION: both-on-screen median 211 ms is 1\.51x the trailing 7-night median 140 ms/)
  })

  it('speed needs three prior nights; memory, errors and failures do not', () => {
    expect(R.regressions(okRow('2026-11-20', 900), nights(2, 140))).toEqual([])
    expect(R.regressions(okRow('2026-11-20', 900), nights(3, 140))).toHaveLength(1)
    expect(R.regressions(okRow('2026-11-20', 150, { soak: { retainedMBPer100: 301 } }), [])[0]).toMatch(/memory retained 301 MB per 100 switches/)
    expect(R.regressions(okRow('2026-11-20', 150, { soak: { retainedMBPer100: 300 } }), [])).toEqual([])
    expect(R.regressions(okRow('2026-11-20', 150, { pageErrors: { count: 1, rejections: 1 } }), [])[0]).toMatch(/1 page error\(s\) \(1 unhandled rejection/)
    expect(R.regressions(okRow('2026-11-20', 150, { failures: [{ step: 'soak', why: 'timed out' }] }), [])[0]).toBe('REGRESSION: soak did not complete: timed out')
  })

  it('only earlier dates count, the newest row of a date wins, and at most seven', () => {
    const rows = [...nights(9, 100), okRow('2026-11-18', 400), okRow('2026-11-20', 999)]
    const prior = R.priorNights(rows, '2026-11-20')
    expect(prior).toHaveLength(7)
    expect(prior.map((r: { date: string }) => r.date)).toEqual(['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18'])
    expect(prior[6].two.medMs).toBe(400)
    expect(R.nightIndex(rows, '2026-11-20')).toBe(9)
  })

  it('latest.md carries tonight, the trailing medians and every REGRESSION line', () => {
    const row = { ...okRow('2026-11-20', 300, { soak: { retainedMBPer100: 2904, extrapolated: true, reached: 50, points: [{ after: 0, usedMB: 235 }, { after: 50, usedMB: 1687 }], complete: false, planned: 100 } }), runId: 'x', build: { commit: '4c2911bc9076ea0e', uptimeS: 600 } }
    const md = R.formatLatest(row, nights(7, 140))
    expect(md).toContain('REGRESSION: both-on-screen median 300 ms is 2.14x')
    expect(md).toContain('REGRESSION: memory retained 2904 MB per 100 switches (scaled from 50 switches)')
    expect(md).toContain('| ... p90 | 360 ms | 200 ms (7 nights) |')
    expect(md).toContain('`4c2911bc9076`')
    expect(R.formatLatest(okRow('2026-11-20', 150), [])).toContain('No regression.')
  })
})

describe('typed ticker rotation', () => {
  it('one night never types a ticker twice, and six nights type every (ticker, timeframe) pair exactly once', () => {
    const seen = new Map<string, number>()
    for (let k = 0; k < 6; k++) {
      const night = R.typedForNight(R.DEFAULT_POOL, k)
      const all = R.TYPED_TFS.flatMap((tf: string) => night[tf])
      expect(new Set(all).size).toBe(18)
      for (const tf of R.TYPED_TFS) for (const s of night[tf]) seen.set(`${tf}:${s}`, (seen.get(`${tf}:${s}`) || 0) + 1)
    }
    expect(seen.size).toBe(36 * 3)
    expect([...seen.values()].every((v) => v === 1)).toBe(true)
    expect(R.typedForNight(R.DEFAULT_POOL, 6)).toEqual(R.typedForNight(R.DEFAULT_POOL, 0))
  })

  it('a ticker typed tonight (on any timeframe) is not typed again tomorrow night', () => {
    for (let k = 0; k < 12; k++) {
      const a = new Set(Object.values(R.typedForNight(R.DEFAULT_POOL, k)).flat())
      const b = Object.values(R.typedForNight(R.DEFAULT_POOL, k + 1)).flat()
      expect(b.filter((s) => a.has(s))).toEqual([])
    }
  })

  it('a pool too small for three timeframes is refused, not silently reused', () => {
    expect(() => R.typedForNight(R.DEFAULT_POOL.slice(0, 12), 0)).toThrow(/at least 18/)
  })
})
