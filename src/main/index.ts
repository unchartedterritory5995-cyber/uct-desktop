import { app, BrowserWindow, ipcMain, session } from 'electron'
import { registerBridgeHandlers } from './bridge/handlers'
import { APP_USER_MODEL_ID, ORIGIN, PARTITION } from './config'
import { installPolicy } from './policy/install'
import { createMainWindow } from './windows/main-window'
import { followSiteTheme, installThemedTitleBars } from './windows/titlebar'

app.setAppUserModelId(APP_USER_MODEL_ID)

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
    main = createMainWindow()
    mainContentsId = main.webContents.id
    followSiteTheme(main.webContents)
  })
}
