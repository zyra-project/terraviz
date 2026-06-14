import { describe, expect, it } from 'vitest'

import { matchFixture, type FixtureRule } from './fixtures'
import { publisherFixtures } from '../fixtures/publisher'

describe('matchFixture', () => {
  const rules: FixtureRule[] = [
    { url: '/api/v1/publish/me', json: { role: 'admin' } },
    { url: /\/datasets\/[^/?]+(\?|$)/, json: { dataset: { id: 'x' } } },
    { url: '/api/v1/publish/datasets', json: { datasets: [] } },
    { url: '/api/v1/publish/datasets', method: 'POST', status: 201, json: { ok: true } },
  ]

  it('returns the first matching rule and serializes json', () => {
    const r = matchFixture(rules, 'http://h/api/v1/publish/me', 'GET')
    expect(r).toEqual({
      status: 200,
      contentType: 'application/json',
      body: '{"role":"admin"}',
    })
  })

  it('prefers an earlier specific rule (detail before list)', () => {
    const r = matchFixture(rules, 'http://h/api/v1/publish/datasets/01ABC', 'GET')
    expect(r?.body).toBe('{"dataset":{"id":"x"}}')
  })

  it('falls through to the list rule for the collection URL', () => {
    const r = matchFixture(rules, 'http://h/api/v1/publish/datasets?limit=20', 'GET')
    expect(r?.body).toBe('{"datasets":[]}')
  })

  it('respects the method filter', () => {
    const get = matchFixture(rules, 'http://h/api/v1/publish/datasets', 'GET')
    expect(get?.status).toBe(200)
    // The GET list rule comes first, so POST also matches it here unless
    // a method-specific rule precedes it — assert the method gate itself.
    const onlyPost: FixtureRule[] = [
      { url: '/x', method: 'POST', status: 201, json: { ok: true } },
    ]
    expect(matchFixture(onlyPost, 'http://h/x', 'GET')).toBeNull()
    expect(matchFixture(onlyPost, 'http://h/x', 'POST')?.status).toBe(201)
  })

  it('returns null when nothing matches', () => {
    expect(matchFixture(rules, 'http://h/api/other', 'GET')).toBeNull()
  })
})

describe('publisherFixtures', () => {
  it('serves an admin identity when admin is set', () => {
    const admin = matchFixture(
      publisherFixtures({ admin: true }),
      'http://h/api/v1/publish/me',
      'GET',
    )
    expect(admin?.body).toContain('"is_admin":true')
    expect(admin?.body).toContain('"role":"admin"')
  })

  it('serves a non-admin identity by default', () => {
    const me = matchFixture(
      publisherFixtures(),
      'http://h/api/v1/publish/me',
      'GET',
    )
    expect(me?.body).toContain('"is_admin":false')
  })

  it('resolves dataset detail ahead of the dataset list', () => {
    const rules = publisherFixtures()
    const detail = matchFixture(rules, 'http://h/api/v1/publish/datasets/01ABC', 'GET')
    const list = matchFixture(rules, 'http://h/api/v1/publish/datasets', 'GET')
    expect(detail?.body).toContain('"keywords"')
    expect(list?.body).toContain('"datasets"')
    expect(list?.body).not.toContain('"keywords"')
  })
})
