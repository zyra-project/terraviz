import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import { renderHeroPanel, destroyHeroPanel, resetHeroPanelForTests } from './heroPanelUI'
import { resetHeroCacheForTests, REAL_TIME_TAG } from '../services/heroService'
import type { Dataset } from '../types'

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
})
