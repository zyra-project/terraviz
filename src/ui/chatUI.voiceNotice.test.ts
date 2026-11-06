// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The chat's side of the first-use voice notice: no path that opens the
 * microphone may run before the notice for the engine that would hear
 * the user has been agreed to. The resolvers are mocked to hand the
 * chat a browser engine, and the hands-free controller's `sync` is
 * watched rather than run, since arming it for real needs a microphone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const engineStart = vi.fn()
/** Which engine the mocked single-tap resolver hands out. */
let tapProvider: 'browser' | 'cloud' = 'browser'
const browserEngine = {
  provider: 'browser' as const,
  supportsLanguage: () => true,
  isAvailable: () => true,
}

vi.mock('../services/voiceService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/voiceService')>()
  return {
    ...actual,
    resolveSttEngine: () => ({
      ...browserEngine,
      provider: tapProvider,
      start: () => { engineStart(); return { stop: vi.fn(), abort: vi.fn() } },
    }),
    resolveStreamingSttEngine: () => ({ ...browserEngine, startStreaming: vi.fn() }),
  }
})

vi.mock('../analytics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analytics')>()
  return { ...actual, emit: vi.fn() }
})

const { initChatUI, openChat, setOrbitAvailable } = await import('./chatUI')
const { loadConfig, saveConfig, getDefaultConfig } = await import('../services/docentService')
const { HandsFreeController } = await import('./voiceHandsFree')
const { resetOrbitAvailabilityForTests } = await import('../services/orbitAvailability')
const { markVoiceNoticeSeen, resetVoiceNoticeForTests, hasSeenVoiceNotice } = await import('./voiceNotice')

const announce = vi.fn()

function setupDOM(): void {
  document.body.innerHTML = `
    <button id="tools-menu-toggle"></button>
    <div id="tools-menu-popover" class="hidden">
      <button id="tools-menu-close"></button>
      <section class="tools-menu-section-orbit"><button id="tools-menu-orbit-settings"></button></section>
    </div>
    <button id="chat-trigger"></button>
    <div id="chat-dataset-prompt" class="hidden"></div>
    <div id="chat-panel" class="hidden">
      <button id="chat-close"></button>
      <div id="chat-settings" class="hidden">
        <select id="chat-settings-voice-handsfree">
          <option value="off">Off</option><option value="open-mic">Open mic</option>
          <option value="push-to-talk">Push to talk</option>
        </select>
        <button id="chat-settings-save" type="button"></button>
        <span id="chat-settings-status"></span>
      </div>
      <div id="chat-messages"></div>
      <textarea id="chat-input"></textarea>
      <button id="chat-mic"></button>
      <button id="chat-send"></button>
    </div>
  `
}

function startChat(): void {
  initChatUI({
    onLoadDataset: vi.fn(),
    onFlyTo: vi.fn(),
    getDatasets: () => [],
    getCurrentDataset: () => null,
    announce,
  } as unknown as Parameters<typeof initChatUI>[0])
}

function notice(): HTMLDialogElement | null {
  return document.querySelector('dialog.voice-notice')
}

function press(which: 'continue' | 'cancel'): void {
  notice()!.querySelector<HTMLButtonElement>(`.voice-notice-${which}`)!.click()
}

/** The notice settles, then its caller acts, on microtasks. */
async function settled(): Promise<void> {
  await vi.waitFor(() => expect(notice()).toBeNull())
  await Promise.resolve()
}

let syncedModes: string[]

beforeEach(() => {
  setupDOM()
  sessionStorage.clear()
  localStorage.clear()
  resetOrbitAvailabilityForTests()
  resetVoiceNoticeForTests()
  engineStart.mockClear()
  announce.mockClear()
  tapProvider = 'browser'
  syncedModes = []
  vi.spyOn(HandsFreeController.prototype, 'sync').mockImplementation(function (opts) {
    syncedModes.push(opts.mode)
  })
})

afterEach(() => {
  // Withdrawing ends a capture a test started: the chat holds it in
  // module state, so the next test's tap would stop it, not start one.
  setOrbitAvailable(false)
  setOrbitAvailable(true)
  resetVoiceNoticeForTests()
  vi.restoreAllMocks()
})

describe('a single tap on the microphone', () => {
  it('shows the notice first and starts nothing until Continue', async () => {
    startChat()
    openChat()
    document.getElementById('chat-mic')!.click()
    expect(notice()).not.toBeNull()
    expect(engineStart).not.toHaveBeenCalled()
    press('continue')
    await settled()
    expect(engineStart).toHaveBeenCalledTimes(1)
  })

  it('starts at once, inside the tap, once the notice has been agreed to', () => {
    markVoiceNoticeSeen('browser', 'tap')
    startChat()
    openChat()
    document.getElementById('chat-mic')!.click()
    expect(notice()).toBeNull()
    expect(engineStart).toHaveBeenCalledTimes(1)
  })

  // The capture resolves its engine again; one that changed while the
  // notice was open has not been agreed to.
  it('refuses to start through an engine other than the one agreed to', async () => {
    startChat()
    openChat()
    document.getElementById('chat-mic')!.click()
    tapProvider = 'cloud'
    press('continue')
    await settled()
    expect(engineStart).not.toHaveBeenCalled()
  })

  it('starts nothing on Not now, and asks again next time', async () => {
    startChat()
    openChat()
    document.getElementById('chat-mic')!.click()
    press('cancel')
    await settled()
    expect(engineStart).not.toHaveBeenCalled()
    document.getElementById('chat-mic')!.click()
    expect(notice()).not.toBeNull()
  })
})

describe('a hands-free mode', () => {
  it('is held off until the notice is agreed to, then armed, and says so', async () => {
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'open-mic' })
    startChat()
    expect(syncedModes).toEqual(['off'])
    expect(notice()!.textContent).toContain('the microphone turns on each time Terraviz opens here')
    press('continue')
    await settled()
    expect(syncedModes).toEqual(['off', 'open-mic'])
    expect(hasSeenVoiceNotice('browser', 'open-mic')).toBe(true)
    expect(announce).toHaveBeenLastCalledWith('Hands-free is on: Open mic')
  })

  it('is set back to Off on Not now, and the settings say so', async () => {
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'open-mic' })
    startChat()
    press('cancel')
    await settled()
    expect(loadConfig().voiceHandsFree).toBe('off')
    expect((document.getElementById('chat-settings-voice-handsfree') as HTMLSelectElement).value).toBe('off')
    expect(announce).toHaveBeenLastCalledWith('Hands-free is off. You can turn it on again in Orbit settings.')
    expect(syncedModes).toEqual(['off'])
  })

  // A modal over the splash would ask before the app is on screen, and
  // hide the splash's status from a screen reader.
  it('asks on load only once the loading screen has gone', async () => {
    document.body.insertAdjacentHTML('beforeend', '<div id="loading-screen" style="display: flex"></div>')
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'open-mic' })
    startChat()
    expect(syncedModes).toEqual(['off'])
    expect(notice()).toBeNull()
    document.getElementById('loading-screen')!.classList.add('fade-out')
    await vi.waitFor(() => expect(notice()).not.toBeNull())
  })

  // Saving opens the notice, and the modal hides the live region, so
  // "Settings saved" waits for the answer and goes out with it.
  it('folds "Settings saved" into what a notice opened by Save announces', async () => {
    startChat()
    openChat()
    announce.mockClear()
    ;(document.getElementById('chat-settings-voice-handsfree') as HTMLSelectElement).value = 'open-mic'
    document.getElementById('chat-settings-save')!.click()
    expect(notice()).not.toBeNull()
    expect(announce).not.toHaveBeenCalled()
    press('continue')
    await settled()
    expect(announce).toHaveBeenCalledTimes(1)
    expect(announce).toHaveBeenLastCalledWith('Settings saved. Hands-free is on: Open mic')
  })

  // Nothing captures before the first press, so that press asks, and the
  // agreement arms the mode rather than starting a single-tap capture.
  it('asks for push to talk at its first press, not on load', async () => {
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'push-to-talk' })
    startChat()
    openChat()
    expect(notice()).toBeNull()
    expect(syncedModes).toEqual(['off'])
    document.getElementById('chat-mic')!.click()
    expect(notice()!.textContent).toContain('only while you hold the microphone button down')
    press('continue')
    await settled()
    expect(syncedModes).toEqual(['off', 'push-to-talk'])
    expect(engineStart).not.toHaveBeenCalled()
    expect(announce).toHaveBeenLastCalledWith('Hands-free is on: Push to talk')
  })

  // The controller treats a wake word this build cannot run as Off, so a
  // notice would describe a mode that is not there.
  it('asks nothing for a stored wake word this build cannot run', () => {
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'wake-word' })
    startChat()
    expect(notice()).toBeNull()
  })

  it('is armed at once when already agreed to, with no notice', () => {
    markVoiceNoticeSeen('browser', 'open-mic')
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'open-mic' })
    startChat()
    expect(notice()).toBeNull()
    expect(syncedModes).toEqual(['open-mic'])
  })

  // The tap notice says nothing about a microphone left on.
  it('asks again when only the tap notice was agreed to', () => {
    markVoiceNoticeSeen('browser', 'tap')
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'open-mic' })
    startChat()
    expect(notice()).not.toBeNull()
    expect(syncedModes).toEqual(['off'])
  })
})
