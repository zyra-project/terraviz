// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Structural validation for the Orbit Cost dashboard (1f/E).
 *
 * Two failure modes the test catches:
 *
 *   1. Hand-edited JSON that introduces a syntax error or drifts
 *      from the panel-shape Grafana expects (id / gridPos / targets
 *      / columns). The Grafana dashboard schema is permissive but
 *      these load-bearing fields fail loudly at import time.
 *
 *   2. Phase 1d/Y's `turn_rounds` field landing at the wrong
 *      blob/double index. The brief flagged that this dashboard is
 *      the consumer of `double7` — we pin that explicitly so a
 *      future schema shift (alphabetical ordering — see
 *      `ANALYTICS_QUERIES.md` "Important: because event-specific
 *      blobs and doubles are alphabetical by field name…") shows
 *      up here.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_PATH = resolve(__dirname, 'orbit-cost.json')

interface Panel {
  id: number
  type: string
  title: string
  description: string
  gridPos: { x: number; y: number; w: number; h: number }
  targets: Array<{
    refId: string
    url_options?: { data?: string }
    columns?: Array<{ selector: string; text: string; type: string }>
  }>
}

interface Dashboard {
  title: string
  uid: string
  panels: Panel[]
  templating: { list: Array<{ name: string }> }
}

function load(): Dashboard {
  const raw = readFileSync(DASHBOARD_PATH, 'utf-8')
  return JSON.parse(raw) as Dashboard
}

describe('orbit-cost dashboard structure', () => {
  const dashboard = load()

  it('has the expected top-level identity fields', () => {
    expect(dashboard.title).toBe('Terraviz — Orbit Cost')
    expect(dashboard.uid).toBe('terraviz-orbit-cost')
  })

  it('declares the standard environment / internal / DS_INFINITY templating vars', () => {
    const names = dashboard.templating.list.map(t => t.name).sort()
    expect(names).toEqual(['DS_INFINITY', 'environment', 'internal'])
  })

  it('exposes four panels with unique ids and descriptive titles', () => {
    expect(dashboard.panels).toHaveLength(4)
    const ids = dashboard.panels.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const panel of dashboard.panels) {
      expect(panel.title.length).toBeGreaterThan(0)
      expect(panel.description.length).toBeGreaterThan(0)
    }
  })

  it('every panel has at least one target with a non-empty SQL data field', () => {
    for (const panel of dashboard.panels) {
      expect(panel.targets.length).toBeGreaterThan(0)
      for (const target of panel.targets) {
        const sql = target.url_options?.data ?? ''
        expect(sql.length).toBeGreaterThan(0)
        // Sanity: every SQL query selects from terraviz_events with
        // the standard environment + internal filters in place.
        expect(sql).toMatch(/FROM\s+terraviz_events/)
        expect(sql).toMatch(/blob2\s*=\s*'\$environment'/)
        expect(sql).toMatch(/blob4\s*=\s*'\$internal'/)
      }
    }
  })

  it('every panel column list matches the columns referenced in its SQL', () => {
    for (const panel of dashboard.panels) {
      for (const target of panel.targets) {
        const cols = target.columns ?? []
        expect(cols.length).toBeGreaterThan(0)
        const sql = target.url_options?.data ?? ''
        // Every declared column must appear in the SELECT clause as
        // an `AS <name>` alias.
        for (const col of cols) {
          expect(sql).toMatch(new RegExp(`AS\\s+${col.selector}\\b`))
        }
      }
    }
  })
})

describe('orbit-cost dashboard — Phase 1d/Y schema pin', () => {
  const dashboard = load()
  const sqls = dashboard.panels.flatMap(p =>
    p.targets.map(t => ({ panel: p.title, sql: t.url_options?.data ?? '' })),
  )

  it('uses double7 for turn_rounds, matching ANALYTICS_QUERIES.md', () => {
    // Three of the four panels reference turn_rounds (panel 4 is
    // browse_search, no turn_rounds). Defensively assert the index
    // is `double7` everywhere it appears so a future schema shift
    // (alphabetical ordering inside the orbit_turn shape) surfaces
    // here rather than in production.
    const turnRoundsPanels = sqls.filter(({ sql }) => /double7/.test(sql))
    expect(turnRoundsPanels.length).toBeGreaterThanOrEqual(3)
    for (const { sql } of turnRoundsPanels) {
      // No bare `doubleN where N != 7` reference for turn_rounds —
      // i.e., we don't accidentally use double6 (turn_index) or
      // double5 (output_tokens). Spot-check by ensuring no SQL
      // computes against double5/double6 in this dashboard.
      expect(sql).not.toMatch(/\bdouble[1245689]\b/)
    }
  })

  it('only counts assistant turns (blob8 = assistant) for round-cost analysis', () => {
    const turnSqls = sqls.filter(({ sql }) =>
      /blob1\s*=\s*'orbit_turn'/.test(sql),
    )
    expect(turnSqls.length).toBeGreaterThanOrEqual(3)
    for (const { sql } of turnSqls) {
      expect(sql).toMatch(/blob8\s*=\s*'assistant'/)
    }
  })

  it('queries duration_ms via double3 for the p95 panel', () => {
    const p95 = sqls.find(({ panel }) => panel.includes('p95'))
    expect(p95).toBeDefined()
    expect(p95!.sql).toMatch(/quantile\(0\.95\).*double3/)
  })

  it('queries query_hash via blob5 for the top-queries panel', () => {
    const browse = sqls.find(({ sql }) => /browse_search/.test(sql))
    expect(browse).toBeDefined()
    expect(browse!.sql).toMatch(/blob5\s+AS\s+query_hash/)
  })
})
