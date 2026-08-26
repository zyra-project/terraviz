// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendChip, removeChipAt, renderChipInput } from './chip-input'

describe('appendChip — pure transform', () => {
  it('appends a non-empty value', () => {
    expect(appendChip(['a'], 'b')).toEqual(['a', 'b'])
  })

  it('trims whitespace before appending', () => {
    expect(appendChip([], '  hello  ')).toEqual(['hello'])
  })

  it('rejects whitespace-only input', () => {
    const current: ReadonlyArray<string> = ['a']
    expect(appendChip(current, '   ')).toBe(current)
  })

  it('rejects empty input', () => {
    const current: ReadonlyArray<string> = ['a']
    expect(appendChip(current, '')).toBe(current)
  })

  it('rejects case-insensitive duplicates', () => {
    const current: ReadonlyArray<string> = ['Climate']
    expect(appendChip(current, 'climate')).toBe(current)
    expect(appendChip(current, 'CLIMATE')).toBe(current)
  })

  it('honours max chip count', () => {
    const current: ReadonlyArray<string> = ['a', 'b', 'c']
    expect(appendChip(current, 'd', { max: 3 })).toBe(current)
    expect(appendChip(current, 'd', { max: 4 })).toEqual(['a', 'b', 'c', 'd'])
  })

  it('honours maxLength per chip', () => {
    const current: ReadonlyArray<string> = []
    const long = 'a'.repeat(41)
    expect(appendChip(current, long, { maxLength: 40 })).toBe(current)
    expect(appendChip(current, 'a'.repeat(40), { maxLength: 40 })).toHaveLength(1)
  })
})

describe('removeChipAt — pure transform', () => {
  it('removes the chip at the given index', () => {
    expect(removeChipAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  })

  it('removes the first chip', () => {
    expect(removeChipAt(['a', 'b'], 0)).toEqual(['b'])
  })

  it('removes the last chip', () => {
    expect(removeChipAt(['a', 'b'], 1)).toEqual(['a'])
  })

  it('returns the array unchanged for an out-of-range index', () => {
    const current: ReadonlyArray<string> = ['a', 'b']
    expect(removeChipAt(current, 5)).toBe(current)
    expect(removeChipAt(current, -1)).toBe(current)
  })
})

describe('renderChipInput — DOM behaviour', () => {
  let host: HTMLDivElement
  let onChange: ReturnType<typeof vi.fn<(values: ReadonlyArray<string>) => void>>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    onChange = vi.fn<(values: ReadonlyArray<string>) => void>()
  })

  function mount(initial: string[] = []): {
    input: HTMLInputElement
    chips: () => string[]
  } {
    const el = renderChipInput({
      id: 'test-chips',
      labelKey: 'publisher.datasetForm.field.keywords',
      values: initial,
      onChange,
    })
    host.appendChild(el)
    const input = host.querySelector<HTMLInputElement>('#test-chips')!
    const chips = (): string[] =>
      Array.from(host.querySelectorAll('.publisher-chip-text')).map(
        e => e.textContent ?? '',
      )
    return { input, chips }
  }

  function press(input: HTMLInputElement, key: string): void {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    )
  }

  it('renders the initial chips', () => {
    const { chips } = mount(['Climate', 'Ocean'])
    expect(chips()).toEqual(['Climate', 'Ocean'])
  })

  it('Enter commits the input as a new chip', () => {
    const { input, chips } = mount([])
    input.value = 'Atmosphere'
    press(input, 'Enter')
    expect(chips()).toEqual(['Atmosphere'])
    expect(input.value).toBe('')
    expect(onChange).toHaveBeenCalledWith(['Atmosphere'])
  })

  it('comma also commits the input', () => {
    const { input, chips } = mount([])
    input.value = 'sst'
    press(input, ',')
    expect(chips()).toEqual(['sst'])
  })

  it('Tab with pending text commits; Tab with empty text falls through', () => {
    const { input, chips } = mount(['existing'])

    // Tab on empty input should NOT preventDefault — focus should
    // move on as normal.
    const e1 = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(e1)
    expect(e1.defaultPrevented).toBe(false)
    expect(chips()).toEqual(['existing'])

    // Tab with pending text commits the chip.
    input.value = 'new-chip'
    const e2 = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    })
    input.dispatchEvent(e2)
    expect(e2.defaultPrevented).toBe(true)
    expect(chips()).toEqual(['existing', 'new-chip'])
  })

  it('blur with pending text commits as if Enter were pressed', () => {
    const { input, chips } = mount([])
    input.value = 'tagged'
    input.dispatchEvent(new Event('blur', { bubbles: true }))
    expect(chips()).toEqual(['tagged'])
  })

  it('Backspace on an empty input removes the trailing chip', () => {
    const { input, chips } = mount(['one', 'two'])
    expect(chips()).toEqual(['one', 'two'])
    input.value = ''
    press(input, 'Backspace')
    expect(chips()).toEqual(['one'])
    expect(onChange).toHaveBeenCalledWith(['one'])
  })

  it('Backspace with text in the input is ignored (lets the input edit normally)', () => {
    const { input, chips } = mount(['keep'])
    input.value = 'typing'
    press(input, 'Backspace')
    expect(chips()).toEqual(['keep'])
  })

  it('clicking a chip × removes that specific chip', () => {
    const { chips } = mount(['a', 'b', 'c'])
    const removes = host.querySelectorAll<HTMLButtonElement>('.publisher-chip-remove')
    removes[1].click() // remove "b"
    expect(chips()).toEqual(['a', 'c'])
    expect(onChange).toHaveBeenCalledWith(['a', 'c'])
  })

  it('the × button carries an aria-label that names the chip being removed', () => {
    mount(['climate'])
    const x = host.querySelector<HTMLButtonElement>('.publisher-chip-remove')
    expect(x?.getAttribute('aria-label')).toBe('Remove climate')
  })

  it('rejects whitespace-only entries silently and clears the input', () => {
    const { input, chips } = mount([])
    input.value = '   '
    press(input, 'Enter')
    expect(chips()).toEqual([])
    expect(input.value).toBe('')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('rejects duplicates silently', () => {
    const { input, chips } = mount(['Climate'])
    input.value = 'climate'
    press(input, 'Enter')
    expect(chips()).toEqual(['Climate'])
    expect(input.value).toBe('')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('respects the max chip cap', () => {
    const el = renderChipInput({
      id: 'capped',
      labelKey: 'publisher.datasetForm.field.keywords',
      values: ['a', 'b'],
      max: 2,
      onChange,
    })
    host.appendChild(el)
    const input = host.querySelector<HTMLInputElement>('#capped')!
    input.value = 'c'
    press(input, 'Enter')
    const chips = Array.from(host.querySelectorAll('.publisher-chip-text')).map(
      e => e.textContent,
    )
    expect(chips).toEqual(['a', 'b'])
    expect(onChange).not.toHaveBeenCalled()
  })
})
