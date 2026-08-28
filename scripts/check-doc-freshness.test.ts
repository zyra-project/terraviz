// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'

import {
  AGEING_AFTER_DAYS,
  STALE_AFTER_DAYS,
  classify,
  formatReport,
  readDocAge,
} from './check-doc-freshness'

const TODAY = new Date('2026-08-03T00:00:00Z')
const daysAgo = (n: number) =>
  new Date(TODAY.getTime() - n * 86_400_000).toISOString().slice(0, 10)

describe('readDocAge', () => {
  it('parses the bold marker the planning docs actually use', () => {
    const doc = `# Title\n\n**Last reviewed:** ${daysAgo(30)} (some parenthetical)\n`
    expect(readDocAge('d.md', doc, TODAY)).toMatchObject({ days: 30, status: 'current' })
  })

  it('parses a plain unbolded marker', () => {
    const doc = `Last reviewed: ${daysAgo(10)}\n`
    expect(readDocAge('d.md', doc, TODAY)?.days).toBe(10)
  })

  it('parses a marker with the colon outside the bold', () => {
    const doc = `**Last reviewed**: ${daysAgo(7)}\n`
    expect(readDocAge('d.md', doc, TODAY)?.days).toBe(7)
  })

  it('returns null for a doc with no marker — not a finding', () => {
    expect(readDocAge('d.md', '# Just a doc\n\nNo marker here.\n', TODAY)).toBeNull()
  })

  it('ignores prose that cites another doc\'s date without a colon', () => {
    // Real case: docs/CURRENT_EVENTS_PLAN.md describes federation-scoping's
    // review date in passing. An optional colon read that as the citing
    // doc's own marker, which would later send a reader to update a line
    // that is not a marker.
    const doc =
      'The planning artifact is [federation-scoping](x.md),\n' +
      '**Last reviewed 2026-05-04** — within the ~6-month window.\n'
    expect(readDocAge('d.md', doc, TODAY)).toBeNull()
  })

  it('still reads its own marker when the file also cites another date', () => {
    const doc =
      `**Last reviewed:** ${daysAgo(3)}\n\n` +
      'Elsewhere: **Last reviewed 2020-01-01** (quoting another doc).\n'
    expect(readDocAge('d.md', doc, TODAY)?.days).toBe(3)
  })

  it('returns null for an unparseable date rather than throwing', () => {
    expect(readDocAge('d.md', '**Last reviewed:** soon\n', TODAY)).toBeNull()
  })

  it('reads the first marker when a doc quotes the convention later', () => {
    const doc = `**Last reviewed:** ${daysAgo(5)}\n\nOther docs say "Last reviewed: 2020-01-01".\n`
    expect(readDocAge('d.md', doc, TODAY)?.days).toBe(5)
  })
})

describe('classify', () => {
  it('is current below the ageing threshold', () => {
    expect(classify(0)).toBe('current')
    expect(classify(AGEING_AFTER_DAYS - 1)).toBe('current')
  })

  it('is ageing between the thresholds', () => {
    expect(classify(AGEING_AFTER_DAYS)).toBe('ageing')
    expect(classify(STALE_AFTER_DAYS - 1)).toBe('ageing')
  })

  it('is stale at and beyond the stale threshold', () => {
    expect(classify(STALE_AFTER_DAYS)).toBe('stale')
    expect(classify(STALE_AFTER_DAYS + 400)).toBe('stale')
  })
})

describe('formatReport', () => {
  const age = (days: number, status: 'current' | 'ageing' | 'stale') => ({
    file: 'docs/x.md',
    reviewed: daysAgo(days),
    days,
    status,
  })

  it('is empty when everything is current, so a clean run prints nothing', () => {
    expect(formatReport([age(1, 'current'), age(2, 'current')])).toBe('')
  })

  it('names the flagged doc and its age', () => {
    const out = formatReport([age(200, 'stale')])
    expect(out).toContain('docs/x.md')
    expect(out).toContain('200d')
    expect(out).toContain('stale')
  })

  it('omits current docs from a report that flags others', () => {
    const out = formatReport([age(200, 'stale'), age(1, 'current')])
    expect(out).toContain('1 planning doc(s)')
  })

  it('says a fresh date is not sufficient, since Revisit-when is prose', () => {
    expect(formatReport([age(200, 'stale')])).toContain('necessary but not sufficient')
  })
})
