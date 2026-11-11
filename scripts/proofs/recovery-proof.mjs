// Recovery after a network drop, in the real app against the live site (desktop plan 6.4). Rows:
//   R-offline  going offline shows the desktop banner's offline message
//   R-order    back online, sign-in (/api/auth/me) is re-checked BEFORE the live streams reopen
//   R-fast     the price and bars streams reopen within 5 s of coming back (not the 30-45 s watchdog)
//   R-clear    the banner clears once the streams are connected, well inside the 20 s cap
// Bench member on /charts (it has both streams). Window on an uncovered display.
// Usage: MSYS_NO_PATHCONV=1 node scripts/proofs/recovery-proof.mjs [--display=5]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, sleep, startApp } from './launch.mjs'

const DISPLAY = Number((process.argv.find((a) => a.startsWith('--display=')) || '--display=5').split('=')[1])
const rows = []
const row = (id, pass, detail) => { rows.push({ id, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`) }
const BANNER = `(document.querySelector('[role="status"]')||{}).textContent||''`

let app
try {
  app = await startApp('electron', 9364, [])
  const d = JSON.parse(readFileSync(join('proof-output', 'displays.json'), 'utf8'))[DISPLAY]
  app.placeMainWindow(d.x + 40, d.y + 40, 1500, 950)
  const { c, run } = app
  await c.send('Network.enable')
  const seen = []
  c.on((m) => {
    if (m.method !== 'Network.requestWillBeSent') return
    const u = m.params.request.url
    if (/\/api\/auth\/me|\/api\/stream\/(prices|bars)/.test(u)) seen.push({ t: Date.now(), kind: u.includes('/auth/me') ? 'auth' : u.includes('/stream/prices') ? 'prices' : 'bars' })
  })
  await c.send('Page.navigate', { url: `${BASE}/charts` })
  await sleep(25000)
  const hasStreams = seen.some((s) => s.kind === 'prices') && seen.some((s) => s.kind === 'bars')
  if (!hasStreams) throw new Error(`the page opened no price and bars streams (${seen.map((s) => s.kind).join(',')}); nothing to recover`)

  await c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await sleep(3000)
  const offText = await run(BANNER)
  row('R-offline', /offline/i.test(offText), `banner: "${offText}"`)

  seen.length = 0
  const back = Date.now()
  await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  let clearedAt = null
  for (let i = 0; i < 50; i++) {
    await sleep(500)
    const text = await run(BANNER)
    if (clearedAt === null && !/offline|moment behind/i.test(text) && Date.now() - back > 500) { clearedAt = Date.now(); break }
  }
  const first = (k) => seen.find((s) => s.kind === k)?.t ?? null
  const ta = first('auth'), tp = first('prices'), tb = first('bars')
  row('R-order', ta !== null && tp !== null && tb !== null && ta <= tp && ta <= tb, `auth +${ta && ta - back} ms, prices +${tp && tp - back} ms, bars +${tb && tb - back} ms`)
  row('R-fast', tp !== null && tb !== null && tp - back < 5000 && tb - back < 5000, `streams reopened at +${tp && tp - back} / +${tb && tb - back} ms`)
  row('R-clear', clearedAt !== null && clearedAt - back < 15000, `banner cleared at +${clearedAt && clearedAt - back} ms`)
} finally {
  if (app) await app.close?.()
}
const failed = rows.filter((r) => !r.pass).length
console.log(failed ? `${failed} FAILED` : 'ALL PASS')
process.exit(failed ? 1 : 0)
