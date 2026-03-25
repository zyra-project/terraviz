/**
 * Chat UI — digital docent chat panel.
 *
 * Floating panel in the bottom-left with a trigger button.
 * Streams LLM responses token-by-token, falls back to local engine.
 * Persists conversation in sessionStorage, config in localStorage.
 */

import type { ChatMessage, ChatAction, ChatSession, DocentConfig } from '../types'
import type { Dataset } from '../types'
import { escapeHtml, escapeAttr } from './browseUI'
import { createMessageId } from '../services/docentEngine'
import { processMessage, loadConfig, saveConfig, testConnection, getDefaultConfig, isLocalDev } from '../services/docentService'

// --- Constants ---
const SESSION_STORAGE_KEY = 'sos-docent-chat'
const CHAT_OPENED_KEY = 'sos-docent-seen'
const MAX_MESSAGES = 200
const MAX_PERSISTED_MESSAGES = 100

export interface ChatCallbacks {
  onLoadDataset: (id: string) => void
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
  saveSession()
  renderMessages()
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

  // Settings form
  document.getElementById('chat-settings-save')?.addEventListener('click', handleSettingsSave)
  document.getElementById('chat-settings-test')?.addEventListener('click', handleSettingsTest)
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
  const modelInput = document.getElementById('chat-settings-model') as HTMLInputElement | null
  const enabledInput = document.getElementById('chat-settings-enabled') as HTMLInputElement | null
  if (urlInput) urlInput.value = config.apiUrl
  if (keyInput) keyInput.value = config.apiKey
  if (modelInput) modelInput.value = config.model
  if (enabledInput) enabledInput.checked = config.enabled
}

function readSettingsForm(): DocentConfig {
  const defaults = getDefaultConfig()
  const urlInput = document.getElementById('chat-settings-url') as HTMLInputElement | null
  const keyInput = document.getElementById('chat-settings-key') as HTMLInputElement | null
  const modelInput = document.getElementById('chat-settings-model') as HTMLInputElement | null
  const enabledInput = document.getElementById('chat-settings-enabled') as HTMLInputElement | null
  return {
    apiUrl: urlInput?.value.trim() || defaults.apiUrl,
    apiKey: keyInput?.value.trim() ?? '',
    model: modelInput?.value.trim() || defaults.model,
    enabled: enabledInput?.checked ?? defaults.enabled,
  }
}

function handleSettingsSave(): void {
  const config = readSettingsForm()
  saveConfig(config)
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
    const stream = processMessage(
      text,
      messages.slice(0, -2), // history without user msg or placeholder (processMessage re-adds user msg)
      callbacks.getDatasets(),
      callbacks.getCurrentDataset(),
    )

    let firstChunk = true
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
          updateStreamingMessage(docentMsg)
          scrollToBottom()
          break

        case 'auto-load': {
          // Auto-load the top result immediately
          callbacks.onLoadDataset(chunk.action.datasetId)
          if (!docentMsg.text) {
            const altHint = chunk.alternatives.length > 0 ? ' Here are some alternatives if this isn\'t quite right:' : ''
            docentMsg.text = `I've loaded **${chunk.action.datasetTitle}** — that's your closest match.${altHint}`
          }
          if (!docentMsg.actions) docentMsg.actions = []
          for (const alt of chunk.alternatives) {
            docentMsg.actions.push(alt)
          }
          updateStreamingMessage(docentMsg)
          scrollToBottom()
          break
        }

        case 'done':
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
          break
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
}

function renderMessage(msg: ChatMessage): string {
  const roleClass = msg.role === 'user' ? 'chat-msg-user' : 'chat-msg-docent'
  const { html: textHtml, inlinedIds } = renderChatText(msg.text ?? '', msg.actions)
  const remaining = msg.actions?.filter(a => !inlinedIds.has(a.datasetId))
  const actionsHtml = remaining?.length ? renderActions(remaining) : ''
  return `<div class="chat-msg ${roleClass}" data-msg-id="${escapeAttr(msg.id)}">
    <div class="chat-msg-text">${textHtml}</div>
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
    const remaining = msg.actions?.filter(a => !inlinedIds.has(a.datasetId))
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
  // Strip raw <<LOAD:...>> markers that appear during streaming (before 'done')
  const clean = text.replace(/<?<LOAD:[^>]+>>?\n?/g, '')
  let html = renderMarkdownLite(escapeHtml(clean))

  // Replace [[LOAD:ID]] placeholders (set by 'done') with inline action buttons
  const inlinedIds = new Set<string>()
  html = html.replace(/\[\[LOAD:([^\]]+)\]\]/g, (_, id) => {
    const action = actions?.find(a => a.datasetId === id)
    if (!action) return ''
    inlinedIds.add(id)
    return `<button class="chat-action-btn chat-action-inline" data-dataset-id="${escapeAttr(action.datasetId)}" aria-label="Load ${escapeAttr(action.datasetTitle)}"><span class="chat-action-title">${escapeHtml(action.datasetTitle)}</span> <span class="chat-action-load">Load &#x27A4;</span></button>`
  })

  return { html, inlinedIds }
}

function renderActions(actions: ChatAction[]): string {
  const buttons = actions.map(a => {
    if (a.type === 'load-dataset') {
      return `<button class="chat-action-btn" data-dataset-id="${escapeAttr(a.datasetId)}" aria-label="Load ${escapeAttr(a.datasetTitle)}">
        <span class="chat-action-title">${escapeHtml(a.datasetTitle)}</span>
        <span class="chat-action-load">Load &#x27A4;</span>
      </button>`
    }
    return ''
  }).join('')
  const browseFooter = actions.length >= 3 && callbacks?.onOpenBrowse
    ? `<button class="chat-browse-link">Compare these side by side in Browse &#x2192;</button>`
    : ''
  return `<div class="chat-actions">${buttons}${browseFooter}</div>`
}

function wireActionButtons(container: Element): void {
  container.querySelectorAll<HTMLElement>('.chat-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.datasetId
      if (id && callbacks) {
        callbacks.onLoadDataset(id)
        callbacks.announce('Loading dataset')

        // Remove action cards from this message after loading
        const msgEl = btn.closest('.chat-msg')
        const msgId = msgEl?.getAttribute('data-msg-id')
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

function dismissDatasetPrompt(): void {
  if (datasetPromptTimer !== null) {
    clearTimeout(datasetPromptTimer)
    datasetPromptTimer = null
  }
  const el = document.getElementById('chat-dataset-prompt')
  if (el) el.classList.add('hidden')
}

function showTyping(): void {
  const el = document.getElementById('chat-typing')
  if (el) el.classList.remove('hidden')
}

function hideTyping(): void {
  const el = document.getElementById('chat-typing')
  if (el) el.classList.add('hidden')
}

function scrollToBottom(): void {
  const container = document.getElementById('chat-messages')
  if (container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight
    })
  }
}
