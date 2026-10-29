// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { afterEach, describe, expect, it, vi } from 'vitest'
import { marked } from 'marked'
import {
  canonicalTag, cutProse, exhibitPlainText, exhibitProse, jsonBytes, machineValue, MARKDOWN_SOURCE_MAX, SOURCE_MAX,
} from './exhibit-text'

describe('exhibitPlainText', () => {
  it('takes Markdown out, keeping the words, only where it is asked to', () => {
    const md = 'A **bold** [link](https://example.org/x) and `code`.\n\n# Heading\n\n- one\n- two'
    expect(exhibitPlainText(md, { markdown: true })).toBe('A bold link and code. Heading one two')
    // A title is text: read as Markdown, it would lose its number.
    expect(exhibitPlainText('1. Hurricane Maria')).toBe('1. Hurricane Maria')
    expect(exhibitPlainText('# of fires per day')).toBe('# of fires per day')
  })

  it('reads each escape once, so escaped markup stays text', () => {
    for (const markdown of [false, true]) {
      expect(exhibitPlainText('Use the &lt;b&gt; tag', { markdown }), String(markdown)).toBe('Use the <b> tag')
      expect(exhibitPlainText('&amp;lt; is how', { markdown }), String(markdown)).toBe('&lt; is how')
    }
    // A bare &nbsp is still read where Markdown would escape its &.
    expect(exhibitPlainText('Voyager &nbsp and Cassini', { markdown: true })).toBe('Voyager and Cassini')
  })

  it('reads no name a JavaScript object carries as an entity', () => {
    expect(exhibitPlainText('Fish &constructor; chips &toString &valueOf;')).toBe('Fish &constructor; chips &toString &valueOf;')
  })

  it('cuts a long source at a word before reading it, and says so', () => {
    const long = 'word '.repeat(SOURCE_MAX)
    for (const [markdown, max] of [[false, SOURCE_MAX], [true, MARKDOWN_SOURCE_MAX]] as const) {
      const { text, cut } = exhibitProse(long, { markdown })
      expect(cut).toBe(true)
      expect(text.endsWith('word...')).toBe(true)
      expect(text.length).toBeLessThanOrEqual(max + 3)
    }
    expect(exhibitProse('short').cut).toBe(false)
    // White space past the bound isn't a cut.
    expect(exhibitProse(`Title${' '.repeat(SOURCE_MAX)}`)).toEqual({ text: 'Title', cut: false })
    // Nor is a cut that leaves no text a "...".
    expect(exhibitProse('<b>'.repeat(SOURCE_MAX))).toEqual({ text: '', cut: true })
  })

  afterEach(() => vi.restoreAllMocks())

  it('flattens a line\'s block markers past the limit before the parse sees them', () => {
    const parse = vi.spyOn(marked, 'parse')
    exhibitProse('1. '.repeat(1024), { markdown: true })
    const seen = parse.mock.calls[0][0] as string
    expect((seen.match(/1\./g) ?? []).length).toBe(8)
  })

  it('flattens only markers Markdown would read as markers', () => {
    // A list marker needs the space or tab after it, so these are text,
    // as they are to the parser itself.
    for (const text of ['1.2.3.4.5.6.7.8.9.10 is the section', '+------+------+', '1)2)3)4)5)6)7)8)9)10) steps']) {
      expect(exhibitPlainText(text, { markdown: true }), text).toBe(text)
    }
  })

  it('skips the parse for a source delimited past the limit', () => {
    const parse = vi.spyOn(marked, 'parse')
    exhibitProse('*a _b '.repeat(600), { markdown: true })
    expect(parse).not.toHaveBeenCalled()
    exhibitProse('A **bold** claim.', { markdown: true })
    expect(parse).toHaveBeenCalledTimes(1)
  })

  it('reads a source the parser throws on as HTML alone', () => {
    vi.spyOn(marked, 'parse').mockImplementation(() => { throw new RangeError('Maximum call stack size exceeded') })
    expect(exhibitProse('<p>Ocean **heat**</p>', { markdown: true })).toEqual({ text: 'Ocean **heat**', cut: false })
  })

  it('reads Markdown nested or delimited past any abstract without the costly parse', () => {
    // These overflowed the parser's stack or took 40 to 690 ms. Nesting
    // past the limit is flattened, so what is left parses as a shallow
    // list or quote; delimiters past the limit skip the parse, so the text
    // comes back as written.
    for (const unit of ['>', '1. ', '* - + ', '> 1. ']) {
      expect(() => exhibitProse(unit.repeat(Math.ceil(MARKDOWN_SOURCE_MAX / unit.length)), { markdown: true }), unit)
        .not.toThrow()
    }
    for (const unit of ['*a _b ', '![](', '`a']) {
      const { text } = exhibitProse(unit.repeat(Math.ceil(MARKDOWN_SOURCE_MAX / unit.length)), { markdown: true })
      expect(text.startsWith(unit.trim() + (unit.endsWith(' ') ? ' ' : '') + unit.trim()), unit).toBe(true)
    }
    // A few delimiters, as real abstracts have, are still read as Markdown.
    expect(exhibitPlainText('1. One\n2. **Two** [link](https://x)', { markdown: true })).toBe('One Two link')
  })

  it('takes HTML out by the info script\'s rules: inline tags join words, others break them', () => {
    expect(exhibitPlainText('<p>CO<sub>2</sub> rises.</p><p>Next</p>')).toBe('CO2 rises. Next')
    expect(exhibitPlainText('A <a href="https://x">USGS</a>, NOAA<br>Centre')).toBe('A USGS, NOAA Centre')
    expect(exhibitPlainText('<!-- a note --><div>Kept</div>')).toBe('Kept')
  })

  it('drops a tag a cut left open, as the catalog\'s 100-character organizations have', () => {
    expect(exhibitPlainText('NOAA Pacific Tsunami Warning Center, <a href="https://visibl')).toBe('NOAA Pacific Tsunami Warning Center,')
    expect(exhibitPlainText('Aquarium of the Pacific</')).toBe('Aquarium of the Pacific')
    expect(exhibitPlainText('Cassini and Voyager &nbsp <a href = "https://x">Albers</a>')).toBe('Cassini and Voyager Albers')
  })

  it('keeps a < that is text, as in a comparison', () => {
    expect(exhibitPlainText('Particles of size < 2.5 microns')).toBe('Particles of size < 2.5 microns')
  })

  it('reads entities, numeric ones included', () => {
    expect(exhibitPlainText('Fish &amp; chips &#233;t&#xE9; &mdash; 5&deg;C')).toBe('Fish & chips été — 5°C')
    expect(exhibitPlainText('One&nbsp;two')).toBe('One two')
  })

  it('drops what a script cannot hold, and makes every break a space', () => {
    const lone = String.fromCharCode(0xd800)
    expect(exhibitPlainText(`a\tb\u0001c\u0085d${lone}e﷐f￾g`)).toBe('a bcdefg')
    // A title of U+FDD0 would read back in LSL as JSON_INVALID.
    expect(exhibitPlainText('﷐')).toBe('')
  })

  it('folds runs of spaces and trims the ends', () => {
    expect(exhibitPlainText('  many    spaces  ')).toBe('many spaces')
    expect(exhibitPlainText(null)).toBe('')
  })
})

describe('cutProse', () => {
  it('leaves what fits alone', () => {
    expect(cutProse('Short.', 10)).toEqual({ text: 'Short.', cut: false })
  })

  it('cuts at a word, ending ..., within the cap as sent', () => {
    const { text, cut } = cutProse('The quick brown fox jumps over the lazy dog', 20)
    expect(cut).toBe(true)
    expect(text).toBe('The quick brown...')
    expect(jsonBytes(text)).toBeLessThanOrEqual(20)
  })

  it('counts escapes and multi-byte characters as sent', () => {
    for (const source of ['"'.repeat(100), '海'.repeat(100), '\\'.repeat(100), 'é'.repeat(100)]) {
      const { text } = cutProse(source, 48)
      expect(jsonBytes(text), source.slice(0, 1)).toBeLessThanOrEqual(48)
      expect(text.endsWith('...')).toBe(true)
    }
  })

  it('cuts a long text as a short one would, reading only its head', () => {
    // 100 characters, under the head it reads (the cap and 64 more), so
    // this one is read whole.
    const short = 'word '.repeat(20)
    expect(cutProse(short, 48).text).toBe('word word word word word word word word word...')
    expect(cutProse('word '.repeat(100_000), 48)).toEqual(cutProse(short, 48))
  })

  it('never splits a character in two, nor a grapheme', () => {
    expect(cutProse('😀'.repeat(30), 21).text).toBe('😀😀😀😀...')
    // An accent written as its own code point stays on its letter.
    expect(cutProse('e\u0301'.repeat(10), 8).text).toBe('e\u0301...')
  })

  it('gives nothing, not the whole text, when not one grapheme fits beside the ...', () => {
    // Once, a cut this short searched the whole text for a space.
    for (const [text, cap] of [['“Free to use” with credit to NOAA', 5], ['海 water and more', 4]] as const) {
      const out = cutProse(text, cap)
      expect(out, text).toEqual({ text: '', cut: true })
    }
  })

  it('keeps to a count of characters as well as the bytes, whichever binds', () => {
    // The characters bind: plenty of bytes, twenty UTF-16 units.
    const byChars = cutProse('word '.repeat(100), 1000, 20)
    expect(byChars).toEqual({ text: 'word word word...', cut: true })
    // The bytes bind: three bytes a character, 30 bytes.
    const byBytes = cutProse('海'.repeat(100), 30, 500)
    expect(jsonBytes(byBytes.text)).toBeLessThanOrEqual(30)
    expect(byBytes.text).toBe('海'.repeat(9) + '...')
    // What fits both is whole, and a count below a grapheme and its "..."
    // gives nothing, as a cap that small does.
    expect(cutProse('Short.', 1000, 6)).toEqual({ text: 'Short.', cut: false })
    expect(cutProse('Longer than three.', 1000, 3)).toEqual({ text: '', cut: true })
    // A grapheme of two units counts as two, and is never split.
    expect(cutProse('é'.repeat(100), 1000, 9).text).toBe('é'.repeat(3) + '...')
  })

  it('cuts as reading the whole text would, for any mix of characters and limits', () => {
    // A reference that segments everything and walks forward, against the
    // cut that reads only a head: they must agree whichever limit binds.
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    const reference = (text: string, cap: number, chars: number): { text: string; cut: boolean } => {
      const fits = (s: string): boolean => s.length <= chars && jsonBytes(s) <= cap
      if (fits(text)) return { text, cut: false }
      if (cap < 4 || chars < 4) return { text: '', cut: text !== '' }
      const parts = Array.from(segmenter.segment(text), g => g.segment)
      let lo = 0
      while (lo < parts.length && fits(parts.slice(0, lo + 1).join('').trimEnd() + '...')) ++lo
      if (lo === 0) return { text: '', cut: true }
      let end = lo
      const space = parts.lastIndexOf(' ', end - 1)
      if (space > (end * 2) / 3) end = space
      return { text: parts.slice(0, end).join('').trimEnd() + '...', cut: true }
    }
    const pieces = ['a', 'b', ' ', '海', '"', '\\', 'é', 'é', '😀', '👨‍👩‍👧', '🇺🇸']
    let seed = 20261027
    const next = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let i = 0; i < 600; i++) {
      const text = Array.from({ length: next(400) }, () => pieces[next(pieces.length)]).join('')
      const cap = 1 + next(300)
      const chars = next(4) === 0 ? Infinity : 1 + next(200)
      expect(cutProse(text, cap, chars), `${i}: cap ${cap}, chars ${chars}`).toEqual(reference(text, cap, chars))
    }
  })
})

describe('machineValue', () => {
  it('is the value whole when it matches and fits, else empty', () => {
    expect(machineValue('2024-06-01T00:00:00Z', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 24)).toBe('2024-06-01T00:00:00Z')
    expect(machineValue('June 2024', /^\d{4}/, 24)).toBe('')
    expect(machineValue('x'.repeat(30), /^x+$/, 24)).toBe('')
    expect(machineValue(null, /./, 24)).toBe('')
  })
})

describe('canonicalTag', () => {
  it('is NFC, trimmed, with what a script cannot hold dropped, and never cut', () => {
    expect(canonicalTag(' Water ')).toBe('Water')
    expect(canonicalTag('Névé')).toBe('Névé')
    expect(canonicalTag('Snow\u0000 and  Ice')).toBe('Snow and Ice')
    const long = 'a'.repeat(200)
    expect(canonicalTag(long)).toBe(long)
  })

  it('is its own canonical form', () => {
    // A control character dropped from between a letter and its accent
    // leaves a pair: NFC runs last, so the result composes.
    expect(canonicalTag('Ne\u0001\u0301ve')).toBe('Néve')
    for (const t of ['Ne\u0001\u0301ve', ' Snow\u0000 and  Ice ', 'e\u0301', 'A\ufdd0\u0301']) {
      expect(canonicalTag(canonicalTag(t)), JSON.stringify(t)).toBe(canonicalTag(t))
    }
  })
})
