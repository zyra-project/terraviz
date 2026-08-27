// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
 *
 * On small viewports (≤ 600 px wide OR ≤ 480 px tall — typical for
 * embedded iframe demos and phones) the full banner would dominate
 * the available real estate and obscure the globe. In that case we
 * render a small pulsing shield badge in the top-left corner instead;
 * tapping the badge expands to the full banner content. The choice
 * is made once at show time — no resize listener — to keep the
 * behaviour predictable.
 */

import { emit } from '../analytics'
import { openPrivacyUI } from './privacyUI'
import { t, tAttr, tHtml } from '../i18n'

const STORAGE_KEY = 'sos-disclosure-seen'

/** Below either of these dimensions, render the badge instead of
 *  the full banner. Picked to match the existing privacy-ui.css
 *  ≤ 600 px breakpoint plus a height check that catches embedded
 *  demos with short aspect ratios. */
const SMALL_VIEWPORT_WIDTH = 600
const SMALL_VIEWPORT_HEIGHT = 480

/** How long the badge pulses before settling into a quiet rest
 *  state. Pulse is for attention on first appearance, not nagging. */
const PULSE_DURATION_MS = 6000

let mounted = false
/** Tracks the badge's pulse-settle setTimeout so dispose / dismiss
 *  / expand paths can cancel it. Without this, a stale callback
 *  from a previous show could later fire after a new badge has
 *  been mounted and silently strip its pulse. */
let pulseTimer: ReturnType<typeof setTimeout> | null = null

/** Cancel any pending pulse-settle timer. Idempotent. */
function clearPulseTimer(): void {
  if (pulseTimer != null) {
    clearTimeout(pulseTimer)
    pulseTimer = null
  }
}

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

/** True when the viewport is small enough that the full banner
 *  would obscure most of the app. Exported for tests. */
export function isSmallViewport(): boolean {
  return (
    window.innerWidth <= SMALL_VIEWPORT_WIDTH ||
    window.innerHeight <= SMALL_VIEWPORT_HEIGHT
  )
}

/** Push a one-time polite announcement to the app-wide ARIA
 *  live region (`#a11y-announcer`) — used to make the badge
 *  discoverable to screen-reader users without the badge itself
 *  needing to be a live region (a button-as-live-region is
 *  unusual and easy for AT to misinterpret). The full banner
 *  carries `aria-live="polite"` directly because it's a region;
 *  the badge defers to the shared announcer instead. */
function announcePolite(message: string): void {
  const live = document.getElementById('a11y-announcer')
  if (!live) return
  // Clear, then set on next frame — guarantees the announcement
  // fires even if the announcer happens to already contain the
  // same string from a prior call.
  live.textContent = ''
  requestAnimationFrame(() => {
    live.textContent = message
  })
}

/** Build + attach the full banner DOM. */
function buildBanner(): HTMLElement {
  const banner = document.createElement('section')
  banner.id = 'disclosure-banner'
  banner.className = 'disclosure-banner'
  banner.setAttribute('role', 'region')
  // setAttribute is API-level (browser handles attribute escaping
  // internally), so plain t() is safe here. innerHTML below is
  // string-level: every translated value flows through tHtml/tAttr.
  banner.setAttribute('aria-label', t('disclosureBanner.aria'))
  banner.setAttribute('aria-live', 'polite')
  banner.innerHTML = `
    <p class="disclosure-banner-text">${tHtml('disclosureBanner.text')}</p>
    <div class="disclosure-banner-actions">
      <button
        type="button"
        id="disclosure-banner-settings"
        class="disclosure-banner-btn disclosure-banner-btn-secondary"
      >${tHtml('disclosureBanner.settings')}</button>
      <a
        id="disclosure-banner-policy"
        class="disclosure-banner-link"
        href="/privacy"
        target="_blank"
        rel="noopener"
      >${tHtml('disclosureBanner.policy')}</a>
      <button
        type="button"
        id="disclosure-banner-dismiss"
        class="disclosure-banner-btn disclosure-banner-btn-primary"
        aria-label="${tAttr('disclosureBanner.dismiss.aria')}"
      >${tHtml('disclosureBanner.dismiss')}</button>
    </div>
  `
  document.body.appendChild(banner)
  return banner
}

/** Build + attach the small-viewport badge (pulsing shield icon).
 *  Click expands to the full banner. */
function buildBadge(): HTMLElement {
  const badge = document.createElement('button')
  badge.id = 'disclosure-badge'
  badge.type = 'button'
  badge.className = 'disclosure-badge disclosure-badge--pulse'
  badge.setAttribute('aria-label', t('disclosureBanner.badge.aria'))
  badge.innerHTML = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M12 2 L4 5 V12 C4 17 7.5 21 12 22 C16.5 21 20 17 20 12 V5 L12 2 Z" fill="currentColor" />
      <path d="M8.5 12 L11 14.5 L15.5 9.5" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  `
  document.body.appendChild(badge)
  return badge
}

/** Wire the standard banner buttons (dismiss + settings shortcut).
 *  Used both when the banner renders directly on a large viewport
 *  AND when it expands from the small-viewport badge on click. */
function wireBannerHandlers(): void {
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
}

/** Tear down the badge and render the full banner in its place.
 *  Triggered by the user tapping the badge.
 *
 *  Focus management: the user just clicked a button (the badge)
 *  that no longer exists in the DOM, so the browser would drop
 *  focus to <body> by default — bad for keyboard / screen-reader
 *  users. Move focus to the dismiss button so the next Tab /
 *  Enter has a sensible target. */
function expandBadgeToBanner(): void {
  clearPulseTimer()
  document.getElementById('disclosure-badge')?.remove()
  buildBanner()
  wireBannerHandlers()
  const focusTarget = document.getElementById('disclosure-banner-dismiss')
  if (focusTarget instanceof HTMLElement) {
    focusTarget.focus()
  }
}

/** Dismiss: persist, emit, remove DOM. Tolerates either form
 *  (banner or badge) being live. */
function dismiss(): void {
  clearPulseTimer()
  markSeen()
  emit({
    event_type: 'settings_changed',
    key: 'disclosure_seen',
    value_class: 'dismissed',
  })
  document.getElementById('disclosure-banner')?.remove()
  document.getElementById('disclosure-badge')?.remove()
  mounted = false
}

/**
 * Show the banner if the user has not already dismissed it.
 * Idempotent — a second call while the banner is visible is a no-op.
 * Returns true when the banner (or badge) was actually rendered.
 */
export function showDisclosureBannerIfNeeded(): boolean {
  if (mounted) return false
  if (hasSeenDisclosure()) return false
  mounted = true

  if (isSmallViewport()) {
    const badge = buildBadge()
    badge.addEventListener('click', () => expandBadgeToBanner(), { once: true })
    // Make the badge discoverable to screen-reader users. The
    // full banner is itself an aria-live region (it's a text
    // region the visitor was meant to read); the badge is just
    // a button, so it defers to the app-wide #a11y-announcer.
    // Without this, AT users would only learn about the privacy
    // notice if they happened to tab onto the badge.
    announcePolite(t('disclosureBanner.announce'))
    // Settle the pulse after a few seconds even if the user
    // doesn't tap — pulse is for attention on first appearance,
    // not for steady nagging. Capture the badge in the closure so
    // a stale callback can never strip the pulse class from a
    // *different* badge mounted later (after dispose / re-show).
    // We also store the timer id at module scope so dispose paths
    // can cancel it eagerly.
    clearPulseTimer()
    pulseTimer = setTimeout(() => {
      pulseTimer = null
      badge.classList.remove('disclosure-badge--pulse')
    }, PULSE_DURATION_MS)
  } else {
    buildBanner()
    wireBannerHandlers()
  }

  return true
}

/** Tear down. Idempotent. Exposed for tests. */
export function disposeDisclosureBanner(): void {
  clearPulseTimer()
  document.getElementById('disclosure-banner')?.remove()
  document.getElementById('disclosure-badge')?.remove()
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
