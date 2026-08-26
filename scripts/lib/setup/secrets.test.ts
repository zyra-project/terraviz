// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  appendVar,
  ensureSecrets,
  generateSigningKey,
  hasVar,
  NODE_KEY_VAR,
  PREVIEW_KEY_VAR,
} from './secrets'

describe('generateSigningKey', () => {
  it('produces 256 bits of base64', () => {
    const key = generateSigningKey()
    expect(Buffer.from(key, 'base64')).toHaveLength(32)
  })

  it('is not deterministic', () => {
    expect(generateSigningKey()).not.toBe(generateSigningKey())
  })
})

describe('hasVar', () => {
  it('finds an assignment with a value', () => {
    expect(hasVar('A=1\nPREVIEW_SIGNING_KEY=abc\n', PREVIEW_KEY_VAR)).toBe(true)
  })

  // `.dev.vars.example` ships `# PREVIEW_SIGNING_KEY=`. Treating that
  // as present would leave the preview endpoints failing closed with
  // nothing to show for it.
  it('does not count a commented-out line', () => {
    expect(hasVar('# PREVIEW_SIGNING_KEY=\n', PREVIEW_KEY_VAR)).toBe(false)
  })

  it('does not count an empty assignment', () => {
    expect(hasVar('PREVIEW_SIGNING_KEY=\n', PREVIEW_KEY_VAR)).toBe(false)
    expect(hasVar('PREVIEW_SIGNING_KEY=   \n', PREVIEW_KEY_VAR)).toBe(false)
  })

  it('does not match a different variable with the same suffix', () => {
    expect(hasVar('OLD_PREVIEW_SIGNING_KEY=x\n', PREVIEW_KEY_VAR)).toBe(false)
  })
})

describe('appendVar', () => {
  it('appends with a newline when the file lacks a trailing one', () => {
    const { text, added } = appendVar('A=1', 'B', '2')
    expect(added).toBe(true)
    expect(text).toContain('\nB=2\n')
    expect(text.startsWith('A=1\n')).toBe(true)
  })

  // A key already set may already be signing outstanding preview
  // tokens; silently rotating it would invalidate every one.
  it('leaves an existing assignment untouched', () => {
    const { text, added } = appendVar('B=original\n', 'B', 'replacement')
    expect(added).toBe(false)
    expect(text).toBe('B=original\n')
    expect(text).not.toContain('replacement')
  })

  it('handles an empty file', () => {
    const { text } = appendVar('', 'B', '2')
    expect(text).toContain('B=2')
  })
})

describe('ensureSecrets', () => {
  it('generates the preview key and leaves the node key to gen:node-key', () => {
    const { text, outcomes } = ensureSecrets(`${NODE_KEY_VAR}=abc\n`, () => 'GENERATED')
    expect(outcomes.find(o => o.name === NODE_KEY_VAR)?.status).toBe('present')
    expect(outcomes.find(o => o.name === PREVIEW_KEY_VAR)?.status).toBe('generated')
    expect(text).toContain(`${PREVIEW_KEY_VAR}=GENERATED`)
  })

  it('reports nothing to do when both are already set', () => {
    const { text, outcomes } = ensureSecrets(
      `${NODE_KEY_VAR}=abc\n${PREVIEW_KEY_VAR}=def\n`,
    )
    expect(text).toBeNull()
    expect(outcomes.every(o => o.status === 'present')).toBe(true)
  })

  // gen:node-key also writes node-public-key.txt (which init-node
  // reads in Phase 9) and stamps the local D1 row, so it stays the
  // single owner of the node keypair.
  it('names the command for the node key instead of generating one', () => {
    const { outcomes } = ensureSecrets(`${PREVIEW_KEY_VAR}=def\n`)
    const node = outcomes.find(o => o.name === NODE_KEY_VAR)!
    expect(node.status).toBe('manual')
    expect(node.action).toContain('gen:node-key')
    expect(node.action).toContain('node-public-key.txt')
  })

  it('refuses to create .dev.vars itself', () => {
    const { text, outcomes } = ensureSecrets(null)
    expect(text).toBeNull()
    expect(outcomes.every(o => o.status === 'manual')).toBe(true)
    expect(outcomes[0].action).toContain('0600')
  })

  it('never rotates an existing preview key', () => {
    const { text } = ensureSecrets(`${PREVIEW_KEY_VAR}=keep-me\n`, () => 'NEW')
    expect(text).toBeNull()
  })

  it('preserves the rest of the file when appending', () => {
    const original = `${NODE_KEY_VAR}=abc\nDEV_BYPASS_ACCESS=true\nMOCK_R2=true\n`
    const { text } = ensureSecrets(original, () => 'GEN')
    expect(text).toContain('DEV_BYPASS_ACCESS=true')
    expect(text).toContain('MOCK_R2=true')
    expect(text).toContain(`${NODE_KEY_VAR}=abc`)
  })
})
