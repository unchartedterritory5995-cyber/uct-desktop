import { app, autoUpdater, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, powerMonitor, session, Tray } from 'electron'
import { join } from 'node:path'
import { installShellProtocol, registerShellScheme } from './app-shell-protocol'
import { registerBridgeHandlers } from './bridge/handlers'
import { APP_USER_MODEL_ID, ORIGIN, PARTITION } from './config'
import { buildDiagnostics } from './diagnostics'
import { createEventLog } from './event-log'
import { buildMenuTemplate, performReset, resetStorages } from './menu'
import { installPolicy } from './policy/install'
import { createQuitController, focusExistingWindow } from './quit'
import { createRecovery, type RecoverableWindow } from './recovery'
import { createResidency, HIDDEN_FLAG, launchedHidden } from './residency'
import { CHANNELS } from '../shared/contract'
import { createConsentStore, createMicrophoneGate } from './policy/microphone'
import { nodeLogFs, nodeStoreFs } from './store-fs'
import { createElectronPlacement } from './windows/placement-electron'
import { createMainWindow } from './windows/main-window'
import { followSiteTheme, installThemedTitleBars } from './windows/titlebar'

app.setAppUserModelId(APP_USER_MODEL_ID)
registerShellScheme() // must run before the app is ready

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Black box: crash dumps stay on this PC (nothing is uploaded) and lifecycle events go to a capped,
  // scrubbed log, so an exit or crash leaves something to read. See event-log.ts.
  crashReporter.start({ uploadToServer: false })
  const log = createEventLog({ dir: join(app.getPath('userData'), 'logs'), fs: nodeLogFs, now: () => Date.now() })
  log.startSession(app.getVersion())
  // Monitor only: it observes and never changes how an uncaught error behaves.
  process.on('uncaughtExceptionMonitor', (err, origin) =>
    log.record('main-error', { origin, message: err instanceof Error ? err.message : String(err), at: err instanceof Error ? (err.stack ?? '').split('
')[1]?.trim() : undefined }),
  )
  app.on('render-process-gone', (_e, wc, d) => log.record('render-process-gone', { reason: d.reason, exitCode: d.exitCode, main: wc.id === siteContents?.id }))
  app.on('child-process-gone', (_e, d) => log.record('child-process-gone', { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name ?? d.serviceName }))
  app.on('will-quit', () => log.endSession('quit'))

  let main: BrowserWindow | undefined
  let siteContents: Electron.WebContents | undefined
  const clock = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) }

  // Close means quit. The website hears onBeforeQuit and has 500 ms to ack before we close.
  const quit = createQuitController({
    clock,
    sendBeforeQuit: () => {
      if (siteContents && !siteContents.isDestroyed()) siteContents.send(CHANNELS.beforeQuit)
    },
    finalize: () => app.quit(),
  })

  let residency: ReturnType<typeof createResidency> | undefined
  let tray: Tray | undefined // kept referenced, or it is garbage-collected and vanishes
  // A second launch (desktop icon, Start menu) opens the resident desk instantly.
  app.on('second-instance', () => {
    if (residency) residency.open()
    else focusExistingWindow(main)
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    residency?.quitRequested()
    if (quit.allowClose()) return
    event.preventDefault()
    quit.requestQuit('quit')
  })
  // The updater's quitAndInstall must never wait on, or be blocked by, a close handler.
  autoUpdater.on('before-quit-for-update', () => quit.beforeQuitForUpdate())

  void app.whenReady().then(() => {
    for (const ev of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'shutdown'] as const) powerMonitor.on(ev as 'suspend', () => log.record(`power-${ev}`))
    installThemedTitleBars()
    const consent = createConsentStore({ file: join(app.getPath('userData'), 'microphone-consent.json'), fs: nodeStoreFs })
    const microphoneGate = createMicrophoneGate({ store: consent })
    let mainContentsId = -1 // the SITE contents: notifications and the bridge belong to it
    let barContentsId = -1
    installPolicy(
      session.fromPartition(PARTITION),
      ORIGIN,
      (c) => c.id === mainContentsId,
      createElectronPlacement(),
      (c) => c.id === barContentsId,
      microphoneGate,
    )
    registerBridgeHandlers(ipcMain, {
      origin: ORIGIN,
      getInfo: () => ({ appVersion: app.getVersion(), platform: process.platform }),
      onAckBeforeQuit: () => quit.ack(),
    })
    installShellProtocol(session.fromPartition(PARTITION))
    const startHidden = launchedHidden(process.argv)
    const created = createMainWindow({ stayHidden: () => (residency ? residency.isHidden() : startHidden) })
    const win = created.win
    siteContents = created.site
    mainContentsId = created.site.id
    barContentsId = created.bar.id
    let resetting = false
    main = win
    const allWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
    residency = createResidency({
      clock,
      now: () => Date.now(),
      hideAll: () => allWindows().forEach((w) => w.hide()),
      showAll: () => {
        allWindows().forEach((w) => w !== win && w.showInactive())
        focusExistingWindow(win)
      },
      hasPendingUpdate: () => false, // until the updater is wired (Task 28 feed): nothing to install
      installUpdate: () => {
        log.record('update-install-idle')
        void quit.prepareForUpdate().then(() => autoUpdater.quitAndInstall())
      },
    })
    const openDesk = () => residency?.open()
    const quitApp = () => {
      residency?.quitRequested()
      quit.requestQuit('quit')
    }
    tray = new Tray(nativeImage.createFromPath(join(__dirname, '..', 'icon.png')).resize({ width: 16, height: 16 }))
    tray.setToolTip('UCT Intelligence')
    const buildTrayMenu = () =>
      Menu.buildFromTemplate([
        { label: 'Open UCT Intelligence', click: openDesk },
        { type: 'separator' },
        {
          label: 'Start with Windows',
          type: 'checkbox',
          checked: app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: [HIDDEN_FLAG] })
            log.record('login-item', { on: item.checked })
          },
        },
        { type: 'separator' },
        { label: 'Quit', click: quitApp },
      ])
    tray.setContextMenu(buildTrayMenu())
    tray.on('click', openDesk)
    tray.on('right-click', () => tray?.setContextMenu(buildTrayMenu()))
    if (startHidden) {
      residency.startHidden()
      log.record('started-in-tray')
    }

    win.on('close', (event) => {
      if (!quit.allowClose() && residency?.onClose() === 'hide') {
        event.preventDefault()
        log.record('hidden-to-tray')
        return
      }
      if (!quit.allowClose()) {
        event.preventDefault()
        quit.requestQuit('quit')
        return
      }
      // The site is a child view that closing the window does not unload: close it first.
      if (!created.closer.isDone()) {
        event.preventDefault()
        created.closer.begin()
      }
    })
    // A page-level beforeunload guard (unsaved text) can cancel a quit and would repeat on every X.
    created.site.on('will-prevent-unload', (event) => {
      created.closer.promptShown()
      const leave = quit.handleUnloadPrevented(
        () =>
          dialog.showMessageBoxSync(win, {
            type: 'question',
            message: 'You have unsaved text. Leave anyway?',
            buttons: ['Leave', 'Stay'],
            defaultId: 1,
            cancelId: 1,
          }) === 0,
      )
      if (leave || resetting) event.preventDefault() // preventDefault lets the unload go ahead
      else created.closer.reset() // Stay: a later X must work again
    })
    win.on('session-end', () => {
      residency?.quitRequested()
      log.endSession('session-end')
      quit.requestQuit('session-end')
    })
    created.site.on('unresponsive', () => log.record('site-unresponsive'))
    created.site.on('responsive', () => log.record('site-responsive'))
    created.site.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) log.record('load-failed', { code, description, url }) // -3 is ERR_ABORTED
    })

    const ses = session.fromPartition(PARTITION)
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildMenuTemplate({
          onQuit: quitApp,
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
                  events: log.tail(40),
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
                resetting = true
                try {
                  await performReset(
                    {
                      destroyChildren: () => BrowserWindow.getAllWindows().filter((w) => w !== win).forEach((w) => w.destroy()),
                      showShell: () => created.showError('reset'),
                      clearStorage: async (cookies) => {
                        await ses.clearStorageData({ storages: resetStorages(cookies) })
                        await ses.clearCache()
                        consent.clear() // a denied microphone is asked about again
                      },
                      loadSite: () => created.guard.retry(),
                    },
                    checkboxChecked,
                  )
                } finally {
                  resetting = false
                }
              })
          },
        }),
      ),
    )

    const recovery = createRecovery({
      win: { webContents: created.site, isDestroyed: () => win.isDestroyed() || created.site.isDestroyed() } as unknown as RecoverableWindow,
      now: () => Date.now(),
      dialog: { showMessageBox: (o) => dialog.showMessageBox(win, o) },
      clock,
      getChildren: () => BrowserWindow.getAllWindows().filter((w) => w !== win),
      showError: (k) => void created.showError(k),
    })
    win.once('closed', () => {
      recovery.dispose()
      residency?.dispose()
    })
    followSiteTheme(created.site)
  })
}
