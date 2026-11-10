import { describe, expect, it } from 'vitest'
import { isExtendedSession, isMarketHours } from '../src/main/market-hours'

// Eastern is UTC-4 in summer time (EDT) and UTC-5 in winter time (EST).
// 2026 US clock changes: Sunday 2026-03-08 (spring forward) and Sunday 2026-11-01 (fall back).
const utc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi)

describe('isMarketHours', () => {
  it('opens at 9:30 ET, not 9:29 (EST, Monday 2026-11-09)', () => {
    expect(isMarketHours(utc(2026, 11, 9, 14, 29))).toBe(false)
    expect(isMarketHours(utc(2026, 11, 9, 14, 30))).toBe(true)
  })

  it('closes at 16:00 ET, open at 15:59 (EST)', () => {
    expect(isMarketHours(utc(2026, 11, 9, 20, 59))).toBe(true)
    expect(isMarketHours(utc(2026, 11, 9, 21, 0))).toBe(false)
  })

  it('is closed all weekend', () => {
    expect(isMarketHours(utc(2026, 11, 14, 15, 0))).toBe(false) // Saturday 10:00 ET
    expect(isMarketHours(utc(2026, 11, 15, 15, 0))).toBe(false) // Sunday 10:00 ET
  })

  it('follows the spring-forward change (Fri 3/6 EST, Mon 3/9 EDT)', () => {
    // Friday before: 9:30 ET is 14:30 UTC.
    expect(isMarketHours(utc(2026, 3, 6, 13, 30))).toBe(false)
    expect(isMarketHours(utc(2026, 3, 6, 14, 30))).toBe(true)
    // Monday after: 9:30 ET is 13:30 UTC, and 16:00 ET is 20:00 UTC.
    expect(isMarketHours(utc(2026, 3, 9, 13, 29))).toBe(false)
    expect(isMarketHours(utc(2026, 3, 9, 13, 30))).toBe(true)
    expect(isMarketHours(utc(2026, 3, 9, 19, 59))).toBe(true)
    expect(isMarketHours(utc(2026, 3, 9, 20, 0))).toBe(false)
  })

  it('follows the fall-back change (Fri 10/30 EDT, Mon 11/2 EST)', () => {
    expect(isMarketHours(utc(2026, 10, 30, 13, 30))).toBe(true)
    expect(isMarketHours(utc(2026, 10, 30, 20, 0))).toBe(false)
    expect(isMarketHours(utc(2026, 11, 2, 13, 30))).toBe(false)
    expect(isMarketHours(utc(2026, 11, 2, 14, 30))).toBe(true)
    expect(isMarketHours(utc(2026, 11, 2, 20, 30))).toBe(true)
  })
})

describe('isExtendedSession', () => {
  it('covers 4:00 to 20:00 ET on weekdays, across both clock changes', () => {
    expect(isExtendedSession(utc(2026, 11, 9, 8, 59))).toBe(false) // 3:59 EST
    expect(isExtendedSession(utc(2026, 11, 9, 9, 0))).toBe(true) // 4:00 EST
    expect(isExtendedSession(utc(2026, 11, 10, 0, 59))).toBe(true) // Mon 19:59 EST
    expect(isExtendedSession(utc(2026, 11, 10, 1, 0))).toBe(false) // Mon 20:00 EST
    expect(isExtendedSession(utc(2026, 3, 9, 8, 0))).toBe(true) // 4:00 EDT
    expect(isExtendedSession(utc(2026, 3, 9, 7, 59))).toBe(false) // 3:59 EDT
  })
  it('is closed on weekends', () => {
    expect(isExtendedSession(utc(2026, 11, 14, 15, 0))).toBe(false)
  })
})
