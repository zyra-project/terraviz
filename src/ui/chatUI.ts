/**
 * Chat UI — digital docent chat panel.
 *
 * Floating panel in the bottom-left with a trigger button.
 * Streams LLM responses token-by-token, falls back to local engine.
 * Persists conversation in sessionStorage, config in localStorage.
 */

import type { ChatMessage, ChatAction, ChatSession, DocentConfig, MapViewContext, ReadingLevel, FeedbackRating, FeedbackPayload } from '../types'
import type { Dataset } from '../types'
import { escapeHtml, escapeAttr } from './domUtils'
import { createMessageId } from '../services/docentEngine'
import { processMessage, loadConfig, loadConfigWithKey, saveConfig, testConnection, getDefaultConfig, isLocalDev, IS_TAURI, captureViewContext } from '../services/docentService'
import {
  getDegradedReason,
  subscribe as subscribeDegraded,
  type DegradedReason,
} from '../services/docentDegradedState'
import { captureGlobeScreenshot } from '../services/screenshotService'
import { ensureLoaded as ensureQALoaded } from '../services/qaService'
import { fetchModels } from '../services/llmProvider'
import { isAvailable as isAppleIntelligenceAvailable } from '../services/appleIntelligenceProvider'
import { setLogLevel, logger } from '../utils/logger'
import { emit, startDwell, type DwellHandle } from '../analytics'
import { enMessages, t, getLocale, type MessageKey } from '../i18n'
import { resolveSttEngine, resolveTtsEngine, resolveStreamingSttEngine, voiceSupportForLocale, splitIntoSpokenChunks, baseLanguage, listVoiceLanguageOptions, type SttSession, type TtsEngine } from '../services/voiceService'
import { HandsFreeController } from './voiceHandsFree'
import { registerBrowserVoiceEngines, primeBrowserTts, listBrowserVoices, curateVoices, onBrowserVoicesChanged } from '../services/voiceBrowserEngines'
import { registerCloudVoiceEngines } from '../services/voiceCloudEngines'

// --- Constants ---
const SESSION_STORAGE_KEY = 'sos-docent-chat'
const CHAT_OPENED_KEY = 'sos-docent-seen'
const MAX_MESSAGES = 200
const MAX_PERSISTED_MESSAGES = 100

export interface ChatCallbacks {
  onLoadDataset: (id: string) => void
  onFlyTo: (lat: number, lon: number, altitude?: number) => void
  onSetTime: (isoDate: string) => { success: boolean; message: string }
  /**
   * Side-effect-free predicate: would `onSetTime(isoDate)` succeed
   * right now? Used to surface set-time failures inline the moment
   * the action streams in, rather than waiting for the deferred
   * execution after a load-dataset click. Returning `null` means
   * the host doesn't support eager checks — the SPA just renders
   * the optimistic "Seeking to X" status as before.
   */
  canSetTime?: (isoDate: string) => { ok: true } | { ok: false; message: string }
  onFitBounds: (bounds: [number, number, number, number], label?: string) => void
  onAddMarker: (lat: number, lng: number, label?: string) => void
  onToggleLabels: (visible: boolean) => void
  onHighlightRegion: (geojson: GeoJSON.GeoJSON, label?: string) => void
  getMapViewContext: () => MapViewContext | null
  getDatasets: () => Dataset[]
  getCurrentDataset: () => Dataset | null
  announce: (message: string) => void
  onOpenBrowse?: () => void
  /**
   * Phase 3pg/C — load a single frame from an image-sequence
   * dataset. `frameQuery` is the verbatim payload from the
   * `<<LOAD_FRAME:DATASET_ID:query>>` marker; the host resolves it
   * via `resolveFrameQuery` (or by calling the `/frames` endpoint)
   * before rendering. Optional — chat UIs running against a host
   * that doesn't ship the frame loader can leave it unbound, in
   * which case frame-load buttons silently no-op.
   */
  onLoadFrame?: (datasetId: string, frameQuery: string) => void
  /**
   * Phase 3 hands-free — duck the loaded dataset's audio (the HLS
   * `<video>`, when the user has unmuted it) while a voice turn is
   * active, restoring it afterward. Prevents the mic transcribing
   * dataset audio and TTS competing with it (§9.1). Optional; a host
   * without dataset audio can leave it unbound.
   */
  onVoiceAudioFocus?: (active: boolean) => void
}

let callbacks: ChatCallbacks | null = null
let messages: ChatMessage[] = []
let isOpen = false
let isStreaming = false
let settingsOpen = false
let datasetPromptTimer: ReturnType<typeof setTimeout> | null = null
/** Tier B dwell handle for the chat panel — non-null while the
 * panel is open. Started in openChat(), stopped in closeChat().
 * Tier-gated at emit time by the dwell helper, so wiring is
 * unconditional here. */
let chatDwellHandle: DwellHandle | null = null
/** Wall-clock at which the most recent user message was sent —
 * used to compute `orbit_load_followed.latency_ms` when the user
 * later clicks an inline load button in the docent's reply. */
let lastUserSendAt: number | null = null

/** Active speech-recognition session, or null when not listening (ORBIT_VOICE_PLAN §1). */
let sttSession: SttSession | null = null
/** Release handle for the `voiceschanged` subscription (re-init safe). */
let voicesUnsub: (() => void) | null = null
/** Set when a send terminates listening, so the session's `onEnd` doesn't re-send. */
let sttSuppressAutoSend = false

/** TTS (auto-speak) state for the in-flight reply (ORBIT_VOICE_PLAN §1.1, §2). */
let ttsEngine: TtsEngine | null = null
let spokenChunkCount = 0
let ttsChain: Promise<void> = Promise.resolve()
let speakingActive = false
let ttsTrigger: 'autospeak' | 'replay' = 'autospeak'
let ttsEmitted = false
/** Monotonic id bumped when a new speaking session begins. Queued
 * `ttsChain` callbacks capture it and bail if a newer session has
 * started — otherwise a prior reply's pending promise could hide the
 * Stop control or enqueue speech into the current session. */
let ttsSessionId = 0

/** Globe-control actions deferred until a load-dataset action in the same message completes. */
let pendingGlobeActions: ChatAction[] = []

/** Tracks dataset load actions clicked per message (implicit positive feedback). */
const actionClickMap = new Map<string, string[]>()

/** Phase 1f/I — held across initChatUI calls so a re-init (test
 * teardown / hot reload) releases the prior listener instead of
 * accumulating them. Production calls initChatUI exactly once at
 * boot, so this is purely defensive. */
let degradedUnsubscribe: (() => void) | null = null

/**
 * Initialize the chat UI with callbacks and restore session.
 */
export function initChatUI(cb: ChatCallbacks): void {
  callbacks = cb
  restoreSession()
  wireEvents()
  initVoiceInput()
  renderMessages()
  // Apply the persisted debug-prompt setting now, at boot — not just
  // when the settings panel is first opened. Otherwise the checkbox
  // shows as on but the log level stays at the bundle default until
  // the user toggles the box.
  setLogLevel(loadConfig().debugPrompt ? 'debug' : null)
  // Collapse trigger to icon-only if user has opened chat before
  if (localStorage.getItem(CHAT_OPENED_KEY)) {
    document.getElementById('chat-trigger')?.classList.add('collapsed')
  }
  // Phase 1f/D — render an initial degraded badge if the docent
  // already detected quota exhaustion before the chat UI booted
  // (e.g. when the disclosure banner triggered an early search),
  // and keep it in sync with state changes for the session. Release
  // any prior subscription first so a re-init doesn't double-listen.
  renderDegradedBadge(getDegradedReason())
  degradedUnsubscribe?.()
  degradedUnsubscribe = subscribeDegraded(state =>
    renderDegradedBadge(state.reason),
  )
}

/**
 * Inject / refresh the "Reduced functionality" badge inside the
 * chat panel. Idempotent — repeated calls update the existing
 * element rather than appending duplicates.
 */
function renderDegradedBadge(reason: DegradedReason | null): void {
  const panel = document.getElementById('chat-panel')
  if (!panel) return
  let badge = document.getElementById('chat-degraded-badge') as HTMLDivElement | null
  if (reason === null) {
    badge?.remove()
    return
  }
  if (!badge) {
    badge = document.createElement('div')
    badge.id = 'chat-degraded-badge'
    badge.className = 'chat-degraded-badge'
    badge.setAttribute('role', 'status')
    badge.setAttribute('aria-live', 'polite')
    panel.prepend(badge)
  }
  badge.textContent = degradedBadgeText(reason)
}

function degradedBadgeText(reason: DegradedReason): string {
  switch (reason) {
    case 'quota_exhausted':
      // Phase 1f/I — text matches the state's actual semantics. The
      // SPA only flips this reason in response to a Workers AI 4006
      // (quota *exhausted*, not "approaching"). The earlier
      // "approaching limit" copy implied a softer state than the
      // server signals.
      return t('chat.degraded.quotaExhausted')
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
  if (!isOpen && !chatDwellHandle) {
    chatDwellHandle = startDwell('chat')
  }
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
  callbacks?.announce(t('chat.announce.opened'))
}

/**
 * Open the chat panel and expand the Orbit settings form. Called from
 * the Tools menu as an external entry point — the chat panel has to
 * be open for the inline `#chat-settings` form to be visible in the
 * first place, so we open both in sequence. If settings is already
 * expanded, this just ensures the chat panel is visible.
 */
export function openChatSettings(): void {
  openChat()
  if (!settingsOpen) {
    toggleSettings()
  } else {
    populateSettings().catch(err => logger.warn('[Chat] Failed to populate settings:', err))
  }
  // Scroll the settings panel into view (it's at the top of the chat body)
  const panel = document.getElementById('chat-settings')
  panel?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

/**
 * Close the chat panel.
 */
export function closeChat(): void {
  const panel = document.getElementById('chat-panel')
  const trigger = document.getElementById('chat-trigger')
  const browseChatBtn = document.getElementById('browse-chat-btn')
  if (!panel) return
  if (chatDwellHandle) {
    chatDwellHandle.stop()
    chatDwellHandle = null
  }
  isOpen = false
  panel.classList.add('hidden')
  trigger?.classList.remove('chat-trigger-active')
  trigger?.setAttribute('aria-expanded', 'false')
  browseChatBtn?.classList.remove('chat-trigger-active')
  if (settingsOpen) toggleSettings()
  callbacks?.announce(t('chat.announce.closed'))
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
    // Find the rendered status span for THIS action. The eager
    // dry-check at stream time may have stamped an `error` on
    // the action and rendered it with failure styling; if the
    // deferred execution now succeeds (user loaded a different
    // time-enabled dataset), the stale error styling has to clear,
    // and the underlying action's `error` field has to come off
    // so a re-render (panel close + reopen) doesn't flash the
    // failure state again.
    //
    // Match by ISO date substring across status spans — the
    // optimistic "Seeking to {date}" badge embeds it, and the
    // dry-check failure messages do too for date-out-of-range
    // cases. For "no dataset loaded" failures the date isn't in
    // the badge text, so substring match miss is acceptable: the
    // execution path can only succeed once a dataset IS loaded,
    // at which point the badge text will have been re-rendered
    // through the action's updated `error`-cleared state.
    const statusEls = document.querySelectorAll('.chat-action-status')
    if (!result.success) {
      callbacks.announce(result.message)
      action.error = result.message
      for (const el of statusEls) {
        if (el.textContent?.includes(action.isoDate) || el.textContent === action.error) {
          el.textContent = result.message
          el.classList.add('chat-action-status-err')
        }
      }
    } else {
      // Successful execution clears any prior eager-dry-check
      // error stamp so the action persists clean in message
      // history (and re-renders without the failure styling).
      delete action.error
      const seeking = t('chat.action.seekingTo', { date: action.isoDate })
      for (const el of statusEls) {
        if (
          el.classList.contains('chat-action-status-err')
          && el.textContent?.includes(action.isoDate)
        ) {
          el.classList.remove('chat-action-status-err')
          el.textContent = seeking
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
  const micBtn = document.getElementById('chat-mic')
  micBtn?.addEventListener('click', toggleListening)
  // Push-to-talk: capture only while the mic is held down. Pointer
  // events cover mouse, touch and pen; `pointerup`/`leave`/`cancel`
  // all release so a turn can't get stuck capturing.
  micBtn?.addEventListener('pointerdown', () => {
    if ((loadConfig().voiceHandsFree ?? 'off') !== 'push-to-talk') return
    primeBrowserTts()
    void handsFree?.press()
  })
  const releasePtt = (): void => {
    if ((loadConfig().voiceHandsFree ?? 'off') === 'push-to-talk') handsFree?.release()
  }
  micBtn?.addEventListener('pointerup', releasePtt)
  micBtn?.addEventListener('pointerleave', releasePtt)
  micBtn?.addEventListener('pointercancel', releasePtt)
  document.getElementById('chat-stop-speaking')?.addEventListener('click', () => {
    // Only a barge-in if speech was actually produced — Stop clicked
    // before the first chunk speaks shouldn't count (§10.4).
    const wasSpeaking = ttsEmitted
    stopSpeaking()
    // Hands-free interrupt: don't just stop Orbit's voice — hand the
    // turn back to the user immediately by resuming the mic and
    // restoring dataset audio, rather than waiting for the cancelled
    // reply to drain. (§9.1 "Stop speaking" → "interrupt".)
    if ((loadConfig().voiceHandsFree ?? 'off') !== 'off') {
      if (wasSpeaking) emitBargeIn() // a real reply was cut short (§10.4)
      handsFree?.setBusy(false)
      setVoiceAudioFocus(false)
    }
    callbacks?.announce(t('chat.announce.voiceStopped'))
  })
  // Enabling auto-speak is a user gesture — prime iOS TTS here so the
  // very next reply can be spoken without waiting for another tap.
  document.getElementById('chat-settings-voice-autospeak')?.addEventListener('change', (e) => {
    if ((e.target as HTMLInputElement | null)?.checked) primeBrowserTts()
  })
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
    callbacks?.announce(t('chat.announce.cleared'))
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
      callbacks?.announce(t(config.visionEnabled ? 'chat.announce.visionEnabled' : 'chat.announce.visionDisabled'))
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

// --- Voice input (STT) — ORBIT_VOICE_PLAN.md Phase 1 ---

/**
 * Register the browser speech engines this runtime supports and
 * reveal the mic button when STT is actually available for the
 * active locale. No-op (button stays hidden) otherwise, so the
 * typed experience is unchanged where voice can't run.
 */
function initVoiceInput(): void {
  registerBrowserVoiceEngines()
  // Cloud engines register too but are opt-in (provider=cloud) — `auto`
  // never picks them; web-only (no /api proxy in the desktop shell).
  registerCloudVoiceEngines()
  updateMicVisibility()
  populateVoiceOptions()
  // System voices load asynchronously — refresh the picker when they
  // arrive. Release any prior subscription first so a re-init (hot
  // reload / tests) doesn't accumulate duplicate listeners.
  voicesUnsub?.()
  voicesUnsub = onBrowserVoicesChanged(populateVoiceOptions)
  // Phase 3 hands-free: bridge the realtime session to the input/send
  // path. Inert until the user opts into a mode and a streaming engine
  // resolves. Recreated on re-init (idempotent teardown).
  handsFree?.teardown()
  handsFree = new HandsFreeController({
    onPartial: (text) => fillVoiceInput(text),
    onTurn: (text) => { emitHandsFreeTurn(text); fillVoiceInput(text); void handleSend() },
    onStateChange: (state) => {
      setMicListening(state === 'capturing' || state === 'listening')
      // Duck dataset audio the moment we start capturing a turn (kept
      // ducked through send + reply; released at the resume point).
      if (state === 'capturing') { handsFreeCaptureStartedAt = Date.now(); setVoiceAudioFocus(true) }
    },
  })
  syncHandsFree()
}

/** Module-level hands-free controller (null until init). */
let handsFree: HandsFreeController | null = null

/** Whether dataset audio is currently ducked for a voice turn. */
let voiceAudioFocused = false

/** Wall-clock start of the current hands-free capture, for turn latency. */
let handsFreeCaptureStartedAt = 0

/**
 * Tier B: record a completed hands-free STT turn — provider, language,
 * latency, and which interaction model (`open-mic` vs `push-to-talk`).
 * These are the §10.4 numbers that decide the exhibit's interaction
 * model. No transcript text leaves the device.
 */
function emitHandsFreeTurn(transcript: string): void {
  const cfg = loadConfig()
  const mode = cfg.voiceHandsFree ?? 'off'
  if (mode === 'off') return
  const lang = cfg.voiceLang || getLocale()
  const provider = resolveStreamingSttEngine(cfg.voiceProvider ?? 'auto', lang)?.provider ?? 'browser'
  emit({
    event_type: 'voice_interaction',
    mode: 'stt',
    provider,
    trigger: mode, // 'open-mic' | 'push-to-talk'
    duration_ms: handsFreeCaptureStartedAt ? Math.max(0, Date.now() - handsFreeCaptureStartedAt) : 0,
    lang: baseLanguage(lang),
    // An empty final transcript (the streaming engine can emit one) is
    // not a successful turn — derive success from real text.
    success: transcript.trim().length > 0,
  })
}

/**
 * Tier B: record a hands-free barge-in — the user interrupted Orbit's
 * spoken reply. Drives the barge-in-frequency metric (§10.4).
 */
function emitBargeIn(): void {
  const lang = loadConfig().voiceLang || getLocale()
  emit({
    event_type: 'voice_interaction',
    mode: 'tts',
    // The reply that was cut short — use the engine/trigger that were
    // actually speaking, not a fresh re-resolve.
    provider: ttsEngine?.provider ?? 'browser',
    trigger: ttsTrigger, // 'autospeak' | 'replay'
    duration_ms: 0,
    lang: baseLanguage(lang),
    // TTS *had* started (success = "TTS started"); `interrupted` is what
    // marks the barge-in. Caller only emits this once speech was produced.
    success: true,
    interrupted: true,
  })
}

/** Duck / restore the dataset audio for a voice turn (deduped). */
function setVoiceAudioFocus(active: boolean): void {
  if (voiceAudioFocused === active) return
  voiceAudioFocused = active
  callbacks?.onVoiceAudioFocus?.(active)
}

/** Fill the chat input with a (partial or final) transcript, resizing. */
function fillVoiceInput(text: string): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  if (!input) return
  input.value = text
  input.style.height = 'auto'
  input.style.height = Math.min(input.scrollHeight, 96) + 'px'
}

/** (Re)configure the hands-free controller from the current config. */
function syncHandsFree(): void {
  const cfg = loadConfig()
  handsFree?.sync({
    mode: cfg.voiceHandsFree ?? 'off',
    lang: cfg.voiceLang || getLocale(),
    provider: cfg.voiceProvider ?? 'auto',
  })
  // If hands-free ended up inactive (turned off, or no streaming engine
  // resolved), make sure any ducking from a prior turn is released — the
  // send/drain path that normally un-ducks may never run again.
  if (!handsFree?.isActive()) {
    setMicListening(false)
    setVoiceAudioFocus(false)
  }
}

/** Show the mic only when an STT engine resolves for the active locale (§3 matrix). */
function updateMicVisibility(): void {
  const btn = document.getElementById('chat-mic')
  if (!btn) return
  const cfg = loadConfig()
  const support = voiceSupportForLocale(cfg.voiceLang || getLocale(), cfg.voiceProvider ?? 'auto')
  btn.style.display = support.stt ? 'flex' : 'none'
}

/**
 * Fill the settings Voice picker with the system TTS voices,
 * preferring those that match the active language. Voices load
 * asynchronously, so this re-runs on `voiceschanged`.
 */
function populateVoiceOptions(): void {
  const select = document.getElementById('chat-settings-voice-name') as HTMLSelectElement | null
  if (!select) return
  const cfg = loadConfig()
  const lang = baseLanguage(cfg.voiceLang || getLocale())
  // Curate first (drop Apple novelty voices, sort best-first), then
  // prefer voices for the active language, falling back to all.
  const all = curateVoices(listBrowserVoices())
  const matching = all.filter(v => baseLanguage(v.lang) === lang)
  const voices = matching.length ? matching : all
  const selected = cfg.voiceName ?? ''
  const defaultLabel = t('chat.settings.voiceName.default')
  select.innerHTML = ''
  const defaultOpt = document.createElement('option')
  defaultOpt.value = ''
  defaultOpt.textContent = defaultLabel
  select.appendChild(defaultOpt)
  for (const v of voices) {
    const opt = document.createElement('option')
    opt.value = v.name
    opt.textContent = `${v.name} (${v.lang})` // i18n-exempt: system voice id + BCP-47 tag
    select.appendChild(opt)
  }
  select.value = selected
}

/**
 * Fill the recognition-language override picker. "Same as app" (value
 * "") keeps voice tracking the UI locale; the rest are the BCP-47
 * languages the voice stack can name (§8 Phase 3), labelled in the
 * active locale via `Intl.DisplayNames` so no per-language i18n keys
 * are needed. Selecting one decouples spoken language from UI locale.
 */
function populateVoiceLanguageOptions(): void {
  const select = document.getElementById('chat-settings-voice-lang') as HTMLSelectElement | null
  if (!select) return
  const cfg = loadConfig()
  const defaultLabel = t('chat.settings.voiceLang.auto')
  let names: Intl.DisplayNames | null = null
  try {
    names = new Intl.DisplayNames([getLocale()], { type: 'language' })
  } catch { /* DisplayNames unsupported — fall back to the raw tag */ }
  select.innerHTML = ''
  const defaultOpt = document.createElement('option')
  defaultOpt.value = ''
  defaultOpt.textContent = defaultLabel
  select.appendChild(defaultOpt)
  for (const code of listVoiceLanguageOptions()) {
    const opt = document.createElement('option')
    opt.value = code
    opt.textContent = names?.of(code) ?? code // i18n-exempt: localized via Intl.DisplayNames or raw BCP-47 tag
    select.appendChild(opt)
  }
  select.value = cfg.voiceLang ?? ''
}

function toggleListening(): void {
  // The mic tap is a user gesture — prime iOS TTS now so a
  // voice-initiated reply (which auto-sends later, off-gesture) can
  // still be spoken aloud.
  primeBrowserTts()
  const mode = loadConfig().voiceHandsFree ?? 'off'
  // Open-mic: the mic button is a mute toggle for the always-on session.
  // Don't set the indicator here — unmute arms asynchronously and can
  // fail (permission denied); the controller's state-change hook drives
  // setMicListening so the UI never gets stuck showing "listening".
  if (mode === 'open-mic' && handsFree?.isActive()) {
    const muted = handsFree.toggleMute()
    callbacks?.announce(t(muted ? 'chat.announce.voiceMuted' : 'chat.announce.voiceListening'))
    return
  }
  // Push-to-talk is driven by pointer down/up (see wireEvents) — but
  // only when a hands-free session is actually live. If none resolved,
  // fall through to the Phase 1 single-tap path so the mic still works.
  if (mode === 'push-to-talk' && handsFree?.isActive()) return
  // Phase 1 single-tap path.
  if (sttSession) stopListening()
  else startListening()
}

function startListening(): void {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  if (!input || isStreaming) return
  // Barge-in: never capture while Orbit is speaking, or the mic would
  // transcribe its own TTS (echo / self-trigger). (§9.1)
  stopSpeaking()
  const cfg = loadConfig()
  const lang = cfg.voiceLang || getLocale()
  const engine = resolveSttEngine(cfg.voiceProvider ?? 'auto', lang)
  if (!engine) {
    callbacks?.announce(t('chat.announce.voiceError'))
    return
  }
  sttSuppressAutoSend = false
  let sawFinal = false
  let sttError = false
  const startedAt = Date.now()
  const provider = engine.provider
  const langBase = baseLanguage(lang)
  setMicListening(true)
  callbacks?.announce(t('chat.announce.voiceListening'))
  sttSession = engine.start({
    lang,
    interim: true,
    // Fill the input live so the user sees what's being heard and
    // can edit before it sends (conversational repair, §9.2).
    onResult: (result) => {
      input.value = result.transcript
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 96) + 'px'
      if (result.isFinal) sawFinal = true
    },
    onError: (err) => {
      logger.warn('[voice] STT error', err)
      sttError = true
      endListening()
      callbacks?.announce(t('chat.announce.voiceError'))
    },
    onEnd: () => {
      const hadFinal = sawFinal
      const suppressed = sttSuppressAutoSend
      sttSuppressAutoSend = false
      endListening()
      // Tier B: no transcript text — only provider/lang/duration/success.
      emit({
        event_type: 'voice_interaction',
        mode: 'stt',
        provider,
        trigger: 'mic',
        duration_ms: Math.max(0, Date.now() - startedAt),
        lang: langBase,
        success: hadFinal && !sttError,
      })
      // Auto-send on a committed transcript (push-to-talk turn) —
      // unless an error was reported (could be partial/wrong) or a
      // manual send already terminated this session.
      if (hadFinal && !sttError && !suppressed && input.value.trim()) void handleSend()
    },
  })
}

/** Stop capture; the engine's `onEnd` resets the UI (and may auto-send). */
function stopListening(): void {
  sttSession?.stop()
}

function endListening(): void {
  sttSession = null
  setMicListening(false)
}

function setMicListening(on: boolean): void {
  const btn = document.getElementById('chat-mic')
  if (!btn) return
  btn.classList.toggle('listening', on)
  btn.setAttribute('aria-pressed', String(on))
  btn.title = on ? t('chat.voice.titleListening') : t('chat.voice.title')
}

// --- Voice output (TTS auto-speak) — ORBIT_VOICE_PLAN.md §1.1, §2 ---

/**
 * Start a fresh speaking session for a reply. Cancels any prior
 * speech, then resolves a TTS engine only when auto-speak is on and
 * one is available for the active locale. No engine → stays silent.
 */
function beginSpeaking(): void {
  stopSpeaking()
  ttsSessionId++
  const cfg = loadConfig()
  if (!cfg.voiceAutoSpeak) { ttsEngine = null; return }
  // Runs in the send-click / Enter gesture task — unlock iOS audio
  // before the (later, async) real speech fires.
  primeBrowserTts()
  ttsEngine = resolveTtsEngine(cfg.voiceProvider ?? 'auto', cfg.voiceLang || getLocale())
  spokenChunkCount = 0
  speakingActive = !!ttsEngine
  ttsTrigger = 'autospeak'
  ttsEmitted = false
  if (speakingActive) setStopSpeakingVisible(true)
}

/**
 * Emit the Tier B `voice_interaction` (TTS) event once per speaking
 * session, the first time speech is actually produced. No text or
 * audio — only provider / language / trigger. (ORBIT_VOICE_PLAN §6)
 */
function emitTtsOnce(): void {
  if (ttsEmitted || !ttsEngine) return
  ttsEmitted = true
  emit({
    event_type: 'voice_interaction',
    mode: 'tts',
    provider: ttsEngine.provider,
    trigger: ttsTrigger,
    duration_ms: 0,
    lang: baseLanguage(loadConfig().voiceLang || getLocale()),
    success: true,
  })
}

/**
 * Enqueue any newly-complete sentences for speech. Reads the
 * spoken-form projection of the full message so far (markers /
 * markdown / URLs stripped) and queues sentences past the cursor.
 * While streaming, the last (possibly partial) sentence is held
 * back; `final` flushes it. (§1.1 projection, §2 sentence-chunking)
 */
function pumpSpeech(fullText: string, final: boolean): void {
  if (!speakingActive || !ttsEngine) return
  const session = ttsSessionId
  const sentences = splitIntoSpokenChunks(fullText)
  const upto = final ? sentences.length : Math.max(0, sentences.length - 1)
  const cfg = loadConfig()
  const lang = cfg.voiceLang || getLocale()
  const rate = cfg.voiceRate
  const voice = cfg.voiceName
  const engine = ttsEngine
  for (let i = spokenChunkCount; i < upto; i++) {
    const sentence = sentences[i]
    if (!sentence) continue
    emitTtsOnce()
    ttsChain = ttsChain.then(() => (speakingActive && session === ttsSessionId ? engine.speak(sentence, { lang, rate, voice }) : undefined))
  }
  spokenChunkCount = Math.max(spokenChunkCount, upto)
  if (final) {
    // Hide the Stop control once the queued speech drains — but only
    // if this is still the active session.
    ttsChain = ttsChain.then(() => { if (speakingActive && session === ttsSessionId) setStopSpeakingVisible(false) })
  }
}

/** Stop speech immediately (Stop control / barge-in / new reply). */
function stopSpeaking(): void {
  speakingActive = false
  ttsEngine?.cancel()
  ttsChain = Promise.resolve()
  setStopSpeakingVisible(false)
}

function setStopSpeakingVisible(visible: boolean): void {
  const btn = document.getElementById('chat-stop-speaking')
  if (btn) btn.style.display = visible ? 'flex' : 'none'
}

/** Whether a TTS engine resolves for the active locale (gates the per-message Speak button). */
function canSpeakReplies(): boolean {
  const cfg = loadConfig()
  return !!resolveTtsEngine(cfg.voiceProvider ?? 'auto', cfg.voiceLang || getLocale())
}

/**
 * Speak a specific message on demand. The first chunk is spoken
 * **synchronously** so this works when invoked from a tap — iOS
 * Safari requires speech to originate inside a user gesture, which
 * the streamed auto-speak path (microtask-queued) can't guarantee.
 */
function speakMessage(text: string): void {
  const cfg = loadConfig()
  const engine = resolveTtsEngine(cfg.voiceProvider ?? 'auto', cfg.voiceLang || getLocale())
  if (!engine) return
  const chunks = splitIntoSpokenChunks(text)
  const first = chunks[0]
  if (!first) return
  stopSpeaking()
  ttsSessionId++
  const session = ttsSessionId
  speakingActive = true
  ttsEngine = engine
  ttsTrigger = 'replay'
  ttsEmitted = false
  emitTtsOnce()
  setStopSpeakingVisible(true)
  const lang = cfg.voiceLang || getLocale()
  const rate = cfg.voiceRate
  const voice = cfg.voiceName
  let chain = engine.speak(first, { lang, rate, voice })
  for (let i = 1; i < chunks.length; i++) {
    const sentence = chunks[i]
    if (!sentence) continue
    chain = chain.then(() => (speakingActive && session === ttsSessionId ? engine.speak(sentence, { lang, rate, voice }) : undefined))
  }
  ttsChain = chain.then(() => { if (speakingActive && session === ttsSessionId) setStopSpeakingVisible(false) })
}

function wireSpeakButtons(container: ParentNode): void {
  container.querySelectorAll<HTMLButtonElement>('.chat-speak-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = messages.find((m) => m.id === btn.dataset.msgId)
      if (!msg?.text) return
      primeBrowserTts()
      speakMessage(msg.text)
    })
  })
}

// --- Settings panel ---

function toggleSettings(): void {
  const panel = document.getElementById('chat-settings')
  if (!panel) return
  settingsOpen = !settingsOpen
  panel.classList.toggle('hidden', !settingsOpen)
  if (settingsOpen) {
    populateSettings().catch(err => logger.warn('[Chat] Failed to populate settings:', err))
  }
}

async function populateSettings(): Promise<void> {
  const config = await loadConfigWithKey()
  const urlInput = document.getElementById('chat-settings-url') as HTMLInputElement | null
  const keyInput = document.getElementById('chat-settings-key') as HTMLInputElement | null
  const enabledInput = document.getElementById('chat-settings-enabled') as HTMLInputElement | null
  const visionInput = document.getElementById('chat-settings-vision') as HTMLInputElement | null
  const debugInput = document.getElementById('chat-settings-debug') as HTMLInputElement | null
  const readingLevelSelect = document.getElementById('chat-settings-reading-level') as HTMLSelectElement | null
  if (urlInput) {
    urlInput.value = config.apiUrl
    if (IS_TAURI) urlInput.placeholder = t('chat.settings.url.tauri.placeholder')
  }
  if (keyInput) {
    keyInput.value = config.apiKey
    if (IS_TAURI) keyInput.placeholder = t('chat.settings.key.tauri.placeholder')
  }
  if (readingLevelSelect) readingLevelSelect.value = config.readingLevel
  if (enabledInput) enabledInput.checked = config.enabled
  if (visionInput) visionInput.checked = config.visionEnabled
  if (debugInput) debugInput.checked = config.debugPrompt ?? false
  const autospeakInput = document.getElementById('chat-settings-voice-autospeak') as HTMLInputElement | null
  if (autospeakInput) autospeakInput.checked = config.voiceAutoSpeak ?? false
  populateVoiceOptions()
  populateVoiceLanguageOptions()
  const providerSelect = document.getElementById('chat-settings-voice-provider') as HTMLSelectElement | null
  if (providerSelect) providerSelect.value = config.voiceProvider ?? 'auto'
  const handsFreeSelect = document.getElementById('chat-settings-voice-handsfree') as HTMLSelectElement | null
  if (handsFreeSelect) handsFreeSelect.value = config.voiceHandsFree ?? 'off'
  const rateSelect = document.getElementById('chat-settings-voice-rate') as HTMLSelectElement | null
  if (rateSelect) rateSelect.value = String(config.voiceRate ?? 1)
  // Apply saved debug log level on startup
  setLogLevel(config.debugPrompt ? 'debug' : null)
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

/**
 * Phase 4: prepend "Local (Apple Intelligence)" to a model select if available.
 * Works offline — the check goes through the Tauri plugin, not HTTP.
 */
function addAppleIntelligenceOption(select: HTMLSelectElement, selected: string): void {
  isAppleIntelligenceAvailable().then(available => {
    if (!available || !select) return
    if (Array.from(select.options).some(o => o.value === 'apple-intelligence')) return
    const opt = document.createElement('option')
    opt.value = 'apple-intelligence'
    opt.textContent = t('chat.settings.model.appleIntelligence')
    opt.selected = selected === 'apple-intelligence'
    select.insertBefore(opt, select.firstChild)
  }).catch(() => { /* not available, silently skip */ })
}

/** Fetch models from the API and populate the select, preserving the current selection. */
async function refreshModelSelect(apiUrl: string, preferredModel?: string): Promise<void> {
  const select = document.getElementById('chat-settings-model') as HTMLSelectElement | null
  if (!select) return

  const config = await loadConfigWithKey()
  const selected = preferredModel ?? select.value ?? config.model

  const models = await fetchModels({ ...config, apiUrl })

  select.innerHTML = ''
  if (models.length === 0) {
    // Fallback: keep the current value as a manual entry
    const opt = document.createElement('option')
    opt.value = selected
    opt.textContent = selected || t('chat.settings.model.noneFound')
    select.appendChild(opt)
    select.disabled = false
    // Still check for Apple Intelligence — it's local and works offline
    addAppleIntelligenceOption(select, selected)
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

  addAppleIntelligenceOption(select, selected)

  // Auto-persist the first model when config has none (e.g. fresh Tauri install)
  if (!selected && models.length > 0) {
    const cfg = loadConfig()
    cfg.model = models[0]
    saveConfig(cfg)
  }
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
  const autospeakInput = document.getElementById('chat-settings-voice-autospeak') as HTMLInputElement | null
  const voiceNameSelect = document.getElementById('chat-settings-voice-name') as HTMLSelectElement | null
  const voiceRateSelect = document.getElementById('chat-settings-voice-rate') as HTMLSelectElement | null
  const voiceProviderSelect = document.getElementById('chat-settings-voice-provider') as HTMLSelectElement | null
  const voiceLangSelect = document.getElementById('chat-settings-voice-lang') as HTMLSelectElement | null
  const handsFreeSelect = document.getElementById('chat-settings-voice-handsfree') as HTMLSelectElement | null
  const parsedRate = Number(voiceRateSelect?.value)
  // Carry forward voice config not exposed in this form so a save
  // doesn't wipe it.
  const current = loadConfig()
  const providerValue = voiceProviderSelect?.value
  const voiceProvider = providerValue === 'browser' || providerValue === 'cloud' || providerValue === 'auto'
    ? providerValue
    : current.voiceProvider
  // "" (Same as app) clears the override so voice tracks the UI locale.
  const voiceLang = voiceLangSelect ? (voiceLangSelect.value || undefined) : current.voiceLang
  const handsFreeValue = handsFreeSelect?.value
  const voiceHandsFree = handsFreeValue === 'push-to-talk' || handsFreeValue === 'open-mic' || handsFreeValue === 'off'
    ? handsFreeValue
    : current.voiceHandsFree
  return {
    apiUrl: urlInput?.value.trim() || defaults.apiUrl,
    apiKey: keyInput?.value.trim() ?? '',
    model: modelSelect?.value.trim() || defaults.model,
    readingLevel: isValidReadingLevel(readingLevelSelect?.value) ? readingLevelSelect!.value as ReadingLevel : defaults.readingLevel,
    enabled: enabledInput?.checked ?? defaults.enabled,
    visionEnabled: visionInput?.checked ?? defaults.visionEnabled,
    debugPrompt: debugInput?.checked ?? defaults.debugPrompt,
    voiceAutoSpeak: autospeakInput?.checked ?? current.voiceAutoSpeak,
    voiceProvider,
    voiceLang,
    voiceHandsFree,
    voiceName: voiceNameSelect ? (voiceNameSelect.value || undefined) : current.voiceName,
    voiceRate: Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : current.voiceRate,
  }
}

function handleSettingsSave(): void {
  const config = readSettingsForm()
  saveConfig(config, true)
  // Apply debug log level at runtime so production console shows all messages
  setLogLevel(config.debugPrompt ? 'debug' : null)
  // Keep vision toggle button + hint banner in sync with settings checkbox
  setVisionUI(config.visionEnabled)
  // Provider change can flip which engine resolves for the locale —
  // refresh mic visibility + the voice picker.
  updateMicVisibility()
  populateVoiceOptions()
  // Hands-free mode / language / provider may have changed — re-sync
  // the realtime session (creates, tears down, or re-arms as needed).
  syncHandsFree()
  const status = document.getElementById('chat-settings-status')
  if (status) {
    status.textContent = t('chat.settings.status.saved')
    status.className = 'chat-settings-status chat-settings-status-ok'
    setTimeout(() => { status.textContent = '' }, 2000)
  }
  callbacks?.announce(t('chat.announce.settingsSaved'))
}

async function handleSettingsTest(): Promise<void> {
  const config = readSettingsForm()
  // Apply debug level before testing so errors appear in console
  setLogLevel(config.debugPrompt ? 'debug' : null)
  const status = document.getElementById('chat-settings-status')
  const testBtn = document.getElementById('chat-settings-test') as HTMLButtonElement | null
  if (status) {
    status.textContent = t('chat.settings.status.testing')
    status.className = 'chat-settings-status'
  }
  if (testBtn) testBtn.disabled = true

  const result = await testConnection(config)

  if (status) {
    if (result.ok) {
      // Warn if connection works but the Enable checkbox is unchecked
      const enabledInput = document.getElementById('chat-settings-enabled') as HTMLInputElement | null
      if (enabledInput && !enabledInput.checked) {
        status.textContent = t('chat.settings.status.enableHint')
        status.className = 'chat-settings-status chat-settings-status-err'
      } else {
        status.textContent = t('chat.settings.status.connected')
        status.className = 'chat-settings-status chat-settings-status-ok'
      }
    } else {
      status.textContent = result.reason ?? t('chat.settings.status.failedToConnect')
      status.className = 'chat-settings-status chat-settings-status-err'
    }
    setTimeout(() => { status.textContent = '' }, 5000)
  }
  if (testBtn) testBtn.disabled = false
  callbacks?.announce(t(result.ok ? 'chat.announce.testSuccess' : 'chat.announce.testFailed'))
}

// --- Send / receive ---

async function handleSend(): Promise<void> {
  const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
  if (!input || !callbacks || isStreaming) return

  // Terminate any active listening first (regardless of how send was
  // triggered) so recognition can't keep mutating the input after we
  // read and clear it. Suppress the session's auto-send — this send
  // already commits the current transcript.
  if (sttSession) {
    sttSuppressAutoSend = true
    stopListening()
  }
  // Hands-free: suspend the open mic while Orbit thinks/speaks so it
  // can't transcribe its own reply (§9.1). Resumed once speech drains.
  handsFree?.setBusy(true)
  setVoiceAudioFocus(true)

  const text = input.value.trim()
  if (!text) {
    handsFree?.setBusy(false)
    setVoiceAudioFocus(false)
    return
  }

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
  // Tier B: record the send. Length-only — no message text leaves
  // the device through telemetry. Latency anchor for a possible
  // follow-up `orbit_load_followed` event when the user clicks an
  // inline load button in the reply.
  lastUserSendAt = Date.now()
  const cfgForEvent = loadConfig()
  emit({
    event_type: 'orbit_interaction',
    interaction: 'message_sent',
    subtype: 'user_text',
    model: cfgForEvent.model ?? 'unknown',
    duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
  })

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
  beginSpeaking()
  // Identify this turn's speaking session so the resume below can't
  // re-enable the mic if a newer turn has since taken over (a stale
  // earlier ttsChain settling after the next send began).
  const turnSpeakId = ttsSessionId
  const turnStartedAt = Date.now()
  let streamFinishReason: 'stop' | 'length' | 'tool_calls' | 'error' = 'stop'

  try {
    // Capture globe screenshot + overlay context only when vision mode and LLM are both active
    const config = await loadConfigWithKey()
    const shouldCaptureVision = config.visionEnabled && config.enabled && !!config.apiUrl
    const screenshot = shouldCaptureVision ? await captureGlobeScreenshot() : null
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
          // Only re-chunk for speech when this delta may have completed
          // a sentence — re-splitting the whole message on every token
          // would be O(n²). The `done` flush catches any trailing text.
          if (/[.!?\n]/.test(chunk.text)) pumpSpeech(docentMsg.text, false)
          break

        case 'action': {
          if (!docentMsg.actions) docentMsg.actions = []
          let action = chunk.action
          // Eager dry-check for set-time so the user sees the
          // failure ("no time-enabled dataset loaded", "date out
          // of range") the moment the action streams in, rather
          // than staring at an optimistic "Seeking to X" badge
          // until they click some unrelated Load button. The
          // dry-check is side-effect-free — actual seeking still
          // happens later via executeGlobeAction. If the host
          // doesn't expose canSetTime, we fall through to the
          // optimistic render as before.
          if (action.type === 'set-time' && callbacks.canSetTime) {
            const probe = callbacks.canSetTime(action.isoDate)
            if (!probe.ok) {
              action = { ...action, error: probe.message }
            }
          }
          docentMsg.actions.push(action)
          // Globe-control actions are always deferred during streaming;
          // flushed at 'done' (immediate) or after dataset loads
          // (deferred). A set-time we already know will fail still
          // gets queued so it can re-evaluate after the user loads
          // a dataset that might satisfy it (different time-enabled
          // dataset → different success conditions).
          if (action.type !== 'load-dataset') {
            pendingGlobeActions.push(action)
          }
          updateStreamingMessage(docentMsg)
          scrollToBottom()
          break
        }

        case 'auto-load': {
          // Auto-load the top result immediately
          const autoAction = chunk.action
          if (autoAction.type === 'load-dataset') {
            callbacks.onLoadDataset(autoAction.datasetId)
            if (!docentMsg.text) {
              const altHint = chunk.alternatives.length > 0 ? t('chat.autoLoad.altHint') : ''
              docentMsg.text = t('chat.autoLoad.message', { title: autoAction.datasetTitle, altHint })
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
            const hint = t(isLocalDev ? 'chat.fallback.localDev' : 'chat.fallback.production')
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
      docentMsg.text = t('chat.error.generic')
    }
    streamFinishReason = 'error'
  }

  hideTyping()
  isStreaming = false
  setSendEnabled(true)
  // Speak any remaining (final) sentence and let the queue drain.
  pumpSpeech(docentMsg.text, true)
  // Resume hands-free listening only once any spoken reply has finished
  // draining (ttsChain), so the open mic doesn't capture Orbit's voice.
  // When auto-speak is off, ttsChain is already resolved → immediate.
  // Restore the ducked dataset audio at the same point. Skip if a newer
  // turn has since started speaking — it now owns the mic/ducking.
  void ttsChain.finally(() => {
    if (turnSpeakId !== ttsSessionId) return
    handsFree?.setBusy(false)
    setVoiceAudioFocus(false)
  })

  // Clean up empty actions array
  if (docentMsg.actions?.length === 0) delete docentMsg.actions

  // Tier B: stream-end metrics. response_complete + the
  // assistant-side orbit_turn fire here so they reflect the
  // actual round-trip the user perceived (includes streaming
  // tail). Token counts are emitted as `0` because llmProvider
  // doesn't yet surface usage data from OpenAI-compatible
  // providers — TODO: capture `usage.prompt_tokens` /
  // `completion_tokens` from the final SSE chunk and thread them
  // through to here so dashboards' `input_tokens > 0` filter
  // gains real signal.
  const cfgForStreamEnd = loadConfig()
  const streamDurationMs = Math.max(0, Date.now() - turnStartedAt)
  const docentMessages = messages.filter((m) => m.role === 'docent')
  const turnIndex = Math.max(0, docentMessages.findIndex((m) => m.id === docentMsg.id))
  emit({
    event_type: 'orbit_interaction',
    interaction: 'response_complete',
    subtype: streamFinishReason,
    model: cfgForStreamEnd.model ?? 'unknown',
    duration_ms: streamDurationMs,
    input_tokens: 0,
    output_tokens: 0,
  })
  emit({
    event_type: 'orbit_turn',
    turn_role: 'assistant',
    reading_level: cfgForStreamEnd.readingLevel ?? 'normal',
    model: cfgForStreamEnd.model ?? 'unknown',
    finish_reason: streamFinishReason,
    turn_index: turnIndex,
    duration_ms: streamDurationMs,
    input_tokens: 0,
    output_tokens: 0,
    content_length: docentMsg.text.length,
    // 1d/Y — surface how many LLM round-trips this turn took so
    // dashboards can monitor per-turn cost shifts since 1d/F
    // replaced the single-round [RELEVANT DATASETS] injection
    // with a tool-calling path that can take 2+ rounds.
    turn_rounds: docentMsg.llmContext?.roundsCount ?? 0,
  })

  // Re-render fully to wire action button events
  renderMessages()
  scrollToBottom()
  saveSession()
  callbacks.announce(t('chat.announce.docentResponded'))
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
    // Inline render — markdown-lite **bold** is parsed below in renderMarkdownLite
    // for chat messages, but the welcome block hard-codes its <strong> tags so
    // it can keep its specific p/strong markup. Escape the translation FIRST
    // so a translator-supplied "</p><script>" or HTML/event attribute can't
    // smuggle markup; then apply the **bold** → <strong> transform on the
    // already-escaped text. escapeHtml doesn't touch the asterisks so the
    // regex still matches the markdown markers.
    const intro = escapeHtml(t('chat.welcome.intro')).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    const hint = escapeHtml(t('chat.welcome.hint'))
    container.innerHTML = `<div class="chat-welcome">
      <div class="chat-welcome-icon" aria-hidden="true">&#x1F30D;</div>
      <p>${intro}</p>
      <p class="chat-welcome-hint">${hint}</p>
      <div class="chat-suggestions">
        <button class="chat-suggestion" data-query="${escapeAttr(t('chat.welcome.suggestions.seaLevel.query'))}">${escapeHtml(t('chat.welcome.suggestions.seaLevel.label'))}</button>
        <button class="chat-suggestion" data-query="${escapeAttr(t('chat.welcome.suggestions.ndvi.query'))}">${escapeHtml(t('chat.welcome.suggestions.ndvi.label'))}</button>
        <button class="chat-suggestion" data-query="${escapeAttr(t('chat.welcome.suggestions.hurricanes.query'))}">${escapeHtml(t('chat.welcome.suggestions.hurricanes.label'))}</button>
        <button class="chat-suggestion" data-query="${escapeAttr(t('chat.welcome.suggestions.arctic.query'))}">${escapeHtml(t('chat.welcome.suggestions.arctic.label'))}</button>
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
  wireSpeakButtons(container)
}

/** Render a single chat message as an HTML string with inline action buttons. */
function renderMessage(msg: ChatMessage): string {
  const roleClass = msg.role === 'user' ? 'chat-msg-user' : 'chat-msg-docent'
  const { html: textHtml, inlinedIds } = renderChatText(msg.text ?? '', msg.actions)
  const remaining = msg.actions?.filter(a => a.type !== 'load-dataset' || !inlinedIds.has(a.datasetId))
  const actionsHtml = remaining?.length ? renderActions(remaining) : ''
  const thumbsUpLabel = t('chat.feedback.thumbsUp')
  const thumbsDownLabel = t('chat.feedback.thumbsDown')
  const speakLabel = t('chat.voice.speakAria')
  const speakBtnHtml = canSpeakReplies()
    ? `<button class="chat-speak-btn" data-msg-id="${escapeAttr(msg.id)}" aria-label="${escapeAttr(speakLabel)}" title="${escapeAttr(speakLabel)}">&#x1F50A;&#xFE0E;</button>`
    : ''
  const feedbackHtml = msg.role === 'docent' && msg.text
    ? `<div class="chat-feedback">
         ${speakBtnHtml}
         <button class="chat-feedback-btn" data-feedback="thumbs-up" data-msg-id="${escapeAttr(msg.id)}" aria-label="${escapeAttr(thumbsUpLabel)}" aria-pressed="false" title="${escapeAttr(thumbsUpLabel)}">&#x1F44D;&#xFE0E;</button>
         <button class="chat-feedback-btn" data-feedback="thumbs-down" data-msg-id="${escapeAttr(msg.id)}" aria-label="${escapeAttr(thumbsDownLabel)}" aria-pressed="false" title="${escapeAttr(thumbsDownLabel)}">&#x1F44E;&#xFE0E;</button>
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
  // Strip raw markers that appear during streaming (all action types).
  // LOAD_FRAME must come before LOAD (the LOAD regex requires `:`
  // right after `LOAD` so it wouldn't match `<<LOAD_FRAME:...>>` —
  // verified — but stripping LOAD_FRAME first keeps the order
  // intent-obvious for future readers). Phase 3pg-review/C —
  // Copilot discussion_r3277396454: the LOAD_FRAME marker was
  // visibly flickering in the transcript during stream because
  // the renderer hadn't been taught to strip it yet.
  let clean = text.replace(/<?<LOAD_FRAME:[^>]+>>?\n?/g, '')
  clean = clean.replace(/<?<LOAD:[^>]+>>?\n?/g, '')
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
      return `<span class="chat-action-btn chat-action-inline chat-action-loaded"><span class="chat-action-title">${escapeHtml(action.datasetTitle)}</span> <span class="chat-action-load">${escapeHtml(t('chat.action.loaded'))}</span></span>`
    }
    return `<button class="chat-action-btn chat-action-inline" data-dataset-id="${escapeAttr(action.datasetId)}" aria-label="${escapeAttr(t('chat.action.load.aria', { title: action.datasetTitle }))}"><span class="chat-action-title">${escapeHtml(action.datasetTitle)}</span> <span class="chat-action-load">${escapeHtml(t('chat.action.load'))}</span></button>`
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
        return `<span class="chat-action-btn chat-action-loaded"><span class="chat-action-title">${escapeHtml(a.datasetTitle)}</span> <span class="chat-action-load">${escapeHtml(t('chat.action.loaded'))}</span></span>`
      }
      return `<button class="chat-action-btn" data-dataset-id="${escapeAttr(a.datasetId)}" aria-label="${escapeAttr(t('chat.action.load.aria', { title: a.datasetTitle }))}">
        <span class="chat-action-title">${escapeHtml(a.datasetTitle)}</span>
        <span class="chat-action-load">${escapeHtml(t('chat.action.load'))}</span>
      </button>`
    }
    if (a.type === 'fly-to') {
      const latLabel = Math.abs(a.lat).toFixed(1) + '\u00B0' + (a.lat >= 0 ? 'N' : 'S')
      const lonLabel = Math.abs(a.lon).toFixed(1) + '\u00B0' + (a.lon >= 0 ? 'E' : 'W')
      const flying = t('chat.action.flyingTo', { coords: `${latLabel}, ${lonLabel}` })
      return `<span class="chat-action-status" aria-label="${escapeAttr(flying)}">${escapeHtml(flying)}</span>`
    }
    if (a.type === 'set-time') {
      // Eager dry-check at stream time may have stamped an `error`
      // on the action — render that with the failure styling
      // immediately, matching what executeGlobeAction would write
      // post-execution. Same pre-translated message in both paths.
      if (a.error) {
        return `<span class="chat-action-status chat-action-status-err" aria-label="${escapeAttr(a.error)}">${escapeHtml(a.error)}</span>`
      }
      const seeking = t('chat.action.seekingTo', { date: a.isoDate })
      return `<span class="chat-action-status" aria-label="${escapeAttr(seeking)}">${escapeHtml(seeking)}</span>`
    }
    if (a.type === 'fit-bounds') {
      const label = a.label ?? t('chat.action.regionDefault')
      const navigating = t('chat.action.navigatingTo', { label })
      return `<span class="chat-action-status" aria-label="${escapeAttr(navigating)}">${escapeHtml(navigating)}</span>`
    }
    if (a.type === 'add-marker') {
      const label = a.label ?? `${a.lat.toFixed(1)}, ${a.lng.toFixed(1)}`
      const marker = t('chat.action.marker', { label })
      return `<span class="chat-action-status" aria-label="${escapeAttr(marker)}">${escapeHtml(marker)}</span>`
    }
    if (a.type === 'toggle-labels') {
      const labelsMsg = t(a.visible ? 'chat.action.labelsShown' : 'chat.action.labelsHidden')
      return `<span class="chat-action-status" aria-label="${escapeAttr(labelsMsg)}">${escapeHtml(labelsMsg)}</span>`
    }
    if (a.type === 'highlight-region') {
      const label = a.label ?? t('chat.action.regionDefault')
      const highlighted = t('chat.action.highlighted', { label })
      return `<span class="chat-action-status" aria-label="${escapeAttr(highlighted)}">${escapeHtml(highlighted)}</span>`
    }
    if (a.type === 'load-frame') {
      // Phase 3pg/C — single-frame load button. Display name is
      // pre-derived server-side (or by `resolveFrameQuery` on the
      // SPA side); render it verbatim so all consumers agree on
      // the label.
      return `<button class="chat-action-btn chat-action-frame" data-dataset-id="${escapeAttr(a.datasetId)}" data-frame-query="${escapeAttr(a.frameQuery)}" aria-label="${escapeAttr(t('chat.action.loadFrame.aria', { name: a.displayName }))}"><span class="chat-action-title">${escapeHtml(a.displayName)}</span> <span class="chat-action-load">${escapeHtml(t('chat.action.loadFrame'))}</span></button>`
    }
    return ''
  }).join('')
  const loadActions = actions.filter(a => a.type === 'load-dataset')
  const browseFooter = loadActions.length >= 3 && callbacks?.onOpenBrowse
    ? `<button class="chat-browse-link">${escapeHtml(t('chat.action.compareInBrowse'))}</button>`
    : ''
  return `<div class="chat-actions">${items}${browseFooter}</div>`
}

/** Attach click handlers to action buttons within a rendered message container. */
function wireActionButtons(container: Element): void {
  container.querySelectorAll<HTMLElement>('.chat-action-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.datasetId
      // Phase 3pg/C — frame-load buttons carry a `data-frame-query`
      // attribute and route through `onLoadFrame` instead. The
      // analytics + dataset-load bookkeeping below stays on the
      // load-dataset path; frame loads don't unload the parent
      // sequence so the "remove action card after load" behaviour
      // would also be wrong for them.
      //
      // The frame-query branch is exclusive: if `data-frame-query`
      // is set, we never fall through to `onLoadDataset` even when
      // `callbacks.onLoadFrame` is unbound. The fallback would load
      // the whole sequence — surprising behaviour the user didn't
      // ask for. Unbound `onLoadFrame` is a host-side opt-out
      // (e.g. a chat consumer that doesn't ship the frame loader);
      // the right answer is a quiet no-op, matching the doc comment
      // on `ChatCallbacks.onLoadFrame`.
      const frameQuery = btn.dataset.frameQuery
      if (id && frameQuery !== undefined) {
        if (callbacks?.onLoadFrame) {
          callbacks.onLoadFrame(id, frameQuery)
          callbacks.announce(t('chat.announce.loadingFrame'))
        }
        return
      }
      if (id && callbacks) {
        callbacks.onLoadDataset(id)
        callbacks.announce(t('chat.announce.loading'))
        // Tier B: chat → load correlation. `latency_ms` is the
        // time between the user's most recent message and this
        // click — long latencies suggest the user read the reply
        // carefully before acting; short ones suggest auto-load
        // or a confident click. `path='button_click'` since this
        // is the inline button branch (the bare-id fallback path
        // and the tool-call path land separately).
        const cfgForLoad = loadConfig()
        emit({
          event_type: 'orbit_interaction',
          interaction: 'action_executed',
          subtype: 'load_dataset',
          model: cfgForLoad.model ?? 'unknown',
          duration_ms: 0,
          input_tokens: 0,
          output_tokens: 0,
        })
        if (lastUserSendAt !== null) {
          emit({
            event_type: 'orbit_load_followed',
            dataset_id: id,
            path: 'button_click',
            latency_ms: Math.max(0, Date.now() - lastUserSendAt),
          })
        }

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
    let line = rawLine.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Convert markdown links [text](url) → clickable <a> (new tab)
    line = line.replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    // Convert bare URLs that aren't already inside an <a> tag. Split on
    // existing anchors to avoid wrapping URLs that are already linked
    // (e.g. when the markdown link text itself is a URL).
    line = line.split(/(<a\s[^>]*>.*?<\/a>)/g).map((segment, i) => {
      // Odd indices are the captured <a>...</a> groups — pass through
      if (i % 2 === 1) return segment
      return segment.replace(
        /(https?:\/\/[^\s<)]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
      )
    }).join('')
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
  // Sit the chat trigger above the info panel whenever it's visible —
  // not just when expanded. The collapsed state (header + picker row)
  // still has measurable height that the trigger needs to clear.
  if (!infoPanel.classList.contains('hidden')) {
    const h = infoPanel.getBoundingClientRect().height
    if (h > 0) {
      trigger.style.bottom = `${h + 12}px`
      return
    }
  }
  trigger.style.bottom = ''
}

// --- Contextual dataset prompt ---

/** Show a contextual prompt nudging the user to ask about the loaded dataset. */
function showDatasetPrompt(dataset: Dataset): void {
  dismissDatasetPrompt()
  const el = document.getElementById('chat-dataset-prompt')
  if (!el) return
  el.textContent = t('chat.datasetPrompt.cta', { title: dataset.title })
  el.classList.remove('hidden')
  el.onclick = () => {
    dismissDatasetPrompt()
    openChat()
    const input = document.getElementById('chat-input') as HTMLTextAreaElement | null
    if (input) {
      input.value = t('chat.datasetPrompt.tellMe', { title: dataset.title })
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

/** Feedback-tag MessageKey lists. The visible label resolves through
 * t() at render time so a locale switch + reload picks up new copy
 * without redeploying. The English source label is also passed
 * through to the backend (as the keyword translators see) so the
 * server-side feedback table stores a stable English-key per tag
 * regardless of the user's locale. */
const FEEDBACK_TAGS_NEGATIVE: MessageKey[] = [
  'chat.feedback.tag.wrongDataset',
  'chat.feedback.tag.inaccurateInfo',
  'chat.feedback.tag.tooLong',
  'chat.feedback.tag.offTopic',
  'chat.feedback.tag.misunderstood',
]

const FEEDBACK_TAGS_POSITIVE: MessageKey[] = [
  'chat.feedback.tag.greatRecommendation',
  'chat.feedback.tag.clearExplanation',
  'chat.feedback.tag.learnedSomething',
  'chat.feedback.tag.goodLevelOfDetail',
  'chat.feedback.tag.helpedMeExplore',
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
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false')
      })
      // Highlight the selected one (stays disabled)
      btn.classList.add('chat-feedback-rated')
      btn.classList.remove('chat-feedback-disabled')

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
    emit({
      event_type: 'feedback',
      context: 'ai_response',
      kind: rating === 'thumbs-up' ? 'thumbs_up' : 'thumbs_down',
      status: 'ok',
      rating: rating === 'thumbs-up' ? 1 : -1,
    })
    if (rating === 'thumbs-down') {
      // Tier B correction signal — pairs with the Tier A
      // `feedback` envelope above. Dashboards can use this to
      // identify the rated turn cheaply (turn_index) without
      // joining to the feedback table.
      const docentMessages = messages.filter((m) => m.role === 'docent')
      const turnIndex = docentMessages.findIndex((m) => m.id === messageId)
      if (turnIndex >= 0) {
        emit({
          event_type: 'orbit_correction',
          signal: 'thumbs_down',
          turn_index: turnIndex,
        })
      }
    }
    callbacks?.announce(t('chat.announce.feedbackSubmitted'))
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
    emit({
      event_type: 'feedback',
      context: 'ai_response',
      kind: rating === 'thumbs-up' ? 'thumbs_up' : 'thumbs_down',
      status: 'error',
      rating: rating === 'thumbs-up' ? 1 : -1,
    })
    callbacks?.announce(t('chat.announce.feedbackFailed'))
  }
}

/** Show the inline "tell us more" expansion (or bottom sheet on mobile). */
function showFeedbackExpansion(messageId: string, rating: FeedbackRating, btn: HTMLElement): void {
  // Remove any existing expansion
  dismissFeedbackExpansion()

  const isPositive = rating === 'thumbs-up'
  const placeholder = t(isPositive ? 'chat.feedback.placeholder.positive' : 'chat.feedback.placeholder.negative')
  const tags = isPositive ? FEEDBACK_TAGS_POSITIVE : FEEDBACK_TAGS_NEGATIVE

  // data-tag stores the canonical English label (server-side stable),
  // while the visible button text uses t() so it reflects the user's locale.
  const tagsHtml = tags.map(key => {
    const englishLabel = enMessages[key as keyof typeof enMessages] ?? key
    return `<button class="chat-feedback-tag" aria-pressed="false" data-tag="${escapeAttr(englishLabel)}">${escapeHtml(t(key))}</button>`
  }).join('')

  const expansionHtml = `
    <div class="chat-feedback-tags">${tagsHtml}</div>
    <textarea class="chat-feedback-comment" placeholder="${escapeAttr(placeholder)}" rows="2"></textarea>
    <div class="chat-feedback-expand-actions">
      <button class="chat-feedback-send">${escapeHtml(t('chat.feedback.send'))}</button>
      <button class="chat-feedback-dismiss" aria-label="${escapeAttr(t('chat.feedback.dismiss'))}">${escapeHtml(t('chat.feedback.dismiss'))}</button>
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
    sheet.setAttribute('aria-label', t('chat.feedback.sheetAria'))
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
    expand.setAttribute('aria-label', t('chat.feedback.sheetAria'))
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
    callbacks?.announce(t('chat.announce.feedbackExtra'))
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
