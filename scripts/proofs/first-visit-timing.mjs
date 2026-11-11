// First-visit timing for Early Hints (desktop speed plan 10.3). Fresh browser context per run (no cache),
// loads the site's front page, reads Resource Timing: when the HTML's first byte arrived and when the entry
// script STARTED and ENDED. With Early Hints working, the entry script starts BEFORE the HTML's first byte.
// Usage: node scripts/proofs/first-visit-timing.mjs [runs=5]
import { chromium } from 'playwright'

const RUNS = Number(process.argv[2] || 5)
const URL = 'https://uctintelligence.com/'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const rows = []
for (let i = 0; i < RUNS; i++) {
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36 uct-proof' })
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'load' })
  const r = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0]
    const entry = performance.getEntriesByType('resource').find((e) => /\/assets\/index-[\w-]+\.js$/.test(e.name))
    // Chrome: responseStart is the FIRST byte of anything, a 103 included; finalResponseHeadersStart is the real page.
    const hint = nav.firstInterimResponseStart || 0
    const page = Math.round(nav.finalResponseHeadersStart || nav.responseStart)
    return {
      hint103: hint ? Math.round(hint) : null,
      htmlFirstByte: page,
      entryStart: entry ? Math.round(entry.startTime) : null,
      entryEnd: entry ? Math.round(entry.responseEnd) : null,
      entryVia: entry ? entry.initiatorType : null,
      load: Math.round(nav.loadEventEnd),
      hinted: entry ? entry.startTime < page : null,
    }
  })
  rows.push(r)
  console.log(`run ${i + 1}: 103 hint ${r.hint103} ms | HTML first byte ${r.htmlFirstByte} ms | via ${r.entryVia} | entry script ${r.entryStart}-${r.entryEnd} ms | load ${r.load} ms | started before HTML: ${r.hinted}`)
  await ctx.close()
}
await browser.close()
const med = (k) => { const v = rows.map((r) => r[k]).filter((x) => x != null).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
console.log(`MEDIAN: 103 hint ${med('hint103')} ms | HTML first byte ${med('htmlFirstByte')} ms | entry script done ${med('entryEnd')} ms | load ${med('load')} ms`)
