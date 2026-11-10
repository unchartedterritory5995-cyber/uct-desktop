import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildBarBridge, buildBridge, buildShellBridge, type IpcRendererLike } from '../src/preload/bridge'
import { BRIDGE_VERSION, CAPABILITIES, CHANNELS, hasDesktopFeature } from '../src/shared/contract'

const O = 'https://uctintelligence.com'
const spec = JSON.parse(readFileSync(new URL('../contract/bridge.json', import.meta.url), 'utf8')) as {
  bridgeVersion: number
  properties: string[]
  methods: string[]
  capabilities: string[]
}

function fakeIpc() {
  const listeners = new Map<string, Set<(e: unknown, ...a: unknown[]) => void>>()
  const sent: string[] = []
  const ipc: IpcRendererLike = {
    invoke: async () => ({ appVersion: '1', platform: 'win32' }),
    send: (c) => void sent.push(c),
    on: (c, l) => void (listeners.get(c) ?? listeners.set(c, new Set()).get(c)!).add(l),
    removeListener: (c, l) => void listeners.get(c)?.delete(l),
  }
  return { ipc, listeners, sent }
}

describe('exposed surface', () => {
  it('matches contract/bridge.json exactly', () => {
    const b = buildBridge(fakeIpc().ipc, O, O)!
    expect(Object.keys(b).sort()).toEqual([...spec.properties, ...spec.methods].sort())
    expect(b.bridgeVersion).toBe(spec.bridgeVersion)
    expect(b.bridgeVersion).toBe(BRIDGE_VERSION)
    expect([...b.capabilities].sort()).toEqual([...spec.capabilities].sort())
    expect([...CAPABILITIES].sort()).toEqual([...spec.capabilities].sort())
    for (const m of spec.methods) expect(typeof (b as unknown as Record<string, unknown>)[m]).toBe('function')
  })
  it('exposes nothing off the app origin', () => {
    expect(buildBridge(fakeIpc().ipc, 'https://evil.example', O)).toBeNull()
    expect(buildBridge(fakeIpc().ipc, O, '')).toBeNull()
  })
  it('every on* unsubscribe removes its listener', () => {
    const { ipc, listeners } = fakeIpc()
    const b = buildBridge(ipc, O, O)!
    const calls: unknown[] = []
    const off1 = b.onWindowState((s) => calls.push(s))
    const off2 = b.onBeforeQuit(() => calls.push('q'))
    expect(listeners.get(CHANNELS.windowState)!.size).toBe(1)
    expect(listeners.get(CHANNELS.beforeQuit)!.size).toBe(1)
    ;[...listeners.get(CHANNELS.windowState)!][0]({}, 'maximized')
    expect(calls).toEqual(['maximized'])
    off1()
    off2()
    expect(listeners.get(CHANNELS.windowState)!.size).toBe(0)
    expect(listeners.get(CHANNELS.beforeQuit)!.size).toBe(0)
  })
  it('ackBeforeQuit sends on its channel', () => {
    const { ipc, sent } = fakeIpc()
    buildBridge(ipc, O, O)!.ackBeforeQuit()
    expect(sent).toEqual([CHANNELS.ackBeforeQuit])
  })
})

describe('the error page bridge', () => {
  it('exposes only retry, and only on the app-shell origin', () => {
    const { ipc, sent } = fakeIpc()
    expect(buildShellBridge(ipc, O)).toBeNull()
    const s = buildShellBridge(ipc, 'app-shell://shell')!
    expect(Object.keys(s)).toEqual(['retry'])
    s.retry()
    expect(sent).toEqual([CHANNELS.retry])
  })
})

describe('the title bar bridge', () => {
  it('exposes only back(), takes no argument, and only on the app-shell origin', () => {
    const { ipc, sent } = fakeIpc()
    expect(buildBarBridge(ipc, O)).toBeNull()
    const b = buildBarBridge(ipc, 'app-shell://shell')!
    expect(Object.keys(b)).toEqual(['back'])
    expect(b.back.length).toBe(0)
    b.back()
    expect(sent).toEqual([CHANNELS.barBack])
  })
})

describe('hasDesktopFeature', () => {
  it('is false and never throws when the bridge is absent or incomplete', () => {
    expect(hasDesktopFeature('before-quit', undefined)).toBe(false)
    expect(hasDesktopFeature('before-quit', null)).toBe(false)
    expect(hasDesktopFeature('before-quit', {})).toBe(false)
    expect(hasDesktopFeature('before-quit', { capabilities: 'x' })).toBe(false)
    expect(hasDesktopFeature('before-quit', { capabilities: ['before-quit'], onBeforeQuit: () => 0 })).toBe(false)
    expect(hasDesktopFeature('unknown', { capabilities: ['unknown'] })).toBe(false)
  })
  it('is true for a complete bridge', () => {
    const b = buildBridge(fakeIpc().ipc, O, O)!
    expect(hasDesktopFeature('before-quit', b)).toBe(true)
    expect(hasDesktopFeature('window-state', b)).toBe(true)
    expect(hasDesktopFeature('nope', b)).toBe(false)
  })
  it('reads globalThis.uctDesktop by default', () => {
    expect(hasDesktopFeature('window-state')).toBe(false)
  })
})
