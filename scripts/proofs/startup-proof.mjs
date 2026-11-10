// How long until Charts is usable, first launch and repeat launch, in the real app or Chrome.
// Then, on Electron, drops the network and confirms the outage screen appears and recovers.
// Usage: node scripts/proofs/startup-proof.mjs electron|chrome
// Signs in from BENCH_EMAIL / BENCH_PASSWORD, never printed. Sends no OS keys or clicks.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE, MENU, connect, sleep, startApp } from './launch.mjs'

const target = process.argv[2]
if (target !== 'electron' && target !== 'chrome') throw new Error('target must be electron or chrome')
const PORT = target === 'electron' ? 9340 : 9341
const OUT = 'proof-output'
const WARM_LAUNCHES = 3
const OFFLINE_WAIT_MS = 40000
const COOKIE_FLUSH_MS = 35000
mkdirSync(OUT, { recursive: true })
const results = { target, startedUtc: new Date().toISOString(), launches: [] }

const profile = mkdtempSync(join(tmpdir(), `uct-proof-startup-${target}-`))
const pages = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page')

const ready = `(() => {
  const nav = performance.getEntriesByType('navigation')[0]
  const paints = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]))
  return { domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), ...paints, transferKb: Math.round(performance.getEntriesByType('resource').reduce((a, r) => a + (r.transferSize || 0), 0) / 1024), requests: performance.getEntriesByType('resource').length }
})()`

async function launch(label, signIn) {
  const t0 = Date.now()
  const app = await startApp(target, PORT, [], { profile, signIn })
  const opened = Date.now() - t0
  const t1 = Date.now()
  await app.charts()
  const row = { label, processUpToPageMs: opened, navigateToChartsMs: Date.now() - t1, totalMs: Date.now() - t0 }
  await sleep(1500)
  row.page = await app.run(ready)
  results.launches.push(row)
  console.log(JSON.stringify(row))
  return app
}

let app
try {
  app = await launch('first', true)
  await sleep(COOKIE_FLUSH_MS) // Chromium writes cookies to disk on a timer, and this run force-kills
  await app.close({ keepProfile: true })
  await sleep(2500)
  for (let i = 1; i <= WARM_LAUNCHES; i++) {
    app = await launch(`repeat-${i}`, false)
    if (i < WARM_LAUNCHES) {
      await app.close({ keepProfile: true })
      await sleep(2500)
    }
  }

  if (target === 'electron') {
    // Emulate an outage on the site's own connection, then lift it.
    const { c, run } = app
    await c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
    await c.send('Page.reload').catch(() => undefined)
    const t0 = Date.now()
    let shell = null
    while (Date.now() - t0 < OFFLINE_WAIT_MS) {
      await sleep(500)
      shell = (await pages()).find((t) => t.url.startsWith('app-shell://') && t.url.includes('error'))
      if (shell) break
    }
    results.outage = { errorPageMs: shell ? Date.now() - t0 : null }
    if (shell) {
      const errorPage = await connect(shell.webSocketDebuggerUrl).catch(() => null)
      if (errorPage) results.outage.text = (await errorPage.send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,160)', returnByValue: true })).result.value
      await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => undefined)
      const t1 = Date.now()
      let back = false
      while (Date.now() - t1 < 60000) {
        await sleep(1000)
        const site = (await pages()).find((t) => t.url.startsWith(BASE))
        if (site) { back = true; break }
      }
      results.outage.recovered = back
      results.outage.recoverMs = back ? Date.now() - t1 : null
      if (back) console.log('site url back; menu check', await run(`!!document.querySelector('${MENU}')`).catch((e) => String(e.message).slice(0, 80)))
    }
    console.log(JSON.stringify({ outage: results.outage }))
  }
} catch (e) {
  results.error = String(e.message).split('\n')[0].slice(0, 200)
  console.log('stopped', results.error)
} finally {
  writeFileSync(join(OUT, `results-startup-${target}.json`), JSON.stringify(results, null, 2))
  if (app) await app.close()
  await sleep(2000)
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* temp */ }
}
process.exit(results.error ? 1 : 0)
