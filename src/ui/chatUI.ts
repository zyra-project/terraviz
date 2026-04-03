/**
 * Chat UI — digital docent chat panel.
 *
 * Floating panel in the bottom-left with a trigger button.
 * Streams LLM responses token-by-token, falls back to local engine.
 * Persists conversation in sessionStorage, config in localStorage.
 */

import type { ChatMessage, ChatAction, ChatSession, DocentConfig, MapViewContext, ReadingLevel, FeedbackRating, FeedbackPayload } from '../types'
import type { Dataset } from '../types'
import { escapeHtml, escapeAttr } from './browseUI'
import { createMessageId } from '../services/docentEngine'
import { processMessage, loadConfig, saveConfig, testConnection, getDefaultConfig, isLocalDev, captureGlobeScreenshot, captureViewContext } from '../services/docentService'
import { ensureLoaded as ensureQALoaded } from '../services/qaService'
import { fetchModels } from '../services/llmProvider'

// --- Constants ---
const SESSION_STORAGE_KEY = 'sos-docent-chat'
const CHAT_OPENED_KEY = 'sos-docent-seen'
const MAX_MESSAGES = 200
const MAX_PERSISTED_MESSAGES = 100

export interface ChatCallbacks {
  onLoadDataset: (id: string) => void
  onFlyTo: (lat: number, lon: number, altitude?: number) => void
  onSetTime: (isoDate: string) => { success: boolean; message: string }
  onFitBounds: (bounds: [number, number, number, number], label?: string) => void
  onAddMarker: (lat: number, lng: number, label?: string) => void
  onToggleLabels: (visible: boolean) => void
  onHighlightRegion: (geojson: GeoJSON.GeoJSON, label?: string) => void
  getMapViewContext: () => MapViewContext | null
  getDatasets: () => Dataset[]
  getCurrentDataset: () => Dataset | null
  announce: (message: string) => void
  onOpenBrowse?: () => void
}

let callbacks: ChatCallbacks | null = null
let messages: ChatMessage[] = []
let isOpen = false
let isStreaming = false
let settingsOpen = false
let datasetPromptTimer: ReturnType<typeof setTimeout> | null = null

/** Globe-control actions deferred until a load-dataset action in the same message completes. */
let pendingGlobeActions: ChatAction[] = []

/** Tracks dataset load actions clicked per message (implicit positive feedback). */
const actionClickMap = new Map<string, string[]>()

/**
 * Initialize the chat UI with callbacks and restore session.
 */
export function initChatUI(cb: ChatCallbacks): void {
  callbacks = cb
  restoreSession()
  wireEvents()
  renderMessages()
  // Collapse trigger to icon-only if user has opened chat before
  if (localStorage.getItem(CHAT_OPENED_KEY)) {
    document.getElementById('chat-trigger')?.classList.add('collapsed')
  }
}

/**
 * Open the chat panel.
 */
export function openChat(): void {
  const panel = document.getElementById('chat-panel')
  const trigger = document.getElementById('chat-trigger')
  const browseChatBtn = document.getElementById('browse-chat-btn')
  if (!panel) return
  isOpen = true
  panel.classList.remove('hidden')
  // Pre-load Q&A knowledge base (fire-and-forget)
  void ensureQALoaded()
  trigger?.classList.add('chat-trigger-active')
  trigger?.setAttribute('aria-expanded', 'true')
  browseChatBtn?.classList.add('chat-trigger-active')
  // Collapse trigger to icon-only after first open
  localStorage.setItem(CHAT_OPENED_KEY, '1')
  trigger?.classList.add('collapsed')
  dismissDatasetPrompt()
  // Collapse info panel — both can't be tall at the same time
  const infoPanel = document.getElementById('info-panel')
  const infoHeader = document.getElementById('info-header')
  if (infoPanel?.classList.contains('expanded')) {
    infoPanel.classList.remove('expanded')
    infoHeader?.setAttribute('aria-expanded', 'false')
  }
  scrollToBottom()
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  input?.focus()
  callbacks?.announce('Chat opened')
}

/**
 * Close the chat panel.
 */
export function closeChat(): void {
  const panel = document.getElementById('chat-panel')
  const trigger = document.getElementById('chat-trigger')
  const browseChatBtn = document.getElementById('browse-chat-btn')
  if (!panel) return
  isOpen = false
  panel.classList.add('hidden')
  trigger?.classList.remove('chat-trigger-active')
  trigger?.setAttribute('aria-expanded', 'false')
  browseChatBtn?.classList.remove('chat-trigger-active')
  if (settingsOpen) toggleSettings()
  callbacks?.announce('Chat closed')
}

/**
 * Toggle the chat panel open/closed.
 */
export function toggleChat(): void {
  if (isOpen) closeChat()
  else openChat()
}

/**
 * Notify the chat that the current dataset changed.
 */
export function notifyDatasetChanged(dataset: Dataset | null): void {
  saveSession()
  if (dataset && !isOpen) {
    showDatasetPrompt(dataset)
  } else {
    dismissDatasetPrompt()
  }
}

/**
 * Get all current messages (for testing).
 */
export function getMessages(): ChatMessage[] {
  return [...messages]
}

/**
 * Clear chat history.
 */
export function clearChat(): void {
  messages = []
  actionClickMap.clear()
  saveSession()
  renderMessages()
}

// --- Globe control execution ---

/** Execute a globe-control action immediately. */
function executeGlobeAction(action: ChatAction): void {
  if (!callbacks) return
  if (action.type === 'fly-to') {
    callbacks.onFlyTo(action.lat, action.lon, action.altitude)
  } else if (action.type === 'set-time') {
    const result = callbacks.onSetTime(action.isoDate)
    if (!result.success) {
      callbacks.announce(result.message)
      // Update the status indicator in the DOM to show the error
      const statusEls = document.querySelectorAll('.chat-action-status')
      for (const el of statusEls) {
        if (el.textContent?.includes(action.isoDate)) {
          el.textContent = result.message
          el.classList.add('chat-action-status-err')
        }
      }
    }
  } else if (action.type === 'fit-bounds') {
    callbacks.onFitBounds(action.bounds, action.label)
  } else if (action.type === 'add-marker') {
    callbacks.onAddMarker(action.lat, action.lng, action.label)
  } else if (action.type === 'toggle-labels') {
    callbacks.onToggleLabels(action.visible)
  } else if (action.type === 'highlight-region') {
    callbacks.onHighlightRegion(action.geojson, action.label)
  }
}

/**
 * Flush any pending globe-control actions that were deferred while waiting
 * for a dataset to load. Call this after a dataset finishes loading from chat.
 */
export function flushPendingGlobeActions(): void {
  const actions = pendingGlobeActions.splice(0)
  for (const action of actions) {
    executeGlobeAction(action)
  }
}

// --- Session persistence ---

function saveSession(): void {
  const session: ChatSession = {
    messages: messages.slice(-MAX_PERSISTED_MESSAGES),
  }
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  } catch {
    // silently ignore
  }
}

function restoreSession(): void {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY)
    if (raw) {
      const session: ChatSession = JSON.parse(raw)
      messages = session.messages ?? []
    }
  } catch {
    messages = []
  }
}

// --- Event wiring ---

/**
 * Show the standalone floating chat trigger (used when a dataset is loaded).
 */
export function showChatTrigger(): void {
  const trigger = document.getElementById('chat-trigger')
  trigger?.classList.add('visible')
  // One-time pulse on first ever appearance to draw attention
  if (!localStorage.getItem(CHAT_OPENED_KEY)) {
    trigger?.classList.remove('pulse')
    // Force reflow so re-adding the class restarts the animation
    void trigger?.offsetWidth
    trigger?.classList.add('pulse')
  }
}

/**
 * Hide the standalone floating chat trigger (used when browse panel is shown).
 */
export function hideChatTrigger(): void {
  document.getElementById('chat-trigger')?.classList.remove('visible')
}

/** Wire DOM event listeners for the chat panel: trigger, input, send, settings, vision toggle. */
function wireEvents(): void {
  document.getElementById('chat-trigger')?.addEventListener('click', toggleChat)
  document.getElementById('browse-chat-btn')?.addEventListener('click', toggleChat)
  // Slide trigger continuously with the info panel as it opens/closes
  const infoPanel = document.getElementById('info-panel')
  if (infoPanel && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => updateTriggerForInfoPanel()).observe(infoPanel)
  }
  document.getElementById('chat-close')?.addEventListener('click', closeChat)
  document.getElementById('chat-send')?.addEventListener('click', handleSend)
  document.getElementById('chat-settings-btn')?.addEventListener('click', toggleSettings)

  // Prevent wheel events from bubbling to the globe's zoom handler
  document.getElementById('chat-panel')?.addEventListener('wheel', (e) => {
    e.stopPropagation()
  })

  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    })
    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 96) + 'px'
    })
  }

  document.getElementById('chat-clear')?.addEventListener('click', () => {
    clearChat()
    callbacks?.announce('Chat cleared')
  })

  // Vision toggle — syncs with DocentConfig.visionEnabled
  const visionBtn = document.getElementById('chat-vision-toggle')
  if (visionBtn) {
    // Restore persisted state
    const cfg = loadConfig()
    setVisionUI(cfg.visionEnabled)
    visionBtn.addEventListener('click', () => {
      const config = loadConfig()
      config.visionEnabled = !config.visionEnabled
      saveConfig(config)
      setVisionUI(config.visionEnabled)
      callbacks?.announce(config.visionEnabled ? 'Vision mode enabled' : 'Vision mode disabled')
    })
  }

  // Settings form
  document.getElementById('chat-settings-save')?.addEventListener('click', handleSettingsSave)
  document.getElementById('chat-settings-test')?.addEventListener('click', handleSettingsTest)
  // Re-fetch model list when the URL field loses focus with a changed value
  let lastFetchedUrl = ''
  const urlInput = document.getElementById('chat-settings-url') as HTMLInputElement | null
  urlInput?.addEventListener('blur', () => {
    const url = urlInput.value.trim()
    if (url && url !== lastFetchedUrl) {
      lastFetchedUrl = url
      void refreshModelSelect(url)
    }
  })
}

const VALID_READING_LEVELS: ReadingLevel[] = ['young-learner', 'general', 'in-depth', 'expert']
function isValidReadingLevel(value: string | undefined): value is ReadingLevel {
  return VALID_READING_LEVELS.includes(value as ReadingLevel)
}

// --- Vision UI helpers ---

/** Sync all vision-related UI elements with the given state. */
function setVisionUI(enabled: boolean): void {
  const btn = document.getElementById('chat-vision-toggle')
  const hint = document.getElementById('chat-vision-hint')
  const settingsCheck = document.getElementById('chat-settings-vision') as HTMLInputElement | null
  btn?.setAttribute('aria-pressed', String(enabled))
  hint?.classList.toggle('visible', enabled)
  if (settingsCheck) settingsCheck.checked = enabled
}

// --- Settings panel ---

function toggleSettings(): void {
  const panel = document.getElementById('chat-settings')
  if (!panel) return
  settingsOpen = !settingsOpen
  panel.classList.toggle('hidden', !settingsOpen)
  if (settingsOpen) {
    populateSettings()
  }
}

function populateSettings(): void {
  const config = loadConfig()
  const urlInput = document.getElementById('chat-settings-url') as HTMLInputElement | null
  const keyInput = document.getElementById('chat-settings-key') as HTMLInputElement | null
  const enabledInput = document.getElementById('chat-settings-enabled') as HTMLInputElement | null
  const visionInput = document.getElementById('chat-settings-vision') as HTMLInputElement | null
  const debugInput = document.getElementById('chat-settings-debug') as HTMLInputElement | null
  const readingLevelSelect = document.getElementById('chat-settings-reading-level') as HTMLSelectElement | null
  if (urlInput) urlInput.value = config.apiUrl
  if (keyInput) keyInput.value = config.apiKey
  if (readingLevelSelect) readingLevelSelect.value = config.readingLevel
  if (enabledInput) enabledInput.checked = config.enabled
  if (visionInput) visionInput.checked = config.visionEnabled
  if (debugInput) debugInput.checked = config.debugPrompt ?? false
  // Seed the select with the saved model immediately, then refresh from API
  seedModelSelect(config.model)
  void refreshModelSelect(config.apiUrl, config.model)
}

/** Put the saved model as the sole option while models are loading. */
function seedModelSelect(currentModel: string): void {
  const select = document.getElementById('chat-settings-model') as HTMLSelectElement | null
  if (!select) return
  select.innerHTML = ''
  if (currentModel) {
    const opt = document.createElement('option')
    opt.value = currentModel
    opt.textContent = currentModel
    select.appendChild(opt)
  }
  select.disabled = true
}

/** Fetch models from the API and populate the select, preserving the current selection. */
async function refreshModelSelect(apiUrl: string, preferredModel?: string): Promise<void> {
  const select = document.getElementById('chat-settings-model') as HTMLSelectElement | null
  if (!select) return

  const config = loadConfig()
  const selected = preferredModel ?? select.value ?? config.model

  const models = await fetchModels({ ...config, apiUrl })

  select.innerHTML = ''
  if (models.length === 0) {
    // Fallback: keep the current value as a manual entry
    const opt = document.createElement('option')
    opt.value = selected
    opt.textContent = selected || 'No models found'
    select.appendChild(opt)
    select.disabled = false
    return
  }

  // Ensure the currently configured model is always present, even if not in the list
  const allModels = models.includes(selected) || !selected ? models : [selected, ...models]
  for (const id of allModels) {
    const opt = document.createElement('option')
    opt.value = id
    opt.textContent = id
    opt.selected = id === selected
    select.appendChild(opt)
  }
  select.disabled = false
}

function readSettingsForm(): DocentConfig {
  const defaults = getDefaultConfig()
  const urlInput = document.getElementById('chat-settings-url') as HTMLInputElement | null
  const keyInput = document.getElementById('chat-settings-key') as HTMLInputElement | null
  const modelSelect = document.getElementById('chat-settings-model') as HTMLSelectElement | null
  const readingLevelSelect = document.getElementById('chat-settings-reading-level') as HTMLSelectElement | null
  const enabledInput = document.getElementById('chat-settings-enabled') as HTMLInputElement | null
  const visionInput = document.getElementById('chat-settings-vision') as HTMLInputElement | null
  const debugInput = document.getElementById('chat-settings-debug') as HTMLInputElement | null
  return {
    apiUrl: urlInput?.value.trim() || defaults.apiUrl,
    apiKey: keyInput?.value.trim() ?? '',
    model: modelSelect?.value.trim() || defaults.model,
    readingLevel: isValidReadingLevel(readingLevelSelect?.value) ? readingLevelSelect!.value as ReadingLevel : defaults.readingLevel,
    enabled: enabledInput?.checked ?? defaults.enabled,
    visionEnabled: visionInput?.checked ?? defaults.visionEnabled,
    debugPrompt: debugInput?.checked ?? defaults.debugPrompt,
  }
}

function handleSettingsSave(): void {
  const config = readSettingsForm()
  saveConfig(config)
  // Keep vision toggle button + hint banner in sync with settings checkbox
  setVisionUI(config.visionEnabled)
  const status = document.getElementById('chat-settings-status')
  if (status) {
    status.textContent = 'Saved'
    status.className = 'chat-settings-status chat-settings-status-ok'
    setTimeout(() => { status.textContent = '' }, 2000)
  }
  callbacks?.announce('Settings saved')
}

async function handleSettingsTest(): Promise<void> {
  const config = readSettingsForm()
  const status = document.getElementById('chat-settings-status')
  const testBtn = document.getElementById('chat-settings-test') as HTMLButtonElement | null
  if (status) {
    status.textContent = 'Testing…'
    status.className = 'chat-settings-status'
  }
  if (testBtn) testBtn.disabled = true

  const result = await testConnection(config)

  if (status) {
    if (result.ok) {
      status.textContent = 'Connected'
      status.className = 'chat-settings-status chat-settings-status-ok'
    } else {
      status.textContent = result.reason ?? 'Failed to connect'
      status.className = 'chat-settings-status chat-settings-status-err'
    }
    setTimeout(() => { status.textContent = '' }, 5000)
  }
  if (testBtn) testBtn.disabled = false
  callbacks?.announce(result.ok ? 'LLM connection successful' : 'LLM connection failed')
}

// --- Send / receive ---

async function handleSend(): Promise<void> {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  if (!input || !callbacks || isStreaming) return

  const text = input.value.trim()
  if (!text) return

  // Add user message
  const userMsg: ChatMessage = {
    id: createMessageId(),
    role: 'user',
    text,
    timestamp: Date.now(),
  }
  messages.push(userMsg)
  input.value = ''
  input.style.height = 'auto'
  renderMessages()
  scrollToBottom()
  saveSession()

  // Create a placeholder docent message for streaming
  const docentMsg: ChatMessage = {
    id: createMessageId(),
    role: 'docent',
    text: '',
    actions: [],
    timestamp: Date.now(),
  }
  messages.push(docentMsg)
  // Cap in-memory messages to prevent unbounded growth in long sessions
  if (messages.length > MAX_MESSAGES) {
    messages = messages.slice(-MAX_MESSAGES)
  }
  isStreaming = true
  showTyping()
  setSendEnabled(false)

  try {
    // Capture globe screenshot + overlay context only when vision mode and LLM are both active
    const config = loadConfig()
    const shouldCaptureVision = config.visionEnabled && config.enabled && !!config.apiUrl
    const screenshot = shouldCaptureVision ? captureGlobeScreenshot() : null
    const viewContext = shouldCaptureVision ? captureViewContext() : undefined

    // Capture map geographic context for the LLM system prompt (skip in local-only mode)
    const mapViewContext = config.enabled && config.apiUrl
      ? callbacks.getMapViewContext?.() ?? undefined
      : undefined

    const stream = processMessage(
      text,
      messages.slice(0, -2), // history without user msg or placeholder (processMessage re-adds user msg)
      callbacks.getDatasets(),
      callbacks.getCurrentDataset(),
      config,
      screenshot,
      viewContext,
      mapViewContext,
    )

    let firstChunk = true
    pendingGlobeActions = [] // Clear any stale pending actions
    for await (const chunk of stream) {
      if (firstChunk && chunk.type !== 'done') {
        hideTyping()
        firstChunk = false
      }
      switch (chunk.type) {
        case 'delta':
          docentMsg.text += chunk.text
          updateStreamingMessage(docentMsg)
          scrollToBottom()
          break

        case 'action':
          if (!docentMsg.actions) docentMsg.actions = []
          docentMsg.actions.push(chunk.action)
          // Globe-control actions are always deferred during streaming;
          // flushed at 'done' (immediate) or after dataset loads (deferred)
          if (chunk.action.type !== 'load-dataset') {
            pendingGlobeActions.push(chunk.action)
          }
          updateStreamingMessage(docentMsg)
          scrollToBottom()
          break

        case 'auto-load': {
          // Auto-load the top result immediately
          const autoAction = chunk.action
          if (autoAction.type === 'load-dataset') {
            callbacks.onLoadDataset(autoAction.datasetId)
            if (!docentMsg.text) {
              const altHint = chunk.alternatives.length > 0 ? ' Here are some alternatives if this isn\'t quite right:' : ''
              docentMsg.text = `I've loaded **${autoAction.datasetTitle}** — that's your closest match.${altHint}`
            }
          }
          if (!docentMsg.actions) docentMsg.actions = []
          for (const alt of chunk.alternatives) {
            docentMsg.actions.push(alt)
          }
          updateStreamingMessage(docentMsg)
          scrollToBottom()
          break
        }

        case 'rewrite':
          // Replace message text with validated version (invalid dataset IDs stripped)
          docentMsg.text = chunk.text
          updateStreamingMessage(docentMsg)
          break

        case 'done': {
          // Attach LLM context for RLHF feedback extraction (non-enumerable
          // so it won't be serialized to sessionStorage by saveSession)
          Object.defineProperty(docentMsg, 'llmContext', {
            value: chunk.llmContext ?? { systemPrompt: '', model: '', readingLevel: 'general', visionEnabled: false, fallback: true, historyCompressed: false },
            writable: true,
            configurable: true,
            enumerable: false,
          })
          // Replace <<LOAD:...>> markers with inline placeholders so buttons
          // render at the original location in the text, not grouped at the bottom.
          if (docentMsg.text) {
            docentMsg.text = docentMsg.text.replace(
              /<?<LOAD:([^>]+)>>?\n?/g,
              (_, id) => `[[LOAD:${id.trim()}]]`,
            ).trim()
            updateStreamingMessage(docentMsg)
          }
          if (chunk.fallback && docentMsg.text) {
            const hint = isLocalDev
              ? '⚠ AI service unavailable — running in offline mode. Make sure `npm run dev` is proxying /api, or configure a local provider in settings.'
              : '⚠ AI service unavailable — showing offline results. Check LLM settings.'
            docentMsg.text += `\n\n*${hint}*`
            updateStreamingMessage(docentMsg)
          }
          // Flush globe-control actions immediately if:
          // - no load-dataset action in this message, OR
          // - the only load-dataset actions reference the already-loaded dataset
          const loadActions = docentMsg.actions?.filter(a => a.type === 'load-dataset') ?? []
          const currentDataset = callbacks?.getCurrentDataset()
          const allAlreadyLoaded = loadActions.length > 0
            && loadActions.every(a => a.type === 'load-dataset' && a.datasetId === currentDataset?.id)
          if (loadActions.length === 0 || allAlreadyLoaded) {
            flushPendingGlobeActions()
          }
          break
        }
      }
    }
  } catch {
    if (!docentMsg.text) {
      docentMsg.text = "Sorry, I had trouble responding. Try asking again, or check the LLM settings."
    }
  }

  hideTyping()
  isStreaming = false
  setSendEnabled(true)

  // Clean up empty actions array
  if (docentMsg.actions?.length === 0) delete docentMsg.actions

  // Re-render fully to wire action button events
  renderMessages()
  scrollToBottom()
  saveSession()
  callbacks.announce('Docent responded')
}

function setSendEnabled(enabled: boolean): void {
  const btn = document.getElementById('chat-send') as HTMLButtonElement | null
  if (btn) btn.disabled = !enabled
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  if (input) input.disabled = !enabled
}

// --- Rendering ---

/** Render all messages into the chat container, or show the welcome screen if empty. */
function renderMessages(): void {
  const container = document.getElementById('chat-messages')
  if (!container) return

  if (messages.length === 0) {
    container.innerHTML = `<div class="chat-welcome">
      <div class="chat-welcome-icon" aria-hidden="true">&#x1F30D;</div>
      <p><strong>I'm Orbit</strong>, your digital docent — I help you find the right dataset for your question.</p>
      <p class="chat-welcome-hint">Browse the catalog to compare options side by side. Ask me when you have something specific in mind.</p>
      <div class="chat-suggestions">
        <button class="chat-suggestion" data-query="What datasets show sea level rise?">Sea level rise</button>
        <button class="chat-suggestion" data-query="Explain what NDVI measures">What is NDVI?</button>
        <button class="chat-suggestion" data-query="Show me something related to hurricanes">Hurricanes</button>
        <button class="chat-suggestion" data-query="Which datasets cover the Arctic?">Arctic</button>
      </div>
    </div>`
    container.querySelectorAll<HTMLElement>('.chat-suggestion').forEach(btn => {
      btn.addEventListener('click', () => {
        const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
        if (input && btn.dataset.query) {
          input.value = btn.dataset.query
          handleSend()
        }
      })
    })
    return
  }

  container.innerHTML = messages.map(msg => renderMessage(msg)).join('')
  wireActionButtons(container)
  wireFeedbackButtons(container)
}

/** Render a single chat message as an HTML string with inline action buttons. */
function renderMessage(msg: ChatMessage): string {
  const roleClass = msg.role === 'user' ? 'chat-msg-user' : 'chat-msg-docent'
  const { html: textHtml, inlinedIds } = renderChatText(msg.text ?? '', msg.actions)
  const remaining = msg.actions?.filter(a => a.type !== 'load-dataset' || !inlinedIds.has(a.datasetId))
  const actionsHtml = remaining?.length ? renderActions(remaining) : ''
  const feedbackHtml = msg.role === 'docent' && msg.text
    ? `<div class="chat-feedback">
         <button class="chat-feedback-btn" data-feedback="thumbs-up" data-msg-id="${escapeAttr(msg.id)}" aria-label="Good response" title="Good response">&#x1F44D;&#xFE0E;</button>
         <button class="chat-feedback-btn" data-feedback="thumbs-down" data-msg-id="${escapeAttr(msg.id)}" aria-label="Bad response" title="Bad response">&#x1F44E;&#xFE0E;</button>
       </div>`
    : ''
  return `<div class="chat-msg ${roleClass}" data-msg-id="${escapeAttr(msg.id)}">
    <div class="chat-msg-text">${textHtml}</div>
    ${feedbackHtml}
    ${actionsHtml}
  </div>`
}

/**
 * Update only the currently streaming message (avoids full re-render flicker).
 */
function updateStreamingMessage(msg: ChatMessage): void {
  const container = document.getElementById('chat-messages')
  if (!container) return

  const selector = `[data-msg-id="${CSS.escape(msg.id)}"]`
  let el = container.querySelector(selector)
  if (!el) {
    // Append it
    container.insertAdjacentHTML('beforeend', renderMessage(msg))
    el = container.querySelector(selector)
  } else {
    const { html, inlinedIds } = renderChatText(msg.text ?? '', msg.actions)
    const textEl = el.querySelector('.chat-msg-text')
    if (textEl) {
      textEl.innerHTML = html
    }
    // Update remaining (non-inlined) actions at the bottom
    const remaining = msg.actions?.filter(a => a.type !== 'load-dataset' || !inlinedIds.has(a.datasetId))
    const existingActions = el.querySelector('.chat-actions')
    if (remaining?.length) {
      const actionsHtml = renderActions(remaining)
      if (existingActions) {
        existingActions.outerHTML = actionsHtml
      } else {
        el.insertAdjacentHTML('beforeend', actionsHtml)
      }
    } else if (existingActions) {
      existingActions.remove()
    }
    wireActionButtons(el)
  }
}

/**
 * Render message text, converting [[LOAD:ID]] placeholders to inline action
 * buttons and stripping raw <<LOAD:...>> markers (visible during streaming).
 */
function renderChatText(
  text: string,
  actions?: ChatAction[],
): { html: string; inlinedIds: Set<string> } {
  // Strip raw markers that appear during streaming (all action types)
  let clean = text.replace(/<?<LOAD:[^>]+>>?\n?/g, '')
  clean = clean.replace(/<?<FLY:[^>]+>>?\n?/g, '')
  clean = clean.replace(/<?<TIME:[^>]+>>?\n?/g, '')
  clean = clean.replace(/<?<BOUNDS:[^>]+>>?\n?/g, '')
  clean = clean.replace(/<?<MARKER:[^>]+>>?\n?/g, '')
  clean = clean.replace(/<?<LABELS:[^>]+>>?\n?/g, '')
  clean = clean.replace(/<?<REGION:[^>]+>>?\n?/g, '')
  // Strip bare fly_to/set_time text patterns (LLM fallback)
  clean = clean.replace(/^.*\bfly_to\s*[:(\s]\s*[-\d.,\s]+\)?\s*$/gim, '')
  clean = clean.replace(/^.*\bset_time\s*[:(\s]\s*"?[^")\n]*"?\s*\)?\s*$/gim, '')
  clean = clean.replace(/\n{3,}/g, '\n\n')
  let html = renderMarkdownLite(escapeHtml(clean))

  // Replace [[LOAD:ID]] placeholders (set by 'done') with inline action buttons
  const inlinedIds = new Set<string>()
  const currentDatasetId = callbacks?.getCurrentDataset()?.id
  html = html.replace(/\[\[LOAD:([^\]]+)\]\]/g, (_, id) => {
    const action = actions?.find(a => a.type === 'load-dataset' && a.datasetId === id)
    if (!action || action.type !== 'load-dataset') return ''
    inlinedIds.add(id)
    // Show non-interactive "Loaded" badge if this dataset is already on the globe
    if (action.datasetId === currentDatasetId) {
      return `<span class="chat-action-btn chat-action-inline chat-action-loaded"><span class="chat-action-title">${escapeHtml(action.datasetTitle)}</span> <span class="chat-action-load">Loaded &#x2714;</span></span>`
    }
    return `<button class="chat-action-btn chat-action-inline" data-dataset-id="${escapeAttr(action.datasetId)}" aria-label="Load ${escapeAttr(action.datasetTitle)}"><span class="chat-action-title">${escapeHtml(action.datasetTitle)}</span> <span class="chat-action-load">Load &#x27A4;</span></button>`
  })

  return { html, inlinedIds }
}

/** Render a group of dataset action buttons as an HTML string. */
function renderActions(actions: ChatAction[]): string {
  const currentDatasetId = callbacks?.getCurrentDataset()?.id
  const items = actions.map(a => {
    if (a.type === 'load-dataset') {
      // Show non-interactive "Loaded" badge if this dataset is already on the globe
      if (a.datasetId === currentDatasetId) {
        return `<span class="chat-action-btn chat-action-loaded"><span class="chat-action-title">${escapeHtml(a.datasetTitle)}</span> <span class="chat-action-load">Loaded &#x2714;</span></span>`
      }
      return `<button class="chat-action-btn" data-dataset-id="${escapeAttr(a.datasetId)}" aria-label="Load ${escapeAttr(a.datasetTitle)}">
        <span class="chat-action-title">${escapeHtml(a.datasetTitle)}</span>
        <span class="chat-action-load">Load &#x27A4;</span>
      </button>`
    }
    if (a.type === 'fly-to') {
      const latLabel = Math.abs(a.lat).toFixed(1) + '\u00B0' + (a.lat >= 0 ? 'N' : 'S')
      const lonLabel = Math.abs(a.lon).toFixed(1) + '\u00B0' + (a.lon >= 0 ? 'E' : 'W')
      return `<span class="chat-action-status" aria-label="Flying to ${latLabel}, ${lonLabel}">Flying to ${escapeHtml(latLabel)}, ${escapeHtml(lonLabel)}</span>`
    }
    if (a.type === 'set-time') {
      return `<span class="chat-action-status" aria-label="Seeking to ${escapeAttr(a.isoDate)}">Seeking to ${escapeHtml(a.isoDate)}</span>`
    }
    if (a.type === 'fit-bounds') {
      const label = a.label ?? 'region'
      return `<span class="chat-action-status" aria-label="Navigating to ${escapeAttr(label)}">Navigating to ${escapeHtml(label)}</span>`
    }
    if (a.type === 'add-marker') {
      const label = a.label ?? `${a.lat.toFixed(1)}, ${a.lng.toFixed(1)}`
      return `<span class="chat-action-status" aria-label="Marker: ${escapeAttr(label)}">Marker: ${escapeHtml(label)}</span>`
    }
    if (a.type === 'toggle-labels') {
      return `<span class="chat-action-status" aria-label="${a.visible ? 'Labels shown' : 'Labels hidden'}">${a.visible ? 'Labels shown' : 'Labels hidden'}</span>`
    }
    if (a.type === 'highlight-region') {
      const label = a.label ?? 'region'
      return `<span class="chat-action-status" aria-label="Highlighted ${escapeAttr(label)}">Highlighted ${escapeHtml(label)}</span>`
    }
    return ''
  }).join('')
  const loadActions = actions.filter(a => a.type === 'load-dataset')
  const browseFooter = loadActions.length >= 3 && callbacks?.onOpenBrowse
    ? `<button class="chat-browse-link">Compare these side by side in Browse &#x2192;</button>`
    : ''
  return `<div class="chat-actions">${items}${browseFooter}</div>`
}

/** Attach click handlers to action buttons within a rendered message container. */
function wireActionButtons(container: Element): void {
  container.querySelectorAll<HTMLElement>('.chat-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.datasetId
      if (id && callbacks) {
        callbacks.onLoadDataset(id)
        callbacks.announce('Loading dataset')

        // Track the click for implicit feedback
        const msgEl = btn.closest('.chat-msg')
        const msgId = msgEl?.getAttribute('data-msg-id')
        if (msgId) {
          const clicks = actionClickMap.get(msgId) ?? []
          clicks.push(id)
          actionClickMap.set(msgId, clicks)
        }

        // Remove action cards from this message after loading
        if (msgId) {
          const msg = messages.find(m => m.id === msgId)
          if (msg) delete msg.actions
        }
        const actionsEl = btn.closest('.chat-actions')
        actionsEl?.remove()
        saveSession()
      }
    })
  })
  container.querySelectorAll<HTMLElement>('.chat-browse-link').forEach(btn => {
    btn.addEventListener('click', () => {
      closeChat()
      callbacks?.onOpenBrowse?.()
    })
  })
}

/**
 * Minimal markdown: **bold**, bullet lists, and newlines.
 */
function renderMarkdownLite(html: string): string {
  const lines = html.split('\n')
  const out: string[] = []
  let inList = false

  for (const rawLine of lines) {
    const line = rawLine.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    const bulletMatch = line.match(/^• (.+)$/)

    if (bulletMatch) {
      if (!inList) { inList = true; out.push('<ul>') }
      out.push(`<li>${bulletMatch[1]}</li>`)
    } else {
      if (inList) { inList = false; out.push('</ul>') }
      out.push(line === '' ? '<br>' : line + '<br>')
    }
  }
  if (inList) out.push('</ul>')
  return out.join('')
}

// --- Trigger / info-panel coordination ---

/** Adjust the chat trigger button position to sit above the info panel when expanded. */
function updateTriggerForInfoPanel(): void {
  const trigger = document.getElementById('chat-trigger')
  const infoPanel = document.getElementById('info-panel')
  if (!trigger || !infoPanel) return
  if (infoPanel.classList.contains('expanded')) {
    const h = infoPanel.getBoundingClientRect().height
    trigger.style.bottom = `${h + 12}px`
  } else {
    trigger.style.bottom = ''
  }
}

// --- Contextual dataset prompt ---

/** Show a contextual prompt nudging the user to ask about the loaded dataset. */
function showDatasetPrompt(dataset: Dataset): void {
  dismissDatasetPrompt()
  const el = document.getElementById('chat-dataset-prompt')
  if (!el) return
  el.textContent = `Ask the Docent about ${dataset.title} \u2192`
  el.classList.remove('hidden')
  el.onclick = () => {
    dismissDatasetPrompt()
    openChat()
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
    if (input) {
      input.value = `Tell me about ${dataset.title}`
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 96) + 'px'
    }
  }
  datasetPromptTimer = setTimeout(() => dismissDatasetPrompt(), 8000)
}

/** Dismiss the dataset prompt banner and clear its auto-hide timer. */
function dismissDatasetPrompt(): void {
  if (datasetPromptTimer !== null) {
    clearTimeout(datasetPromptTimer)
    datasetPromptTimer = null
  }
  const el = document.getElementById('chat-dataset-prompt')
  if (el) el.classList.add('hidden')
}

/** Show the typing indicator in the chat panel. */
function showTyping(): void {
  const el = document.getElementById('chat-typing')
  if (el) el.classList.remove('hidden')
}

/** Hide the typing indicator. */
function hideTyping(): void {
  const el = document.getElementById('chat-typing')
  if (el) el.classList.add('hidden')
}

/** Scroll the chat message container to the bottom. */
function scrollToBottom(): void {
  const container = document.getElementById('chat-messages')
  if (container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })
  }
}

// --- Feedback ---

const FEEDBACK_TAGS_NEGATIVE = [
  'Wrong dataset',
  'Inaccurate info',
  'Too long',
  'Off topic',
  'Didn\'t understand my question',
]

const FEEDBACK_TAGS_POSITIVE = [
  'Great recommendation',
  'Clear explanation',
  'Learned something new',
  'Good level of detail',
  'Helped me explore',
]

/** Check if viewport is narrow (mobile). */
function isMobileViewport(): boolean {
  return window.matchMedia('(max-width: 768px)').matches
}

/** Attach click handlers to feedback buttons within a rendered message container. */
function wireFeedbackButtons(container: Element): void {
  container.querySelectorAll<HTMLElement>('.chat-feedback-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const rating = btn.dataset.feedback as FeedbackRating | undefined
      const msgId = btn.dataset.msgId
      const feedbackRow = btn.closest<HTMLElement>('.chat-feedback')
      if (!rating || !msgId || !feedbackRow || feedbackRow.dataset.feedbackSubmitted === 'true') return

      feedbackRow.dataset.feedbackSubmitted = 'true'

      // Disable all buttons to prevent duplicate submissions
      feedbackRow.querySelectorAll<HTMLButtonElement>('.chat-feedback-btn').forEach(b => {
        b.disabled = true
        b.classList.add('chat-feedback-disabled')
      })
      // Highlight the selected one (stays disabled)
      btn.classList.add('chat-feedback-rated')
      btn.classList.remove('chat-feedback-disabled')
      btn.setAttribute('aria-pressed', 'true')

      submitInlineRating(msgId, rating, btn as HTMLButtonElement)
    })
  })
}

/** Build the base feedback payload for a given message. */
function buildFeedbackPayload(messageId: string, rating: FeedbackRating): FeedbackPayload {
  const ratedMessage = messages.find(m => m.id === messageId)
  const ctx = ratedMessage?.llmContext

  const msgIndex = messages.findIndex(m => m.id === messageId)
  const precedingUserMsg = msgIndex > 0 ? messages[msgIndex - 1] : null
  const userMessage = precedingUserMsg?.role === 'user' ? precedingUserMsg.text : undefined

  const docentMessages = messages.filter(m => m.role === 'docent')
  const turnIndex = docentMessages.findIndex(m => m.id === messageId)

  return {
    rating,
    comment: '',
    messageId,
    messages: messages.map(m => ({ id: m.id, role: m.role, text: m.text, timestamp: m.timestamp })),
    datasetId: callbacks?.getCurrentDataset()?.id ?? null,
    timestamp: Date.now(),
    systemPrompt: ctx?.systemPrompt,
    modelConfig: ctx ? {
      model: ctx.model,
      readingLevel: ctx.readingLevel,
      visionEnabled: ctx.visionEnabled,
    } : undefined,
    isFallback: ctx ? ctx.fallback : undefined,
    userMessage,
    turnIndex: turnIndex >= 0 ? turnIndex : undefined,
    historyCompressed: ctx?.historyCompressed,
    actionClicks: actionClickMap.get(messageId),
  }
}

/** Submit a single-click inline rating to the server, then show expansion. */
async function submitInlineRating(messageId: string, rating: FeedbackRating, btn: HTMLButtonElement): Promise<void> {
  const payload = buildFeedbackPayload(messageId, rating)

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
    }
    btn.classList.add('chat-feedback-success')
    callbacks?.announce('Feedback submitted')
    // Show optional expansion for richer feedback
    showFeedbackExpansion(messageId, rating, btn)
  } catch {
    // Re-enable buttons on failure so user can retry
    const feedbackRow = btn.closest<HTMLElement>('.chat-feedback')
    if (feedbackRow) delete feedbackRow.dataset.feedbackSubmitted
    feedbackRow?.querySelectorAll<HTMLButtonElement>('.chat-feedback-btn').forEach(b => {
      b.disabled = false
      b.classList.remove('chat-feedback-disabled', 'chat-feedback-rated')
      b.removeAttribute('aria-pressed')
    })
  }
}

/** Show the inline "tell us more" expansion (or bottom sheet on mobile). */
function showFeedbackExpansion(messageId: string, rating: FeedbackRating, btn: HTMLElement): void {
  // Remove any existing expansion
  dismissFeedbackExpansion()

  const isPositive = rating === 'thumbs-up'
  const placeholder = isPositive ? 'What was helpful? (optional)' : 'What could be improved? (optional)'
  const tags = isPositive ? FEEDBACK_TAGS_POSITIVE : FEEDBACK_TAGS_NEGATIVE

  const tagsHtml = tags.map(tag =>
    `<button class="chat-feedback-tag" aria-pressed="false" data-tag="${escapeAttr(tag)}">${escapeHtml(tag)}</button>`,
  ).join('')

  const expansionHtml = `
    <div class="chat-feedback-tags">${tagsHtml}</div>
    <textarea class="chat-feedback-comment" placeholder="${escapeAttr(placeholder)}" rows="2"></textarea>
    <div class="chat-feedback-expand-actions">
      <button class="chat-feedback-send">Send</button>
      <button class="chat-feedback-dismiss" aria-label="Dismiss">Dismiss</button>
    </div>
  `

  const useMobile = isMobileViewport()

  if (useMobile) {
    // Bottom sheet anchored to chat panel
    const panel = document.getElementById('chat-panel')
    if (!panel) return
    const sheet = document.createElement('div')
    sheet.className = 'chat-feedback-sheet'
    sheet.id = 'chat-feedback-expansion'
    sheet.setAttribute('role', 'region')
    sheet.setAttribute('aria-label', 'Additional feedback')
    sheet.dataset.messageId = messageId
    sheet.dataset.rating = rating
    sheet.innerHTML = `<div class="chat-feedback-sheet-handle" aria-hidden="true"></div>${expansionHtml}`
    panel.appendChild(sheet)
    // Trigger slide-up animation
    requestAnimationFrame(() => sheet.classList.add('chat-feedback-sheet-open'))
  } else {
    // Inline expansion below the message
    const msgEl = btn.closest('.chat-msg')
    if (!msgEl) return
    const expand = document.createElement('div')
    expand.className = 'chat-feedback-expand'
    expand.id = 'chat-feedback-expansion'
    expand.setAttribute('role', 'region')
    expand.setAttribute('aria-label', 'Additional feedback')
    expand.dataset.messageId = messageId
    expand.dataset.rating = rating
    expand.innerHTML = expansionHtml
    msgEl.after(expand)
  }

  // Wire events
  const expansion = document.getElementById('chat-feedback-expansion')!
  wireExpansionEvents(expansion, messageId, rating)

  // Focus the first tag for keyboard users
  const firstTag = expansion.querySelector<HTMLElement>('.chat-feedback-tag')
  firstTag?.focus()
}

/** Wire up tag toggles, send, dismiss, and keyboard events on the expansion. */
function wireExpansionEvents(expansion: HTMLElement, messageId: string, rating: FeedbackRating): void {
  // Tag toggles
  expansion.querySelectorAll<HTMLElement>('.chat-feedback-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      const pressed = tag.getAttribute('aria-pressed') === 'true'
      tag.setAttribute('aria-pressed', String(!pressed))
      tag.classList.toggle('chat-feedback-tag-selected', !pressed)
    })
  })

  // Send button
  expansion.querySelector('.chat-feedback-send')?.addEventListener('click', () => {
    submitFeedbackUpdate(expansion, messageId, rating)
  })

  // Dismiss button
  expansion.querySelector('.chat-feedback-dismiss')?.addEventListener('click', () => {
    dismissFeedbackExpansion()
  })

  // Escape key
  expansion.addEventListener('keydown', (e: Event) => {
    if ((e as KeyboardEvent).key === 'Escape') {
      dismissFeedbackExpansion()
    }
  })
}

/** Collect tags and comment from expansion, submit update to server. */
async function submitFeedbackUpdate(expansion: HTMLElement, messageId: string, rating: FeedbackRating): Promise<void> {
  const tags: string[] = []
  expansion.querySelectorAll<HTMLElement>('.chat-feedback-tag[aria-pressed="true"]').forEach(tag => {
    if (tag.dataset.tag) tags.push(tag.dataset.tag)
  })
  const comment = (expansion.querySelector('.chat-feedback-comment') as HTMLTextAreaElement | null)?.value.trim() ?? ''

  if (!tags.length && !comment) {
    dismissFeedbackExpansion()
    return
  }

  const sendBtn = expansion.querySelector('.chat-feedback-send') as HTMLButtonElement | null
  if (sendBtn) sendBtn.disabled = true

  const payload = buildFeedbackPayload(messageId, rating)
  payload.comment = comment
  payload.tags = tags

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Unknown error' }))
      throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`)
    }
    callbacks?.announce('Additional feedback submitted')
    dismissFeedbackExpansion()
  } catch {
    if (sendBtn) sendBtn.disabled = false
  }
}

/** Remove the feedback expansion or bottom sheet. */
function dismissFeedbackExpansion(): void {
  const el = document.getElementById('chat-feedback-expansion')
  if (!el) return
  if (el.classList.contains('chat-feedback-sheet')) {
    el.classList.remove('chat-feedback-sheet-open')
    el.addEventListener('transitionend', () => el.remove(), { once: true })
    // Fallback removal if transition doesn't fire
    setTimeout(() => el.remove(), 350)
  } else {
    el.remove()
  }
}

/**
 * Submit feedback programmatically (for testing).
 */
export function submitFeedback(messageId: string, rating: FeedbackRating): void {
  const btn = document.querySelector(`[data-feedback="${rating}"][data-msg-id="${messageId}"]`) as HTMLElement | null
  btn?.click()
}
