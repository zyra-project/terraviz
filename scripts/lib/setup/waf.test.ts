// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  buildFeedbackRule,
  buildTranscodeRule,
  ensureWafRules,
  FEEDBACK_RULE_DESCRIPTION,
  mergeRules,
  RULE_PREFIX,
  TRANSCODE_RULE_DESCRIPTION,
  WafApi,
  type WafRule,
} from './waf'

const operatorRule = (description: string): WafRule => ({
  action: 'block',
  expression: 'ip.src eq 1.2.3.4',
  description,
  enabled: true,
})

describe('mergeRules', () => {
  // The rulesets API replaces the whole list on PUT, so anything
  // dropped here is deleted from the operator's zone. This is the
  // property the module exists to guarantee.
  it('never drops an existing rule', () => {
    const existing = [operatorRule('block a bad actor'), operatorRule('rate limit /api')]
    const { rules, kept } = mergeRules(existing, [buildTranscodeRule()])
    expect(kept).toBe(2)
    expect(rules.slice(0, 2)).toEqual(existing)
    expect(rules).toHaveLength(3)
  })

  it('preserves existing order and appends ours last', () => {
    const existing = [operatorRule('first'), operatorRule('second')]
    const { rules } = mergeRules(existing, [buildTranscodeRule(), buildFeedbackRule()])
    expect(rules.map(r => r.description)).toEqual([
      'first',
      'second',
      TRANSCODE_RULE_DESCRIPTION,
      FEEDBACK_RULE_DESCRIPTION,
    ])
  })

  it('is idempotent — a second merge adds nothing', () => {
    const wanted = [buildTranscodeRule(), buildFeedbackRule()]
    const first = mergeRules([], wanted)
    const second = mergeRules(first.rules, wanted)
    expect(second.added).toEqual([])
    expect(second.rules).toHaveLength(2)
  })

  // An operator who tuned our rule's expression keeps their edit.
  it('does not overwrite a rule it finds by description', () => {
    const edited: WafRule = { ...buildTranscodeRule(), expression: 'edited by operator' }
    const { rules, added } = mergeRules([edited], [buildTranscodeRule()])
    expect(added).toEqual([])
    expect(rules[0].expression).toBe('edited by operator')
  })

  it('handles a zone with no rules at all', () => {
    const { rules, added, kept } = mergeRules([], [buildFeedbackRule()])
    expect(kept).toBe(0)
    expect(added).toEqual([FEEDBACK_RULE_DESCRIPTION])
    expect(rules).toHaveLength(1)
  })

  it('ignores existing rules that carry no description', () => {
    const anonymous: WafRule = { action: 'block', expression: 'x' }
    const { rules } = mergeRules([anonymous], [buildTranscodeRule()])
    expect(rules).toHaveLength(2)
    expect(rules[0]).toEqual(anonymous)
  })
})

describe('rule builders', () => {
  it('gates the transcode skip on the service-token header', () => {
    const rule = buildTranscodeRule()
    expect(rule.expression).toContain('cf-access-client-id')
    expect(rule.expression).toContain('/transcode-complete')
    expect(rule.action).toBe('skip')
  })

  it('scopes the feedback skip to POST on exactly one path', () => {
    const rule = buildFeedbackRule()
    expect(rule.expression).toContain('"/api/feedback"')
    expect(rule.expression).toContain('http.request.method eq "POST"')
  })

  it('skips managed rules, SBFM, BIC and security level', () => {
    const params = buildTranscodeRule().action_parameters as {
      ruleset: string
      phases: string[]
      products: string[]
    }
    expect(params.ruleset).toBe('current')
    expect(params.phases).toContain('http_request_firewall_managed')
    expect(params.phases).toContain('http_request_sbfm')
    expect(params.products).toEqual(expect.arrayContaining(['bic', 'securityLevel']))
  })

  it('tags both rules so they are identifiable and idempotent', () => {
    for (const rule of [buildTranscodeRule(), buildFeedbackRule()]) {
      expect(rule.description?.startsWith(RULE_PREFIX)).toBe(true)
      expect(rule.enabled).toBe(true)
    }
  })
})

function stubWaf(
  getResponse: { status: number; body: unknown },
  onPut?: (rules: WafRule[]) => void,
): WafApi {
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PUT') {
      onPut?.(JSON.parse(String(init?.body)).rules)
      return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 })
    }
    return new Response(JSON.stringify(getResponse.body), {
      status: getResponse.status,
      statusText: getResponse.status === 404 ? 'Not Found' : 'OK',
    })
  }) as unknown as typeof fetch
  return new WafApi('zone1', { apiToken: 't', fetchImpl })
}

describe('ensureWafRules', () => {
  it('appends to the zone rules it read back', async () => {
    let put: WafRule[] | undefined
    const api = stubWaf(
      { status: 200, body: { success: true, result: { rules: [operatorRule('mine')] } } },
      rules => void (put = rules),
    )
    const res = await ensureWafRules(api, [buildTranscodeRule()], true)
    expect(res.existing).toBe(1)
    expect(res.added).toEqual([TRANSCODE_RULE_DESCRIPTION])
    expect(put?.map(r => r.description)).toEqual(['mine', TRANSCODE_RULE_DESCRIPTION])
  })

  // A zone that has never had a custom rule has no entrypoint. That
  // is "no rules", which is different from "failed to read".
  it('treats a missing entrypoint as an empty rule list', async () => {
    let put: WafRule[] | undefined
    const api = stubWaf({ status: 404, body: { success: false, errors: [] } }, rules => {
      put = rules
    })
    const res = await ensureWafRules(api, [buildFeedbackRule()], true)
    expect(res.existing).toBe(0)
    expect(put).toHaveLength(1)
  })

  // The dangerous case: if the read fails for any other reason,
  // writing would replace the operator's rules with just ours.
  it('aborts without writing when the read fails', async () => {
    let putCalled = false
    const api = stubWaf(
      { status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } },
      () => void (putCalled = true),
    )
    await expect(ensureWafRules(api, [buildTranscodeRule()], true)).rejects.toThrow(
      /Zone WAF/,
    )
    expect(putCalled).toBe(false)
  })

  it('writes nothing when both rules are already present', async () => {
    let putCalled = false
    const api = stubWaf(
      {
        status: 200,
        body: {
          success: true,
          result: { rules: [buildTranscodeRule(), buildFeedbackRule()] },
        },
      },
      () => void (putCalled = true),
    )
    const res = await ensureWafRules(api, [buildTranscodeRule(), buildFeedbackRule()], true)
    expect(res.changed).toBe(false)
    expect(putCalled).toBe(false)
  })

  it('does not write when apply is false', async () => {
    let putCalled = false
    const api = stubWaf(
      { status: 200, body: { success: true, result: { rules: [] } } },
      () => void (putCalled = true),
    )
    const res = await ensureWafRules(api, [buildTranscodeRule()], false)
    expect(res.added).toEqual([TRANSCODE_RULE_DESCRIPTION])
    expect(res.changed).toBe(false)
    expect(putCalled).toBe(false)
  })
})
