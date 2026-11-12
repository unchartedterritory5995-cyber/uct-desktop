import { describe, expect, it } from 'vitest'
import { createLastPage, rememberablePath } from '../src/main/last-page'

const O = 'https://uctintelligence.com'

describe('the app reopens on the last page', () => {
  it('remembers plain app pages only', () => {
    expect(rememberablePath(`${O}/charts`, O)).toBe('/charts')
    expect(rememberablePath(`${O}/terminal/calendar`, O)).toBe('/terminal/calendar')
    expect(rememberablePath(`${O}/journal/notebook`, O)).toBe('/journal/notebook')
    for (const bad of [
      `${O}/`, `${O}/login`, `${O}/login/next`, `${O}/smoke-login`, `${O}/share/n/abc`, `${O}/reset-password`,
      `${O}/charts?sym=NVDA`, `${O}/charts#token=x`, `${O}/Charts`, `${O}/charts/NVDA`, `https://evil.test/charts`,
      'app-shell://shell/error.html', 'not a url', `${O}/a/b/c/d/e`, `https://user:pw@uctintelligence.com/charts`,
    ]) expect(rememberablePath(bad, O)).toBeNull()
  })

  it('saves on navigation, atomically, and the next launch starts there; nothing usable means "/"', () => {
    const files = new Map<string, string>()
    const fs = {
      readFile: (p: string) => { if (!files.has(p)) throw new Error('ENOENT'); return files.get(p)! },
      writeFile: (p: string, d: string) => void files.set(p, d),
      rename: (a: string, b: string) => { files.set(b, files.get(a)!); files.delete(a) },
    }
    const first = createLastPage({ file: 'C:/ud/last-page.json', fs, origin: O })
    expect(first.startPath()).toBe('/')
    first.note(`${O}/login`)
    expect(files.size).toBe(0)
    first.note(`${O}/options-flow`)
    first.note(`${O}/charts`)
    expect([...files.keys()]).toEqual(['C:/ud/last-page.json'])
    expect(createLastPage({ file: 'C:/ud/last-page.json', fs, origin: O }).startPath()).toBe('/charts')
    files.set('C:/ud/last-page.json', JSON.stringify({ path: '/smoke-login' }))
    expect(createLastPage({ file: 'C:/ud/last-page.json', fs, origin: O }).startPath()).toBe('/')
    files.set('C:/ud/last-page.json', '{broken')
    expect(createLastPage({ file: 'C:/ud/last-page.json', fs, origin: O }).startPath()).toBe('/')
  })
})
