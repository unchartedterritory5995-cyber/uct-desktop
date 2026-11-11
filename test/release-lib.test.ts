import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script module, no types
import * as R from '../scripts/release-lib.mjs'

const LATEST = [
  'version: 0.1.8',
  'files:',
  '  - url: UCT-Intelligence-Setup-0.1.8.exe',
  '    sha512: abc==',
  '    size: 122722503',
  'path: UCT-Intelligence-Setup-0.1.8.exe',
  'sha512: abc==',
  "releaseDate: '2026-11-11T16:08:00.000Z'",
  '',
].join('\n')

describe('release rules', () => {
  it('reads the feed fields electron-updater uses', () => {
    expect(R.parseLatest(LATEST)).toEqual({ version: '0.1.8', path: 'UCT-Intelligence-Setup-0.1.8.exe', sha512: 'abc==', size: 122722503, stagingPercentage: null })
    expect(R.parseLatest(LATEST.replace(/\n/g, '\r\n')).size).toBe(122722503)
  })

  it('stages a rollout, halts at 0, and 100 means everyone (the line is removed)', () => {
    const ten = R.setStaging(LATEST, 10)
    expect(R.parseLatest(ten).stagingPercentage).toBe(10)
    const halted = R.setStaging(ten, 0)
    expect(R.parseLatest(halted).stagingPercentage).toBe(0)
    expect(halted.match(/stagingPercentage/g)).toHaveLength(1) // replaced, never duplicated
    const all = R.setStaging(halted, 100)
    expect(R.parseLatest(all).stagingPercentage).toBeNull()
    expect(all).not.toMatch(/stagingPercentage/)
    expect(R.parseLatest(all)).toMatchObject({ version: '0.1.8', sha512: 'abc==', size: 122722503 }) // nothing else touched
  })

  it('refuses a stage that is not a whole number 0-100', () => {
    for (const bad of [-1, 101, 10.5, NaN]) expect(() => R.setStaging(LATEST, bad)).toThrow()
  })

  it('orders versions numerically', () => {
    expect(R.compareVersions('0.1.10', '0.1.9')).toBe(1)
    expect(R.compareVersions('0.1.8', '0.1.8')).toBe(0)
    expect(R.compareVersions('0.2.0', '0.10.0')).toBe(-1)
    expect(() => R.compareVersions('0.1', '0.1.0')).toThrow()
  })

  it('finds secrets that must never ship, and passes ordinary code', () => {
    expect(R.findSecrets('const k = "sk-' + 'a'.repeat(30) + '"')).toHaveLength(1)
    expect(R.findSecrets('token: "' + 'A'.repeat(20) + '"')).toHaveLength(1)
    expect(R.findSecrets('-----BEGIN RSA PRIVATE KEY-----')).toHaveLength(1)
    expect(R.findSecrets('const ORIGIN = "https://uctintelligence.com"; let token = null')).toEqual([])
  })

  it('a published feed must match what was built, rollout share included', () => {
    const local = R.parseLatest(R.setStaging(LATEST, 10))
    expect(R.feedMismatches(local, local)).toEqual([])
    expect(R.feedMismatches(local, { ...local, sha512: 'zzz' })).toEqual(['sha512: built abc==, feed zzz'])
    expect(R.feedMismatches(local, { ...local, stagingPercentage: null })).toHaveLength(1)
  })
})
