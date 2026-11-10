import { contextBridge, ipcRenderer } from 'electron'
import { buildBarBridge } from './bridge'

// Only the title bar page (app-shell://shell) gets this; it can ask for one thing: go back.
const bar = buildBarBridge(ipcRenderer, location.origin)
if (bar) contextBridge.exposeInMainWorld('uctBar', bar)
