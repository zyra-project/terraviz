// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Structural validation for the Product Health dashboard's
 * migration row (Phase 3 commit G).
 *
 * Pins the load-bearing fields the dashboard relies on at import
 * time:
 *
 *   - Top-level identity (title, uid)
 *   - Standard environment / internal / DS_INFINITY templating
 *     vars present
 *   - Every panel's targets carry a non-empty SQL `data` field
 *     selecting from `terraviz_events` with the standard filters
 *   - The migration row's three panels exist with unique ids
 *   - The migration SQL pins blob1='migration_r2_hls' and uses
 *     blob7 for `outcome` — this matches `toDataPoint`'s
 *     alphabetical ordering of MigrationR2HlsEvent's string
 *     fields (dataset_id, legacy_id, outcome, r2_key, vimeo_id
 *     at blob5..blob9). A future schema shift that reorders
 *     these surfaces here.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DASHBOARD_PATH = resolve(__dirname, 'product-health.json')

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

describe('product-health dashboard — top-level structure', () => {
  const dashboard = load()

  it('declares the expected identity', () => {
    expect(dashboard.title).toBe('Terraviz — Product Health')
    expect(dashboard.uid).toBe('terraviz-product-health')
  })

  it('declares the standard environment / internal / DS_INFINITY templating vars', () => {
    const names = dashboard.templating.list.map(t => t.name).sort()
    expect(names).toEqual(['DS_INFINITY', 'environment', 'internal'])
  })

  it('every panel has unique ids and descriptive titles + descriptions', () => {
    const ids = dashboard.panels.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const panel of dashboard.panels) {
      expect(panel.title.length).toBeGreaterThan(0)
      expect(panel.description.length).toBeGreaterThan(0)
    }
  })

  it('every target queries terraviz_events with the standard environment + internal filters', () => {
    for (const panel of dashboard.panels) {
      for (const target of panel.targets) {
        const sql = target.url_options?.data ?? ''
        expect(sql.length).toBeGreaterThan(0)
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
        for (const col of cols) {
          expect(sql).toMatch(new RegExp(`AS\\s+${col.selector}\\b`))
        }
      }
    }
  })
})

describe('product-health dashboard — Phase 3 migration row', () => {
  const dashboard = load()
  const migrationPanels = dashboard.panels.filter(p =>
    p.title.toLowerCase().includes('migration video'),
  )

  it('exposes three migration panels (commit 3/G)', () => {
    expect(migrationPanels).toHaveLength(3)
    const titles = migrationPanels.map(p => p.title).sort()
    expect(titles).toEqual([
      'Migration video — cumulative ok rows',
      'Migration video — failure breakdown',
      'Migration video — runs per day by outcome',
    ])
  })

  it('places the migration row on its own grid row', () => {
    const ys = new Set(migrationPanels.map(p => p.gridPos.y))
    expect(ys.size).toBe(1)
  })

  it('pins blob1 = migration_r2_hls on every migration query', () => {
    for (const panel of migrationPanels) {
      for (const target of panel.targets) {
        const sql = target.url_options?.data ?? ''
        expect(sql).toMatch(/blob1\s*=\s*'migration_r2_hls'/)
      }
    }
  })

  it('uses blob7 for outcome (alphabetical position in MigrationR2HlsEvent)', () => {
    // Walking MigrationR2HlsEvent's fields alphabetically (after
    // the 4 server-stamped blobs and excluding event_type):
    //   bundle_bytes (num) → double1
    //   dataset_id   (str) → blob5
    //   duration_ms  (num) → double2
    //   encode_duration_ms (num) → double3
    //   legacy_id    (str) → blob6
    //   outcome      (str) → blob7  ← pinned here
    //   r2_key       (str) → blob8
    //   source_bytes (num) → double4
    //   upload_duration_ms (num) → double5
    //   vimeo_id     (str) → blob9
    const failureBreakdown = migrationPanels.find(p =>
      p.title.includes('failure breakdown'),
    )
    expect(failureBreakdown).toBeDefined()
    const sql = failureBreakdown!.targets[0].url_options!.data!
    expect(sql).toMatch(/blob7\s+AS\s+outcome/)
    expect(sql).toMatch(/blob7\s*!=\s*'ok'/)
  })

  it('cumulative ok query filters blob7 = ok', () => {
    const cumulative = migrationPanels.find(p => p.title.includes('cumulative'))
    expect(cumulative).toBeDefined()
    const sql = cumulative!.targets[0].url_options!.data!
    expect(sql).toMatch(/blob7\s*=\s*'ok'/)
    expect(sql).toMatch(/AS\s+ok_rows/)
  })
})

describe('product-health dashboard — Phase 3b asset migration row', () => {
  const dashboard = load()
  const assetPanels = dashboard.panels.filter(p =>
    p.title.toLowerCase().includes('migration assets'),
  )

  it('exposes three asset-migration panels (commit 3b/J)', () => {
    expect(assetPanels).toHaveLength(3)
    const titles = assetPanels.map(p => p.title).sort()
    expect(titles).toEqual([
      'Migration assets — cumulative ok by asset_type',
      'Migration assets — events per day by outcome',
      'Migration assets — failure breakdown by asset_type',
    ])
  })

  it('places the asset-migration row on its own grid y (distinct from the video row)', () => {
    const ys = new Set(assetPanels.map(p => p.gridPos.y))
    expect(ys.size).toBe(1)
    const [y] = [...ys]
    // The video migration row sits at y=34 (8 tall); this row
    // lands at y=42 so the rows don't overlap.
    expect(y).toBe(42)
  })

  it('pins blob1 = migration_r2_assets on every query', () => {
    for (const panel of assetPanels) {
      for (const target of panel.targets) {
        const sql = target.url_options?.data ?? ''
        expect(sql).toMatch(/blob1\s*=\s*'migration_r2_assets'/)
      }
    }
  })

  it('uses blob5 for asset_type and blob8 for outcome', () => {
    // Walking MigrationR2AssetsEvent's fields alphabetically (after
    // the 4 server-stamped blobs and excluding event_type):
    //   asset_type   (str) → blob5
    //   dataset_id   (str) → blob6
    //   duration_ms  (num) → double1
    //   legacy_id    (str) → blob7
    //   outcome      (str) → blob8  ← pinned here
    //   r2_key       (str) → blob9
    //   source_bytes (num) → double2
    //   source_url   (str) → blob10
    const breakdown = assetPanels.find(p => p.title.includes('failure breakdown'))
    expect(breakdown).toBeDefined()
    const sql = breakdown!.targets[0].url_options!.data!
    expect(sql).toMatch(/blob5\s+AS\s+asset_type/)
    expect(sql).toMatch(/blob8\s+AS\s+outcome/)
    expect(sql).toMatch(/blob8\s*!=\s*'ok'/)
  })

  it('cumulative ok query filters blob8 = ok and groups by asset_type', () => {
    const cumulative = assetPanels.find(p => p.title.includes('cumulative'))
    expect(cumulative).toBeDefined()
    const sql = cumulative!.targets[0].url_options!.data!
    expect(sql).toMatch(/blob8\s*=\s*'ok'/)
    expect(sql).toMatch(/blob5\s+AS\s+asset_type/)
    expect(sql).toMatch(/AS\s+ok_rows/)
  })

  it('dashboard version bumps so operators re-import on upgrade', () => {
    // Bumped on every panel row addition so operators re-import
    // and see the new content:
    //   - 3c/F: version 9 (tour migration row)
    //   - 3pa/F: version 10 (publisher portal row)
    expect(dashboard.version).toBe(10)
  })
})

describe('product-health dashboard — Phase 3c tour migration row', () => {
  const dashboard = load()
  const tourPanels = dashboard.panels.filter(p =>
    p.title.toLowerCase().includes('migration tours'),
  )

  it('exposes three tour-migration panels (commit 3c/F)', () => {
    expect(tourPanels).toHaveLength(3)
    const titles = tourPanels.map(p => p.title).sort()
    expect(titles).toEqual([
      'Migration tours — cumulative ok rows',
      'Migration tours — events per day by outcome',
      'Migration tours — non-ok outcome breakdown',
    ])
  })

  it('places the tour-migration row on its own grid y (distinct from the asset row)', () => {
    const ys = new Set(tourPanels.map(p => p.gridPos.y))
    expect(ys.size).toBe(1)
    const [y] = [...ys]
    // The 3b asset migration row sits at y=42 (8 tall); this row
    // lands at y=50 so the rows don't overlap.
    expect(y).toBe(50)
  })

  it('pins blob1 = migration_r2_tours on every query', () => {
    for (const panel of tourPanels) {
      for (const target of panel.targets) {
        const sql = target.url_options?.data ?? ''
        expect(sql).toMatch(/blob1\s*=\s*'migration_r2_tours'/)
      }
    }
  })

  it('uses blob7 for outcome (no asset_type to shift positions)', () => {
    // Walking MigrationR2ToursEvent's fields alphabetically (after
    // event_type, environment, country, internal — the four
    // server-stamped blobs):
    //   dataset_id        (str) → blob5
    //   duration_ms       (num) → double1
    //   legacy_id         (str) → blob6
    //   outcome           (str) → blob7   ← pinned here
    //   r2_key            (str) → blob8
    //   siblings_external (num) → double2
    //   siblings_migrated (num) → double3
    //   siblings_relative (num) → double4
    //   siblings_sos_cdn  (num) → double5
    //   source_bytes      (num) → double6
    //   source_url        (str) → blob9
    // Note: without an `asset_type` column the outcome lands one
    // position earlier than migration_r2_assets — operators
    // copy-pasting an asset-row query must remember to bump
    // blob8 → blob7 for the tour-row equivalent.
    const breakdown = tourPanels.find(p => p.title.includes('breakdown'))
    expect(breakdown).toBeDefined()
    const sql = breakdown!.targets[0].url_options!.data!
    expect(sql).toMatch(/blob7\s+AS\s+outcome/)
    expect(sql).toMatch(/blob7\s*!=\s*'ok'/)
  })

  it('cumulative ok query filters blob7 = ok and counts rows', () => {
    const cumulative = tourPanels.find(p => p.title.includes('cumulative'))
    expect(cumulative).toBeDefined()
    const sql = cumulative!.targets[0].url_options!.data!
    expect(sql).toMatch(/blob7\s*=\s*'ok'/)
    expect(sql).toMatch(/AS\s+ok_rows/)
  })
})

describe('product-health dashboard — Phase 3pa publisher row', () => {
  const dashboard = load()
  const publisherPanels = dashboard.panels.filter(p =>
    p.title.toLowerCase().includes('publisher portal'),
  )

  it('exposes three publisher panels (commit 3pa/F)', () => {
    expect(publisherPanels).toHaveLength(3)
    const titles = publisherPanels.map(p => p.title).sort()
    expect(titles).toEqual([
      'Publisher portal — loads by route',
      'Publisher portal — loads per day by route',
      'Publisher portal — total loads',
    ])
  })

  it('places the publisher row on its own grid row', () => {
    const ys = new Set(publisherPanels.map(p => p.gridPos.y))
    expect(ys.size).toBe(1)
  })

  it('pins blob1 = publisher_portal_loaded on every publisher query', () => {
    for (const panel of publisherPanels) {
      for (const target of panel.targets) {
        const sql = target.url_options?.data ?? ''
        expect(sql).toMatch(/blob1\s*=\s*'publisher_portal_loaded'/)
      }
    }
  })

  it('uses blob5 for route (alphabetical position in PublisherPortalLoadedEvent)', () => {
    // PublisherPortalLoadedEvent's only own string field beyond
    // `event_type` is `route`, so it sorts to the first user-blob
    // position (blob5). If a future schema adds a string field
    // alphabetically before `route` it shifts blob5 → blob6 and
    // this assertion fails — keeping operators honest.
    for (const panel of publisherPanels) {
      for (const target of panel.targets) {
        const sql = target.url_options?.data ?? ''
        // Either selects blob5 AS route or filters by route via
        // its alias — the test passes as long as blob5 is the
        // route column on this row of panels.
        if (sql.includes('route')) {
          expect(sql).toMatch(/blob5\s+AS\s+route/)
        }
      }
    }
  })
})
