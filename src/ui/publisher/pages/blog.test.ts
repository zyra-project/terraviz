// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the blog authoring list — the public "View post" link on
 * published rows (and its absence on drafts).
 */

import { describe, expect, it, vi } from 'vitest'
import { renderBlogPage } from './blog'

const LIST = {
  posts: [
    { id: 'P1', slug: 'live-post', title: 'Live post', status: 'published', updatedAt: '2026-07-01T00:00:00.000Z', publishedAt: '2026-07-01T00:00:00.000Z' },
    { id: 'P2', slug: 'wip', title: 'Work in progress', status: 'draft', updatedAt: '2026-07-02T00:00:00.000Z', publishedAt: null },
  ],
}

function mockFetch(meRole = 'admin') {
  const me = { role: meRole, is_admin: meRole === 'admin' }
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    const body = url.includes('/publish/me') ? me : LIST
    return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
  })
}

describe('renderBlogPage', () => {
  it('published rows link to the public post; drafts do not', async () => {
    const mount = document.createElement('div')
    await renderBlogPage(mount, { fetchFn: mockFetch(), navigate: vi.fn() })

    const views = Array.from(mount.querySelectorAll('.publisher-blog-view-link')) as HTMLAnchorElement[]
    expect(views).toHaveLength(1)
    expect(views[0].getAttribute('href')).toBe('/blog/live-post')
    expect(views[0].rel).toContain('noopener')
  })

  it('shows the New-post button for an author but hides it for a reviewer', async () => {
    const authorMount = document.createElement('div')
    await renderBlogPage(authorMount, { fetchFn: mockFetch('author'), navigate: vi.fn() })
    expect(authorMount.querySelector('.publisher-blog-new-btn')).not.toBeNull()

    const reviewerMount = document.createElement('div')
    await renderBlogPage(reviewerMount, { fetchFn: mockFetch('reviewer'), navigate: vi.fn() })
    expect(reviewerMount.querySelector('.publisher-blog-new-btn')).toBeNull()
  })
})
