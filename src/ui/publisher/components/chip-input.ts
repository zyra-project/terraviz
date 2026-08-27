// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Chip-input control — text input that converts entries into
 * removable chips as the user types.
 *
 * Used on the dataset form for keywords and tags (3pc/C3b);
 * categories may follow in a later sub-phase with a facet-aware
 * variant.
 *
 * Behaviour:
 *
 *   - Typing + Enter / comma / Tab → adds the current text as a
 *     chip and clears the input.
 *   - Blur with pending text → same as Enter (so a publisher who
 *     tabs out without pressing Enter still commits the value).
 *   - Backspace at an empty input → removes the most recent
 *     chip. Matches the chip-input convention publishers expect
 *     from GitHub / Gmail / etc.
 *   - Whitespace-only entries are rejected silently.
 *   - Duplicate entries (case-insensitive) are rejected silently.
 *   - Max chip count + max chip length are honoured if the
 *     caller supplies caps (validator-aligned by default).
 *   - Each chip has an explicit X button as the redundant /
 *     accessible removal path; keyboard users don't have to use
 *     backspace.
 *
 * Server-side validators (`validateStringArray` in
 * `functions/api/v1/_lib/validators.ts`) enforce the bounds; this
 * component applies the same caps client-side for immediate
 * feedback and to keep the rendered chip-set bounded.
 */

import { t, type MessageKey } from '../../../i18n'

export interface ChipInputOptions {
  id: string
  labelKey: MessageKey
  values: ReadonlyArray<string>
  placeholder?: string
  helpKey?: MessageKey
  /** Optional cap on number of chips. */
  max?: number
  /** Optional cap on individual chip length. */
  maxLength?: number
  onChange: (values: ReadonlyArray<string>) => void
}

/** Lowercase a value, trim, return null for whitespace-only. */
function normalize(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  return trimmed
}

/**
 * Pure transform: append `raw` to `current` after normalization.
 * Returns the unchanged array when the input is whitespace-only,
 * a case-insensitive duplicate, exceeds maxLength, or would push
 * past the max cap. Exported so unit tests can assert on the
 * transform without spinning up a real DOM input.
 */
export function appendChip(
  current: ReadonlyArray<string>,
  raw: string,
  caps: { max?: number; maxLength?: number } = {},
): ReadonlyArray<string> {
  const value = normalize(raw)
  if (!value) return current
  if (caps.maxLength && value.length > caps.maxLength) return current
  if (caps.max && current.length >= caps.max) return current
  // Case-insensitive de-dupe — keywords are tags by nature so
  // "Climate" and "climate" mean the same thing.
  const lower = value.toLowerCase()
  if (current.some(v => v.toLowerCase() === lower)) return current
  return [...current, value]
}

/** Pure transform: remove the chip at `index`. */
export function removeChipAt(
  current: ReadonlyArray<string>,
  index: number,
): ReadonlyArray<string> {
  if (index < 0 || index >= current.length) return current
  return current.slice(0, index).concat(current.slice(index + 1))
}

/**
 * Render the chip-input control. Returns the wrapper element;
 * the caller appends it into the form. The control owns its own
 * state internally (re-rendering chips on mutation); the
 * `onChange` callback fires after every successful add / remove
 * so the form's outer state can stay in sync.
 */
export function renderChipInput(opts: ChipInputOptions): HTMLElement {
  let values: ReadonlyArray<string> = [...opts.values]

  const wrap = document.createElement('div')
  wrap.className = 'publisher-form-field'

  const label = document.createElement('label')
  label.className = 'publisher-form-label'
  label.htmlFor = opts.id
  label.textContent = t(opts.labelKey)
  wrap.appendChild(label)

  const box = document.createElement('div')
  box.className = 'publisher-chip-input'

  const chipList = document.createElement('span')
  chipList.className = 'publisher-chip-list'
  chipList.setAttribute('role', 'list')
  box.appendChild(chipList)

  const input = document.createElement('input')
  input.type = 'text'
  input.id = opts.id
  input.className = 'publisher-chip-input-text'
  if (opts.placeholder) input.placeholder = opts.placeholder
  box.appendChild(input)

  wrap.appendChild(box)

  if (opts.helpKey) {
    const help = document.createElement('p')
    help.className = 'publisher-form-help'
    help.textContent = t(opts.helpKey)
    wrap.appendChild(help)
  }

  function renderChips(): void {
    chipList.replaceChildren()
    for (let i = 0; i < values.length; i++) {
      const v = values[i]
      const chip = document.createElement('span')
      chip.className = 'publisher-chip'
      chip.setAttribute('role', 'listitem')

      const text = document.createElement('span')
      text.className = 'publisher-chip-text'
      text.textContent = v
      chip.appendChild(text)

      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'publisher-chip-remove'
      x.setAttribute(
        'aria-label',
        t('publisher.chipInput.remove.aria', { value: v }),
      )
      x.textContent = '×'
      const indexAtRender = i
      x.addEventListener('click', () => {
        values = removeChipAt(values, indexAtRender)
        renderChips()
        input.focus()
        opts.onChange(values)
      })
      chip.appendChild(x)

      chipList.appendChild(chip)
    }
  }

  function commitInput(): void {
    if (!input.value) return
    const next = appendChip(values, input.value, {
      max: opts.max,
      maxLength: opts.maxLength,
    })
    if (next !== values) {
      values = next
      input.value = ''
      renderChips()
      opts.onChange(values)
    } else {
      // Normalisation rejected the value (whitespace-only,
      // duplicate, too long, over cap). Clear the input so the
      // user doesn't see their attempted entry hanging around.
      input.value = ''
    }
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      // Tab is intercepted only when there's pending text so we
      // don't trap focus when the user is moving on.
      if (e.key === 'Tab' && !input.value) return
      e.preventDefault()
      commitInput()
    } else if (e.key === 'Backspace' && input.value === '' && values.length > 0) {
      // Remove the trailing chip.
      values = removeChipAt(values, values.length - 1)
      renderChips()
      opts.onChange(values)
    }
  })

  input.addEventListener('blur', () => {
    commitInput()
  })

  // Clicking the box puts focus on the input — keeps the input
  // accessible even when the chip list takes most of the visual
  // width.
  box.addEventListener('click', e => {
    if (e.target === box || (e.target as Element).classList?.contains('publisher-chip-list')) {
      input.focus()
    }
  })

  renderChips()
  return wrap
}
