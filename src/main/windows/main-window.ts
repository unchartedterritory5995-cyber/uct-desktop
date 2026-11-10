import { BrowserWindow, ipcMain, WebContentsView, type WebContents } from 'electron'
import { join } from 'node:path'
import { ORIGIN, PARTITION } from '../config'
import { APP_SHELL_ORIGIN, isShellSender } from '../app-shell'
import { createLoadGuard, type LoadGuard } from '../load-guard'
import { CHANNELS, type WindowState } from '../../shared/contract'
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
} from './chrome'
import { colorrefToCss } from './titlebar-color'
import { currentCaptionColors, onThemeChange } from './titlebar'
import { headerValue, makeRetryHandler, wireLoadEvents } from './wiring'

export type ErrorKind = 'origin-error' | 'network-error' | 'crash' | 'reset'

function windowState(win: BrowserWindow): WindowState {
  if (!win.isVisible()) return 'hidden' // in the tray: the website goes idle
  if (win.isFullScreen()) return 'fullscreen'
  if (win.isMinimized()) return 'minimized'
  if (win.isMaximized()) return 'maximized'
  return 'normal'
}

export interface MainWindow {
  win: BrowserWindow
  /** The website's contents (a child view). Everything that used to hang off the window hangs off this. */
  site: WebContents
  /** The window's own contents: the 32 px title bar page. */
  bar: WebContents
  guard: LoadGuard
  /** Close the site first so its beforeunload and pagehide run, then the window. */
  closer: ReturnType<typeof createSiteCloser>
  showError(kind: ErrorKind): Promise<void>
}

export interface MainWindowOptions {
  /** True while the app should stay in the tray (started with Windows, or closed to the tray). */
  stayHidden?: () => boolean
}

export function createMainWindow(options: MainWindowOptions = {}): MainWindow {
  const stayHidden = options.stayHidden ?? (() => false)
  const start = currentCaptionColors()
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0c',
    title: WINDOW_TITLE,
    titleBarStyle: 'hidden',
    titleBarOverlay: { height: BAR_HEIGHT, color: colorrefToCss(start.caption), symbolColor: colorrefToCss(start.text) },
    // The window's own contents are only the title bar page: no website, no bridge.
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/bar.js'),
    },
  })
  const bar = win.webContents

  // The site: same security posture and bridge preload the main window always had.
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--uct-origin=${ORIGIN}`],
    },
  })
  view.setBackgroundColor('#0a0a0c')
  win.contentView.addChildView(view)
  const site = view.webContents

  // ---- layout ----
  const fullScreen = createFullScreenController({
    isWindowFullScreen: () => win.isFullScreen(),
    setWindowFullScreen: (flag) => win.setFullScreen(flag),
    relayout: () => relayout(),
  })
  function relayout(): void {
    if (win.isDestroyed()) return
    const [width, height] = win.getContentSize()
    view.setBounds(layoutRects({ width, height }, fullScreen.isHtml()).site)
  }
  relayout()
  for (const e of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'] as const) {
    win.on(e as 'resize', relayout)
  }
  site.on('enter-html-full-screen', () => fullScreen.enter())
  site.on('leave-html-full-screen', () => fullScreen.leave())

  // ---- title bar page ----
  void bar.loadURL(`${APP_SHELL_ORIGIN}/bar.html`).catch(() => undefined)
  const pushBar = (): void => {
    if (bar.isDestroyed() || site.isDestroyed() || bar.isLoading()) return
    const colors = currentCaptionColors()
    const state = barState({
      canGoBack: site.navigationHistory.canGoBack(),
      bg: colorrefToCss(colors.caption),
      fg: colorrefToCss(colors.text),
    })
    void bar.executeJavaScript(barScript(state)).catch(() => undefined)
  }
  bar.on('did-finish-load', pushBar)
  bar.on('page-title-updated', (event) => forceTitle(event, win))
  site.on('did-navigate', pushBar)
  site.on('did-navigate-in-page', pushBar)
  site.on('did-finish-load', pushBar)
  const offTheme = onThemeChange((colors) => {
    if (!win.isDestroyed()) {
      win.setTitleBarOverlay({ height: BAR_HEIGHT, color: colorrefToCss(colors.caption), symbolColor: colorrefToCss(colors.text) })
    }
    pushBar()
  })
  const onBack = makeBackHandler({
    barId: () => bar.id,
    canGoBack: () => site.navigationHistory.canGoBack(),
    goBack: () => site.navigationHistory.goBack(),
  })
  ipcMain.on(CHANNELS.barBack, onBack)

  // ---- focus: typing goes to the site ----
  const focusSite = (): void => {
    if (!site.isDestroyed()) site.focus()
  }
  site.on('did-finish-load', focusSite)
  win.on('focus', focusSite)
  win.once('ready-to-show', () => {
    if (stayHidden()) return // started in the tray: the page loads now, the window shows on open
    win.show()
    focusSite()
  })

  // ---- error page, load guard (all on the SITE contents) ----
  const showError = (kind: ErrorKind): Promise<void> => {
    if (win.isDestroyed() || site.isDestroyed()) return Promise.resolve()
    // Show the window first: an offline start must not be an invisible process holding the lock.
    // In the tray, the error page waits behind the hidden window instead (a login start before the
    // network is up must not pop a window); the tray icon still offers Open.
    if (!win.isVisible() && !stayHidden()) win.show()
    return site.loadURL(`${APP_SHELL_ORIGIN}/error.html?k=${kind}`).catch(() => undefined)
  }
  const guard = createLoadGuard({
    appOrigin: ORIGIN,
    clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    load: (url) => {
      if (!site.isDestroyed()) void site.loadURL(url).catch(() => undefined)
    },
    showError: (kind) => void showError(kind),
    showApp: () => undefined, // the next successful navigation has already replaced the error page
  })
  // Cloudflare marks an interactive challenge with `cf-mitigated: challenge`; remember it per URL.
  const challenges = new Map<string, string>()
  site.session.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === 'mainFrame' && details.webContentsId === site.id) {
      const v = headerValue(details.responseHeaders, 'cf-mitigated')
      if (v) challenges.set(details.url, v)
      else challenges.delete(details.url)
    }
    callback({})
  })
  wireLoadEvents(site, guard, (url) => challenges.get(url))
  // `retry` is callable only from the error page shown in the site view, through its own sender check.
  const onRetry = makeRetryHandler(site, guard, isShellSender)
  ipcMain.on(CHANNELS.retry, onRetry)

  const sendState = (): void => {
    if (!win.isDestroyed() && !site.isDestroyed()) site.send(CHANNELS.windowState, windowState(win))
  }
  for (const e of ['maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen', 'hide', 'show'] as const) {
    win.on(e as 'maximize', sendState)
  }

  // ---- closing: the site view is not unloaded by closing the window, so do it explicitly ----
  const closer = createSiteCloser({
    clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    closeSite: (waitForBeforeUnload) => {
      if (!site.isDestroyed()) site.close({ waitForBeforeUnload })
    },
    closeWindow: () => {
      if (!win.isDestroyed()) win.close()
    },
  })
  site.once('destroyed', () => closer.onSiteDestroyed())
  win.on('closed', () => {
    guard.dispose()
    offTheme()
    ipcMain.removeListener(CHANNELS.retry, onRetry)
    ipcMain.removeListener(CHANNELS.barBack, onBack)
    if (!site.isDestroyed()) site.close() // never leak the view past its window
  })

  guard.start()
  return { win, site, bar, guard, closer, showError }
}
