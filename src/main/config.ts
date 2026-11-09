// Set by scripts/build.mjs. A production build has no way to point at another origin.
declare const __BUILD_KIND__: 'production' | 'dev'

export const BUILD_KIND: 'production' | 'dev' =
  typeof __BUILD_KIND__ === 'undefined' ? 'dev' : __BUILD_KIND__

const PRODUCTION_ORIGIN = 'https://uctintelligence.com'

export function resolveOrigin(kind: 'production' | 'dev', override: string | undefined): string {
  if (kind === 'production' || !override) return PRODUCTION_ORIGIN
  return new URL(override).origin
}

export const ORIGIN = resolveOrigin(BUILD_KIND, process.env.UCT_DESKTOP_ORIGIN)
export const PARTITION = 'persist:uct'
export const APP_USER_MODEL_ID = 'com.uctintelligence.desktop'
