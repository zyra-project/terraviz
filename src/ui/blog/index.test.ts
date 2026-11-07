// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the public blog surface — list cards, the sanitized post
 * page (markdown body, dataset deep links, event citation), and the
 * missing-post view.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPageOptOut } from '../../analytics/pageOptOut'
import { bootBlogPage, carryTelemetry } from './index'

const LIST = {
  posts: [
    { slug: 'gulf-warming', title: 'Watching the Gulf warm', summary: 'Three decades of SST.', publishedAt: '2026-07-01T00:00:00.000Z', datasetCount: 2 },
  ],
}
const POST = {
  post: {
    slug: 'gulf-warming',
    title: 'Watching the Gulf warm',
    summary: 'Three decades of SST.',
    bodyMd: '## The data\nWe looked at the loop. <script>alert(1)</script>',
    publishedAt: '2026-07-01T00:00:00.000Z',
    datasets: [{ id: 'DS_SST', title: 'Sea Surface Temperature' }],
    event: { id: 'EVT1', title: 'Gulf marine heatwave', sourceName: 'NOAA', sourceUrl: 'https://example.gov/heatwave' },
  },
}

const IDENTITY = { profile: { orgName: 'The Zyra Project', logoUrl: 'https://assets.example.org/logo.png' } }

/** Stub fetch for the content endpoints; `/api/v1/node-profile`
 *  (the header identity) is routed separately. */
function stubFetch(status: number, body: unknown, identity: unknown = { profile: null }) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const isIdentity = url.includes('/api/v1/node-profile')
    return {
      ok: isIdentity ? true : status === 200,
      status: isIdentity ? 200 : status,
      json: async () => (isIdentity ? identity : body),
    } as unknown as Response
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.body.classList.remove('blog-body')
})

describe('bootBlogPage', () => {
  it('renders published-post cards on /blog', async () => {
    history.pushState(null, '', '/blog')
    stubFetch(200, LIST)
    await bootBlogPage()
    const card = document.querySelector('.blog-card') as HTMLAnchorElement
    expect(card.getAttribute('href')).toBe('/blog/gulf-warming')
    expect(card.textContent).toContain('Watching the Gulf warm')
  })

  it('renders the post: sanitized markdown, dataset deep links, event citation', async () => {
    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, POST)
    await bootBlogPage()
    const body = document.querySelector('.blog-post-body')!
    expect(body.querySelector('h2')?.textContent).toBe('The data')
    // The sanitizer must strip the script tag.
    expect(body.querySelector('script')).toBeNull()
    expect(body.innerHTML).not.toContain('<script>')

    const explore = document.querySelector('.blog-post-explore-list a') as HTMLAnchorElement
    expect(explore.getAttribute('href')).toBe('/dataset/DS_SST')
    const cite = document.querySelector('.blog-post-citation a') as HTMLAnchorElement
    expect(cite.getAttribute('href')).toBe('https://example.gov/heatwave')
    expect(cite.rel).toContain('noopener')
    // No playable tour on this post → no button.
    expect(document.querySelector('.blog-post-tour-btn')).toBeNull()
  })

  it('renders the event story image as a captioned lead figure, dropping non-http(s) urls', async () => {
    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, {
      post: { ...POST.post, event: { ...POST.post.event, imageUrl: 'https://img.example.org/heatwave.jpg' } },
    })
    await bootBlogPage()
    const img = document.querySelector('.blog-post-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://img.example.org/heatwave.jpg')
    // No stored alt → the event title is the accessible fallback.
    expect(img.alt).toBe('Gulf marine heatwave')
    expect(document.querySelector('.blog-post-figcaption')?.textContent).toBe('Gulf marine heatwave — NOAA')

    // A curator-written description wins over the title fallback.
    stubFetch(200, {
      post: {
        ...POST.post,
        event: { ...POST.post.event, imageUrl: 'https://img.example.org/heatwave.jpg', imageAlt: 'SST anomaly map' },
      },
    })
    await bootBlogPage()
    expect((document.querySelector('.blog-post-image') as HTMLImageElement).alt).toBe('SST anomaly map')

    // A dead image link drops the whole figure, caption included.
    const current = document.querySelector('.blog-post-image') as HTMLImageElement
    current.dispatchEvent(new Event('error'))
    expect(document.querySelector('.blog-post-figure')).toBeNull()
    expect(document.querySelector('.blog-post-figcaption')).toBeNull()

    // eslint-disable-next-line no-script-url
    stubFetch(200, { post: { ...POST.post, event: { ...POST.post.event, imageUrl: 'javascript:alert(1)' } } })
    await bootBlogPage()
    expect(document.querySelector('.blog-post-figure')).toBeNull()
  })

  it('renders no figure when the event carries no image', async () => {
    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, POST)
    await bootBlogPage()
    expect(document.querySelector('.blog-post-figure')).toBeNull()
  })

  it("prefers the post's cover image over the event image, with no citation caption", async () => {
    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, {
      post: {
        ...POST.post,
        coverImageUrl: 'https://img.example.org/cover.jpg',
        coverImageAlt: 'Curator-picked cover',
        // Even with an event image present, the cover wins.
        event: { ...POST.post.event, imageUrl: 'https://img.example.org/heatwave.jpg' },
      },
    })
    await bootBlogPage()
    const img = document.querySelector('.blog-post-image') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('https://img.example.org/cover.jpg')
    expect(img.alt).toBe('Curator-picked cover')
    // The cover is the post's own image — no event citation caption.
    expect(document.querySelector('.blog-post-figcaption')).toBeNull()

    // A non-http(s) cover falls back to the event image path.
    // eslint-disable-next-line no-script-url
    stubFetch(200, {
      post: {
        ...POST.post,
        coverImageUrl: 'javascript:alert(1)',
        event: { ...POST.post.event, imageUrl: 'https://img.example.org/heatwave.jpg' },
      },
    })
    await bootBlogPage()
    expect((document.querySelector('.blog-post-image') as HTMLImageElement).getAttribute('src')).toBe(
      'https://img.example.org/heatwave.jpg',
    )
    expect(document.querySelector('.blog-post-figcaption')?.textContent).toBe('Gulf marine heatwave — NOAA')
  })

  it('renders the Play-the-companion-tour button when the API surfaces one', async () => {
    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, { post: { ...POST.post, tour: { id: 'TR000AAAAAAAAAAAAAAAAAAAAA' } } })
    await bootBlogPage()
    const btn = document.querySelector('.blog-post-tour-btn') as HTMLAnchorElement
    expect(btn.getAttribute('href')).toBe('/?tour=TR000AAAAAAAAAAAAAAAAAAAAA')
  })

  it('renders the missing view for an unknown slug', async () => {
    history.pushState(null, '', '/blog/nope')
    stubFetch(404, { error: 'not_found' })
    await bootBlogPage()
    expect(document.querySelector('.blog-missing')).toBeTruthy()
    expect((document.querySelector('.blog-missing a') as HTMLAnchorElement).getAttribute('href')).toBe('/blog')
  })

  it('renders the missing view for a malformed percent-encoded slug', async () => {
    history.pushState(null, '', '/blog/%E0%A4')
    stubFetch(200, POST)
    await bootBlogPage()
    // decodeURIComponent throws on the truncated sequence — the page
    // must land on the missing view, not stick in the loading state.
    expect(document.querySelector('.blog-loading')).toBeNull()
    expect(document.querySelector('.blog-missing')).toBeTruthy()
  })

  it('renders the missing view on both routes when the blog feature is off', async () => {
    const off = { profile: { orgName: 'The Zyra Project', logoUrl: null }, features: { blog: false } }
    history.pushState(null, '', '/blog')
    stubFetch(200, LIST, off)
    await bootBlogPage()
    expect(document.querySelector('.blog-missing')).toBeTruthy()
    expect(document.querySelector('.blog-list')).toBeNull()
    // Header identity still renders — the node isn't anonymous, the
    // blog is just off.
    expect(document.querySelector('.blog-home-link')?.textContent).toContain('The Zyra Project')

    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, POST, off)
    await bootBlogPage()
    expect(document.querySelector('.blog-missing')).toBeTruthy()
    expect(document.querySelector('.blog-post')).toBeNull()
  })

  it('fails open (blog renders) when the identity read carries no features', async () => {
    history.pushState(null, '', '/blog')
    stubFetch(200, LIST, IDENTITY)
    await bootBlogPage()
    expect(document.querySelector('.blog-list')).toBeTruthy()
  })

  it('renders the org logo + name in the header when the identity is configured', async () => {
    history.pushState(null, '', '/blog')
    stubFetch(200, LIST, IDENTITY)
    await bootBlogPage()
    const logo = document.querySelector('.blog-home-link .blog-logo') as HTMLImageElement
    expect(logo.getAttribute('src')).toBe('https://assets.example.org/logo.png')
    expect(logo.alt).toBe('The Zyra Project')
    expect(document.querySelector('.blog-home-link')?.textContent).toContain('The Zyra Project')
  })

  it('drops a non-http(s) logo url and falls back to the app title without identity', async () => {
    history.pushState(null, '', '/blog')
    // eslint-disable-next-line no-script-url
    stubFetch(200, LIST, { profile: { orgName: 'Evil', logoUrl: 'javascript:alert(1)' } })
    await bootBlogPage()
    expect(document.querySelector('.blog-logo')).toBeNull()
    expect(document.querySelector('.blog-home-link')?.textContent).toContain('Evil')
  })
})

/** Every link on the page that loads a page of this app, by role. */
function appLinks(): Record<string, string | null> {
  const href = (selector: string): string | null =>
    document.querySelector<HTMLAnchorElement>(selector)?.getAttribute('href') ?? null
  return {
    home: href('.blog-home-link'),
    index: href('.blog-index-link'),
    tour: href('.blog-post-tour-btn'),
    dataset: href('.blog-post-explore-list a'),
  }
}

const TOUR_POST = { post: { ...POST.post, tour: { id: 'TR000AAAAAAAAAAAAAAAAAAAAA' } } }

describe('bootBlogPage carries the telemetry switch onto its links', () => {
  it("keeps a query telemetry value in each link's query, and no other key", async () => {
    history.pushState(null, '', '/blog/gulf-warming?telemetry=0&utm_source=newsletter&embed=1')
    stubFetch(200, TOUR_POST)
    await bootBlogPage()
    expect(appLinks()).toEqual({
      home: '/?telemetry=0',
      index: '/blog?telemetry=0',
      tour: '/?tour=TR000AAAAAAAAAAAAAAAAAAAAA&telemetry=0',
      dataset: '/dataset/DS_SST?telemetry=0',
    })
    // The source citation is another site's: the switch never leaves.
    expect(document.querySelector('.blog-post-citation a')?.getAttribute('href')).toBe('https://example.gov/heatwave')
  })

  it("keeps a fragment telemetry value in each link's fragment, and no anchor", async () => {
    history.pushState(null, '', '/blog/gulf-warming#methods&telemetry=off')
    stubFetch(200, TOUR_POST)
    await bootBlogPage()
    expect(appLinks()).toEqual({
      home: '/#telemetry=off',
      index: '/blog#telemetry=off',
      tour: '/?tour=TR000AAAAAAAAAAAAAAAAAAAAA#telemetry=off',
      dataset: '/dataset/DS_SST#telemetry=off',
    })
  })

  it('gives every link an address the next page reads as turned off', async () => {
    for (const address of ['/blog/gulf-warming?telemetry=0', '/blog/gulf-warming#telemetry=0']) {
      history.pushState(null, '', address)
      stubFetch(200, TOUR_POST)
      await bootBlogPage()
      for (const [role, href] of Object.entries(appLinks())) {
        const url = new URL(href ?? '', location.origin)
        expect(readPageOptOut({ search: url.search, hash: url.hash, gpc: false }), `${address} ${role}`).toBe('address')
      }
    }
  })

  it('carries every value of a repeated key, so an off value still wins', async () => {
    history.pushState(null, '', '/blog/gulf-warming?telemetry=1&telemetry=0')
    stubFetch(200, POST)
    await bootBlogPage()
    expect(appLinks().dataset).toBe('/dataset/DS_SST?telemetry=1&telemetry=0')
  })

  it('carries it onto the list cards and the missing view', async () => {
    history.pushState(null, '', '/blog?telemetry=0')
    stubFetch(200, LIST)
    await bootBlogPage()
    expect(document.querySelector('.blog-card')?.getAttribute('href')).toBe('/blog/gulf-warming?telemetry=0')

    history.pushState(null, '', '/blog/nope#telemetry=0')
    stubFetch(404, { error: 'not_found' })
    await bootBlogPage()
    expect(document.querySelector('.blog-missing a')?.getAttribute('href')).toBe('/blog#telemetry=0')
  })

  it('leaves the links bare when the address has no telemetry key', async () => {
    history.pushState(null, '', '/blog/gulf-warming?utm_source=newsletter#methods')
    stubFetch(200, TOUR_POST)
    await bootBlogPage()
    expect(appLinks()).toEqual({
      home: '/',
      index: '/blog',
      tour: '/?tour=TR000AAAAAAAAAAAAAAAAAAAAA',
      dataset: '/dataset/DS_SST',
    })
  })

  it('rebuilds a link as the visitor reaches for it, so a later #telemetry=0 is carried', async () => {
    history.pushState(null, '', '/blog/gulf-warming')
    stubFetch(200, POST)
    await bootBlogPage()
    const link = document.querySelector('.blog-post-explore-list a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/dataset/DS_SST')

    // A host writing the switch after the page loaded.
    history.replaceState(null, '', '/blog/gulf-warming#telemetry=0')
    for (const type of ['pointerdown', 'focus', 'contextmenu', 'click']) {
      link.setAttribute('href', '/stale')
      link.dispatchEvent(new Event(type))
      expect(link.getAttribute('href'), type).toBe('/dataset/DS_SST#telemetry=0')
    }
  })

  it('still carries what the page loaded with after an anchor replaces the fragment', async () => {
    history.pushState(null, '', '/blog/gulf-warming#telemetry=0')
    stubFetch(200, POST)
    await bootBlogPage()
    // An in-page link (`[Methods](#methods)`) replaces the part after
    // `#`, while the page keeps the switch it read at load.
    history.replaceState(null, '', '/blog/gulf-warming#methods')
    const link = document.querySelector('.blog-post-explore-list a') as HTMLAnchorElement
    link.dispatchEvent(new Event('pointerdown'))
    expect(link.getAttribute('href')).toBe('/dataset/DS_SST#telemetry=0')
  })

  it("carries it onto the post body's links into this site, and nowhere else", async () => {
    const origin = location.origin
    history.pushState(null, '', '/blog/gulf-warming?telemetry=0')
    stubFetch(200, {
      post: {
        ...POST.post,
        bodyMd: [
          '[the smoke](/dataset/smoke-ds)',
          '[the tour](/?tour=TR1)',
          `[absolute](${origin}/dataset/abs-ds#view)`,
          '[methods](#methods)',
          '[NOAA](https://www.noaa.gov/smoke)',
          '[relative](//evil.example/x)',
          '[mail](mailto:team@example.org)',
        ].join('\n\n'),
      },
    })
    await bootBlogPage()
    const hrefs = [...document.querySelectorAll('.blog-post-body a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual([
      '/dataset/smoke-ds?telemetry=0',
      '/?tour=TR1&telemetry=0',
      '/dataset/abs-ds?telemetry=0#view',
      '#methods',
      'https://www.noaa.gov/smoke',
      '//evil.example/x',
      'mailto:team@example.org',
    ])
  })
})

describe('carryTelemetry', () => {
  const none = { search: '', hash: '' }

  it('returns the destination unchanged when neither address has the key', () => {
    expect(carryTelemetry('/dataset/x?a=1#b', { search: '?lang=es', hash: '#top' }, none)).toBe('/dataset/x?a=1#b')
  })

  it("joins onto the destination's own query and fragment", () => {
    const now = { search: '?telemetry=0', hash: '#telemetry=no' }
    expect(carryTelemetry('/dataset/x?a=1#view', now, none)).toBe('/dataset/x?a=1&telemetry=0#view&telemetry=no')
    expect(carryTelemetry('/dataset/x?#', now, none)).toBe('/dataset/x?telemetry=0#telemetry=no')
  })

  it('takes the load-time and current values once each, and none the destination has', () => {
    const boot = { search: '?telemetry=0', hash: '#telemetry=0' }
    const now = { search: '?telemetry=0', hash: '#telemetry=false' }
    expect(carryTelemetry('/', now, boot)).toBe('/?telemetry=0#telemetry=0&telemetry=false')
    expect(carryTelemetry('/?telemetry=0', now, boot)).toBe('/?telemetry=0#telemetry=0&telemetry=false')
  })

  it('carries an empty or bare value, which turns reporting off', () => {
    expect(carryTelemetry('/', { search: '?telemetry', hash: '#telemetry=' }, none)).toBe('/?telemetry=#telemetry=')
  })

  it('encodes a value so it reads back the same', () => {
    const out = carryTelemetry('/', { search: '?telemetry=a%26b', hash: '' }, none)
    expect(new URL(out, 'https://node.example').searchParams.getAll('telemetry')).toEqual(['a&b'])
  })
})
