import { app, powerMonitor, screen } from 'electron'
import { join } from 'node:path'
import { nodeStoreFs } from '../store-fs'
import type { DisplayInfo } from './display'
import { createLayoutStore } from './layout-store'
import { createPlacement, type Placement } from './placement'

/** Call after app ready. The desk store sits under userData and holds window placement only. */
export function createElectronPlacement(): Placement {
  const store = createLayoutStore({
    file: join(app.getPath('userData'), 'desk-layout.json'),
    fs: nodeStoreFs,
  })
  const placement = createPlacement({
    store,
    getDisplays: (): DisplayInfo[] =>
      screen.getAllDisplays().map((d) => ({
        id: d.id,
        bounds: d.bounds,
        workArea: d.workArea,
        scaleFactor: d.scaleFactor,
        internal: d.internal,
        label: d.label,
      })),
    now: () => Date.now(),
    clock: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) },
  })
  const onScreen = (): void => placement.screenEvent()
  screen.on('display-added', onScreen)
  screen.on('display-removed', onScreen)
  screen.on('display-metrics-changed', onScreen)
  powerMonitor.on('resume', onScreen)
  return placement
}
