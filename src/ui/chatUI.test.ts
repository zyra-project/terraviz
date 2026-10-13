// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

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
  getImmersiveVoiceState,
  toggleImmersiveVoice,
  endImmersiveVoice,
} from './chatUI'
import type { ChatCallbacks } from './chatUI'
import { loadConfig, saveConfig } from '../services/docentService'
import { t } from '../i18n'
import { until } from '../test-utils'
import {
  createFakeSttEngine,
  registerSttEngine,
  registerTtsEngine,
  resetVoiceEngines,
  type SttEngine,
  type SttStartOptions,
  type TtsEngine,
} from '../services/voiceService'
import {
  clearDegraded,
  markDegraded,
  resetForTests as resetDegradedForTests,
} from '../services/docentDegradedState'

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
        <select id="chat-settings-voice-lang">
          <option value=""></option>
          <option value="es">es</option>
          <option value="ja">ja</option>
        </select>
        <select id="chat-settings-voice-handsfree">
          <option value="off"></option>
          <option value="push-to-talk">Push to talk</option>
          <option value="open-mic">Open mic</option>
        </select>
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
    onVoiceAudioFocus: vi.fn(),
    onShowAnalysis: vi.fn(),
    // Globe-control seams. Absent here, every assertion about whether
    // the camera moved silently passes on `undefined` — which is how a
    // measurement's fly-to reached production without a test noticing
    // it was being queued and never run.
    onFlyTo: vi.fn(),
    onAddMarker: vi.fn(),
  } as MockCallbacks
}

/** Let pending micro/macrotasks settle (handleSend is async). */
async function flush(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) {
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
}

beforeEach(() => {
  setupDOM()
  sessionStorage.clear()
  localStorage.clear()
  resetDegradedForTests()
  // The message list is module-level; clear it so a test that sends a
  // message doesn't leak into a later "no messages" assertion.
  clearChat()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetDegradedForTests()
})

describe('recognition-language override (voiceLang)', () => {
  it('saves a chosen language and clears it on "Same as app"', () => {
    initChatUI(makeCallbacks())
    const sel = document.getElementById('chat-settings-voice-lang') as HTMLSelectElement
    const save = document.getElementById('chat-settings-save') as HTMLButtonElement

    sel.value = 'es'
    save.click()
    expect(loadConfig().voiceLang).toBe('es')

    // "" is the "Same as app" default — clears the override so voice
    // tracks the UI locale again.
    sel.value = ''
    save.click()
    expect(loadConfig().voiceLang).toBeUndefined()
  })
})

describe('voice audio ducking', () => {
  it('ducks dataset audio on send and restores it after the turn', async () => {
    const cb = makeCallbacks()
    initChatUI(cb)
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'hello orbit'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()
    await flush()
    const calls = (cb.onVoiceAudioFocus as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    // Ducked at the start of the turn, restored once it completes.
    expect(calls[0]).toBe(true)
    expect(calls[calls.length - 1]).toBe(false)
  })
})

describe('hands-free mode (voiceHandsFree)', () => {
  it('persists the chosen hands-free mode through settings', () => {
    initChatUI(makeCallbacks())
    const sel = document.getElementById('chat-settings-voice-handsfree') as HTMLSelectElement
    const save = document.getElementById('chat-settings-save') as HTMLButtonElement

    sel.value = 'open-mic'
    save.click()
    expect(loadConfig().voiceHandsFree).toBe('open-mic')

    sel.value = 'off'
    save.click()
    expect(loadConfig().voiceHandsFree).toBe('off')
  })
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

// ── Phase 1f/D + 1f/I + 1f/N — degraded-mode badge ─────────────
describe('degraded-mode badge', () => {
  function badgeEl(): HTMLElement | null {
    return document.getElementById('chat-degraded-badge')
  }

  it('renders the badge on init when state is already degraded', () => {
    // 1f/D: initChatUI synchronously reads getDegradedReason() so an
    // early-detection (e.g. disclosure banner triggering a search
    // before the chat UI mounts) shows up immediately rather than
    // waiting for the next state change.
    markDegraded('quota_exhausted')
    initChatUI(makeCallbacks())
    expect(badgeEl()).not.toBeNull()
    expect(badgeEl()!.textContent).toMatch(/Workers AI quota reached/)
    expect(badgeEl()!.getAttribute('role')).toBe('status')
    expect(badgeEl()!.getAttribute('aria-live')).toBe('polite')
  })

  it('does not render the badge on init when state is clean', () => {
    initChatUI(makeCallbacks())
    expect(badgeEl()).toBeNull()
  })

  it('renders the badge when markDegraded fires after init', () => {
    initChatUI(makeCallbacks())
    expect(badgeEl()).toBeNull()
    markDegraded('quota_exhausted')
    expect(badgeEl()).not.toBeNull()
  })

  it('removes the badge when clearDegraded fires', () => {
    initChatUI(makeCallbacks())
    markDegraded('quota_exhausted')
    expect(badgeEl()).not.toBeNull()
    clearDegraded()
    expect(badgeEl()).toBeNull()
  })

  it('does not duplicate the badge on repeated state changes', () => {
    initChatUI(makeCallbacks())
    markDegraded('quota_exhausted')
    // Re-marking is a no-op at the state layer (markDegraded
    // suppresses the listener fanout for the same reason), but
    // even a forced re-render must not stack badge elements.
    markDegraded('quota_exhausted')
    expect(document.querySelectorAll('#chat-degraded-badge').length).toBe(1)
  })

  it('1f/I — re-initialising the UI does not stack listeners', () => {
    // initChatUI is normally called once at boot; tests + hot-reload
    // can re-call it. Pre-1f/I each call appended a fresh subscriber
    // so a single markDegraded fired the render N times. The
    // unsubscribe-before-resubscribe guard means after a re-init,
    // exactly one listener still routes state changes to the DOM.
    initChatUI(makeCallbacks())
    initChatUI(makeCallbacks())
    initChatUI(makeCallbacks())
    markDegraded('quota_exhausted')
    expect(document.querySelectorAll('#chat-degraded-badge').length).toBe(1)
    clearDegraded()
    expect(badgeEl()).toBeNull()
  })

  // A quota-exhausted turn ends in the local engine's answer with
  // `fallback: true`. The badge already says why; the generic "AI service
  // unavailable — … Check LLM settings." hint would contradict it and send
  // the operator after settings that are fine.
  async function sendFallbackTurn(): Promise<string> {
    const { processMessage } = await import('../services/docentService')
    vi.mocked(processMessage).mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'Offline answer.' }
      yield { type: 'done' as const, fallback: true }
    })
    initChatUI(makeCallbacks())
    openChat()
    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'what is this'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()
    await vi.waitFor(() => {
      expect(getMessages()[1]?.text).toContain('Offline answer.')
    })
    // Let the `done` chunk land; the second test proves this is long
    // enough for the hint to appear when it should.
    await flush()
    return getMessages()[1].text
  }

  it('shows the badge instead of the settings hint on a degraded fallback', async () => {
    markDegraded('quota_exhausted')
    const text = await sendFallbackTurn()
    expect(badgeEl()).not.toBeNull()
    expect(text).toBe('Offline answer.')
    expect(text).not.toMatch(/AI service unavailable/)
  })

  it('keeps the settings hint on a fallback with no degraded reason', async () => {
    const text = await sendFallbackTurn()
    expect(badgeEl()).toBeNull()
    expect(text).toMatch(/AI service unavailable/)
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

  it('renders a unit exponent however the model wrote it', async () => {
    // §A6 answers quote units from the dataset's own sidecar as plain
    // text ("kg m-2"). Live, the model re-set them in LaTeX — "at least
    // 427 mg m$^{-2}$" — and this chat has no math renderer, so the
    // markup reached the reader raw. Fixed in the renderer rather than
    // with another prompt rule: after ten failed instructions about how
    // to write a value, notation is a rendering concern.
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      // Every notation seen or plausible, plus a price that must survive:
      // the conversion is all-or-nothing per exponent and only fires on
      // something shaped like one.
      yield { type: 'delta' as const, text: 'At least 427 mg m$^{-2}$, or 2 kg m^{-3}, or 5 m^2, costing $30.' }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'how bad is it'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      const rendered = document.querySelector('#chat-messages')?.textContent ?? ''
      expect(rendered).toContain('427 mg m\u207b\u00b2')
      expect(rendered).toContain('2 kg m\u207b\u00b3')
      expect(rendered).toContain('5 m\u00b2')
      // The exponents are gone; the price is not.
      expect(rendered).not.toContain('^')
      expect(rendered).toContain('$30')
    })
  })

  it('renders a measurement card for a measurement action', async () => {
    // Reported live: no card visible on a build that has this code.
    // The render path had never been asserted end-to-end — only that
    // docentService emits the chunk — so this pins the other half.
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'The smoke is worst over Canada.' }
      yield {
        type: 'action' as const,
        action: {
          type: 'measurement' as const,
          valueText: '0.000427 kg m-2, the highest anywhere in Canada',
          lat: 54.2,
          lon: -101.4,
          frameTime: 'Jul 31, 2026, 07:00 AM',
          dataset: 'Wildfire Smoke Overhead',
        },
      }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'where is it worst'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      const card = document.querySelector('.chat-measurement')
      expect(card).not.toBeNull()
      const shown = card!.textContent ?? ''
      expect(shown).toContain('0.000427 kg m-2')
      expect(shown).toContain('Canada')
      // Signed floats become compass letters only at render time.
      expect(shown).toContain('54.20°N')
      expect(shown).toContain('101.40°W')
      expect(shown).toContain('Wildfire Smoke Overhead')
    })
  })

  it('moves the globe for a measurement even when the reply offers a dataset to load', async () => {
    // Reported live: the reading was right, the card rendered, and the
    // globe never moved. The same reply recommended a different dataset,
    // and globe actions are held until a pending Load is tapped — which
    // is correct for an event card (Load, then fly to where it happened)
    // and wrong for a measurement, which describes the frame already on
    // the globe.
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'The smoke is worst in northern Canada.' }
      yield {
        type: 'action' as const,
        action: {
          type: 'measurement' as const,
          valueText: 'at least 0.0005 kg m-2, the highest anywhere in the whole dataset',
          lat: 65.879,
          lon: -121.851,
        },
      }
      yield { type: 'action' as const, action: { type: 'fly-to' as const, lat: 65.879, lon: -121.851, fromMeasurement: true as const } }
      yield {
        type: 'action' as const,
        action: { type: 'add-marker' as const, lat: 65.879, lng: -121.851, label: '0.0005 kg m-2', fromMeasurement: true as const },
      }
      // The recommendation that used to hold the camera hostage.
      yield {
        type: 'action' as const,
        action: { type: 'load-dataset' as const, datasetId: 'DS_OTHER', datasetTitle: 'Wildfire Smoke Forecast' },
      }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'where is the smoke worst'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      expect(cb.onFlyTo).toHaveBeenCalledWith(65.879, -121.851, undefined)
      expect(cb.onAddMarker).toHaveBeenCalledWith(65.879, -121.851, '0.0005 kg m-2')
    })
    // And the unrelated dataset was not loaded as a side effect.
    expect(cb.onLoadDataset).not.toHaveBeenCalled()
  })

  it('still holds an untagged fly-to behind a pending Load', async () => {
    // The event-card ordering this deferral exists for must survive.
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'There is an outbreak.' }
      yield { type: 'action' as const, action: { type: 'fly-to' as const, lat: 10, lon: 20 } }
      yield {
        type: 'action' as const,
        action: { type: 'load-dataset' as const, datasetId: 'DS_OTHER', datasetTitle: 'Some Dataset' },
      }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'what is happening'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      expect(getMessages()).toHaveLength(2)
    })
    expect(cb.onFlyTo).not.toHaveBeenCalled()
  })

  it('renders a cited event card for an event-citation action', async () => {
    const { processMessage } = await import('../services/docentService')
    const mockedProcessMessage = vi.mocked(processMessage)

    mockedProcessMessage.mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'There is an active wildfire outbreak.' }
      yield {
        type: 'action' as const,
        action: {
          type: 'event-citation' as const,
          eventId: 'EVT_1',
          title: 'Wildfire outbreak in the Sierra',
          sourceName: 'InciWeb',
          sourceUrl: 'https://inciweb.example/1',
        },
      }
      yield { type: 'done' as const, fallback: false }
    })

    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    initChatUI(cb)
    openChat()

    const input = document.getElementById('chat-input') as HTMLTextAreaElement
    input.value = "what's happening with wildfires?"
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    await vi.waitFor(() => {
      const card = document.querySelector('.chat-event-citation')
      expect(card).not.toBeNull()
      expect(card!.querySelector('.chat-event-title')!.textContent).toBe('Wildfire outbreak in the Sierra')
      const link = card!.querySelector('.chat-event-source') as HTMLAnchorElement
      expect(link.href).toContain('inciweb.example/1')
    })
  })

  it('suppresses the eager set-time error when a Load is pending in the same message', async () => {
    // An Orbit current-event card streams Load + Fly + Seek together at app
    // start; the seek is deferred until the Load tap, so flagging "no video
    // dataset loaded" before then is misleading.
    const { processMessage } = await import('../services/docentService')
    vi.mocked(processMessage).mockImplementation(async function* () {
      yield { type: 'action' as const, action: { type: 'load-dataset' as const, datasetId: 'DS_NEW', datasetTitle: 'Clouds' } }
      yield { type: 'action' as const, action: { type: 'set-time' as const, isoDate: '2026-08-01' } }
      yield { type: 'done' as const, fallback: false }
    })
    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    cb.canSetTime = vi.fn().mockReturnValue({ ok: false, message: 'No video dataset loaded' })
    initChatUI(cb)
    openChat()
    ;(document.getElementById('chat-input') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    await vi.waitFor(() => expect(document.querySelector('.chat-action-status')).not.toBeNull())
    expect(document.querySelector('.chat-action-status-err')).toBeNull()
  })

  it('clears a premature set-time error at done when a Load arrives after it', async () => {
    // An inline set_time tool call streams BEFORE the turn-end load-dataset,
    // so the stream-time eager check saw no pending load and stamped the
    // error. The done handler must clear it once the full action set is known.
    const { processMessage } = await import('../services/docentService')
    vi.mocked(processMessage).mockImplementation(async function* () {
      yield { type: 'action' as const, action: { type: 'set-time' as const, isoDate: '2026-08-01' } }
      yield { type: 'action' as const, action: { type: 'load-dataset' as const, datasetId: 'DS_LATE', datasetTitle: 'Clouds' } }
      yield { type: 'done' as const, fallback: false }
    })
    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    cb.canSetTime = vi.fn().mockReturnValue({ ok: false, message: 'No video dataset loaded' })
    initChatUI(cb)
    openChat()
    ;(document.getElementById('chat-input') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    // After the stream completes, the premature error must be gone.
    await vi.waitFor(() => expect(document.querySelector('.chat-action-status')).not.toBeNull())
    await flush()
    expect(document.querySelector('.chat-action-status-err')).toBeNull()
  })

  it('still flags a set-time error when no Load is pending', async () => {
    const { processMessage } = await import('../services/docentService')
    vi.mocked(processMessage).mockImplementation(async function* () {
      yield { type: 'action' as const, action: { type: 'set-time' as const, isoDate: '2026-08-01' } }
      yield { type: 'done' as const, fallback: false }
    })
    const cb = makeCallbacks()
    cb.getDatasets.mockReturnValue([])
    cb.getCurrentDataset.mockReturnValue(null)
    cb.canSetTime = vi.fn().mockReturnValue({ ok: false, message: 'No video dataset loaded' })
    initChatUI(cb)
    openChat()
    ;(document.getElementById('chat-input') as HTMLTextAreaElement).value = 'x'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()

    await vi.waitFor(() => expect(document.querySelector('.chat-action-status-err')).not.toBeNull())
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

describe('§A6 — the Analyze chip', () => {
  /** Stream one show-analysis action and return the rendered chip. */
  async function renderChip(
    action: Record<string, unknown>,
    cb = makeCallbacks(),
  ): Promise<HTMLButtonElement | null> {
    const { processMessage } = await import('../services/docentService')
    vi.mocked(processMessage).mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'The mean is 200 mg m-2.' }
      yield { type: 'action' as const, action: action as never }
      yield { type: 'done' as const, fallback: false }
    })
    initChatUI(cb)
    openChat()
    ;(document.getElementById('chat-input') as HTMLTextAreaElement).value = 'how bad is it?'
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()
    await vi.waitFor(() => expect(getMessages()).toHaveLength(2))
    await flush()
    return document.querySelector<HTMLButtonElement>('.chat-action-analyze')
  }

  it('names the region it will open', async () => {
    const chip = await renderChip({ type: 'show-analysis', scope: 'named', regionName: 'Colorado' })
    expect(chip).not.toBeNull()
    expect(chip!.textContent).toContain('Colorado')
  })

  it('opens Analyze on that region when clicked', async () => {
    const cb = makeCallbacks()
    const chip = await renderChip(
      { type: 'show-analysis', scope: 'named', regionName: 'Colorado' },
      cb,
    )
    chip!.click()
    expect(cb.onShowAnalysis).toHaveBeenCalledWith('named', 'Colorado')
  })

  it('never falls through to loading a dataset', async () => {
    // The chip carries no dataset id, so without its own exclusive
    // branch it would reach the load-dataset path with `undefined` —
    // the same footgun the frame-load branch guards against.
    const cb = makeCallbacks()
    const chip = await renderChip({ type: 'show-analysis', scope: 'dataset' }, cb)
    chip!.click()
    expect(cb.onLoadDataset).not.toHaveBeenCalled()
  })

  it('is not rendered by a host that cannot open the panel', async () => {
    // A chip that opens nothing is worse than no chip.
    const cb = makeCallbacks()
    delete (cb as Record<string, unknown>).onShowAnalysis
    const chip = await renderChip({ type: 'show-analysis', scope: 'named', regionName: 'Colorado' }, cb)
    expect(chip).toBeNull()
  })

  it('labels the whole-dataset and view scopes differently', async () => {
    const whole = await renderChip({ type: 'show-analysis', scope: 'dataset' })
    expect(whole!.textContent).not.toContain('undefined')
    clearChat()
    const view = await renderChip({ type: 'show-analysis', scope: 'view' })
    expect(view!.textContent).not.toBe(whole!.textContent)
  })
})

describe('immersive voice (VR/AR HUD)', () => {
  // `local` sorts first in the `auto` resolution order, so these fakes
  // win over whatever the browser registers at init.
  function fakeTts(spoken: string[]) {
    return {
      provider: 'local' as const,
      supportsLanguage: () => true,
      isAvailable: () => true,
      speak: async (text: string): Promise<void> => { spoken.push(text) },
      cancel: vi.fn<() => void>(),
    } satisfies TtsEngine
  }

  /** An STT engine that reports a partial and waits for stop() to commit it. */
  function heldSttEngine(partial: string): SttEngine {
    return {
      provider: 'local',
      supportsLanguage: () => true,
      isAvailable: () => true,
      start: (opts: SttStartOptions) => {
        queueMicrotask(() => opts.onResult({ transcript: partial, isFinal: false }))
        return {
          stop: () => {
            opts.onResult({ transcript: partial, isFinal: true })
            opts.onEnd()
          },
        }
      },
    }
  }

  async function replyWith(...chunks: Array<Record<string, unknown>>): Promise<void> {
    const { processMessage } = await import('../services/docentService')
    vi.mocked(processMessage).mockImplementation(async function* () {
      for (const chunk of chunks) yield chunk as never
      yield { type: 'done' as const, fallback: false }
    })
  }

  const LOAD_ICE = { type: 'action', action: { type: 'load-dataset', datasetId: 'DS_ICE', datasetTitle: 'Sea Ice' } }

  /**
   * How many sends have run to their last step. `handleSend` announces
   * this when it is done, so it anchors a "didn't happen" assertion on
   * the chain having finished rather than on a count of event-loop turns.
   */
  function sendsFinished(cb: MockCallbacks): number {
    return cb.announce.mock.calls.filter((c) => c[0] === t('chat.announce.docentResponded')).length
  }

  /**
   * Whether a turn has restored the ducked dataset audio. It does that
   * once its speech has drained, so this anchors "nothing more was
   * spoken" where the send finishing would come too early.
   */
  function audioRestored(cb: MockCallbacks): boolean {
    return (cb.onVoiceAudioFocus as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[0] === false)
  }

  function sendFromPanel(text: string): void {
    ;(document.getElementById('chat-input') as HTMLTextAreaElement).value = text
    ;(document.getElementById('chat-send') as HTMLButtonElement).click()
  }

  beforeEach(() => {
    resetVoiceEngines()
    endImmersiveVoice()
  })

  afterEach(() => {
    resetVoiceEngines()
    endImmersiveVoice()
  })

  it('offers no voice when no STT engine resolves, so the HUD hides its mic', () => {
    initChatUI(makeCallbacks())
    expect(getImmersiveVoiceState()).toBeNull()
  })

  it('runs a whole spoken turn: listen, send, speak, then let the caption linger', async () => {
    const spoken: string[] = []
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'show me sea ice' }))
    registerTtsEngine(fakeTts(spoken))
    await replyWith({ type: 'delta', text: 'Here is sea ice. It shrinks every summer.' })
    initChatUI(makeCallbacks())
    expect(getImmersiveVoiceState()).toEqual({ phase: 'idle', caption: '' })

    toggleImmersiveVoice()
    expect(getImmersiveVoiceState()?.phase).toBe('listening')

    await vi.waitFor(() => expect(spoken).toHaveLength(2))
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('idle'))
    expect(getMessages()[0]).toMatchObject({ role: 'user', text: 'show me sea ice' })
    // Spoken although voiceAutoSpeak is off: voice in, voice out.
    expect(loadConfig().voiceAutoSpeak).toBe(false)
    expect(spoken).toEqual(['Here is sea ice.', 'It shrinks every summer.'])
    // The last sentence stays readable for a moment, then clears.
    expect(getImmersiveVoiceState()?.caption).toBe('It shrinks every summer.')
    expect(getImmersiveVoiceState(Date.now() + 60_000)).toEqual({ phase: 'idle', caption: '' })
  })

  it('leaves a panel turn silent when auto-speak is off', async () => {
    const spoken: string[] = []
    registerTtsEngine(fakeTts(spoken))
    await replyWith({ type: 'delta', text: 'Here is sea ice.' })
    const cb = makeCallbacks()
    initChatUI(cb)
    sendFromPanel('show me sea ice')
    await until(() => sendsFinished(cb) === 1, 'the send finished')
    await until(() => audioRestored(cb), 'the turn drained')
    expect(getMessages()[1]?.text).toBe('Here is sea ice.')
    expect(spoken).toEqual([])
  })

  it('carries out the first Load in the reply, since no one can tap it in the headset', async () => {
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'show me sea ice' }))
    await replyWith({ type: 'delta', text: 'Sea ice is a good fit.' }, LOAD_ICE)
    const cb = makeCallbacks()
    initChatUI(cb)

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(cb.onLoadDataset).toHaveBeenCalledWith('DS_ICE'))
    expect(cb.onLoadDataset).toHaveBeenCalledTimes(1)
  })

  it('does not swap the dataset the reply is about for a related one it also suggests', async () => {
    // Orbit often attaches a Load for the dataset being viewed. The
    // reply's first Load is the rule, and that one is already showing.
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'what am I looking at' }))
    await replyWith(
      { type: 'delta', text: 'This is sea surface temperature. Sea ice is related.' },
      { type: 'action', action: { type: 'load-dataset', datasetId: 'DS_SST', datasetTitle: 'Sea Surface Temperature' } },
      LOAD_ICE,
      { type: 'action', action: { type: 'fly-to', lat: 10, lon: 20 } },
    )
    const cb = makeCallbacks()
    cb.getCurrentDataset.mockReturnValue({ id: 'DS_SST' })
    initChatUI(cb)

    toggleImmersiveVoice()
    await until(() => sendsFinished(cb) === 1, 'the send finished')
    expect(cb.onLoadDataset).not.toHaveBeenCalled()
    // Nothing is loading, so the reply's fly-to has no load to wait for.
    expect(cb.onFlyTo).toHaveBeenCalledWith(10, 20, undefined)
  })

  it('holds the fly-to until the Load it carried out lands', async () => {
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'show me sea ice' }))
    await replyWith(
      { type: 'delta', text: 'Sea ice is a good fit.' },
      LOAD_ICE,
      { type: 'action', action: { type: 'fly-to', lat: 10, lon: 20 } },
    )
    const cb = makeCallbacks()
    cb.getCurrentDataset.mockReturnValue({ id: 'DS_SST' })
    initChatUI(cb)

    toggleImmersiveVoice()
    await until(() => sendsFinished(cb) === 1, 'the send finished')
    expect(cb.onLoadDataset.mock.calls).toEqual([['DS_ICE']])
    // The host flushes it once the dataset is on the globe, as after a click.
    expect(cb.onFlyTo).not.toHaveBeenCalled()
  })

  it('leaves the Load as a button on a panel turn', async () => {
    await replyWith({ type: 'delta', text: 'Sea ice is a good fit.' }, LOAD_ICE)
    const cb = makeCallbacks()
    initChatUI(cb)
    sendFromPanel('show me sea ice')
    await until(() => sendsFinished(cb) === 1, 'the send finished')
    expect(getMessages()[1]?.actions).toHaveLength(1)
    expect(cb.onLoadDataset).not.toHaveBeenCalled()
  })

  it('does not load an alternative over a dataset the turn already auto-loaded', async () => {
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'show me sea ice' }))
    await replyWith({
      type: 'auto-load',
      action: { type: 'load-dataset', datasetId: 'DS_ICE', datasetTitle: 'Sea Ice' },
      alternatives: [{ type: 'load-dataset', datasetId: 'DS_SNOW', datasetTitle: 'Snow Cover' }],
    })
    const cb = makeCallbacks()
    initChatUI(cb)

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getMessages()).toHaveLength(2))
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('idle'))
    expect(cb.onLoadDataset.mock.calls).toEqual([['DS_ICE']])
  })

  it('captions the live transcript, and a second tap sends what was heard', async () => {
    registerSttEngine(heldSttEngine('where is the ozone hole'))
    await replyWith({ type: 'delta', text: 'Over Antarctica.' })
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getImmersiveVoiceState()).toEqual({ phase: 'listening', caption: 'where is the ozone hole' }))

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getMessages()[0]?.text).toBe('where is the ozone hole'))
  })

  it('shows thinking after the send tap while the engine is still transcribing', async () => {
    // Cloud STT has no live transcript: stop() uploads the recording,
    // and the session only ends when the transcription comes back.
    let answer: () => void = () => {}
    registerSttEngine({
      provider: 'local',
      supportsLanguage: () => true,
      isAvailable: () => true,
      start: (opts) => ({
        stop: () => {
          answer = () => {
            opts.onResult({ transcript: 'where is the ozone hole', isFinal: true })
            opts.onEnd()
          }
        },
      }),
    })
    await replyWith({ type: 'delta', text: 'Over Antarctica.' })
    const cb = makeCallbacks()
    initChatUI(cb)

    toggleImmersiveVoice()
    expect(getImmersiveVoiceState()?.phase).toBe('listening')
    toggleImmersiveVoice()
    // Not "Listening… tap the mic to send" for the whole upload.
    expect(getImmersiveVoiceState()).toEqual({ phase: 'thinking', caption: '' })

    answer()
    await until(() => sendsFinished(cb) === 1, 'the send finished')
    expect(getMessages()[0]).toMatchObject({ role: 'user', text: 'where is the ozone hole' })
  })

  it('shows the reply as the caption when no voice can speak it', async () => {
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'show me sea ice' }))
    await replyWith({ type: 'delta', text: 'Here is **sea ice**.' })
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getMessages()).toHaveLength(2))
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('idle'))
    expect(getImmersiveVoiceState()?.caption).toBe('Here is sea ice.')
  })

  it('ends the turn quietly when nothing was heard', async () => {
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: '' }))
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getImmersiveVoiceState()).toEqual({ phase: 'idle', caption: '' }))
    expect(getMessages()).toHaveLength(0)
  })

  it('reports a recognition error on the HUD for a moment', async () => {
    registerSttEngine({
      provider: 'local',
      supportsLanguage: () => true,
      isAvailable: () => true,
      start: (opts) => {
        queueMicrotask(() => { opts.onError(new Error('not-allowed')); opts.onEnd() })
        return { stop: () => {} }
      },
    })
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('error'))
    expect(getImmersiveVoiceState(Date.now() + 60_000)?.phase).toBe('idle')
  })

  it('can try again after an engine that fails inside start()', () => {
    // The browser engine reports the error and ends before start()
    // returns when `rec.start()` throws. The session it then hands back
    // is already over, and must not be kept as the live one.
    const start = vi.fn((opts: SttStartOptions) => {
      opts.onError(new Error('not-allowed'))
      opts.onEnd()
      return { stop: () => {} }
    })
    registerSttEngine({ provider: 'local', supportsLanguage: () => true, isAvailable: () => true, start })
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    expect(getImmersiveVoiceState()?.phase).toBe('error')
    toggleImmersiveVoice()
    toggleImmersiveVoice()
    expect(start).toHaveBeenCalledTimes(3)
    expect(getImmersiveVoiceState()?.phase).toBe('error')
  })

  it('stops speaking when the mic is tapped mid-reply', async () => {
    let finish: () => void = () => {}
    const tts = fakeTts([])
    tts.speak = () => new Promise<void>((resolve) => { finish = resolve })
    tts.cancel.mockImplementation(() => finish())
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'tell me about El Niño' }))
    registerTtsEngine(tts)
    await replyWith({ type: 'delta', text: 'El Niño warms the Pacific. It shifts rainfall worldwide.' })
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('speaking'))
    toggleImmersiveVoice()
    expect(tts.cancel).toHaveBeenCalled()
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('idle'))
  })

  it('goes back to thinking when speech is stopped while the reply is still streaming', async () => {
    // Sentences are spoken as they arrive, so the stop tap can land
    // before the model has finished — here the stream stays open after
    // two sentences.
    const { processMessage } = await import('../services/docentService')
    let release: () => void = () => {}
    vi.mocked(processMessage).mockImplementation(async function* () {
      yield { type: 'delta' as const, text: 'El Niño warms the Pacific. It shifts rainfall worldwide.' }
      await new Promise<void>((r) => { release = r })
      yield { type: 'delta' as const, text: ' It also weakens the trade winds.' }
      yield { type: 'done' as const, fallback: false }
    })
    let finish: () => void = () => {}
    const spoken: string[] = []
    const tts = fakeTts(spoken)
    tts.speak = (text: string) => {
      spoken.push(text)
      return new Promise<void>((resolve) => { finish = resolve })
    }
    tts.cancel.mockImplementation(() => finish())
    const stt = createFakeSttEngine({ provider: 'local', transcript: 'tell me about El Niño' })
    const start = vi.spyOn(stt, 'start')
    registerSttEngine(stt)
    registerTtsEngine(tts)
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    await until(() => getImmersiveVoiceState()?.phase === 'speaking', 'Orbit speaking the first sentence')
    toggleImmersiveVoice()
    expect(tts.cancel).toHaveBeenCalled()
    // Silenced, but the reply is still on its way: there is nothing
    // left to stop, and a new question can't start yet either.
    expect(getImmersiveVoiceState()?.phase).toBe('thinking')
    toggleImmersiveVoice()
    expect(getImmersiveVoiceState()?.phase).toBe('thinking')
    expect(start).toHaveBeenCalledTimes(1)

    release()
    await until(() => getImmersiveVoiceState()?.phase === 'idle', 'the turn ended with the stream')
    expect(spoken).toEqual(['El Niño warms the Pacific.'])
  })

  it('keeps a HUD turn alive when the reply it interrupted finishes draining', async () => {
    // A panel reply is still being read aloud when the HUD mic is
    // tapped — asked in 2D, then entered VR while Orbit was talking.
    let finish: () => void = () => {}
    const tts = fakeTts([])
    const speak = vi.fn<(text: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
      .mockResolvedValue(undefined)
    tts.speak = speak
    tts.cancel.mockImplementation(() => finish())
    registerSttEngine(heldSttEngine('show me sea ice'))
    registerTtsEngine(tts)
    saveConfig({ ...loadConfig(), voiceAutoSpeak: true })
    await replyWith({ type: 'delta', text: 'Oceans cover most of the planet.' })
    const cb = makeCallbacks()
    initChatUI(cb)
    sendFromPanel('tell me about the oceans')
    await until(() => speak.mock.calls.length === 1, 'the panel reply being read aloud')

    toggleImmersiveVoice()
    expect(getImmersiveVoiceState()?.phase).toBe('listening')
    // The barge-in cancelled the old speech; its turn restores the
    // ducked audio when that drains, and must end nothing else.
    await until(() => audioRestored(cb), 'the old reply drained')
    expect(getImmersiveVoiceState()?.phase).toBe('listening')

    // So the turn is still the HUD's: its reply's Load is carried out.
    await replyWith({ type: 'delta', text: 'Sea ice is a good fit.' }, LOAD_ICE)
    toggleImmersiveVoice()
    await until(() => sendsFinished(cb) === 2, 'the HUD turn finished')
    expect(cb.onLoadDataset.mock.calls).toEqual([['DS_ICE']])
  })

  it('stops listening without sending when the immersive session ends', async () => {
    const held = heldSttEngine('hello')
    const sessionEnded = vi.fn()
    registerSttEngine({
      ...held,
      start: (opts) => held.start({ ...opts, onEnd: () => { opts.onEnd(); sessionEnded() } }),
    })
    initChatUI(makeCallbacks())
    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.caption).toBe('hello'))
    endImmersiveVoice()
    expect(getImmersiveVoiceState()).toEqual({ phase: 'idle', caption: '' })
    // The session committed "hello" and ran to its end — the point
    // where a transcript is normally sent.
    expect(sessionEnded).toHaveBeenCalledTimes(1)
    // Left in the input for the 2D user to send or discard.
    expect(getMessages()).toHaveLength(0)
    expect((document.getElementById('chat-input') as HTMLTextAreaElement).value).toBe('hello')
  })

  /** A HUD question whose reply is held back until `release()`. */
  async function askWithReplyHeld(text: string): Promise<{ cb: MockCallbacks; spoken: string[]; release: () => void }> {
    const { processMessage } = await import('../services/docentService')
    let release: () => void = () => {}
    vi.mocked(processMessage).mockImplementation(async function* () {
      await new Promise<void>((r) => { release = r })
      yield { type: 'delta' as const, text }
      yield { type: 'done' as const, fallback: false }
    })
    const spoken: string[] = []
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'show me sea ice' }))
    registerTtsEngine(fakeTts(spoken))
    const cb = makeCallbacks()
    initChatUI(cb)
    toggleImmersiveVoice()
    await until(() => getImmersiveVoiceState()?.phase === 'thinking', 'the question was sent')
    return { cb, spoken, release: () => release() }
  }

  it('does not read the reply aloud in 2D when the session ends mid-reply with auto-speak off', async () => {
    const { cb, spoken, release } = await askWithReplyHeld('Here is sea ice.')
    expect(loadConfig().voiceAutoSpeak).toBe(false)

    endImmersiveVoice()
    release()
    await until(() => audioRestored(cb), 'the turn drained')
    // The reply still lands in the chat; auto-speak governs the panel.
    expect(getMessages()[1]?.text).toBe('Here is sea ice.')
    expect(spoken).toEqual([])
  })

  it('keeps reading the reply when the session ends mid-reply with auto-speak on', async () => {
    saveConfig({ ...loadConfig(), voiceAutoSpeak: true })
    const { cb, spoken, release } = await askWithReplyHeld('Here is sea ice.')

    endImmersiveVoice()
    release()
    await until(() => audioRestored(cb), 'the turn drained')
    expect(spoken).toEqual(['Here is sea ice.'])
  })

  it('ignores a tap while Orbit is still thinking', async () => {
    const { processMessage } = await import('../services/docentService')
    let release: () => void = () => {}
    vi.mocked(processMessage).mockImplementation(async function* () {
      await new Promise<void>((r) => { release = r })
      yield { type: 'done' as const, fallback: false }
    })
    registerSttEngine(createFakeSttEngine({ provider: 'local', transcript: 'show me sea ice' }))
    saveConfig({ ...loadConfig(), voiceAutoSpeak: false })
    initChatUI(makeCallbacks())

    toggleImmersiveVoice()
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('thinking'))
    toggleImmersiveVoice()
    expect(getImmersiveVoiceState()?.phase).toBe('thinking')
    release()
    await vi.waitFor(() => expect(getImmersiveVoiceState()?.phase).toBe('idle'))
  })
})
