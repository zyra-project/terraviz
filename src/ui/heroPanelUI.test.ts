// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { renderHeroPanel, destroyHeroPanel, resetHeroPanelForTests, setHeroEnabled } from './heroPanelUI'
import { resetHeroCacheForTests, REAL_TIME_TAG } from '../services/heroService'
import type { Dataset } from '../types'
import { until } from '../test-utils'

function ds(id: string, opts: { tags?: string[]; endTime?: string; title?: string } = {}): Dataset {
  return {
    id,
    title: opts.title ?? id,
    dataLink: '',
    tags: opts.tags,
    endTime: opts.endTime,
  } as unknown as Dataset
}

/** Stub fetch so the override pipeline returns the empty stub (no
 *  override) — tests exercise the auto-derived path. Uses
 *  vi.stubGlobal so vi.unstubAllGlobals() in afterEach removes it. */
function stubEmptyOverride(): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
}

const realtime = ds('rt', { tags: [REAL_TIME_TAG], endTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(), title: 'Live Storm' })

beforeEach(() => {
  document.body.innerHTML = '<div id="hero-panel" class="hero-panel hidden"></div>'
  resetHeroPanelForTests()
  resetHeroCacheForTests()
  stubEmptyOverride()
})

afterEach(() => {
  destroyHeroPanel()
  resetHeroPanelForTests()
  resetHeroCacheForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('renderHeroPanel', () => {
  it('renders the hero card in catalog mode when a candidate qualifies', async () => {
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    const host = document.getElementById('hero-panel')!
    expect(host.classList.contains('hidden')).toBe(false)
    expect(host.querySelector('.hero-panel-card')?.getAttribute('data-id')).toBe('rt')
    expect(host.querySelector('.hero-panel-title')?.textContent).toBe('Live Storm')
  })

  it('stays hidden outside catalog mode', async () => {
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: false })
    expect(document.getElementById('hero-panel')!.classList.contains('hidden')).toBe(true)
  })

  it('stays hidden when no candidate qualifies', async () => {
    await renderHeroPanel({ datasets: [ds('plain', { tags: ['Water'] })], onSelect: vi.fn(), isCatalogMode: true })
    expect(document.getElementById('hero-panel')!.classList.contains('hidden')).toBe(true)
  })

  it('loads the dataset when the card is clicked', async () => {
    const onSelect = vi.fn()
    await renderHeroPanel({ datasets: [realtime], onSelect, isCatalogMode: true })
    ;(document.querySelector('.hero-panel-card') as HTMLElement).click()
    expect(onSelect).toHaveBeenCalledWith('rt')
  })

  it('dismiss hides the panel for the session and survives a re-render', async () => {
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    ;(document.querySelector('.hero-panel-dismiss') as HTMLElement).click()
    const host = document.getElementById('hero-panel')!
    expect(host.classList.contains('hidden')).toBe(true)
    // A subsequent render in the same session stays hidden.
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    expect(host.classList.contains('hidden')).toBe(true)
  })

  it('uses the curator headline when the override supplies one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ datasetId: 'feat', window: { start: '2000-01-01', end: '2999-01-01' }, headline: 'Curated headline' }),
    }))
    await renderHeroPanel({ datasets: [ds('feat', { title: 'Plain title' })], onSelect: vi.fn(), isCatalogMode: true })
    expect(document.querySelector('.hero-panel-title')?.textContent).toBe('Curated headline')
  })

  it('re-evaluates on each call — hides when a later call leaves catalog mode', async () => {
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    const host = document.getElementById('hero-panel')!
    expect(host.classList.contains('hidden')).toBe(false)
    // Simulate the catalog↔sphere tab flipping ?catalog=true off.
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: false })
    expect(host.classList.contains('hidden')).toBe(true)
  })

  it('destroyHeroPanel hides the panel and clears it', async () => {
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    destroyHeroPanel()
    const host = document.getElementById('hero-panel')!
    expect(host.classList.contains('hidden')).toBe(true)
    expect(host.innerHTML).toBe('')
  })

  it('renders a cited source link for an event-sourced hero', async () => {
    // Route featured-event to an approved event whose datasetId is in
    // the catalog; the hero + static-file sources stay empty.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: unknown) => {
        const u = String(url)
        if (u.includes('featured-event')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              event: { title: 'Hurricane Lena', datasetId: 'feat', source: { name: 'NOAA', url: 'https://example.gov/storm' } },
            }),
          })
        }
        return Promise.resolve({ ok: true, json: async () => ({}) })
      }),
    )
    await renderHeroPanel({ datasets: [ds('feat', { title: 'Live Storm' })], onSelect: vi.fn(), isCatalogMode: true })
    const host = document.getElementById('hero-panel')!
    expect(host.querySelector('.hero-panel-card')?.getAttribute('data-id')).toBe('feat')
    expect(host.querySelector('.hero-panel-title')?.textContent).toBe('Hurricane Lena')
    const link = host.querySelector('.hero-panel-source-link') as HTMLAnchorElement | null
    expect(link?.textContent).toBe('NOAA')
    expect(link?.getAttribute('href')).toBe('https://example.gov/storm')
  })
})

// The node's `hero` switch hides the whole panel, not only a portal
// pin (maintainer's decision, 2026-11-09). `realtime` qualifies on the
// automatic path, so each "hidden" below is the switch, not a missing
// candidate; the first test proves that baseline.
describe('setHeroEnabled', () => {
  it('shows the automatic pick while the switch is on (the baseline)', async () => {
    setHeroEnabled(true)
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    expect(document.getElementById('hero-panel')!.classList.contains('hidden')).toBe(false)
  })

  it('off: stays hidden and asks for no candidate at all', async () => {
    setHeroEnabled(false)
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    expect(document.getElementById('hero-panel')!.classList.contains('hidden')).toBe(true)
    expect(vi.mocked(fetch)).not.toHaveBeenCalled()
  })

  it('off after a render hides the panel already showing', async () => {
    await renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    const host = document.getElementById('hero-panel')!
    expect(host.classList.contains('hidden')).toBe(false)
    setHeroEnabled(false)
    expect(host.classList.contains('hidden')).toBe(true)
    expect(host.innerHTML).toBe('')
  })

  it('off while a candidate is resolving drops the late result', async () => {
    // Fetches hang until released and ignore the abort, so the
    // resolution completes with a qualifying candidate after the
    // switch went off: only the panel's own guard can drop it.
    const empty = { ok: true, json: async () => ({}) }
    const waiting: Array<(v: unknown) => void> = []
    let released = false
    vi.stubGlobal('fetch', vi.fn(() =>
      released ? Promise.resolve(empty) : new Promise(r => { waiting.push(r) }),
    ))
    const pending = renderHeroPanel({ datasets: [realtime], onSelect: vi.fn(), isCatalogMode: true })
    await until(() => waiting.length > 0, 'the first candidate fetch')
    setHeroEnabled(false)
    released = true
    for (const r of waiting) r(empty)
    await pending
    expect(document.getElementById('hero-panel')!.classList.contains('hidden')).toBe(true)
  })
})
