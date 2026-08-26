// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  showDisclosureBannerIfNeeded,
  hasSeenDisclosure,
  disposeDisclosureBanner,
  resetDisclosureForTests,
  isSmallViewport,
} from './disclosureBanner'
import { disposePrivacyUI, isPrivacyUIOpen } from './privacyUI'
import { resetForTests, __peek } from '../analytics/emitter'
import { setTier } from '../analytics/config'

/** Force the window to a viewport size for the duration of the test.
 *  The stubs are torn down by `vi.unstubAllGlobals()` in afterEach
 *  (vi.restoreAllMocks alone does NOT reset stubGlobal stubs). */
function setViewport(width: number, height: number): void {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
}

beforeEach(() => {
  // The badge path looks up #a11y-announcer to push a polite
  // announcement when it mounts. Provide one in the test DOM
  // so that path runs (and is testable). Tests that care about
  // the announcement assert on its textContent after rAF.
  document.body.innerHTML = '<div id="a11y-announcer" aria-live="polite" aria-atomic="true"></div>'
  localStorage.clear()
  resetForTests()
  resetDisclosureForTests()
  disposeDisclosureBanner()
  disposePrivacyUI()
  setTier('essential')
  // Default to a comfortably large viewport so existing tests
  // hit the full-banner branch.
  setViewport(1280, 800)
})

afterEach(() => {
  disposeDisclosureBanner()
  disposePrivacyUI()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('disclosureBanner — show once', () => {
  it('renders on first call and remembers the dismissal afterwards', () => {
    expect(hasSeenDisclosure()).toBe(false)
    expect(showDisclosureBannerIfNeeded()).toBe(true)

    const banner = document.getElementById('disclosure-banner')
    expect(banner).not.toBeNull()

    // Dismiss
    const dismiss = document.getElementById('disclosure-banner-dismiss') as HTMLButtonElement
    dismiss.click()

    expect(document.getElementById('disclosure-banner')).toBeNull()
    expect(hasSeenDisclosure()).toBe(true)

    // Second call is a no-op
    expect(showDisclosureBannerIfNeeded()).toBe(false)
    expect(document.getElementById('disclosure-banner')).toBeNull()
  })

  it('is a no-op when storage already marks it seen', () => {
    localStorage.setItem('sos-disclosure-seen', '1')
    expect(showDisclosureBannerIfNeeded()).toBe(false)
    expect(document.getElementById('disclosure-banner')).toBeNull()
  })

  it('is idempotent while visible — a second call does not double-render', () => {
    expect(showDisclosureBannerIfNeeded()).toBe(true)
    expect(showDisclosureBannerIfNeeded()).toBe(false)
    const banners = document.querySelectorAll('#disclosure-banner')
    expect(banners.length).toBe(1)
  })
})

describe('disclosureBanner — emits on dismiss', () => {
  it('records a settings_changed event with key=disclosure_seen', () => {
    showDisclosureBannerIfNeeded()
    const dismiss = document.getElementById('disclosure-banner-dismiss') as HTMLButtonElement
    dismiss.click()

    const evs = __peek()
    const dismissed = evs.find(
      (e): e is Extract<typeof e, { event_type: 'settings_changed' }> =>
        e.event_type === 'settings_changed' && e.key === 'disclosure_seen',
    )
    expect(dismissed).toBeTruthy()
    expect(dismissed?.value_class).toBe('dismissed')
  })
})

describe('disclosureBanner — Privacy settings shortcut', () => {
  it('clicking Privacy settings opens the privacy dialog and dismisses the banner', () => {
    showDisclosureBannerIfNeeded()
    const settings = document.getElementById('disclosure-banner-settings') as HTMLButtonElement
    settings.click()

    expect(document.getElementById('disclosure-banner')).toBeNull()
    expect(hasSeenDisclosure()).toBe(true)
    expect(isPrivacyUIOpen()).toBe(true)
  })
})

describe('disclosureBanner — a11y shape', () => {
  it('labels itself as a polite live region', () => {
    showDisclosureBannerIfNeeded()
    const banner = document.getElementById('disclosure-banner')!
    expect(banner.getAttribute('role')).toBe('region')
    expect(banner.getAttribute('aria-live')).toBe('polite')
    expect(banner.getAttribute('aria-label')).toMatch(/privacy/i)
  })

  it('links to the canonical /privacy page', () => {
    showDisclosureBannerIfNeeded()
    const link = document.getElementById('disclosure-banner-policy') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/privacy')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
  })
})

// ---------------------------------------------------------------------------
// Small-viewport collapsed form
// ---------------------------------------------------------------------------
describe('disclosureBanner — small-viewport badge', () => {
  it('isSmallViewport reports true at narrow widths', () => {
    setViewport(500, 800)
    expect(isSmallViewport()).toBe(true)
  })

  it('isSmallViewport reports true at short heights', () => {
    setViewport(1280, 400)
    expect(isSmallViewport()).toBe(true)
  })

  it('isSmallViewport reports false on a comfortable desktop viewport', () => {
    setViewport(1280, 800)
    expect(isSmallViewport()).toBe(false)
  })

  it('renders the badge instead of the banner on a small viewport', () => {
    setViewport(500, 400)

    expect(showDisclosureBannerIfNeeded()).toBe(true)

    expect(document.getElementById('disclosure-banner')).toBeNull()
    const badge = document.getElementById('disclosure-badge')
    expect(badge).not.toBeNull()
    expect(badge!.classList.contains('disclosure-badge--pulse')).toBe(true)
    expect(badge!.getAttribute('aria-label')).toMatch(/privacy/i)
  })

  it('clicking the badge expands to the full banner content', () => {
    setViewport(500, 400)
    showDisclosureBannerIfNeeded()

    const badge = document.getElementById('disclosure-badge') as HTMLButtonElement
    badge.click()

    expect(document.getElementById('disclosure-badge')).toBeNull()
    const banner = document.getElementById('disclosure-banner')
    expect(banner).not.toBeNull()
    // Same buttons as the desktop banner — Privacy settings,
    // Read policy, Got it.
    expect(document.getElementById('disclosure-banner-settings')).not.toBeNull()
    expect(document.getElementById('disclosure-banner-policy')).not.toBeNull()
    expect(document.getElementById('disclosure-banner-dismiss')).not.toBeNull()
  })

  it('dismissing from the expanded banner persists and removes everything', () => {
    setViewport(500, 400)
    showDisclosureBannerIfNeeded()

    const badge = document.getElementById('disclosure-badge') as HTMLButtonElement
    badge.click()

    const dismiss = document.getElementById('disclosure-banner-dismiss') as HTMLButtonElement
    dismiss.click()

    expect(document.getElementById('disclosure-banner')).toBeNull()
    expect(document.getElementById('disclosure-badge')).toBeNull()
    expect(hasSeenDisclosure()).toBe(true)

    // Subsequent shows are a no-op even with a small viewport.
    expect(showDisclosureBannerIfNeeded()).toBe(false)
  })

  it('emits the same dismissal event whether dismissed from the banner or the expanded badge', () => {
    setViewport(500, 400)
    showDisclosureBannerIfNeeded();
    (document.getElementById('disclosure-badge') as HTMLButtonElement).click();
    (document.getElementById('disclosure-banner-dismiss') as HTMLButtonElement).click()

    const evs = __peek()
    const dismissed = evs.find(
      (e): e is Extract<typeof e, { event_type: 'settings_changed' }> =>
        e.event_type === 'settings_changed' && e.key === 'disclosure_seen',
    )
    expect(dismissed).toBeTruthy()
    expect(dismissed?.value_class).toBe('dismissed')
  })

  it('disposeDisclosureBanner cleans up the badge as well as the banner', () => {
    setViewport(500, 400)
    showDisclosureBannerIfNeeded()
    expect(document.getElementById('disclosure-badge')).not.toBeNull()

    disposeDisclosureBanner()
    expect(document.getElementById('disclosure-badge')).toBeNull()
    // After disposing, mounted resets so a fresh show works again.
    expect(showDisclosureBannerIfNeeded()).toBe(true)
  })

  it('mounts a polite announcement to #a11y-announcer so AT users discover the badge', async () => {
    setViewport(500, 400)

    // jsdom runs requestAnimationFrame synchronously via setTimeout(0),
    // so the announcement lands on the next microtask tick.
    showDisclosureBannerIfNeeded()

    // Allow the rAF callback inside announcePolite to run.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const live = document.getElementById('a11y-announcer')!
    expect(live.textContent).toMatch(/privacy notice/i)
    expect(live.textContent).toMatch(/shield/i)
  })

  it('expanding the badge moves focus to the dismiss button so keyboard users do not lose context', () => {
    setViewport(500, 400)
    showDisclosureBannerIfNeeded()

    const badge = document.getElementById('disclosure-badge') as HTMLButtonElement
    badge.focus()
    expect(document.activeElement).toBe(badge)

    badge.click()

    const dismiss = document.getElementById('disclosure-banner-dismiss') as HTMLButtonElement
    // Focus should land on the dismiss button rather than dropping
    // to <body> when the badge is removed.
    expect(document.activeElement).toBe(dismiss)
  })
})

// ---------------------------------------------------------------------------
// Pulse settle timer + race
// ---------------------------------------------------------------------------
describe('disclosureBanner — pulse settle timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('removes the pulse class after the settle interval elapses', () => {
    setViewport(500, 400)
    showDisclosureBannerIfNeeded()

    const badge = document.getElementById('disclosure-badge') as HTMLElement
    expect(badge.classList.contains('disclosure-badge--pulse')).toBe(true)

    // PULSE_DURATION_MS is 6000 in the source. Advance well past it.
    vi.advanceTimersByTime(7000)

    expect(badge.classList.contains('disclosure-badge--pulse')).toBe(false)
  })

  it('a stale pulse timeout from a disposed badge cannot strip the pulse from a freshly-mounted one', () => {
    setViewport(500, 400)

    // T=0: first show schedules its pulse-settle timer for T=6000.
    showDisclosureBannerIfNeeded()

    // T=2000: dispose. The original badge is gone; the original
    // timer must be cancelled, otherwise it will fire at T=6000
    // and strip the pulse class from whatever badge happens to be
    // mounted then.
    vi.advanceTimersByTime(2000)
    disposeDisclosureBanner()

    // T=2000: re-show. New badge gets pulse class, new timer
    // scheduled for T=8000 (current time + PULSE_DURATION_MS).
    showDisclosureBannerIfNeeded()
    const badge = document.getElementById('disclosure-badge') as HTMLElement
    expect(badge.classList.contains('disclosure-badge--pulse')).toBe(true)

    // T=6000: advance to when the *original* timer would have
    // fired. If the cancel-on-dispose fix is missing, the pulse
    // class would be stripped here.
    vi.advanceTimersByTime(4000)
    expect(badge.classList.contains('disclosure-badge--pulse')).toBe(true)

    // T=8000: the *new* timer fires normally on its own schedule.
    vi.advanceTimersByTime(2000)
    expect(badge.classList.contains('disclosure-badge--pulse')).toBe(false)
  })
})
