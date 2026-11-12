import { describe, expect, it } from 'vitest'
import { createLaunchTiming, FLUSH_AFTER_MS } from '../src/main/launch-timing'

function harness() {
  let t = 0
  const timers: { fn: () => void; at: number; live: boolean }[] = []
  const written: Record<string, number | boolean>[] = []
  const timing = createLaunchTiming({
    now: () => t,
    record: (f) => written.push(f),
    clock: {
      setTimeout: (fn, ms) => {
        const h = { fn, at: t + ms, live: true }
        timers.push(h)
        return h
      },
      clearTimeout: (h) => {
        ;(h as { live: boolean }).live = false
      },
    },
  })
  const advance = (ms: number) => {
    t += ms
    for (const h of timers) if (h.live && h.at <= t) { h.live = false; h.fn() }
  }
  return { timing, written, advance, at: (ms: number) => { t = ms } }
}

describe('launch timing', () => {
  it('writes every phase once, in ms from process start, when the website has loaded', () => {
    const h = harness()
    h.at(212.4); h.timing.mark('ready')
    h.at(260); h.timing.mark('window')
    h.at(271); h.timing.mark('loading')
    h.at(330); h.timing.mark('shown')
    h.at(640); h.timing.mark('domReady')
    expect(h.written).toEqual([])
    h.at(905); h.timing.mark('loaded')
    expect(h.written).toEqual([{ ready: 212, window: 260, loading: 271, shown: 330, domReady: 640, loaded: 905, complete: true }])
  })

  it('a reload or second navigation never moves a phase, and nothing is written twice', () => {
    const h = harness()
    h.at(100); h.timing.mark('domReady')
    h.at(900); h.timing.mark('domReady')
    h.timing.mark('loaded')
    h.at(5000); h.timing.mark('loaded')
    h.advance(FLUSH_AFTER_MS)
    expect(h.written).toEqual([{ domReady: 100, loaded: 900, complete: true }])
  })

  it('a launch that never loads the website (offline, started in the tray) still leaves what it reached', () => {
    const h = harness()
    h.at(200); h.timing.mark('ready')
    h.at(250); h.timing.mark('window')
    h.advance(FLUSH_AFTER_MS - 251)
    expect(h.written).toEqual([])
    h.advance(1)
    expect(h.written).toEqual([{ ready: 200, window: 250, complete: false }])
    h.timing.mark('loaded')
    expect(h.written).toHaveLength(1)
  })
})
