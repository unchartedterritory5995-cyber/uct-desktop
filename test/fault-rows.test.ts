import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import { parseRows } from '../scripts/nightly/fault-rows.mjs'

describe('weekly fault check: collecting proof rows', () => {
  it('reads PASS and FAIL rows, ignores everything else, and tolerates Windows line endings', () => {
    const out = 'sign-in status 200\r\nPASS F-gpu: killed GPU process 1: 299 frames\r\nFAIL R-fast: streams back after 31 s\nALL PASS\n  PASS indented: not a row\n'
    expect(parseRows(out)).toEqual([
      { id: 'F-gpu', pass: true, detail: 'killed GPU process 1: 299 frames' },
      { id: 'R-fast', pass: false, detail: 'streams back after 31 s' },
    ])
  })
  it('a proof that printed nothing has no rows (the runner counts it as blind, never as a pass)', () => {
    expect(parseRows('')).toEqual([])
    expect(parseRows(undefined)).toEqual([])
  })
})
