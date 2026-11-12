// The build members actually run: the newest release-out/v<version>/win-unpacked (the release tool,
// scripts/release.mjs, builds every published version there). The nightly speed check, the weekly fault
// check and the market-day run all measure THIS. Until 2026-11-11 they read release-share/, which had
// stopped at 0.1.5 while members were on 0.1.9.
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const EXE = 'UCT Intelligence.exe'

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/** Newest `v<x.y.z>` folder name among `names` (stage folders and anything else ignored), or null. */
export function newestTag(names) {
  const tags = names.filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
  return tags.sort((a, b) => compareVersions(b.slice(1), a.slice(1)))[0] ?? null
}

/** Absolute path of the members' build exe, or null when no release has been built on this PC. */
export function membersBuildExe(root = '.') {
  const out = join(root, 'release-out')
  if (!existsSync(out)) return null
  const names = readdirSync(out).filter((n) => existsSync(join(out, n, 'win-unpacked', EXE)))
  const tag = newestTag(names)
  return tag ? resolve(out, tag, 'win-unpacked', EXE) : null
}
