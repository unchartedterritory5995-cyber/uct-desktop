// Black box on the PACKAGED app (release-share/win-unpacked or UCT_PROOF_EXE). Rows:
//   B-launch     a launch writes a `launch` line with the app version
//   B-unclean    a hard kill (taskkill /F) is reported as `previous-exit-unclean` on the next launch
//   B-dumps      the crash dump directory exists (crashReporter started, nothing uploaded)
//   B-diag       Help > Copy Diagnostics puts recent events on the clipboard, with the profile path scrubbed
//   B-quit       Quit writes one `exit` line and removes the session marker
import { _electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const EXE = process.env.UCT_PROOF_EXE || resolve('release-share', 'win-unpacked', 'UCT Intelligence.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
const row = (id, pass, detail) => {
  rows.push({ id, verdict: pass ? 'PASS' : 'FAIL', detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`)
}
const profile = mkdtempSync(join(tmpdir(), 'uct-proof-blackbox-'))
const logFile = join(profile, 'logs', 'events.log')
const events = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const launch = () => _electron.launch({ executablePath: EXE, args: [`--user-data-dir=${profile}`], timeout: 60000 })

try {
  let app = await launch()
  await sleep(6000)
  const version = await app.evaluate(({ app: a }) => a.getVersion())
  const l1 = events().filter((e) => e.event === 'launch')
  row('B-launch', l1.length === 1 && l1[0].version === version, `launch lines=${l1.length}, version=${l1[0]?.version} (app ${version})`)

  const dumps = await app.evaluate(({ app: a }) => a.getPath('crashDumps'))
  row('B-dumps', existsSync(dumps), `crash dump dir ${existsSync(dumps) ? 'exists' : 'MISSING'}`)

  // Copy Diagnostics through the real menu item, then read the clipboard from the main process.
  const diag = await app.evaluate(async ({ Menu, clipboard }) => {
    clipboard.writeText('')
    const find = (items) => {
      for (const i of items) {
        if (/diagnostic/i.test(i.label || '')) return i
        if (i.submenu) { const s = find(i.submenu.items); if (s) return s }
      }
      return null
    }
    const item = find(Menu.getApplicationMenu()?.items || [])
    if (!item) return { error: 'no Copy Diagnostics item' }
    item.click()
    // readText may return a promise in this Electron version: await it either way.
    const read = async () => String((await clipboard.readText()) ?? '')
    for (let k = 0; k < 40 && !(await read()); k++) await new Promise((r) => setTimeout(r, 100))
    return { text: await read() }
  })
  const text = diag.text || ''
  const user = process.env.USERNAME || 'Patrick'
  row('B-diag', text.includes('Recent events:') && text.includes('"launch"') && !text.includes(`\\${user}\\`) && !text.includes(`/${user}/`),
    diag.error || `diagnostics ${text.length} chars, events section ${text.includes('Recent events:')}, account name present ${text.includes(user)}`)

  // Hard kill, as a crash or power loss would end it.
  execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(2500)
  app = await launch()
  await sleep(5000)
  const unclean = events().filter((e) => e.event === 'previous-exit-unclean')
  row('B-unclean', unclean.length === 1 && unclean[0].previousVersion === version, `unclean lines=${unclean.length}, previousVersion=${unclean[0]?.previousVersion}`)

  const exited = new Promise((r) => app.process().once('exit', r))
  await app.evaluate(({ app: a }) => setTimeout(() => a.quit(), 50)).catch(() => undefined)
  await Promise.race([exited, sleep(10000)])
  await sleep(500)
  const exits = events().filter((e) => e.event === 'exit')
  const marker = existsSync(join(profile, 'logs', 'running.json'))
  row('B-quit', exits.length === 1 && !marker, `exit lines=${exits.length}, session marker ${marker ? 'LEFT BEHIND' : 'removed'}`)
} catch (e) {
  row('run', false, String(e.message).slice(0, 200))
} finally {
  writeFileSync(join('proof-output', 'results-blackbox.json'), JSON.stringify({ exe: EXE, startedUtc: new Date().toISOString(), rows }, null, 2))
  await sleep(1000)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp */ }
}
const failed = rows.filter((r) => r.verdict !== 'PASS').length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
