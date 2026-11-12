import { app, autoUpdater, BrowserWindow, clipboard, crashReporter, dialog, ipcMain, Menu, nativeImage, net, powerMonitor, session, Tray, webContents } from 'electron'
import { randomBytes } from 'node:crypto'
import { release } from 'node:os'
import { join } from 'node:path'
import { installShellProtocol, registerShellScheme } from './app-shell-protocol'
import { registerBridgeHandlers } from './bridge/handlers'
import { APP_USER_MODEL_ID, ORIGIN, PARTITION, TRAY_RESIDENCY_ENABLED } from './config'
import { buildDiagnostics } from './diagnostics'
import { createEventLog } from './event-log'
import { createDeskVisibilityReporter } from './desk-visibility'
import { buildMenuTemplate, performReset, resetStorages } from './menu'
import { installPolicy } from './policy/install'
import { createQuitController, focusExistingWindow } from './quit'
import { createRecovery, type RecoverableWindow } from './recovery'
import { createResidency, HIDDEN_FLAG, launchedHidden } from './residency'
import { CHANNELS } from '../shared/contract'
import { createConsentStore, createMicrophoneGate } from './policy/microphone'
import { nodeLogFs, nodeStoreFs } from './store-fs'
import { createElectronPlacement } from './windows/placement-electron'
import { createMainWindow, MAIN_WINDOW_NAME } from './windows/main-window'
import { followSiteTheme, installThemedTitleBars } from './windows/titlebar'
import { createTelemetry, netCode, reasonCode } from './telemetry'
import { autoUpdater as appUpdater } from 'electron-updater'
import { createAppUpdateHub } from './app-update'
import { classifyUpdateError, createUpdateController, type UpdaterLike } from './updates'
import { createLaunchTiming } from './launch-timing'
import { parseBounds } from './windows/main-window'
import { performance } from 'node:perf_hooks'
import { loadRegisterRestart, registerOsRestart, restartedByWindows } from './os-restart'

app.setAppUserModelId(APP_USER_MODEL_ID)
registerShellScheme() // must run before the app is ready

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Black box: crash dumps stay on this PC (nothing is uploaded) and lifecycle events go to a capped,
  // scrubbed log, so an exit or crash leaves something to read. See event-log.ts.
  crashReporter.start({ uploadToServer: false })
  const log = createEventLog({ dir: join(app.getPath('userData'), 'logs'), fs: nodeLogFs, now: () => Date.now() })
  const session0 = log.startSession(app.getVersion())
  // Main-process stalls in the first 20 s of a launch (the network stack waits on this thread for the
  // cookie key, so a blocked main thread blocks the first page request). Black box only.
  {
    let last = performance.now()
    const lagTimer = setInterval(() => {
      const now = performance.now()
      if (now - last > 250) log.record('main-stall', { at: Math.round(last), ms: Math.round(now - last) })
      last = now
      if (now > 20_000) clearInterval(lagTimer)
    }, 50)
  }
  // Where this launch's time goes, from process start (launch-timing.ts). Black box only.
  const launchTiming = createLaunchTiming({
    now: () => performance.now(),
    record: (fields) => log.record('launch-timing', fields),
    clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
  })
  // Telemetry (telemetry.ts): enum-only lifecycle events to the website. Off for any run with a remote
  // debugging port or an inspector (every proof and Playwright launch has one; a member's launch never
  // does) and when UCT_DESKTOP_TELEMETRY=0, so measurement runs never count as member machines.
  const debugRun = app.commandLine.hasSwitch('remote-debugging-port') ||
    process.argv.some((a) => a.startsWith('--remote-debugging-port') || a.startsWith('--inspect'))
  const telemetryOn = process.env.UCT_DESKTOP_TELEMETRY !== '0' && !debugRun
  // A/B switches for the launch proof (launch-cold.mjs), honoured ONLY in a debug run: `late-show` waits for
  // the title bar page before showing the window, `no-preconnect` skips the early connection. Members never
  // have a debug port, so their launch always takes both improvements.
  const proofAb = debugRun ? (process.env.UCT_PROOF_AB ?? '') : ''
  // Proofs open the main window straight onto their measurement display (`x,y,w,h`), never first on the
  // owner's primary monitor. Debug runs only.
  const proofBounds = debugRun ? parseBounds(process.env.UCT_PROOF_WINDOW_BOUNDS) : undefined
  const telemetry = telemetryOn
    ? createTelemetry({
        file: join(app.getPath('userData'), 'telemetry.json'),
        fs: nodeStoreFs,
        send: async (body) => {
          await app.whenReady()
          try {
            const r = await net.fetch(`${ORIGIN}/api/desktop/event`, { method: 'POST', body, headers: { 'content-type': 'application/json' }, credentials: 'omit' })
            if (!r.ok) return null
            const j = (await r.json()) as { enabled?: unknown }
            return { enabled: j?.enabled !== false }
          } catch {
            return null
          }
        },
        version: app.getVersion(),
        os: `${process.platform}-${release()}`,
        now: () => Date.now(),
        randomHex32: () => randomBytes(16).toString('hex'),
        clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
      })
    : undefined
  telemetry?.noteLaunch()
  // Updates (plan 7.1, updates.ts + app-update.ts): installed builds only, never a proof or debug run
  // (a proof launches release-share/win-unpacked and must not install itself over the member's app),
  // unless a proof asks for it with UCT_PROOF_UPDATES=1. UCT_DESKTOP_UPDATES=0 turns them off.
  const updatesOn = app.isPackaged && process.env.UCT_DESKTOP_UPDATES !== '0' && (!debugRun || process.env.UCT_PROOF_UPDATES === '1')
  let updates: ReturnType<typeof createUpdateController> | undefined
  const updateHub = createAppUpdateHub({
    broadcast: (u) => {
      for (const wc of webContents.getAllWebContents()) if (!wc.isDestroyed() && wc.getURL().startsWith(ORIGIN)) wc.send(CHANNELS.appUpdate, u)
    },
    report: (event, code) => telemetry?.report(event, code),
  })
  if (session0.previousUnclean) telemetry?.report('unclean_exit')
  // Monitor only: it observes and never changes how an uncaught error behaves.
  process.on('uncaughtExceptionMonitor', (err, origin) =>
    log.record('main-error', { origin, message: err instanceof Error ? err.message : String(err), at: err instanceof Error ? (err.stack ?? '').split('\n')[1]?.trim() : undefined }),
  )
  // The monitor above does not see rejected promises that nothing awaited. Electron's main process
  // only warns on those, so logging them changes nothing about how the app behaves.
  process.on('unhandledRejection', (reason) =>
    log.record('main-unhandled-rejection', { message: reason instanceof Error ? reason.message : String(reason) }),
  )
  app.on('render-process-gone', (_e, wc, d) => {
    log.record('render-process-gone', { reason: d.reason, exitCode: d.exitCode, main: wc.id === siteContents?.id })
    if (d.reason !== 'clean-exit') telemetry?.report('renderer_crash', reasonCode(d.reason))
  })
  app.on('child-process-gone', (_e, d) => {
    log.record('child-process-gone', { type: d.type, reason: d.reason, exitCode: d.exitCode, name: d.name ?? d.serviceName })
    if (d.type === 'GPU' && d.reason !== 'clean-exit') telemetry?.report('gpu_crash', reasonCode(d.reason))
  })
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
  let openWhenReady = false
  // A second launch (desktop icon, Start menu) opens the resident desk instantly. A second login-item
  // start (--hidden) must not pop a window, and a click before the app is ready is kept, not lost.
  app.on('second-instance', (_e, argv) => {
    if (launchedHidden(argv)) return
    if (residency) residency.open()
    else if (main) focusExistingWindow(main)
    else openWhenReady = true
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
    launchTiming.mark('ready')
    // Open the connection to the website (DNS, TCP, TLS) now, while the window is being built, so the
    // first page request does not pay for it (speed plan 4.2). Two sockets: the page and its first API call.
    if (!proofAb.includes('no-preconnect')) {
      try { session.fromPartition(PARTITION).preconnect({ url: ORIGIN, numSockets: 2 }) } catch { /* best effort */ }
    }
    // Windows Update restarts: reopen UCT after the reboot, like a browser (never after a crash or hang).
    if (restartedByWindows(process.argv)) log.record('launch-after-windows-restart')
    registerOsRestart({ register: loadRegisterRestart(), enabled: app.isPackaged && !debugRun, record: (e, f) => log.record(e, f) })
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
      onSiteEvent: (name) => {
        if (name === 'signed_in') telemetry?.noteSignedIn()
        else if (name === 'desk_restored') telemetry?.noteDeskRestored()
      },
      getAppUpdate: () => updateHub.get(),
      // The normal quit first (onBeforeQuit, unsaved-text prompt, Stay cancels); will-quit installs.
      onRestartToUpdate: () => {
        if (!updateHub.requestRestart()) return
        log.record('update-restart-requested')
        residency?.quitRequested()
        quit.requestQuit('quit')
      },
    })
    if (updatesOn) {
      appUpdater.logger = null
      appUpdater.on('error', (err: unknown) =>
        log.record(`update-error-${classifyUpdateError(err)}`, { code: String((err as { code?: unknown })?.code ?? '').slice(0, 60) }),
      )
      appUpdater.on('update-not-available', () => log.record('update-none'))
      appUpdater.on('update-available', () => log.record('update-available'))
      appUpdater.on('update-downloaded', () => log.record('update-downloaded'))
      updates = createUpdateController({ updater: appUpdater as unknown as UpdaterLike, onState: (st) => updateHub.onState(st) })
      const first = setTimeout(() => void updates?.check(), 60_000)
      const every = setInterval(() => void updates?.check(), 4 * 60 * 60_000)
      app.once('will-quit', () => {
        clearTimeout(first)
        clearInterval(every)
        // Every window is closed and the member answered any unsaved-text prompt: install, then reopen.
        if (updateHub.restartRequested()) {
          log.record('update-install-and-restart')
          appUpdater.quitAndInstall(true, true)
        }
      })
    }
    installShellProtocol(session.fromPartition(PARTITION))
    // The tray is OFF until the website's idle mode (Task 22) and a working updater exist: a resident
    // app that cannot go idle would poll the server all night, and one that cannot update never would.
    // Desk visibility for the website's idle mode: 'hidden' only when every app window is hidden or
    // minimized (a minimized main window with boards up on other monitors is still a visible desk).
    // Sent to every page on the site's origin: the main site and any stand-alone Terminal pop-out.
    const sitePages = () => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.getURL().startsWith(ORIGIN))
    const desk = createDeskVisibilityReporter({
      windows: () => BrowserWindow.getAllWindows(),
      send: (state) => {
        log.record('desk-visibility', { state })
        for (const wc of sitePages()) wc.send(CHANNELS.deskVisibility, state)
      },
    })
    const deskUpdate = () => setImmediate(() => desk.update())
    app.on('browser-window-created', (_e, w) => {
      for (const ev of ['show', 'hide', 'minimize', 'restore', 'closed'] as const) w.on(ev as 'show', deskUpdate)
      deskUpdate()
    })
    app.on('web-contents-created', (_e, wc) => {
      wc.on('did-finish-load', () => {
        const state = desk.current()
        if (state && !wc.isDestroyed() && wc.getURL().startsWith(ORIGIN)) wc.send(CHANNELS.deskVisibility, state)
      })
    })

    const startHidden = TRAY_RESIDENCY_ENABLED && launchedHidden(process.argv) && !openWhenReady
    const created = createMainWindow({
      stayHidden: () => (residency ? residency.isHidden() : startHidden),
      // The main window reopens where the member left it (its own store; pop-outs keep desk-layout.json).
      placement: createElectronPlacement({ file: 'main-window.json', isName: (n) => n === MAIN_WINDOW_NAME }),
      showEarly: !proofAb.includes('late-show'),
      bounds: proofBounds,
      onPhase: (p) => launchTiming.mark(p),
    })
    // Every full page load of the website in a launch's first minute, with its path and status: a launch
    // that loads the site twice (a reload, a redirect) shows up here, in ms from process start.
    let launchNavs = 0
    created.site.on('did-navigate', (_e, url, code) => {
      if (launchNavs >= 5 || performance.now() > 60_000 || !url.startsWith(ORIGIN)) return
      launchNavs++
      log.record('launch-navigation', { n: launchNavs, path: new URL(url).pathname, code, ms: Math.round(performance.now()) })
    })
    const win = created.win
    siteContents = created.site
    mainContentsId = created.site.id
    barContentsId = created.bar.id
    let resetting = false
    main = win
    const quitApp = () => {
      residency?.quitRequested()
      quit.requestQuit('quit')
    }
    if (TRAY_RESIDENCY_ENABLED) {
    // Only the windows this hide made invisible come back, in the state they had: a board the member
    // had minimized stays minimized.
    let hiddenByUs: { w: BrowserWindow; minimized: boolean }[] = []
    residency = createResidency({
      clock,
      now: () => Date.now(),
      hideAll: () => {
        hiddenByUs = BrowserWindow.getAllWindows()
          .filter((w) => !w.isDestroyed() && w.isVisible())
          .map((w) => ({ w, minimized: w.isMinimized() }))
        hiddenByUs.forEach(({ w }) => w.hide())
      },
      showAll: () => {
        for (const { w, minimized } of hiddenByUs) {
          if (w.isDestroyed() || w === win) continue
          if (minimized) w.minimize()
          else w.showInactive()
        }
        hiddenByUs = []
        focusExistingWindow(win)
      },
      // Not wired yet: Task 28's electron-updater client and feed come first. Until then nothing is
      // ever pending, and installUpdate is unreachable by construction.
      hasPendingUpdate: () => false,
      // Fails safe: until the website reports what is at stake (unsaved text, armed alerts, audio,
      // microphone), every moment counts as busy.
      isBusy: () => true,
      installUpdate: () => log.record('update-install-not-wired'),
    })
    const openDesk = () => residency?.open()
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
    } // TRAY_RESIDENCY_ENABLED
    if (openWhenReady) focusExistingWindow(win)

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
      const leave = quit.handleUnloadPrevented(() => {
        // A modal parented to a hidden window may never surface, and this one blocks the main
        // process: bring the desk back first so the member can see the question.
        if (!win.isDestroyed() && !win.isVisible()) {
          if (residency) residency.open()
          else win.show()
        }
        return (
          dialog.showMessageBoxSync(win, {
            type: 'question',
            message: 'You have unsaved text. Leave anyway?',
            buttons: ['Leave', 'Stay'],
            defaultId: 1,
            cancelId: 1,
          }) === 0
        )
      })
      if (leave || resetting) event.preventDefault() // preventDefault lets the unload go ahead
      else {
        created.closer.reset() // Stay: a later X must work again
        residency?.quitCancelled() // ...and hide to the tray again, not quit
      }
    })
    win.on('session-end', () => {
      // Never install an update while Windows is shutting down or restarting (os-restart.ts).
      updateHub.sessionEnding()
      updates?.hold()
      residency?.quitRequested()
      log.endSession('session-end')
      quit.requestQuit('session-end')
    })
    created.site.on('unresponsive', () => {
      log.record('site-unresponsive')
      telemetry?.report('site_unresponsive')
    })
    created.site.on('responsive', () => log.record('site-responsive'))
    created.site.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        log.record('load-failed', { code, description, url }) // -3 is ERR_ABORTED
        telemetry?.report('load_failed', netCode(code))
      }
    })
    // One launch_ok per run, on the site's first successful main-frame load: the site's own origin
    // with an HTTP status under 400 (the offline/error page loads into this same view and must not
    // count). A failed send stays queued on disk and is retried every 15 minutes and on the next launch.
    let launchReported = false
    let lastStatus = 0
    created.site.on('did-navigate', (_e, _url, httpResponseCode) => {
      lastStatus = httpResponseCode
    })
    created.site.on('did-finish-load', () => {
      if (launchReported || created.site.isDestroyed()) return
      if (!created.site.getURL().startsWith(ORIGIN) || lastStatus <= 0 || lastStatus >= 400) return
      launchReported = true
      telemetry?.report('launch_ok')
    })
    if (telemetry) {
      const retry = setInterval(() => void telemetry.flush(), 15 * 60_000)
      app.once('will-quit', () => clearInterval(retry))
    }

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
