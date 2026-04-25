/**
 * Privacy UI — the Tools → Privacy panel.
 *
 * Small modal dialog housing:
 *   - a radio group for the telemetry tier (Essential / Research / Off)
 *   - a read-only display of the current in-memory session ID
 *   - a link to the full policy at `/privacy`
 *   - a polite live-region for status announcements
 *
 * The panel is lazy-mounted on first `openPrivacyUI()` and kept in
 * the DOM afterwards so repeat opens are cheap and focus/aria state
 * stays predictable. Escape + outside-click close it.
 *
 * Tier changes persist via `setTier()` and apply the runtime buffer
 * consequences via `applyTierChange()` (drop all on Off, strip
 * Tier B on Research → Essential). The emitted `settings_changed`
 * event carries the key `telemetry_tier` and a `value_class` of
 * the new tier; per the sanitizer rules the tier itself is safe
 * to emit verbatim as it is a fixed enum.
 */

import {
  applyTierChange,
  emit,
  getSessionId,
  loadConfig,
  setTier,
} from '../analytics'
import type { TelemetryTier } from '../types'

let mounted = false
let isOpen = false
let lastTrigger: HTMLElement | null = null
let listenerController: AbortController | null = null

const TIER_LABELS: Record<TelemetryTier, string> = {
  essential: 'Essential',
  research: 'Research',
  off: 'Off',
}

const TIER_DESCRIPTIONS: Record<TelemetryTier, string> = {
  essential:
    'Anonymous health and usage events so we can keep the app working. On by default.',
  research:
    'Adds panel dwell times, Orbit interactions, and sanitized stack frames so we can improve the docent. Opt-in.',
  off:
    'No telemetry events are sent. The app works exactly the same.',
}

/** Build the panel HTML. Called once on first open. */
function buildPanel(): HTMLElement {
  const host = document.createElement('div')
  host.id = 'privacy-ui-host'
  host.innerHTML = `
    <div id="privacy-ui-backdrop" class="privacy-ui-backdrop hidden" aria-hidden="true"></div>
    <section
      id="privacy-ui-panel"
      class="privacy-ui-panel hidden"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-ui-title"
      aria-describedby="privacy-ui-desc"
    >
      <header class="privacy-ui-header">
        <h2 id="privacy-ui-title">Privacy</h2>
        <button
          type="button"
          id="privacy-ui-close"
          class="privacy-ui-close"
          aria-label="Close privacy settings"
        >&#x2715;</button>
      </header>
      <p id="privacy-ui-desc" class="privacy-ui-desc">
        Choose how much the app reports back. You can change this at any time; the change takes effect immediately.
      </p>
      <fieldset class="privacy-ui-tiers" role="radiogroup" aria-label="Telemetry tier">
        <legend class="sr-only">Telemetry tier</legend>
        ${renderTierOption('essential')}
        ${renderTierOption('research')}
        ${renderTierOption('off')}
      </fieldset>
      <div class="privacy-ui-meta">
        <div class="privacy-ui-session">
          <span class="privacy-ui-session-label">Session ID</span>
          <code id="privacy-ui-session-id" class="privacy-ui-session-id"></code>
          <span class="privacy-ui-session-hint">In-memory only · resets on relaunch</span>
        </div>
        <a class="privacy-ui-policy-link" href="/privacy" target="_blank" rel="noopener">
          Read the full privacy policy &rarr;
        </a>
      </div>
      <div id="privacy-ui-status" class="privacy-ui-status" role="status" aria-live="polite"></div>
    </section>
  `
  document.body.appendChild(host)
  return host
}

function renderTierOption(tier: TelemetryTier): string {
  return `
    <label class="privacy-ui-tier">
      <input
        type="radio"
        name="privacy-ui-tier"
        value="${tier}"
        data-tier="${tier}"
      />
      <span class="privacy-ui-tier-body">
        <span class="privacy-ui-tier-label">${TIER_LABELS[tier]}</span>
        <span class="privacy-ui-tier-desc">${TIER_DESCRIPTIONS[tier]}</span>
      </span>
    </label>
  `
}

/** Set the radio group to reflect the currently persisted tier. */
function syncRadios(): void {
  const current = loadConfig().tier
  const radios = document.querySelectorAll<HTMLInputElement>('input[name="privacy-ui-tier"]')
  radios.forEach((r) => {
    r.checked = r.value === current
  })
}

/** Refresh the session-ID display. Called on every open because the
 * ID rotates on app relaunch; no need to observe it continuously. */
function syncSessionId(): void {
  const el = document.getElementById('privacy-ui-session-id')
  if (el) el.textContent = getSessionId()
}

/** Wire up listeners on the mounted panel. Uses an AbortController
 * so re-init (tests / HMR) cleanly removes every handler. */
function wireEvents(): void {
  listenerController?.abort()
  listenerController = new AbortController()
  const { signal } = listenerController

  document
    .getElementById('privacy-ui-close')
    ?.addEventListener('click', () => closePrivacyUI(), { signal })

  document
    .getElementById('privacy-ui-backdrop')
    ?.addEventListener('click', () => closePrivacyUI(), { signal })

  const radios = document.querySelectorAll<HTMLInputElement>('input[name="privacy-ui-tier"]')
  radios.forEach((r) => {
    r.addEventListener(
      'change',
      () => {
        if (!r.checked) return
        const tier = r.value as TelemetryTier
        handleTierChange(tier)
      },
      { signal },
    )
  })

  document.addEventListener(
    'keydown',
    (ev) => {
      if (!isOpen) return
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        closePrivacyUI()
      } else if (ev.key === 'Tab') {
        trapFocus(ev)
      }
    },
    { signal },
  )
}

/** Return focusable descendants of the modal panel, skipping
 * disabled controls. Doesn't bother filtering by computed style —
 * the modal is binary open/closed and contains no nested hidden
 * subtrees, so every matching element in the panel is visible
 * whenever the panel is. */
function getFocusableInPanel(): HTMLElement[] {
  const panel = document.getElementById('privacy-ui-panel')
  if (!panel) return []
  return Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  )
}

/** Cycle Tab / Shift-Tab between the first and last focusable
 * elements inside the modal so keyboard focus can't escape to the
 * underlying page while the dialog is open. Required by
 * `aria-modal="true"`. */
function trapFocus(ev: KeyboardEvent): void {
  const focusables = getFocusableInPanel()
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement as HTMLElement | null
  const panel = document.getElementById('privacy-ui-panel')
  const withinPanel = !!(active && panel?.contains(active))

  if (ev.shiftKey) {
    if (!withinPanel || active === first) {
      ev.preventDefault()
      last.focus()
    }
  } else {
    if (!withinPanel || active === last) {
      ev.preventDefault()
      first.focus()
    }
  }
}

/** Persist the new tier, apply buffer consequences, announce. */
function handleTierChange(tier: TelemetryTier): void {
  setTier(tier)
  applyTierChange(tier)
  emit({
    event_type: 'settings_changed',
    key: 'telemetry_tier',
    value_class: tier,
  })
  announce(
    tier === 'off'
      ? 'Telemetry off. Pending events discarded.'
      : `Telemetry set to ${TIER_LABELS[tier]}.`,
  )
}

function announce(message: string): void {
  const status = document.getElementById('privacy-ui-status')
  if (!status) return
  status.textContent = message
}

/** Ensure the panel exists in the DOM and its listeners are wired. */
function ensureMounted(): void {
  if (mounted) return
  buildPanel()
  wireEvents()
  mounted = true
}

/** Open the privacy settings panel. Opens lazily on first call. */
export function openPrivacyUI(triggeredBy?: HTMLElement | null): void {
  ensureMounted()
  syncRadios()
  syncSessionId()
  const panel = document.getElementById('privacy-ui-panel')
  const backdrop = document.getElementById('privacy-ui-backdrop')
  panel?.classList.remove('hidden')
  backdrop?.classList.remove('hidden')
  panel?.setAttribute('aria-hidden', 'false')
  backdrop?.setAttribute('aria-hidden', 'false')
  isOpen = true
  lastTrigger = triggeredBy ?? null
  // Focus the currently-selected radio so keyboard users land inside
  // the dialog on the right option.
  const selected = document.querySelector<HTMLInputElement>(
    'input[name="privacy-ui-tier"]:checked',
  )
  selected?.focus()
}

/** Close the panel and return focus to whatever opened it. */
export function closePrivacyUI(): void {
  const panel = document.getElementById('privacy-ui-panel')
  const backdrop = document.getElementById('privacy-ui-backdrop')
  panel?.classList.add('hidden')
  backdrop?.classList.add('hidden')
  panel?.setAttribute('aria-hidden', 'true')
  backdrop?.setAttribute('aria-hidden', 'true')
  isOpen = false
  lastTrigger?.focus()
  lastTrigger = null
}

/** Whether the panel is currently open. Used by tests. */
export function isPrivacyUIOpen(): boolean {
  return isOpen
}

/** Tear down listeners and DOM. Idempotent. Used by tests. */
export function disposePrivacyUI(): void {
  listenerController?.abort()
  listenerController = null
  const host = document.getElementById('privacy-ui-host')
  host?.remove()
  mounted = false
  isOpen = false
  lastTrigger = null
}
