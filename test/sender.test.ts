import { describe, expect, it } from 'vitest'
import { assertTrustedSender, isTrustedSender } from '../src/main/bridge/sender'
import { registerBridgeHandlers, type IpcMainLike } from '../src/main/bridge/handlers'
import { CHANNELS } from '../src/shared/contract'

const O = 'https://uctintelligence.com'
const top = (url: string) => ({ senderFrame: { url, parent: null } })
const child = (url: string) => ({ senderFrame: { url, parent: {} } })

describe('assertTrustedSender', () => {
  it('accepts the exact origin in the top frame', () => {
    expect(isTrustedSender(top(`${O}/charts?x=1`), O)).toBe(true)
    expect(() => assertTrustedSender(top(O + '/'), O)).not.toThrow()
  })
  it('rejects subframes, other origins and null frames', () => {
    expect(isTrustedSender(child(`${O}/`), O)).toBe(false)
    expect(isTrustedSender(top('https://uctintelligence.com.evil.example/'), O)).toBe(false)
    expect(isTrustedSender(top('http://uctintelligence.com/'), O)).toBe(false)
    expect(isTrustedSender({ senderFrame: null }, O)).toBe(false)
    expect(isTrustedSender({ senderFrame: undefined }, O)).toBe(false)
    expect(() => assertTrustedSender({ senderFrame: null }, O)).toThrow()
  })
  it('rejects inherited-origin about:blank and blob: documents', () => {
    expect(isTrustedSender(top('about:blank'), O)).toBe(false)
    expect(isTrustedSender(top(`blob:${O}/1b2c`), O)).toBe(false)
    expect(isTrustedSender(top('not a url'), O)).toBe(false)
  })
  it('refuses credentials in the URL', () => {
    expect(isTrustedSender(top('https://a:b@uctintelligence.com/'), O)).toBe(false)
  })
})

describe('registerBridgeHandlers', () => {
  it('answers getInfo only to a trusted sender and acks only from one', () => {
    const handlers = new Map<string, (e: never) => unknown>()
    const ipc: IpcMainLike = {
      handle: (c, l) => void handlers.set(c, l as never),
      on: (c, l) => void handlers.set(c, l as never),
    }
    let acks = 0
    registerBridgeHandlers(ipc, { origin: O, getInfo: () => ({ appVersion: '1', platform: 'win32' }), onAckBeforeQuit: () => void acks++ })
    const info = handlers.get(CHANNELS.getInfo)!
    expect(info(top(`${O}/`) as never)).toEqual({ appVersion: '1', platform: 'win32' })
    expect(() => info(child(`${O}/`) as never)).toThrow()
    const ack = handlers.get(CHANNELS.ackBeforeQuit)!
    ack(child(`${O}/`) as never)
    expect(acks).toBe(0)
    ack(top(`${O}/`) as never)
    expect(acks).toBe(1)
  })
})
