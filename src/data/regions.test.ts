// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { resolveRegion } from './regions'

describe('resolveRegion — US multi-state regions', () => {
  // The events AI emits these regional descriptors (a place spanning
  // several states); each must resolve to a bounding box so geo-gated
  // features (satellite snapshots, locators) still work.
  const phrases = [
    'U.S. Midwest',
    'Upper Midwest',
    'Northeast',
    'New England',
    'Mid-Atlantic',
    'Southeast US',
    'the South',
    'Gulf Coast',
    'Southwest',
    'Pacific Northwest',
    'West Coast',
    'East Coast',
    'Mountain West',
  ]

  it('resolves each regional phrase to a valid [w, s, e, n] box', () => {
    for (const name of phrases) {
      const r = resolveRegion(name)
      expect(r, name).not.toBeNull()
      const [w, s, e, n] = r!.bounds
      expect(e, name).toBeGreaterThan(w) // no accidental antimeridian box
      expect(n, name).toBeGreaterThan(s)
    }
  })

  it('is case- and whitespace-insensitive (the AI\'s "U.S. Midwest")', () => {
    expect(resolveRegion('  u.s. midwest  ')?.name).toBe('Midwest')
    expect(resolveRegion('PACIFIC NORTHWEST')?.name).toBe('Pacific Northwest')
  })

  it('each new region name is itself resolvable (name doubles as an alias)', () => {
    // Only the entries added here — pre-existing entries with decorated
    // display names (e.g. "ENSO Region (Niño 3.4)") are out of scope.
    const names = [
      'Midwest', 'Upper Midwest', 'Northeast', 'New England', 'Mid-Atlantic',
      'Southeast US', 'American South', 'Gulf Coast', 'Southwest',
      'Pacific Northwest', 'West Coast', 'East Coast', 'Mountain West',
    ]
    for (const name of names) {
      expect(resolveRegion(name), name).not.toBeNull()
    }
  })
})
