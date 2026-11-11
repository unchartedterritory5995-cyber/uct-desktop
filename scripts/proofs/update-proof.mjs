// App updates in the real app (plan 7.1). Rows:
//   U-cap     the site sees the 'app-update' capability with all three methods
//   U-none    with nothing downloaded, getAppUpdate() answers null (no toast)
//   U-check   the app checks the feed about 60 s after launch and records the outcome in its black box
//             (update-none / update-available / update-downloaded, or update-error-<class> while the
//             feed is missing); the app is still running afterwards
// Updates are off in every debug run, so this sets UCT_PROOF_UPDATES=1, the one switch that allows them.
// Never point it at the member's installed app: a newer feed version would download.
// Usage: MSYS_NO_PATHCONV=1 UCT_PROOF_EXE=<win path> node scripts/proofs/update-proof.mjs [--display=2]
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sleep, startApp } from './launch.mjs'

process.env.UCT_PROOF_UPDATES = '1'
const DISPLAY = Number((process.argv.find((a) => a.startsWith('--display=')) || '--display=2').split('=')[1])
const rows = []
const row = (id, pass, detail) => { rows.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
const profile = mkdtempSync(join(tmpdir(), 'uct-update-proof-'))

function blackBox() {
  const dir = join(profile, 'logs')
  let lines = []
  try {
    for (const f of readdirSync(dir)) lines = lines.concat(readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean))
  } catch { /* no log yet */ }
  return lines.map((l) => { try { return JSON.parse(l).event } catch { return null } }).filter(Boolean)
}

let app
try {
  app = await startApp('electron', 9366, [], { profile })
  const d = JSON.parse(readFileSync(join('proof-output', 'displays.json'), 'utf8'))[DISPLAY]
  if (d) app.placeMainWindow(d.x + 40, d.y + 40, 1500, 950)
  const { run } = app
  const cap = await run(`(()=>{const b=window.uctDesktop;return !!b&&b.capabilities.includes('app-update')&&['getAppUpdate','onAppUpdate','restartToUpdate'].every(m=>typeof b[m]==='function')})()`)
  row('U-cap', cap === true, `capability and methods present: ${cap}`)
  const none = await run(`window.uctDesktop.getAppUpdate().then(u=>JSON.stringify(u))`)
  row('U-none', none === 'null', `getAppUpdate() -> ${none}`)
  let events = []
  for (let i = 0; i < 30; i++) {
    await sleep(5000)
    events = blackBox().filter((e) => e.startsWith('update-'))
    if (events.length) break
  }
  const alive = await run('1+1').then((v) => v === 2, () => false)
  row('U-check', events.length > 0 && alive, `black box: ${events.join(', ') || 'no update event in 150 s'}; app alive: ${alive}`)
} finally {
  if (app) await app.close?.()
}
const failed = rows.filter((r) => !r.pass).length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
