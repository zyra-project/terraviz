// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import type { Dataset } from '../types'
import {
  buildDatasetPath,
  buildNoDatasetPath,
  datasetUrlRef,
  isDatasetRef,
  parseDatasetPathname,
  previewDatasetRef,
  resolveDatasetRef,
} from './datasetUrl'

function ds(over: Partial<Dataset> & Pick<Dataset, 'id'>): Dataset {
  return {
    title: 'Untitled',
    format: 'video/mp4',
    dataLink: 'https://example.com/x.m3u8',
    ...over,
  } as Dataset
}

const SMOKE = ds({
  id: '01KYK82VR6KDQK0915JNMQQ8RG',
  slug: 'north-america-smoke',
  title: 'North America Smoke',
})
const LEGACY = ds({
  id: '01JXCULID0000000000000000',
  slug: 'sea-ice-extent',
  legacyId: 'INTERNAL_SOS_768',
})
const NO_SLUG = ds({ id: 'SOS_ONLY_aurora' })
const CATALOG = [SMOKE, LEGACY, NO_SLUG]

describe('isDatasetRef', () => {
  it('accepts slugs, ULIDs, and legacy ids', () => {
    expect(isDatasetRef('north-america-smoke')).toBe(true)
    expect(isDatasetRef('01KYK82VR6KDQK0915JNMQQ8RG')).toBe(true)
    expect(isDatasetRef('INTERNAL_SOS_768')).toBe(true)
  })

  it('rejects anything that could smuggle markup or a path segment', () => {
    expect(isDatasetRef('<script>alert(1)</script>')).toBe(false)
    expect(isDatasetRef('a/b')).toBe(false)
    expect(isDatasetRef('has space')).toBe(false)
    expect(isDatasetRef('has.dot')).toBe(false)
    expect(isDatasetRef('')).toBe(false)
    expect(isDatasetRef('x'.repeat(65))).toBe(false)
  })
})

describe('parseDatasetPathname', () => {
  it('parses the canonical slug form, with or without a trailing slash', () => {
    expect(parseDatasetPathname('/dataset/north-america-smoke')).toBe('north-america-smoke')
    expect(parseDatasetPathname('/dataset/north-america-smoke/')).toBe('north-america-smoke')
  })

  it('leaves other SPA routes alone', () => {
    expect(parseDatasetPathname('/')).toBeNull()
    expect(parseDatasetPathname('/blog/some-post')).toBeNull()
    expect(parseDatasetPathname('/publish/datasets')).toBeNull()
    // The root namespace stays free — a bare slug is not a dataset URL.
    expect(parseDatasetPathname('/north-america-smoke')).toBeNull()
  })
})

describe('resolveDatasetRef', () => {
  it('resolves by slug, id, and legacy id', () => {
    expect(resolveDatasetRef('north-america-smoke', CATALOG)).toBe(SMOKE)
    expect(resolveDatasetRef('01KYK82VR6KDQK0915JNMQQ8RG', CATALOG)).toBe(SMOKE)
    expect(resolveDatasetRef('INTERNAL_SOS_768', CATALOG)).toBe(LEGACY)
  })

  it('matches slugs case-insensitively so a link that picked up a capital still lands', () => {
    expect(resolveDatasetRef('North-America-Smoke', CATALOG)).toBe(SMOKE)
  })

  it('prefers an exact id match over a slug match, whatever the catalog order', () => {
    // Disjoint alphabets (uppercase ids, lowercase slugs) make this
    // unreachable in practice; the lookup order is what guarantees a
    // deterministic answer if it ever stopped being true.
    const shadow = ds({ id: 'north-america-smoke', title: 'Shadow' })
    expect(resolveDatasetRef('north-america-smoke', [SMOKE, shadow])).toBe(shadow)
    expect(resolveDatasetRef('north-america-smoke', [shadow, SMOKE])).toBe(shadow)
  })

  it('returns undefined for an unknown or empty reference', () => {
    expect(resolveDatasetRef('nope', CATALOG)).toBeUndefined()
    expect(resolveDatasetRef(null, CATALOG)).toBeUndefined()
    expect(resolveDatasetRef(undefined, CATALOG)).toBeUndefined()
    expect(resolveDatasetRef('', CATALOG)).toBeUndefined()
  })

  it('does not match rows that carry no slug against an empty ref', () => {
    expect(resolveDatasetRef('SOS_ONLY_aurora', CATALOG)).toBe(NO_SLUG)
  })
})

describe('datasetUrlRef', () => {
  it('prefers the slug', () => {
    expect(datasetUrlRef(SMOKE)).toBe('north-america-smoke')
  })

  it('falls back to the id when there is no slug or the slug is malformed', () => {
    expect(datasetUrlRef(NO_SLUG)).toBe('SOS_ONLY_aurora')
    expect(datasetUrlRef({ id: 'X1', slug: 'not_a_valid_slug' })).toBe('X1')
    expect(datasetUrlRef({ id: 'X2', slug: '9-leading-digit' })).toBe('X2')
    expect(datasetUrlRef({ id: 'X3', slug: 'ab' })).toBe('X3')
  })
})

describe('buildDatasetPath', () => {
  it('builds the canonical path', () => {
    expect(buildDatasetPath(SMOKE)).toBe('/dataset/north-america-smoke')
  })

  it('carries the visitor’s mode across a dataset switch', () => {
    expect(buildDatasetPath(SMOKE, '?catalog=true')).toBe('/dataset/north-america-smoke?catalog=true')
    expect(buildDatasetPath(SMOKE, '?embed=1&layout=2')).toBe('/dataset/north-america-smoke?embed=1&layout=2')
  })

  it('drops the dataset param the path segment now carries', () => {
    expect(buildDatasetPath(SMOKE, '?dataset=OLD&catalog=true'))
      .toBe('/dataset/north-america-smoke?catalog=true')
  })

  it('drops a draft-preview token rather than pointing it at another dataset', () => {
    expect(buildDatasetPath(SMOKE, '?preview=tok&dataset=DRAFT')).toBe('/dataset/north-america-smoke')
  })
})

describe('previewDatasetRef', () => {
  it('names the draft a preview URL is scoped to', () => {
    expect(previewDatasetRef('?preview=tok&dataset=DRAFT01')).toBe('DRAFT01')
  })

  it('is null for an ordinary URL, so nothing is pinned', () => {
    expect(previewDatasetRef('')).toBeNull()
    expect(previewDatasetRef('?dataset=01KYK82VR6KDQK0915JNMQQ8RG')).toBeNull()
    expect(previewDatasetRef('?catalog=true')).toBeNull()
  })

  it('is null for a token with no dataset — nothing to pin', () => {
    // `getPreviewParamsFromUrl` requires both params, so a lone
    // `?preview=` never boots a draft. Reporting no pinned dataset
    // keeps this agreeing with that.
    expect(previewDatasetRef('?preview=tok')).toBeNull()
  })
})

describe('buildNoDatasetPath', () => {
  it('strips the dataset segment but keeps the mode', () => {
    expect(buildNoDatasetPath('/dataset/north-america-smoke', '?catalog=true')).toBe('/?catalog=true')
    expect(buildNoDatasetPath('/dataset/north-america-smoke', '')).toBe('/')
  })

  it('strips the legacy query form too', () => {
    expect(buildNoDatasetPath('/', '?dataset=01KYK82VR6KDQK0915JNMQQ8RG&embed=1')).toBe('/?embed=1')
  })

  it('leaves a non-dataset path in place', () => {
    // Tauri can serve the SPA from /index.html; resetting to '/'
    // unconditionally would break the webview's asset path.
    expect(buildNoDatasetPath('/index.html', '')).toBe('/index.html')
  })
})
