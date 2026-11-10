import { protocol, type Session } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_SHELL_SCHEME, resolveShellFile } from './app-shell'

/** Before app ready. `standard` and `secure` only: no fetch, bypassCSP, CORS or service workers. */
export function registerShellScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: APP_SHELL_SCHEME, privileges: { standard: true, secure: true } }])
}

/** On the app's session, so the page loads in the same partition as the site. */
export function installShellProtocol(session: Session): void {
  session.protocol.handle(APP_SHELL_SCHEME, async (request) => {
    const entry = resolveShellFile(request.url)
    if (!entry) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(join(__dirname, '../pages', entry.file))
      return new Response(body, { headers: { 'content-type': entry.type, 'cache-control': 'no-store' } })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
