// Why does a COLD profile's first visit to a page lay out ~60 times a second? Lists the running
// animations (and which properties they animate: width/height/top/left force layout every frame) and
// samples layout counts in 5 s slices while the first visit loads. Fresh profile, bench member.
// Usage: MSYS_NO_PATHCONV=1 node scripts/proofs/cold-layout-probe.mjs [/route] [--slices=12]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, sleep, startApp } from './launch.mjs'

const args = process.argv.slice(2)
const route = args.find((a) => a.startsWith('/')) || '/dashboard'
const SLICES = Number((args.find((a) => a.startsWith('--slices=')) || '--slices=12').split('=')[1])
const PORT = 9353

const ANIMS = `(()=>document.getAnimations().filter(a=>a.playState==='running').map(a=>{const t=a.effect&&a.effect.target;const kf=a.effect&&a.effect.getKeyframes?a.effect.getKeyframes():[];const props=[...new Set(kf.flatMap(k=>Object.keys(k).filter(p=>!['offset','easing','composite','computedOffset'].includes(p))))];const cls=t?String(t.className&&t.className.baseVal!==undefined?t.className.baseVal:t.className).split(' ')[0]:'';return (a.animationName||a.transitionProperty||a.constructor.name)+' ['+props.join(',')+'] on '+(t?t.tagName:'')+'.'+cls.replace(/_[a-z0-9]{5}_\\d+$/,'')}))()`
const metrics = async (c) => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))

let app
const out = { route, startedUtc: new Date().toISOString(), slices: [] }
try {
  app = await startApp('electron', PORT, [])
  const { c, run } = app
  await c.send('Performance.enable', { timeDomain: 'timeTicks' })
  await c.send('Page.navigate', { url: `${BASE}${route}` })
  let prev = await metrics(c)
  for (let i = 0; i < SLICES; i++) {
    await sleep(5000)
    const m = await metrics(c)
    const anims = await run(ANIMS)
    const counts = {}
    for (const a of anims) counts[a] = (counts[a] || 0) + 1
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6)
    const slice = { t: (i + 1) * 5, layoutsPerS: Math.round((m.LayoutCount - prev.LayoutCount) / 5), recalcsPerS: Math.round((m.RecalcStyleCount - prev.RecalcStyleCount) / 5), busyPct: Math.round(((m.TaskDuration - prev.TaskDuration) / 5) * 100), anims: top }
    out.slices.push(slice)
    console.log(`t=${String(slice.t).padStart(3)}s layout/s ${String(slice.layoutsPerS).padStart(4)} recalc/s ${String(slice.recalcsPerS).padStart(4)} busy ${String(slice.busyPct).padStart(3)}%  ${top.map(([k, n]) => `${k} x${n}`).join(' | ') || '-'}`)
    prev = m
  }
} finally {
  writeFileSync(join('proof-output', 'results-cold-layout-probe.json'), JSON.stringify(out, null, 1))
  if (app) await app.close?.()
}
process.exit(0)
