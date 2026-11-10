import { app, dialog, shell, type DownloadItem, type Session, type WebContents } from 'electron'
import { join } from 'node:path'
import type { Placement } from '../windows/placement'
import { installZoomKeys } from '../windows/zoom'
import { classifyNavigation, classifyNewWindow } from './classify'
import { safeDownloadName } from './downloads'
import { classifyExternalFlow, EXTERNAL_FLOW_NOTICE } from './external-flow'
import { isPermissionAllowed } from './permissions'

function openExternally(url: string): void {
  void shell.openExternal(url).catch(() => undefined)
}

// Billing and connector sign-ins: tell the member, then open the app's own page in the browser.
function openExternalOrFlow(url: string, appOrigin: string): void {
  const flow = classifyExternalFlow(url, appOrigin)
  if (!flow) return openExternally(url)
  void dialog.showMessageBox({ type: 'info', message: EXTERNAL_FLOW_NOTICE })
  openExternally(flow.openUrl)
}

function guardContents(contents: WebContents, appOrigin: string, placement?: Placement): void {
  const onNavigate = (event: { preventDefault(): void }, url: string): void => {
    const verdict = classifyNavigation(url, appOrigin)
    if (verdict === 'stay') return
    event.preventDefault()
    if (verdict === 'external-flow') openExternalOrFlow(url, appOrigin)
  }
  contents.on('will-navigate', onNavigate)
  // A redirect inside an embedded frame is that frame's business, not the app leaving the site.
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) onNavigate(event, url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('did-create-window', (child, details) => placement?.onCreated(child, details.frameName))

  contents.setWindowOpenHandler(({ url, frameName, features }) => {
    // The origin, not getURL(): a popped-out portal is about:blank but carries the app's origin.
    const opener = contents.mainFrame.origin
    const verdict = classifyNewWindow(url, appOrigin, opener)
    if (verdict === 'blank-child') {
      // Portal windows: nothing here may override sandbox, and no preload is relied on.
      // Only uct-board-<id> / uct-widget-<id> get saved placement; any other name is unchanged.
      const placed = placement?.openOptions(frameName, features)
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, ...placed } }
    }
    if (verdict === 'app-child') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: { backgroundThrottling: false },
        },
      }
    }
    if (verdict === 'external') openExternalOrFlow(url, appOrigin)
    return { action: 'deny' }
  })
}

function guardDownload(item: DownloadItem): void {
  const name = safeDownloadName(item.getFilename())
  if (name) {
    // Windows' own save dialog, so the member sees where it goes and decides about overwriting.
    item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), name) })
    return
  }
  item.cancel()
  void dialog.showMessageBox({ type: 'info', message: 'This file type cannot be saved from the desktop app.' })
}

export function installPolicy(
  session: Session,
  appOrigin: string,
  isMainWindow: (contents: WebContents) => boolean,
  placement?: Placement,
): void {
  session.on('will-download', (_event, item) => guardDownload(item))
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = 'mediaTypes' in details ? details : undefined
    const origin = media?.securityOrigin || details.requestingUrl
    callback(isPermissionAllowed({ permission, origin, mediaTypes: media?.mediaTypes, fromMainWindow: isMainWindow(contents) }, appOrigin))
  })
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const mediaType = 'mediaType' in details ? details.mediaType : undefined
    return isPermissionAllowed(
      {
        permission,
        origin: details.securityOrigin || requestingOrigin,
        mediaTypes: mediaType ? [mediaType] : undefined,
        fromMainWindow: contents ? isMainWindow(contents) : false,
      },
      appOrigin,
    )
  })
  app.on('web-contents-created', (_event, contents) => {
    guardContents(contents, appOrigin, placement)
    installZoomKeys(contents)
  })
}
