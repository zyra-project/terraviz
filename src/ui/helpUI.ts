// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Help UI — floating panel with a Guide tab and a Feedback form.
 *
 * The Guide tab renders static how-to content explaining the app's
 * features. The Feedback tab submits bug reports / feature requests
 * to /api/general-feedback, optionally attaching a screenshot of the
 * current globe view via the shared screenshotService helper.
 *
 * Two triggers share one open/close handler:
 *   - #help-trigger — floating top-right, hidden when browse is open
 *   - #help-trigger-browse — inside the browse overlay header
 */

import type { GeneralFeedbackKind, GeneralFeedbackPayload, FeedbackKind } from '../types'
import { captureFullScreen } from '../services/screenshotService'
import { submitGeneralFeedback } from '../services/generalFeedbackService'
import { closeChat } from './chatUI'
import { logger } from '../utils/logger'
import { emit } from '../analytics'
import { t, tAttr, tHtml, type MessageKey } from '../i18n'
import { sanitizeGuideHtml } from './sanitizeHtml'

const IS_TAURI = !!(window as any).__TAURI__
const MESSAGE_MAX = 2000
const MESSAGE_MIN = 10

type TabKey = 'guide' | 'feedback'

let currentTab: TabKey = 'guide'
let isOpen = false
let lastTrigger: HTMLElement | null = null
let activeDatasetId: string | null = null

/** Called by main.ts when a dataset loads so bug reports can include it. */
export function setActiveDataset(id: string | null): void {
  activeDatasetId = id
}

/** Whether the current viewport is a portrait phone (matches the CSS breakpoint). */
function isPortraitPhone(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(max-width: 600px) and (orientation: portrait)').matches
}

/** Build the guide tab HTML. Each section is one translated HTML
 *  blob in `locales/*.json` so translators can render it whole;
 *  the structural <section> wrapper + ordering live here. */
function renderGuideHtml(): string {
  // Section keys in display order. The downloads section is gated
  // on Tauri (desktop builds) so the web build doesn't show
  // instructions for a feature it lacks.
  const sectionKeys: MessageKey[] = [
    'help.guide.section.navigating',
    'help.guide.section.exploring',
    'help.guide.section.tools',
    'help.guide.section.multiglobe',
    'help.guide.section.tours',
    'help.guide.section.orbit',
  ]
  if (IS_TAURI) sectionKeys.push('help.guide.section.downloads')
  sectionKeys.push('help.guide.section.shortcuts', 'help.guide.section.privacy')

  // Each section's HTML body is translator-supplied (Weblate). Run
  // it through the allowlist sanitizer before injecting into
  // innerHTML so a malicious or accidental translation can't
  // smuggle <script>, on*-handlers, or javascript: hrefs.
  // scripts/generate-locales.ts catches obvious cases at build
  // time too; this is the runtime backstop.
  return sectionKeys
    .map((key) => `<section class="help-guide-section">${sanitizeGuideHtml(t(key))}</section>`)
    .join('\n')
}

/** Build the feedback tab HTML (form). Translator content arrives
 *  via Weblate (untrusted); every t() lands in innerHTML so each
 *  one flows through tHtml (text content) or tAttr (quoted attr
 *  value) for defense in depth. */
function renderFeedbackHtml(): string {
  return `
    <form id="help-feedback-form" novalidate>
      <fieldset class="help-form-kind" role="radiogroup" aria-label="${tAttr('help.feedback.kind.aria')}">
        <label class="help-kind-option">
          <input type="radio" name="help-kind" value="bug" checked />
          <span>${tHtml('help.feedback.kind.bug')}</span>
        </label>
        <label class="help-kind-option">
          <input type="radio" name="help-kind" value="feature" />
          <span>${tHtml('help.feedback.kind.feature')}</span>
        </label>
        <label class="help-kind-option">
          <input type="radio" name="help-kind" value="other" />
          <span>${tHtml('help.feedback.kind.other')}</span>
        </label>
      </fieldset>
      <label class="help-form-label" for="help-feedback-message">${tHtml('help.feedback.message.label')}</label>
      <textarea
        id="help-feedback-message"
        name="message"
        rows="6"
        maxlength="${MESSAGE_MAX}"
        required
        aria-describedby="help-feedback-counter"
        placeholder="${tAttr('help.feedback.message.placeholder')}"
      ></textarea>
      <div class="help-form-meta">
        <span id="help-feedback-counter" aria-live="polite">${tHtml('help.feedback.counter', { count: 0, max: MESSAGE_MAX })}</span>
      </div>
      <label class="help-form-label" for="help-feedback-contact">${tHtml('help.feedback.contact.label')}</label>
      <input
        id="help-feedback-contact"
        name="contact"
        type="text"
        maxlength="200"
        placeholder="${tAttr('help.feedback.contact.placeholder')}"
        autocomplete="off"
      />
      <label class="help-form-check">
        <input type="checkbox" id="help-feedback-screenshot" name="screenshot" />
        <span>${tHtml('help.feedback.screenshot.label')}</span>
      </label>
      <div id="help-feedback-status" class="help-form-status" role="status" aria-live="polite"></div>
      <div class="help-form-actions">
        <button type="submit" id="help-feedback-submit" class="help-btn-primary">${tHtml('help.feedback.submit')}</button>
      </div>
    </form>
  `
}

/** Build the full panel body for the active tab. */
function renderPanelBody(): void {
  const guidePanel = document.getElementById('help-tabpanel-guide')
  const feedbackPanel = document.getElementById('help-tabpanel-feedback')
  if (guidePanel && !guidePanel.dataset.rendered) {
    guidePanel.innerHTML = renderGuideHtml()
    guidePanel.dataset.rendered = 'true'
  }
  if (feedbackPanel && !feedbackPanel.dataset.rendered) {
    feedbackPanel.innerHTML = renderFeedbackHtml()
    feedbackPanel.dataset.rendered = 'true'
    wireFeedbackForm()
  }
}

/** Switch the active tab. */
function selectTab(key: TabKey): void {
  currentTab = key
  const tabs = document.querySelectorAll<HTMLElement>('.help-tab')
  tabs.forEach(tab => {
    const selected = tab.dataset.tab === key
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    tab.classList.toggle('active', selected)
  })
  const guidePanel = document.getElementById('help-tabpanel-guide')
  const feedbackPanel = document.getElementById('help-tabpanel-feedback')
  if (guidePanel) guidePanel.classList.toggle('hidden', key !== 'guide')
  if (feedbackPanel) feedbackPanel.classList.toggle('hidden', key !== 'feedback')
  if (key === 'feedback') {
    const first = document.getElementById('help-feedback-message') as HTMLTextAreaElement | null
    first?.focus()
  }
}

/** Open the help panel. */
export function openHelp(triggeredBy?: HTMLElement): void {
  const panel = document.getElementById('help-panel')
  if (!panel) return
  if (isPortraitPhone()) {
    // On portrait phones the sheet is full-screen, so dismiss chat to
    // avoid trapping focus behind an invisible panel.
    closeChat()
  }
  panel.classList.remove('hidden')
  panel.setAttribute('aria-hidden', 'false')
  // Backdrop is visible on desktop only (CSS hides it at tablet and
  // portrait breakpoints), but we toggle the class unconditionally.
  document.getElementById('help-backdrop')?.classList.remove('hidden')
  isOpen = true
  lastTrigger = triggeredBy ?? document.getElementById('help-trigger')
  document.getElementById('help-trigger')?.setAttribute('aria-expanded', 'true')
  document.getElementById('help-trigger-browse')?.setAttribute('aria-expanded', 'true')
  renderPanelBody()
  selectTab(currentTab)
  // Move focus into the dialog for keyboard/screen-reader users.
  // selectTab() already focuses the feedback textarea when opening
  // on the feedback tab; for the guide tab, focus the active tab
  // button so focus isn't stranded outside the dialog.
  if (currentTab !== 'feedback') {
    const activeTab = panel.querySelector<HTMLElement>('.help-tab[aria-selected="true"]')
    activeTab?.focus()
  }
}

/** Close the help panel. */
export function closeHelp(): void {
  const panel = document.getElementById('help-panel')
  if (!panel) return
  panel.classList.add('hidden')
  panel.setAttribute('aria-hidden', 'true')
  document.getElementById('help-backdrop')?.classList.add('hidden')
  isOpen = false
  document.getElementById('help-trigger')?.setAttribute('aria-expanded', 'false')
  document.getElementById('help-trigger-browse')?.setAttribute('aria-expanded', 'false')
  // Return focus to the trigger that opened the panel
  lastTrigger?.focus()
}

/** Toggle the help panel. Exported so both triggers and browseUI can call it. */
export function toggleHelp(triggeredBy?: HTMLElement): void {
  if (isOpen) closeHelp()
  else openHelp(triggeredBy)
}

/** Wire up the feedback form's submit and character-counter. */
function wireFeedbackForm(): void {
  const form = document.getElementById('help-feedback-form') as HTMLFormElement | null
  const textarea = document.getElementById('help-feedback-message') as HTMLTextAreaElement | null
  const counter = document.getElementById('help-feedback-counter')
  const status = document.getElementById('help-feedback-status')
  const submit = document.getElementById('help-feedback-submit') as HTMLButtonElement | null
  if (!form || !textarea || !counter || !status || !submit) return

  // Attach to the same AbortController signal used by initHelpUI() so
  // disposeHelpUI() tears these listeners down alongside the global
  // ones. Prevents listener accumulation on hot-reload / repeat init.
  const signal = listenerController?.signal

  const updateCounter = () => {
    counter.textContent = t('help.feedback.counter', { count: textarea.value.length, max: MESSAGE_MAX })
  }
  textarea.addEventListener('input', updateCounter, signal ? { signal } : undefined)
  updateCounter()

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    // Disable immediately so a double-click (or Enter-spam) can't fire
    // a second submission while we're capturing a screenshot or
    // waiting on the server. Re-enabled on every exit path below.
    if (submit.disabled) return
    submit.disabled = true
    try {
      const message = textarea.value.trim()
      if (message.length < MESSAGE_MIN) {
        status.textContent = t('help.feedback.status.tooShort', { min: MESSAGE_MIN })
        status.className = 'help-form-status error'
        textarea.focus()
        return
      }
      const kindInput = form.querySelector<HTMLInputElement>('input[name="help-kind"]:checked')
      const kind = (kindInput?.value ?? 'bug') as GeneralFeedbackKind
      const contactEl = document.getElementById('help-feedback-contact') as HTMLInputElement | null
      const screenshotEl = document.getElementById('help-feedback-screenshot') as HTMLInputElement | null

      let screenshot: string | undefined
      if (screenshotEl?.checked) {
        status.textContent = t('help.feedback.status.capturing')
        status.className = 'help-form-status'
        const captured = await captureFullScreen()
        if (captured) {
          screenshot = captured
        } else {
          // Capture can hang or fail on mobile Safari and other
          // constrained environments. Rather than stranding the
          // user, surface a clear message and continue with the
          // text-only report — the description is usually the
          // most valuable part of a bug report anyway.
          status.textContent = t('help.feedback.status.captureFailed')
          status.className = 'help-form-status'
          // Brief pause so the user reads the message before the
          // status flips to "Sending…".
          await new Promise((resolve) => setTimeout(resolve, 800))
        }
      }

      const payload: GeneralFeedbackPayload = {
        kind,
        message,
        contact: contactEl?.value.trim() || undefined,
        url: typeof window !== 'undefined' ? window.location.href : undefined,
        platform: IS_TAURI ? 'desktop' : 'web',
        datasetId: activeDatasetId,
        screenshot,
      }

      status.textContent = t('help.feedback.status.sending')
      status.className = 'help-form-status'

      const result = await submitGeneralFeedback(payload)

      emit({
        event_type: 'feedback',
        context: 'general',
        kind: kind as FeedbackKind,
        status: result.ok ? 'ok' : 'error',
        rating: 0,
      })

      if (result.ok) {
        form.reset()
        updateCounter()
        status.textContent = t('help.feedback.status.success')
        status.className = 'help-form-status success'
      } else {
        // status.textContent does not interpret HTML, so pass the raw
        // server error string — escaping would show users literal
        // '&lt;' etc. instead of the intended characters.
        status.textContent = result.error
          ? t('help.feedback.status.failedReason', { error: result.error })
          : t('help.feedback.status.failed')
        status.className = 'help-form-status error'
        logger.warn('[helpUI] submit failed', result)
      }
    } finally {
      submit.disabled = false
    }
  }, signal ? { signal } : undefined)
}

/** Handle arrow-key navigation between tabs. */
function onTabKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const next: TabKey = currentTab === 'guide' ? 'feedback' : 'guide'
  selectTab(next)
  const nextTab = document.querySelector<HTMLElement>(`.help-tab[data-tab="${next}"]`)
  nextTab?.focus()
}

/** Click-outside handler — closes the panel when clicking outside it. */
function onDocumentClick(e: MouseEvent): void {
  if (!isOpen) return
  const target = e.target as Node | null
  if (!target) return
  const panel = document.getElementById('help-panel')
  const trigger = document.getElementById('help-trigger')
  const triggerBrowse = document.getElementById('help-trigger-browse')
  if (panel?.contains(target)) return
  if (trigger?.contains(target)) return
  if (triggerBrowse?.contains(target)) return
  closeHelp()
}

/**
 * Return the currently focusable descendants of the help panel,
 * ignoring elements that are hidden via display:none or
 * tabindex="-1". Used by the focus trap so Tab/Shift-Tab cycle
 * within the dialog instead of escaping to the underlying page.
 */
function getFocusableInPanel(): HTMLElement[] {
  const panel = document.getElementById('help-panel')
  if (!panel) return []
  const nodes = panel.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )
  return Array.from(nodes).filter((el) => {
    // display:none elements have no offsetParent (except <body>).
    // Also skip elements inside a display:none ancestor.
    if (el.offsetParent === null && el.tagName !== 'BODY') return false
    return true
  })
}

/**
 * Focus trap for the modal help dialog. Intercepts Tab / Shift-Tab
 * and cycles focus between the first and last focusable elements
 * inside the panel so keyboard users can't inadvertently move focus
 * to the underlying page while the dialog is open. Matches the
 * behavior implied by aria-modal="true" on the panel.
 */
function onTrapFocus(e: KeyboardEvent): void {
  if (!isOpen || e.key !== 'Tab') return
  const focusables = getFocusableInPanel()
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  const active = document.activeElement as HTMLElement | null
  const panel = document.getElementById('help-panel')
  const withinPanel = !!(active && panel?.contains(active))

  if (e.shiftKey) {
    if (!withinPanel || active === first) {
      e.preventDefault()
      last.focus()
    }
  } else {
    if (!withinPanel || active === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

// AbortController whose signal is passed to every listener added by
// initHelpUI(). disposeHelpUI() calls .abort() to remove ALL listeners
// (document-level and element-level) at once. This keeps initHelpUI()
// idempotent for tests and hot-reload without having to track each
// listener individually.
let listenerController: AbortController | null = null

/**
 * Tear down all listeners added by initHelpUI() and restore the DOM
 * to a closed state. Exported primarily for tests and hot-reload;
 * also called internally at the top of initHelpUI() for idempotency.
 */
export function disposeHelpUI(): void {
  if (listenerController) {
    listenerController.abort()
    listenerController = null
  }
  // Reset DOM state so if initHelpUI() is called while the panel was
  // open (hot reload, test setup), the panel isn't left visibly
  // stranded with no working listeners.
  const panel = document.getElementById('help-panel')
  panel?.classList.add('hidden')
  panel?.setAttribute('aria-hidden', 'true')
  document.getElementById('help-backdrop')?.classList.add('hidden')
  document.getElementById('help-trigger')?.setAttribute('aria-expanded', 'false')
  document.getElementById('help-trigger-browse')?.setAttribute('aria-expanded', 'false')
  isOpen = false
  lastTrigger = null
}

/** Initialize the help UI — wire up triggers, tabs, and global handlers. */
export function initHelpUI(): void {
  // Tear down any existing listeners and reset DOM state first so
  // repeat calls (tests, hot reload) don't accumulate handlers.
  disposeHelpUI()

  const trigger = document.getElementById('help-trigger')
  const panel = document.getElementById('help-panel')
  if (!trigger || !panel) {
    logger.warn('[helpUI] help-trigger or help-panel not found in DOM')
    return
  }

  listenerController = new AbortController()
  const { signal } = listenerController

  trigger.addEventListener('click', () => toggleHelp(trigger), { signal })

  // Close button in the panel header (visible on portrait phones; harmless elsewhere)
  const closeBtn = document.getElementById('help-close')
  closeBtn?.addEventListener('click', closeHelp, { signal })

  // Tab list
  const tabs = document.querySelectorAll<HTMLElement>('.help-tab')
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const key = tab.dataset.tab as TabKey | undefined
      if (key) selectTab(key)
    }, { signal })
    tab.addEventListener('keydown', onTabKeyDown, { signal })
  })

  // Global handlers
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isOpen) {
      e.stopPropagation()
      closeHelp()
    }
  }, { signal })
  document.addEventListener('click', onDocumentClick, { signal })
  // Focus trap — paired with aria-modal="true" on #help-panel so
  // keyboard focus can't escape the dialog while it's open.
  document.addEventListener('keydown', onTrapFocus, { signal })
}
