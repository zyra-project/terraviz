// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import { matchesStacQuery, parseStacQuery } from './stac-query'
import type { StacItem } from './stac-types'

describe('STAC query contract', () => {
  it('clamps limits and accepts open intervals', () => {
    expect(parseStacQuery(new URLSearchParams('limit=1000')).limit).toBe(100)
    expect(parseStacQuery(new URLSearchParams('datetime=../2026-01-01T00:00:00Z')).interval?.[0]).toBe(-Infinity)
  })
  it.each(['limit=0', 'limit=-1', 'limit=abc', 'limit=1&limit=2', 'bbox=1,2,3', 'bbox=0,91,1,92',
    'datetime=2026', 'datetime=../..', 'datetime=2026-02-01T00:00:00Z/2026-01-01T00:00:00Z'])('rejects %s', text => {
    expect(() => parseStacQuery(new URLSearchParams(text))).toThrow()
  })
  it('handles crossing boxes, null geometry and inclusive interval overlap', () => {
    const item = { bbox: [170, -10, -170, 10], properties: { datetime: null,
      start_datetime: '2026-01-01T00:00:00Z', end_datetime: '2026-01-02T00:00:00Z' } } as StacItem
    expect(matchesStacQuery(item, parseStacQuery(new URLSearchParams('bbox=175,0,179,5')))).toBe(true)
    expect(matchesStacQuery(item, parseStacQuery(new URLSearchParams('bbox=-1,0,1,5')))).toBe(false)
    expect(matchesStacQuery(item, parseStacQuery(new URLSearchParams('datetime=2026-01-02T00:00:00Z')))).toBe(true)
    expect(matchesStacQuery({ ...item, bbox: undefined } as StacItem, parseStacQuery(new URLSearchParams('bbox=0,0,1,1')))).toBe(false)
  })
})