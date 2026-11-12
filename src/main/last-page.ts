// The app reopens on the page the member was on (speed plan 4.x, 2026-11-11), like a browser restoring
// its tab. Besides being what a member expects, it is faster: a launch that loads "/" waits for the
// sign-in check before the site even starts fetching the Charts code and the maintenance check (measured:
// Charts code began at ~580 ms on "/", in parallel with sign-in on "/charts"), because "/" only learns
// where to send a signed-in member once /api/auth/me answers.
//
// Only a plain app page is remembered: lowercase route words, no query, no fragment (a query can carry a
// ticker or a token), never a sign-in / account / share / one-time-link page, never the error page.
// Stored locally under userData (last-page.json), nothing leaves the machine.

const ROUTE = /^\/[a-z0-9-]{1,40}(?:\/[a-z0-9-]{1,40}){0,3}$/
const NEVER = /^\/(login|logout|signup|register|subscribe|reset-password|forgot-password|verify|verify-email|smoke-login|share|s|invite|unsubscribe|checkout|billing|oauth|auth|desktop-auth|coming-soon|maintenance)(\/|$)/

/** The path to remember for `url`, or null when it is not one we keep. */
export function rememberablePath(url: string, origin: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.origin !== origin || u.username || u.password) return null
  if (u.search || u.hash) return null
  const p = u.pathname
  if (p === '/' || !ROUTE.test(p) || NEVER.test(p)) return null
  return p
}

export interface LastPageFs {
  readFile(path: string): string
  writeFile(path: string, data: string): void
  rename(from: string, to: string): void
}

export function createLastPage(deps: { file: string; fs: LastPageFs; origin: string }) {
  let saved: string | null = null
  try {
    const j = JSON.parse(deps.fs.readFile(deps.file)) as { path?: unknown }
    if (typeof j.path === 'string' && rememberablePath(deps.origin + j.path, deps.origin) === j.path) saved = j.path
  } catch {
    /* none yet, or unreadable: start at "/" */
  }
  return {
    /** Where this launch should open ("/" when nothing usable is saved). */
    startPath: (): string => saved ?? '/',
    /** Called on every navigation of the site view; writes only when a rememberable page changes. */
    note(url: string): void {
      const p = rememberablePath(url, deps.origin)
      if (!p || p === saved) return
      saved = p
      try {
        const tmp = `${deps.file}.tmp`
        deps.fs.writeFile(tmp, JSON.stringify({ path: p }))
        deps.fs.rename(tmp, deps.file)
      } catch {
        /* a failed write keeps the old page; never an error in the main process */
      }
    },
  }
}
