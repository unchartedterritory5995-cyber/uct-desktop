import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { ORIGIN, PARTITION } from '../config'
import { APP_SHELL_ORIGIN, isShellSender } from '../app-shell'
import { createLoadGuard, type LoadGuard } from '../load-guard'
import { CHANNELS, type WindowState } from '../../shared/contract'

export function showErrorPage(win: BrowserWindow, kind: 'origin-error' | 'network-error'): void {
  if (win.isDestroyed()) return
  // Show the window first: a failed load never reaches ready-to-show, and an offline start must
  // not be an invisible process holding the single-instance lock.
  if (!win.isVisible()) win.show()
  void win.loadURL(`${APP_SHELL_ORIGIN}/error.html?k=${kind}`).catch(() => undefined)
}

function windowState(win: BrowserWindow): WindowState {
  if (win.isFullScreen()) return 'fullscreen'
  if (win.isMinimized()) return 'minimized'
  if (win.isMaximized()) return 'maximized'
  return 'normal'
}

export interface MainWindow {
  win: BrowserWindow
  guard: LoadGuard
}

export function createMainWindow(): MainWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // The bridge preload belongs to the main window only; popups never rely on it.
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--uct-origin=${ORIGIN}`],
    },
  })
  win.once('ready-to-show', () => win.show())

  const guard = createLoadGuard({
    appOrigin: ORIGIN,
    clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
    load: () => {
      if (!win.isDestroyed()) void win.loadURL(ORIGIN).catch(() => undefined)
    },
    showError: (kind) => showErrorPage(win, kind),
    showApp: () => undefined, // the next successful navigation has already replaced the error page
  })
  const wc = win.webContents
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame) guard.onFailLoad(url, code)
  })
  wc.on('did-frame-navigate', (_e, url, httpResponseCode, _text, isMainFrame) => {
    if (isMainFrame) guard.onNavigated(url, httpResponseCode)
  })
  // `retry` is callable only from the error page, through its own sender check.
  const onRetry = (event: { sender: unknown; senderFrame: Parameters<typeof isShellSender>[0]['senderFrame'] }): void => {
    if (event.sender !== wc || !isShellSender(event)) return
    guard.retry()
  }
  ipcMain.on(CHANNELS.retry, onRetry)

  const sendState = (): void => {
    if (!win.isDestroyed()) wc.send(CHANNELS.windowState, windowState(win))
  }
  for (const e of ['maximize', 'unmaximize', 'minimize', 'restore', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(e as 'maximize', sendState)
  }
  win.on('closed', () => {
    guard.dispose()
    ipcMain.removeListener(CHANNELS.retry, onRetry)
  })

  guard.start()
  return { win, guard }
}
