// THE PRESENTATION STAMP (2026-11-21, after the independent review): the owner's bar is "both linked charts' new
// candles ON SCREEN within 40 ms of the key", and the flip proof's old BOTH was the animation frame that first
// SAW the new series through the chart's debug handle, about 30 ms before lightweight-charts painted it.
//
// Injected at document start (before any app script), so the library's own scheduling goes through it:
// lightweight-charts 5.2 paints in `window.requestAnimationFrame` (ChartWidget's invalidate handler). Every rAF
// callback is wrapped; a callback that DRAWS into a canvas inside a flip-proof chart widget is a PAINT of that
// chart, and the frame AFTER it (the next rAF timestamp) is when the painted frame has been handed to the screen:
// `present`. pixels(chart) = present of the chart's first paint of the new symbol.
//
// ⛔ THE PROBE READS NOTHING PER FRAME (2026-11-21: a per-frame read that clones series options cost ~3.8 ms a flip,
// the instrument loading what it measures). Per paint it keeps the frame time, the callback's end, a count of draw
// calls and `present`. Only while the proof has ARMED a switch (P.armed: each linked chart's newest bar at the key)
// and a chart's first new paint is not yet found does a paint of THAT chart read its newest bar (one by-index
// lookup, no series copy, no options); the first paint whose bar differs is marked `first`. Nothing else is read
// until the post-paint window is over. With `marks = true` (the proof's --trace flips) each paint and present also
// leaves a user-timing mark, so the stamp can be checked against the trace (pixels-trace-check.mjs).
;(() => {
  if (window.top !== window || window.__paintProbe) return
  const P = (window.__paintProbe = { paints: [], max: 30000, cur: null, lastCv: null, lastW: null, marks: false, onPresent: null, armed: null })
  const raf0 = window.requestAnimationFrame.bind(window)
  P.raf0 = raf0
  const wOf = new WeakMap()
  const widgetOf = (cv) => {
    if (!cv || !cv.closest) return null
    let w = wOf.get(cv)
    if (w === undefined) {
      const el = cv.closest('[data-widget-id]')
      w = el ? el.getAttribute('data-widget-id') : null
      if (w && !/^flip-chart/.test(w)) w = null
      wOf.set(cv, w)
    }
    return w
  }
  const proto = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype
  if (proto) {
    for (const m of ['clearRect', 'fillRect', 'strokeRect', 'fill', 'stroke', 'drawImage', 'fillText', 'putImageData']) {
      const f = proto[m]
      if (typeof f !== 'function') continue
      proto[m] = function () {
        const cur = P.cur
        if (cur) {
          const cv = this.canvas
          if (cv !== P.lastCv) { P.lastCv = cv; P.lastW = widgetOf(cv) }
          if (P.lastW) cur.set(P.lastW, (cur.get(P.lastW) || 0) + 1)
        }
        return f.apply(this, arguments)
      }
    }
  }
  window.requestAnimationFrame = function (cb) {
    return raf0(function (t) {
      const outer = P.cur
      P.cur = new Map()
      P.lastCv = null
      try { return cb(t) } finally {
        const drew = P.cur
        P.cur = outer
        P.lastCv = null
        if (drew.size) {
          const end = performance.now()
          const A = P.armed
          for (const [w, draws] of drew) {
            const p = { w, t, end, draws, present: null }
            // the ONE read: an armed chart whose first paint of the new symbol has not been found yet
            if (A && A.need[w] && !A.found[w] && end >= A.key()) {
              try {
                const nb = window.__uctChartDebug[w].newestBar()
                if (nb) { p.time = nb.time; p.close = nb.close }
                if (nb && !(nb.time === A.need[w].time && nb.close === A.need[w].close)) { p.first = true; A.found[w] = p }
              } catch (e) { /* mid-remount */ }
            }
            if (P.paints.length < P.max) P.paints.push(p)
            if (P.marks) { try { performance.mark('__lwcPaint:' + w) } catch (e) { /* */ } }
            raf0((t2) => {
              p.present = t2
              if (P.marks) { try { performance.mark('__present:' + w) } catch (e) { /* */ } }
              if (P.onPresent) { try { P.onPresent(p) } catch (e) { /* the proof's hook */ } }
            })
          }
        }
      }
    })
  }
})()
