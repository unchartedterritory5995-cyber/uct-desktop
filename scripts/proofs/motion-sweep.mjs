// Which endless animations are actually RUNNING on each page, in the real app, signed in as the bench
// member. An endless animation that is on screen in normal use makes the window produce a frame at the
// display rate forever (2026-11-10: the Charts clock dot alone saturated the GPU process). This answers
// from the product itself, not from a CSS grep.
// Usage: node scripts/proofs/motion-sweep.mjs [electron|chrome]
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, sleep, startApp } from './launch.mjs'

const target = process.argv[2] || 'electron'
const PORT = target === 'electron' ? 9347 : 9348
const ROUTES = ['/terminal', '/charts', '/morning-wire', '/dashboard', '/ai-search', '/uct-20', '/breadth', '/screener', '/options-flow', '/flow-scoreboard', '/live-massive', '/catalysts/history', '/model-book', '/formulas/reference', '/desk', '/journal', '/portfolio-heat', '/community', '/support', '/settings']

const LIST = `(()=>document.getAnimations().filter(a=>a.playState==='running'&&a.effect&&a.effect.getTiming&&a.effect.getTiming().iterations===Infinity).map(a=>{const t=a.effect.target;const cls=t?String(t.className&&t.className.baseVal!==undefined?t.className.baseVal:t.className):'';const r=t&&t.getBoundingClientRect?t.getBoundingClientRect():null;return {name:String(a.animationName||a.constructor.name).replace(/_[a-z0-9]{5}_\\d+$/,''),el:(t?t.tagName:'')+'.'+cls.split(' ')[0].replace(/_[a-z0-9]{5}_\\d+$/,''),visible:!!r&&r.width>0&&r.height>0&&r.bottom>0&&r.top<innerHeight}}))()`

let app
const results = { target, startedUtc: new Date().toISOString(), routes: [] }
try {
  app = await startApp(target, PORT, [])
  const { c, run } = app
  for (const route of ROUTES) {
    try {
      await c.send('Page.navigate', { url: `${BASE}${route}` })
      await sleep(7000)
      const list = await run(LIST)
      const uniq = Object.values(Object.fromEntries(list.map((a) => [`${a.name}|${a.el}|${a.visible}`, a])))
      const counts = {}
      for (const a of list) counts[`${a.name}|${a.el}`] = (counts[`${a.name}|${a.el}`] || 0) + 1
      results.routes.push({ route, endless: uniq.map((a) => ({ ...a, count: counts[`${a.name}|${a.el}`] })) })
      console.log(`${route.padEnd(22)} ${uniq.length ? uniq.map((a) => `${a.name} on ${a.el}${a.visible ? '' : ' (off-screen)'} x${counts[`${a.name}|${a.el}`]}`).join('; ') : '-'}`)
    } catch (e) {
      results.routes.push({ route, error: String(e.message).slice(0, 120) })
      console.log(`${route.padEnd(22)} ERROR ${String(e.message).slice(0, 100)}`)
    }
  }
} finally {
  writeFileSync(join('proof-output', `results-motion-sweep-${target}.json`), JSON.stringify(results, null, 2))
  if (app) await app.close()
}
