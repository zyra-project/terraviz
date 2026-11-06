// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ARROW_OWNER_ROLES,
  SPACE_OWNER_ROLES,
  handlePlaybackKey,
  playbackShortcutFor,
  type PlaybackKeyActions,
  type ShortcutKeyEvent,
} from './playbackController'

function key(k: string, target: EventTarget | null, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    key: k,
    target,
    defaultPrevented: false,
    isComposing: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...extra,
  }
}

function el(html: string, inner?: string): HTMLElement {
  document.body.insertAdjacentHTML('beforeend', html)
  const host = document.body.lastElementChild as HTMLElement
  return inner ? host.querySelector<HTMLElement>(inner)! : host
}

const NAV_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End']

beforeEach(() => { document.body.innerHTML = '' })

describe('playbackShortcutFor', () => {
  it('maps the five bare keys to their actions with nothing focused', () => {
    expect(playbackShortcutFor(key(' ', document.body))).toBe('toggle')
    expect(playbackShortcutFor(key('ArrowLeft', document.body))).toBe('step-back')
    expect(playbackShortcutFor(key('ArrowRight', document.body))).toBe('step-forward')
    expect(playbackShortcutFor(key('Home', document.body))).toBe('start')
    expect(playbackShortcutFor(key('End', document.body))).toBe('end')
    expect(playbackShortcutFor(key('k', document.body))).toBeNull()
    // A target that is not an element (the document) is no one's.
    expect(playbackShortcutFor(key(' ', document))).toBe('toggle')
  })

  // A key outside the map, including one named like an object property,
  // is nobody's shortcut.
  it('knows only its own keys', () => {
    expect(playbackShortcutFor(key('toString', document.body))).toBeNull()
    expect(playbackShortcutFor(key('Space', document.body))).toBeNull()
  })

  // Space presses a button through its default action, which the handler
  // cancels; taking it here made Space do nothing on every focused control.
  it.each([
    ['a button', '<button>Settings</button>'],
    ['a link (Space scrolls its panel rather than act elsewhere)', '<a href="/privacy">Privacy</a>'],
    ['a role="button" header', '<div id="info-header" role="button" tabindex="0">Title</div>'],
    ['a text field', '<input type="text">'],
    ['a checkbox', '<input type="checkbox">'],
    ['a select', '<select><option>a</option></select>'],
    ['a text area', '<textarea></textarea>'],
    ['editable text', '<div contenteditable="true"></div>'],
    ['a video player', '<video controls></video>'],
    ['an audio player', '<audio controls></audio>'],
  ])('leaves Space to %s', (_, html) => {
    expect(playbackShortcutFor(key(' ', el(html)))).toBeNull()
  })

  it('leaves Space to a summary, which it opens, and to the control an inner element belongs to', () => {
    expect(playbackShortcutFor(key(' ', el('<details><summary>More</summary></details>', 'summary')))).toBeNull()
    expect(playbackShortcutFor(key(' ', el('<button><span class="icon">▶</span></button>', '.icon')))).toBeNull()
  })

  it.each(SPACE_OWNER_ROLES)('leaves Space to role="%s"', (role) => {
    expect(playbackShortcutFor(key(' ', el(`<div role="${role}" tabindex="0"></div>`)))).toBeNull()
  })

  // A focused list or grid acts on its current item, so it owns Space too.
  it.each(ARROW_OWNER_ROLES)('leaves Space and the arrows to role="%s"', (role) => {
    const target = el(`<div role="${role}" tabindex="0"></div>`)
    expect(playbackShortcutFor(key(' ', target))).toBeNull()
    for (const k of NAV_KEYS) expect(playbackShortcutFor(key(k, target))).toBeNull()
  })

  // The transport bar is a toolbar whose buttons are reached by Tab, so the
  // arrows keep stepping while one of them has focus.
  it('keeps the arrows, Home and End on a plain button in a toolbar', () => {
    const play = el('<div role="toolbar"><button id="play-btn">Play</button></div>', 'button')
    expect(playbackShortcutFor(key('ArrowRight', play))).toBe('step-forward')
    expect(playbackShortcutFor(key('Home', play))).toBe('start')
    expect(playbackShortcutFor(key(' ', play))).toBeNull()
  })

  it.each([
    ['a text field', '<input type="text">'],
    ['a range slider', '<input type="range">'],
    ['a select', '<select><option>a</option></select>'],
    ['a tab in a tab list', '<div role="tablist"><button role="tab">A</button></div>', 'button'],
    ['an option in a list', '<ul role="listbox"><li role="option" tabindex="0">A</li></ul>', 'li'],
    ['a radio group', '<div role="radiogroup"><span role="radio" tabindex="0">A</span></div>', 'span'],
    ['editable text', '<div contenteditable=""><p>text</p></div>', 'p'],
    ['a video player, which seeks with them', '<video controls></video>'],
  ])('leaves the arrows, Home and End to %s', (_, html, inner?: string) => {
    const target = el(html, inner)
    for (const k of NAV_KEYS) expect(playbackShortcutFor(key(k, target))).toBeNull()
  })

  it('does not treat contenteditable="false" as editable', () => {
    const target = el('<div contenteditable="false" tabindex="0"></div>')
    expect(playbackShortcutFor(key('ArrowLeft', target))).toBe('step-back')
    expect(playbackShortcutFor(key(' ', target))).toBe('toggle')
  })

  it.each([
    ['a role="dialog" panel', '<div role="dialog"><p tabindex="0">Help</p></div>'],
    ['a non-modal panel', '<div role="dialog" aria-modal="false"><p tabindex="0">Orbit</p></div>'],
    ['a modal <dialog>', '<dialog open><p tabindex="0">Notice</p></dialog>'],
    ['an alert dialog', '<div role="alertdialog"><p tabindex="0">Sure?</p></div>'],
    ['the open browse panel', '<div id="browse-overlay"><p tabindex="0">Catalog</p></div>'],
  ])('leaves every key to %s', (_, html) => {
    const inside = el(html, 'p')
    for (const k of [' ', ...NAV_KEYS]) expect(playbackShortcutFor(key(k, inside))).toBeNull()
  })

  it('takes keys again once the browse panel is hidden', () => {
    const inside = el('<div id="browse-overlay" class="hidden"><p tabindex="0">Catalog</p></div>', 'p')
    expect(playbackShortcutFor(key(' ', inside))).toBe('toggle')
  })

  // MapLibre cancels the arrows on a focused globe to pan it, before the
  // page's handler runs: there they move the view and step nothing.
  it('leaves the arrows a focused globe has already taken', () => {
    const canvas = el('<canvas class="maplibregl-canvas" tabindex="0"></canvas>')
    expect(playbackShortcutFor(key('ArrowLeft', canvas, { defaultPrevented: true }))).toBeNull()
    expect(playbackShortcutFor(key(' ', canvas))).toBe('toggle')
  })

  // Alt+Left is the browser's Back; Ctrl, Meta and Shift combinations belong
  // to the browser or the system.
  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const)('leaves a key held with %s alone', (modifier) => {
    expect(playbackShortcutFor(key('ArrowLeft', document.body, { [modifier]: true }))).toBeNull()
    expect(playbackShortcutFor(key(' ', document.body, { [modifier]: true }))).toBeNull()
  })

  it('leaves a key another handler took, or one inside an IME composition', () => {
    expect(playbackShortcutFor(key(' ', document.body, { defaultPrevented: true }))).toBeNull()
    expect(playbackShortcutFor(key(' ', document.body, { isComposing: true }))).toBeNull()
  })
})

describe('handlePlaybackKey', () => {
  type KeyEvent = Parameters<typeof handlePlaybackKey>[0]

  function press(k: string, target: EventTarget = document.body, repeat = false): KeyEvent & { prevented: boolean } {
    const event = {
      ...key(k, target),
      repeat,
      prevented: false,
      preventDefault() { this.prevented = true },
    }
    return event
  }

  function actions(state: { tour?: boolean; video?: boolean } = {}): PlaybackKeyActions & Record<string, ReturnType<typeof vi.fn>> {
    return {
      tourRunning: vi.fn(() => state.tour ?? false),
      toggleTour: vi.fn(),
      hasPlayback: vi.fn(() => state.video ?? true),
      toggle: vi.fn(),
      step: vi.fn(),
      rewind: vi.fn(),
      fastForward: vi.fn(),
    }
  }

  it('drives playback and takes the key', () => {
    const a = actions()
    for (const [k, call, arg] of [
      [' ', 'toggle', undefined],
      ['ArrowLeft', 'step', -1],
      ['ArrowRight', 'step', 1],
      ['Home', 'rewind', undefined],
      ['End', 'fastForward', undefined],
    ] as const) {
      const event = press(k)
      expect(handlePlaybackKey(event, a)).toBe(true)
      expect(event.prevented).toBe(true)
      if (arg === undefined) expect(a[call]).toHaveBeenCalled()
      else expect(a[call]).toHaveBeenLastCalledWith(arg)
    }
  })

  // One owner: a tour's Space no longer comes from a second handler that
  // cancelled it on focused buttons and toggled the dataset as well.
  it('gives Space to a running tour, and only to it', () => {
    const a = actions({ tour: true })
    expect(handlePlaybackKey(press(' '), a)).toBe(true)
    expect(a.toggleTour).toHaveBeenCalledTimes(1)
    expect(a.toggle).not.toHaveBeenCalled()
    // The arrows still step the dataset during a tour.
    handlePlaybackKey(press('ArrowRight'), a)
    expect(a.step).toHaveBeenCalledWith(1)
  })

  it('leaves Space on a focused button alone, tour or not', () => {
    const button = el('<button id="tour-stop-btn">Stop</button>')
    for (const tour of [true, false]) {
      const a = actions({ tour })
      const event = press(' ', button)
      expect(handlePlaybackKey(event, a)).toBe(false)
      expect(event.prevented).toBe(false)
      expect(a.toggleTour).not.toHaveBeenCalled()
      expect(a.toggle).not.toHaveBeenCalled()
    }
  })

  it('leaves a key with nothing to drive to its default', () => {
    const a = actions({ video: false })
    for (const k of [' ', 'Home', 'ArrowLeft']) {
      const event = press(k)
      expect(handlePlaybackKey(event, a)).toBe(false)
      expect(event.prevented).toBe(false)
    }
    // A tour still takes Space with no video loaded.
    const tour = actions({ tour: true, video: false })
    expect(handlePlaybackKey(press(' '), tour)).toBe(true)
    expect(tour.toggleTour).toHaveBeenCalled()
  })

  // Auto-repeat would toggle, and announce, thirty times a second.
  it('acts once for a held Space, but keeps stepping on a held arrow', () => {
    const a = actions()
    const held = press(' ', document.body, true)
    expect(handlePlaybackKey(held, a)).toBe(true)
    expect(held.prevented).toBe(true)
    expect(a.toggle).not.toHaveBeenCalled()
    handlePlaybackKey(press('ArrowRight', document.body, true), a)
    expect(a.step).toHaveBeenCalledWith(1)
  })
})
