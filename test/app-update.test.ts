import { describe, expect, it } from 'vitest'
import { createAppUpdateHub } from '../src/main/app-update'
import { toAppUpdate } from '../src/preload/bridge'

function hub() {
  const sent: unknown[] = []
  const reports: unknown[][] = []
  const h = createAppUpdateHub({ broadcast: (u) => sent.push(u), report: (...a) => reports.push(a) })
  return { h, sent, reports }
}

describe('app-update hub', () => {
  it('a downloaded update is offered to every page, reported once', () => {
    const { h, sent, reports } = hub()
    expect(h.get()).toBeNull()
    h.onState({ kind: 'downloaded', version: '0.1.7' })
    h.onState({ kind: 'downloaded', version: '0.1.7' }) // the same download again: no second toast or event
    expect(h.get()).toEqual({ version: '0.1.7' })
    expect(sent).toEqual([{ version: '0.1.7' }])
    expect(reports).toEqual([['update_downloaded']])
  })

  it('a newer download replaces the offer', () => {
    const { h, sent } = hub()
    h.onState({ kind: 'downloaded', version: '0.1.7' })
    h.onState({ kind: 'downloaded', version: '0.1.8' })
    expect(h.get()).toEqual({ version: '0.1.8' })
    expect(sent).toEqual([{ version: '0.1.7' }, { version: '0.1.8' }])
  })

  it('a withdrawn version disappears from every page and cancels a requested restart', () => {
    const { h, sent } = hub()
    h.onState({ kind: 'downloaded', version: '0.1.7' })
    expect(h.requestRestart()).toBe(true)
    h.onState({ kind: 'withdrawn', version: '0.1.7' })
    expect(h.get()).toBeNull()
    expect(sent.at(-1)).toBeNull()
    expect(h.restartRequested()).toBe(false)
    // A later download must not inherit the restart the member asked for on the pulled version.
    h.onState({ kind: 'downloaded', version: '0.1.8' })
    expect(h.restartRequested()).toBe(false)
  })

  it('restart is refused with nothing downloaded, and remembered once asked', () => {
    const { h } = hub()
    expect(h.requestRestart()).toBe(false)
    expect(h.restartRequested()).toBe(false)
    h.onState({ kind: 'downloaded', version: '0.1.7' })
    expect(h.restartRequested()).toBe(false) // never without the member asking
    expect(h.requestRestart()).toBe(true)
    expect(h.restartRequested()).toBe(true)
  })

  it('Windows ending the session cancels a requested restart: no installer during a shutdown', () => {
    const { h } = hub()
    h.onState({ kind: 'downloaded', version: '0.1.7' })
    h.requestRestart()
    expect(h.restartRequested()).toBe(true)
    h.sessionEnding()
    expect(h.restartRequested()).toBe(false)
    expect(h.get()).toEqual({ version: '0.1.7' }) // still offered next run
  })

  it('repeated failures are reported with their class and offer nothing', () => {
    const { h, sent, reports } = hub()
    h.onState({ kind: 'failed-repeatedly', errorClass: 'network', downloadUrl: 'x' })
    expect(reports).toEqual([['update_error', 'network']])
    expect(sent).toEqual([])
  })
})

describe('toAppUpdate (what may reach the page)', () => {
  it('passes only { version: X.Y.Z }', () => {
    expect(toAppUpdate({ version: '0.1.7', path: 'C:/x.exe' })).toEqual({ version: '0.1.7' })
    expect(toAppUpdate(null)).toBeNull()
    expect(toAppUpdate({ version: '0.1.7<script>' })).toBeNull()
    expect(toAppUpdate({ version: 7 })).toBeNull()
    expect(toAppUpdate('0.1.7')).toBeNull()
  })
})
