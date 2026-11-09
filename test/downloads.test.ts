import { describe, expect, it } from 'vitest'
import { safeDownloadName } from '../src/main/policy/downloads'

describe('safeDownloadName', () => {
  it('keeps the allowed file types, in any case', () => {
    for (const name of ['chart.png', 'a.jpg', 'trades.CSV', 'x.json', 'note.txt', 'earnings.ics', 'report.pdf']) {
      expect(safeDownloadName(name)).toBe(name)
    }
  })

  it('refuses everything else', () => {
    for (const name of ['setup.exe', 'run.bat', 'x.js', 'y.html', 'z.msi', 'a.png.exe', 'noextension', '', '.csv']) {
      expect(safeDownloadName(name)).toBeNull()
    }
  })

  it('strips any folders from the name', () => {
    expect(safeDownloadName('..\\..\\Windows\\report.pdf')).toBe('report.pdf')
    expect(safeDownloadName('../../etc/report.pdf')).toBe('report.pdf')
    expect(safeDownloadName('C:\\Users\\x\\chart.png')).toBe('chart.png')
  })

  it('refuses names Windows treats specially', () => {
    for (const name of ['report.txt:hidden', 'CON.txt', 'nul.csv', 'com1.json', 'lpt9.pdf', 'bad\u0001.png', 'wild*.png', 'q?.txt']) {
      expect(safeDownloadName(name)).toBeNull()
    }
  })

  it('refuses names that Windows would silently change', () => {
    expect(safeDownloadName('report.pdf.')).toBeNull()
    expect(safeDownloadName('report.pdf ')).toBeNull()
  })
})
