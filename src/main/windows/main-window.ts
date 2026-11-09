import { BrowserWindow } from 'electron'
import { ORIGIN, PARTITION } from '../config'

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d10',
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  win.once('ready-to-show', () => win.show())
  void win.loadURL(ORIGIN)
  return win
}
