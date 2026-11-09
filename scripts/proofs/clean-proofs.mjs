// Proof rows that test-tool launch switches would falsify: popup blocking (P2), background
// throttling (P4) and how Cloudflare treats the app (P6).
// Playwright launches with --disable-popup-blocking and the background-throttling switches, and
// turns on focus emulation, which keeps a minimized page "visible". So this runner starts the real
// app through launch.mjs, with only a debugging port.
// Usage: node scripts/proofs/clean-proofs.mjs electron|chrome [--stream]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, CHILD_TITLE, sleep, startApp } from './launch.mjs'

const target = process.argv[2]
const stream = process.argv.includes('--stream')
if (target !== 'electron' && target !== 'chrome') throw new Error('target must be electron or chrome')

const OUT = 'proof-output'
const PORT = target === 'electron' ? 9333 : 9334
const STREAM_MS = 30 * 60 * 1000
const STREAM_ALIVE_MS = 2 * 60 * 1000
const SWITCHES_ABSENT = ['--disable-popup-blocking', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']

mkdirSync(OUT, { recursive: true })
const results = {}
const file = join(OUT, `results-clean-${target}.json`)

function rec(name, verdict, detail) {
  results[name] = { verdict, detail }
  writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`[${verdict}] ${name} ${JSON.stringify(detail).slice(0, 500)}`)
}

async function row(name, fn) {
  try {
    await fn()
  } catch (e) {
    rec(name, 'INCONCLUSIVE', { error: String(e.message).split('\n')[0].slice(0, 200) })
  }
}

let exitCode = 0
let app
try {
  app = await startApp(target, PORT)
  const { c, run, charts, showMainWindow } = app
  const seen = []
  c.on((m) => {
    if (m.method !== 'Network.responseReceived') return
    const { url, status, headers } = m.params.response
    if (!url.startsWith(BASE)) return
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
    seen.push({ s: status, cf: lower['cf-mitigated'] || '', t: Date.now() })
  })

  await charts()
  await sleep(9000)
  rec('Launch switches', 'NOTE', { absent: SWITCHES_ABSENT, focusEmulation: false, userAgent: await run('navigator.userAgent') })

  await row('Copy permission', async () => {
    // Asks the policy without touching the owner's clipboard.
    const state = await run("navigator.permissions.query({name:'clipboard-write'}).then(r=>r.state)")
    rec('Copy permission', state === 'granted' ? 'PASS' : 'FAIL', { state })
  })

  await row('P2 launch restore', async () => {
    const open = (prefix) => `(()=>{const o=[];for(let i=0;i<6;i++)o.push(window.open('','${prefix}'+i,'width=320,height=240,left='+(60+40*i)+',top='+(60+40*i)));const n=o.filter(Boolean).length;o.forEach(w=>w&&w.close());return n})()`
    const noGesture = await run(open('proof-a'))
    await sleep(1500)
    const oneGesture = await run(open('proof-b'), true)
    await sleep(6000)
    rec('P2 launch restore', noGesture === 6 ? 'PASS' : 'FAIL', { noGesture, oneGesture, of: 6 })
  })

  await row('P4 background (after hours)', async () => {
    const opened = await run(`(()=>{const w=window.open('','proof-p4','width=500,height=360,left=240,top=240');window.__child=w;if(w){w.document.title='${CHILD_TITLE}';w.focus()}return !!w})()`, true)
    if (!opened) throw new Error('child window did not open')
    await sleep(1500)
    const start = `(()=>{const w=window.__child;const c=window.__c={childRaf:0,openerRaf:0,tick:0};window.__on=true;
      const a=()=>{if(window.__on){c.childRaf++;w.requestAnimationFrame(a)}};w.requestAnimationFrame(a);
      const b=()=>{if(window.__on){c.openerRaf++;requestAnimationFrame(b)}};requestAnimationFrame(b);
      window.__t=setInterval(()=>{c.tick++},100);return true})()`
    const stop = `(()=>{window.__on=false;clearInterval(window.__t);return {...window.__c,hidden:document.hidden,childHidden:window.__child.document.hidden}})()`
    await run(start)
    await sleep(10000)
    const visible = await run(stop)
    if (visible.childRaf < 100) {
      // A covered window paints nothing, so there is no baseline for the minimized case to meet.
      await run('window.__child.close()')
      rec('P4 background (after hours)', 'INCONCLUSIVE', { visible, reason: 'child window was not painting before the opener was minimized' })
      return
    }
    const minimizedWindows = showMainWindow(6)
    if (minimizedWindows !== 1) {
      if (minimizedWindows > 0) showMainWindow(9)
      throw new Error(`expected to minimize 1 window, found ${minimizedWindows}`)
    }
    await sleep(2000)
    await run(start)
    await sleep(10000)
    const minimized = await run(stop)
    showMainWindow(9)
    await sleep(1500)
    await run('window.__child.close()')
    const childKeepsPainting = minimized.childRaf >= visible.childRaf * 0.5
    const openerTimersRun = minimized.tick >= 80
    rec('P4 background (after hours)', childKeepsPainting && openerTimersRun ? 'PASS' : 'FAIL', {
      visible, minimized, childKeepsPainting, openerTimersRun, note: 'minimized only; market-open CPU and memory row not run',
    })
  })

  await row('P6 500 calls', async () => {
    const alerts = await run(`fetch('/api/alerts',{credentials:'include'}).then(r=>({status:r.status,json:(r.headers.get('content-type')||'').includes('json')}))`)
    const r = await run(`(async()=>{const tally={};let cf=0;for(let i=0;i<500;i++){const x=await fetch('/api/auth/me',{credentials:'include'});tally[x.status]=(tally[x.status]||0)+1;if(x.headers.get('cf-mitigated'))cf++;await new Promise(d=>setTimeout(d,250))}return {tally,cf}})()`)
    const ok = alerts.status === 200 && alerts.json && r.cf === 0 && r.tally[200] === 500
    rec('P6 500 calls', ok ? 'PASS' : 'FAIL', { alerts, ...r })
  })

  if (stream) {
    await row('P6 30-minute stream', async () => {
      const from = Date.now()
      await charts()
      for (let minute = 1; minute <= STREAM_MS / 60000; minute++) {
        await sleep(60000)
        const gone = app.exited()
        if (gone) throw new Error(`app exited in minute ${minute}: ${JSON.stringify(gone)}`)
        console.log(`stream minute ${minute}: ${seen.filter((x) => x.t >= from).length} responses`)
      }
      const during = seen.filter((x) => x.t >= from)
      const blocked = during.filter((x) => x.cf || x.s === 403).length
      const lastResponse = during.length ? during[during.length - 1].t : 0
      const aliveAtEnd = Date.now() - lastResponse < STREAM_ALIVE_MS
      const me = await run(`fetch('/api/auth/me',{credentials:'include'}).then(r=>r.status)`)
      rec('P6 30-minute stream', blocked === 0 && me === 200 && aliveAtEnd ? 'PASS' : 'FAIL', { minutes: 30, responses: during.length, blocked, aliveAtEnd, authAtEnd: me })
    })
  }
} catch (e) {
  exitCode = 1
  console.log(`run stopped: ${String(e.message).split('\n')[0].slice(0, 200)}`)
} finally {
  if (app) await app.close()
}
process.exit(exitCode)
