// Read-only probe of the server column lane on production (bench member): sequential single asks for
// symbols nobody has charted this session, with each response's Server-Timing, so the cold cost of ONE
// definition for ONE symbol is visible without five concurrent asks waiting on each other.
import { writeFileSync } from 'node:fs'
import { startApp } from './launch.mjs'

const OUT = process.argv[2]
const SYMS = (process.argv[3] || 'CAT,DE,HON,MMM,GE,BA,LMT,RTX,UPS,FDX').split(',')
const D = { x: -1440, y: 0, w: 1440, h: 950 }
const app = await startApp('chrome', 9441, ['--disable-features=CalculateNativeWinOcclusion', `--window-position=${D.x},${D.y}`], {})
const out = { rows: [] }
try {
  const { run } = app
  const ask = (url) => run(`(async()=>{const t=performance.now();const r=await fetch(${JSON.stringify(url)},{credentials:'include'});const b=await r.text();return {status:r.status,ms:Math.round(performance.now()-t),st:r.headers.get('server-timing'),tier:r.headers.get('x-bars-tier'),cc:r.headers.get('cache-control'),bytes:b.length,n:(()=>{try{const j=JSON.parse(b);return (j.times||j.bars||[]).length}catch(e){return -1}})()}})()`)
  for (const [i, s] of SYMS.entries()) {
    const row = { sym: s }
    // alternate which definition goes first, so "first ask of a symbol" is seen for both kinds
    const order = i % 2 ? ['rsRating', 'rsVsEma', 'rsLine', 'rsPhases', 'rsExit'] : ['rsVsEma', 'rsRating', 'rsLine', 'rsPhases', 'rsExit']
    row.bars852 = await ask(`/api/bars/${s}?tf=D&bars=852`)
    for (const d of order) row[d] = await ask(`/api/signature/columns?defId=${d}&sym=${s}&tf=D`)
    row.again = await ask(`/api/signature/columns?defId=rsLine&sym=${s}&tf=D`)
    out.rows.push(row)
    console.log(s, 'bars852', row.bars852.ms, row.bars852.st, 'tier', row.bars852.tier, '|', order.map((d) => `${d} ${row[d].ms}ms {${row[d].st}}`).join(' | '), '| again', row.again.ms, row.again.st)
  }
} catch (e) {
  out.error = String((e && e.stack) || e).slice(0, 500)
  console.log(out.error)
} finally {
  writeFileSync(OUT, JSON.stringify(out, null, 1))
  await app.close()
}
