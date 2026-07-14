/**
 * Tests for the portal-side feature-toggle helpers.
 *
 * Coverage: fetchFeatures caching (one network read shared by every
 * caller), fail-open on network/server failure, normalization of the
 * wire payload, resetFeaturesCache, and the disabled-card renderer
 * (i18n'd heading/body, card classes, replaces prior content).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFeatures, fetchPublicOrgName, renderFeatureDisabledCard, resetFeaturesCache } from './features'
import { defaultFeatures } from '../../types/node-features'

function okFetch(features: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify({ profile: null, features }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch
}

describe('fetchFeatures', () => {
  afterEach(() => {
    resetFeaturesCache()
  })

  it('parses the toggle map from the public node-profile payload', async () => {
    const features = await fetchFeatures({ fetchFn: okFetch({ blog: false, events: false }) })
    expect(features.blog).toBe(false)
    expect(features.events).toBe(false)
    expect(features.datasets).toBe(true)
  })

  it('caches the promise — a second call makes no second fetch', async () => {
    const fetchFn = okFetch({ tours: false })
    const a = await fetchFeatures({ fetchFn })
    const b = await fetchFeatures({ fetchFn: vi.fn() as unknown as typeof fetch })
    expect(a).toEqual(b)
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('fetchPublicOrgName shares the same single read (no second fetch)', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({ profile: { orgName: 'Coastal Science Center', logoUrl: null }, features: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch
    const [features, orgName] = await Promise.all([
      fetchFeatures({ fetchFn }),
      fetchPublicOrgName({ fetchFn }),
    ])
    expect(features).toEqual(defaultFeatures())
    expect(orgName).toBe('Coastal Science Center')
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('fetchPublicOrgName degrades to null on failure', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    expect(await fetchPublicOrgName({ fetchFn: failing })).toBeNull()
  })

  it('resetFeaturesCache forces a refetch', async () => {
    const first = await fetchFeatures({ fetchFn: okFetch({ tours: false }) })
    expect(first.tours).toBe(false)
    resetFeaturesCache()
    const second = await fetchFeatures({ fetchFn: okFetch({}) })
    expect(second.tours).toBe(true)
  })

  it('fails open to all-enabled on a server error or a throwing fetch', async () => {
    const failing = vi.fn(async () => new Response('boom', { status: 500 })) as unknown as typeof fetch
    expect(await fetchFeatures({ fetchFn: failing })).toEqual(defaultFeatures())
    resetFeaturesCache()
    const throwing = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    expect(await fetchFeatures({ fetchFn: throwing })).toEqual(defaultFeatures())
  })

  it('normalizes a garbage features payload to all-enabled', async () => {
    expect(await fetchFeatures({ fetchFn: okFetch('nonsense') })).toEqual(defaultFeatures())
  })
})

describe('renderFeatureDisabledCard', () => {
  it('replaces the mount with the disabled card for the named feature', () => {
    const mount = document.createElement('div')
    mount.appendChild(document.createElement('table'))
    renderFeatureDisabledCard(mount, 'blog')
    expect(mount.querySelector('table')).toBeNull()
    const card = mount.querySelector('.publisher-feature-disabled')
    expect(card).not.toBeNull()
    expect(card?.classList.contains('publisher-card')).toBe(true)
    expect(mount.querySelector('.publisher-card-heading')?.textContent).toContain('Blog')
    expect(mount.querySelector('.publisher-feature-disabled-body')?.textContent).toContain('Blog')
  })
})
