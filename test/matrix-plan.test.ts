import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import { matrixPlan } from '../scripts/nightly/matrix-plan.mjs'
// @ts-expect-error plain .mjs script module, no types
import * as M from '../scripts/proofs/acceptance-matrix-lib.mjs'

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 40)

describe('the nightly acceptance-matrix slice', () => {
  it('weeknights: the core grid into a folder of its own, 120 min', () => {
    expect(matrixPlan(at(2026, 11, 20), 'D:/a', null, null)).toEqual({ grid: 'core,cadence', out: 'D:/a/core-20261120', budgetMin: 120, newPass: null })
    expect(matrixPlan(at(2026, 11, 23), 'D:/a', { dir: 'D:/a/full-20261121' }, { todo: 300 }, { UCT_MATRIX_CORE_MIN: '45' }).budgetMin).toBe(45)
  })

  it('weekend nights: one full pass resumes until every cell is scored, then a new pass starts', () => {
    const sat = matrixPlan(at(2026, 11, 21), 'D:/a', null, null)
    expect(sat).toMatchObject({ grid: 'full', out: 'D:/a/full-20261121', budgetMin: 360, newPass: { dir: 'D:/a/full-20261121' } })
    // Sunday: the same pass, still cells to go (and a pass that has not written a status yet keeps going too)
    expect(matrixPlan(at(2026, 11, 22), 'D:/a', { dir: 'D:/a/full-20261121' }, { todo: 412 })).toEqual({ grid: 'full', out: 'D:/a/full-20261121', budgetMin: 360, newPass: null })
    expect(matrixPlan(at(2026, 11, 22), 'D:/a', { dir: 'D:/a/full-20261121' }, null).newPass).toBeNull()
    // the next weekend after it finished: a new pass
    expect(matrixPlan(at(2026, 11, 28), 'D:/a', { dir: 'D:/a/full-20261121' }, { todo: 0 })).toMatchObject({ out: 'D:/a/full-20261128', newPass: { dir: 'D:/a/full-20261128' } })
  })

  it("the core grid is the owner's 24 cells on production's own device-store setting; cadence 18, pr 8", () => {
    const core = M.expandCells(M.selection('core'))
    expect(core).toHaveLength(24)
    expect(M.gridCells('cadence')).toHaveLength(18)
    expect(M.gridCells('core,cadence')).toHaveLength(42)
    expect(M.gridCells('pr').map((c: { id: string }) => c.id)).toEqual(['default__D+30m__sp500__next', 'default__D+30m__sp500__jump12', 'default__D+30m__sp500__jump70', 'default__D+30m__sp500__typed', 'default__D+30m__r2000__next', 'default__D+30m__r2000__jump12', 'default__D+30m__r2000__jump70', 'default__D+30m__r2000__typed'])
    expect([...new Set(core.map((c: { layout: string }) => c.layout))]).toEqual(['D+30m', 'D+60m'])
    expect([...new Set(core.map((c: { list: string }) => c.list))]).toEqual(['sp500', 'r2000', 'bullbear'])
    expect([...new Set(core.map((c: { store: string }) => c.store))]).toEqual(['default'])
    expect(M.expandCells(M.selection('full'))).toHaveLength(16 * 7 * 7 * 2)
    // an explicit filter replaces that dimension
    expect(M.expandCells(M.selection('core', { motions: ['next'] }))).toHaveLength(6)
    expect(M.gridCells('core,cadence', { lists: ['sp500'] })).toHaveLength(14)
    // production's own setting: no device-store override is written into the profile
    const a = M.cellArgs(core[0]).args
    expect(a.some((x: string) => x.includes('uct.deviceStore') || x.startsWith('--ls='))).toBe(false)
    expect(() => M.selection('nightly')).toThrow(/unknown grid nightly/)
  })
})
