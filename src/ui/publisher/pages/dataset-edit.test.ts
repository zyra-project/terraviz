import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDatasetEditPage } from './dataset-edit'
import type { PublisherDatasetDetail } from '../types'

function dataset(
  overrides: Partial<PublisherDatasetDetail> = {},
): PublisherDatasetDetail {
  return {
    id: '01EDIT0000000000000000000',
    slug: 'edit-me',
    title: 'Existing dataset',
    abstract: 'Original abstract.',
    organization: 'NOAA',
    format: 'video/mp4',
    visibility: 'public',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    published_at: null,
    retracted_at: null,
    publisher_id: 'PUB001',
    legacy_id: null,
    data_ref: 'vimeo:123',
    thumbnail_ref: null,
    legend_ref: null,
    caption_ref: null,
    website_link: null,
    start_time: null,
    end_time: null,
    period: null,
    run_tour_on_load: null,
    license_spdx: 'CC0-1.0',
    license_url: null,
    license_statement: null,
    attribution_text: null,
    rights_holder: null,
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
    data_url?: string | null
    thumbnail_url?: string | null
    legend_url?: string | null
  } = {},
): Response {
  return new Response(
    JSON.stringify({
      dataset: d,
      data_url: extras.data_url ?? null,
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

describe('renderDatasetEditPage', () => {
  let mount: HTMLDivElement

  beforeEach(() => {
    mount = document.createElement('div')
    document.body.appendChild(mount)
    sessionStorage.clear()
  })

  it('fetches /api/v1/publish/datasets/:id with the URL-encoded id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetEditPage(mount, 'has/slash', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/publish/datasets/has%2Fslash',
      expect.anything(),
    )
  })

  it('renders the edit heading and prefills the title field', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset()))
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-detail-title')?.textContent).toBe(
      'Edit dataset',
    )
    expect(mount.querySelector<HTMLInputElement>('#dataset-title')?.value).toBe(
      'Existing dataset',
    )
  })

  it('redirects a non-owner (can_edit=false) to the read-only detail page instead of the form', async () => {
    const fetchFn = vi.fn().mockResolvedValue(detailResponse(dataset({ can_edit: false })))
    const navigate = vi.fn<(url: string) => void>()
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
      navigate,
    })
    expect(navigate).toHaveBeenCalledWith('/publish/datasets/01EDIT0000000000000000000')
    // The form is not mounted for a read-only caller.
    expect(mount.querySelector<HTMLInputElement>('#dataset-title')).toBeNull()
  })

  it('surfaces the existing data_ref via the asset uploader’s "current" line + the manual override input', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(dataset({ data_ref: 'r2:videos/01XYZ/master.m3u8' })),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    // The asset-uploader component surfaces the row's existing
    // ref through a "Current reference:" read-only line above
    // the file picker.
    const currentValue = mount.querySelector('.publisher-asset-uploader-current-value')
    expect(currentValue?.textContent).toBe('r2:videos/01XYZ/master.m3u8')
    // The manual override input (3pd-review2/D fix #5) is also
    // mounted in edit mode so editors can swap to a legacy
    // `vimeo:` / `url:` ref without re-uploading bytes.
    const manualInput = mount.querySelector<HTMLInputElement>('#dataset-data-ref')
    expect(manualInput).not.toBeNull()
    expect(manualInput?.value).toBe('r2:videos/01XYZ/master.m3u8')
  })

  it('mounts thumbnail + legend uploaders in edit mode and prefills their manual refs', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(
        dataset({
          thumbnail_ref: 'r2:datasets/01EDIT/thumbnail.png',
          legend_ref: 'r2:datasets/01EDIT/legend.png',
        }),
      ),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    // Three uploaders now: data + thumbnail + legend.
    expect(mount.querySelectorAll('.publisher-asset-uploader').length).toBe(3)
    // Manual ref inputs prefill from the row.
    expect(mount.querySelector<HTMLInputElement>('#dataset-thumbnail-ref')?.value).toBe(
      'r2:datasets/01EDIT/thumbnail.png',
    )
    expect(mount.querySelector<HTMLInputElement>('#dataset-legend-ref')?.value).toBe(
      'r2:datasets/01EDIT/legend.png',
    )
  })

  it('offers "generate from this dataset\'s data" for an image dataset with a resolved data URL', async () => {
    // The server resolves the row's `r2:` data_ref to a public URL
    // (`data_url`) — so an already-uploaded image gets the one-click
    // path without re-uploading.
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(
        dataset({ format: 'image/png', data_ref: 'r2:datasets/01EDIT/by-digest/aa/asset.png' }),
        { data_url: 'https://assets.example/datasets/01EDIT/by-digest/aa/asset.png' },
      ),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).toContain('Generate from this dataset')
  })

  it('hides the one-click button for an image dataset when no data URL resolved', async () => {
    // No `data_url` (e.g. R2 public base not bound) → the one-click
    // path is hidden; the manual frame picker still works.
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(
        dataset({ format: 'image/png', data_ref: 'r2:datasets/01EDIT/by-digest/aa/asset.png' }),
        { data_url: null },
      ),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-asset-uploader-generate')).not.toBeNull()
    expect(mount.textContent).not.toContain('Generate from this dataset')
  })

  it('offers the data-source button for a video dataset with a resolved HLS URL', async () => {
    // The resolved `data_url` is the dataset's HLS playlist; the
    // uploader loads it into a scrubable video so the publisher picks
    // a frame.
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(
        dataset({ format: 'video/mp4', data_ref: 'r2:videos/01EDIT/master.m3u8' }),
        { data_url: 'https://assets.example/videos/01EDIT/master.m3u8' },
      ),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).toContain('Generate from this dataset')
  })

  it('omits the data-source button for a legacy video dataset with no resolved URL', async () => {
    // A `vimeo:` data_ref doesn't resolve to a public URL → null
    // data_url → manual-frame path only.
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(dataset({ format: 'video/mp4', data_ref: 'vimeo:123' }), {
        data_url: null,
      }),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector('.publisher-asset-uploader-generate')).not.toBeNull()
    expect(mount.textContent).not.toContain('Generate from this dataset')
  })

  it('shows image previews of the current thumbnail + legend', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(
        dataset({
          thumbnail_ref: 'r2:datasets/01EDIT/thumbnail.webp',
          legend_ref: 'r2:datasets/01EDIT/legend.png',
        }),
        {
          thumbnail_url: 'https://assets.example/thumbnail.webp',
          legend_url: 'https://assets.example/legend.png',
        },
      ),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const previews = Array.from(
      mount.querySelectorAll<HTMLImageElement>('img.publisher-form-aux-preview'),
    ).map(i => i.src)
    expect(previews).toContain('https://assets.example/thumbnail.webp')
    expect(previews).toContain('https://assets.example/legend.png')
  })

  it('prefills the geography & projection fields from the row', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(
        dataset({
          bbox_n: 60,
          bbox_s: 20,
          bbox_w: -10,
          bbox_e: 30,
          lon_origin: 180,
          is_flipped_in_y: 1,
          celestial_body: 'Mars',
          radius_mi: 2106,
        }),
      ),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.querySelector<HTMLInputElement>('#dataset-bbox-n')?.value).toBe('60')
    expect(mount.querySelector<HTMLInputElement>('#dataset-bbox-e')?.value).toBe('30')
    expect(mount.querySelector<HTMLInputElement>('#dataset-lon-origin')?.value).toBe('180')
    expect(mount.querySelector<HTMLInputElement>('#dataset-flipped-y')?.checked).toBe(true)
    expect(mount.querySelector<HTMLInputElement>('#dataset-celestial-body')?.value).toBe('Mars')
    expect(mount.querySelector<HTMLInputElement>('#dataset-radius-mi')?.value).toBe('2106')
  })

  it('prefills keyword chips from the decoration arrays', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(dataset(), { keywords: ['sst', 'anomaly'], tags: ['demo'] }),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    const chipTexts = Array.from(mount.querySelectorAll('.publisher-chip-text')).map(
      el => el.textContent,
    )
    expect(chipTexts).toEqual(expect.arrayContaining(['sst', 'anomaly', 'demo']))
  })

  it('replaces the asset uploader with a transcoding notice when the row is mid-transcode', async () => {
    // Migration 0012 — the form's UI gate is the publisher-facing
    // counterpart to the server-side `transcoding_in_progress`
    // refusal in /asset/.../complete. Mounting the active uploader
    // would let an editor start a second upload that the server
    // would 409 anyway; the notice is a clearer signal.
    const fetchFn = vi.fn().mockResolvedValue(
      detailResponse(
        dataset({
          transcoding: 1,
          data_ref: 'r2:videos/01XYZ/PRIOR-UPLOAD/master.m3u8',
        }),
      ),
    )
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    // The data uploader is replaced by the notice; only the two
    // auxiliary uploaders (thumbnail + legend) remain — those are
    // independent of the data transcode and stay available.
    expect(mount.querySelectorAll('.publisher-asset-uploader').length).toBe(2)
    // Manual-ref input is also hidden — pasting a ref into a
    // soon-to-be-overwritten data_ref would just cause a race.
    expect(mount.querySelector('#dataset-data-ref')).toBeNull()
    // Notice + the current ref both rendered so the editor sees
    // what's about to change.
    expect(mount.querySelector('.publisher-form-notice')?.textContent).toContain(
      'video transcode is in progress',
    )
    expect(
      mount.querySelector('.publisher-asset-uploader-current')?.textContent,
    ).toBe('r2:videos/01XYZ/PRIOR-UPLOAD/master.m3u8')
  })

  it('renders the not-found card on a 404 response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await renderDatasetEditPage(mount, 'missing', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).toContain('Dataset not found')
    expect(mount.querySelector('.publisher-back-link')).not.toBeNull()
    expect(mount.querySelector('form.publisher-form')).toBeNull()
  })

  it('renders the server-error card on a 5xx response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 503 }))
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
    })
    expect(mount.textContent).toContain('server returned an error')
    expect(mount.querySelector('form.publisher-form')).toBeNull()
  })

  it('PUTs to /api/v1/publish/datasets/:id on submit', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(detailResponse(dataset()))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ dataset: dataset() }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    const routerNavigate = vi.fn()
    await renderDatasetEditPage(mount, '01EDIT0000000000000000000', {
      fetchFn: fetchFn as unknown as typeof fetch,
      routerNavigate,
    })
    const form = mount.querySelector<HTMLFormElement>('form.publisher-form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await new Promise(r => setTimeout(r, 0))
    expect(fetchFn).toHaveBeenLastCalledWith(
      '/api/v1/publish/datasets/01EDIT0000000000000000000',
      expect.objectContaining({ method: 'PUT' }),
    )
  })
})
