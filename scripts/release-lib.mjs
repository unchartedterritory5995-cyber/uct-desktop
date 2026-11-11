// Pure rules for scripts/release.mjs (tested in test/release-lib.test.ts). No I/O.

export const REPO = 'unchartedterritory5995-cyber/uct-desktop-releases'
export const FEED = `https://github.com/${REPO}/releases`

/** latest.yml fields the tool relies on. Only top-level `key: value` lines are read. */
export function parseLatest(yaml) {
  const top = {}
  for (const line of String(yaml).split(/\r?\n/)) {
    const m = /^([A-Za-z0-9]+):\s*(.*)$/.exec(line)
    if (m) top[m[1]] = m[2].replace(/^'(.*)'$/, '$1').trim()
  }
  const size = /^\s+size:\s*(\d+)\s*$/m.exec(String(yaml))
  return {
    version: top.version || null,
    path: top.path || null,
    sha512: top.sha512 || null,
    size: size ? Number(size[1]) : null,
    stagingPercentage: top.stagingPercentage === undefined ? null : Number(top.stagingPercentage),
  }
}

/** Set (or, at 100, remove) the rollout share. electron-updater: missing = everyone, 0 = nobody. */
export function setStaging(yaml, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error(`stage must be a whole number 0-100, got ${percent}`)
  const lines = String(yaml).replace(/\r\n/g, '\n').split('\n').filter((l) => !/^stagingPercentage:/.test(l))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (percent < 100) lines.push(`stagingPercentage: ${percent}`)
  return lines.join('\n') + '\n'
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/
export function compareVersions(a, b) {
  const x = VERSION.exec(a)
  const y = VERSION.exec(b)
  if (!x || !y) throw new Error(`not X.Y.Z: ${a} / ${b}`)
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) > Number(y[i]) ? 1 : -1
  return 0
}

/** Patterns that must never ship inside an installer anyone can unpack. */
export const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic style keys
  /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
]
export function findSecrets(text) {
  return SECRET_PATTERNS.filter((re) => re.test(text)).map((re) => re.source.slice(0, 40))
}

/** What a published feed must match: the version, file, hash and size we built. */
export function feedMismatches(local, remote) {
  const out = []
  for (const k of ['version', 'path', 'sha512', 'size']) if (local[k] !== remote[k]) out.push(`${k}: built ${local[k]}, feed ${remote[k]}`)
  if (local.stagingPercentage !== remote.stagingPercentage) out.push(`stagingPercentage: built ${local.stagingPercentage}, feed ${remote.stagingPercentage}`)
  return out
}
