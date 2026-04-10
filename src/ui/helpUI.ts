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

import type { GeneralFeedbackKind, GeneralFeedbackPayload } from '../types'
import { captureFullScreen } from '../services/screenshotService'
import { submitGeneralFeedback } from '../services/generalFeedbackService'
import { closeChat } from './chatUI'
import { logger } from '../utils/logger'

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

/** Build the guide tab HTML. Content is static; desktop-only sections gated on IS_TAURI. */
function renderGuideHtml(): string {
  const downloadsSection = IS_TAURI
    ? `
    <section class="help-guide-section">
      <h3>Offline downloads</h3>
      <ul>
        <li>Click the download icon on any dataset card to cache it locally.</li>
        <li>Downloaded datasets open instantly, even without an internet connection.</li>
        <li>Manage cached datasets from the download panel to see sizes or delete old ones.</li>
      </ul>
    </section>`
    : ''

  return `
    <section class="help-guide-section">
      <h3>Navigating the globe</h3>
      <ul>
        <li>Drag to rotate the Earth.</li>
        <li>Scroll or pinch to zoom.</li>
        <li>Double-click a location to focus on it.</li>
      </ul>
    </section>
    <section class="help-guide-section">
      <h3>Exploring datasets</h3>
      <ul>
        <li>Open the dataset browser from the home button or the right-edge tab.</li>
        <li>Filter by category or search by keyword to narrow the list.</li>
        <li>Click any card to load that dataset onto the globe.</li>
      </ul>
    </section>
    <section class="help-guide-section">
      <h3>Guided tours</h3>
      <ul>
        <li>Tours are scripted sequences that fly the camera, swap datasets, and narrate a topic.</li>
        <li>Start a tour from the browse panel — tour cards are marked with a play icon.</li>
        <li>Use the on-screen transport controls to play, pause, or skip between tour steps.</li>
        <li>Some tours pause for questions or user input; click continue to resume.</li>
      </ul>
    </section>
    <section class="help-guide-section">
      <h3>Talking to Orbit</h3>
      <ul>
        <li>Orbit is the digital docent — an AI assistant that can recommend datasets and explain what you're seeing.</li>
        <li>Open the chat panel from the bottom-left trigger or the speech-bubble button in the browse panel.</li>
        <li>Orbit can embed load buttons directly in its replies — click one to jump straight to that dataset.</li>
        <li>Use the thumbs-up / thumbs-down buttons under each reply to rate Orbit's answers.</li>
      </ul>
    </section>
    <section class="help-guide-section">
      <h3>Map controls</h3>
      <ul>
        <li>Toggle labels, boundaries, and 3D terrain from the map controls in the top-left.</li>
      </ul>
    </section>${downloadsSection}
    <section class="help-guide-section">
      <h3>Keyboard shortcuts</h3>
      <ul>
        <li><kbd>Esc</kbd> — close the active panel</li>
        <li><kbd>Enter</kbd> — send a chat message</li>
        <li><kbd>Space</kbd> — toggle playback when a video dataset is loaded</li>
      </ul>
    </section>
    <section class="help-guide-section">
      <h3>Privacy</h3>
      <p>Feedback submissions store the text you type plus your browser's user agent and the current page URL. Attaching a screenshot is optional and opt-in. We do not collect analytics or tracking cookies.</p>
    </section>
  `
}

/** Build the feedback tab HTML (form). */
function renderFeedbackHtml(): string {
  return `
    <form id="help-feedback-form" novalidate>
      <fieldset class="help-form-kind" role="radiogroup" aria-label="Feedback type">
        <label class="help-kind-option">
          <input type="radio" name="help-kind" value="bug" checked />
          <span>Bug report</span>
        </label>
        <label class="help-kind-option">
          <input type="radio" name="help-kind" value="feature" />
          <span>Feature request</span>
        </label>
        <label class="help-kind-option">
          <input type="radio" name="help-kind" value="other" />
          <span>Other</span>
        </label>
      </fieldset>
      <label class="help-form-label" for="help-feedback-message">
        Describe what happened or what you'd like to see
      </label>
      <textarea
        id="help-feedback-message"
        name="message"
        rows="6"
        maxlength="${MESSAGE_MAX}"
        required
        aria-describedby="help-feedback-counter"
        placeholder="Tell us as much as you can — steps to reproduce, what you expected, and what actually happened."
      ></textarea>
      <div class="help-form-meta">
        <span id="help-feedback-counter" aria-live="polite">0 / ${MESSAGE_MAX}</span>
      </div>
      <label class="help-form-label" for="help-feedback-contact">
        Contact (optional)
      </label>
      <input
        id="help-feedback-contact"
        name="contact"
        type="text"
        maxlength="200"
        placeholder="Email or handle — only used to follow up if we have questions"
        autocomplete="off"
      />
      <label class="help-form-check">
        <input type="checkbox" id="help-feedback-screenshot" name="screenshot" />
        <span>Attach a screenshot of the current view</span>
      </label>
      <div id="help-feedback-status" class="help-form-status" role="status" aria-live="polite"></div>
      <div class="help-form-actions">
        <button type="submit" id="help-feedback-submit" class="help-btn-primary">Send feedback</button>
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

  const updateCounter = () => {
    counter.textContent = `${textarea.value.length} / ${MESSAGE_MAX}`
  }
  textarea.addEventListener('input', updateCounter)
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
        status.textContent = `Please enter at least ${MESSAGE_MIN} characters.`
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
        status.textContent = 'Capturing screenshot\u2026'
        const captured = await captureFullScreen()
        if (captured) screenshot = captured
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

      status.textContent = 'Sending\u2026'
      status.className = 'help-form-status'

      const result = await submitGeneralFeedback(payload)

      if (result.ok) {
        form.reset()
        updateCounter()
        status.textContent = 'Thanks! Your feedback was received.'
        status.className = 'help-form-status success'
      } else {
        // status.textContent does not interpret HTML, so pass the raw
        // server error string — escaping would show users literal
        // '&lt;' etc. instead of the intended characters.
        status.textContent = result.error
          ? `Couldn't send feedback: ${result.error}`
          : "Couldn't send feedback"
        status.className = 'help-form-status error'
        logger.warn('[helpUI] submit failed', result)
      }
    } finally {
      submit.disabled = false
    }
  })
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
}
