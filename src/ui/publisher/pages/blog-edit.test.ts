/**
 * Tests for the blog editor page — the Generate flow filling the
 * content fields, Save composing the create body from the grounding
 * selections, and the publish transition.
 */

import { describe, it, expect, vi } from 'vitest'
import { renderBlogEditPage } from './blog-edit'

const ADMIN_ME = { role: 'admin', is_admin: true }
const DATASETS = {
  datasets: [
    { id: 'DS_SST', slug: 'sst', title: 'Sea Surface Temperature', abstract: null, organization: 'NOAA', format: 'video/mp4', visibility: 'public', created_at: '', updated_at: '', published_at: '2026-01-01', retracted_at: null, publisher_id: null, legacy_id: null },
  ],
  next_cursor: null,
}
const EVENTS = {
  events: [
    {
      id: 'EVT1',
      title: 'Gulf marine heatwave',
      links: [
        // Approved link to the dataset the tests pick manually — the
        // seed dedupes against it; the proposed link must NOT seed.
        { datasetId: 'DS_SST', datasetTitle: 'Sea Surface Temperature', status: 'approved' },
        { datasetId: 'DS_PROPOSED', datasetTitle: 'Unvetted pairing', status: 'proposed' },
      ],
    },
  ],
}
const DRAFT = { draft: { title: 'AI Title', summary: 'AI summary.', bodyMd: '## AI body' }, tour: null, tourError: null }

interface Captured {
  posts: Array<{ url: string; body: unknown }>
  /** Every requested URL, in order — for asserting query params. */
  urls?: string[]
}

function mockFetch(capture: Captured, overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    ;(capture.urls ??= []).push(url)
    const method = init?.method ?? 'GET'
    let body: unknown = {}
    if (method === 'POST' || method === 'PUT') {
      capture.posts.push({ url, body: JSON.parse(String(init?.body)) })
      if (url.includes('/blog/generate')) body = overrides['generate'] ?? DRAFT
      else body = { post: { id: 'POST1', slug: 'ai-title', title: 'AI Title', summary: null, bodyMd: '## AI body', datasetIds: ['DS_SST'], eventId: null, status: url.includes('POST1') ? 'published' : 'draft', publishedAt: null } }
    } else if (url.includes('/publish/me')) body = ADMIN_ME
    else if (url.includes('/publish/datasets')) body = DATASETS
    else if (url.includes('/publish/events')) body = EVENTS
    return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
  })
}

const flush = () => new Promise<void>(r => setTimeout(r, 0))

async function mountEditor(capture: Captured) {
  const mount = document.createElement('div')
  await renderBlogEditPage(mount, { fetchFn: mockFetch(capture), navigate: vi.fn() })
  await flush() // catalog + events lazy loads
  return mount
}

function pickDataset(mount: HTMLElement): void {
  const search = mount.querySelector('input[type="search"]') as HTMLInputElement
  search.value = 'sea'
  search.dispatchEvent(new Event('input'))
  ;(mount.querySelector('.publisher-blog-candidate') as HTMLButtonElement).click()
}

describe('renderBlogEditPage', () => {
  it('Generate posts the grounding selections and fills the content fields', async () => {
    const capture: Captured = { posts: [] }
    const mount = await mountEditor(capture)

    pickDataset(mount)
    const evSelect = mount.querySelector('.publisher-blog-event-select') as HTMLSelectElement
    evSelect.value = 'EVT1'
    evSelect.dispatchEvent(new Event('change'))
    ;(mount.querySelector('#blog-include-tour') as HTMLInputElement).checked = true

    ;(mount.querySelector('.publisher-blog-generate-btn') as HTMLButtonElement).click()
    await flush()

    const gen = capture.posts.find(p => p.url.includes('/blog/generate'))!
    expect(gen.body).toEqual({
      datasetIds: ['DS_SST'],
      eventId: 'EVT1',
      length: 'medium',
      includeTour: true,
    })
    // The event picker offers curator-approved events only — a cited
    // proposed event would generate from unvetted text and its public
    // citation would silently never render.
    const eventsCall = capture.urls?.find(u => u.includes('/publish/events'))
    expect(eventsCall).toContain('status=approved')
    expect((mount.querySelector('#blog-title') as HTMLInputElement).value).toBe('AI Title')
    expect((mount.querySelector('#blog-body') as HTMLTextAreaElement).value).toBe('## AI body')
  })

  it('Generate refreshes an open Preview pane with the drafted body', async () => {
    const capture: Captured = { posts: [] }
    const mount = await mountEditor(capture)
    pickDataset(mount)

    // Open Preview first (empty body → empty-state hint).
    ;(mount.querySelector('.publisher-form-toggle') as HTMLButtonElement).click()
    const preview = mount.querySelector('.publisher-form-markdown-preview') as HTMLElement
    expect(preview.hidden).toBe(false)

    ;(mount.querySelector('.publisher-blog-generate-btn') as HTMLButtonElement).click()
    await flush()

    // The visible preview must reflect the generated markdown, not the
    // pre-generate empty state.
    expect(preview.querySelector('h2')?.textContent).toBe('AI body')
  })

  it('a generate-with-tour reveals the tour-preview link into the authoring dock', async () => {
    const capture: Captured = { posts: [] }
    const mount = document.createElement('div')
    await renderBlogEditPage(mount, {
      fetchFn: mockFetch(capture, {
        generate: { draft: DRAFT.draft, tour: { id: 'TOUR1' }, tourError: null },
      }),
      navigate: vi.fn(),
    })
    await flush()

    const link = mount.querySelector('.publisher-blog-tour-link') as HTMLAnchorElement
    expect(link.hidden).toBe(true)

    pickDataset(mount)
    ;(mount.querySelector('.publisher-blog-generate-btn') as HTMLButtonElement).click()
    await flush()

    expect(link.hidden).toBe(false)
    expect(link.getAttribute('href')).toBe('/?tourEdit=TOUR1')
  })

  it('a failed regenerate hides the previous attempt\'s tour link', async () => {
    const capture: Captured = { posts: [] }
    const mount = document.createElement('div')
    let failNext = false
    const failure = { error: 'generation_failed', message: 'The model call failed or timed out — try again.' }
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.includes('/blog/generate')) {
        if (failNext) {
          return { ok: false, status: 502, type: 'basic', json: async () => failure, text: async () => JSON.stringify(failure) } as unknown as Response
        }
        const body = { draft: DRAFT.draft, tour: { id: 'TOUR1' }, tourError: null }
        return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
      }
      let body: unknown = {}
      if (url.includes('/publish/me')) body = ADMIN_ME
      else if (url.includes('/publish/datasets')) body = DATASETS
      else if (url.includes('/publish/events')) body = EVENTS
      return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    })
    await renderBlogEditPage(mount, { fetchFn, navigate: vi.fn() })
    await flush()
    void capture

    pickDataset(mount)
    const genBtn = mount.querySelector('.publisher-blog-generate-btn') as HTMLButtonElement
    const link = mount.querySelector('.publisher-blog-tour-link') as HTMLAnchorElement
    genBtn.click()
    await flush()
    expect(link.hidden).toBe(false)

    failNext = true
    genBtn.click()
    await flush()
    expect(link.hidden).toBe(true)
  })

  it('citing an event seeds its APPROVED dataset links as chips (proposed excluded)', async () => {
    const capture: Captured = { posts: [] }
    const mount = await mountEditor(capture)

    // No chips yet; select the event.
    const evSelect = mount.querySelector('.publisher-blog-event-select') as HTMLSelectElement
    evSelect.value = 'EVT1'
    evSelect.dispatchEvent(new Event('change'))

    const chips = Array.from(mount.querySelectorAll('.publisher-blog-chip')).map(c => c.textContent)
    expect(chips.some(c => c?.includes('Sea Surface Temperature'))).toBe(true)
    // The unvetted pairing must not be seeded.
    expect(chips.some(c => c?.includes('Unvetted pairing'))).toBe(false)
    expect(chips).toHaveLength(1)
  })

  it('Generate surfaces the server\'s typed failure message (503 ai_unavailable)', async () => {
    const capture: Captured = { posts: [] }
    const mount = document.createElement('div')
    const failure = { error: 'ai_unavailable', message: 'Workers AI is not bound on this deployment.' }
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = init?.method ?? 'GET'
      if (method === 'POST' && url.includes('/blog/generate')) {
        capture.posts.push({ url, body: JSON.parse(String(init?.body)) })
        return { ok: false, status: 503, type: 'basic', json: async () => failure, text: async () => JSON.stringify(failure) } as unknown as Response
      }
      let body: unknown = {}
      if (url.includes('/publish/me')) body = ADMIN_ME
      else if (url.includes('/publish/datasets')) body = DATASETS
      else if (url.includes('/publish/events')) body = EVENTS
      return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    })
    await renderBlogEditPage(mount, { fetchFn, navigate: vi.fn() })
    await flush()

    pickDataset(mount)
    ;(mount.querySelector('.publisher-blog-generate-btn') as HTMLButtonElement).click()
    await flush()

    // The route's curator-facing message must reach the status line —
    // not the generic "Something went wrong."
    const statuses = Array.from(mount.querySelectorAll('.publisher-blog-status'))
    expect(statuses.some(s => s.textContent === 'Workers AI is not bound on this deployment.')).toBe(true)
  })

  it('Generate without datasets is blocked client-side', async () => {
    const capture: Captured = { posts: [] }
    const mount = await mountEditor(capture)
    ;(mount.querySelector('.publisher-blog-generate-btn') as HTMLButtonElement).click()
    await flush()
    expect(capture.posts).toHaveLength(0)
  })

  it('Save creates the post with the grounding citations', async () => {
    const capture: Captured = { posts: [] }
    const mount = await mountEditor(capture)
    pickDataset(mount)
    ;(mount.querySelector('#blog-title') as HTMLInputElement).value = 'Hand-written'
    ;(mount.querySelector('#blog-body') as HTMLTextAreaElement).value = 'Body text'
    ;(mount.querySelector('.publisher-blog-save-btn') as HTMLButtonElement).click()
    await flush()
    const save = capture.posts.find(p => p.url.endsWith('/publish/blog'))!
    expect(save.body).toEqual({
      title: 'Hand-written',
      summary: null,
      bodyMd: 'Body text',
      datasetIds: ['DS_SST'],
      eventId: null,
    })
  })

  it('shows the restricted card for a non-privileged caller', async () => {
    const mount = document.createElement('div')
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const body = url.includes('/publish/me') ? { role: 'publisher', is_admin: false } : {}
      return { ok: true, status: 200, type: 'basic', json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response
    })
    await renderBlogEditPage(mount, { fetchFn })
    expect(mount.querySelector('.publisher-blog-restricted')).toBeTruthy()
    expect(mount.querySelector('#blog-title')).toBeNull()
  })
})
