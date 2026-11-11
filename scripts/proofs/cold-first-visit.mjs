// A brand-new member's first visit: main-thread busy share in 5 s slices while the page loads and the
// background bars packs ingest, then whether each pack actually finished (its version stamp). A busy
// main thread means every click stutters; a missing stamp means the ingest failed and will re-run.
// Fresh profile, bench member, real app, window on an uncovered display.
// Usage: MSYS_NO_PATHCONV=1 node scripts/proofs/cold-first-visit.mjs [/route] [--display=5] [--seconds=90]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, sleep, startApp } from './launch.mjs'

const args = process.argv.slice(2)
const route = args.find((a) => a.startsWith('/')) || '/dashboard'
const opt = (k, d) => Number((args.find((a) => a.startsWith(`--${k}=`)) || '').split('=')[1] || d)
const DISPLAY = opt('display', 5)
const SECONDS = opt('seconds', 90)
const PORT = 9363

const metrics = async (c) => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
const STAMPS = `JSON.stringify(Object.fromEntries(['barspack.version','barspack.hotVersion','intradaypack.version','breadthpack.version'].map(k=>[k,localStorage.getItem(k)])))`

let app
const out = { route, startedUtc: new Date().toISOString(), slices: [] }
try {
  app = await startApp('electron', PORT, [])
  const d = JSON.parse(readFileSync(join('proof-output', 'displays.json'), 'utf8'))[DISPLAY]
  app.placeMainWindow(d.x + 40, d.y + 40, 1500, 950)
  const { c, run } = app
  await c.send('Performance.enable', { timeDomain: 'timeTicks' })
  await c.send('Page.navigate', { url: `${BASE}${route}` })
  const drawn = await run(`new Promise(res=>{let n=0,on=true;const f=()=>{n++;if(on)requestAnimationFrame(f)};requestAnimationFrame(f);setTimeout(()=>{on=false;res(n)},1000)})`)
  if (drawn < 20) throw new Error('the window is not being drawn (covered or off-screen); refusing to measure')
  let prev = await metrics(c)
  for (let t = 5; t <= SECONDS; t += 5) {
    await sleep(5000)
    const m = await metrics(c)
    const busy = Math.round(((m.TaskDuration - prev.TaskDuration) / 5) * 100)
    out.slices.push({ t, busyPct: busy, heapMB: Math.round(m.JSHeapUsedSize / 1048576) })
    prev = m
  }
  out.stamps = JSON.parse(await run(STAMPS))
  const busy = out.slices.map((s) => s.busyPct)
  out.maxBusyPct = Math.max(...busy)
  out.meanBusyPct = Math.round(busy.reduce((a, b) => a + b, 0) / busy.length)
  console.log(`busy % per 5 s: ${busy.join(' ')}`)
  console.log(`max ${out.maxBusyPct}%  mean ${out.meanBusyPct}%`)
  console.log(`stamps: ${JSON.stringify(out.stamps)}`)
} finally {
  writeFileSync(join('proof-output', `results-cold-first-visit${route.replace(/\//g, '-')}.json`), JSON.stringify(out, null, 1))
  if (app) await app.close?.()
}
process.exit(0)
