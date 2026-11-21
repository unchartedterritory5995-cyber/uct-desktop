// A chart PR's pixels_both PAIR (the release rule's first half): interleaved flip-proof runs, A = the baseline build,
// B = the PR's build (A B B A), pooled per arm. B is WORSE beyond noise by the grid's own rule (acceptance-matrix-lib.mjs
// NOISE): its median pixels_both at least one frame above A's AND a one-sided Mann-Whitney p < 0.05 (a switch not on
// screen in time ranks above every number). Otherwise the PR is EQUAL OR FASTER. A run taken UNDER LOAD makes it
// UNCONFIRMED.
// usage: node scripts/proofs/pair-check.mjs A=a1.json,a2.json B=b1.json,b2.json
import { readFileSync } from 'node:fs'
import * as M from './acceptance-matrix-lib.mjs'

const arms = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')).map(([k, v]) => [k, v.split(',')]))
const med = (xs) => { const v = xs.map((x) => (x == null ? Infinity : x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2 }
const pct = (xs, p) => { const v = xs.map((x) => (x == null ? Infinity : x)).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : null }
const fmt = (x) => (x == null ? 'n/a' : x === Infinity ? 'not on screen' : `${Math.round(x * 10) / 10} ms`)
const S = {}
for (const [arm, files] of Object.entries(arms)) {
  const px = [], repaints = []
  let loaded = false, builds = new Set(), vias = new Set()
  for (const f of files) {
    const run = JSON.parse(readFileSync(f, 'utf8'))
    const charts = [run.tf, run.tf2, run.tf3].filter(Boolean).length
    if (run.machine && run.machine.underLoad) loaded = true
    if (run.paintProbe) vias.add(run.stampVia || 'MessageChannel')
    if (run.build && run.build.commit) builds.add(run.build.commit)
    if (run.dist && run.dist.dir) builds.add(run.dist.dir.split(/[\\/]/).pop())
    for (const fl of run.flips || []) {
      const s = M.scoreSwitch(fl, charts, run.dwell || 0)
      px.push(s.pixelsBothMs ?? null)
      if (s.repaints) repaints.push(Math.max(...s.repaints))
    }
  }
  S[arm] = { px, med: med(px), p90: pct(px, 0.9), repaintsMax: repaints.length ? Math.max(...repaints) : null, repaintsMed: repaints.length ? med(repaints) : null, loaded, builds: [...builds], vias: [...vias].sort() }
  console.log(`${arm}: ${px.length} switches | pixels_both median ${fmt(S[arm].med)}, p90 ${fmt(S[arm].p90)} | repaints per chart median ${S[arm].repaintsMed ?? 'n/a'} (max ${S[arm].repaintsMax ?? 'n/a'})${loaded ? ' | UNDER LOAD' : ''} | ${S[arm].builds.join(', ')}`)
}
if (S.A && S.B) {
  const d = S.B.med != null && S.A.med != null ? S.B.med - S.A.med : null
  const p = M.mannWhitneyGreater(S.B.px, S.A.px)
  const worse = d != null && d >= M.NOISE.frameMs && p != null && p < M.NOISE.p
  // two stamps are two rulers (see acceptance-matrix-lib compareResults): no verdict across them
  const mixed = new Set([...S.A.vias, ...S.B.vias]).size > 1
  const verdict = mixed ? `NO VERDICT: the arms were stamped differently (A ${S.A.vias.join(' + ')}, B ${S.B.vias.join(' + ')})` : worse ? (S.A.loaded || S.B.loaded ? 'WORSE, UNCONFIRMED (under load)' : 'WORSE') : 'EQUAL OR FASTER'
  console.log(`B - A median ${fmt(d)}; Mann-Whitney p(B worse) ${p == null ? 'n/a' : p.toFixed(3)} -> ${verdict}`)
}
