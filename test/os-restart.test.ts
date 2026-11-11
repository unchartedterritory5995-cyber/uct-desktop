import { describe, expect, it } from 'vitest'
import { RESTART_ARG, RESTART_FLAGS, registerOsRestart, restartedByWindows } from '../src/main/os-restart'

function rig(register: ((c: string, f: number) => number) | null, enabled = true) {
  const events: unknown[][] = []
  const calls: unknown[][] = []
  const wrapped = register ? (c: string, f: number) => { calls.push([c, f]); return register(c, f) } : null
  const result = registerOsRestart({ register: wrapped, enabled, record: (...a) => void events.push(a) })
  return { result, events, calls }
}

describe('Windows restart registration', () => {
  it('registers with our marker argument, for updates and reboots only (never crashes or hangs)', () => {
    const { result, calls, events } = rig(() => 0)
    expect(result).toBe('registered')
    expect(calls).toEqual([[RESTART_ARG, RESTART_FLAGS]])
    expect(RESTART_FLAGS & 1).toBe(1) // RESTART_NO_CRASH
    expect(RESTART_FLAGS & 2).toBe(2) // RESTART_NO_HANG
    expect(RESTART_FLAGS & 4).toBe(0) // patches still reopen the app
    expect(RESTART_FLAGS & 8).toBe(0) // reboots still reopen the app
    expect(events).toEqual([['os-restart-registered']])
  })

  it('a debug or proof run never registers', () => {
    const { result, calls, events } = rig(() => 0, false)
    expect(result).toBe('skipped')
    expect(calls).toEqual([])
    expect(events).toEqual([])
  })

  it('a failing call is recorded, never thrown', () => {
    expect(rig(() => -2147024809).result).toBe('failed')
    expect(rig(() => -2147024809).events).toEqual([['os-restart-failed', { hr: -2147024809 }]])
    expect(rig(() => { throw new Error('dll') }).result).toBe('failed')
    expect(rig(null).result).toBe('unavailable')
  })

  it('recognises a launch by Windows', () => {
    expect(restartedByWindows(['app.exe', RESTART_ARG])).toBe(true)
    expect(restartedByWindows(['app.exe', '--hidden'])).toBe(false)
  })
})
