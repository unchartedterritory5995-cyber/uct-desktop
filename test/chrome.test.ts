import { describe, expect, it } from 'vitest'
import {
  BAR_HEIGHT,
  barScript,
  barState,
  createFullScreenController,
  createSiteCloser,
  forceTitle,
  layoutRects,
  makeBackHandler,
  WINDOW_TITLE,
} from '../src/main/windows/chrome'
import { APP_SHELL_ORIGIN, isBarSender, resolveShellFile, SHELL_FILES } from '../src/main/app-shell'
import { colorrefToCss, captionColors } from '../src/main/windows/titlebar-color'
import type { Clock } from '../src/main/load-guard'

describe('layoutRects', () => {
  it('puts a 32 px bar over the site, which fills the rest', () => {
    expect(BAR_HEIGHT).toBe(32)
    expect(layoutRects({ width: 1500, height: 950 }, false)).toEqual({
      bar: { x: 0, y: 0, width: 1500, height: 32 },
      site: { x: 0, y: 32, width: 1500, height: 918 },
    })
  })
  it('HTML full screen hides the bar: the site fills the window from y=0', () => {
    expect(layoutRects({ width: 1920, height: 1080 }, true).site).toEqual({ x: 0, y: 0, width: 1920, height: 1080 })
  })
  it('never produces a negative size, even for a tiny or odd window', () => {
    const r = layoutRects({ width: -5, height: 10 }, false)
    expect(r.site.height).toBe(0)
    expect(r.site.width).toBe(0)
    expect(r.bar.height).toBeLessThanOrEqual(10)
    expect(layoutRects({ width: NaN, height: 100 }, false).site.width).toBe(0)
  })
})

describe('bar state', () => {
  it('has a fixed shape with a constant title and a strict boolean', () => {
    const s = barState({ canGoBack: true, bg: '#101012', fg: '#ffffff' })
    expect(Object.keys(s).sort()).toEqual(['bg', 'canGoBack', 'fg', 'title'])
    expect(s.title).toBe('UCT Intelligence')
    expect(barState({ canGoBack: 'yes' as never, bg: '#101012', fg: '#ffffff' }).canGoBack).toBe(false)
  })
  it('refuses anything that is not a plain hex color', () => {
    const s = barState({ canGoBack: false, bg: '#fff;}</style><script>x()</script>', fg: 'url(javascript:1)' })
    expect(s.bg).toBe('#101012')
    expect(s.fg).toBe('#ffffff')
  })
  it('is pushed as JSON.stringify of that shape, never as markup', () => {
    const script = barScript(barState({ canGoBack: true, bg: '#101012', fg: '#ffffff' }))
    expect(script).toBe('window.__uctBar && window.__uctBar({"canGoBack":true,"bg":"#101012","fg":"#ffffff","title":"UCT Intelligence"})')
  })
})

describe('colors', () => {
  it('turns a COLORREF into a CSS hex color', () => {
    expect(colorrefToCss(0x00ffffff)).toBe('#ffffff')
    expect(colorrefToCss(0x00000000)).toBe('#000000')
    expect(colorrefToCss(captionColors({ r: 16, g: 16, b: 18 }).caption)).toBe('#101012')
    expect(colorrefToCss(captionColors({ r: 255, g: 128, b: 1 }).caption)).toBe('#ff8001')
  })
})

describe('title forcing', () => {
  it('keeps every popped window titled plainly', () => {
    const calls: string[] = []
    let prevented = false
    forceTitle({ preventDefault: () => void (prevented = true) }, { setTitle: (t) => void calls.push(t) })
    expect(prevented).toBe(true)
    expect(calls).toEqual([WINDOW_TITLE])
    expect(WINDOW_TITLE).toBe('UCT Intelligence')
  })
})

describe('the bar page and its back button', () => {
  it('is served by name from the static map', () => {
    expect(resolveShellFile(`${APP_SHELL_ORIGIN}/bar.html`)).toBe(SHELL_FILES['bar.html'])
    expect(resolveShellFile(`${APP_SHELL_ORIGIN}/bar.js`)).toBe(SHELL_FILES['bar.js'])
    expect(resolveShellFile(`${APP_SHELL_ORIGIN}/bar.html/../x`)).toBeNull()
  })
  const f = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } })
  it('recognises only the top frame of bar.html', () => {
    expect(isBarSender(f(`${APP_SHELL_ORIGIN}/bar.html`))).toBe(true)
    expect(isBarSender(f(`${APP_SHELL_ORIGIN}/bar.html`, {}))).toBe(false)
    expect(isBarSender(f(`${APP_SHELL_ORIGIN}/error.html`))).toBe(false)
    expect(isBarSender(f('https://uctintelligence.com/'))).toBe(false)
    expect(isBarSender({ senderFrame: null })).toBe(false)
  })
  it('goes back only for the bar contents, top frame, bar URL, with history to go back to', () => {
    let backs = 0
    let can = true
    const handle = makeBackHandler({ barId: () => 7, canGoBack: () => can, goBack: () => void backs++ })
    handle({ sender: { id: 8 }, ...f(`${APP_SHELL_ORIGIN}/bar.html`) }) // another contents
    handle({ sender: { id: 7 }, ...f('https://uctintelligence.com/') }) // the site pretending
    handle({ sender: { id: 7 }, ...f(`${APP_SHELL_ORIGIN}/bar.html`, {}) }) // a subframe
    handle({ sender: { id: 7 }, ...f(`${APP_SHELL_ORIGIN}/error.html`) })
    expect(backs).toBe(0)
    can = false
    handle({ sender: { id: 7 }, ...f(`${APP_SHELL_ORIGIN}/bar.html`) })
    expect(backs).toBe(0)
    can = true
    handle({ sender: { id: 7 }, ...f(`${APP_SHELL_ORIGIN}/bar.html`) })
    expect(backs).toBe(1)
  })
})

describe('HTML full screen', () => {
  function make(initialFull = false) {
    const log: string[] = []
    let full = initialFull
    const c = createFullScreenController({
      isWindowFullScreen: () => full,
      setWindowFullScreen: (b) => (full = b, void log.push(`full:${b}`)),
      relayout: () => void log.push('layout'),
    })
    return { c, log }
  }
  it('enters window full screen, hides the bar, and restores afterwards', () => {
    const { c, log } = make()
    c.enter()
    expect(c.isHtml()).toBe(true)
    expect(log).toEqual(['full:true', 'layout'])
    c.leave()
    expect(c.isHtml()).toBe(false)
    expect(log).toEqual(['full:true', 'layout', 'full:false', 'layout'])
  })
  it('leaves a member-initiated full screen alone', () => {
    const { c, log } = make(true)
    c.enter()
    c.leave()
    expect(log).toEqual(['layout', 'layout'])
  })
})

describe('closing the site view so its unload handlers run', () => {
  function make() {
    let t = 0
    let id = 0
    const timers = new Map<number, { at: number; fn: () => void }>()
    const clock: Clock = {
      setTimeout: (fn, ms) => (timers.set(++id, { at: t + ms, fn }), id),
      clearTimeout: (h) => void timers.delete(h as number),
    }
    const advance = (ms: number) => {
      t += ms
      for (const [k, x] of [...timers]) if (x.at <= t) (timers.delete(k), x.fn())
    }
    const log: string[] = []
    const closer = createSiteCloser({
      clock,
      closeSite: (wait) => void log.push(`site:${wait}`),
      closeWindow: () => void log.push('window'),
    })
    return { closer, log, advance }
  }
  it('closes the site first (waiting for beforeunload) and the window only once it is gone', () => {
    const { closer, log } = make()
    closer.begin()
    closer.begin()
    expect(log).toEqual(['site:true'])
    closer.onSiteDestroyed()
    expect(log).toEqual(['site:true', 'window'])
    expect(closer.isDone()).toBe(true)
    closer.begin()
    expect(log).toEqual(['site:true', 'window', 'window'])
  })
  it('forces the close if the page never lets go', () => {
    const { closer, log, advance } = make()
    closer.begin()
    advance(3999)
    expect(log).toEqual(['site:true'])
    advance(1)
    expect(log).toEqual(['site:true', 'site:false', 'window'])
  })
  it('does not force while a Leave or Stay prompt is showing, and Stay allows a later close', () => {
    const { closer, log, advance } = make()
    closer.begin()
    closer.promptShown()
    advance(60_000)
    expect(log).toEqual(['site:true'])
    closer.reset() // the member chose Stay
    closer.begin()
    expect(log).toEqual(['site:true', 'site:true'])
  })
  it('a site that dies on its own marks it done without closing the window', () => {
    const { closer, log } = make()
    closer.onSiteDestroyed()
    expect(closer.isDone()).toBe(true)
    expect(log).toEqual([])
  })
})
