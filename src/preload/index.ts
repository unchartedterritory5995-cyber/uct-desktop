import { contextBridge, ipcRenderer } from 'electron'
import { buildBridge } from './bridge'

// The main process passes the app origin as an argument, so this file is the same in every build.
const arg = process.argv.find((a) => a.startsWith('--uct-origin='))
const bridge = buildBridge(ipcRenderer, location.origin, arg ? arg.slice('--uct-origin='.length) : '')
if (bridge) contextBridge.exposeInMainWorld('uctDesktop', bridge)
