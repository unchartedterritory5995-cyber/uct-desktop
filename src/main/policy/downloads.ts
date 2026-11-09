import { win32 } from 'node:path'

const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'csv', 'json', 'txt', 'ics', 'pdf'])
const FORBIDDEN_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** The bare file name to offer for saving, or null if this download must be refused. */
export function safeDownloadName(suggested: string): string | null {
  const name = win32.basename(suggested)
  if (FORBIDDEN_CHARACTERS.test(name) || RESERVED_DEVICE_NAME.test(name)) return null
  if (/[. ]$/.test(name)) return null
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  return ALLOWED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? name : null
}
