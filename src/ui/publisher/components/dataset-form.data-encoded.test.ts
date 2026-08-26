// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderDatasetForm } from './dataset-form'
import { renderDatasetEditPage } from '../pages/dataset-edit'
import type { PublisherDatasetDetail } from '../types'
import { until } from '../../../test-utils'

const EDIT_ID = '01EDIT0000000000000000000'

/** Minimal saved row. Mirrors `dataset-edit.test.ts`'s fixture — the
 *  edit path only reaches the form through the page, which fetches the
 *  row first, so mounting the form directly cannot exercise it. */
function savedRow(overrides: Partial<PublisherDatasetDetail> = {}): PublisherDatasetDetail {
  return {
    id: EDIT_ID, slug: 'edit-me', title: 'Existing dataset', abstract: null,
    organization: null, format: 'video/mp4', visibility: 'private',
    created_at: '2026-04-01T00:00:00Z', updated_at: '2026-04-02T00:00:00Z',
    published_at: null, retracted_at: null, publisher_id: 'PUB001',
    legacy_id: null, data_ref: 'vimeo:123', thumbnail_ref: null,
    legend_ref: null, caption_ref: null, website_link: null,
    start_time: null, end_time: null, period: null, run_tour_on_load: null,
    license_spdx: 'CC0-1.0', license_url: null, license_statement: null,
    attribution_text: null, rights_holder: null, doi: null, citation_text: null,
    ...overrides,
  } as PublisherDatasetDetail
}

function detailResponse(d: PublisherDatasetDetail): Response {
  return new Response(JSON.stringify({
    dataset: d, data_url: null, thumbnail_url: null, legend_url: null,
    keywords: [], tags: [],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

async function mountEdit(row: PublisherDatasetDetail): Promise<{
  root: HTMLElement
  fetchFn: ReturnType<typeof vi.fn>
}> {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const fetchFn = vi.fn()
    .mockResolvedValueOnce(detailResponse(row))
    .mockResolvedValue(new Response(JSON.stringify({ dataset: { id: EDIT_ID } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }))
  await renderDatasetEditPage(root, EDIT_ID, {
    fetchFn: fetchFn as unknown as typeof fetch,
  } as unknown as Parameters<typeof renderDatasetEditPage>[2])
  return { root, fetchFn }
}

/**
 * The data-encoded controls, which are the only way to publish a
 * dataset whose luma carries values rather than a picture.
 *
 * The behaviour worth pinning is the *ordering*: `render_encoding` is
 * read off the row by the transcode when it fires, so a row that
 * acquires the flag after its bytes are uploaded is one that claims to
 * carry values it has already lost to a bicubic rescale. These assert
 * that the upload cannot start before the sidecar is readable.
 */

const VALID_SCALE = JSON.stringify({
  stops: [
    { t: 0, rgba: [68, 1, 84, 0] },
    { t: 1, rgba: [253, 231, 37, 255] },
  ],
  vmin: -35,
  vmax: 78.025,
  units: 'dBZ',
  dataMinLuma: 8,
})

function mount(overrides: Record<string, unknown> = {}): {
  root: HTMLElement
  fetchFn: ReturnType<typeof vi.fn>
} {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const fetchFn = vi.fn(async () =>
    new Response(JSON.stringify({ dataset: { id: 'ds1' } }), { status: 200 }))
  renderDatasetForm(root, {
    mode: 'create',
    navigate: vi.fn(),
    fetchFn: fetchFn as unknown as typeof fetch,
    ...overrides,
  } as unknown as Parameters<typeof renderDatasetForm>[1])
  return { root, fetchFn }
}

function toggle(root: HTMLElement): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>('#dataset-data-encoded')
}

function scaleBox(root: HTMLElement): HTMLTextAreaElement | null {
  return root.querySelector<HTMLTextAreaElement>('#dataset-color-scale')
}

/** Walk to the Media step — the form is a stepper and only the active
 *  section is in the DOM's visible flow. */
function openMedia(root: HTMLElement): void {
  const nav = root.querySelector<HTMLElement>(
    '.publisher-form-nav-link[data-section="ds-section-media"]')
  if (!nav) throw new Error('media step nav button not found')
  nav.click()
}

describe('dataset form — data-encoded controls', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('offers the encoding toggle, off by default', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)
    expect(box).not.toBeNull()
    expect(box?.checked).toBe(false)
    // The sidecar field only exists once the mode is chosen — an
    // always-visible JSON textarea on a picture dataset is noise.
    expect(scaleBox(root)).toBeNull()
  })

  it('reveals the colour-scale field when enabled', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    expect(scaleBox(root)).not.toBeNull()
  })

  it('rejects a malformed sidecar while it is still on screen', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    const area = scaleBox(root)!
    area.value = '{ "stops": [], "vmin": 1, "vmax": 1 }'
    area.dispatchEvent(new Event('input'))
    // Assert the specific message, not merely that *an* error element
    // exists — a required-title error would satisfy that and the test
    // would pass without the sidecar ever being validated.
    expect(root.textContent ?? '').toMatch(/not a valid colour scale/i)
  })

  it('reveals the uploader once a valid sidecar lands', () => {
    // The gate is evaluated at render time while the textarea
    // deliberately does not re-render on input, so the blur handler has
    // to reconcile. Without it a publisher pastes a correct sidecar and
    // nothing appears to happen.
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    const area = scaleBox(root)!
    area.value = VALID_SCALE
    area.dispatchEvent(new Event('input'))
    area.dispatchEvent(new Event('change'))
    openMedia(root)
    // Positive assertion on the thing that should now exist. Matching
    // on absent copy is what went wrong first time: /before uploading/
    // also matches the help text "Choose this before uploading".
    expect(root.querySelector('.publisher-form-data-upload .publisher-asset-uploader')).not.toBeNull()
    expect(root.textContent ?? '').not.toMatch(/Add a valid colour scale/i)
  })

  it('accepts a valid sidecar', () => {
    const { root } = mount()
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    const area = scaleBox(root)!
    area.value = VALID_SCALE
    area.dispatchEvent(new Event('input'))
    const text = root.textContent ?? ''
    expect(text).toMatch(/dBZ/)
  })

  it('sends data-luma and the sidecar when enabled', async () => {
    const { root, fetchFn } = mount()
    const title = root.querySelector<HTMLInputElement>('#dataset-title')
    if (title) {
      title.value = 'Reflectivity'
      title.dispatchEvent(new Event('change'))
    }
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    const area = scaleBox(root)!
    area.value = VALID_SCALE
    area.dispatchEvent(new Event('input'))
    area.dispatchEvent(new Event('change'))
    root.querySelector('form')?.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }))
    await Promise.resolve()
    expect(fetchFn).toHaveBeenCalled()
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))
    expect(body.render_encoding).toBe('data-luma')
    expect(JSON.parse(body.color_scale).units).toBe('dBZ')
  })

  it('clears both columns with explicit nulls when unticked on a data-encoded row', async () => {
    // The branch that omission would get wrong: to a PATCH an absent
    // field means "unchanged", so turning the mode off has to say so.
    const { root, fetchFn } = await mountEdit(savedRow({
      render_encoding: 'data-luma',
      color_scale: VALID_SCALE,
    } as Partial<PublisherDatasetDetail>))
    openMedia(root)
    const box = toggle(root)
    expect(box?.checked).toBe(true)
    box!.checked = false
    box!.dispatchEvent(new Event('change'))
    root.querySelector('form')?.dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
    const put = fetchFn.mock.calls.find(c => c[1]?.method === 'PUT')
    expect(put).toBeDefined()
    const body = JSON.parse(String(put![1].body))
    expect(body).toHaveProperty('render_encoding', null)
    expect(body).toHaveProperty('color_scale', null)
  })

  it('blocks an edit-mode upload until the encoding change is saved', async () => {
    // The guard validated the in-memory sidecar, but the transcode
    // reads the row — and an edit-mode uploader is handed the existing
    // id without persisting anything on the way there.
    const { root } = await mountEdit(savedRow())
    openMedia(root)
    const box = toggle(root)!
    box.checked = true
    box.dispatchEvent(new Event('change'))
    openMedia(root)
    const area = scaleBox(root)!
    area.value = VALID_SCALE
    area.dispatchEvent(new Event('input'))
    area.dispatchEvent(new Event('change'))
    openMedia(root)
    // The sidecar is valid, so the missing-sidecar block is satisfied —
    // but the row still says picture, so the uploader must stay away.
    expect(root.querySelector('.publisher-form-data-upload .publisher-asset-uploader')).toBeNull()
    expect(root.textContent ?? '').toMatch(/Save the dataset before uploading/i)
  })

  it('does not send the encoding pair for an ordinary picture dataset', async () => {
    // A pair of nulls in the body of every dataset ever created would
    // be the wrong fix for "unticking must clear the columns".
    const { root, fetchFn } = mount()
    const title = root.querySelector<HTMLInputElement>('#dataset-title')
    if (title) {
      title.value = 'Picture dataset'
      title.dispatchEvent(new Event('change'))
    }
    const form = root.querySelector('form')
    form?.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    await Promise.resolve()
    // Anchor on the request having happened at all. Without this the
    // body is `undefined`, every `not.toContain` trivially holds, and
    // the test reports success for a form that never submitted.
    expect(fetchFn).toHaveBeenCalled()
    const body = fetchFn.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe('string')
    expect(body as string).not.toContain('render_encoding')
    expect(body as string).not.toContain('color_scale')
  })
})

// ---------------------------------------------------------------------------
// The uploader wiring
// ---------------------------------------------------------------------------

describe('dataset form — publish-as-uploaded wiring', () => {
  /**
   * Regression: the flag was first passed to the *auxiliary* uploader
   * factory (thumbnail / legend) rather than to the primary data
   * uploader, so the control never rendered where it matters. The
   * component's own tests passed throughout, because they call
   * `renderAssetUploader` directly — only a test that goes through the
   * form catches a mis-wired call site.
   */
  it('offers publish-as-uploaded on the data uploader of a saved data-encoded row', async () => {
    const { root } = await mountEdit(
      savedRow({
        format: 'video/mp4',
        render_encoding: 'data-luma',
        color_scale: VALID_SCALE,
      } as Partial<PublisherDatasetDetail>),
    )
    openMedia(root)
    await until(
      () => root.querySelector('.publisher-asset-uploader-asis') !== null,
      'the publish-as-uploaded control to mount',
    )
    const box = root.querySelector<HTMLInputElement>('.publisher-asset-uploader-asis input')
    // Defaulted on: for these rows the transcode decimates to the
    // single 4096x2048 rung and re-encodes the values themselves.
    expect(box?.checked).toBe(true)
  })

  it('does not offer it on a row that is not data-encoded', async () => {
    const { root } = await mountEdit(savedRow({ format: 'video/mp4' }))
    openMedia(root)
    await until(
      () => root.querySelector('.publisher-asset-uploader-input-row') !== null,
      'the uploader to mount',
    )
    expect(root.querySelector('.publisher-asset-uploader-asis')).toBeNull()
  })
})
