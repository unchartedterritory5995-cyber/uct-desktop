import { app, BrowserWindow, session } from 'electron'
import { APP_USER_MODEL_ID, ORIGIN, PARTITION } from './config'
import { installPolicy } from './policy/install'
import { createMainWindow } from './windows/main-window'

app.setAppUserModelId(APP_USER_MODEL_ID)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
  app.on('window-all-closed', () => app.quit())
  void app.whenReady().then(() => {
    installPolicy(session.fromPartition(PARTITION), ORIGIN)
    createMainWindow()
  })
}
