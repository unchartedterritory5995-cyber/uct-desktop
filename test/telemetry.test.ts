import { describe, expect, it } from 'vitest'
import { createTelemetry, MAX_QUEUE, netCode, reasonCode, type SendResult } from '../src/main/telemetry'

function memFs(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial }
  return {
    files,
    readFile: (p: string) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    writeFile: (p: string, d: string) => void (files[p] = d),
    rename: (a: string, b: string) => {
      files[b] = files[a]
      delete files[a]
    },
    mkdir: () => undefined,
  }
}

function harness(opts: { files?: Record<string, string>; version?: string; answer?: () => SendResult | Promise<SendResult> } = {}) {
  const fs = memFs(opts.files)
  const sent: string[] = []
  const timers: (() => void)[] = []
  const t = createTelemetry({
    file: 'C:/u/telemetry.json',
    fs,
    send: async (body) => {
      sent.push(body)
      return opts.answer ? opts.answer() : { enabled: true }
    },
    version: opts.version ?? '0.1.4',
    os: 'win32-10.0.26200',
    now: () => 1_800_000_000_000,
    randomHex32: () => 'c'.repeat(32),
    clock: { setTimeout: (fn) => timers.push(fn), clearTimeout: () => undefined },
  })
  const runTimers = async () => {
    while (timers.length) timers.shift()!()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { t, fs, sent, timers, runTimers }
}

const events = (body: string) => JSON.parse(body).events as Record<string, unknown>[]

describe('telemetry', () => {
  it('sends only enum fields: event, version, os, code, install id, time', async () => {
    const h = harness()
    h.t.report('load_failed', 'net_105')
    await h.runTimers()
    const [e] = events(h.sent[0])
    expect(Object.keys(e).sort()).toEqual(['error_code', 'event', 'install', 'os', 'shell_version', 'ts'])
    expect(e).toMatchObject({ event: 'load_failed', error_code: 'net_105', shell_version: '0.1.4', os: 'win32-10.0.26200', install: 'c'.repeat(32) })
  })

  it('drops an unknown error code instead of sending it', async () => {
    const h = harness()
    h.t.report('renderer_crash', 'something C:\\Users\\x')
    await h.runTimers()
    expect(events(h.sent[0])[0].error_code).toBeUndefined()
  })

  it('batches reports made before the flush into one request', async () => {
    const h = harness()
    h.t.report('launch_ok')
    h.t.report('desk_restored')
    expect(h.timers.length).toBe(1)
    await h.runTimers()
    expect(h.sent.length).toBe(1)
    expect(events(h.sent[0]).map((e) => e.event)).toEqual(['launch_ok', 'desk_restored'])
    expect(h.t.queued()).toBe(0)
  })

  it('keeps the queue on disk when the send fails, and sends it on the next run', async () => {
    const h = harness({ answer: () => null })
    h.t.report('unclean_exit')
    await h.runTimers()
    expect(h.t.queued()).toBe(1)
    const next = harness({ files: h.fs.files })
    expect(next.t.queued()).toBe(1)
    await next.t.flush()
    expect(events(next.sent[0]).map((e) => e.event)).toEqual(['unclean_exit'])
    expect(next.t.queued()).toBe(0)
  })

  it('treats a thrown send like a failed one', async () => {
    const h = harness({ answer: () => { throw new Error('net down') } })
    h.t.report('gpu_crash', 'crashed')
    await h.runTimers()
    expect(h.t.queued()).toBe(1)
  })

  it('stops for the rest of the run and drops the queue when the server says enabled: false', async () => {
    const h = harness({ answer: () => ({ enabled: false }) })
    h.t.report('launch_ok')
    await h.runTimers()
    expect(h.t.isStopped()).toBe(true)
    expect(h.t.queued()).toBe(0)
    h.t.report('renderer_crash', 'oom')
    await h.runTimers()
    expect(h.sent.length).toBe(1)
  })

  it('caps the queue, dropping the oldest', () => {
    const h = harness({ answer: () => null })
    for (let i = 0; i < MAX_QUEUE + 5; i++) h.t.report(i === 0 ? 'unclean_exit' : 'load_failed', 'net_2')
    expect(h.t.queued()).toBe(MAX_QUEUE)
    const saved = JSON.parse(h.fs.files['C:/u/telemetry.json'])
    expect(saved.queue[0].event).toBe('load_failed')
  })

  it('reports update_installed on the first launch of a new version only', async () => {
    const first = harness({ version: '0.1.3' })
    first.t.noteLaunch()
    expect(first.t.queued()).toBe(0) // a fresh install is not an update
    const upgraded = harness({ files: first.fs.files, version: '0.1.4' })
    upgraded.t.noteLaunch()
    expect(upgraded.t.queued()).toBe(1)
    await upgraded.runTimers()
    expect(events(upgraded.sent[0])[0].event).toBe('update_installed')
    const again = harness({ files: upgraded.fs.files, version: '0.1.4' })
    again.t.noteLaunch()
    expect(again.t.queued()).toBe(0)
  })

  it('keeps one install id across runs and replaces a malformed one', () => {
    const a = harness()
    a.t.noteLaunch()
    const b = harness({ files: a.fs.files })
    expect(b.t.installId()).toBe('c'.repeat(32))
    const bad = harness({ files: { 'C:/u/telemetry.json': JSON.stringify({ install: '../../x', queue: [] }) } })
    expect(bad.t.installId()).toBe('c'.repeat(32))
  })

  it('survives a corrupt state file', () => {
    const h = harness({ files: { 'C:/u/telemetry.json': '{not json' } })
    h.t.report('launch_ok')
    expect(h.t.queued()).toBe(1)
  })

  it('maps codes to the wire form', () => {
    expect(netCode(-105)).toBe('net_105')
    expect(netCode(0)).toBeUndefined()
    expect(netCode(-123456)).toBeUndefined()
    expect(reasonCode('abnormal-exit')).toBe('abnormal_exit')
    expect(reasonCode('oom')).toBe('oom')
    expect(reasonCode('weird-new-reason')).toBeUndefined()
  })
})
