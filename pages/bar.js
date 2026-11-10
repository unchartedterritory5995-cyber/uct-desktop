const back = document.getElementById('back')
const title = document.getElementById('title')
// Called by the app with a fixed-shape object: { canGoBack, bg, fg, title }. Values are set as
// style properties and text, never as markup.
window.__uctBar = (state) => {
  if (!state || typeof state !== 'object') return
  document.documentElement.style.setProperty('--bg', String(state.bg))
  document.documentElement.style.setProperty('--fg', String(state.fg))
  back.disabled = state.canGoBack !== true
  title.textContent = String(state.title)
}
back.addEventListener('click', () => {
  if (!back.disabled && window.uctBar) window.uctBar.back()
})
