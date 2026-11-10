import type { MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  onAbout(): void
  onCopyDiagnostics(): void
  onResetAppData(): void
  onQuit(): void
}

// Zoom is owned by windows/zoom.ts, so no zoom roles appear here.
export function buildMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  return [
    { label: 'File', submenu: [{ label: 'Quit', accelerator: 'Alt+F4', click: a.onQuit }] },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About UCT Intelligence', click: a.onAbout },
        { label: 'Copy Diagnostics', click: a.onCopyDiagnostics },
        { type: 'separator' },
        { label: 'Reset app data...', click: a.onResetAppData },
      ],
    },
  ]
}

/** Storage cleared by "Reset app data". Cookies (the sign-in) are a separate choice. */
export function resetStorages(includeCookies: boolean): string[] {
  const storages = ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem', 'websql', 'shadercache']
  return includeCookies ? [...storages, 'cookies'] : storages
}
