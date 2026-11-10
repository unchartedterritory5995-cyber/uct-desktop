// Microphone consent: the first use shows a native dialog and the answer is kept, one boolean per
// origin, under userData (temp file plus atomic rename, like the desk store). Nothing else is stored.
import type { StoreFs } from '../windows/layout-store'

const VERSION = 1

export const MICROPHONE_DIALOG_MESSAGE = 'Allow UCT Intelligence to use your microphone?'
export const MICROPHONE_DIALOG_DETAIL =
  'It is used for voice input in your notes and journal, only while you are using it. ' +
  'If you choose Don’t allow, it stays off until you use Help > Reset app data.'

export interface ConsentStore {
  get(origin: string): boolean | undefined
  set(origin: string, allowed: boolean): void
  clear(): void
}

function normalise(origin: string): string | null {
  try {
    const u = new URL(origin)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

export function createConsentStore(deps: { file: string; fs: StoreFs }): ConsentStore {
  const { file, fs } = deps
  const origins = new Map<string, boolean>()

  try {
    const raw = fs.readFile(file)
    try {
      const parsed = JSON.parse(raw) as { version?: number; origins?: Record<string, unknown> }
      if (parsed.version !== VERSION || !parsed.origins || typeof parsed.origins !== 'object') throw new Error('shape')
      for (const [o, v] of Object.entries(parsed.origins)) {
        const key = normalise(o)
        if (!key || typeof v !== 'boolean') throw new Error('shape')
        origins.set(key, v)
      }
    } catch {
      origins.clear()
      try {
        fs.writeFile(`${file}.bad`, raw)
      } catch {
        /* start empty */
      }
    }
  } catch {
    /* no file yet */
  }

  // A failed write keeps the answer in memory for this session and retries on the next change.
  const flush = (): void => {
    try {
      const tmp = `${file}.tmp`
      fs.mkdir(file.replace(/[\\/][^\\/]*$/, ''))
      fs.writeFile(tmp, JSON.stringify({ version: VERSION, origins: Object.fromEntries(origins) }), { flush: true })
      fs.rename(tmp, file)
    } catch {
      /* retried on the next change */
    }
  }

  return {
    get: (origin) => {
      const key = normalise(origin)
      return key ? origins.get(key) : undefined
    },
    set(origin, allowed) {
      const key = normalise(origin)
      if (!key || typeof allowed !== 'boolean') return
      origins.set(key, allowed)
      flush()
    },
    clear() {
      origins.clear()
      flush()
    },
  }
}

export interface MicrophoneGate {
  /** True only for an origin that already said yes. Used by the synchronous permission check. */
  isGranted(origin: string): boolean
  /** The stored answer, or one native dialog (shared by concurrent requests) whose answer is kept. */
  request(origin: string, askUser: () => Promise<boolean>): Promise<boolean>
}

export function createMicrophoneGate(deps: { store: ConsentStore }): MicrophoneGate {
  const pending = new Map<string, Promise<boolean>>()
  return {
    isGranted: (origin) => deps.store.get(origin) === true,
    request(origin, askUser) {
      const stored = deps.store.get(origin)
      if (stored !== undefined) return Promise.resolve(stored)
      const existing = pending.get(origin)
      if (existing) return existing
      const p = askUser()
        .then((answer) => {
          deps.store.set(origin, answer === true)
          return answer === true
        })
        .catch(() => false) // a dialog that failed is a no for now, but not remembered
        .finally(() => void pending.delete(origin))
      pending.set(origin, p)
      return p
    },
  }
}
