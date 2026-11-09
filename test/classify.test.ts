import { describe, expect, it } from 'vitest'
import { classifyNavigation, classifyNewWindow } from '../src/main/policy/classify'

const O = 'https://uctintelligence.com'

describe('classifyNewWindow', () => {
  it('allows blank children only from the app', () => {
    expect(classifyNewWindow('', O, `${O}/charts`)).toBe('blank-child')
    expect(classifyNewWindow('about:blank', O, `${O}/charts`)).toBe('blank-child')
    expect(classifyNewWindow('', O, 'https://checkout.stripe.com/x')).toBe('deny')
    expect(classifyNewWindow('', O, O)).toBe('blank-child')
    expect(classifyNewWindow('https://news.example/a', O, O)).toBe('external')
    expect(classifyNewWindow('', O, 'null')).toBe('deny')
    expect(classifyNewWindow('', O, 'about:blank')).toBe('deny')
  })

  it('allows app children only from the app', () => {
    expect(classifyNewWindow(`${O}/terminal?popout=x`, O, `${O}/terminal`)).toBe('app-child')
    expect(classifyNewWindow(`${O}/terminal?popout=x`, O, 'https://news.example/')).toBe('deny')
  })

  it('sends other web pages to the browser', () => {
    expect(classifyNewWindow('https://news.example/a', O, `${O}/`)).toBe('external')
    expect(classifyNewWindow('http://news.example/a', O, `${O}/`)).toBe('external')
  })

  it('refuses every other scheme', () => {
    for (const u of ['javascript:alert(1)', 'file:///c:/x', 'smb://x/y', 'ms-msdt:x', 'data:text/html,x', 'vbscript:x', `blob:${O}/a`]) {
      expect(classifyNewWindow(u, O, `${O}/`)).toBe('deny')
    }
  })

  it('is not fooled by lookalike origins', () => {
    expect(classifyNewWindow('https://uctintelligence.com.evil.example/', O, `${O}/`)).toBe('external')
    expect(classifyNewWindow(`${O}/x`, O, 'https://uctintelligence.com.evil.example/')).toBe('deny')
    expect(classifyNewWindow('http://uctintelligence.com/', O, `${O}/`)).toBe('external')
  })

  it('refuses URLs carrying credentials', () => {
    expect(classifyNewWindow('https://uctintelligence.com@evil.example/', O, `${O}/`)).toBe('deny')
    expect(classifyNewWindow('https://user:pw@uctintelligence.com/', O, `${O}/`)).toBe('deny')
    expect(classifyNewWindow(`${O}/x`, O, 'https://user@uctintelligence.com/')).toBe('deny')
  })

  it('refuses garbage', () => {
    expect(classifyNewWindow('not a url', O, `${O}/`)).toBe('deny')
    expect(classifyNewWindow(`${O}/x`, O, 'not a url')).toBe('deny')
  })
})

describe('classifyNavigation', () => {
  it('keeps the app in the app', () => {
    expect(classifyNavigation(`${O}/settings`, O)).toBe('stay')
  })

  it('sends other web pages to the browser', () => {
    expect(classifyNavigation('https://checkout.stripe.com/c/1', O)).toBe('external-flow')
    expect(classifyNavigation('https://uctintelligence.com.evil.example/', O)).toBe('external-flow')
  })

  it('refuses every other scheme and credentials', () => {
    for (const u of ['app-shell://error', 'file:///c:/x', 'javascript:alert(1)', 'about:blank', 'not a url']) {
      expect(classifyNavigation(u, O)).toBe('deny')
    }
    expect(classifyNavigation('https://uctintelligence.com@evil.example/', O)).toBe('deny')
  })
})
