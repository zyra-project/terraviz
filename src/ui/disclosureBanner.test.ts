import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import {
  showDisclosureBannerIfNeeded,
  hasSeenDisclosure,
  disposeDisclosureBanner,
  resetDisclosureForTests,
} from './disclosureBanner'
import { disposePrivacyUI, isPrivacyUIOpen } from './privacyUI'
import { resetForTests, __peek } from '../analytics/emitter'
import { setTier } from '../analytics/config'

beforeEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  resetForTests()
  resetDisclosureForTests()
  disposeDisclosureBanner()
  disposePrivacyUI()
  setTier('essential')
})

afterEach(() => {
  disposeDisclosureBanner()
  disposePrivacyUI()
  document.body.innerHTML = ''
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
