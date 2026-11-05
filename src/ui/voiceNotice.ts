// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The first-use voice notice (docs/ORBIT_VOICE_PLAN.md §6): before
 * Orbit first listens through a voice engine, say where the audio goes,
 * and start nothing until the user presses Start listening.
 *
 * It is a gate rather than a banner because the default engine is the
 * browser's own speech recognition, which in Chrome sends the audio to
 * Google. A notice shown beside a microphone that is already streaming
 * discloses after the fact. So every path that starts capture asks
 * `confirmVoiceNotice` first, and the privacy policy stops being the
 * only place a user can learn this.
 *
 * What is remembered, and why it is keyed this way:
 *   - **Per engine**, because where the audio goes is what changes.
 *     Cloud's live path is an engine of its own (`cloud-live`): its
 *     audio passes through an AI Gateway, which the batch path's does
 *     not, so a build that turns live transcription on asks again.
 *   - **Open mic and wake word are each their own notice.** Each keeps
 *     the microphone on across visits, and they promise opposite things
 *     about when audio leaves the device, so agreeing to one says
 *     nothing about the other. Either covers a tap or push to talk.
 *   - **Versioned per engine** (`NOTICE_VERSION`). Bump an engine's
 *     version when a fact its notice states changes, so everyone who
 *     agreed is asked again; not for wording or translation. Nothing
 *     expires by time.
 *   - In `localStorage`, with an in-memory fallback so a browser that
 *     refuses storage is asked once per page, not on every tap.
 *
 * The dialog is a native `<dialog>` opened with `showModal()`: the
 * browser makes the rest of the page inert, traps focus and turns
 * Escape into `cancel`, which here means "Not now". Focus opens on the
 * heading, not on Start listening, so the text is in view and agreeing
 * is not the default. Keys typed in it stop at the dialog: the
 * playback shortcuts once cancelled Space on both buttons, and while
 * `playbackShortcutFor` now leaves a dialog's keys alone, a key typed
 * in a consent gate should reach nothing behind it. Only one notice is
 * open at a time; a second request while one is open answers `false`,
 * so two callers cannot both act on one agreement.
 */

import type { VoiceProvider } from '../types'
import { tHtml, type MessageKey } from '../i18n'

/** Which kind of capture is about to start. */
export type VoiceNoticeMode = 'tap' | 'push-to-talk' | 'open-mic' | 'wake-word'

/** The engine that will hear the user, as far as the notice cares. */
export type VoiceNoticeEngine = VoiceProvider | 'cloud-live'

export const VOICE_NOTICE_STORAGE_KEY = 'sos-voice-notice-seen'

const NOTICE_VERSION = {
  browser: 1,
  cloud: 1,
  'cloud-live': 1,
  local: 1,
} as const satisfies Record<VoiceNoticeEngine, number>

/** A tap and push to talk share a notice: both capture only on demand. */
type NoticeKind = 'tap' | 'open-mic' | 'wake-word'

function kindOf(mode: VoiceNoticeMode): NoticeKind {
  return mode === 'push-to-talk' ? 'tap' : mode
}

function noticeKey(engine: VoiceNoticeEngine, kind: NoticeKind): string {
  return `${engine}${kind === 'tap' ? '' : `:${kind}`}@${NOTICE_VERSION[engine]}`
}

/** Whether the microphone stays on once this mode is armed. */
export function isAlwaysOn(mode: VoiceNoticeMode): boolean {
  return mode === 'open-mic' || mode === 'wake-word'
}

/** The notice engine for a resolved engine: Cloud's live path is its own. */
export function noticeEngineFor(engine: { provider: VoiceProvider; live?: boolean }): VoiceNoticeEngine {
  return engine.provider === 'cloud' && engine.live ? 'cloud-live' : engine.provider
}

const memorySeen = new Set<string>()

function readSeen(): Set<string> {
  const seen = new Set(memorySeen)
  try {
    const raw = localStorage.getItem(VOICE_NOTICE_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) for (const key of parsed) if (typeof key === 'string') seen.add(key)
  } catch {
    // Unavailable or unreadable storage: what this page has seen stands.
  }
  return seen
}

/** Has the user agreed to the notice for this engine and mode? */
export function hasSeenVoiceNotice(engine: VoiceNoticeEngine, mode: VoiceNoticeMode): boolean {
  const seen = readSeen()
  const kind = kindOf(mode)
  if (kind !== 'tap') return seen.has(noticeKey(engine, kind))
  return (['tap', 'open-mic', 'wake-word'] as const).some((k) => seen.has(noticeKey(engine, k)))
}

/** Record that the user agreed to the notice for this engine and mode. */
export function markVoiceNoticeSeen(engine: VoiceNoticeEngine, mode: VoiceNoticeMode): void {
  const key = noticeKey(engine, kindOf(mode))
  memorySeen.add(key)
  const seen = readSeen()
  seen.add(key)
  try {
    localStorage.setItem(VOICE_NOTICE_STORAGE_KEY, JSON.stringify([...seen].sort()))
  } catch {
    // Kept in memory for this page.
  }
}

/** Running in the desktop app, where "the browser" is the system web view. */
function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window
}

/** The notice's paragraphs, in order, for this engine and mode. */
export function voiceNoticeParagraphs(
  engine: VoiceNoticeEngine,
  mode: VoiceNoticeMode,
  desktop: boolean = isDesktopApp(),
): MessageKey[] {
  const enginePara: Record<VoiceNoticeEngine, MessageKey> = {
    browser: desktop ? 'chat.voiceNotice.browserDesktop' : 'chat.voiceNotice.browser',
    cloud: 'chat.voiceNotice.cloud',
    'cloud-live': 'chat.voiceNotice.cloudLive',
    local: 'chat.voiceNotice.local',
  }
  const modePara: Record<VoiceNoticeMode, MessageKey | null> = {
    tap: null,
    'push-to-talk': 'chat.voiceNotice.pushToTalk',
    'open-mic': 'chat.voiceNotice.openMic',
    'wake-word': 'chat.voiceNotice.wakeWord',
  }
  const keys: MessageKey[] = [enginePara[engine], 'chat.voiceNotice.sent']
  const extra = modePara[mode]
  if (extra) keys.push(extra)
  // A hands-free notice says that Not now turns Hands-free off, since it
  // does: a label alone would suggest "ask me later".
  keys.push(mode === 'tap' ? 'chat.voiceNotice.change' : 'chat.voiceNotice.changeHandsFree')
  return keys
}

export interface VoiceNoticeRequest {
  /** The engine that will hear the user (`noticeEngineFor`). */
  engine: VoiceNoticeEngine
  mode: VoiceNoticeMode
  /** Where focus goes when the notice closes, if it is still on the page. */
  returnFocus?: HTMLElement | null
  /** Override the desktop-app check. Tests only. */
  desktop?: boolean
}

let open: { dialog: HTMLDialogElement; settle: (agreed: boolean) => void } | null = null

/** Is a notice on screen now? */
export function isVoiceNoticeOpen(): boolean {
  return open !== null
}

/**
 * Resolve `true` if Orbit may start listening: at once when the notice
 * for this engine and mode has been agreed to, else once the user
 * presses Start listening. Resolves `false` on Not now, Escape, a call
 * while another notice is open, or `closeVoiceNotice()`.
 */
export function confirmVoiceNotice(request: VoiceNoticeRequest): Promise<boolean> {
  if (hasSeenVoiceNotice(request.engine, request.mode)) return Promise.resolve(true)
  if (open) return Promise.resolve(false)
  return new Promise((resolve) => {
    const dialog = buildDialog(request)
    let settled = false
    const settle = (agreed: boolean): void => {
      if (settled) return
      settled = true
      if (agreed) markVoiceNoticeSeen(request.engine, request.mode)
      open = null
      if (dialog.open) dialog.close()
      dialog.remove()
      const target = request.returnFocus
      if (target?.isConnected) target.focus()
      resolve(agreed)
    }
    open = { dialog, settle }
    dialog.querySelector('.voice-notice-continue')?.addEventListener('click', () => settle(true))
    dialog.querySelector('.voice-notice-cancel')?.addEventListener('click', () => settle(false))
    // Escape fires `cancel`; any other close (a form, the browser) ends
    // in `close`. Neither is an agreement.
    dialog.addEventListener('cancel', () => settle(false))
    dialog.addEventListener('close', () => settle(false))
    dialog.addEventListener('keydown', (event) => event.stopPropagation())
    document.body.appendChild(dialog)
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    // Not left to `autofocus`: support for it inside a modal varies.
    dialog.querySelector<HTMLElement>('#voice-notice-title')?.focus()
  })
}

/** Close any open notice as "Not now". For a page losing Orbit. */
export function closeVoiceNotice(): void {
  open?.settle(false)
}

function buildDialog(request: VoiceNoticeRequest): HTMLDialogElement {
  const dialog = document.createElement('dialog')
  dialog.className = 'voice-notice'
  dialog.setAttribute('aria-labelledby', 'voice-notice-title')
  // The engine paragraph only: where the audio goes is what must be
  // heard on opening, and the whole body read as one flat string is
  // long and then heard twice by anyone who reads on.
  dialog.setAttribute('aria-describedby', 'voice-notice-engine')
  const paragraphs = voiceNoticeParagraphs(request.engine, request.mode, request.desktop ?? isDesktopApp())
    .map((key, index) => `<p${index === 0 ? ' id="voice-notice-engine"' : ''}>${tHtml(key)}</p>`)
    .join('')
  // "Opens in a new tab" is added to the link's name, not put in its
  // place, so the name always starts with the words on screen.
  dialog.innerHTML = `
    <h2 id="voice-notice-title" class="voice-notice-title" tabindex="-1">${tHtml('chat.voiceNotice.title')}</h2>
    <div class="voice-notice-body">${paragraphs}</div>
    <p class="voice-notice-policy"><a href="/privacy" target="_blank" rel="noopener">${tHtml('chat.voiceNotice.policy')}<span class="sr-only"> ${tHtml('chat.voiceNotice.newTab')}</span></a></p>
    <div class="voice-notice-actions">
      <button type="button" class="voice-notice-cancel">${tHtml('chat.voiceNotice.cancel')}</button>
      <button type="button" class="voice-notice-continue">${tHtml('chat.voiceNotice.continue')}</button>
    </div>`
  return dialog
}

/** Forget every agreement and close any notice. Tests only. */
export function resetVoiceNoticeForTests(): void {
  closeVoiceNotice()
  memorySeen.clear()
  try { localStorage.removeItem(VOICE_NOTICE_STORAGE_KEY) } catch { /* unavailable */ }
}
