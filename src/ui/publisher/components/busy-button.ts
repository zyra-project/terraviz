// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * A button that stays focusable while its action runs.
 *
 * Setting `disabled` on the focused button sends focus to `<body>`,
 * which loses a keyboard or screen-reader user's place: the next Tab
 * starts from the top of the page, and a screen reader announces
 * nothing about where they are. `aria-disabled="true"` says the same
 * thing to assistive technology and keeps focus where it was, but it
 * does not stop the button firing, so every click handler that uses
 * this must return early while `busy` is set. The look comes from
 * `.publisher-button[aria-disabled='true']` in `publisher.css`.
 */
export interface BusyButton {
  readonly busy: boolean
  set(next: boolean): void
}

export function busyButton(button: HTMLButtonElement): BusyButton {
  let busy = false
  return {
    get busy(): boolean {
      return busy
    },
    set(next: boolean): void {
      busy = next
      if (next) button.setAttribute('aria-disabled', 'true')
      else button.removeAttribute('aria-disabled')
    },
  }
}
