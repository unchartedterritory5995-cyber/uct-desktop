import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import * as N from '../scripts/nightly/compare.mjs'

const row = (route: string, o: Record<string, number> = {}) => ({
  route, busyPct: 2, layoutsPerS: 0, recalcsPerS: 1, rafPerS: 0, requestsPerMin: 20, heapMB: 40, ...o,
})
const run = (...routes: object[]) => ({ routes })
const pass = (r: object) => ({ status: 'pass', run: r })

describe('nightly speed check rules', () => {
  it('a run equal to the baseline, or within tolerance, is not a regression', () => {
    const base = run(row('/charts'))
    expect(N.findRegressions(base, run(row('/charts')))).toEqual([])
    // busy 2 -> 4 is exactly the +2 floor: still fine
    expect(N.findRegressions(base, run(row('/charts', { busyPct: 4, layoutsPerS: 3, rafPerS: 10, heapMB: 60 })))).toEqual([])
  })

  it('flags each metric that goes over its limit, with the numbers', () => {
    const base = run(row('/charts'))
    const out = N.findRegressions(base, run(row('/charts', { busyPct: 7.5, rafPerS: 60 })))
    expect(out).toEqual([
      { route: '/charts', metric: 'busyPct', base: 2, cur: 7.5, limit: 4 },
      { route: '/charts', metric: 'rafPerS', base: 0, cur: 60, limit: 10 },
    ])
  })

  it('a busy baseline scales by ratio, not the absolute floor', () => {
    expect(N.limitFor('busyPct', 20)).toBe(30)
    expect(N.limitFor('busyPct', 1)).toBe(3)
    expect(N.limitFor('heapMB', 200)).toBe(260)
  })

  it('a route new since the baseline gets no verdict', () => {
    expect(N.findRegressions(run(row('/charts')), run(row('/new-page', { busyPct: 90 })))).toEqual([])
  })

  it('only a slowdown seen on the recheck too is confirmed', () => {
    const first = [{ route: '/a', metric: 'busyPct' }, { route: '/b', metric: 'rafPerS' }]
    const recheck = [{ route: '/b', metric: 'rafPerS' }, { route: '/a', metric: 'heapMB' }]
    expect(N.confirmedRegressions(first, recheck)).toEqual([{ route: '/b', metric: 'rafPerS' }])
  })

  it('baseline is the per-metric median of the last 7 passing runs; regressed and blind nights never count', () => {
    const h = [
      pass(run(row('/c', { busyPct: 100 }))), // 8th from the end: dropped
      ...[1, 2, 3, 4, 5, 6].map((b) => pass(run(row('/c', { busyPct: b })))),
      { status: 'regressed', run: run(row('/c', { busyPct: 500 })) },
      { status: 'blind' },
      pass(run(row('/c', { busyPct: 7 }))),
    ]
    const b = N.baselineFrom(h)
    expect(b.runs).toBe(7)
    expect(b.routes[0].busyPct).toBe(4)
    expect(N.baselineFrom([{ status: 'blind' }])).toBeNull()
  })

  it('a reset (--accept) starts the baseline over from the nights after it', () => {
    const h = [pass(run(row('/c', { busyPct: 1 }))), { status: 'reset' }, pass(run(row('/c', { busyPct: 9 })))]
    expect(N.baselineFrom(h).routes[0].busyPct).toBe(9)
    expect(N.baselineFrom([pass(run(row('/c'))), { status: 'reset' }])).toBeNull()
  })

  it('blind nights are counted from the end, and the notice fires once at 3', () => {
    expect(N.trailingBlind([{ status: 'blind' }, pass(run()), { status: 'blind' }, { status: 'blind' }])).toBe(2)
    expect(N.trailingBlind([pass(run())])).toBe(0)
    expect(N.trailingBlind([{ status: 'blind' }, { status: 'regressed' }, { status: 'blind' }])).toBe(1)
    expect(N.BLIND_ALERT_AFTER).toBe(3)
  })

  it('a lasting slowdown posts the first night, then every 7th', () => {
    const reg = { status: 'regressed' }
    expect(N.shouldPostRegression([pass(run())])).toBe(true)
    expect(N.shouldPostRegression([pass(run()), reg])).toBe(false)
    expect(N.shouldPostRegression(Array(6).fill(reg))).toBe(false)
    expect(N.shouldPostRegression(Array(7).fill(reg))).toBe(true)
  })

  it('the alert names route, metric and numbers and fits a Discord message', () => {
    const text = N.formatRegressionAlert([{ route: '/charts', metric: 'rafPerS', base: 0, cur: 60, limit: 10 }], { date: '2026-11-11', appVersion: '0.1.5', build: 'index-x.js' })
    expect(text).toContain('`/charts` animation frames/s: 60 (normal 0, limit 10)')
    expect(text).toContain('0.1.5')
    const many = Array(200).fill({ route: '/charts', metric: 'busyPct', base: 1, cur: 9, limit: 3 })
    expect(N.formatRegressionAlert(many, { date: 'd', appVersion: 'v' }).length).toBeLessThanOrEqual(1900)
  })
})
