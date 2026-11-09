import { app, shell, type Session, type WebContents } from 'electron'
import { classifyNavigation, classifyNewWindow } from './classify'
import { isPermissionAllowed } from './permissions'

function openExternally(url: string): void {
  void shell.openExternal(url).catch(() => undefined)
}

function guardContents(contents: WebContents, appOrigin: string): void {
  const onNavigate = (event: { preventDefault(): void }, url: string): void => {
    const verdict = classifyNavigation(url, appOrigin)
    if (verdict === 'stay') return
    event.preventDefault()
    if (verdict === 'external-flow') openExternally(url)
  }
  contents.on('will-navigate', onNavigate)
  // A redirect inside an embedded frame is that frame's business, not the app leaving the site.
  contents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (isMainFrame) onNavigate(event, url)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())

  contents.setWindowOpenHandler(({ url }) => {
    const opener = contents.getURL()
    const verdict = classifyNewWindow(url, appOrigin, opener)
    if (verdict === 'blank-child') {
      // Portal windows: nothing here may override sandbox, and no preload is relied on.
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } }
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
    if (verdict === 'external') openExternally(url)
    return { action: 'deny' }
  })
}

export function installPolicy(session: Session, appOrigin: string): void {
  session.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? details.mediaTypes : undefined
    callback(isPermissionAllowed({ permission, origin: details.requestingUrl, mediaTypes }, appOrigin))
  })
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const mediaType = 'mediaType' in details ? details.mediaType : undefined
    return isPermissionAllowed(
      { permission, origin: requestingOrigin, mediaTypes: mediaType ? [mediaType] : undefined },
      appOrigin,
    )
  })
  app.on('web-contents-created', (_event, contents) => guardContents(contents, appOrigin))
}
