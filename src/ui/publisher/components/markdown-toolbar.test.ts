// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyAction,
  attachToolbar,
  renderMarkdownToolbar,
} from './markdown-toolbar'

function makeTextarea(
  value: string,
  selStart: number,
  selEnd = selStart,
): HTMLTextAreaElement {
  const ta = document.createElement('textarea')
  document.body.appendChild(ta)
  ta.value = value
  ta.setSelectionRange(selStart, selEnd)
  return ta
}

describe('applyAction — inline wrapping', () => {
  it('wraps a selection in ** for bold', () => {
    const ta = makeTextarea('the quick fox', 4, 9) // "quick"
    applyAction(ta, 'bold')
    expect(ta.value).toBe('the **quick** fox')
    // Inner selection so user can immediately overwrite.
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('quick')
  })

  it('inserts placeholder bold text when nothing is selected', () => {
    const ta = makeTextarea('cursor here|', 12) // end of buffer
    applyAction(ta, 'bold')
    expect(ta.value).toBe('cursor here|**bold text**')
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('bold text')
  })

  it('wraps a selection in * for italic', () => {
    const ta = makeTextarea('plain text here', 6, 10) // "text"
    applyAction(ta, 'italic')
    expect(ta.value).toBe('plain *text* here')
  })

  it('wraps a selection in ` for inline code', () => {
    const ta = makeTextarea('the npm run dev command', 4, 15) // "npm run dev"
    applyAction(ta, 'code-inline')
    expect(ta.value).toBe('the `npm run dev` command')
  })
})

describe('applyAction — links', () => {
  it('inserts [text](url) and cursors into the URL slot when nothing is selected', () => {
    const ta = makeTextarea('See ', 4)
    applyAction(ta, 'link')
    expect(ta.value).toBe('See [text](url)')
    // Cursor inside the URL placeholder.
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('url')
  })

  it('uses the selection as the link text and cursors into url', () => {
    const ta = makeTextarea('Click my homepage now', 6, 17) // "my homepage"
    applyAction(ta, 'link')
    expect(ta.value).toBe('Click [my homepage](url) now')
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('url')
  })
})

describe('applyAction — line prefixes', () => {
  it('prepends ## to the current line for headings', () => {
    const ta = makeTextarea('My title', 3) // cursor middle of line
    applyAction(ta, 'h2')
    expect(ta.value).toBe('## My title')
  })

  it('prepends ## to each line in a multi-line selection', () => {
    const ta = makeTextarea('alpha\nbeta\ngamma', 0, 16)
    applyAction(ta, 'h2')
    expect(ta.value).toBe('## alpha\n## beta\n## gamma')
  })

  it('prepends > for blockquote across whole lines', () => {
    const ta = makeTextarea('quote me\nand me', 2, 12) // selection spans two lines
    applyAction(ta, 'blockquote')
    expect(ta.value).toBe('> quote me\n> and me')
  })

  it('prepends - for bullet lists line-wise', () => {
    const ta = makeTextarea('one\ntwo\nthree', 0, 13)
    applyAction(ta, 'list-bullet')
    expect(ta.value).toBe('- one\n- two\n- three')
  })

  it('prepends 1. for numbered lists line-wise', () => {
    const ta = makeTextarea('item', 0)
    applyAction(ta, 'list-numbered')
    expect(ta.value).toBe('1. item')
  })

  it('extends prefix to the full line even when cursor is mid-line', () => {
    // Caret in the middle of "two" should still prefix the whole line.
    const ta = makeTextarea('one\ntwo\nthree', 5) // inside "two"
    applyAction(ta, 'list-bullet')
    expect(ta.value).toBe('one\n- two\nthree')
  })
})

describe('applyAction — code block', () => {
  it('wraps the selection in triple-backtick fences on their own lines', () => {
    const ta = makeTextarea('before\nconst x = 1\nafter', 7, 18) // "const x = 1"
    applyAction(ta, 'code-block')
    expect(ta.value).toBe('before\n```\nconst x = 1\n```\nafter')
  })

  it('uses placeholder text when nothing is selected', () => {
    const ta = makeTextarea('', 0)
    applyAction(ta, 'code-block')
    expect(ta.value).toBe('```\ncode\n```')
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('code')
  })

  it('inserts a leading newline when not already at a line start', () => {
    const ta = makeTextarea('inline text', 11) // end of buffer, no trailing newline
    applyAction(ta, 'code-block')
    expect(ta.value).toBe('inline text\n```\ncode\n```')
  })
})

describe('renderMarkdownToolbar + attachToolbar', () => {
  let toolbar: HTMLElement
  let textarea: HTMLTextAreaElement
  let onChange: ReturnType<typeof vi.fn<(newValue: string) => void>>

  beforeEach(() => {
    toolbar = renderMarkdownToolbar()
    document.body.appendChild(toolbar)
    textarea = document.createElement('textarea')
    textarea.value = 'hello world'
    document.body.appendChild(textarea)
    onChange = vi.fn<(newValue: string) => void>()
    attachToolbar(toolbar, textarea, { onChange })
  })

  it('renders all nine action buttons', () => {
    const buttons = toolbar.querySelectorAll('button[data-action]')
    expect(buttons.length).toBe(9)
    const actions = Array.from(buttons).map(b =>
      (b as HTMLButtonElement).dataset.action,
    )
    expect(actions).toEqual([
      'h2',
      'bold',
      'italic',
      'blockquote',
      'code-inline',
      'code-block',
      'link',
      'list-bullet',
      'list-numbered',
    ])
  })

  it('every button has an aria-label and a title attribute', () => {
    for (const btn of toolbar.querySelectorAll('button[data-action]')) {
      expect(btn.getAttribute('aria-label')?.length).toBeGreaterThan(0)
      expect(btn.getAttribute('title')?.length).toBeGreaterThan(0)
    }
  })

  it('marks the toolbar as a role=toolbar with an aria-label for AT users', () => {
    expect(toolbar.getAttribute('role')).toBe('toolbar')
    expect(toolbar.getAttribute('aria-label')).toBe('Markdown formatting')
  })

  it('clicking Bold wraps the selection and fires onChange with the new value', () => {
    textarea.setSelectionRange(0, 5) // "hello"
    const bold = toolbar.querySelector<HTMLButtonElement>('button[data-action="bold"]')!
    bold.click()
    expect(textarea.value).toBe('**hello** world')
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith('**hello** world')
  })

  it('clicking Link inserts [text](url) with cursor in the URL slot', () => {
    textarea.value = ''
    textarea.setSelectionRange(0, 0)
    const link = toolbar.querySelector<HTMLButtonElement>('button[data-action="link"]')!
    link.click()
    expect(textarea.value).toBe('[text](url)')
    expect(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd)).toBe(
      'url',
    )
  })

  it('a click on the toolbar background (not a button) is a no-op', () => {
    toolbar.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(onChange).not.toHaveBeenCalled()
    expect(textarea.value).toBe('hello world')
  })
})
