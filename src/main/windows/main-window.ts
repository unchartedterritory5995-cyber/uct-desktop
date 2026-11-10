import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { ORIGIN, PARTITION } from '../config'

const ERR_ABORTED = -3
const RETRY_MS = 10000

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    webPreferences: {
      partition: PARTITION,
      // The bridge preload belongs to the main window only; popups never rely on it.
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--uct-origin=${ORIGIN}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  // A failed load never reaches ready-to-show. Show the window anyway and keep trying, so an
  // offline start is not an invisible process holding the single-instance lock.
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (!isMainFrame || code === ERR_ABORTED) return
    if (!win.isVisible()) win.show()
    setTimeout(() => {
      if (!win.isDestroyed()) void win.loadURL(ORIGIN).catch(() => undefined)
    }, RETRY_MS)
  })
  void win.loadURL(ORIGIN).catch(() => undefined)
  return win
}
