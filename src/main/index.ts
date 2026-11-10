import { app, BrowserWindow, dialog, ipcMain, session } from 'electron'
import { installShellProtocol, registerShellScheme } from './app-shell-protocol'
import { registerBridgeHandlers } from './bridge/handlers'
import { APP_USER_MODEL_ID, ORIGIN, PARTITION } from './config'
import { installPolicy } from './policy/install'
import { createRecovery, type RecoverableWindow } from './recovery'
import { createMainWindow, showErrorPage } from './windows/main-window'
import { followSiteTheme, installThemedTitleBars } from './windows/titlebar'

app.setAppUserModelId(APP_USER_MODEL_ID)
registerShellScheme() // must run before the app is ready

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let main: BrowserWindow | undefined
  app.on('second-instance', () => {
    if (!main || main.isDestroyed()) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  })
  app.on('window-all-closed', () => app.quit())
  void app.whenReady().then(() => {
    installThemedTitleBars()
    let mainContentsId = -1
    installPolicy(session.fromPartition(PARTITION), ORIGIN, (c) => c.id === mainContentsId)
    registerBridgeHandlers(ipcMain, {
      origin: ORIGIN,
      getInfo: () => ({ appVersion: app.getVersion(), platform: process.platform }),
      onAckBeforeQuit: () => undefined, // the quit sequence is Task 18
    })
    installShellProtocol(session.fromPartition(PARTITION))
    const win = createMainWindow().win
    main = win
    createRecovery({
      win: win as unknown as RecoverableWindow,
      now: () => Date.now(),
      dialog: { showMessageBox: (o) => dialog.showMessageBox(win, o) },
      clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
      showError: (k) => showErrorPage(win, k),
    })
    mainContentsId = main.webContents.id
    followSiteTheme(main.webContents)
  })
}
