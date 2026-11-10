export interface Rgb {
  r: number
  g: number
  b: number
}

export interface CaptionColors {
  /** Windows COLORREF values: 0x00BBGGRR. */
  caption: number
  text: number
  dark: boolean
}

const RGB_FUNCTION = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i
const WHITE = 0x00ffffff
const BLACK = 0x00000000
const DARK_BELOW = 140

/** An opaque color from a computed style or CSS variable, or null if it cannot paint a bar. */
export function parseCssColor(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const fn = RGB_FUNCTION.exec(text)
  if (fn) {
    if (fn[4] !== undefined && Number(fn[4]) === 0) return null
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) }
  }
  const hex = HEX.exec(text)
  if (!hex) return null
  const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1]
  const n = parseInt(digits, 16)
  return { r: n >> 16, g: (n >> 8) & 0xff, b: n & 0xff }
}

export function captionColors({ r, g, b }: Rgb): CaptionColors {
  const dark = 0.299 * r + 0.587 * g + 0.114 * b < DARK_BELOW
  return { caption: (b << 16) | (g << 8) | r, text: dark ? WHITE : BLACK, dark }
}

/** A Windows COLORREF (0x00BBGGRR) as a CSS #rrggbb color. */
export function colorrefToCss(colorref: number): string {
  const hex = (n: number): string => (n & 0xff).toString(16).padStart(2, '0')
  return `#${hex(colorref)}${hex(colorref >> 8)}${hex(colorref >> 16)}`
}
