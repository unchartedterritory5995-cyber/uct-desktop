// What may open and where it may go. Pure, so every rule is unit-tested without Electron.
// URLs are parsed with new URL(), never matched as strings: a lookalike such as
// https://uctintelligence.com.evil.example must not read as the app.

export type NewWindowClass = 'blank-child' | 'app-child' | 'external' | 'deny'
export type NavigationClass = 'stay' | 'external-flow' | 'deny'

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function isApp(url: URL | null, appOrigin: string): boolean {
  return url !== null && url.origin === appOrigin && !url.username && !url.password
}

function isHttp(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:'
}

export function classifyNewWindow(url: string, appOrigin: string, openerUrl: string): NewWindowClass {
  const fromApp = isApp(parse(openerUrl), appOrigin)
  if (!fromApp) return 'deny'
  if (url === '' || url === 'about:blank') return 'blank-child'
  const target = parse(url)
  if (!target || !isHttp(target)) return 'deny'
  if (target.username || target.password) return 'deny'
  return isApp(target, appOrigin) ? 'app-child' : 'external'
}

export function classifyNavigation(url: string, appOrigin: string): NavigationClass {
  const target = parse(url)
  if (!target || !isHttp(target)) return 'deny'
  if (target.username || target.password) return 'deny'
  return isApp(target, appOrigin) ? 'stay' : 'external-flow'
}
