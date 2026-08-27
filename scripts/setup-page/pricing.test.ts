// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it } from 'vitest'
import {
  CHECKED_ON,
  D1_PRICING,
  estimateStorage,
  freeVideoDatasets,
  GB_PER_VIDEO_DATASET,
  R2_PRICING,
  REFERENCE_NODE,
} from './pricing'

describe('estimateStorage', () => {
  it('costs nothing for a small catalog', () => {
    const e = estimateStorage(5)
    expect(e.billableGb).toBe(0)
    expect(e.monthlyUsd).toBe(0)
  })

  it('bills only the excess', () => {
    const e = estimateStorage(200)
    expect(e.freeGb).toBe(R2_PRICING.freeStorageGb)
    expect(e.billableGb).toBeCloseTo(e.storageGb - R2_PRICING.freeStorageGb, 5)
    expect(e.monthlyUsd).toBeCloseTo(e.billableGb * R2_PRICING.storagePerGbMonth, 5)
  })

  it('treats nonsense input as zero rather than NaN', () => {
    for (const bad of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateStorage(bad)).toEqual({
        storageGb: 0, freeGb: 0, billableGb: 0, monthlyUsd: 0,
      })
    }
  })

  it('agrees with freeVideoDatasets() at the boundary', () => {
    expect(estimateStorage(freeVideoDatasets()).billableGb).toBe(0)
    expect(estimateStorage(freeVideoDatasets() + 1).billableGb).toBeGreaterThan(0)
  })
})

// The whole estimate hangs off one measured number. If it stops
// reproducing the invoice it was calibrated against, it is wrong.
describe('the reference node it is calibrated on', () => {
  it('reproduces the real bill it came from', () => {
    const e = estimateStorage(REFERENCE_NODE.videoDatasets)
    expect(e.storageGb).toBeCloseTo(REFERENCE_NODE.storedGb, 1)
    // Cloudflare rounds the billed quantity up to the next GB-month.
    expect(Math.round(e.billableGb)).toBe(REFERENCE_NODE.billedGbMonth)
    expect(e.monthlyUsd).toBeCloseTo(REFERENCE_NODE.monthlyUsd, 1)
  })

  it('keeps the per-dataset figure in a plausible range', () => {
    expect(GB_PER_VIDEO_DATASET).toBeGreaterThan(0.1)
    expect(GB_PER_VIDEO_DATASET).toBeLessThan(5)
  })
})

describe('the rate constants', () => {
  // Not a check that the prices are right — nothing here can know
  // that. A check that they are the shape the arithmetic assumes.
  it('are positive numbers with a free allowance', () => {
    expect(R2_PRICING.storagePerGbMonth).toBeGreaterThan(0)
    expect(R2_PRICING.freeStorageGb).toBeGreaterThan(0)
    expect(D1_PRICING.paidStoragePerGbMonth).toBeGreaterThan(0)
  })

  // R2's headline advantage over S3, and confirmed by the reference
  // invoice: data retrieval and egress both billed $0.00.
  it('still records egress as free', () => {
    expect(R2_PRICING.egressPerGb).toBe(0)
  })

  it('carries a checked-on date the page can show', () => {
    expect(CHECKED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
