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
  'audit_events',
  'dataset_categories',
  'dataset_developers',
  'dataset_keywords',
  'dataset_related',
  'dataset_renditions',
  'dataset_tags',
  'datasets',
  'node_identity',
  'publishers',
  'tour_dataset_refs',
  'tours',
]

const EXPECTED_INDEXES = [
  'idx_audit_subject',
  'idx_datasets_publisher',
  'idx_datasets_updated_at',
  'idx_datasets_visibility',
  'idx_renditions_dataset',
]

describe('Phase 1a migrations', () => {
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
