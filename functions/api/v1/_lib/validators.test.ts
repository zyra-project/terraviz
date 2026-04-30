/**
 * Tests for the publisher-API field validators.
 *
 * The validator surface is the system of record for the rules in
 * `CATALOG_PUBLISHING_TOOLS.md` "Validation rules" — mirroring it
 * here keeps the table and the runtime in lockstep when either
 * side changes.
 */

import { describe, expect, it } from 'vitest'
import {
  __internal,
  validateDraftCreate,
  validateDraftUpdate,
  validateForPublish,
  validateTourDraft,
} from './validators'

describe('hasControlChars', () => {
  it('allows ordinary text and ws (HT/LF/CR)', () => {
    expect(__internal.hasControlChars('Hello, world!')).toBe(false)
    expect(__internal.hasControlChars('one\ttab\nnewline\rcr')).toBe(false)
  })
  it('rejects strings containing C0 control or DEL', () => {
    expect(__internal.hasControlChars('null\x00byte')).toBe(true)
    expect(__internal.hasControlChars('\x07bell')).toBe(true)
    expect(__internal.hasControlChars('escape\x1b[1m')).toBe(true)
    expect(__internal.hasControlChars('del\x7f')).toBe(true)
  })
})

describe('looksLikeUrl', () => {
  it('accepts http(s)', () => {
    expect(__internal.looksLikeUrl('https://example.com')).toBe(true)
    expect(__internal.looksLikeUrl('http://example.com:8080/path?q=1')).toBe(true)
  })
  it('rejects bare strings, ftp, and javascript: pseudo-URLs', () => {
    expect(__internal.looksLikeUrl('not a url')).toBe(false)
    expect(__internal.looksLikeUrl('ftp://example.com')).toBe(false)
    expect(__internal.looksLikeUrl('javascript:alert(1)')).toBe(false)
  })
})

describe('deriveSlug', () => {
  it('lowercases, hyphenates, and trims', () => {
    expect(__internal.deriveSlug('Hurricane Helene 2024')).toBe('hurricane-helene-2024')
    expect(__internal.deriveSlug('  --Polar--  Vortex--  ')).toBe('polar-vortex')
  })

  it('prefixes `dataset-` when the title leads with a digit (1d/J)', () => {
    // The 1d SOS bulk import surfaced this — `validateDraftCreate`
    // accepts a digit-leading slug but `validateForPublish` doesn't.
    // The fix is here so the publisher API's auto-derived slug is
    // always publish-ready.
    expect(__internal.deriveSlug('360 Media - National Marine Sanctuaries'))
      .toBe('dataset-360-media-national-marine-sanctuaries')
    expect(__internal.deriveSlug('120 Years of Earthquakes'))
      .toBe('dataset-120-years-of-earthquakes')
  })

  it('falls back to `dataset` when the title contains no slug-able chars', () => {
    expect(__internal.deriveSlug('---')).toBe('dataset')
    expect(__internal.deriveSlug('   ')).toBe('dataset')
  })

  it('respects the 64-char cap even with the dataset- prefix', () => {
    const slug = __internal.deriveSlug('9' + 'a'.repeat(80))
    expect(slug.length).toBeLessThanOrEqual(64)
    expect(slug.startsWith('dataset-')).toBe(true)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('validateDraftCreate', () => {
  it('flags missing title and format', () => {
    const errors = validateDraftCreate({})
    const codes = errors.map(e => `${e.field}:${e.code}`)
    expect(codes).toContain('title:required')
    expect(codes).toContain('format:required')
  })

  it('rejects too-short and too-long titles', () => {
    expect(validateDraftCreate({ title: 'ab', format: 'video/mp4' }).map(e => e.code)).toContain(
      'too_short',
    )
    expect(
      validateDraftCreate({ title: 'a'.repeat(201), format: 'video/mp4' }).map(e => e.code),
    ).toContain('too_long')
  })

  it('accepts a valid minimal payload', () => {
    expect(validateDraftCreate({ title: 'Hello world', format: 'video/mp4' })).toEqual([])
  })

  it('rejects an unknown format', () => {
    const errs = validateDraftCreate({ title: 'Hi there', format: 'video/avi' })
    expect(errs.some(e => e.field === 'format' && e.code === 'invalid_value')).toBe(true)
  })

  it('rejects malformed and reserved slugs', () => {
    expect(
      validateDraftCreate({ title: 'A title', format: 'video/mp4', slug: 'BAD SLUG' }).map(
        e => e.code,
      ),
    ).toContain('invalid_format')
    expect(
      validateDraftCreate({ title: 'A title', format: 'video/mp4', slug: 'admin' }).map(
        e => e.code,
      ),
    ).toContain('reserved')
  })

  it('rejects an unsafe abstract', () => {
    const errs = validateDraftCreate({
      title: 'A title',
      format: 'video/mp4',
      abstract: '<script>alert(1)</script>',
    })
    expect(errs.some(e => e.field === 'abstract' && e.code === 'unsafe_html')).toBe(true)
  })

  it('caps categories at 6 entries', () => {
    const errs = validateDraftCreate({
      title: 'A title',
      format: 'video/mp4',
      categories: { Theme: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
    })
    expect(errs.some(e => e.field === 'categories' && e.code === 'too_many')).toBe(true)
  })

  it('flags invalid time range orientation', () => {
    const errs = validateDraftCreate({
      title: 'A title',
      format: 'video/mp4',
      start_time: '2026-02-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:00.000Z',
    })
    expect(errs.some(e => e.field === 'end_time' && e.code === 'before_start')).toBe(true)
  })

  it('accepts a legacy_id under 100 chars for bulk-imported rows', () => {
    expect(
      validateDraftCreate({
        title: 'Hurricane Helene',
        format: 'video/mp4',
        legacy_id: 'INTERNAL_SOS_768',
      }),
    ).toEqual([])
  })

  it('rejects an over-long legacy_id', () => {
    const errs = validateDraftCreate({
      title: 'X',
      format: 'video/mp4',
      legacy_id: 'L'.repeat(101),
    })
    expect(errs.some(e => e.field === 'legacy_id' && e.code === 'too_long')).toBe(true)
  })
})

describe('validateDraftUpdate', () => {
  it('treats every field as optional', () => {
    expect(validateDraftUpdate({})).toEqual([])
  })
  it('still rejects malformed fields when present', () => {
    const errs = validateDraftUpdate({ slug: 'BadSlug', visibility: 'maybe' })
    expect(errs.some(e => e.field === 'slug')).toBe(true)
    expect(errs.some(e => e.field === 'visibility')).toBe(true)
  })
})

describe('validateForPublish', () => {
  it('requires title, slug, format, data_ref, visibility, and license', () => {
    const errs = validateForPublish({})
    const fields = new Set(errs.map(e => e.field))
    expect(fields).toContain('title')
    expect(fields).toContain('slug')
    expect(fields).toContain('format')
    expect(fields).toContain('data_ref')
    expect(fields).toContain('visibility')
    expect(fields).toContain('license')
  })

  it('passes when all required fields are set', () => {
    expect(
      validateForPublish({
        title: 'My dataset',
        slug: 'my-dataset',
        format: 'video/mp4',
        data_ref: 'vimeo:1234567',
        visibility: 'public',
        license_spdx: 'CC-BY-4.0',
      }),
    ).toEqual([])
  })

  it('accepts license_statement as a license fallback', () => {
    expect(
      validateForPublish({
        title: 'My dataset',
        slug: 'my-dataset',
        format: 'video/mp4',
        data_ref: 'vimeo:1234567',
        visibility: 'public',
        license_statement: 'All rights reserved by NOAA.',
      }),
    ).toEqual([])
  })
})

describe('validateTourDraft', () => {
  it('requires a title', () => {
    expect(validateTourDraft({}).map(e => e.field)).toContain('title')
  })
  it('accepts a minimal valid body', () => {
    expect(validateTourDraft({ title: 'My tour' })).toEqual([])
  })
})
