import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDatasetDetailPage } from './dataset-detail'
import type { PublisherDatasetDetail } from '../types'

function dataset(
  overrides: Partial<PublisherDatasetDetail> = {},
): PublisherDatasetDetail {
  return {
    id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    slug: 'sst-anomaly-2026-04',
    title: 'Sea Surface Temperature Anomaly — April 2026',
    abstract: 'Monthly mean SST anomaly relative to 1991-2020 climatology.',
    organization: 'NOAA/PMEL',
    format: 'video/mp4',
    visibility: 'public',
    created_at: '2026-04-30T12:00:00Z',
    updated_at: '2026-04-30T12:30:00Z',
    published_at: '2026-04-30T12:30:00Z',
    retracted_at: null,
    publisher_id: 'PUB001',
    legacy_id: null,
    data_ref: 'r2:videos/01ABC/master.m3u8',
    thumbnail_ref: 'r2:datasets/01ABC/thumbnail.jpg',
    legend_ref: null,
    caption_ref: null,
    website_link: 'https://www.pmel.noaa.gov/sst-anomaly',
    start_time: '2026-04-01',
    end_time: '2026-04-30',
    period: 'P1M',
    run_tour_on_load: null,
    license_spdx: 'CC0-1.0',
    license_url: null,
    license_statement: null,
    attribution_text: 'Visualization by NOAA/PMEL',
    rights_holder: 'U.S. Government',
    doi: null,
    citation_text: null,
    ...overrides,
  }
}

function detailResponse(
  d: PublisherDatasetDetail,
  extras: {
    keywords?: string[]
    tags?: string[]
    thumbnail_url?: string | null
    legend_url?: string | null
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      dataset: d,
      thumbnail_url: extras.thumbnail_url ?? null,
      legend_url: extras.legend_url ?? null,
      keywords: extras.keywords ?? [],
      tags: extras.tags ?? [],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}

describe('renderDatasetDetailPage', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  it('fetches /api/v1/publish/datasets/:id with the URL-encoded id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, 'has/slash', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/publish/datasets/has%2Fslash',
      expect.anything(),
    )
  })

  it('renders image previews of the thumbnail + legend when resolved', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(dataset(), {
        thumbnail_url: 'https://assets.example/thumbnail.webp',
        legend_url: 'https://assets.example/legend.png',
      }),
    )
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const imgs = Array.from(
      mount.querySelectorAll<HTMLImageElement>('img.publisher-detail-media-img'),
    ).map(i => i.src)
    expect(imgs).toContain('https://assets.example/thumbnail.webp')
    expect(imgs).toContain('https://assets.example/legend.png')
  })

  it('omits the preview card when no thumbnail/legend resolved', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-media')).toBeNull()
  })

  it('renders the title, slug, and status badge in the header', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-title')?.textContent).toBe(
      'Sea Surface Temperature Anomaly — April 2026',
    )
    expect(mount.querySelector('.publisher-detail-slug')?.textContent).toBe(
      'sst-anomaly-2026-04',
    )
    expect(mount.querySelector<HTMLElement>('.publisher-badge-status')?.textContent).toBe(
      'Published',
    )
  })

  it('renders the back-to-list link', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const back = mount.querySelector<HTMLAnchorElement>('.publisher-back-link')
    expect(back?.getAttribute('href')).toBe('/publish/datasets')
    expect(back?.textContent).toContain('Back to all datasets')
  })

  it('renders the abstract section when abstract is non-null', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).toContain('Monthly mean SST anomaly')
  })

  it('omits the abstract section when abstract is null', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(detailResponse(dataset({ abstract: null })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-abstract')).toBeNull()
  })

  it('renders identity, lifecycle, assets, and licensing section headings', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const headings = Array.from(
      mount.querySelectorAll('.publisher-card-heading'),
    ).map(h => h.textContent)
    expect(headings).toContain('Identity')
    expect(headings).toContain('Lifecycle')
    expect(headings).toContain('Assets')
    expect(headings).toContain('Licensing & attribution')
  })

  it('renders the data_ref in a monospace value cell', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const monoValues = Array.from(
      mount.querySelectorAll('.publisher-field-value-mono'),
    ).map(el => el.textContent)
    expect(monoValues).toContain('r2:videos/01ABC/master.m3u8')
  })

  it('skips field rows with null values rather than rendering empty cells', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset({ doi: null })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).not.toContain('DOI')
  })

  it('renders the not-found card on a 404 response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await renderDatasetDetailPage(mount, 'missing', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).toContain('Dataset not found')
    // Back link still rendered so the user can recover.
    expect(mount.querySelector('.publisher-back-link')).not.toBeNull()
    // No Refresh button on the not-found state — the back link
    // is the right recovery action.
    expect(mount.querySelector('.publisher-button')).toBeNull()
  })

  it('renders keywords + tags as chips in the categorization card', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(dataset(), {
        keywords: ['sst', 'anomaly'],
        tags: ['demo'],
      }),
    )
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const headings = Array.from(
      mount.querySelectorAll('.publisher-card-heading'),
    ).map(h => h.textContent)
    expect(headings).toContain('Keywords & tags')
    const chipTexts = Array.from(mount.querySelectorAll('.publisher-chip-text')).map(
      el => el.textContent,
    )
    expect(chipTexts).toEqual(expect.arrayContaining(['sst', 'anomaly', 'demo']))
  })

  it('omits the categorization card when keywords and tags are empty', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const headings = Array.from(
      mount.querySelectorAll('.publisher-card-heading'),
    ).map(h => h.textContent)
    expect(headings).not.toContain('Keywords & tags')
  })

  it('renders an Edit button linking to the edit page', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const edit = mount.querySelector<HTMLAnchorElement>('.publisher-detail-edit')
    expect(edit).not.toBeNull()
    expect(edit?.getAttribute('href')).toBe(
      '/publish/datasets/01AAAAAAAAAAAAAAAAAAAAAAAA/edit',
    )
    expect(edit?.textContent).toBe('Edit')
  })

  it('hides Edit / Preview / Retract when the caller cannot edit the row', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset({ can_edit: false })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    // Read-only view: the row still renders, but none of the
    // owner-scoped mutation affordances appear.
    expect(mount.querySelector('.publisher-detail-edit')).toBeNull()
    expect(mount.querySelector('.publisher-detail-preview')).toBeNull()
    expect(mount.querySelector('.publisher-detail-title')?.textContent).toBe(
      'Sea Surface Temperature Anomaly — April 2026',
    )
  })

  it('Edit button delegates to routerNavigate on a plain click', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    const routerNavigate = vi.fn<(path: string) => void>()
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })
    const edit = mount.querySelector<HTMLAnchorElement>('.publisher-detail-edit')!
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    edit.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(true)
    expect(routerNavigate).toHaveBeenCalledWith(
      '/publish/datasets/01AAAAAAAAAAAAAAAAAAAAAAAA/edit',
    )
  })

  it('Edit button lets the browser handle modifier-clicks', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    const routerNavigate = vi.fn<(path: string) => void>()
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })
    const edit = mount.querySelector<HTMLAnchorElement>('.publisher-detail-edit')!
    const ev = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      button: 0,
      metaKey: true,
    })
    edit.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(routerNavigate).not.toHaveBeenCalled()
  })

  it('renders a Publish button on a draft row', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset({ published_at: null })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-publish')?.textContent).toBe(
      'Publish',
    )
    expect(mount.querySelector('.publisher-detail-retract')).toBeNull()
  })

  it('renders a Retract button on a published row', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-retract')?.textContent).toBe(
      'Retract',
    )
    expect(mount.querySelector('.publisher-detail-publish')).toBeNull()
  })

  it('renders a Publish button on a retracted row (re-publish path)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(detailResponse(dataset({ retracted_at: '2026-05-01T00:00:00Z' })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-publish')?.textContent).toBe(
      'Publish',
    )
  })

  it('skips the publish action when the publisher cancels the confirm prompt', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset({ published_at: null })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      confirmFn: () => false,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-publish')?.click()
    await new Promise(r => setTimeout(r, 0))
    // Only the initial GET — no POST to the publish endpoint.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('POSTs to /publish on confirm and refreshes the view', async () => {
    const draft = dataset({ published_at: null })
    const published = dataset({ published_at: '2026-05-10T00:00:00Z' })
    const fetchFn = vi
      .fn()
      // initial GET
      .mockResolvedValueOnce(detailResponse(draft))
      // POST publish
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ dataset: published, keywords: [], tags: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      // post-action GET
      .mockResolvedValueOnce(detailResponse(published))
    await renderDatasetDetailPage(mount, '01AAAAAAAAAAAAAAAAAAAAAAAA', {
      fetchFn: fetchFn as unknown as typeof fetch,
      confirmFn: () => true,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-publish')!.click()
    await new Promise(r => setTimeout(r, 0))
    // Wait for the post-action refetch to settle.
    await new Promise(r => setTimeout(r, 0))
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      '/api/v1/publish/datasets/01AAAAAAAAAAAAAAAAAAAAAAAA/publish',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(mount.querySelector<HTMLElement>('.publisher-badge-status')?.textContent).toBe(
      'Published',
    )
    expect(mount.querySelector('.publisher-detail-retract')).not.toBeNull()
  })

  it('POSTs to /retract on a published row', async () => {
    const published = dataset()
    const retracted = dataset({ retracted_at: '2026-05-10T00:00:00Z' })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(published))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ dataset: retracted, keywords: [], tags: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(detailResponse(retracted))
    await renderDatasetDetailPage(mount, '01AAAAAAAAAAAAAAAAAAAAAAAA', {
      fetchFn: fetchFn as unknown as typeof fetch,
      confirmFn: () => true,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-retract')!.click()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      '/api/v1/publish/datasets/01AAAAAAAAAAAAAAAAAAAAAAAA/retract',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('surfaces a validation error inline without flipping the badge', async () => {
    const draft = dataset({ published_at: null })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(draft))
      // POST publish → 400 with validation errors
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [{ field: 'data_ref', code: 'required', message: 'data_ref required' }],
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // post-action refetch — still a draft
      .mockResolvedValueOnce(detailResponse(draft))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      confirmFn: () => true,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-publish')!.click()
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    const banner = mount.querySelector('.publisher-detail-action-error')?.textContent ?? ''
    // The banner now surfaces the per-field server message so
    // the publisher can see what to fix without leaving the
    // page (was a generic "validation errors" string in 3pc/F).
    expect(banner).toContain('data_ref')
    expect(banner).toContain('data_ref required')
    expect(banner).toMatch(
      /validation/i,
    )
    expect(mount.querySelector<HTMLElement>('.publisher-badge-status')?.textContent).toBe(
      'Draft',
    )
  })

  it('renders a Preview button on a non-transcoding row', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-preview')?.textContent).toBe('Preview')
  })

  it('hides the Preview button while transcoding', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(detailResponse(dataset({ transcoding: 1, published_at: null })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: () => new Promise(() => {}),
    })
    expect(mount.querySelector('.publisher-detail-preview')).toBeNull()
  })

  it('restores focus to the Preview button on close (fix #1)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(dataset()))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: 'T', url: '/x', expires_in: 60 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const previewBtn = mount.querySelector<HTMLButtonElement>('.publisher-detail-preview')!
    previewBtn.focus()
    expect(document.activeElement).toBe(previewBtn)
    previewBtn.click()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    // Modal opened, focus moved into the URL input.
    const urlField = mount.querySelector<HTMLInputElement>('.publisher-modal-url')
    expect(document.activeElement).toBe(urlField)
    // Close → focus returns to the Preview button (not the
    // now-detached URL input). Without the fix the
    // `previouslyFocused` capture would have happened AFTER
    // `urlInput.focus()` and pointed at the URL field, so
    // the restore would attempt to focus an element that
    // had already been removed.
    const closeBtn = Array.from(
      mount.querySelectorAll<HTMLButtonElement>('.publisher-modal .publisher-button'),
    ).find(b => b.textContent === 'Close')!
    closeBtn.click()
    // MutationObserver runs in microtask queue; tick a few
    // times to let it fire.
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(document.activeElement).toBe(previewBtn)
  })

  it('preview modal carries dialog ARIA semantics', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(dataset()))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: 'T', url: '/x', expires_in: 60 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-preview')!.click()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    const modal = mount.querySelector<HTMLElement>('.publisher-modal')!
    expect(modal.getAttribute('role')).toBe('dialog')
    expect(modal.getAttribute('aria-modal')).toBe('true')
    const labelledBy = modal.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    const heading = modal.querySelector(`#${labelledBy}`)
    expect(heading?.textContent).toBe('Preview link ready')
  })

  it('opens a modal with the preview URL when Preview is clicked', async () => {
    const fetchFn = vi
      .fn()
      // initial GET
      .mockResolvedValueOnce(detailResponse(dataset()))
      // POST preview → token
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            token: 'PREVIEW-TOKEN-ABC',
            url: '/api/v1/datasets/01ABC/preview/PREVIEW-TOKEN-ABC',
            expires_in: 900,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    await renderDatasetDetailPage(mount, '01AAAAAAAAAAAAAAAAAAAAAAAA', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-preview')!.click()
    // microtask + a tick for the publisherSend promise + a tick for paint
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(mount.querySelector('.publisher-modal')).not.toBeNull()
    const urlField = mount.querySelector<HTMLInputElement>('.publisher-modal-url')
    // 3pe/D — modal renders the SPA-side
    // `/?preview=<token>&dataset=<id>` URL so the reviewer lands
    // on the live globe rendering of the draft. The token is
    // url-encoded; the dataset id is taken from the page's id
    // parameter, not the backend's `url` field.
    expect(urlField?.value).toContain('?preview=PREVIEW-TOKEN-ABC')
    expect(urlField?.value).toContain('&dataset=01AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(urlField?.value).not.toContain('/preview/PREVIEW-TOKEN-ABC')
  })

  it('does NOT open the preview modal if the user navigates away while the token POST is in flight', async () => {
    // PR #112 followup — dispatchPreview's async POST can
    // resolve after the user has navigated to a different
    // page. Without the ROUTE_CHANGE_START_EVENT guard, the
    // modal would mount on top of the next page's DOM (same
    // shape as the transcode poll-loop race /T fixed).
    let resolvePreview: (r: Response) => void = () => {}
    const previewPromise = new Promise<Response>(resolve => {
      resolvePreview = resolve
    })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(dataset()))
      .mockReturnValueOnce(previewPromise)
    await renderDatasetDetailPage(mount, '01AAAAAAAAAAAAAAAAAAAAAAAA', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-preview')!.click()
    // Promise dispatched, awaiting the preview response. User
    // navigates away — the router fires the start event before
    // the destination handler renders into `content`.
    window.dispatchEvent(
      new CustomEvent('publisher:routechange:start', {
        detail: { path: '/publish/datasets' },
      }),
    )
    // Plant a sentinel marker simulating the next page rendering
    // into the same mount, then resolve the in-flight preview
    // POST. The deferred dispatchPreview should bail without
    // clobbering the sentinel.
    mount.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'sentinel-next-page',
        textContent: 'next page content',
      }),
    )
    resolvePreview(
      new Response(
        JSON.stringify({
          token: 'PREVIEW-TOKEN-LATE',
          url: '/api/v1/datasets/01ABC/preview/PREVIEW-TOKEN-LATE',
          expires_in: 900,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    for (let i = 0; i < 8; i++) await Promise.resolve()
    // Sentinel survives — the late preview response didn't
    // open a modal over it.
    expect(mount.querySelector('.sentinel-next-page')).not.toBeNull()
    expect(mount.querySelector('.publisher-modal')).toBeNull()
  })

  it('surfaces the server error code in the action banner on 5xx', async () => {
    // 3pe-review/D — before this fix `kind: 'server'` fell through to
    // the "Couldn't reach the server" network message, hiding 503
    // codes like `preview_unconfigured` from publishers on mobile
    // without DevTools. Now the banner includes the status + the
    // typed `error` field from the JSON body so misconfig is
    // diagnosable from the portal.
    const fetchFn = vi
      .fn()
      // initial GET succeeds
      .mockResolvedValueOnce(detailResponse(dataset()))
      // POST preview returns 503 with the typed envelope
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'preview_unconfigured',
            message: 'Preview tokens are not configured on this deployment.',
          }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      // re-fetch after error for the banner paint
      .mockResolvedValueOnce(detailResponse(dataset()))
    await renderDatasetDetailPage(mount, '01AAAAAAAAAAAAAAAAAAAAAAAA', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-preview')!.click()
    for (let i = 0; i < 12; i++) await Promise.resolve()
    const banner = mount.querySelector('.publisher-detail-action-error')?.textContent ?? ''
    expect(banner).toContain('503')
    expect(banner).toContain('preview_unconfigured')
    // And the modal should NOT have opened.
    expect(mount.querySelector('.publisher-modal')).toBeNull()
  })

  it('closes the preview modal on Close click', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(dataset()))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ token: 'T', url: '/x', expires_in: 60 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    mount.querySelector<HTMLButtonElement>('.publisher-detail-preview')!.click()
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(mount.querySelector('.publisher-modal')).not.toBeNull()
    const closeBtn = Array.from(
      mount.querySelectorAll<HTMLButtonElement>('.publisher-modal .publisher-button'),
    ).find(b => b.textContent === 'Close')!
    closeBtn.click()
    expect(mount.querySelector('.publisher-modal')).toBeNull()
  })

  it('renders a Transcoding badge when transcoding=1', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(detailResponse(dataset({ published_at: null, transcoding: 1 })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      // Disable polling so the test doesn't hang on the loop.
      sleep: () => new Promise(() => {}),
    })
    expect(mount.querySelector('.publisher-badge-transcoding')?.textContent).toBe(
      'Transcoding…',
    )
  })

  it('disables Publish while transcoding', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(detailResponse(dataset({ published_at: null, transcoding: 1 })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: () => new Promise(() => {}),
    })
    const publish = mount.querySelector<HTMLButtonElement>('.publisher-detail-publish')
    expect(publish?.disabled).toBe(true)
  })

  it('polls the detail endpoint while transcoding and stops when it clears', async () => {
    const transcodingRow = dataset({ published_at: null, transcoding: 1 })
    const finishedRow = dataset({ published_at: null, transcoding: null })
    const fetchFn = vi
      .fn()
      // initial GET → transcoding
      .mockResolvedValueOnce(detailResponse(transcodingRow))
      // first poll → still transcoding
      .mockResolvedValueOnce(detailResponse(transcodingRow))
      // second poll → done
      .mockResolvedValueOnce(detailResponse(finishedRow))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      // Resolve immediately so the loop ticks without real timers.
      sleep: () => Promise.resolve(),
      transcodePollIntervalMs: 0,
    })
    // Let the loop run a few microtask ticks.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // Three GETs total: initial + 2 polls. The badge should be gone
    // and the Publish button enabled after the second poll lands.
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect(mount.querySelector('.publisher-badge-transcoding')).toBeNull()
    const publish = mount.querySelector<HTMLButtonElement>('.publisher-detail-publish')
    expect(publish?.disabled).toBe(false)
  })

  it('tears down the poll loop and renders not-found when the dataset is deleted mid-transcode', async () => {
    // PR #112 followup — the earlier shape treated every
    // non-session error from a poll tick as transient. A
    // dataset deleted mid-transcode would leave the UI
    // showing the stale "Transcoding…" badge forever, with
    // the poll loop hammering the 404'd endpoint every 5 s.
    const transcodingRow = dataset({ published_at: null, transcoding: 1 })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(transcodingRow))
      // Second tick: row deleted out from under the page.
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      transcodePollIntervalMs: 0,
    })
    // The second fetch landed: the poll tick hit 404, the
    // loop tore down, and the page renders the not-found
    // error card. The transcoding badge is gone.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(mount.querySelector('.publisher-badge-transcoding')).toBeNull()
    expect(mount.textContent).toContain('Dataset not found')
  })

  it('tears down the poll loop on a session error before rendering the session card', async () => {
    // PR #112 followup — the session-error branch used to
    // return without calling stopTranscodePolling, leaving
    // the AbortController + routechange listener registered
    // for this mount until some later navigation cleaned up.
    // The fix is symmetric with the not_found case.
    const transcodingRow = dataset({ published_at: null, transcoding: 1 })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(transcodingRow))
      // Second tick: session expired.
      .mockResolvedValueOnce(
        new Response('', { status: 401 }),
      )
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      transcodePollIntervalMs: 0,
    })
    // Let the poll tick land + the session-error path run.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(2)
    // No more fetches even if the loop's sleep promise
    // resolves later — the loop was aborted.
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('aborts the transcode poller when the router fires a routechange away from this page', async () => {
    // The router replaces the children of `content` rather than
    // swapping the element itself, so without a routechange
    // listener the poll loop would keep ticking after the user
    // navigated away and stomp on whatever page replaced it.
    // Migration 0012 / PR #112 Copilot.
    const transcodingRow = dataset({ published_at: null, transcoding: 1 })
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(transcodingRow))
    const sleepResolvers: Array<() => void> = []
    const sleep = (): Promise<void> =>
      new Promise<void>(resolve => {
        sleepResolvers.push(resolve)
      })
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep,
      transcodePollIntervalMs: 1,
    })
    // Initial GET ran; the loop is now sleeping inside our
    // controllable promise. Fire a routechange to a different
    // path — the listener should abort the controller.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    window.dispatchEvent(
      new CustomEvent('publisher:routechange:start', { detail: { path: '/publish/datasets' } }),
    )
    // Resolve the in-flight sleep so the loop wakes up. After
    // resuming it should observe the aborted signal and exit
    // without firing the poll fetch.
    sleepResolvers[0]?.()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('aborts the transcode poller on routechange:start (before the destination handler renders)', async () => {
    // Regression test for the race the previous test couldn't
    // catch: the router fires `publisher:routechange:start`
    // *before* the destination route handler runs, so the loop
    // tears down before the new page can mount into `content`.
    // Without this, a poll tick scheduled between the new page
    // rendering and the (post-handler) `routechange` end event
    // would `paint(content, ...)` over the freshly-mounted DOM.
    // PR #112 followup — dataset-detail.ts:682.
    //
    // The check: dispatch routechange:start, paint() a sentinel
    // marker into content (simulating the destination page
    // rendering into the same mount), resolve the in-flight
    // sleep so the loop wakes up — it must NOT replace our
    // sentinel.
    const transcodingRow = dataset({ published_at: null, transcoding: 1 })
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(transcodingRow))
    const sleepResolvers: Array<() => void> = []
    const sleep = (): Promise<void> =>
      new Promise<void>(resolve => {
        sleepResolvers.push(resolve)
      })
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep,
      transcodePollIntervalMs: 1,
    })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // Step 1: fire routechange:start as the router would.
    window.dispatchEvent(
      new CustomEvent('publisher:routechange:start', {
        detail: { path: '/publish/datasets' },
      }),
    )
    // Step 2: the new page renders into the same content mount.
    mount.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'sentinel-new-page',
      textContent: 'new page content',
    }))
    // Step 3: resolve the in-flight sleep so the loop wakes up.
    // The aborted controller should make it exit without
    // refetching or repainting.
    sleepResolvers[0]?.()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    // The sentinel is still there — the loop did NOT paint over it.
    expect(mount.querySelector('.sentinel-new-page')).not.toBeNull()
  })

  it('keeps the transcode poller running across a routechange that lands on the same path', async () => {
    // The listener should only abort on a path mismatch — a
    // popstate that re-fires the same path (e.g. user clicks
    // a same-page anchor) shouldn't kill the poll loop.
    const transcodingRow = dataset({ published_at: null, transcoding: 1 })
    const finishedRow = dataset({ published_at: null, transcoding: null })
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(transcodingRow))
      .mockResolvedValueOnce(detailResponse(finishedRow))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      transcodePollIntervalMs: 0,
    })
    // Routechange that says "we're still here" — listener should
    // be a no-op.
    window.dispatchEvent(
      new CustomEvent('publisher:routechange:start', {
        detail: { path: '/publish/datasets/01ABC' },
      }),
    )
    for (let i = 0; i < 20; i++) await Promise.resolve()
    // Initial GET + at least one poll — the poller continued past
    // the same-path routechange and hit the finishedRow on the
    // next tick.
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('renders the retracted-state badge for a retracted row', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(detailResponse(dataset({ retracted_at: '2026-05-01T00:00:00Z' })))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const badge = mount.querySelector<HTMLElement>('.publisher-badge-status')
    expect(badge?.textContent).toBe('Retracted')
    expect(badge?.dataset.status).toBe('suspended')
  })

  it('renders the server-error card on a 5xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).toContain('server returned an error')
  })

  it('delegates session errors to the shared handler', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 401 }))
    const navigate = vi.fn()
    await renderDatasetDetailPage(mount, '01ABC', {
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    })
    expect(navigate).toHaveBeenCalledOnce()
  })
})
