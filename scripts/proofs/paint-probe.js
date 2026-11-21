// THE PRESENTATION STAMP (2026-11-21, after the independent review): the owner's bar is "both linked charts' new
// candles ON SCREEN within 40 ms of the key", and the flip proof's old BOTH was the animation frame that first
// SAW the new series through the chart's debug handle, about 30 ms before lightweight-charts painted it.
//
// Injected at document start (before any app script), so the library's own scheduling goes through it:
// lightweight-charts 5.2 paints in `window.requestAnimationFrame` (ChartWidget's invalidate handler). Every rAF
// callback is wrapped; a callback that DRAWS into a canvas inside a flip-proof chart widget is a PAINT of that
// chart. At the end of that callback the chart's newest bar (one by-index lookup, never a series copy) tells
// WHICH data was drawn, and the frame AFTER it (the next rAF timestamp) is when the painted frame has been handed
// to the screen: `present`. pixels(chart) = present of its first paint showing the new symbol.
// With `__paintProbe.marks = true` (the proof's --trace flips) each paint and present also leaves a user-timing
// mark, so the stamp can be checked against the Chromium trace's own frame presentation (pixels-trace-check.mjs).
// Cost: per rAF callback a Set; per 2D draw call inside a callback one pointer compare (a WeakMap lookup when the
// canvas changes). Nothing is read from the series but its newest row.
;(() => {
  if (window.top !== window || window.__paintProbe) return
  const P = (window.__paintProbe = { paints: [], max: 30000, cur: null, lastCv: null, lastW: null, marks: false, onPresent: null })
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
          if (P.lastW) cur.add(P.lastW)
        }
        return f.apply(this, arguments)
      }
    }
  }
  window.requestAnimationFrame = function (cb) {
    return raf0(function (t) {
      const outer = P.cur
      P.cur = new Set()
      P.lastCv = null
      try { return cb(t) } finally {
        const drew = P.cur
        P.cur = outer
        P.lastCv = null
        if (drew.size) {
          const end = performance.now()
          for (const w of drew) {
            let time = null, close = null
            try { const h = (window.__uctChartDebug || {})[w]; const nb = h && h.newestBar(); if (nb) { time = nb.time; close = nb.close } } catch (e) { /* mid-remount */ }
            const p = { w, t, end, time, close, present: null }
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
