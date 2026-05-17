/**
 * Tests for the catalog wire-shape serializer.
 *
 * Today this just locks in the tour-row case — tour datasets must
 * carry a `tourJsonUrl` derived from the row's `data_ref` so the
 * SPA's tour engine can fetch the JSON directly instead of hitting
 * the manifest endpoint (which 415s tour formats by design).
 *
 * The video / image cases are exercised end-to-end by the manifest
 * endpoint tests; this file just covers the new tour branch and
 * the fall-back behaviour when the resolver is absent.
 */

import { describe, expect, it } from 'vitest'
import {
  serializeDataset,
  type DataRefResolver,
} from './dataset-serializer'
import type { DatasetRow, DecorationRows, NodeIdentityRow } from './catalog-store'

function fakeRow(overrides: Partial<DatasetRow> = {}): DatasetRow {
  return {
    id: 'DS_TEST',
    slug: 'ds-test',
    origin_node: 'NODE001',
    title: 'Test Tour',
    abstract: null,
    organization: null,
    format: 'tour/json',
    data_ref: 'url:https://example.com/tour.json',
    thumbnail_ref: null,
    sphere_thumbnail_ref: null,
    sphere_thumbnail_ref_lg: null,
    legend_ref: null,
    caption_ref: null,
    website_link: null,
    start_time: null,
    end_time: null,
    period: null,
    weight: 0,
    visibility: 'public',
    is_hidden: 0,
    run_tour_on_load: null,
    license_spdx: null,
    license_url: null,
    license_statement: null,
    attribution_text: null,
    rights_holder: null,
    doi: null,
    citation_text: null,
    schema_version: 1,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-01T00:00:00.000Z',
    published_at: '2026-05-01T00:00:00.000Z',
    retracted_at: null,
    publisher_id: null,
    legacy_id: null,
    color_table_ref: null,
    probing_info: null,
    bbox_n: null,
    bbox_s: null,
    bbox_w: null,
    bbox_e: null,
    celestial_body: null,
    radius_mi: null,
    lon_origin: null,
    is_flipped_in_y: null,
    transcoding: null,
    active_transcode_upload_id: null,
    content_digest: null,
    source_digest: null,
    ...overrides,
  }
}

const emptyDecoration: DecorationRows = {
  tags: [],
  categories: [],
  keywords: [],
  developers: [],
  related: [],
}

const fakeIdentity: NodeIdentityRow = {
  node_id: 'NODE001',
  display_name: 'Test Node',
  base_url: 'https://test.example.com',
  description: null,
  contact_email: null,
  public_key: 'abc123',
  created_at: '2026-05-01T00:00:00.000Z',
}

const passthroughResolver: DataRefResolver = (ref) =>
  ref.startsWith('url:') ? ref.slice(4) : null

describe('serializeDataset — tour rows', () => {
  it('sets tourJsonUrl when format is tour/json and the resolver finds a URL', () => {
    const wire = serializeDataset(
      fakeRow({ format: 'tour/json', data_ref: 'url:https://cdn.example.com/t.json' }),
      emptyDecoration,
      fakeIdentity,
      passthroughResolver,
    )
    expect(wire.tourJsonUrl).toBe('https://cdn.example.com/t.json')
    // The manifest dataLink stays put — older clients fall back to
    // it; new clients prefer tourJsonUrl. Both shapes coexist.
    expect(wire.dataLink).toBe('/api/v1/datasets/DS_TEST/manifest')
  })

  it('omits tourJsonUrl when no resolver is supplied', () => {
    // This is the unit-test-friendly call form: skip the resolver,
    // get a wire row that explicitly doesn't claim tourJsonUrl.
    const wire = serializeDataset(
      fakeRow({ format: 'tour/json', data_ref: 'url:https://x.example/y.json' }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.tourJsonUrl).toBeUndefined()
  })

  it('omits tourJsonUrl when the resolver returns null (unsupported scheme)', () => {
    // A tour row with a scheme the resolver can't handle (e.g. a
    // misconfigured `vimeo:` data_ref) should leave tourJsonUrl
    // unset rather than emit a string that won't fetch.
    const wire = serializeDataset(
      fakeRow({ format: 'tour/json', data_ref: 'vimeo:123' }),
      emptyDecoration,
      fakeIdentity,
      passthroughResolver,
    )
    expect(wire.tourJsonUrl).toBeUndefined()
  })

  it('does not set tourJsonUrl on non-tour rows even when the resolver is present', () => {
    // The branch is gated on `format === 'tour/json'` — video and
    // image rows must never carry tourJsonUrl, since their assets
    // legitimately go through the manifest indirection.
    const wire = serializeDataset(
      fakeRow({ format: 'video/mp4', data_ref: 'url:https://example.com/v.mp4' }),
      emptyDecoration,
      fakeIdentity,
      passthroughResolver,
    )
    expect(wire.tourJsonUrl).toBeUndefined()
  })
})

describe('serializeDataset — Phase 3b columns', () => {
  // The three columns added in migration 0009: color_table_ref
  // (auxiliary asset URL, serialized verbatim) plus probing_info
  // and bounding_variables (JSON-stringified text in D1, parsed
  // to objects on the wire).
  it('emits colorTableLink from color_table_ref verbatim', () => {
    const wire = serializeDataset(
      fakeRow({ color_table_ref: 'https://example.org/colortable.png' }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.colorTableLink).toBe('https://example.org/colortable.png')
  })

  it('omits colorTableLink when color_table_ref is null', () => {
    const wire = serializeDataset(fakeRow({ color_table_ref: null }), emptyDecoration, fakeIdentity)
    expect(wire.colorTableLink).toBeUndefined()
  })

  it('parses probing_info JSON text on read', () => {
    const probing = {
      units: 'psu',
      minVal: 20,
      maxVal: 38,
      minPos: { x: 45, y: 99, XUnits: 'Pixels', YUnits: 'Pixels' },
      maxPos: { x: 277, y: 99, XUnits: 'Pixels', YUnits: 'Pixels' },
    }
    const wire = serializeDataset(
      fakeRow({ probing_info: JSON.stringify(probing) }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.probingInfo).toEqual(probing)
  })

  it('returns undefined for malformed probing_info JSON rather than 500-ing', () => {
    // The validator gates write-side shape, so the only way a row
    // ends up with malformed JSON here is an out-of-band DB edit.
    // We surface that as a missing field rather than a hard
    // serializer failure (the read endpoint stays available).
    const wire = serializeDataset(
      fakeRow({ probing_info: 'not json {' }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.probingInfo).toBeUndefined()
  })

  it('omits probing_info when the column is null (default state)', () => {
    const wire = serializeDataset(fakeRow({}), emptyDecoration, fakeIdentity)
    expect(wire.probingInfo).toBeUndefined()
  })
})

describe('serializeDataset — Phase 3d columns (non-global metadata)', () => {
  // Migration 0010 promoted bounding_variables (JSON text) to four
  // typed columns and added celestialBody / radiusMi / lonOrigin /
  // isFlippedInY for non-Earth + dateline-centered + flipped
  // datasets. Serializer surfaces them when populated, omits when
  // NULL so the common (Earth, global, prime-meridian, no-flip)
  // case stays terse on the wire.

  it('assembles boundingBox from all four bbox_* columns', () => {
    const wire = serializeDataset(
      fakeRow({ bbox_n: 52.621, bbox_s: 21.1381, bbox_w: -134.099, bbox_e: -60.9016 }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.boundingBox).toEqual({
      n: 52.621,
      s: 21.1381,
      w: -134.099,
      e: -60.9016,
    })
  })

  it('omits boundingBox if any corner is null (defensive — a partial bbox is useless)', () => {
    // A row with bbox_n / bbox_s / bbox_w populated but bbox_e
    // missing can't drive the SPA's regional projection — better
    // to drop the field than emit a half-box.
    const wire = serializeDataset(
      fakeRow({ bbox_n: 90, bbox_s: -90, bbox_w: -180, bbox_e: null }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.boundingBox).toBeUndefined()
  })

  it('omits boundingBox when all four corners are null (global dataset)', () => {
    const wire = serializeDataset(fakeRow({}), emptyDecoration, fakeIdentity)
    expect(wire.boundingBox).toBeUndefined()
  })

  it('surfaces celestialBody / radiusMi when populated (non-Earth row)', () => {
    const wire = serializeDataset(
      fakeRow({ celestial_body: 'Mars', radius_mi: 2106.1 }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.celestialBody).toBe('Mars')
    expect(wire.radiusMi).toBe(2106.1)
  })

  it('omits celestialBody / radiusMi when null (Earth default)', () => {
    const wire = serializeDataset(fakeRow({}), emptyDecoration, fakeIdentity)
    expect(wire.celestialBody).toBeUndefined()
    expect(wire.radiusMi).toBeUndefined()
  })

  it('omits celestialBody when the column is an empty / whitespace string (legacy data)', () => {
    // Defense in depth — the importer strips empties on the write
    // side, but if a row sneaked through with `celestial_body = ''`
    // we don't want to surface `celestialBody: ""` on the wire and
    // confuse the SPA's "omitted == Earth" convention.
    expect(
      serializeDataset(fakeRow({ celestial_body: '' }), emptyDecoration, fakeIdentity).celestialBody,
    ).toBeUndefined()
    expect(
      serializeDataset(fakeRow({ celestial_body: '   ' }), emptyDecoration, fakeIdentity).celestialBody,
    ).toBeUndefined()
  })

  it('surfaces lonOrigin when non-null (dateline-centered datasets)', () => {
    const wire = serializeDataset(
      fakeRow({ lon_origin: 180 }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.lonOrigin).toBe(180)
  })

  it('preserves lonOrigin = 0 explicitly (caller asked for prime meridian)', () => {
    // A row with lon_origin = 0 (vs NULL) means the publisher
    // explicitly set prime-meridian; we round-trip it rather than
    // collapsing 0 → undefined which would lose the publisher's
    // intent on the next read.
    const wire = serializeDataset(
      fakeRow({ lon_origin: 0 }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.lonOrigin).toBe(0)
  })

  it('surfaces isFlippedInY as true only when the column == 1', () => {
    const wire = serializeDataset(
      fakeRow({ is_flipped_in_y: 1 }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.isFlippedInY).toBe(true)
  })

  it('omits isFlippedInY when the column == 0 or null (no flip is the default)', () => {
    const zero = serializeDataset(
      fakeRow({ is_flipped_in_y: 0 }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(zero.isFlippedInY).toBeUndefined()
    const nullCase = serializeDataset(fakeRow({}), emptyDecoration, fakeIdentity)
    expect(nullCase.isFlippedInY).toBeUndefined()
  })
})

describe('serializeDataset — asset-ref resolution (3b/N)', () => {
  // After Phase 3b's migrate-r2-assets writes `r2:datasets/<id>/<asset>.<ext>`
  // to the *_ref columns, the serializer MUST resolve them back to
  // public HTTPS URLs before handing the row to the SPA. Otherwise
  // the browser tries to load `<img src="r2:...">` and the asset
  // 404s. Phase 3b/N added the AssetRefResolver callback parameter;
  // these tests pin the contract.
  const noaaThumbnail = 'https://d3sik7mbbzunjo.cloudfront.net/x/thumb.jpg'
  const r2Thumbnail = 'r2:datasets/DS_TEST/thumbnail.jpg'

  function r2Resolver(ref: string | null | undefined): string | null {
    if (!ref) return null
    if (ref.startsWith('r2:')) {
      return `https://video.example.com/${ref.slice('r2:'.length)}`
    }
    return ref
  }

  it('resolves r2: asset refs to public URLs via the callback', () => {
    const wire = serializeDataset(
      fakeRow({
        thumbnail_ref: r2Thumbnail,
        legend_ref: 'r2:datasets/DS_TEST/legend.png',
        caption_ref: 'r2:datasets/DS_TEST/caption.vtt',
        color_table_ref: 'r2:datasets/DS_TEST/color-table.png',
      }),
      emptyDecoration,
      fakeIdentity,
      undefined,
      r2Resolver,
    )
    expect(wire.thumbnailLink).toBe('https://video.example.com/datasets/DS_TEST/thumbnail.jpg')
    expect(wire.legendLink).toBe('https://video.example.com/datasets/DS_TEST/legend.png')
    expect(wire.closedCaptionLink).toBe('https://video.example.com/datasets/DS_TEST/caption.vtt')
    expect(wire.colorTableLink).toBe('https://video.example.com/datasets/DS_TEST/color-table.png')
  })

  it('passes bare https URLs through unchanged (pre-migration rows)', () => {
    const wire = serializeDataset(
      fakeRow({
        thumbnail_ref: noaaThumbnail,
        legend_ref: 'https://d3sik7mbbzunjo.cloudfront.net/x/legend.png',
      }),
      emptyDecoration,
      fakeIdentity,
      undefined,
      r2Resolver,
    )
    expect(wire.thumbnailLink).toBe(noaaThumbnail)
    expect(wire.legendLink).toBe('https://d3sik7mbbzunjo.cloudfront.net/x/legend.png')
  })

  it('omits fields when null even with the resolver bound', () => {
    const wire = serializeDataset(
      fakeRow({
        thumbnail_ref: null,
        legend_ref: null,
        caption_ref: null,
        color_table_ref: null,
      }),
      emptyDecoration,
      fakeIdentity,
      undefined,
      r2Resolver,
    )
    expect(wire.thumbnailLink).toBeUndefined()
    expect(wire.legendLink).toBeUndefined()
    expect(wire.closedCaptionLink).toBeUndefined()
    expect(wire.colorTableLink).toBeUndefined()
  })

  it('omits fields when the resolver itself returns null (orphaned r2: ref with no R2_PUBLIC_BASE)', () => {
    // Production behavior when R2_PUBLIC_BASE is unset and the row
    // is on r2: — `resolveAssetRef` returns null. Better to omit
    // the field entirely than to send the unrenderable r2: string
    // to the SPA.
    const nullingResolver = () => null
    const wire = serializeDataset(
      fakeRow({ thumbnail_ref: r2Thumbnail }),
      emptyDecoration,
      fakeIdentity,
      undefined,
      nullingResolver,
    )
    expect(wire.thumbnailLink).toBeUndefined()
  })

  it('resolves r2: runTourOnLoad refs (Phase 3c)', () => {
    // Phase 3c/B migrates run_tour_on_load from NOAA CloudFront
    // to `r2:tours/<id>/tour.json`. The serializer must flip
    // that to a fetchable URL — same resolver, same contract as
    // the *_ref columns from 3b/N.
    const wire = serializeDataset(
      fakeRow({ run_tour_on_load: 'r2:tours/DS_TEST/tour.json' }),
      emptyDecoration,
      fakeIdentity,
      undefined,
      r2Resolver,
    )
    expect(wire.runTourOnLoad).toBe('https://video.example.com/tours/DS_TEST/tour.json')
  })

  it('passes bare https runTourOnLoad through unchanged (pre-3c rows)', () => {
    const wire = serializeDataset(
      fakeRow({
        run_tour_on_load: 'https://d3sik7mbbzunjo.cloudfront.net/extras/foo/tour.json',
      }),
      emptyDecoration,
      fakeIdentity,
      undefined,
      r2Resolver,
    )
    expect(wire.runTourOnLoad).toBe(
      'https://d3sik7mbbzunjo.cloudfront.net/extras/foo/tour.json',
    )
  })

  it('omits runTourOnLoad when the resolver returns null', () => {
    // Same fail-soft posture as the *_ref columns: an r2: ref
    // with no R2_PUBLIC_BASE produces null; we drop the field
    // rather than send an unfetchable string to the SPA.
    const nullingResolver = () => null
    const wire = serializeDataset(
      fakeRow({ run_tour_on_load: 'r2:tours/DS_TEST/tour.json' }),
      emptyDecoration,
      fakeIdentity,
      undefined,
      nullingResolver,
    )
    expect(wire.runTourOnLoad).toBeUndefined()
  })

  it('falls back to verbatim passthrough when no resolver is given (test convenience)', () => {
    // Existing tests don't pass a resolver. Behavior must stay
    // unchanged (verbatim r2: string) so we don't have to pipe a
    // resolver through every legacy test fixture.
    const wire = serializeDataset(
      fakeRow({ thumbnail_ref: r2Thumbnail }),
      emptyDecoration,
      fakeIdentity,
    )
    expect(wire.thumbnailLink).toBe(r2Thumbnail)
  })
})
