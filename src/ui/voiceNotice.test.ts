// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VOICE_NOTICE_STORAGE_KEY,
  closeVoiceNotice,
  confirmVoiceNotice,
  hasSeenVoiceNotice,
  isVoiceNoticeOpen,
  markVoiceNoticeSeen,
  resetVoiceNoticeForTests,
  voiceNoticeParagraphs,
} from './voiceNotice'

function dialog(): HTMLDialogElement | null {
  return document.querySelector('dialog.voice-notice')
}

function press(which: 'continue' | 'cancel'): void {
  dialog()!.querySelector<HTMLButtonElement>(`.voice-notice-${which}`)!.click()
}

beforeEach(() => {
  document.body.innerHTML = '<button id="mic"></button>'
  resetVoiceNoticeForTests()
})
afterEach(() => resetVoiceNoticeForTests())

describe('what the notice says', () => {
  it('names where the audio goes for each engine', () => {
    expect(voiceNoticeParagraphs('browser', 'tap')[0]).toBe('chat.voiceNotice.browser')
    expect(voiceNoticeParagraphs('cloud', 'tap')[0]).toBe('chat.voiceNotice.cloud')
    expect(voiceNoticeParagraphs('local', 'tap')[0]).toBe('chat.voiceNotice.local')
  })

  it('says a microphone left on stays on, only for the modes that leave it on', () => {
    expect(voiceNoticeParagraphs('browser', 'tap')).toEqual([
      'chat.voiceNotice.browser', 'chat.voiceNotice.sent', 'chat.voiceNotice.change',
    ])
    expect(voiceNoticeParagraphs('browser', 'push-to-talk')).toEqual(voiceNoticeParagraphs('browser', 'tap'))
    expect(voiceNoticeParagraphs('cloud', 'open-mic')).toContain('chat.voiceNotice.openMic')
    expect(voiceNoticeParagraphs('cloud', 'wake-word')).toContain('chat.voiceNotice.wakeWord')
    expect(voiceNoticeParagraphs('cloud', 'wake-word')).not.toContain('chat.voiceNotice.openMic')
  })

  it('renders the engine paragraph and the title, and names the dialog by them', () => {
    void confirmVoiceNotice({ provider: 'browser', mode: 'tap' })
    const d = dialog()!
    expect(d.open).toBe(true)
    expect(d.getAttribute('aria-labelledby')).toBe('voice-notice-title')
    expect(d.getAttribute('aria-describedby')).toBe('voice-notice-body')
    expect(d.querySelector('#voice-notice-title')!.textContent).toBe('Before Orbit listens')
    expect(d.querySelector('#voice-notice-body')!.textContent).toContain('Chrome sends the audio to Google')
    expect(document.activeElement).toBe(d.querySelector('.voice-notice-continue'))
  })
})

describe('the gate', () => {
  it('starts nothing until Continue, then remembers it', async () => {
    const answer = confirmVoiceNotice({ provider: 'browser', mode: 'tap' })
    expect(isVoiceNoticeOpen()).toBe(true)
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(false)
    press('continue')
    expect(await answer).toBe(true)
    expect(dialog()).toBeNull()
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(true)
    expect(JSON.parse(localStorage.getItem(VOICE_NOTICE_STORAGE_KEY)!)).toEqual(['browser'])
    // Agreed once, it does not ask again.
    expect(await confirmVoiceNotice({ provider: 'browser', mode: 'tap' })).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('answers no to Not now, to Escape, and to a close from outside, and remembers none', async () => {
    const declined = confirmVoiceNotice({ provider: 'browser', mode: 'tap' })
    press('cancel')
    expect(await declined).toBe(false)

    const escaped = confirmVoiceNotice({ provider: 'browser', mode: 'tap' })
    dialog()!.dispatchEvent(new Event('cancel'))
    expect(await escaped).toBe(false)

    const closed = confirmVoiceNotice({ provider: 'browser', mode: 'tap' })
    closeVoiceNotice()
    expect(await closed).toBe(false)

    expect(dialog()).toBeNull()
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(false)
    expect(localStorage.getItem(VOICE_NOTICE_STORAGE_KEY)).toBeNull()
  })

  it('keeps engines apart: agreeing to one says nothing about another', () => {
    markVoiceNoticeSeen('browser', 'tap')
    expect(hasSeenVoiceNotice('cloud', 'tap')).toBe(false)
  })

  // Open mic and wake word say more (the microphone stays on), so the
  // tap notice does not cover them; theirs covers the tap one.
  it('asks again before a microphone that stays on, and that answer covers a tap', () => {
    markVoiceNoticeSeen('cloud', 'tap')
    expect(hasSeenVoiceNotice('cloud', 'push-to-talk')).toBe(true)
    expect(hasSeenVoiceNotice('cloud', 'open-mic')).toBe(false)
    expect(hasSeenVoiceNotice('cloud', 'wake-word')).toBe(false)

    markVoiceNoticeSeen('browser', 'wake-word')
    expect(hasSeenVoiceNotice('browser', 'open-mic')).toBe(true)
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(true)
  })

  it('answers no to a second request while one is open, so one Continue starts one thing', async () => {
    const first = confirmVoiceNotice({ provider: 'browser', mode: 'open-mic' })
    expect(await confirmVoiceNotice({ provider: 'browser', mode: 'tap' })).toBe(false)
    expect(document.querySelectorAll('dialog.voice-notice')).toHaveLength(1)
    press('continue')
    expect(await first).toBe(true)
  })

  it('hands focus back to where it was asked from', async () => {
    const mic = document.getElementById('mic')!
    const answer = confirmVoiceNotice({ provider: 'browser', mode: 'tap', returnFocus: mic })
    press('cancel')
    await answer
    expect(document.activeElement).toBe(mic)
  })

  it('reads a stored agreement, and ignores storage it cannot parse', () => {
    localStorage.setItem(VOICE_NOTICE_STORAGE_KEY, JSON.stringify(['cloud:always-on']))
    expect(hasSeenVoiceNotice('cloud', 'open-mic')).toBe(true)
    localStorage.setItem(VOICE_NOTICE_STORAGE_KEY, '{not json')
    expect(hasSeenVoiceNotice('cloud', 'open-mic')).toBe(false)
  })
})
