import { describe, expect, it } from 'vitest'
import { classifyExternalFlow, EXTERNAL_FLOW_NOTICE } from '../src/main/policy/external-flow'

const O = 'https://uctintelligence.com'

describe('classifyExternalFlow', () => {
  it('sends Stripe checkout and portal to the app billing page in the browser', () => {
    for (const u of ['https://checkout.stripe.com/c/pay/cs_live_x', 'https://billing.stripe.com/p/session/abc']) {
      expect(classifyExternalFlow(u, O)).toEqual({ kind: 'billing', openUrl: `${O}/settings` })
    }
  })
  it('sends connector sign-ins to the app notebook page in the browser', () => {
    for (const u of [
      'https://api.notion.com/v1/oauth/authorize?client_id=x',
      'https://www.dropbox.com/oauth2/authorize?x=1',
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      'https://www.evernote.com/OAuth.action',
    ]) {
      expect(classifyExternalFlow(u, O)).toEqual({ kind: 'connector', openUrl: `${O}/journal` })
    }
  })
  it('leaves ordinary external links alone', () => {
    expect(classifyExternalFlow('https://news.example/a', O)).toBeNull()
    expect(classifyExternalFlow('https://www.notion.so/help', O)).toBeNull()
  })
  it('does not trust lookalike hosts or non-http schemes', () => {
    expect(classifyExternalFlow('https://checkout.stripe.com.evil.example/x', O)).toBeNull()
    expect(classifyExternalFlow('https://evilstripe.com/x', O)).toBeNull()
    expect(classifyExternalFlow('file:///C:/x', O)).toBeNull()
    expect(classifyExternalFlow('javascript:alert(1)', O)).toBeNull()
    expect(classifyExternalFlow('nonsense', O)).toBeNull()
  })
  it('never matches the app itself', () => {
    expect(classifyExternalFlow(`${O}/subscribe`, O)).toBeNull()
  })
  it('has the specified notice', () => {
    expect(EXTERNAL_FLOW_NOTICE).toBe('Billing and connections open in your browser')
  })
})
