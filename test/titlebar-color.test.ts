import { describe, expect, it } from 'vitest'
import { captionColors, parseCssColor } from '../src/main/windows/titlebar-color'

describe('parseCssColor', () => {
  it('reads the forms a computed style or a CSS variable gives', () => {
    expect(parseCssColor('rgb(16, 16, 18)')).toEqual({ r: 16, g: 16, b: 18 })
    expect(parseCssColor('rgba(16, 16, 18, 1)')).toEqual({ r: 16, g: 16, b: 18 })
    expect(parseCssColor(' #101012 ')).toEqual({ r: 16, g: 16, b: 18 })
    expect(parseCssColor('#fff')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('refuses anything else, including a see-through color', () => {
    for (const v of ['', 'transparent', 'rgba(0, 0, 0, 0)', 'var(--bg)', 'rgb(1, 2)', '#12', null, undefined, 7]) {
      expect(parseCssColor(v)).toBeNull()
    }
  })
})

describe('captionColors', () => {
  it('packs the color the way Windows wants it, blue first', () => {
    expect(captionColors({ r: 0x11, g: 0x22, b: 0x33 }).caption).toBe(0x00332211)
  })

  it('uses light text on a dark theme', () => {
    const c = captionColors({ r: 16, g: 16, b: 18 })
    expect(c.dark).toBe(true)
    expect(c.text).toBe(0x00ffffff)
  })

  it('uses dark text on a light theme', () => {
    const c = captionColors({ r: 245, g: 243, b: 235 })
    expect(c.dark).toBe(false)
    expect(c.text).toBe(0x00000000)
  })
})
