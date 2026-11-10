// Billing and connector sign-ins leave the app's origin (Stripe, Notion, Dropbox, Microsoft,
// Evernote). They are cancelled in the window and the app's OWN page for the task opens in the
// system browser instead, where the member signs in. That keeps the desk alive. Paths come from the
// website: billing is POST /api/auth/checkout|portal (Stripe URL) and connectors are
// POST /api/j2/notes/connectors/{provider}/connect (provider URL), both followed by a top-level
// navigation. Pure: hosts are compared exactly, never as substrings.

export const EXTERNAL_FLOW_NOTICE = 'Billing and connections open in your browser'

export type ExternalFlowKind = 'billing' | 'connector'
export interface ExternalFlow {
  kind: ExternalFlowKind
  /** The app's own page to open in the system browser. */
  openUrl: string
}

const BILLING_HOSTS = new Set(['checkout.stripe.com', 'billing.stripe.com'])
const CONNECTOR_HOSTS = new Set([
  'api.notion.com',
  'www.dropbox.com',
  'login.microsoftonline.com',
  'www.evernote.com',
  'evernote.com',
])

const APP_PATH: Record<ExternalFlowKind, string> = { billing: '/settings', connector: '/journal' }

export function classifyExternalFlow(url: string, appOrigin: string): ExternalFlow | null {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return null
  }
  if (target.protocol !== 'https:' || target.origin === appOrigin) return null
  const host = target.hostname.toLowerCase()
  const kind: ExternalFlowKind | null = BILLING_HOSTS.has(host) ? 'billing' : CONNECTOR_HOSTS.has(host) ? 'connector' : null
  return kind ? { kind, openUrl: `${appOrigin}${APP_PATH[kind]}` } : null
}
