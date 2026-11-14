(async () => {
  // What do the indicator series hold now, and what after the member zooms out past the window?
  const h = window.__uctChartDebug['flip-chart']
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const read = () => {
    const nb = h.newestBar()
    const es = h.engineSeries() || []
    const rows = es.map((s) => s.data.length)
    return {
      window: h.plotWindow ? h.plotWindow() : 'this build has no plotWindow()',
      range: h.visibleRange(),
      candles: nb ? nb.count : null,
      series: es.length,
      rowsMin: rows.length ? Math.min(...rows) : null,
      rowsMax: rows.length ? Math.max(...rows) : null,
      firstTimes: [...new Set(es.map((s) => (s.data[0] ? String(s.data[0].time) : 'none')))].slice(0, 4),
    }
  }
  const before = read()
  const w = document.querySelector('[data-widget-id="flip-chart"]')
  const canvases = [...w.querySelectorAll('canvas')].filter((c) => c.getBoundingClientRect().width > 300)
  const target = canvases[0]
  const r = target.getBoundingClientRect()
  const steps = []
  for (let i = 0; i < 60; i++) {
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, deltaMode: 0, bubbles: true, cancelable: true, clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.4 }))
    await sleep(40)
    if (i % 6 === 5) { const s = read(); steps.push({ i, from: s.range ? Math.round(s.range.from) : null, to: s.range ? Math.round(s.range.to) : null, start: s.window && s.window.start, rowsMin: s.rowsMin }) }
  }
  await sleep(900)
  const after = read()
  return { before, steps, after }
})()
