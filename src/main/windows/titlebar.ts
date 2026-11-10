import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron'
import { ORIGIN } from '../config'
import { captionColors, parseCssColor, type CaptionColors } from './titlebar-color'

const DWMWA_BORDER_COLOR = 34
const DWMWA_CAPTION_COLOR = 35
const DWMWA_TEXT_COLOR = 36
const COLORREF_BYTES = 4
const POLL_MS = 1000
const START_COLOR = captionColors({ r: 16, g: 16, b: 18 })

// The site's background, whichever theme the member picked.
const READ_THEME = `(() => {
  for (const el of [document.body, document.documentElement]) {
    if (!el) continue
    const color = getComputedStyle(el).backgroundColor
    if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') return color
  }
  return getComputedStyle(document.documentElement).getPropertyValue('--bg')
})()`

type SetAttribute = (hwnd: bigint, attribute: number, value: number[], size: number) => number

// Only Windows 11 honors a caption color. Anywhere the call is missing, the dark or light native
// bar still applies, so a failure here must never stop the app.
function loadSetAttribute(): SetAttribute | null {
  try {
    const koffi = require('koffi') as typeof import('koffi')
    return koffi
      .load('dwmapi.dll')
      .func('long __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32_t attribute, _In_ uint32_t *value, uint32_t size)') as SetAttribute
  } catch {
    return null
  }
}

let setAttribute: SetAttribute | null | undefined
let current: CaptionColors = START_COLOR
const listeners = new Set<(colors: CaptionColors) => void>()

/** The colors the title bars currently wear. */
export function currentCaptionColors(): CaptionColors {
  return current
}

/** Called whenever the site's theme changes the bar colors. Returns an unsubscribe. */
export function onThemeChange(listener: (colors: CaptionColors) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

function paint(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (setAttribute === undefined) setAttribute = loadSetAttribute()
  if (!setAttribute) return
  const hwnd = win.getNativeWindowHandle().readBigUInt64LE(0)
  setAttribute(hwnd, DWMWA_CAPTION_COLOR, [current.caption], COLORREF_BYTES)
  setAttribute(hwnd, DWMWA_BORDER_COLOR, [current.caption], COLORREF_BYTES)
  setAttribute(hwnd, DWMWA_TEXT_COLOR, [current.text], COLORREF_BYTES)
}

function apply(next: CaptionColors): void {
  current = next
  nativeTheme.themeSource = next.dark ? 'dark' : 'light'
  BrowserWindow.getAllWindows().forEach(paint)
  listeners.forEach((listener) => listener(next))
}

/** Every window, popped-out ones included, gets the current colors as soon as it exists. */
export function installThemedTitleBars(): void {
  nativeTheme.themeSource = current.dark ? 'dark' : 'light'
  app.on('browser-window-created', (_event, win) => paint(win))
}

/** Keeps the title bars matched to the theme showing in these contents. */
export function followSiteTheme(site: WebContents): void {
  let last = ''
  const read = async (): Promise<void> => {
    if (site.isDestroyed() || !site.getURL().startsWith(ORIGIN)) return
    const value: unknown = await site.executeJavaScript(READ_THEME).catch(() => null)
    const rgb = parseCssColor(value)
    if (!rgb || value === last) return
    last = String(value)
    apply(captionColors(rgb))
  }
  const timer = setInterval(() => void read(), POLL_MS)
  site.once('destroyed', () => clearInterval(timer))
  site.on('did-finish-load', () => void read())
}
