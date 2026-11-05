// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it } from 'vitest'
import { playbackShortcutFor, type ShortcutKeyEvent } from './playbackController'

function key(code: string, target: EventTarget | null, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent {
  return {
    code,
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

function el(html: string): HTMLElement {
  document.body.insertAdjacentHTML('beforeend', html)
  return document.body.lastElementChild as HTMLElement
}

beforeEach(() => { document.body.innerHTML = '' })

describe('playbackShortcutFor', () => {
  it('maps the five bare keys to their actions with nothing focused', () => {
    expect(playbackShortcutFor(key('Space', document.body))).toBe('toggle')
    expect(playbackShortcutFor(key('ArrowLeft', document.body))).toBe('step-back')
    expect(playbackShortcutFor(key('ArrowRight', document.body))).toBe('step-forward')
    expect(playbackShortcutFor(key('Home', document.body))).toBe('start')
    expect(playbackShortcutFor(key('End', document.body))).toBe('end')
    expect(playbackShortcutFor(key('KeyK', document.body))).toBeNull()
    // A target that is not an element (the document, the window) is no one's.
    expect(playbackShortcutFor(key('Space', document))).toBe('toggle')
  })

  // Space presses a button through its default action, which the handler
  // cancels; taking it here made Space do nothing on every focused control.
  it.each([
    ['a button', '<button>Settings</button>'],
    ['a link', '<a href="/privacy">Privacy</a>'],
    ['a switch', '<div role="switch" tabindex="0"></div>'],
    ['a tab', '<div role="tab" tabindex="0"></div>'],
    ['a menu item', '<div role="menuitem" tabindex="0"></div>'],
    ['a list with focus', '<div role="listbox" tabindex="0"></div>'],
    ['a text field', '<input type="text">'],
    ['a checkbox', '<input type="checkbox">'],
    ['a select', '<select><option>a</option></select>'],
    ['a text area', '<textarea></textarea>'],
    ['editable text', '<div contenteditable="true"></div>'],
  ])('leaves Space to %s', (_, html) => {
    expect(playbackShortcutFor(key('Space', el(html)))).toBeNull()
  })

  it('leaves Space to a summary, which it opens', () => {
    const summary = el('<details><summary>More</summary></details>').querySelector('summary')!
    expect(playbackShortcutFor(key('Space', summary))).toBeNull()
  })

  it('leaves Space to the control an inner element belongs to', () => {
    const icon = el('<button><span class="icon">▶</span></button>').querySelector('.icon')!
    expect(playbackShortcutFor(key('Space', icon))).toBeNull()
  })

  // The transport bar is a toolbar whose buttons are reached by Tab, so the
  // arrows keep stepping while one of them has focus.
  it('keeps the arrows, Home and End on a plain button', () => {
    const play = el('<div role="toolbar"><button id="play-btn">Play</button></div>').querySelector('button')!
    expect(playbackShortcutFor(key('ArrowRight', play))).toBe('step-forward')
    expect(playbackShortcutFor(key('Home', play))).toBe('start')
    expect(playbackShortcutFor(key('Space', play))).toBeNull()
  })

  it.each([
    ['a text field', '<input type="text">'],
    ['a range slider', '<input type="range">'],
    ['a select', '<select><option>a</option></select>'],
    ['a tab in a tab list', '<div role="tablist"><button role="tab">A</button></div>', 'button'],
    ['an option in a list', '<ul role="listbox"><li role="option" tabindex="0">A</li></ul>', 'li'],
    ['an ARIA slider', '<div role="slider" tabindex="0"></div>'],
    ['a radio group', '<div role="radiogroup"><span role="radio" tabindex="0">A</span></div>', 'span'],
    ['editable text', '<div contenteditable=""><p>text</p></div>', 'p'],
  ])('leaves the arrows, Home and End to %s', (_, html, inner?: string) => {
    const host = el(html)
    const target = inner ? host.querySelector(inner)! : host
    for (const code of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(playbackShortcutFor(key(code, target))).toBeNull()
    }
  })

  it.each([
    ['a role="dialog" panel', '<div role="dialog"><p tabindex="0">Help</p></div>'],
    ['a modal <dialog>', '<dialog open><p tabindex="0">Notice</p></dialog>'],
    ['an alert dialog', '<div role="alertdialog"><p tabindex="0">Sure?</p></div>'],
  ])('leaves every key to %s', (_, html) => {
    const inside = el(html).querySelector('p')!
    for (const code of ['Space', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      expect(playbackShortcutFor(key(code, inside))).toBeNull()
    }
  })

  // Alt+Left is the browser's Back; Ctrl, Meta and Shift combinations belong
  // to the browser or the system.
  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const)('leaves a key held with %s alone', (modifier) => {
    expect(playbackShortcutFor(key('ArrowLeft', document.body, { [modifier]: true }))).toBeNull()
    expect(playbackShortcutFor(key('Space', document.body, { [modifier]: true }))).toBeNull()
  })

  it('leaves a key another handler took, or one inside an IME composition', () => {
    expect(playbackShortcutFor(key('Space', document.body, { defaultPrevented: true }))).toBeNull()
    expect(playbackShortcutFor(key('Space', document.body, { isComposing: true }))).toBeNull()
  })
})
