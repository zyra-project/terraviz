// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the poster deep-link parsers + orchestrator.
 *
 * Two layers:
 *   - Pure resolution helpers (`resolveLayout`, `parseInitialLayout`,
 *     `resolveTourId`, `resolveOrbitPrompt`). These lock down slug
 *     renames, layout-token changes, the tour-format constraint, and
 *     the legacyId-fallback semantics.
 *   - DOM orchestration (`applyPosterDeepLinks`). These exercise the
 *     button-click + chat-panel dispatch through a jsdom fixture so
 *     button-id renames or boot-order changes can't slip through.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  applyPosterDeepLinks,
  parseInitialLayout,
  resolveLayout,
  resolveOrbitPrompt,
  resolveTourId,
} from './posterDeepLinks'
import type { Dataset } from '../types'

function fakeDataset(
  id: string,
  format: Dataset['format'],
  legacyId?: string,
): Dataset {
  return {
    id,
    title: '',
    format,
    dataLink: '',
    ...(legacyId ? { legacyId } : {}),
  } as Dataset
}

const fakeCatalog: readonly Dataset[] = [
  fakeDataset('SAMPLE_TOUR', 'tour/json'),
  fakeDataset('SAMPLE_TOUR_CLIMATE_FUTURES', 'tour/json'),
  // A tour with a legacy id, so we can verify the legacyId fallback
  // path used when a bookmark refers to an old INTERNAL_SOS_*-style
  // identifier that has since been re-keyed to a ULID-style id.
  fakeDataset('TOUR_LEGACY_TARGET', 'tour/json', 'INTERNAL_SOS_LEGACY_TOUR'),
  // A non-tour dataset; ?tour=INTERNAL_SOS_42 must NOT resolve to
  // it because the parameter is documented as tour-only.
  fakeDataset('INTERNAL_SOS_42', 'image/jpg'),
]

describe('resolveLayout', () => {
  it('passes canonical layout tokens through unchanged', () => {
    expect(resolveLayout('1')).toBe('1')
    expect(resolveLayout('2h')).toBe('2h')
    expect(resolveLayout('2v')).toBe('2v')
    expect(resolveLayout('4')).toBe('4')
  })

  it('expands the public "2" alias to "2h"', () => {
    // The poster ships ?layout=2 as the public form; the canonical
    // viewport vocabulary distinguishes 2h vs 2v.
    expect(resolveLayout('2')).toBe('2h')
  })

  it('returns null for null, empty, and unknown values', () => {
    expect(resolveLayout(null)).toBeNull()
    expect(resolveLayout('')).toBeNull()
    expect(resolveLayout('3')).toBeNull()
    expect(resolveLayout('grid')).toBeNull()
    expect(resolveLayout('1x1')).toBeNull()
  })
})

describe('parseInitialLayout', () => {
  it('prefers ?layout= when both ?layout= and ?setview= are present', () => {
    expect(parseInitialLayout('?layout=4&setview=1')).toBe('4')
  })

  it('falls back to ?setview= when ?layout= is absent', () => {
    expect(parseInitialLayout('?setview=2v')).toBe('2v')
  })

  it('defaults to single-view when neither param is set', () => {
    expect(parseInitialLayout('')).toBe('1')
    expect(parseInitialLayout('?dataset=foo')).toBe('1')
  })

  it('falls back to single-view for unknown values', () => {
    expect(parseInitialLayout('?layout=bogus')).toBe('1')
  })
})

describe('resolveTourId', () => {
  it('maps known slugs to their catalog dataset ids', () => {
    expect(resolveTourId('climate-futures', fakeCatalog)).toBe(
      'SAMPLE_TOUR_CLIMATE_FUTURES',
    )
    expect(resolveTourId('climate-connections', fakeCatalog)).toBe(
      'SAMPLE_TOUR',
    )
  })

  it('is case-insensitive on slug lookup', () => {
    expect(resolveTourId('Climate-Futures', fakeCatalog)).toBe(
      'SAMPLE_TOUR_CLIMATE_FUTURES',
    )
    expect(resolveTourId('CLIMATE-FUTURES', fakeCatalog)).toBe(
      'SAMPLE_TOUR_CLIMATE_FUTURES',
    )
  })

  it('accepts a direct catalog ID when the row is a tour', () => {
    expect(resolveTourId('SAMPLE_TOUR_CLIMATE_FUTURES', fakeCatalog)).toBe(
      'SAMPLE_TOUR_CLIMATE_FUTURES',
    )
    expect(resolveTourId('TOUR_LEGACY_TARGET', fakeCatalog)).toBe(
      'TOUR_LEGACY_TARGET',
    )
  })

  it('rejects non-tour datasets even when the ID matches exactly', () => {
    // ?tour= is documented as tour-only. Loading an image dataset
    // because its ID happened to match would silently give the
    // visitor a totally different experience from what the URL
    // advertises.
    expect(resolveTourId('INTERNAL_SOS_42', fakeCatalog)).toBeNull()
  })

  it('falls back to legacyId when the raw value is a legacy reference', () => {
    // dataService.getDatasetById() falls back to legacyId so older
    // INTERNAL_SOS_* references keep working; resolveTourId mirrors
    // that. Constraint: the resolved row must still be a tour.
    expect(resolveTourId('INTERNAL_SOS_LEGACY_TOUR', fakeCatalog)).toBe(
      'TOUR_LEGACY_TARGET',
    )
  })

  it('returns null when the slug or ID is not in the catalog', () => {
    expect(resolveTourId('not-a-real-tour', fakeCatalog)).toBeNull()
    expect(resolveTourId('INTERNAL_SOS_99999', fakeCatalog)).toBeNull()
  })

  it('returns null for empty / null inputs', () => {
    expect(resolveTourId(null, fakeCatalog)).toBeNull()
    expect(resolveTourId('', fakeCatalog)).toBeNull()
  })

  it("returns null when the slug's mapped target is missing from the catalog", () => {
    // Alias map can outlive a catalog rev. An alias pointing at a
    // deleted dataset must NOT resolve, so the deep-link is a
    // silent no-op rather than a broken load attempt.
    const empty: readonly Dataset[] = []
    expect(resolveTourId('climate-futures', empty)).toBeNull()
  })
})

describe('resolveOrbitPrompt', () => {
  it('returns the tour-recommendation seed for prompt=tour', () => {
    expect(resolveOrbitPrompt('tour')).toBe(
      "I'm new here. What tour should I start with?",
    )
  })

  it('returns undefined for unknown / null prompt names', () => {
    expect(resolveOrbitPrompt(null)).toBeUndefined()
    expect(resolveOrbitPrompt('')).toBeUndefined()
    expect(resolveOrbitPrompt('not-a-real-prompt')).toBeUndefined()
  })
})

describe('applyPosterDeepLinks', () => {
  // jsdom shares a single document across tests; reset the fixture
  // and the URL before each case.
  beforeEach(() => {
    document.body.innerHTML = ''
    history.replaceState({}, '', '/')
  })

  type ToggleId =
    | 'tools-menu-terrain'
    | 'tools-menu-labels'
    | 'tools-menu-borders'
    | 'tools-menu-autorotate'

  /**
   * Build the four Tools-menu toggle buttons jsdom needs and stub
   * `.click()` to add the `.active` class so the orchestrator's
   * "skip if already active" branch is exercisable.
   */
  function setupToolsButtons(): Record<ToggleId, HTMLButtonElement> {
    const ids: ToggleId[] = [
      'tools-menu-terrain',
      'tools-menu-labels',
      'tools-menu-borders',
      'tools-menu-autorotate',
    ]
    const out = {} as Record<ToggleId, HTMLButtonElement>
    for (const id of ids) {
      const btn = document.createElement('button')
      btn.id = id
      btn.click = vi.fn(() => {
        btn.classList.add('active')
      })
      document.body.appendChild(btn)
      out[id] = btn
    }
    return out
  }

  function makeContext() {
    return {
      catalog: fakeCatalog,
      loadDataset: vi.fn().mockResolvedValue(undefined),
      openChatWithQuery: vi.fn(),
    }
  }

  it('clicks the Tools-menu buttons matching ?<name>=on params', async () => {
    const buttons = setupToolsButtons()
    history.replaceState({}, '', '/?terrain=on&borders=on')
    const ctx = makeContext()

    await applyPosterDeepLinks(ctx)

    expect(buttons['tools-menu-terrain'].click).toHaveBeenCalledOnce()
    expect(buttons['tools-menu-borders'].click).toHaveBeenCalledOnce()
    expect(buttons['tools-menu-labels'].click).not.toHaveBeenCalled()
    expect(buttons['tools-menu-autorotate'].click).not.toHaveBeenCalled()
    expect(ctx.loadDataset).not.toHaveBeenCalled()
    expect(ctx.openChatWithQuery).not.toHaveBeenCalled()
  })

  it('skips a Tools-menu button that is already active', async () => {
    const buttons = setupToolsButtons()
    buttons['tools-menu-labels'].classList.add('active')
    history.replaceState({}, '', '/?labels=on')
    const ctx = makeContext()

    await applyPosterDeepLinks(ctx)

    expect(buttons['tools-menu-labels'].click).not.toHaveBeenCalled()
  })

  it('loads a tour for a known slug', async () => {
    setupToolsButtons()
    history.replaceState({}, '', '/?tour=climate-futures')
    const ctx = makeContext()

    await applyPosterDeepLinks(ctx)

    expect(ctx.loadDataset).toHaveBeenCalledOnce()
    expect(ctx.loadDataset).toHaveBeenCalledWith(
      'SAMPLE_TOUR_CLIMATE_FUTURES',
    )
  })

  it('awaits the tour load before opening the chat panel', async () => {
    // Composability check: ?tour=climate-futures&orbit=open must
    // not race. The chat panel has to open AFTER the tour-engine
    // setup pass, otherwise the tour's startup choreography can
    // close it again.
    setupToolsButtons()
    history.replaceState({}, '', '/?tour=climate-futures&orbit=open')

    const callOrder: string[] = []
    let resolveLoad: () => void
    const loadPromise = new Promise<void>((res) => {
      resolveLoad = () => {
        callOrder.push('loadDataset:resolved')
        res()
      }
    })
    const ctx = {
      catalog: fakeCatalog,
      loadDataset: vi.fn(() => {
        callOrder.push('loadDataset:called')
        return loadPromise
      }),
      openChatWithQuery: vi.fn(() => {
        callOrder.push('openChat:called')
      }),
    }

    const dispatchPromise = applyPosterDeepLinks(ctx)

    // The dispatch must be parked on the load promise; chat must
    // not have opened yet.
    await Promise.resolve()
    expect(callOrder).toEqual(['loadDataset:called'])
    expect(ctx.openChatWithQuery).not.toHaveBeenCalled()

    // Once the load resolves, the orchestrator should run chat next.
    resolveLoad!()
    await dispatchPromise
    expect(callOrder).toEqual([
      'loadDataset:called',
      'loadDataset:resolved',
      'openChat:called',
    ])
  })

  it('skips ?tour= when ?dataset= is also set', async () => {
    setupToolsButtons()
    // The existing initial-load path handles ?dataset= already; we
    // must not double-load on top of it.
    history.replaceState(
      {},
      '',
      '/?tour=climate-futures&dataset=INTERNAL_SOS_42',
    )
    const ctx = makeContext()

    await applyPosterDeepLinks(ctx)

    expect(ctx.loadDataset).not.toHaveBeenCalled()
  })

  it('opens the chat panel without a seed when ?orbit=open has no prompt', async () => {
    setupToolsButtons()
    history.replaceState({}, '', '/?orbit=open')
    const ctx = makeContext()

    await applyPosterDeepLinks(ctx)

    expect(ctx.openChatWithQuery).toHaveBeenCalledOnce()
    expect(ctx.openChatWithQuery).toHaveBeenCalledWith(undefined)
  })

  it('seeds the chat input when ?orbit=open&prompt=tour', async () => {
    setupToolsButtons()
    history.replaceState({}, '', '/?orbit=open&prompt=tour')
    const ctx = makeContext()

    await applyPosterDeepLinks(ctx)

    expect(ctx.openChatWithQuery).toHaveBeenCalledWith(
      "I'm new here. What tour should I start with?",
    )
  })

  it('is a no-op when no poster params are present', async () => {
    setupToolsButtons()
    history.replaceState({}, '', '/')
    const ctx = makeContext()

    await applyPosterDeepLinks(ctx)

    expect(ctx.loadDataset).not.toHaveBeenCalled()
    expect(ctx.openChatWithQuery).not.toHaveBeenCalled()
  })

  it("awaits the loadDataset callback's full work, including post-load UI sync", async () => {
    // Locks in the contract main.ts depends on: the loadDataset
    // callback can do async post-load work (showChatTrigger,
    // notifyDatasetChanged, setHelpActiveDataset) and the
    // orchestrator awaits that work before opening chat. If the
    // orchestrator dropped to a fire-and-forget call, ?tour=...&
    // orbit=open would once again open chat before the dataset's
    // help overlay is wired up.
    setupToolsButtons()
    history.replaceState({}, '', '/?tour=climate-futures&orbit=open')

    const callOrder: string[] = []
    const ctx = {
      catalog: fakeCatalog,
      loadDataset: vi.fn(async () => {
        callOrder.push('loadDataset:start')
        await Promise.resolve()
        callOrder.push('postLoadUiSync')
        await Promise.resolve()
        callOrder.push('loadDataset:resolve')
      }),
      openChatWithQuery: vi.fn(() => {
        callOrder.push('openChat')
      }),
    }

    await applyPosterDeepLinks(ctx)

    expect(callOrder).toEqual([
      'loadDataset:start',
      'postLoadUiSync',
      'loadDataset:resolve',
      'openChat',
    ])
  })
})
