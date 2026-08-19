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
    // The 1d SOS bulk import surfaced this — drafts can omit `slug`,
    // so the publisher API derives one later from the title via
    // `deriveSlug`. The fix is here so the auto-derived slug is
    // always publish-ready, even when the title starts with a digit
    // (the validator's SLUG_RE requires a leading [a-z]).
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
      title: 'Color table row',
      format: 'video/mp4',
      legacy_id: 'L'.repeat(101),
    })
    expect(errs.some(e => e.field === 'legacy_id' && e.code === 'too_long')).toBe(true)
  })

  it('rejects an empty / whitespace-only legacy_id (1d/O)', () => {
    // Pre-1d/O an empty string slipped past the createDataset 409
    // pre-check (which truthy-checks `body.legacy_id`) and only
    // failed at the SQLite UNIQUE-index level — opaque to the CLI.
    // Validator-level rejection keeps the mutation layer's
    // truthy-check honest.
    const empty = validateDraftCreate({ title: 'Color table row', format: 'video/mp4', legacy_id: '' })
    expect(empty.some(e => e.field === 'legacy_id' && e.code === 'too_short')).toBe(true)
    const ws = validateDraftCreate({ title: 'Color table row', format: 'video/mp4', legacy_id: '   ' })
    expect(ws.some(e => e.field === 'legacy_id' && e.code === 'too_short')).toBe(true)
  })

  it('accepts color_table_ref and bounds it at 1024 chars (3b/A)', () => {
    expect(
      validateDraftCreate({
        title: 'Color table row',
        format: 'video/mp4',
        color_table_ref: 'https://example.org/color.png',
      }),
    ).toEqual([])
    const errs = validateDraftCreate({
      title: 'Color table row',
      format: 'video/mp4',
      color_table_ref: 'x'.repeat(2000),
    })
    expect(errs.some(e => e.field === 'color_table_ref' && e.code === 'too_long')).toBe(true)
  })

  it('accepts well-formed JSON probing_info (3b/A) + typed bounding_box (3d/A)', () => {
    // probing_info still persists as JSON-stringified text (the
    // structured-rendering work is deferred — caller does the
    // stringify). bounding_box is the Phase 3d typed replacement
    // for the legacy `bounding_variables` JSON string.
    const probing = JSON.stringify({
      units: 'psu',
      minVal: 20,
      maxVal: 38,
      minPos: { x: 45, y: 99, XUnits: 'Pixels', YUnits: 'Pixels' },
      maxPos: { x: 277, y: 99, XUnits: 'Pixels', YUnits: 'Pixels' },
    })
    expect(
      validateDraftCreate({
        title: 'Color table row',
        format: 'video/mp4',
        probing_info: probing,
        bounding_box: { n: 52.621, s: 21.1381, w: -134.099, e: -60.9016 },
      }),
    ).toEqual([])
  })

  it('rejects malformed-JSON probing_info', () => {
    // Catch operator hand-edits or unstringified raw objects before
    // they hit D1 — the serializer parses these on read and
    // otherwise would silently drop them.
    expect(
      validateDraftCreate({
        title: 'Color table row',
        format: 'video/mp4',
        probing_info: 'not json {',
      }).some(e => e.field === 'probing_info' && e.code === 'invalid_json'),
    ).toBe(true)
  })

  it('caps probing_info length at 4096 chars', () => {
    // Length-cap belt-and-braces — even valid JSON shouldn't bloat
    // the row. The real-world payloads are <300 chars; the cap is
    // generous.
    const oversize = JSON.stringify({ blob: 'x'.repeat(5000) })
    expect(
      validateDraftCreate({
        title: 'Color table row',
        format: 'video/mp4',
        probing_info: oversize,
      }).some(e => e.field === 'probing_info' && e.code === 'too_long'),
    ).toBe(true)
  })

  it('accepts a versioned dataset experience and rejects unknown versions', () => {
    const valid = JSON.stringify({
      version: 1,
      audioTracks: [{ source: 'r2:datasets/DS/audio.mp3', sync: 'dataset-clock' }],
      playbackPolicy: { firstDwellMs: 1500 },
    })
    expect(validateDraftCreate({
      title: 'Experience manifest',
      format: 'image/png',
      experience_manifest: valid,
    })).toEqual([])

    const invalid = validateDraftCreate({
      title: 'Future experience manifest',
      format: 'image/png',
      experience_manifest: JSON.stringify({ version: 99 }),
    })
    expect(invalid).toContainEqual(expect.objectContaining({
      field: 'experience_manifest',
      code: 'invalid_value',
    }))
  })

  it('rejects out-of-range bounding_box corners (3d/A)', () => {
    // Latitude (n, s) must be in [-90, 90]; longitude (w, e) in
    // [-180, 180]. Each violation pinpoints the specific sub-field
    // so the publisher API's 400 response is actionable.
    const errs = validateDraftCreate({
      title: 'Bad bbox',
      format: 'video/mp4',
      bounding_box: { n: 100, s: -91, w: -200, e: 999 },
    })
    expect(errs.some(e => e.field === 'bounding_box.n' && e.code === 'invalid_value')).toBe(true)
    expect(errs.some(e => e.field === 'bounding_box.s' && e.code === 'invalid_value')).toBe(true)
    expect(errs.some(e => e.field === 'bounding_box.w' && e.code === 'invalid_value')).toBe(true)
    expect(errs.some(e => e.field === 'bounding_box.e' && e.code === 'invalid_value')).toBe(true)
  })

  it('rejects bounding_box where n < s (flipped latitude box)', () => {
    const errs = validateDraftCreate({
      title: 'Flipped bbox',
      format: 'video/mp4',
      bounding_box: { n: -10, s: 10, w: -10, e: 10 },
    })
    expect(errs.some(e => e.field === 'bounding_box' && e.code === 'invalid_value')).toBe(true)
  })

  it('accepts antimeridian-crossing bounding_box (w > e is valid for Pacific boxes)', () => {
    // Boxes that wrap the antimeridian have w > e on purpose —
    // e.g. a Pacific window from w=170 to e=-170. The validator
    // must not reject this; the SPA's projection handles the wrap.
    expect(
      validateDraftCreate({
        title: 'Pacific bbox',
        format: 'video/mp4',
        bounding_box: { n: 50, s: -50, w: 170, e: -170 },
      }),
    ).toEqual([])
  })

  it('rejects non-finite bounding_box corners', () => {
    const errs = validateDraftCreate({
      title: 'NaN bbox',
      format: 'video/mp4',
      bounding_box: { n: NaN, s: 0, w: 0, e: 10 } as unknown as { n: number; s: number; w: number; e: number },
    })
    expect(errs.some(e => e.field === 'bounding_box.n' && e.code === 'invalid_type')).toBe(true)
  })

  it('validates 3d non-Earth metadata (celestial_body / radius_mi / lon_origin / is_flipped_in_y)', () => {
    // Happy path — all four populated with realistic values.
    expect(
      validateDraftCreate({
        title: 'Mars dataset',
        format: 'image/png',
        celestial_body: 'Mars',
        radius_mi: 2106.1,
        lon_origin: 180,
        is_flipped_in_y: true,
      }),
    ).toEqual([])

    // celestial_body too long (>64 chars)
    expect(
      validateDraftCreate({
        title: 'Long body',
        format: 'image/png',
        celestial_body: 'x'.repeat(65),
      }).some(e => e.field === 'celestial_body' && e.code === 'too_long'),
    ).toBe(true)

    // radius_mi non-positive
    expect(
      validateDraftCreate({
        title: 'Bad radius',
        format: 'image/png',
        radius_mi: -1,
      }).some(e => e.field === 'radius_mi' && e.code === 'invalid_value'),
    ).toBe(true)

    // radius_mi non-finite
    expect(
      validateDraftCreate({
        title: 'Inf radius',
        format: 'image/png',
        radius_mi: Infinity as unknown as number,
      }).some(e => e.field === 'radius_mi' && e.code === 'invalid_type'),
    ).toBe(true)

    // lon_origin out of range
    expect(
      validateDraftCreate({
        title: 'Bad lon',
        format: 'image/png',
        lon_origin: 200,
      }).some(e => e.field === 'lon_origin' && e.code === 'invalid_value'),
    ).toBe(true)

    // is_flipped_in_y wrong type
    expect(
      validateDraftCreate({
        title: 'Bad flip',
        format: 'image/png',
        is_flipped_in_y: 'yes' as unknown as boolean,
      }).some(e => e.field === 'is_flipped_in_y' && e.code === 'invalid_type'),
    ).toBe(true)

    // is_flipped_in_y null is accepted (clears the column on UPDATE)
    expect(
      validateDraftCreate({
        title: 'Clear flip',
        format: 'image/png',
        is_flipped_in_y: null,
      }),
    ).toEqual([])
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

describe('validateRenderEncoding (data-encoded video)', () => {
  const STOPS = [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 255, 255, 255] },
  ]
  const scale = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({ stops: STOPS, vmin: 0, vmax: 100, units: 'mg m-2', ...over })
  const base = { title: 'Smoke', format: 'video/mp4' }

  it('accepts a well-formed encoding + sidecar pair', () => {
    expect(
      validateDraftCreate({ ...base, render_encoding: 'data-luma', color_scale: scale() }),
    ).toEqual([])
  })

  it('leaves a legacy body — neither field set — untouched', () => {
    // The backwards-compatibility contract: an absent pair is not
    // an error, it is every dataset published so far.
    expect(validateDraftCreate(base)).toEqual([])
    expect(validateDraftUpdate({})).toEqual([])
  })

  it('rejects an unknown encoding', () => {
    expect(
      validateDraftCreate({ ...base, render_encoding: 'data-rgb', color_scale: scale() }).some(
        e => e.field === 'render_encoding' && e.code === 'invalid_value',
      ),
    ).toBe(true)
  })

  it('rejects each half of the pair without the other', () => {
    // 'data-luma' with no sidecar renders as raw grayscale…
    expect(
      validateDraftCreate({ ...base, render_encoding: 'data-luma' }).some(
        e => e.field === 'color_scale' && e.code === 'invalid_value',
      ),
    ).toBe(true)
    // …and a sidecar with no encoding is silently ignored.
    expect(
      validateDraftCreate({ ...base, color_scale: scale() }).some(
        e => e.field === 'render_encoding' && e.code === 'invalid_value',
      ),
    ).toBe(true)
  })

  it.each([
    ['unparseable JSON', '{nope'],
    ['a single stop', JSON.stringify({ stops: [STOPS[0]], vmin: 0, vmax: 1 })],
    ['a zero-width range', JSON.stringify({ stops: STOPS, vmin: 7, vmax: 7 })],
    ['a non-finite bound', JSON.stringify({ stops: STOPS, vmin: 0, vmax: null })],
  ])('rejects a sidecar with %s', (_label, color_scale) => {
    // Stricter than the neighbouring probing_info check, which only
    // asks for parseable JSON — this one decides pixel colours.
    expect(
      validateDraftCreate({ ...base, render_encoding: 'data-luma', color_scale }).some(
        e => e.field === 'color_scale',
      ),
    ).toBe(true)
  })

  it('rejects an over-long sidecar', () => {
    const huge = JSON.stringify({ stops: STOPS, vmin: 0, vmax: 1, units: 'x'.repeat(20_000) })
    expect(
      validateDraftCreate({ ...base, render_encoding: 'data-luma', color_scale: huge }).some(
        e => e.field === 'color_scale' && e.code === 'too_long',
      ),
    ).toBe(true)
  })

  it('allows an update to clear the pair back to a picture', () => {
    expect(validateDraftUpdate({ render_encoding: null, color_scale: null })).toEqual([])
  })

  it.each([
    ['a non-integer dataMinLuma', scale({ dataMinLuma: 11.5 })],
    ['a dataMinLuma past the 8-bit range', scale({ dataMinLuma: 255 })],
    ['a dataMinLuma that disagrees with transparentRange',
      scale({ dataMinLuma: 12, transparentRange: 0.2 })],
  ])('refuses %s at write time', (_label, color_scale) => {
    // The band decides what number every texel reports, so a sidecar
    // that gets it wrong must not reach a viewer to be discovered
    // there. `parseColorScale` fails closed and this inherits it.
    expect(
      validateDraftCreate({ ...base, render_encoding: 'data-luma', color_scale }).some(
        e => e.field === 'color_scale' && e.code === 'invalid_value',
      ),
    ).toBe(true)
  })

  it('round-trips a well-formed nodata band', () => {
    expect(
      validateDraftCreate({
        ...base,
        render_encoding: 'data-luma',
        color_scale: scale({ dataMinLuma: 12, transparentRange: 12 / 256 }),
      }),
    ).toEqual([])
  })
})

describe('playback_fps', () => {
  // Rejected rather than coerced. The transcode already falls back to
  // the default for a non-positive value, so a 0 would have produced an
  // accepted write that silently did not take effect — the form still
  // showing 0 while the video played at 30.
  const fps = (v: unknown) =>
    validateDraftUpdate({ playback_fps: v } as never).filter(e => e.field === 'playback_fps')

  it('accepts the sub-1 range, which is the useful one', () => {
    // 0.5 holds each frame two seconds — the point of the REAL column.
    for (const v of [0.25, 0.5, 1, 2, 30]) expect(fps(v)).toEqual([])
  })

  it('accepts null and absence as "use the catalog default"', () => {
    expect(fps(null)).toEqual([])
    expect(validateDraftUpdate({}).filter(e => e.field === 'playback_fps')).toEqual([])
  })

  it('rejects zero and negatives instead of silently defaulting', () => {
    for (const v of [0, -1, -0.5]) {
      expect(fps(v).map(e => e.code), `${v}`).toContain('invalid_value')
    }
  })

  it('rejects a rate above the output frame rate', () => {
    // Above 30 the `-r 30` on each rendition drops the extra source
    // frames rather than playing them faster, so the value would not
    // mean what it says.
    expect(fps(60).map(e => e.code)).toContain('invalid_value')
  })

  it('rejects non-finite and non-numeric values', () => {
    for (const v of [NaN, Infinity, '2', {}]) {
      expect(fps(v).map(e => e.code), String(v)).toContain('invalid_type')
    }
  })
})
