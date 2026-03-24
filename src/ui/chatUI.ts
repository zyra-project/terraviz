/**
 * Chat UI — digital docent chat panel.
 *
 * Floating panel in the bottom-left with a trigger button.
 * Streams LLM responses token-by-token, falls back to local engine.
 * Persists conversation in sessionStorage, config in localStorage.
 */

import type { ChatMessage, ChatAction, ChatSession, DocentConfig } from '../types'
import type { Dataset } from '../types'
import { escapeHtml } from './browseUI'
import { createMessageId } from '../services/docentEngine'
import { processMessage, loadConfig, saveConfig, testConnection, getDefaultConfig } from '../services/docentService'

// --- Constants ---
const SESSION_STORAGE_KEY = 'sos-docent-chat'
const MAX_PERSISTED_MESSAGES = 100

export interface ChatCallbacks {
  onLoadDataset: (id: string) => void
  getDatasets: () => Dataset[]
  getCurrentDataset: () => Dataset | null
  announce: (message: string) => void
}

let callbacks: ChatCallbacks | null = null
let messages: ChatMessage[] = []
let isOpen = false
let isStreaming = false
let settingsOpen = false

/**
 * Initialize the chat UI with callbacks and restore session.
 */
export function initChatUI(cb: ChatCallbacks): void {
  callbacks = cb
  restoreSession()
  wireEvents()
  renderMessages()
}

/**
 * Open the chat panel.
 */
export function openChat(): void {
  const panel = document.getElementById('chat-panel')
  const trigger = document.getElementById('chat-trigger')
  if (!panel) return
  isOpen = true
  panel.classList.remove('hidden')
  trigger?.classList.add('chat-trigger-active')
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
  if (!panel) return
  isOpen = false
  panel.classList.add('hidden')
  trigger?.classList.remove('chat-trigger-active')
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
export function notifyDatasetChanged(_dataset: Dataset | null): void {
  saveSession()
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
    lastActiveDatasetId: callbacks?.getCurrentDataset()?.id ?? null,
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

function wireEvents(): void {
  document.getElementById('chat-trigger')?.addEventListener('click', toggleChat)
  document.getElementById('chat-close')?.addEventListener('click', closeChat)
  document.getElementById('chat-send')?.addEventListener('click', handleSend)
  document.getElementById('chat-settings-btn')?.addEventListener('click', toggleSettings)

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
    enabled: enabledInput?.checked ?? true,
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

  const ok = await testConnection(config)

  if (status) {
    status.textContent = ok ? 'Connected' : 'Failed to connect'
    status.className = ok
      ? 'chat-settings-status chat-settings-status-ok'
      : 'chat-settings-status chat-settings-status-err'
    setTimeout(() => { status.textContent = '' }, 3000)
  }
  if (testBtn) testBtn.disabled = false
  callbacks?.announce(ok ? 'LLM connection successful' : 'LLM connection failed')
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
  isStreaming = true
  showTyping()
  setSendEnabled(false)

  try {
    const stream = processMessage(
      text,
      messages.slice(0, -1), // history without the placeholder
      callbacks.getDatasets(),
      callbacks.getCurrentDataset(),
    )

    let firstChunk = true
    for await (const chunk of stream) {
      switch (chunk.type) {
        case 'delta':
          if (firstChunk) {
            hideTyping()
            firstChunk = false
          }
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

        case 'done':
          break

        case 'error':
          // Error during streaming — the service handles fallback
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
      <p>I'm your digital docent. Ask me about any topic and I'll find data to show you on the globe.</p>
      <div class="chat-suggestions">
        <button class="chat-suggestion" data-query="Show me hurricanes">Hurricanes</button>
        <button class="chat-suggestion" data-query="Tell me about climate change">Climate</button>
        <button class="chat-suggestion" data-query="Show me ocean temperatures">Oceans</button>
        <button class="chat-suggestion" data-query="What about space?">Space</button>
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
  const textHtml = msg.text ? renderMarkdownLite(escapeHtml(msg.text)) : ''
  const actionsHtml = msg.actions?.length ? renderActions(msg.actions) : ''
  return `<div class="chat-msg ${roleClass}" data-msg-id="${msg.id}">
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

  let el = container.querySelector(`[data-msg-id="${msg.id}"]`)
  if (!el) {
    // Append it
    container.insertAdjacentHTML('beforeend', renderMessage(msg))
    el = container.querySelector(`[data-msg-id="${msg.id}"]`)
  } else {
    const textEl = el.querySelector('.chat-msg-text')
    if (textEl) {
      textEl.innerHTML = msg.text ? renderMarkdownLite(escapeHtml(msg.text)) : ''
    }
    // Update actions
    const existingActions = el.querySelector('.chat-actions')
    if (msg.actions?.length) {
      const actionsHtml = renderActions(msg.actions)
      if (existingActions) {
        existingActions.outerHTML = actionsHtml
      } else {
        el.insertAdjacentHTML('beforeend', actionsHtml)
      }
    }
  }
}

function renderActions(actions: ChatAction[]): string {
  return `<div class="chat-actions">${actions.map(a => {
    if (a.type === 'load-dataset') {
      return `<button class="chat-action-btn" data-dataset-id="${escapeHtml(a.datasetId)}" aria-label="Load ${escapeHtml(a.datasetTitle)}">
        <span class="chat-action-title">${escapeHtml(a.datasetTitle)}</span>
        <span class="chat-action-load">Load &#x27A4;</span>
      </button>`
    }
    return ''
  }).join('')}</div>`
}

function wireActionButtons(container: Element): void {
  container.querySelectorAll<HTMLElement>('.chat-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.datasetId
      if (id && callbacks) {
        callbacks.onLoadDataset(id)
        callbacks.announce('Loading dataset')
      }
    })
  })
}

/**
 * Minimal markdown: **bold**, bullet lists, and newlines.
 */
function renderMarkdownLite(html: string): string {
  return html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^• (.+)$/gm, '<li>$1</li>')
    .replace(/\n/g, '<br>')
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
