/**
 * Tests for downloadDialogUI — §8.2 zip-download dialog.
 *
 * happy-dom + mocked fetch + a stubbed dataService. The actual zip
 * service is exercised through these flows; dedicated unit tests for
 * the service itself live in `zipDownloadService.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDownloadDialog,
  destroyDownloadDialogUI,
  initDownloadDialogUI,
  isDownloadDialogOpen,
  openDownloadDialog,
} from './downloadDialogUI'
import { dataService } from '../services/dataService'
import type { Dataset } from '../types'

function makeDataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    id: 'DS01',
    title: 'Demo Dataset',
    format: 'video/mp4',
    dataLink: 'https://vimeo.com/12345',
    ...overrides,
  } as Dataset
}

/** Stub dataService.getDatasetById to return `dataset`. Returns the
 *  original method so afterEach can restore. */
function stubDataset(dataset: Dataset | undefined): () => void {
  const orig = dataService.getDatasetById.bind(dataService)
  dataService.getDatasetById = (id: string) =>
    (dataset && (dataset.id === id || dataset.legacyId === id)) ? dataset : undefined
  return () => { dataService.getDatasetById = orig }
}

/** Mock fetch that returns the legacy Vimeo proxy manifest. Lets the
 *  resolveAssets() path complete without real network. */
function mockProxyFetch(): typeof globalThis.fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-length': '5000' } })
    }
    if (url.includes('video-proxy.zyra-project.org/video/12345')) {
      return new Response(JSON.stringify({
        id: '12345',
        title: '',
        duration: 0,
        hls: '',
        dash: '',
        files: [{ quality: '1080p', width: 1920, height: 1080, size: 1_000_000, type: 'video/mp4', link: 'https://video-proxy.zyra-project.org/v/12345.mp4' }],
      }), { status: 200 })
    }
    return new Response(new ArrayBuffer(8), { status: 200 })
  }) as unknown as typeof globalThis.fetch
}

let restoreDataset: () => void = () => {}
let origFetch: typeof globalThis.fetch

beforeEach(() => {
  document.body.innerHTML = ''
  origFetch = globalThis.fetch
  globalThis.fetch = mockProxyFetch()
  initDownloadDialogUI()
})

afterEach(() => {
  destroyDownloadDialogUI()
  restoreDataset()
  globalThis.fetch = origFetch
  document.body.innerHTML = ''
  delete document.body.dataset.zipDownloadDialogWired
})

describe('downloadDialogUI — mount + open', () => {
  it('lazy-mounts the panel on init', () => {
    expect(document.getElementById('zip-download-dialog')).not.toBeNull()
  })

  it('starts hidden', () => {
    expect(document.getElementById('zip-download-dialog')?.classList.contains('hidden')).toBe(true)
    expect(isDownloadDialogOpen()).toBe(false)
  })

  it('renders an error when the dataset id is unknown', async () => {
    restoreDataset = stubDataset(undefined)
    await openDownloadDialog('NOT_FOUND', null)
    expect(isDownloadDialogOpen()).toBe(true)
    const panel = document.getElementById('zip-download-dialog')!
    expect(panel.querySelector('.zip-dl-error')).not.toBeNull()
  })

  it('renders an asset row per resolved kind', async () => {
    restoreDataset = stubDataset(makeDataset({
      legendLink: 'https://r2.terraviz.zyra-project.org/legend.png',
      thumbnailLink: 'https://r2.terraviz.zyra-project.org/thumb.jpg',
    }))
    await openDownloadDialog('DS01', null)
    // Wait one microtask for the listDownloadableAssets promise to flush.
    await new Promise(r => setTimeout(r, 0))
    const panel = document.getElementById('zip-download-dialog')!
    const checkboxes = panel.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-kind]')
    const kinds = Array.from(checkboxes).map(cb => cb.dataset.kind).sort()
    expect(kinds).toEqual(['legend', 'primary', 'thumbnail'])
  })

  it('defaults every asset checkbox to checked', async () => {
    restoreDataset = stubDataset(makeDataset({
      legendLink: 'https://r2.terraviz.zyra-project.org/legend.png',
    }))
    await openDownloadDialog('DS01', null)
    await new Promise(r => setTimeout(r, 0))
    const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-kind]')
    for (const cb of checkboxes) {
      expect(cb.checked).toBe(true)
    }
  })

  it('shows the publisher source-of-truth note for an R2-hosted primary', async () => {
    // Override fetch to return an R2 public URL as the primary.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': '1000' } })
      }
      return new Response(JSON.stringify({
        id: '12345', title: '', duration: 0, hls: '', dash: '',
        files: [{ quality: '4K', width: 3840, height: 2160, size: 500, type: 'video/mp4', link: 'https://r2.terraviz.zyra-project.org/videos/DS01/source.mp4' }],
      }), { status: 200 })
    }) as unknown as typeof globalThis.fetch

    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    await new Promise(r => setTimeout(r, 0))
    const note = document.querySelector('.zip-dl-source-note')?.textContent ?? ''
    expect(note).toMatch(/publisher upload/i)
  })

  it('shows the Vimeo source-of-truth note for a video-proxy primary', async () => {
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    await new Promise(r => setTimeout(r, 0))
    const note = document.querySelector('.zip-dl-source-note')?.textContent ?? ''
    expect(note).toMatch(/Vimeo proxy/i)
  })
})

describe('downloadDialogUI — close', () => {
  it('close button hides the panel', async () => {
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    const closeBtn = document.getElementById('zip-dl-close') as HTMLButtonElement
    closeBtn.click()
    expect(isDownloadDialogOpen()).toBe(false)
    expect(document.getElementById('zip-download-dialog')?.classList.contains('hidden')).toBe(true)
  })

  it('Escape closes the panel when not downloading', async () => {
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(isDownloadDialogOpen()).toBe(false)
  })

  it('clicking outside the panel closes it', async () => {
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    await new Promise(r => setTimeout(r, 0))
    // happy-dom's composedPath() doesn't return ancestors, so the
    // capture-phase sentinels in downloadDialogUI need a real
    // outside target. Use document.body itself as the click target.
    document.body.click()
    expect(isDownloadDialogOpen()).toBe(false)
  })

  it('closeDownloadDialog clears state for next open', async () => {
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    closeDownloadDialog()
    expect(isDownloadDialogOpen()).toBe(false)
    // Re-open with a different dataset; the previous state must be
    // gone so the second open doesn't blend assets from the first.
    restoreDataset = stubDataset(makeDataset({ id: 'DS02', title: 'Other' }))
    await openDownloadDialog('DS02', null)
    await new Promise(r => setTimeout(r, 0))
    const title = document.querySelector('.zip-dl-dataset')?.textContent
    expect(title).toBe('Other')
  })
})

describe('downloadDialogUI — checkbox + size cap', () => {
  it('unchecking every checkbox disables the start button', async () => {
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    await new Promise(r => setTimeout(r, 0))
    const checkboxes = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"][data-kind]')
    for (const cb of checkboxes) {
      cb.checked = false
      cb.dispatchEvent(new Event('change'))
    }
    const start = document.getElementById('zip-dl-start') as HTMLButtonElement | null
    expect(start?.disabled).toBe(true)
  })

  it('disables the start button when the estimated total exceeds the 1.5 GB cap', async () => {
    // Return a 2 GB content-length so the estimate crosses the cap.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': String(2 * 1024 * 1024 * 1024) } })
      }
      return new Response(JSON.stringify({
        id: '12345', title: '', duration: 0, hls: '', dash: '',
        files: [{ quality: '4K', width: 3840, height: 2160, size: 2 * 1024 * 1024 * 1024, type: 'video/mp4', link: 'https://video-proxy.zyra-project.org/v/12345.mp4' }],
      }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    // Two microtasks: one for resolveAssets, one for estimate.
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    const start = document.getElementById('zip-dl-start') as HTMLButtonElement | null
    expect(start?.disabled).toBe(true)
    expect(document.querySelector('.zip-dl-warning')?.textContent).toMatch(/exceed/i)
  })

  it('surfaces a warning between 1 GB and 1.5 GB but keeps Start enabled', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'content-length': String(1.2 * 1024 * 1024 * 1024) } })
      }
      return new Response(JSON.stringify({
        id: '12345', title: '', duration: 0, hls: '', dash: '',
        files: [{ quality: '4K', width: 3840, height: 2160, size: 1.2 * 1024 * 1024 * 1024, type: 'video/mp4', link: 'https://video-proxy.zyra-project.org/v/12345.mp4' }],
      }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    const start = document.getElementById('zip-dl-start') as HTMLButtonElement | null
    expect(start?.disabled).toBe(false)
    expect(document.querySelector('.zip-dl-warning')?.textContent).toMatch(/larger than/i)
  })
})

describe('downloadDialogUI — re-open does not leak listeners', () => {
  it('opening and closing twice does not double-mount the panel', async () => {
    restoreDataset = stubDataset(makeDataset())
    await openDownloadDialog('DS01', null)
    closeDownloadDialog()
    await openDownloadDialog('DS01', null)
    const panels = document.querySelectorAll('#zip-download-dialog')
    expect(panels.length).toBe(1)
  })
})
