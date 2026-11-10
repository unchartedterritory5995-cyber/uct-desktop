// Pure logic for the main window's custom title bar: the window's own contents are the bar and the
// site lives in a child view below it. Everything here is Electron-free so it is unit-tested.
import type { Clock } from '../load-guard'
import { isBarSender, type ShellSenderEvent } from '../app-shell'
import type { Rect } from './display'

export const BAR_HEIGHT = 32
export const WINDOW_TITLE = 'UCT Intelligence'
const DEFAULT_BG = '#101012'
const DEFAULT_FG = '#ffffff'
const HEX = /^#[0-9a-f]{6}$/i
const SITE_CLOSE_TIMEOUT_MS = 4000

const size = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)

/** Bar over site. In HTML full screen the site covers the whole window from y=0. */
export function layoutRects(content: { width: number; height: number }, htmlFullScreen: boolean): { bar: Rect; site: Rect } {
  const width = size(content.width)
  const height = size(content.height)
  if (htmlFullScreen) {
    return { bar: { x: 0, y: 0, width, height: 0 }, site: { x: 0, y: 0, width, height } }
  }
  const barHeight = Math.min(BAR_HEIGHT, height)
  return {
    bar: { x: 0, y: 0, width, height: barHeight },
    site: { x: 0, y: barHeight, width, height: height - barHeight },
  }
}

export interface BarState {
  canGoBack: boolean
  bg: string
  fg: string
  title: string
}

/** The only data the bar page ever receives: a boolean, two plain hex colors and a constant. */
export function barState(input: { canGoBack: boolean; bg: string; fg: string }): BarState {
  return {
    canGoBack: input.canGoBack === true,
    bg: HEX.test(input.bg) ? input.bg : DEFAULT_BG,
    fg: HEX.test(input.fg) ? input.fg : DEFAULT_FG,
    title: WINDOW_TITLE,
  }
}

export function barScript(state: BarState): string {
  return `window.__uctBar && window.__uctBar(${JSON.stringify(state)})`
}

/** page-title-updated on a popped window: the title stays plain, and so does the taskbar. */
export function forceTitle(event: { preventDefault(): void }, win: { setTitle(title: string): void }): void {
  event.preventDefault()
  win.setTitle(WINDOW_TITLE)
}

export interface BackDeps {
  barId(): number
  canGoBack(): boolean
  goBack(): void
}

/** `back` is honoured only from the bar's own contents, top frame, on bar.html. It takes no argument. */
export function makeBackHandler(deps: BackDeps): (event: { sender: { id: number } } & ShellSenderEvent) => void {
  return (event) => {
    if (event.sender.id !== deps.barId() || !isBarSender(event)) return
    if (deps.canGoBack()) deps.goBack()
  }
}

export interface FullScreenDeps {
  isWindowFullScreen(): boolean
  setWindowFullScreen(flag: boolean): void
  relayout(): void
}

/** HTML full screen from the site: window full screen, bar hidden, then put back as it was. */
export function createFullScreenController(deps: FullScreenDeps): { enter(): void; leave(): void; isHtml(): boolean } {
  let html = false
  let weSetIt = false
  return {
    enter() {
      html = true
      if (!deps.isWindowFullScreen()) {
        deps.setWindowFullScreen(true)
        weSetIt = true
      }
      deps.relayout()
    },
    leave() {
      html = false
      if (weSetIt) {
        weSetIt = false
        deps.setWindowFullScreen(false)
      }
      deps.relayout()
    },
    isHtml: () => html,
  }
}

export interface SiteCloserDeps {
  clock: Clock
  /** Close the site contents; with `true` it fires beforeunload first and the page may object. */
  closeSite(waitForBeforeUnload: boolean): void
  closeWindow(): void
  timeoutMs?: number
}

/**
 * The site is a child view, which window close does not unload. Closing it explicitly first makes
 * its beforeunload and pagehide run, which the website's records depend on.
 */
export function createSiteCloser(deps: SiteCloserDeps): {
  begin(): void
  promptShown(): void
  reset(): void
  onSiteDestroyed(): void
  isDone(): boolean
} {
  let closing = false
  let done = false
  let timer: unknown
  let hasTimer = false
  const clear = (): void => {
    if (hasTimer) deps.clock.clearTimeout(timer)
    hasTimer = false
  }
  return {
    begin() {
      if (done) return deps.closeWindow()
      if (closing) return
      closing = true
      deps.closeSite(true)
      hasTimer = true
      timer = deps.clock.setTimeout(() => {
        hasTimer = false
        done = true
        deps.closeSite(false) // the page never let go: destroy it so it cannot leak
        deps.closeWindow()
      }, deps.timeoutMs ?? SITE_CLOSE_TIMEOUT_MS)
    },
    promptShown: clear, // a Leave or Stay dialog is up: do not force under the member's hands
    reset() {
      clear()
      closing = false
    },
    onSiteDestroyed() {
      clear()
      const wasClosing = closing
      done = true
      if (wasClosing) deps.closeWindow()
    },
    isDone: () => done,
  }
}
