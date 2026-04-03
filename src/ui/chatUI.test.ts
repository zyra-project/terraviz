import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initChatUI,
  openChat,
  closeChat,
  toggleChat,
  getMessages,
  clearChat,
  notifyDatasetChanged,
  submitFeedback,
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
    <div id="chat-dataset-prompt" class="hidden"></div>
    <div id="chat-panel" class="hidden">
      <button id="chat-close"></button>
      <button id="chat-settings-btn"></button>
      <button id="chat-clear"></button>
      <div id="chat-settings" class="hidden">
        <input id="chat-settings-url" type="text" />
        <input id="chat-settings-key" type="password" />
        <input id="chat-settings-model" type="text" />
        <input id="chat-settings-enabled" type="checkbox" checked />
        <input id="chat-settings-vision" type="checkbox" />
        <select id="chat-settings-reading-level"><option value="general" selected>General</option></select>
        <button id="chat-settings-test"></button>
        <button id="chat-settings-save"></button>
        <span id="chat-settings-status"></span>
      </div>
      <div id="chat-messages"></div>
      <div id="chat-typing" class="hidden"></div>
      <div id="chat-vision-hint" class="chat-vision-hint"></div>
      <button id="chat-vision-toggle" class="chat-vision-btn" aria-pressed="false"></button>
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
    onOpenBrowse: vi.fn(),
  } as MockCallbacks
}

beforeEach(() => {
  setupDOM()
  sessionStorage.clear()
  localStorage.clear()
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
  it('does not throw with null', () => {
    initChatUI(makeCallbacks())
    expect(() => notifyDatasetChanged(null)).not.toThrow()
  })

  it('shows the dataset prompt when chat is closed and dataset is non-null', () => {
    initChatUI(makeCallbacks())
    const dataset = { id: 'DS_001', title: 'Sea Surface Temperature' } as Parameters<typeof notifyDatasetChanged>[0]
    notifyDatasetChanged(dataset)
    const prompt = document.getElementById('chat-dataset-prompt')
    expect(prompt?.classList.contains('hidden')).toBe(false)
    expect(prompt?.textContent).toContain('Sea Surface Temperature')
  })

  it('hides the dataset prompt when null is passed', () => {
    initChatUI(makeCallbacks())
    const dataset = { id: 'DS_001', title: 'Sea Surface Temperature' } as Parameters<typeof notifyDatasetChanged>[0]
    notifyDatasetChanged(dataset)
    notifyDatasetChanged(null)
    const prompt = document.getElementById('chat-dataset-prompt')
    expect(prompt?.classList.contains('hidden')).toBe(true)
  })

  it('does not show the dataset prompt when chat is open', () => {
    initChatUI(makeCallbacks())
    openChat()
    const dataset = { id: 'DS_001', title: 'Sea Surface Temperature' } as Parameters<typeof notifyDatasetChanged>[0]
    notifyDatasetChanged(dataset)
    const prompt = document.getElementById('chat-dataset-prompt')
    expect(prompt?.classList.contains('hidden')).toBe(true)
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

describe('trigger label collapse', () => {
  it('adds collapsed class to trigger on first openChat call', () => {
    initChatUI(makeCallbacks())
    openChat()
    expect(document.getElementById('chat-trigger')?.classList.contains('collapsed')).toBe(true)
  })

  it('sets localStorage flag on first openChat call', () => {
    initChatUI(makeCallbacks())
    openChat()
    expect(localStorage.getItem('sos-docent-seen')).toBe('1')
  })

  it('applies collapsed class on init if user has previously opened chat', () => {
    localStorage.setItem('sos-docent-seen', '1')
    initChatUI(makeCallbacks())
    expect(document.getElementById('chat-trigger')?.classList.contains('collapsed')).toBe(true)
  })

  it('does not apply collapsed class on init for first-time users', () => {
    initChatUI(makeCallbacks())
    expect(document.getElementById('chat-trigger')?.classList.contains('collapsed')).toBe(false)
  })
})

describe('welcome state copy', () => {
  it('renders the Digital Docent introduction', () => {
    initChatUI(makeCallbacks())
    clearChat() // ensure welcome state regardless of prior module state
    const messages = document.getElementById('chat-messages')
    expect(messages?.textContent).toContain('Orbit')
  })

  it('renders domain-specific suggestion buttons', () => {
    initChatUI(makeCallbacks())
    clearChat()
    const suggestions = document.querySelectorAll('.chat-suggestion')
    const queries = Array.from(suggestions).map(b => (b as HTMLElement).dataset.query ?? '')
    expect(queries.some(q => q.includes('sea level rise'))).toBe(true)
    expect(queries.some(q => q.includes('NDVI'))).toBe(true)
  })
})

describe('browse handoff', () => {
  it('shows "Compare in Browse" link when 3 or more action cards are rendered', async () => {
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)
    const makeAction = (id: string, title: string) => ({
      type: 'action' as const,
      action: { type: 'load-dataset' as const, datasetId: id, datasetTitle: title },
    })
    mockedProcessMessage.mockImplementation(async function* () {
      yield makeAction('DS_001', 'Dataset One')
      yield makeAction('DS_002', 'Dataset Two')
      yield makeAction('DS_003', 'Dataset Three')
      yield { type: 'done' as const, fallback: false }
    })
    initChatUI(makeCallbacks())
    openChat()
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'show me ocean data'
    document.getElementById('chat-send')?.click()
    await vi.waitFor(() => {
      expect(document.querySelector('.chat-browse-link')).not.toBeNull()
    })
  })

  it('does not show "Compare in Browse" link when fewer than 3 action cards are rendered', async () => {
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)
    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'action' as const, action: { type: 'load-dataset' as const, datasetId: 'DS_001', datasetTitle: 'Dataset One' } }
      yield { type: 'action' as const, action: { type: 'load-dataset' as const, datasetId: 'DS_002', datasetTitle: 'Dataset Two' } }
      yield { type: 'done' as const, fallback: false }
    })
    initChatUI(makeCallbacks())
    clearChat() // start from clean state so no prior messages with 3+ actions remain
    openChat()
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'show me something'
    document.getElementById('chat-send')?.click()
    await vi.waitFor(() => {
      expect(document.querySelector('.chat-action-btn')).not.toBeNull()
    })
    expect(document.querySelector('.chat-browse-link')).toBeNull()
  })
})

describe('vision toggle', () => {
  it('starts with vision disabled by default', () => {
    initChatUI(makeCallbacks())
    const btn = document.getElementById('chat-vision-toggle')
    expect(btn?.getAttribute('aria-pressed')).toBe('false')
  })

  it('toggles vision on click and updates aria-pressed', () => {
    initChatUI(makeCallbacks())
    const btn = document.getElementById('chat-vision-toggle')!
    btn.click()
    expect(btn.getAttribute('aria-pressed')).toBe('true')
    btn.click()
    expect(btn.getAttribute('aria-pressed')).toBe('false')
  })

  it('persists vision state to localStorage', () => {
    initChatUI(makeCallbacks())
    const btn = document.getElementById('chat-vision-toggle')!
    btn.click()

    const stored = JSON.parse(localStorage.getItem('sos-docent-config')!)
    expect(stored.visionEnabled).toBe(true)
  })

  it('restores vision state on init', () => {
    localStorage.setItem('sos-docent-config', JSON.stringify({ visionEnabled: true }))
    initChatUI(makeCallbacks())
    const btn = document.getElementById('chat-vision-toggle')
    expect(btn?.getAttribute('aria-pressed')).toBe('true')
  })

  it('shows hint banner when vision is enabled', () => {
    initChatUI(makeCallbacks())
    const btn = document.getElementById('chat-vision-toggle')!
    const hint = document.getElementById('chat-vision-hint')!
    expect(hint.classList.contains('visible')).toBe(false)
    btn.click()
    expect(hint.classList.contains('visible')).toBe(true)
    btn.click()
    expect(hint.classList.contains('visible')).toBe(false)
  })

  it('syncs settings checkbox with toggle button', () => {
    initChatUI(makeCallbacks())
    const btn = document.getElementById('chat-vision-toggle')!
    const checkbox = document.getElementById('chat-settings-vision') as HTMLInputElement

    btn.click()
    expect(checkbox.checked).toBe(true)
    btn.click()
    expect(checkbox.checked).toBe(false)
  })

  it('announces vision state changes', () => {
    const cb = makeCallbacks()
    initChatUI(cb)
    const btn = document.getElementById('chat-vision-toggle')!
    btn.click()
    expect(cb.announce).toHaveBeenCalledWith('Vision mode enabled')
    btn.click()
    expect(cb.announce).toHaveBeenCalledWith('Vision mode disabled')
  })
})

describe('feedback mechanism', () => {
  it('renders feedback buttons on docent messages but not user messages', () => {
    const session = {
      messages: [
        { id: 'u1', role: 'user', text: 'hello', timestamp: 1 },
        { id: 'd1', role: 'docent', text: 'Hi there!', timestamp: 2 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const container = document.getElementById('chat-messages')!
    const userMsg = container.querySelector('[data-msg-id="u1"]')
    const docentMsg = container.querySelector('[data-msg-id="d1"]')

    expect(userMsg?.querySelector('.chat-feedback')).toBeNull()
    expect(docentMsg?.querySelector('.chat-feedback')).not.toBeNull()
    expect(docentMsg?.querySelectorAll('.chat-feedback-btn')).toHaveLength(2)
  })

  it('does not render feedback buttons on empty docent messages', () => {
    const session = {
      messages: [
        { id: 'd1', role: 'docent', text: '', timestamp: 1 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const container = document.getElementById('chat-messages')!
    const docentMsg = container.querySelector('[data-msg-id="d1"]')
    expect(docentMsg?.querySelector('.chat-feedback')).toBeNull()
  })

  it('submits rating immediately on click without modal', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'u1', role: 'user', text: 'hello', timestamp: 1 },
        { id: 'd1', role: 'docent', text: 'Hi!', timestamp: 2 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    const cb = makeCallbacks()
    initChatUI(cb)

    const thumbsUp = document.querySelector('[data-feedback="thumbs-up"]') as HTMLElement
    thumbsUp.click()

    // No modal should appear
    expect(document.getElementById('chat-feedback-modal')).toBeNull()

    // Wait for fetch
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    // Verify the payload includes new RLHF fields
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('/api/feedback')
    const body = JSON.parse((opts as RequestInit).body as string)
    expect(body.rating).toBe('thumbs-up')
    expect(body.messageId).toBe('d1')
    expect(body.messages).toHaveLength(2)
    expect(body.userMessage).toBe('hello')
    expect(body.turnIndex).toBe(0)

    fetchSpy.mockRestore()
  })

  it('does NOT reset conversation after feedback', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'u1', role: 'user', text: 'hello', timestamp: 1 },
        { id: 'd1', role: 'docent', text: 'Hi!', timestamp: 2 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    const cb = makeCallbacks()
    initChatUI(cb)

    const thumbsUp = document.querySelector('[data-feedback="thumbs-up"]') as HTMLElement
    thumbsUp.click()

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    // Conversation should still be intact
    expect(getMessages()).toHaveLength(2)
    expect(cb.announce).toHaveBeenCalledWith('Feedback submitted')

    fetchSpy.mockRestore()
  })

  it('disables buttons and highlights selected on click', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'd1', role: 'docent', text: 'Answer', timestamp: 1 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const thumbsUp = document.querySelector('[data-feedback="thumbs-up"]') as HTMLElement
    const thumbsDown = document.querySelector('[data-feedback="thumbs-down"]') as HTMLElement
    thumbsUp.click()

    // Selected button should be highlighted, other disabled
    expect(thumbsUp.classList.contains('chat-feedback-rated')).toBe(true)
    expect(thumbsDown.classList.contains('chat-feedback-disabled')).toBe(true)

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    fetchSpy.mockRestore()
  })

  it('re-enables buttons on submission failure', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Rate limit exceeded' }), { status: 429 }),
    )

    const session = {
      messages: [
        { id: 'd1', role: 'docent', text: 'Answer', timestamp: 1 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const thumbsDown = document.querySelector('[data-feedback="thumbs-down"]') as HTMLElement
    thumbsDown.click()

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    // Buttons should be re-enabled after failure
    await vi.waitFor(() => {
      expect(thumbsDown.classList.contains('chat-feedback-rated')).toBe(false)
      expect(thumbsDown.classList.contains('chat-feedback-disabled')).toBe(false)
    })

    // Messages should still be intact
    expect(getMessages()).toHaveLength(1)
    fetchSpy.mockRestore()
  })

  it('sends userMessage in payload (the preceding user message)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'u1', role: 'user', text: 'Tell me about oceans', timestamp: 1 },
        { id: 'd1', role: 'docent', text: 'Oceans cover 71%...', timestamp: 2 },
        { id: 'u2', role: 'user', text: 'What about coral?', timestamp: 3 },
        { id: 'd2', role: 'docent', text: 'Coral reefs are...', timestamp: 4 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    // Rate the second docent message
    const btns = document.querySelectorAll('[data-feedback="thumbs-up"][data-msg-id="d2"]')
    ;(btns[0] as HTMLElement).click()

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.userMessage).toBe('What about coral?')
    expect(body.turnIndex).toBe(1)

    fetchSpy.mockRestore()
  })

  it('shows inline expansion with tags after successful rating', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'd1', role: 'docent', text: 'Answer', timestamp: 1 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const thumbsDown = document.querySelector('[data-feedback="thumbs-down"]') as HTMLElement
    thumbsDown.click()

    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    // Expansion should appear with tags
    const expansion = document.getElementById('chat-feedback-expansion')
    expect(expansion).not.toBeNull()
    expect(expansion?.querySelectorAll('.chat-feedback-tag').length).toBeGreaterThan(0)
    expect(expansion?.querySelector('.chat-feedback-comment')).not.toBeNull()

    fetchSpy.mockRestore()
  })

  it('dismisses expansion on Escape key', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'd1', role: 'docent', text: 'Answer', timestamp: 1 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const thumbsUp = document.querySelector('[data-feedback="thumbs-up"]') as HTMLElement
    thumbsUp.click()

    await vi.waitFor(() => {
      expect(document.getElementById('chat-feedback-expansion')).not.toBeNull()
    })

    const expansion = document.getElementById('chat-feedback-expansion')!
    expansion.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(document.getElementById('chat-feedback-expansion')).toBeNull()

    fetchSpy.mockRestore()
  })

  it('toggles tag aria-pressed on click', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'd1', role: 'docent', text: 'Answer', timestamp: 1 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const thumbsDown = document.querySelector('[data-feedback="thumbs-down"]') as HTMLElement
    thumbsDown.click()

    await vi.waitFor(() => {
      expect(document.getElementById('chat-feedback-expansion')).not.toBeNull()
    })

    const tag = document.querySelector('.chat-feedback-tag') as HTMLElement
    expect(tag.getAttribute('aria-pressed')).toBe('false')
    tag.click()
    expect(tag.getAttribute('aria-pressed')).toBe('true')
    tag.click()
    expect(tag.getAttribute('aria-pressed')).toBe('false')

    fetchSpy.mockRestore()
  })

  it('submits tags and comment on send', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const session = {
      messages: [
        { id: 'u1', role: 'user', text: 'hello', timestamp: 1 },
        { id: 'd1', role: 'docent', text: 'Answer', timestamp: 2 },
      ],
    }
    sessionStorage.setItem('sos-docent-chat', JSON.stringify(session))
    initChatUI(makeCallbacks())

    const thumbsDown = document.querySelector('[data-feedback="thumbs-down"]') as HTMLElement
    thumbsDown.click()

    // Wait for expansion to appear
    await vi.waitFor(() => {
      expect(document.getElementById('chat-feedback-expansion')).not.toBeNull()
    })

    // Select a tag
    const tag = document.querySelector('.chat-feedback-tag') as HTMLElement
    tag.click()

    // Type a comment
    const textarea = document.querySelector('.chat-feedback-comment') as HTMLTextAreaElement
    textarea.value = 'Wrong dataset suggested'

    // Click send
    const sendBtn = document.querySelector('.chat-feedback-send') as HTMLElement
    sendBtn.click()

    // Wait for second fetch (update)
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2)
    })

    const body = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string)
    expect(body.tags).toHaveLength(1)
    expect(body.comment).toBe('Wrong dataset suggested')

    // Expansion should be dismissed
    await vi.waitFor(() => {
      expect(document.getElementById('chat-feedback-expansion')).toBeNull()
    })

    fetchSpy.mockRestore()
  })
})
