/**
 * Tests for the public blog surface — list cards, the sanitized post
 * page (markdown body, dataset deep links, event citation), and the
 * missing-post view.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootBlogPage } from './index'

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
