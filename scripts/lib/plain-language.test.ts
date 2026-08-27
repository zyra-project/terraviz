// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  isMostlyQuotation,
  longSentences,
  measure,
  sentences,
  stripHtmlToProse,
  stripToProse,
  syllables,
  wordCount,
} from './plain-language'

describe('stripToProse', () => {
  it('drops fenced code, tables and headings', () => {
    const out = stripToProse(
      '# Phase 2\n\nRun it.\n\n```bash\nnpm run setup -- --apply\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDone.',
    )
    expect(out).toContain('Run it.')
    expect(out).toContain('Done.')
    expect(out).not.toContain('npm run setup')
    expect(out).not.toContain('Phase 2')
    expect(out).not.toMatch(/\|/)
  })

  // A 4-space indent rule looks like it removes code blocks. In this
  // guide it removes the continuation lines of numbered items instead,
  // welding one item's opening clause to the next and reporting the
  // splice as a long sentence.
  it('keeps the continuation lines of a numbered list', () => {
    const out = stripToProse(
      '10. `npm run dev:functions` cannot run on a fresh clone, contrary\n' +
        '    to the mock-mode claims in `.dev.vars.example`.\n\n' +
        '11. The migration order was backwards.',
    )
    expect(out).toContain('cannot run on a fresh clone, contrary to the mock-mode claims')
  })

  // Without this, "What that risk is bounded by:" welds onto its
  // first bullet and the pair is reported as one long sentence.
  it('treats a colon lead-in as a boundary before its list', () => {
    const out = stripToProse('What it covers:\n\n- The first item.\n- The second item.')
    expect(sentences(out)).toHaveLength(3)
  })

  it('keeps link text and drops the URL', () => {
    expect(stripToProse('See [the guide](https://example.org/x) first.')).toBe(
      'See the guide first.',
    )
  })
})

describe('stripHtmlToProse', () => {
  // Measuring every text node turns the worksheet grid and dependency
  // map into "sentences" that are tables read aloud.
  it('measures paragraphs and ignores the rest of the page', () => {
    const out = stripHtmlToProse(
      '<nav><a>Before you begin</a><a>What it costs</a></nav>' +
        '<table><tr><td>W1</td><td>Cloudflare account ID</td></tr></table>' +
        '<p>This is the prose.</p>',
    )
    expect(out).toBe('This is the prose.')
  })

  // Paragraph breaks are sentence boundaries even when the author
  // did not end the paragraph with a full stop.
  it('does not weld an unpunctuated paragraph onto the next', () => {
    const out = stripHtmlToProse('<p>What it costs</p><p>Less than you think.</p>')
    expect(sentences(out)).toHaveLength(2)
  })

  it('does not double-unescape an entity the document spells out', () => {
    // `&amp;lt;` is how a page writes a literal `&lt;` for the reader. Decoding
    // `&amp;` before `&lt;` turns it into a real `<`, which then reads as a tag
    // rather than as the text the author wrote.
    expect(stripHtmlToProse('<p>Write &amp;lt;p&amp;gt; to show a tag.</p>')).toBe(
      'Write &lt;p&gt; to show a tag.',
    )
  })

  it('still decodes a plain ampersand', () => {
    expect(stripHtmlToProse('<p>Search &amp; rescue.</p>')).toBe('Search & rescue.')
  })

  it('replaces code spans rather than reading them as words', () => {
    expect(stripHtmlToProse('<p>Run <code>npm run setup</code> now.</p>')).toBe(
      'Run CODE now.',
    )
  })
})

describe('sentences', () => {
  it('does not split on abbreviations or decimals', () => {
    expect(sentences('Use a value, e.g. 4.5 GB, then continue onward here.')).toHaveLength(1)
  })

  // A click path is an instruction, not a sentence; counting its words
  // as sentence length is how this check starts reporting nonsense.
  it('ignores UI click paths', () => {
    expect(sentences('Zero Trust → Access → Applications → Add an application.')).toEqual([])
  })

  it('ends a sentence whose full stop sits inside a bracket', () => {
    expect(sentences('It runs first. (That order matters here.) Then it stops.')).toHaveLength(3)
  })

  it('splits on real sentence boundaries', () => {
    expect(sentences('This is one sentence here. And this is a second one.')).toHaveLength(2)
  })
})

describe('isMostlyQuotation', () => {
  // We quote GitHub's and Cloudflare's terms verbatim on purpose.
  // Trimming someone else's policy to satisfy a word count would be
  // the wrong fix.
  it('exempts a sentence that is mostly someone else quoted', () => {
    expect(
      isMostlyQuotation(
        'GitHub says "GitHub Actions usage is free for self-hosted runners and for public repositories that use standard GitHub-hosted runners."',
      ),
    ).toBe(true)
  })

  it('does not exempt our own long prose with a short quote in it', () => {
    expect(
      isMostlyQuotation(
        'The setup tool provisions the resources, rewrites the config, applies the migrations in the order that actually works, and then reports "done" at the end of it all.',
      ),
    ).toBe(false)
  })
})

describe('measure', () => {
  it('reports sentence length and readability', () => {
    const m = measure('The cat sat. The dog ran fast today.')
    expect(m.sentences).toBe(2)
    expect(m.averageSentenceWords).toBeCloseTo(4, 1)
    expect(m.readingEase).toBeGreaterThan(80)
  })

  it('survives empty input', () => {
    expect(measure('').sentences).toBe(0)
  })
})

describe('longSentences', () => {
  const long = `This sentence has been written deliberately so that it runs well past the limit that the checker enforces, going on and on with clause after clause until any reader would lose the thread entirely.`

  it('finds sentences over the limit, worst first', () => {
    const found = longSentences(`Short one here. ${long}`, 30)
    expect(found).toHaveLength(1)
    expect(found[0].words).toBeGreaterThan(30)
  })

  it('leaves quotations alone', () => {
    const quoted = `The docs say "${long}"`
    expect(longSentences(quoted, 30)).toHaveLength(0)
  })
})

describe('helpers', () => {
  it('counts words and syllables plausibly', () => {
    expect(wordCount("it's a test-case")).toBe(3)
    expect(syllables('setup')).toBe(2)
    expect(syllables('a')).toBe(1)
    expect(syllables('')).toBe(0)
  })
})
