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
    { label: 'File', submenu: [{ label: 'Quit', click: a.onQuit }] },
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
export type StorageName = 'cookies' | 'filesystem' | 'indexdb' | 'localstorage' | 'shadercache' | 'serviceworkers' | 'cachestorage'

export function resetStorages(includeCookies: boolean): StorageName[] {
  const storages: StorageName[] = ['localstorage', 'indexdb', 'cachestorage', 'serviceworkers', 'filesystem', 'shadercache']
  return includeCookies ? [...storages, 'cookies'] : storages
}

export interface ResetSteps {
  destroyChildren(): void
  /** Load the neutral shell page in the main window, so the site's unload handlers run first. */
  showShell(): Promise<void> | void
  clearStorage(includeCookies: boolean): Promise<void>
  loadSite(): void
}

/**
 * Order matters: popups first (a closing board must not rewrite records), the shell page next (the
 * site's beforeunload flush runs now, before the wipe), then the wipe, then the site again.
 */
export async function performReset(steps: ResetSteps, includeCookies: boolean): Promise<void> {
  try {
    steps.destroyChildren()
    await steps.showShell()
    await steps.clearStorage(includeCookies)
  } finally {
    steps.loadSite()
  }
}
