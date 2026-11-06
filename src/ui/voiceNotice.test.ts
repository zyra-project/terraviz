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
  noticeEngineFor,
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
    expect(voiceNoticeParagraphs('browser', 'tap', false)[0]).toBe('chat.voiceNotice.browser')
    expect(voiceNoticeParagraphs('browser', 'tap', true)[0]).toBe('chat.voiceNotice.browserDesktop')
    expect(voiceNoticeParagraphs('cloud', 'tap')[0]).toBe('chat.voiceNotice.cloud')
    expect(voiceNoticeParagraphs('cloud-live', 'open-mic')[0]).toBe('chat.voiceNotice.cloudLive')
    expect(voiceNoticeParagraphs('local', 'tap')[0]).toBe('chat.voiceNotice.local')
  })

  it('describes each mode, and says Not now turns a hands-free mode off', () => {
    expect(voiceNoticeParagraphs('browser', 'tap', false)).toEqual([
      'chat.voiceNotice.browser', 'chat.voiceNotice.sent', 'chat.voiceNotice.change',
    ])
    expect(voiceNoticeParagraphs('browser', 'push-to-talk', false)).toEqual([
      'chat.voiceNotice.browser', 'chat.voiceNotice.sent', 'chat.voiceNotice.pushToTalk', 'chat.voiceNotice.changeHandsFree',
    ])
    expect(voiceNoticeParagraphs('cloud', 'open-mic')).toEqual([
      'chat.voiceNotice.cloud', 'chat.voiceNotice.sent', 'chat.voiceNotice.openMic', 'chat.voiceNotice.changeHandsFree',
    ])
    expect(voiceNoticeParagraphs('cloud', 'wake-word')).toEqual([
      'chat.voiceNotice.cloud', 'chat.voiceNotice.sent', 'chat.voiceNotice.wakeWord', 'chat.voiceNotice.changeHandsFree',
    ])
  })

  it('treats only a live Cloud engine as Cloud live', () => {
    expect(noticeEngineFor({ provider: 'cloud', live: true })).toBe('cloud-live')
    expect(noticeEngineFor({ provider: 'cloud' })).toBe('cloud')
    expect(noticeEngineFor({ provider: 'browser', live: true })).toBe('browser')
  })

  it('is named by its title, described by where the audio goes, and opens on the title', () => {
    void confirmVoiceNotice({ engine: 'browser', mode: 'tap', desktop: false })
    const d = dialog()!
    expect(d.open).toBe(true)
    expect(d.querySelector('#' + d.getAttribute('aria-labelledby'))!.textContent).toBe('Before Orbit listens')
    expect(d.querySelector('#' + d.getAttribute('aria-describedby'))!.textContent).toContain('Chrome to Google')
    // Focus on the heading keeps the text in view and agreeing off the default.
    expect(document.activeElement).toBe(d.querySelector('#voice-notice-title'))
    expect(d.querySelector('.voice-notice-continue')!.textContent).toBe('Start listening')
  })

  it("adds the new-tab note to the policy link's name, after the words on screen", () => {
    void confirmVoiceNotice({ engine: 'browser', mode: 'tap', desktop: false })
    const link = dialog()!.querySelector('.voice-notice-policy a')!
    expect(link.hasAttribute('aria-label')).toBe(false)
    expect(link.textContent).toBe('Privacy policy (opens in a new tab)')
    expect(link.querySelector('.sr-only')!.textContent).toBe(' (opens in a new tab)')
  })

  // main.ts's document shortcuts take Space for play/pause and cancel its
  // default, which is what activates a focused button.
  it('keeps keys typed in it away from the page behind', () => {
    let reached = 0
    const count = (): void => { reached++ }
    document.addEventListener('keydown', count)
    try {
      void confirmVoiceNotice({ engine: 'browser', mode: 'tap' })
      dialog()!.querySelector('.voice-notice-continue')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
      expect(reached).toBe(0)
    } finally {
      document.removeEventListener('keydown', count)
    }
  })
})

describe('the gate', () => {
  it('starts nothing until Start listening, then remembers it', async () => {
    const answer = confirmVoiceNotice({ engine: 'browser', mode: 'tap' })
    expect(isVoiceNoticeOpen()).toBe(true)
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(false)
    press('continue')
    expect(await answer).toBe(true)
    expect(dialog()).toBeNull()
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(true)
    expect(JSON.parse(localStorage.getItem(VOICE_NOTICE_STORAGE_KEY)!)).toEqual(['browser@1'])
    // Agreed once, it does not ask again.
    expect(await confirmVoiceNotice({ engine: 'browser', mode: 'tap' })).toBe(true)
    expect(dialog()).toBeNull()
  })

  it('answers no to Not now, to Escape, and to a close from outside, and remembers none', async () => {
    const declined = confirmVoiceNotice({ engine: 'browser', mode: 'tap' })
    press('cancel')
    expect(await declined).toBe(false)

    const escaped = confirmVoiceNotice({ engine: 'browser', mode: 'tap' })
    dialog()!.dispatchEvent(new Event('cancel'))
    expect(await escaped).toBe(false)

    const closed = confirmVoiceNotice({ engine: 'browser', mode: 'tap' })
    closeVoiceNotice()
    expect(await closed).toBe(false)

    expect(dialog()).toBeNull()
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(false)
    expect(localStorage.getItem(VOICE_NOTICE_STORAGE_KEY)).toBeNull()
  })

  it('keeps engines apart, Cloud live included', () => {
    markVoiceNoticeSeen('browser', 'tap')
    expect(hasSeenVoiceNotice('cloud', 'tap')).toBe(false)
    markVoiceNoticeSeen('cloud', 'open-mic')
    expect(hasSeenVoiceNotice('cloud-live', 'open-mic')).toBe(false)
  })

  // Wake word promises no audio until the phrase; open mic sends whenever it
  // hears speech. Agreeing to one says nothing about the other.
  it('keeps open mic and wake word apart, and lets either cover a tap', () => {
    markVoiceNoticeSeen('browser', 'wake-word')
    expect(hasSeenVoiceNotice('browser', 'open-mic')).toBe(false)
    expect(hasSeenVoiceNotice('browser', 'tap')).toBe(true)
    expect(hasSeenVoiceNotice('browser', 'push-to-talk')).toBe(true)

    markVoiceNoticeSeen('cloud', 'tap')
    expect(hasSeenVoiceNotice('cloud', 'push-to-talk')).toBe(true)
    expect(hasSeenVoiceNotice('cloud', 'open-mic')).toBe(false)
    expect(hasSeenVoiceNotice('cloud', 'wake-word')).toBe(false)
  })

  it('answers no to a second request while one is open, so one agreement starts one thing', async () => {
    const first = confirmVoiceNotice({ engine: 'browser', mode: 'open-mic' })
    expect(await confirmVoiceNotice({ engine: 'browser', mode: 'tap' })).toBe(false)
    expect(document.querySelectorAll('dialog.voice-notice')).toHaveLength(1)
    press('continue')
    expect(await first).toBe(true)
  })

  it('hands focus back to where it was asked from', async () => {
    const mic = document.getElementById('mic')!
    const answer = confirmVoiceNotice({ engine: 'browser', mode: 'tap', returnFocus: mic })
    press('cancel')
    await answer
    expect(document.activeElement).toBe(mic)
  })

  // A notice whose facts change gets a new version, and asks everyone again.
  it('reads only agreements to the current version, and ignores storage it cannot parse', () => {
    localStorage.setItem(VOICE_NOTICE_STORAGE_KEY, JSON.stringify(['cloud:open-mic@1']))
    expect(hasSeenVoiceNotice('cloud', 'open-mic')).toBe(true)
    localStorage.setItem(VOICE_NOTICE_STORAGE_KEY, JSON.stringify(['cloud:open-mic@0', 'cloud:open-mic']))
    expect(hasSeenVoiceNotice('cloud', 'open-mic')).toBe(false)
    localStorage.setItem(VOICE_NOTICE_STORAGE_KEY, '{not json')
    expect(hasSeenVoiceNotice('cloud', 'open-mic')).toBe(false)
  })
})
