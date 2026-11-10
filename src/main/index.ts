import { app, autoUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, session } from 'electron'
import { installShellProtocol, registerShellScheme } from './app-shell-protocol'
import { registerBridgeHandlers } from './bridge/handlers'
import { APP_USER_MODEL_ID, ORIGIN, PARTITION } from './config'
import { buildDiagnostics } from './diagnostics'
import { buildMenuTemplate, resetStorages } from './menu'
import { installPolicy } from './policy/install'
import { createQuitController, focusExistingWindow } from './quit'
import { createRecovery, type RecoverableWindow } from './recovery'
import { CHANNELS } from '../shared/contract'
import { createMainWindow, showErrorPage } from './windows/main-window'
import { followSiteTheme, installThemedTitleBars } from './windows/titlebar'

app.setAppUserModelId(APP_USER_MODEL_ID)
registerShellScheme() // must run before the app is ready

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let main: BrowserWindow | undefined
  const clock = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) }

  // Close means quit. The website hears onBeforeQuit and has 500 ms to ack before we close.
  const quit = createQuitController({
    clock,
    sendBeforeQuit: () => {
      if (main && !main.isDestroyed()) main.webContents.send(CHANNELS.beforeQuit)
    },
    finalize: () => app.quit(),
  })

  app.on('second-instance', () => focusExistingWindow(main))
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (quit.allowClose()) return
    event.preventDefault()
    quit.requestQuit('quit')
  })
  // The updater's quitAndInstall must never wait on, or be blocked by, a close handler.
  autoUpdater.on('before-quit-for-update', () => quit.beforeQuitForUpdate())

  void app.whenReady().then(() => {
    installThemedTitleBars()
    let mainContentsId = -1
    installPolicy(session.fromPartition(PARTITION), ORIGIN, (c) => c.id === mainContentsId)
    registerBridgeHandlers(ipcMain, {
      origin: ORIGIN,
      getInfo: () => ({ appVersion: app.getVersion(), platform: process.platform }),
      onAckBeforeQuit: () => quit.ack(),
    })
    installShellProtocol(session.fromPartition(PARTITION))
    const win = createMainWindow().win
    main = win
    win.on('close', (event) => {
      if (quit.allowClose()) return
      event.preventDefault()
      quit.requestQuit('quit')
    })
    win.on('session-end', () => quit.requestQuit('session-end'))

    const ses = session.fromPartition(PARTITION)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          onQuit: () => quit.requestQuit('quit'),
          onAbout: () => void dialog.showMessageBox(win, { type: 'info', message: 'UCT Intelligence', detail: `Version ${app.getVersion()}` }),
          onCopyDiagnostics: () => {
            void ses.getCacheSize().then((cacheBytes) => {
              clipboard.writeText(
                buildDiagnostics({
                  appVersion: app.getVersion(),
                  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
                  platform: `${process.platform} ${process.arch}`,
                  metrics: app.getAppMetrics().map((m) => ({
                    type: m.type,
                    pid: m.pid,
                    memoryKb: m.memory.workingSetSize,
                    cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
                  })),
                  cacheBytes,
                }),
              )
            })
          },
          onResetAppData: () => {
            void dialog
              .showMessageBox(win, {
                type: 'warning',
                message: 'Reset app data?',
                detail: 'Clears this app’s saved settings and caches. Your account on the website is not affected.',
                buttons: ['Cancel', 'Reset'],
                defaultId: 0,
                cancelId: 0,
                checkboxLabel: 'Also sign me out (clear cookies)',
              })
              .then(async ({ response, checkboxChecked }) => {
                if (response !== 1) return
                await ses.clearStorageData({ storages: resetStorages(checkboxChecked) as never })
                await ses.clearCache()
                if (!win.isDestroyed()) win.webContents.reload()
              })
          },
        }),
      ),
    )

    const recovery = createRecovery({
      win: win as unknown as RecoverableWindow,
      now: () => Date.now(),
      dialog: { showMessageBox: (o) => dialog.showMessageBox(win, o) },
      clock,
      getChildren: () => BrowserWindow.getAllWindows().filter((w) => w !== win),
      showError: (k) => showErrorPage(win, k),
    })
    win.once('closed', () => recovery.dispose())
    mainContentsId = main.webContents.id
    followSiteTheme(main.webContents)
  })
}
