// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import { findViolations, stripComments } from './check-css-logical'

const at = (css: string) => findViolations('t.css', css)

describe('findViolations', () => {
  it('flags physical box properties and suggests the logical form', () => {
    expect(at('.a { padding-left: 1rem; }')[0]).toMatchObject({
      line: 1,
      suggest: 'padding-inline-start',
    })
    expect(at('.a { margin-right: 1rem; }')[0]).toMatchObject({ suggest: 'margin-inline-end' })
    expect(at('.a { border-left: 1px; }')[0]).toMatchObject({ suggest: 'border-inline-start' })
  })

  it('preserves the border sub-property when suggesting a fix', () => {
    expect(at('.a { border-right-color: red; }')[0]).toMatchObject({
      suggest: 'border-inline-end-color',
    })
  })

  it('flags directional text-align', () => {
    expect(at('.a { text-align: left; }')[0]).toMatchObject({ suggest: 'text-align: start' })
    expect(at('.a { text-align: right; }')[0]).toMatchObject({ suggest: 'text-align: end' })
  })

  it('leaves already-logical properties alone', () => {
    expect(at('.a { padding-inline-start: 1rem; text-align: start; }')).toEqual([])
    expect(at('.a { margin-inline-end: 0; border-inline-start: 1px; }')).toEqual([])
  })

  it('flags physical positional offsets', () => {
    expect(at('.a { right: 0; }')[0]).toMatchObject({ suggest: 'inset-inline-end' })
    expect(at('.a { left: -9999px; }')[0]).toMatchObject({ suggest: 'inset-inline-start' })
  })

  it('exempts the classic-centering 50% offset', () => {
    // `inset-inline-start: 50%` does not center under RTL, so the
    // physical property is correct here — see CLAUDE.md.
    expect(at('.a { left: 50%; transform: translate(-50%, -50%); }')).toEqual([])
    expect(at('.a { right: 50%; }')).toEqual([])
  })

  it('never inspects transforms, so RTL slide overrides pass', () => {
    expect(at(':root[dir="rtl"] .a { transform: translateX(-100%); }')).toEqual([])
  })

  it('honours an inline rtl-exempt annotation with a reason', () => {
    expect(at('.a { padding-left: 1rem; /* rtl-exempt: mirrors a fixed asset */ }')).toEqual([])
  })

  it('requires a reason on the exemption', () => {
    expect(at('.a { padding-left: 1rem; /* rtl-exempt: */ }')).toHaveLength(1)
    expect(at('.a { padding-left: 1rem; /* rtl-exempt */ }')).toHaveLength(1)
  })

  it('does not match properties named inside comments', () => {
    expect(at('/* avoid padding-left here */\n.a { color: red; }')).toEqual([])
  })

  it('reports accurate line numbers after a multi-line comment', () => {
    const css = '/* one\n two\n three */\n.a { margin-left: 1px; }'
    expect(at(css)[0]).toMatchObject({ line: 4 })
  })

  it('finds every violation on a single line', () => {
    expect(at('.a { padding-left: 1px; margin-right: 2px; }')).toHaveLength(2)
  })
})

describe('stripComments', () => {
  it('blanks comment bodies while preserving line count', () => {
    const out = stripComments('a\n/* x\n y */\nb')
    expect(out.split('\n')).toHaveLength(4)
    expect(out).not.toContain('x')
  })
})
