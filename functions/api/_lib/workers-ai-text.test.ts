/**
 * Unit tests for the shared Workers AI reply-envelope extraction.
 * The envelope cases mirror what has been observed live: classic
 * `{ response }`, JSON-mode `{ response: object }`, OpenAI-shaped
 * `{ choices: [{ message }] }` (llama-4-scout), and `{ output_text }`.
 */

import { describe, expect, it } from 'vitest'
import { extractModelText, extractModelToolCalls } from './workers-ai-text'

describe('extractModelText', () => {
  it('reads the classic { response: string } envelope', () => {
    expect(extractModelText({ response: 'hello' })).toBe('hello')
  })

  it('re-serializes a JSON-mode { response: object } reply', () => {
    expect(extractModelText({ response: { a: 1 } })).toBe('{"a":1}')
  })

  it('reads the OpenAI choices[].message.content envelope', () => {
    expect(
      extractModelText({ choices: [{ message: { role: 'assistant', content: 'scout says' } }] }),
    ).toBe('scout says')
  })

  it('reads { output_text } and bare strings', () => {
    expect(extractModelText({ output_text: 'ot' })).toBe('ot')
    expect(extractModelText('bare')).toBe('bare')
  })

  it('returns null for empty or unrecognisable payloads', () => {
    expect(extractModelText({ response: '' })).toBeNull()
    expect(extractModelText({ choices: [{ message: { content: null } }] })).toBeNull()
    expect(extractModelText({ unrelated: true })).toBeNull()
    expect(extractModelText(null)).toBeNull()
    expect(extractModelText(42)).toBeNull()
  })
})

describe('extractModelToolCalls', () => {
  const calls = [{ id: 'c1', type: 'function', function: { name: 'load', arguments: '{}' } }]

  it('reads top-level tool_calls (classic Workers AI shape)', () => {
    expect(extractModelToolCalls({ response: '', tool_calls: calls })).toEqual(calls)
  })

  it('reads choices[].message.tool_calls (OpenAI shape)', () => {
    expect(
      extractModelToolCalls({ choices: [{ message: { content: null, tool_calls: calls } }] }),
    ).toEqual(calls)
  })

  it('returns null when the reply carries no tool calls', () => {
    expect(extractModelToolCalls({ response: 'just text' })).toBeNull()
    expect(extractModelToolCalls({ choices: [{ message: { content: 'text' } }] })).toBeNull()
    expect(extractModelToolCalls(null)).toBeNull()
  })
})
