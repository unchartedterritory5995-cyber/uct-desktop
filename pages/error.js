const kind = new URLSearchParams(location.search).get('k')
const text = {
  'network-error': ['You appear to be offline', 'Check your connection. We keep trying and will reopen the app when it is back.'],
  'origin-error': ['UCT Intelligence is not answering', 'The site is having trouble. We keep trying and will reopen the app when it is back.'],
}[kind]
if (text) {
  document.getElementById('title').textContent = text[0]
  document.getElementById('detail').textContent = text[1]
}
document.getElementById('retry').addEventListener('click', () => {
  if (window.uctShell) window.uctShell.retry()
})
