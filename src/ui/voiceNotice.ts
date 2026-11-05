// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The first-use voice notice (docs/ORBIT_VOICE_PLAN.md §6): before
 * Orbit first listens through a voice engine, say where the audio goes,
 * and start nothing until the user says Continue.
 *
 * It is a gate rather than a banner because the default engine is the
 * browser's own speech recognition, which in Chrome sends the audio to
 * Google. A notice shown beside a microphone that is already streaming
 * discloses after the fact. So every path that starts capture asks
 * `confirmVoiceNotice` first, and the privacy policy stops being the
 * only place a user can learn this.
 *
 * What is remembered, and why it is keyed this way:
 *   - **Per engine.** Browser and Cloud send audio to different
 *     places, so agreeing to one says nothing about the other.
 *   - **Always-on is its own notice.** Open mic and wake word keep the
 *     microphone on across visits and can pick up people nearby, which
 *     the tap and push-to-talk notice does not say. Agreeing to the
 *     always-on notice covers the tap one too, since it says all of it.
 *   - In `localStorage`, with an in-memory fallback so a browser that
 *     refuses storage is asked once per page, not on every tap.
 *
 * The dialog is a native `<dialog>` opened with `showModal()`: the
 * browser makes the rest of the page inert, traps focus and turns
 * Escape into `cancel`, which here means "Not now". Only one notice is
 * open at a time; a second request while one is open answers `false`,
 * so two callers cannot both act on one Continue.
 */

import type { VoiceProvider } from '../types'
import { t, tHtml, type MessageKey } from '../i18n'

/** Which kind of capture is about to start. */
export type VoiceNoticeMode = 'tap' | 'push-to-talk' | 'open-mic' | 'wake-word'

export const VOICE_NOTICE_STORAGE_KEY = 'sos-voice-notice-seen'

const ENGINE_PARAGRAPH = {
  browser: 'chat.voiceNotice.browser',
  cloud: 'chat.voiceNotice.cloud',
  local: 'chat.voiceNotice.local',
} as const satisfies Record<VoiceProvider, MessageKey>

/** Whether the microphone stays on once this mode is armed. */
export function isAlwaysOn(mode: VoiceNoticeMode): boolean {
  return mode === 'open-mic' || mode === 'wake-word'
}

function noticeKey(provider: VoiceProvider, alwaysOn: boolean): string {
  return alwaysOn ? `${provider}:always-on` : provider
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
export function hasSeenVoiceNotice(provider: VoiceProvider, mode: VoiceNoticeMode): boolean {
  const seen = readSeen()
  return seen.has(noticeKey(provider, true)) || (!isAlwaysOn(mode) && seen.has(noticeKey(provider, false)))
}

/** Record that the user agreed to the notice for this engine and mode. */
export function markVoiceNoticeSeen(provider: VoiceProvider, mode: VoiceNoticeMode): void {
  const key = noticeKey(provider, isAlwaysOn(mode))
  memorySeen.add(key)
  const seen = readSeen()
  seen.add(key)
  try {
    localStorage.setItem(VOICE_NOTICE_STORAGE_KEY, JSON.stringify([...seen].sort()))
  } catch {
    // Kept in memory for this page.
  }
}

/** The notice's paragraphs, in order, for this engine and mode. */
export function voiceNoticeParagraphs(provider: VoiceProvider, mode: VoiceNoticeMode): MessageKey[] {
  const keys: MessageKey[] = [ENGINE_PARAGRAPH[provider], 'chat.voiceNotice.sent']
  if (mode === 'open-mic') keys.push('chat.voiceNotice.openMic')
  if (mode === 'wake-word') keys.push('chat.voiceNotice.wakeWord')
  keys.push('chat.voiceNotice.change')
  return keys
}

export interface VoiceNoticeRequest {
  /** The engine that will hear the user. */
  provider: VoiceProvider
  mode: VoiceNoticeMode
  /** Where focus goes when the notice closes, if it is still on the page. */
  returnFocus?: HTMLElement | null
}

let open: { dialog: HTMLDialogElement; settle: (agreed: boolean) => void } | null = null

/** Is a notice on screen now? */
export function isVoiceNoticeOpen(): boolean {
  return open !== null
}

/**
 * Resolve `true` if Orbit may start listening: at once when the notice
 * for this engine and mode has been agreed to, else once the user
 * presses Continue. Resolves `false` on Not now, Escape, a call while
 * another notice is open, or `closeVoiceNotice()`.
 */
export function confirmVoiceNotice(request: VoiceNoticeRequest): Promise<boolean> {
  if (hasSeenVoiceNotice(request.provider, request.mode)) return Promise.resolve(true)
  if (open) return Promise.resolve(false)
  return new Promise((resolve) => {
    const dialog = buildDialog(request)
    let settled = false
    const settle = (agreed: boolean): void => {
      if (settled) return
      settled = true
      if (agreed) markVoiceNoticeSeen(request.provider, request.mode)
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
    // in `close`. Neither is a Continue.
    dialog.addEventListener('cancel', () => settle(false))
    dialog.addEventListener('close', () => settle(false))
    document.body.appendChild(dialog)
    if (typeof dialog.showModal === 'function') dialog.showModal()
    else dialog.setAttribute('open', '')
    // Not left to `autofocus`: support for it inside a modal varies.
    dialog.querySelector<HTMLButtonElement>('.voice-notice-continue')?.focus()
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
  dialog.setAttribute('aria-describedby', 'voice-notice-body')
  const paragraphs = voiceNoticeParagraphs(request.provider, request.mode)
    .map((key) => `<p>${tHtml(key)}</p>`)
    .join('')
  dialog.innerHTML = `
    <h2 id="voice-notice-title" class="voice-notice-title">${tHtml('chat.voiceNotice.title')}</h2>
    <div id="voice-notice-body" class="voice-notice-body">${paragraphs}</div>
    <p class="voice-notice-policy"><a href="/privacy" target="_blank" rel="noopener">${tHtml('chat.voiceNotice.policy')}</a></p>
    <div class="voice-notice-actions">
      <button type="button" class="voice-notice-cancel">${tHtml('chat.voiceNotice.cancel')}</button>
      <button type="button" class="voice-notice-continue">${tHtml('chat.voiceNotice.continue')}</button>
    </div>`
  // The link names where it goes; a new tab says so to a screen reader.
  dialog.querySelector('.voice-notice-policy a')?.setAttribute('aria-label', t('chat.voiceNotice.policy.aria'))
  return dialog
}

/** Forget every agreement and close any notice. Tests only. */
export function resetVoiceNoticeForTests(): void {
  closeVoiceNotice()
  memorySeen.clear()
  try { localStorage.removeItem(VOICE_NOTICE_STORAGE_KEY) } catch { /* unavailable */ }
}
