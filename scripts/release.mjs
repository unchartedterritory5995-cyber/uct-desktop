// The one way to ship the desktop app (plan 7.2, 9.3). Rules live in release-lib.mjs (tested).
//
//   node scripts/release.mjs publish [--stage=N] [--dry]   build, check, publish vX.Y.Z from package.json
//   node scripts/release.mjs stage vX.Y.Z N               change the rollout share of a published version
//   node scripts/release.mjs halt vX.Y.Z                  stop a version reaching anyone else (stage 0)
//   node scripts/release.mjs status                       what the feed offers right now
//
// publish refuses unless: on main, nothing uncommitted, HEAD pushed, the version is new and higher than
// the feed's, `npm run check` passes (types, every test, build), and no secret pattern is in the bundle.
// After publishing it reads the feed back ANONYMOUSLY, as a member's app does, and fails unless the
// version, file, sha512, size and rollout share match what was built.
//
// Rollout: --stage=10 offers the version to ~10% of installs (electron-updater's stable per-install
// bucket); `stage vX 100` widens it to everyone; `halt vX` (0) stops it. Installs that already
// downloaded a halted version see it withdrawn and never install it (app-update.ts). A version that is
// already installed is fixed by publishing a higher one, never by going back.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { FEED, REPO, compareVersions, feedMismatches, findSecrets, parseLatest, setStaging } from './release-lib.mjs'

const [cmd, ...rest] = process.argv.slice(2)
const flag = (k) => rest.find((a) => a.startsWith(`--${k}`))
const say = (m) => console.log(m)
const die = (m) => { console.error(`REFUSED: ${m}`); process.exit(1) }
const sh = (file, args, opts = {}) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
const gh = (args) => sh('gh', args)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'uct-release-check' }, redirect: 'follow' })
  if (!r.ok) throw new Error(`${url} -> ${r.status}`)
  return r.text()
}
async function headSize(url) {
  const r = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': 'uct-release-check' }, redirect: 'follow' })
  return r.ok ? Number(r.headers.get('content-length')) : -r.status
}
/** Read a feed back as a member's app would; GitHub's CDN can lag a few seconds after an upload. */
async function readBack(url, want) {
  let last = []
  for (let i = 0; i < 12; i++) {
    try {
      const got = parseLatest(await fetchText(url))
      last = feedMismatches(want, got)
      if (!last.length) return got
    } catch (e) { last = [String(e.message || e)] }
    await new Promise((r) => setTimeout(r, 5000))
  }
  die(`the feed does not match what was built: ${last.join('; ')}`)
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] })
}

async function publish() {
  const stage = flag('stage') ? Number(flag('stage').split('=')[1]) : 100
  const dry = !!flag('dry')
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  const tag = `v${version}`
  say(`publish ${tag} at ${stage}%${dry ? ' (dry run: nothing uploaded)' : ''}`)

  if (sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') die('not on main')
  if (sh('git', ['status', '--porcelain'])) die('uncommitted changes: commit first, so the release is exactly a commit')
  sh('git', ['fetch', '-q', 'origin', 'main'])
  if (sh('git', ['rev-parse', 'HEAD']) !== sh('git', ['rev-parse', 'origin/main'])) die('HEAD is not pushed to origin/main')
  let exists = true
  try { gh(['release', 'view', tag, '-R', REPO, '--json', 'tagName']) } catch { exists = false }
  if (exists) die(`${tag} is already published: bump the version in package.json`)
  const current = parseLatest(await fetchText(`${FEED}/latest/download/latest.yml`).catch(() => ''))
  if (current.version && compareVersions(version, current.version) <= 0) die(`${version} is not higher than the feed's ${current.version}`)

  say('checks: types, all tests, build')
  execFileSync(npm, ['run', 'check'], { stdio: 'inherit', shell: true })
  const secrets = walk('dist').flatMap((f) => findSecrets(readFileSync(f, 'utf8')).map((p) => `${f}: ${p}`))
  if (secrets.length) die(`secret patterns in the bundle: ${secrets.join(', ')}`)

  const out = join('release-out', tag)
  mkdirSync(out, { recursive: true })
  say(`building the installer into ${out}`)
  execFileSync(npx, ['electron-builder', '--win', 'nsis', '--publish', 'never', `--config.directories.output=${out}`], { stdio: 'inherit', shell: true })
  const latestPath = join(out, 'latest.yml')
  const latest = setStaging(readFileSync(latestPath, 'utf8'), stage)
  writeFileSync(latestPath, latest)
  const want = parseLatest(latest)
  if (want.version !== version) die(`built ${want.version}, expected ${version}`)
  const exe = join(out, want.path)
  const blockmap = `${exe}.blockmap`
  for (const f of [exe, blockmap]) if (!existsSync(f)) die(`missing ${f}`)
  const sha256 = createHash('sha256').update(readFileSync(exe)).digest('hex').toUpperCase()
  say(`built ${want.path}, ${want.size} bytes, SHA-256 ${sha256}`)
  if (dry) return say('dry run: stopping before upload')

  gh(['release', 'create', tag, exe, blockmap, latestPath, '-R', REPO, '--title', `UCT Intelligence ${version}`,
    '--notes', `Delivered by the in-app updater. Rollout ${stage}%. SHA-256 ${sha256}`])
  await readBack(`${FEED}/download/${tag}/latest.yml`, want)
  if (stage > 0) await readBack(`${FEED}/latest/download/latest.yml`, want)
  const size = await headSize(`${FEED}/download/${tag}/${want.path}`)
  if (size !== want.size) die(`installer download is ${size}, expected ${want.size}`)
  say(`PUBLISHED ${tag} at ${stage}%: feed verified anonymously (version, file, sha512, size, rollout)`)
}

async function stage(tag, percent) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '')) die('usage: stage vX.Y.Z N')
  const dir = join('release-out', `${tag}-stage`)
  mkdirSync(dir, { recursive: true })
  gh(['release', 'download', tag, '-R', REPO, '-p', 'latest.yml', '-D', dir, '--clobber'])
  const file = join(dir, 'latest.yml')
  const next = setStaging(readFileSync(file, 'utf8'), percent)
  writeFileSync(file, next)
  gh(['release', 'upload', tag, file, '-R', REPO, '--clobber'])
  await readBack(`${FEED}/download/${tag}/latest.yml`, parseLatest(next))
  say(percent === 0 ? `HALTED ${tag}: no install will download it; pending downloads are withdrawn` : `${tag} now offered to ${percent}% of installs`)
}

async function status() {
  const latest = parseLatest(await fetchText(`${FEED}/latest/download/latest.yml`))
  say(`feed offers ${latest.version} to ${latest.stagingPercentage ?? 100}% of installs (${latest.path}, ${latest.size} bytes)`)
}

if (cmd === 'publish') await publish()
else if (cmd === 'stage') await stage(rest[0], Number(rest[1]))
else if (cmd === 'halt') await stage(rest[0], 0)
else if (cmd === 'status') await status()
else die('usage: publish [--stage=N] [--dry] | stage vX.Y.Z N | halt vX.Y.Z | status')
