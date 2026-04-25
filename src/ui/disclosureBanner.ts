/**
 * First-session disclosure banner.
 *
 * Shown on first launch to make the telemetry posture visible without
 * making the user dig into Tools → Privacy. Four pieces:
 *   - one-line summary of what's collected and that it's anonymous
 *   - a "Privacy settings" button that opens privacyUI
 *   - a "Read policy" link to /privacy
 *   - a dismiss button
 *
 * Dismissal persists in localStorage under `sos-disclosure-seen`.
 * We emit a `settings_changed` event with key `disclosure_seen` on
 * dismiss so the ingest side can confirm the banner actually ran
 * (and, eventually, that users aren't silently bouncing off it).
 *
 * The banner does not block the app — it's a non-modal strip at the
 * top of the viewport with `aria-live="polite"` so screen readers
 * announce it without stealing focus.
 */

import { emit } from '../analytics'
import { openPrivacyUI } from './privacyUI'

const STORAGE_KEY = 'sos-disclosure-seen'

let mounted = false

/** Has the user already dismissed the banner? */
export function hasSeenDisclosure(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    // Treat a locked-down storage (private mode, some school devices)
    // as "seen" so the banner doesn't nag on every reload when we
    // can't persist dismissal.
    return true
  }
}

/** Persist the dismissal. Silent on storage failure. */
function markSeen(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1')
  } catch {
    // ignore
  }
}

/** Build + attach the banner DOM. */
function buildBanner(): HTMLElement {
  const banner = document.createElement('section')
  banner.id = 'disclosure-banner'
  banner.className = 'disclosure-banner'
  banner.setAttribute('role', 'region')
  banner.setAttribute('aria-label', 'Privacy notice')
  banner.setAttribute('aria-live', 'polite')
  banner.innerHTML = `
    <p class="disclosure-banner-text">
      This app reports anonymous usage events to help us keep it healthy.
      No account, no tracking cookies, no third-party analytics. You can change this any time.
    </p>
    <div class="disclosure-banner-actions">
      <button
        type="button"
        id="disclosure-banner-settings"
        class="disclosure-banner-btn disclosure-banner-btn-secondary"
      >Privacy settings</button>
      <a
        id="disclosure-banner-policy"
        class="disclosure-banner-link"
        href="/privacy"
        target="_blank"
        rel="noopener"
      >Read policy</a>
      <button
        type="button"
        id="disclosure-banner-dismiss"
        class="disclosure-banner-btn disclosure-banner-btn-primary"
        aria-label="Dismiss privacy notice"
      >Got it</button>
    </div>
  `
  document.body.appendChild(banner)
  return banner
}

/** Dismiss: persist, emit, remove DOM. */
function dismiss(): void {
  markSeen()
  emit({
    event_type: 'settings_changed',
    key: 'disclosure_seen',
    value_class: 'dismissed',
  })
  const banner = document.getElementById('disclosure-banner')
  banner?.remove()
  mounted = false
}

/**
 * Show the banner if the user has not already dismissed it.
 * Idempotent — a second call while the banner is visible is a no-op.
 * Returns true when the banner was actually rendered (useful for
 * tests and for log lines).
 */
export function showDisclosureBannerIfNeeded(): boolean {
  if (mounted) return false
  if (hasSeenDisclosure()) return false
  mounted = true
  buildBanner()

  document
    .getElementById('disclosure-banner-dismiss')
    ?.addEventListener('click', () => dismiss(), { once: true })

  document
    .getElementById('disclosure-banner-settings')
    ?.addEventListener('click', (ev) => {
      // Opening settings counts as engagement — dismiss the banner
      // so the user isn't pestered by it after they've acted.
      const trigger = ev.currentTarget as HTMLElement
      dismiss()
      openPrivacyUI(trigger)
    }, { once: true })

  return true
}

/** Tear down. Idempotent. Exposed for tests. */
export function disposeDisclosureBanner(): void {
  const banner = document.getElementById('disclosure-banner')
  banner?.remove()
  mounted = false
}

/** Test helper to forget the persisted dismissal. */
export function resetDisclosureForTests(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
