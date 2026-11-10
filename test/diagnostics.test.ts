import { describe, expect, it } from 'vitest'
import { buildDiagnostics } from '../src/main/diagnostics'

const base = {
  appVersion: '0.1.3',
  versions: { electron: '45.2.3', chrome: '144', node: '24' },
  platform: 'win32 x64',
  metrics: [],
  cacheBytes: 0,
}

describe('buildDiagnostics', () => {
  it('appends recent events, scrubbed', () => {
    const out = buildDiagnostics({ ...base, events: ['{"event":"load-failed","who":"a@b.com"}'] })
    expect(out).toContain('Recent events:')
    expect(out).toContain('load-failed')
    expect(out).not.toContain('a@b.com')
  })

  it('omits the section when there are no events', () => {
    expect(buildDiagnostics(base)).not.toContain('Recent events:')
    expect(buildDiagnostics({ ...base, events: [] })).not.toContain('Recent events:')
  })
})
