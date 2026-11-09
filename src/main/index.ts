import { app, BrowserWindow, session } from 'electron'
import { APP_USER_MODEL_ID, ORIGIN, PARTITION } from './config'
import { installPolicy } from './policy/install'
import { createMainWindow } from './windows/main-window'

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
    let mainContentsId = -1
    installPolicy(session.fromPartition(PARTITION), ORIGIN, (c) => c.id === mainContentsId)
    main = createMainWindow()
    mainContentsId = main.webContents.id
  })
}
