// Frame scheduling with N EMPTY pop-up windows (no charts, no React): separates "too many windows"
// from "too many charts". Each window runs only a requestAnimationFrame counter; the opener reads
// the intervals. Usage: node scripts/proofs/blank-windows-proof.mjs electron|chrome --n=12 [--display=3]
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sleep, startApp } from './launch.mjs'

const target = process.argv[2]
const N = Number((process.argv.find((a) => a.startsWith('--n=')) || '--n=12').split('=')[1])
const displayIndex = Number((process.argv.find((a) => a.startsWith('--display=')) || '--display=3').split('=')[1])
const display = JSON.parse(readFileSync(join('proof-output', 'displays.json'), 'utf8'))[displayIndex]
const PORT = target === 'electron' ? 9345 : 9346
const W = 480
const H = 360

let app
let out = null
try {
  app = await startApp(target, PORT, ['--disable-features=CalculateNativeWinOcclusion'], { signIn: false })
  const { run } = app
  await sleep(4000)
  const opened = await run(`(()=>{window.__pw=[];for(let i=0;i<${N};i++){const w=window.open('', 'blank'+i, 'popup,width=${W},height=${H},left=${display.x + (0)}+'+(i%4)*${W}+',top='+(${display.y}+Math.floor(i/4)*${H}));if(w){w.document.title='blank'+i;w.document.body.style.background='#111';window.__pw.push(w)}}return window.__pw.length})()`, true)
  // Place them explicitly (features strings are best-effort).
  await run(`(()=>{window.__pw.forEach((w,i)=>{try{w.moveTo(${display.x}+(i%4)*${W},${display.y}+Math.floor(i/4)*${H});w.resizeTo(${W},${H})}catch{}});return true})()`)
  await sleep(5000)
  await run(`(()=>{window.__pf=window.__pw.map(()=>[]);window.__pw.forEach((w,i)=>{let last=w.performance.now();const f=t=>{if(window.__pstop)return;window.__pf[i].push(t-last);last=t;w.requestAnimationFrame(f)};w.requestAnimationFrame(f)});return true})()`)
  await sleep(30000)
  out = await run(`(()=>{window.__pstop=true;return window.__pf.map(a=>{const s=[...a].sort((x,y)=>x-y);return {frames:s.length,p95:s.length>30?Math.round(s[Math.floor(s.length*0.95)]):null,over50:s.filter(x=>x>50).length}})})()`)
  const p95s = out.map((w) => w.p95).filter((x) => x !== null).sort((a, b) => a - b)
  const frames = out.reduce((a, w) => a + w.frames, 0)
  const summary = { target, n: N, opened, display: displayIndex, worstP95: p95s.at(-1), medianP95: p95s[Math.floor(p95s.length / 2)], over50Pct: frames ? Math.round((out.reduce((a, w) => a + w.over50, 0) / frames) * 1000) / 10 : null, framesPerWindowPerSec: Math.round(frames / out.length / 30) }
  console.log(JSON.stringify(summary))
  writeFileSync(join('proof-output', `results-blank-${target}-n${N}.json`), JSON.stringify({ summary, windows: out }, null, 2))
} catch (e) {
  console.log(`run stopped: ${String(e.message).slice(0, 200)}`)
} finally {
  if (app) await app.close()
}
