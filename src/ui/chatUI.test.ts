import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initChatUI,
  openChat,
  closeChat,
  toggleChat,
  getMessages,
  clearChat,
  notifyDatasetChanged,
} from './chatUI'
import type { ChatCallbacks } from './chatUI'

vi.mock('../services/docentService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/docentService')>()
  return {
    ...actual,
    processMessage: vi.fn(),
  }
})

// Minimal DOM setup
function setupDOM(): void {
  document.body.innerHTML = `
    <button id="chat-trigger"></button>
    <div id="chat-panel" class="hidden">
      <button id="chat-close"></button>
      <button id="chat-settings-btn"></button>
      <button id="chat-clear"></button>
      <div id="chat-settings" class="hidden">
        <input id="chat-settings-url" type="text" />
        <input id="chat-settings-key" type="password" />
        <input id="chat-settings-model" type="text" />
        <input id="chat-settings-enabled" type="checkbox" checked />
        <button id="chat-settings-test"></button>
        <button id="chat-settings-save"></button>
        <span id="chat-settings-status"></span>
      </div>
      <div id="chat-messages"></div>
      <div id="chat-typing" class="hidden"></div>
      <textarea id="chat-input" rows="1"></textarea>
      <button id="chat-send"></button>
    </div>
  `
}

type MockCallbacks = {
  [K in keyof ChatCallbacks]: ChatCallbacks[K] & ReturnType<typeof vi.fn>
}

function makeCallbacks(): MockCallbacks {
  return {
    onLoadDataset: vi.fn(),
    getDatasets: vi.fn().mockReturnValue([]),
    getCurrentDataset: vi.fn().mockReturnValue(null),
    announce: vi.fn(),
  } as MockCallbacks
}

beforeEach(() => {
  setupDOM()
  sessionStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('initChatUI', () => {
  it('initializes without error', () => {
    const cb = makeCallbacks()
    expect(() => initChatUI(cb)).not.toThrow()
  })

  it('renders welcome state when no messages', () => {
    initChatUI(makeCallbacks())
    const messages = document.getElementById('chat-messages')
    expect(messages?.innerHTML).toContain('chat-welcome')
  })

  it('restores messages from sessionStorage', () => {
    const session = {
      messages: [
        { id: 'test1', role: 'user', text: 'hello', timestamp: 1 },
        { id: 'test2', role: 'docent', text: 'Hi!', timestamp: 2 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))

    initChatUI(makeCallbacks())
    const msgs = getMessages()
    expect(msgs).toHaveLength(2)
    expect(msgs[0].text).toBe('hello')
  })
})

describe('openChat / closeChat / toggleChat', () => {
  it('opens the chat panel', () => {
    initChatUI(makeCallbacks())
    openChat()
    const panel = document.getElementById('chat-panel')
    expect(panel?.classList.contains('hidden')).toBe(false)
  })

  it('closes the chat panel', () => {
    initChatUI(makeCallbacks())
    openChat()
    closeChat()
    const panel = document.getElementById('chat-panel')
    expect(panel?.classList.contains('hidden')).toBe(true)
  })

  it('toggles the chat panel', () => {
    initChatUI(makeCallbacks())
    toggleChat() // open
    expect(document.getElementById('chat-panel')?.classList.contains('hidden')).toBe(false)
    toggleChat() // close
    expect(document.getElementById('chat-panel')?.classList.contains('hidden')).toBe(true)
  })

  it('adds active class to trigger when open', () => {
    initChatUI(makeCallbacks())
    openChat()
    const trigger = document.getElementById('chat-trigger')
    expect(trigger?.classList.contains('chat-trigger-active')).toBe(true)
  })

  it('announces when opening/closing', () => {
    const cb = makeCallbacks()
    initChatUI(cb)
    openChat()
    expect(cb.announce).toHaveBeenCalledWith('Chat opened')
    closeChat()
    expect(cb.announce).toHaveBeenCalledWith('Chat closed')
  })
})

describe('clearChat', () => {
  it('clears all messages', () => {
    const session = {
      messages: [{ id: 'x', role: 'user', text: 'hi', timestamp: 1 }],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    expect(getMessages()).toHaveLength(1)
    clearChat()
    expect(getMessages()).toHaveLength(0)
  })

  it('saves empty session to sessionStorage', () => {
    initChatUI(makeCallbacks())
    clearChat()
    const stored = JSON.parse(sessionStorage.getItem('sos-docent-chat')!)
    expect(stored.messages).toHaveLength(0)
  })
})

describe('notifyDatasetChanged', () => {
  it('does not throw', () => {
    initChatUI(makeCallbacks())
    expect(() => notifyDatasetChanged(null)).not.toThrow()
  })
})

describe('session persistence', () => {
  it('persists messages across init cycles', () => {
    const cb = makeCallbacks()

    // Manually set a session
    const session = {
      messages: [
        { id: 'm1', role: 'user', text: 'test message', timestamp: 1 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))

    // Re-init
    setupDOM()
    initChatUI(cb)
    expect(getMessages()).toHaveLength(1)
    expect(getMessages()[0].text).toBe('test message')
  })

  it('handles corrupted sessionStorage gracefully', () => {
    sessionStorage.setItem('sos-docent-chat', 'not-json')
    initChatUI(makeCallbacks())
    expect(getMessages()).toHaveLength(0)
  })
})

describe('handleSend streaming', () => {
  it('appends streaming deltas to docent message', async () => {
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Hello ' }
      yield { type: 'delta' as const, text: 'world!' }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'test message'

    const sendBtn = document.getElementById('chat-send') as HTMLButtonElement
    sendBtn.click()

    // Wait for async stream processing
    await vi.waitFor(() => {
      const msgs = getMessages()
      expect(msgs).toHaveLength(2) // user + docent
      expect(msgs[1].text).toBe('Hello world!')
    })
  })

  it('calls onLoadDataset for auto-load chunks', async () => {
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      yield {
        type: 'auto-load' as const,
        action: { type: 'load-dataset' as const, datasetId: 'DS_001', datasetTitle: 'Test Dataset' },
        alternatives: [],
      }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'show oceans'

    const sendBtn = document.getElementById('chat-send') as HTMLButtonElement
    sendBtn.click()

    await vi.waitFor(() => {
      expect(cb.onLoadDataset).toHaveBeenCalledWith('DS_001')
    })
  })

  it('disables send button while streaming', async () => {
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    let resolve: (() => void) | undefined
    const gate = new Promise<void>(r => { resolve = r })

    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Thinking...' }
      await gate
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'test'

    const sendBtn = document.getElementById('chat-send') as HTMLButtonElement
    sendBtn.click()

    // Send button should be disabled while streaming
    await vi.waitFor(() => {
      expect(sendBtn.disabled).toBe(true)
    })

    // Release the gate
    resolve!()

    // After streaming, send button should be re-enabled
    await vi.waitFor(() => {
      expect(sendBtn.disabled).toBe(false)
    })
  })

  it('renders action buttons from action chunks', async () => {
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Here are results:' }
      yield {
        type: 'action' as const,
        action: { type: 'load-dataset' as const, datasetId: 'DS_002', datasetTitle: 'Climate Data' },
      }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'climate data'

    const sendBtn = document.getElementById('chat-send') as HTMLButtonElement
    sendBtn.click()

    await vi.waitFor(() => {
      const actionBtns = document.querySelectorAll('.chat-action-btn')
      expect(actionBtns.length).toBeGreaterThan(0)
      expect(actionBtns[0].getAttribute('data-dataset-id')).toBe('DS_002')
    })
  })
})
