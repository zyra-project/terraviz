// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  InteractivePrompter,
  NonInteractivePrompter,
  promptLine,
  renderQuestion,
  validators,
  wrap,
  type Question,
  type ReadlineLike,
} from './prompt'

function scripted(answers: string[]): { rl: ReadlineLike; asked: string[] } {
  const asked: string[] = []
  let i = 0
  return {
    asked,
    rl: {
      question: async (q: string) => {
        asked.push(q)
        return answers[i++] ?? ''
      },
      close: () => {},
    },
  }
}

function capture(): { out: { write: (s: string) => boolean }; text: () => string } {
  const chunks: string[] = []
  return {
    out: { write: (s: string) => (chunks.push(s), true) },
    text: () => chunks.join(''),
  }
}

const ACCOUNT: Question = {
  key: 'accountId',
  label: 'Account ID',
  validate: validators.accountId,
}

describe('validators', () => {
  it('accepts a 32-hex account id and rejects anything else', () => {
    expect(validators.accountId('8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f')).toBeNull()
    expect(validators.accountId('too-short')).toMatch(/32 hex/)
  })

  it('accepts a 64-hex AUD', () => {
    expect(validators.aud('a'.repeat(64))).toBeNull()
    expect(validators.aud('a'.repeat(32))).toMatch(/64 hex/)
  })

  // Silently stripping a scheme would store a value different from
  // the one the operator thinks they set.
  it('rejects a hostname with a scheme or path rather than fixing it', () => {
    expect(validators.hostname('https://a.example.org')).toMatch(/drop the https/)
    expect(validators.hostname('a.example.org/publish')).toMatch(/drop the path/)
    expect(validators.hostname('a.example.org')).toBeNull()
  })

  it('rejects a bare label with no dot', () => {
    expect(validators.hostname('localhost')).toMatch(/expected something like/)
  })

  // The Access policy is a suffix match on the domain; an address
  // here silently produces a policy that matches nobody.
  it('rejects an email address where a domain is wanted', () => {
    expect(validators.emailDomain('me@your-org.org')).toMatch(/a domain, not an address/)
    expect(validators.emailDomain('your-org.org')).toBeNull()
    expect(validators.emailDomain('@your-org.org')).toBeNull()
  })

  it('validates every entry in a domain list and names the bad one', () => {
    expect(validators.emailDomainList('a.org,b.org')).toBeNull()
    expect(validators.emailDomainList('a.org,nope')).toMatch(/"nope"/)
  })

  it('checks urls, repo slugs and project names', () => {
    expect(validators.url('https://a.example.org')).toBeNull()
    expect(validators.url('a.example.org')).toMatch(/full URL/)
    expect(validators.repoSlug('owner/repo')).toBeNull()
    expect(validators.repoSlug('owner')).toMatch(/owner\/repo/)
    expect(validators.projectName('my-node')).toBeNull()
    expect(validators.projectName('My_Node')).toMatch(/lowercase/)
  })
})

describe('renderQuestion / promptLine', () => {
  it('renders help lines and an example', () => {
    const text = renderQuestion({ key: 'k', label: 'L', help: ['one', 'two'], example: 'ex' })
    expect(text).toContain('one')
    expect(text).toContain('e.g. ex')
  })

  it('shows a default in brackets and marks optional questions', () => {
    expect(promptLine({ key: 'k', label: 'L', defaultValue: 'd' })).toContain('[d]')
    expect(promptLine({ key: 'k', label: 'L', optional: true })).toContain('optional')
  })
})

describe('InteractivePrompter', () => {
  it('re-prompts until the answer validates', async () => {
    const { rl, asked } = scripted(['bad', 'alsobad', '8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f'])
    const cap = capture()
    const p = new InteractivePrompter(rl, cap.out)
    expect(await p.ask(ACCOUNT)).toBe('8f4c1d2e9a7b6c5d4e3f2a1b0c9d8e7f')
    expect(asked).toHaveLength(3)
    expect(cap.text()).toContain('32 hex')
  })

  it('gives up after the attempt limit instead of looping forever', async () => {
    const { rl, asked } = scripted(['bad', 'bad', 'bad', 'bad'])
    const cap = capture()
    const p = new InteractivePrompter(rl, cap.out, () => {}, 3)
    expect(await p.ask(ACCOUNT)).toBeNull()
    expect(asked).toHaveLength(3)
    expect(cap.text()).toContain('set it later and re-run')
  })

  it('accepts the default on an empty answer', async () => {
    const { rl } = scripted([''])
    const p = new InteractivePrompter(rl, capture().out)
    expect(await p.ask({ key: 'k', label: 'L', defaultValue: 'terraviz' })).toBe('terraviz')
  })

  it('returns null for an empty optional answer', async () => {
    const { rl } = scripted([''])
    const p = new InteractivePrompter(rl, capture().out)
    expect(await p.ask({ key: 'k', label: 'L', optional: true })).toBeNull()
  })

  it('re-prompts on an empty answer to a required question', async () => {
    const { rl, asked } = scripted(['', 'value'])
    const cap = capture()
    const p = new InteractivePrompter(rl, cap.out)
    expect(await p.ask({ key: 'k', label: 'L' })).toBe('value')
    expect(asked).toHaveLength(2)
    expect(cap.text()).toContain('required')
  })

  it('trims whitespace', async () => {
    const { rl } = scripted(['  spaced  '])
    const p = new InteractivePrompter(rl, capture().out)
    expect(await p.ask({ key: 'k', label: 'L' })).toBe('spaced')
  })

  // Muting is what keeps the secret off the screen; the length
  // acknowledgement is what tells the operator it was received.
  it('mutes output while reading a secret and echoes only its length', async () => {
    const { rl } = scripted(['hunter2'])
    const cap = capture()
    const muteCalls: boolean[] = []
    const p = new InteractivePrompter(rl, cap.out, on => muteCalls.push(on))
    expect(await p.ask({ key: 'k', label: 'Token', secret: true })).toBe('hunter2')
    expect(muteCalls).toEqual([true, false])
    expect(cap.text()).toContain('(7 characters)')
    expect(cap.text()).not.toContain('hunter2')
  })

  // Muting is a process-wide side effect on stdout. Leaving it on
  // after a failed read means the operator types blind for the rest of
  // the run — including through whatever handles the failure.
  it('unmutes when the secret read rejects', async () => {
    const muteCalls: boolean[] = []
    const rl: ReadlineLike = {
      question: async () => {
        throw new Error('aborted')
      },
      close: () => {},
    }
    const p = new InteractivePrompter(rl, capture().out, on => muteCalls.push(on))
    await expect(p.ask({ key: 'k', label: 'Token', secret: true })).rejects.toThrow('aborted')
    expect(muteCalls).toEqual([true, false])
  })

  it('unmutes even when the secret answer is empty', async () => {
    const { rl } = scripted(['', 'x'])
    const muteCalls: boolean[] = []
    const p = new InteractivePrompter(rl, capture().out, on => muteCalls.push(on))
    await p.ask({ key: 'k', label: 'Token', secret: true, optional: true })
    expect(muteCalls.filter(m => m === false)).not.toHaveLength(0)
  })

  it('reads confirmations, honouring the default on an empty answer', async () => {
    const yes = new InteractivePrompter(scripted(['y']).rl, capture().out)
    expect(await yes.confirm('go?')).toBe(true)
    const blankDefaultNo = new InteractivePrompter(scripted(['']).rl, capture().out)
    expect(await blankDefaultNo.confirm('go?', false)).toBe(false)
    const blankDefaultYes = new InteractivePrompter(scripted(['']).rl, capture().out)
    expect(await blankDefaultYes.confirm('go?', true)).toBe(true)
    const no = new InteractivePrompter(scripted(['nope']).rl, capture().out)
    expect(await no.confirm('go?', true)).toBe(false)
  })
})

describe('NonInteractivePrompter', () => {
  // A prompt that blocks in CI burns the job timeout and logs nothing
  // useful; null lets the caller report the missing env var instead.
  it('never blocks and never guesses', async () => {
    const p = new NonInteractivePrompter(() => {})
    expect(await p.ask()).toBeNull()
    expect(await p.confirm()).toBe(false)
  })
})

describe('wrap', () => {
  it('breaks on word boundaries within the width', () => {
    const lines = wrap('the quick brown fox jumps over the lazy dog', 12)
    expect(lines.every(l => l.length <= 12)).toBe(true)
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog')
  })

  it('handles empty input and a single long word', () => {
    expect(wrap('', 10)).toEqual([])
    expect(wrap('supercalifragilistic', 5)).toEqual(['supercalifragilistic'])
  })
})
