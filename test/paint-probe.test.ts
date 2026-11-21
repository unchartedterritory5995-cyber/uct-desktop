import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'

// paint-probe.js runs in the page; here it runs in a bare vm context with just enough of a browser: rAF, a canvas
// context whose draws land in a flip-chart widget, performance, MessageChannel and (optionally) scheduler.postTask.
// Tasks are queued, not run, so each test decides what has run when.
const SRC = readFileSync(join(__dirname, '..', 'scripts', 'proofs', 'paint-probe.js'), 'utf8')

function page({ postTask = true } = {}) {
  let now = 100
  const raf: ((t: number) => void)[] = []
  const posted: { fn: () => void; priority: string }[] = []
  const messages: (() => void)[] = []
  const marks: string[] = []
  class Ctx { canvas = { closest: () => ({ getAttribute: () => 'flip-chart' }) } }
  for (const m of ['clearRect', 'fillRect', 'strokeRect', 'fill', 'stroke', 'drawImage', 'fillText', 'putImageData']) (Ctx.prototype as any)[m] = function () {}
  class MessageChannel {
    port1: { onmessage: null | (() => void); close: () => void } = { onmessage: null, close: () => {} }
    port2 = { postMessage: () => { messages.push(() => this.port1.onmessage && this.port1.onmessage()) } }
  }
  const win: any = {
    requestAnimationFrame: (cb: (t: number) => void) => { raf.push(cb); return raf.length },
    CanvasRenderingContext2D: Ctx,
    performance: { now: () => now, mark: (n: string) => { marks.push(n) } },
    MessageChannel,
    __uctChartDebug: { 'flip-chart': { newestBar: () => ({ time: '2026-11-21', close: 2 }) } },
  }
  if (postTask) win.scheduler = { postTask: (fn: () => void, o: { priority: string }) => { posted.push({ fn, priority: o.priority }); return Promise.resolve() } }
  win.window = win
  win.top = win
  vm.createContext(win)
  vm.runInContext(`var window = this; var performance = this.performance; var MessageChannel = this.MessageChannel; var CanvasRenderingContext2D = this.CanvasRenderingContext2D;\n${SRC}`, win)
  const P = win.__paintProbe
  /** one frame in which the chart draws (the library's paint callback) */
  const frame = (t: number) => {
    win.requestAnimationFrame(() => { now = t + 4; new Ctx().fillRect() })
    const cbs = raf.splice(0)
    for (const cb of cbs) cb(t)
  }
  const at = (t: number) => { now = t }
  return { win, P, frame, at, posted, messages, marks }
}

describe('the frame-complete stamp task', () => {
  it('is a user-blocking scheduler.postTask task posted after the draws; the stamp is when it runs', () => {
    const pg = page()
    expect(pg.P.stampVia).toBe('postTask:user-blocking')
    pg.frame(1000)
    const p = pg.P.paints[0]
    expect(p).toMatchObject({ w: 'flip-chart', end: 1004, complete: null })
    expect(pg.posted.map((x) => x.priority)).toEqual(['user-blocking'])
    expect(pg.messages).toHaveLength(0) // untraced: no second stamp, no extra task
    pg.at(1009)
    pg.posted[0].fn()
    expect(p.complete).toBe(1009)
    expect(p.completeMc).toBeUndefined()
  })

  it('on traced flips the old MessageChannel stamp is recorded beside it, with its own mark', () => {
    const pg = page()
    pg.P.marks = true
    pg.frame(1000)
    expect(pg.posted).toHaveLength(1)
    expect(pg.messages).toHaveLength(1)
    pg.at(1006); pg.posted[0].fn()
    pg.at(1030); pg.messages[0]()
    expect(pg.P.paints[0]).toMatchObject({ complete: 1006, completeMc: 1030 })
    expect(pg.marks).toEqual(['__lwcPaint:flip-chart', '__frameDone:flip-chart', '__frameDoneMc:flip-chart'])
  })

  it('without scheduler.postTask it falls back to a MessageChannel message and says so', () => {
    const pg = page({ postTask: false })
    expect(pg.P.stampVia).toBe('MessageChannel')
    pg.P.marks = true
    pg.frame(1000)
    expect(pg.messages).toHaveLength(1) // the stamp itself, no duplicate
    pg.at(1012); pg.messages[0]()
    expect(pg.P.paints[0]).toMatchObject({ complete: 1012 })
    expect(pg.P.paints[0].completeMc).toBeUndefined()
  })

  it('--provoke-gc queues ONE default-priority full GC behind the first new-symbol paint, ahead of nothing else', () => {
    const pg = page()
    let gcs = 0
    pg.win.gc = () => { gcs++ }
    pg.P.provoke = 'gc'
    pg.frame(900) // no switch armed: not the first new paint, nothing provoked
    expect(pg.messages).toHaveLength(0)
    pg.P.armed = { need: { 'flip-chart': { time: '2026-11-21', close: 1 } }, found: {}, key: () => 950 }
    pg.frame(1000)
    expect(pg.P.paints[1].first).toBe(true)
    expect(pg.messages).toHaveLength(1) // the GC task; the stamp is the user-blocking task
    expect(pg.P.provoke).toBeNull() // one-shot
    pg.messages[0]()
    expect(gcs).toBe(1)
    expect(pg.P.provoked).toHaveLength(1)
  })
})
