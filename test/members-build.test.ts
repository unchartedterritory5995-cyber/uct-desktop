import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import { newestTag } from '../scripts/nightly/members-build.mjs'

describe("the members' build the checks measure", () => {
  it('is the highest released version, by number not by text, ignoring stage and other folders', () => {
    expect(newestTag(['v0.1.9', 'v0.1.10', 'v0.1.9-stage', 'v0.1.2', 'notes', 'v1.0'])).toBe('v0.1.10')
    expect(newestTag(['v0.1.9-stage'])).toBeNull()
    expect(newestTag([])).toBeNull()
  })
})
