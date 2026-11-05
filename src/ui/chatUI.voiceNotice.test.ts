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
        </select>
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
  it('is held off until the notice is agreed to, then armed', async () => {
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'open-mic' })
    startChat()
    expect(syncedModes).toEqual(['off'])
    expect(notice()!.textContent).toContain('the microphone stays on')
    press('continue')
    await settled()
    expect(syncedModes).toEqual(['off', 'open-mic'])
    expect(hasSeenVoiceNotice('browser', 'open-mic')).toBe(true)
  })

  it('is set back to Off on Not now, and the settings say so', async () => {
    saveConfig({ ...getDefaultConfig(), voiceHandsFree: 'open-mic' })
    startChat()
    press('cancel')
    await settled()
    expect(loadConfig().voiceHandsFree).toBe('off')
    expect((document.getElementById('chat-settings-voice-handsfree') as HTMLSelectElement).value).toBe('off')
    expect(announce).toHaveBeenLastCalledWith('Hands-free is off')
    expect(syncedModes).toEqual(['off'])
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
