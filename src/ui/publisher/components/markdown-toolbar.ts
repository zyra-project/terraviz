// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GitHub-issue-style markdown toolbar over a `<textarea>`.
 *
 * Each button manipulates the textarea's value + selection state
 * directly via the DOM `setRangeText` API. State lives on the
 * textarea — we don't trigger a parent re-render, which would
 * lose focus and selection mid-action.
 *
 * Button list (matches the markdown subset our sanitiser
 * accepts):
 *
 *   H2 / Bold / Italic / Blockquote / Inline code / Code block /
 *   Link / Bullet list / Numbered list
 *
 * Wrapping vs prefixing:
 *
 *   - **Wrapping** buttons (Bold, Italic, Inline code, Link)
 *     surround the current selection with delimiters. With no
 *     selection, they insert placeholder text the user can
 *     immediately overwrite (`text`, `url` for the link arg).
 *   - **Prefixing** buttons (H2, Blockquote, Bullet, Numbered)
 *     prepend a token at the start of each selected line — same
 *     line-wise edit pattern GitHub uses.
 *   - **Block** buttons (Code block) wrap the selection in fenced
 *     triple-backticks on their own lines.
 *
 * After the edit, focus stays on the textarea and the selection
 * is set to the inserted text (so the user can immediately
 * overwrite the placeholder).
 */

import { t } from '../../../i18n'

export interface MarkdownToolbarOptions {
  /** Called whenever the toolbar mutates the textarea so the
   *  parent component can keep its own state in sync (e.g.
   *  `state.abstract = textarea.value`). */
  onChange: (newValue: string) => void
}

type Action =
  | 'h2'
  | 'bold'
  | 'italic'
  | 'blockquote'
  | 'code-inline'
  | 'code-block'
  | 'link'
  | 'list-bullet'
  | 'list-numbered'

interface ButtonSpec {
  action: Action
  /** Short label rendered inside the button. Empty string when
   *  the button uses only an icon glyph (e.g. `**B**`). */
  label: string
  ariaLabelKey: AriaLabelKey
  titleKey: TitleKey
}

type AriaLabelKey =
  | 'publisher.markdownToolbar.h2.aria'
  | 'publisher.markdownToolbar.bold.aria'
  | 'publisher.markdownToolbar.italic.aria'
  | 'publisher.markdownToolbar.blockquote.aria'
  | 'publisher.markdownToolbar.codeInline.aria'
  | 'publisher.markdownToolbar.codeBlock.aria'
  | 'publisher.markdownToolbar.link.aria'
  | 'publisher.markdownToolbar.listBullet.aria'
  | 'publisher.markdownToolbar.listNumbered.aria'

type TitleKey =
  | 'publisher.markdownToolbar.h2.title'
  | 'publisher.markdownToolbar.bold.title'
  | 'publisher.markdownToolbar.italic.title'
  | 'publisher.markdownToolbar.blockquote.title'
  | 'publisher.markdownToolbar.codeInline.title'
  | 'publisher.markdownToolbar.codeBlock.title'
  | 'publisher.markdownToolbar.link.title'
  | 'publisher.markdownToolbar.listBullet.title'
  | 'publisher.markdownToolbar.listNumbered.title'

const BUTTONS: ReadonlyArray<ButtonSpec> = [
  {
    action: 'h2',
    label: 'H',
    ariaLabelKey: 'publisher.markdownToolbar.h2.aria',
    titleKey: 'publisher.markdownToolbar.h2.title',
  },
  {
    action: 'bold',
    label: 'B',
    ariaLabelKey: 'publisher.markdownToolbar.bold.aria',
    titleKey: 'publisher.markdownToolbar.bold.title',
  },
  {
    action: 'italic',
    label: 'I',
    ariaLabelKey: 'publisher.markdownToolbar.italic.aria',
    titleKey: 'publisher.markdownToolbar.italic.title',
  },
  {
    action: 'blockquote',
    label: '❝',
    ariaLabelKey: 'publisher.markdownToolbar.blockquote.aria',
    titleKey: 'publisher.markdownToolbar.blockquote.title',
  },
  {
    action: 'code-inline',
    label: '<>',
    ariaLabelKey: 'publisher.markdownToolbar.codeInline.aria',
    titleKey: 'publisher.markdownToolbar.codeInline.title',
  },
  {
    action: 'code-block',
    label: '{ }',
    ariaLabelKey: 'publisher.markdownToolbar.codeBlock.aria',
    titleKey: 'publisher.markdownToolbar.codeBlock.title',
  },
  {
    action: 'link',
    label: '🔗',
    ariaLabelKey: 'publisher.markdownToolbar.link.aria',
    titleKey: 'publisher.markdownToolbar.link.title',
  },
  {
    action: 'list-bullet',
    label: '•',
    ariaLabelKey: 'publisher.markdownToolbar.listBullet.aria',
    titleKey: 'publisher.markdownToolbar.listBullet.title',
  },
  {
    action: 'list-numbered',
    label: '1.',
    ariaLabelKey: 'publisher.markdownToolbar.listNumbered.aria',
    titleKey: 'publisher.markdownToolbar.listNumbered.title',
  },
]

/**
 * Apply an action to the textarea. Pure transform — reads the
 * textarea's current state, computes the new state, writes it
 * back, and sets the selection so the user can keep typing in a
 * sensible place.
 *
 * Exported separately from the toolbar component so unit tests
 * can assert on the transform without spinning up a real
 * textarea + click pipeline.
 */
export function applyAction(textarea: HTMLTextAreaElement, action: Action): void {
  const value = textarea.value
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = value.slice(start, end)

  // Translator-supplied placeholder text the wrap helpers insert
  // when the publisher hasn't selected anything. Localized at
  // call time so a runtime locale switch picks up the right
  // strings on the next button press.
  const boldPlaceholder = t('publisher.markdownToolbar.placeholder.bold')
  const italicPlaceholder = t('publisher.markdownToolbar.placeholder.italic')
  const codePlaceholder = t('publisher.markdownToolbar.placeholder.code')
  const linkTextPlaceholder = t('publisher.markdownToolbar.placeholder.linkText')
  const linkUrlPlaceholder = t('publisher.markdownToolbar.placeholder.linkUrl')

  let result: { text: string; selStart: number; selEnd: number }
  switch (action) {
    case 'bold':
      result = wrap(value, start, end, selected, '**', '**', boldPlaceholder)
      break
    case 'italic':
      result = wrap(value, start, end, selected, '*', '*', italicPlaceholder)
      break
    case 'code-inline':
      result = wrap(value, start, end, selected, '`', '`', codePlaceholder)
      break
    case 'link': {
      // `[text](url)` — placeholder cursors into the URL slot
      // when no selection, into the text slot when there is one.
      // Both placeholders are translator-supplied so a non-English
      // locale gets a familiar word in its own language.
      const text = selected || linkTextPlaceholder
      const inserted = `[${text}](${linkUrlPlaceholder})`
      const newValue = value.slice(0, start) + inserted + value.slice(end)
      // Position cursor on the URL slot so the user can
      // immediately paste / type. The offset uses the actual
      // localized text length, not a hard-coded 3.
      const urlOffset = start + 1 + text.length + 2 // past `[text](`
      result = {
        text: newValue,
        selStart: urlOffset,
        selEnd: urlOffset + linkUrlPlaceholder.length,
      }
      break
    }
    case 'h2':
      result = prefixLines(value, start, end, '## ')
      break
    case 'blockquote':
      result = prefixLines(value, start, end, '> ')
      break
    case 'list-bullet':
      result = prefixLines(value, start, end, '- ')
      break
    case 'list-numbered':
      result = prefixLines(value, start, end, '1. ')
      break
    case 'code-block': {
      // Fenced code on its own lines. Ensure a blank line before
      // the opening fence if we're not already at a line start /
      // empty buffer.
      const needsLeading = start > 0 && value[start - 1] !== '\n'
      const open = (needsLeading ? '\n' : '') + '```\n'
      const close = '\n```'
      const innerText = selected || codePlaceholder
      const inserted = open + innerText + close
      const newValue = value.slice(0, start) + inserted + value.slice(end)
      const innerStart = start + open.length
      result = {
        text: newValue,
        selStart: innerStart,
        selEnd: innerStart + innerText.length,
      }
      break
    }
  }

  textarea.value = result.text
  textarea.setSelectionRange(result.selStart, result.selEnd)
  textarea.focus()
}

function wrap(
  value: string,
  start: number,
  end: number,
  selected: string,
  open: string,
  close: string,
  placeholder: string,
): { text: string; selStart: number; selEnd: number } {
  const inner = selected || placeholder
  const inserted = open + inner + close
  const text = value.slice(0, start) + inserted + value.slice(end)
  // Select the inner so the user can overwrite immediately.
  const innerStart = start + open.length
  return { text, selStart: innerStart, selEnd: innerStart + inner.length }
}

function prefixLines(
  value: string,
  start: number,
  end: number,
  prefix: string,
): { text: string; selStart: number; selEnd: number } {
  // Expand selection to whole-line boundaries.
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  const lineEnd = (() => {
    const next = value.indexOf('\n', end)
    return next === -1 ? value.length : next
  })()
  const region = value.slice(lineStart, lineEnd)
  const lines = region.length === 0 ? [''] : region.split('\n')
  const prefixed = lines.map(l => prefix + l).join('\n')
  const text = value.slice(0, lineStart) + prefixed + value.slice(lineEnd)
  // Select the prefixed region.
  return {
    text,
    selStart: lineStart,
    selEnd: lineStart + prefixed.length,
  }
}

/**
 * Build the toolbar DOM. Returns the `<div>` host with one
 * `<button>` per action. The caller appends it next to the
 * textarea it should drive, and passes the textarea via
 * `attachToolbar(toolbar, textarea, onChange)`.
 *
 * Splitting render vs attach lets the caller place the toolbar
 * in the DOM (e.g. inside a label row) and then wire it once
 * the textarea reference is available.
 */
export function renderMarkdownToolbar(): HTMLElement {
  const toolbar = document.createElement('div')
  toolbar.className = 'publisher-markdown-toolbar'
  toolbar.setAttribute('role', 'toolbar')
  toolbar.setAttribute('aria-label', t('publisher.markdownToolbar.aria'))

  for (const spec of BUTTONS) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = `publisher-markdown-toolbar-btn publisher-markdown-toolbar-${spec.action}`
    btn.textContent = spec.label
    btn.setAttribute('aria-label', t(spec.ariaLabelKey))
    btn.setAttribute('title', t(spec.titleKey))
    btn.dataset.action = spec.action
    toolbar.appendChild(btn)
  }
  return toolbar
}

/**
 * Attach the toolbar to its textarea. Wires each button to
 * `applyAction` and fires `onChange` after every mutation so the
 * parent component can keep its own state in sync.
 */
export function attachToolbar(
  toolbar: HTMLElement,
  textarea: HTMLTextAreaElement,
  options: MarkdownToolbarOptions,
): void {
  toolbar.addEventListener('click', e => {
    const target = e.target as HTMLElement | null
    if (!target) return
    const btn = target.closest('button[data-action]') as HTMLButtonElement | null
    if (!btn) return
    e.preventDefault()
    const action = btn.dataset.action as Action
    applyAction(textarea, action)
    options.onChange(textarea.value)
  })
}
