/**
 * Tests for the catalog migration scaffolding.
 *
 * Two concerns:
 *   1. Every Phase-1a migration applies cleanly to a fresh SQLite
 *      database, in numeric order, with no SQL errors. This is the
 *      "ephemeral local D1" CI gate from CATALOG_DATA_MODEL.md
 *      ("Per-PR" CI gates), reduced to a unit test that runs in
 *      milliseconds.
 *   2. The resulting schema matches the checked-in
 *      `migrations/catalog-schema.sql` snapshot. This is the
 *      "schema diff" CI gate from the same section: schema changes
 *      require a regenerated snapshot in the same PR.
 *
 * Both checks run against an in-memory SQLite — Wrangler local
 * mode is the same library so equivalence is high. The Miniflare
 * round-trip exercised in integration tests lives in later commits.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  applyMigrations,
  freshMigratedDb,
  renderSchemaSnapshot,
  SCHEMA_SNAPSHOT_PATH,
} from './lib/catalog-migrations.ts'
import Database from 'better-sqlite3'

const EXPECTED_TABLES = [
  'analytics_daily',
  'analytics_dataset_daily',
  'analytics_dimension_daily',
  'analytics_errors_daily',
  'analytics_export_state',
  'analytics_orbit_daily',
  'analytics_outcomes_daily',
  'analytics_perf_daily',
  'analytics_quiz_daily',
  'analytics_spatial_daily',
  'asset_uploads',
  'audit_events',
  'blog_posts',
  'current_events',
  'dataset_categories',
  'dataset_developers',
  'dataset_keywords',
  'dataset_related',
  'dataset_renditions',
  'dataset_tags',
  'datasets',
  'event_categories',
  'event_dataset_links',
  'event_keywords',
  'featured_datasets',
  'feed_connectors',
  'hero_override',
  'node_identity',
  'node_profile',
  'publishers',
  'tour_dataset_refs',
  'tours',
  'workflow_runs',
  'workflows',
]

const EXPECTED_INDEXES = [
  'idx_analytics_daily_event',
  'idx_analytics_dataset_daily_layer',
  'idx_analytics_dimension_daily_metric',
  'idx_analytics_errors_daily_day',
  'idx_analytics_orbit_daily_day',
  'idx_analytics_outcomes_daily_day',
  'idx_analytics_perf_daily_day',
  'idx_analytics_quiz_daily_day',
  'idx_analytics_spatial_daily_layer',
  'idx_asset_uploads_dataset',
  'idx_audit_subject',
  'idx_blog_posts_status',
  'idx_current_events_feed_external',
  'idx_current_events_origin_node',
  'idx_current_events_status',
  'idx_datasets_legacy_id',
  'idx_datasets_publisher',
  'idx_datasets_updated_at',
  'idx_datasets_visibility',
  'idx_event_dataset_links_dataset',
  'idx_featured_datasets_position',
  'idx_feed_connectors_enabled',
  'idx_node_identity_singleton',
  'idx_renditions_dataset',
  'idx_tours_visibility',
  'idx_workflow_runs_active',
  'idx_workflow_runs_workflow',
  'idx_workflows_due',
]

describe('catalog migrations', () => {
  it('apply cleanly in order to a fresh SQLite database', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    expect(() => applyMigrations(db)).not.toThrow()
    db.close()
  })

  it('produce the expected catalog tables', () => {
    const db = freshMigratedDb()
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    expect(rows.map(r => r.name)).toEqual(EXPECTED_TABLES)
    db.close()
  })

  it('produce the expected catalog indexes', () => {
    const db = freshMigratedDb()
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type='index' AND sql IS NOT NULL
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
    expect(rows.map(r => r.name)).toEqual(EXPECTED_INDEXES)
    db.close()
  })

  it('produce a schema that matches the checked-in catalog-schema.sql', () => {
    const db = freshMigratedDb()
    const generated = renderSchemaSnapshot(db)
    db.close()
    const onDisk = readFileSync(SCHEMA_SNAPSHOT_PATH, 'utf-8')
    expect(generated).toBe(onDisk)
  })
})
