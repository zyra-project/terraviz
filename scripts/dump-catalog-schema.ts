/**
 * scripts/dump-catalog-schema.ts
 *
 * Regenerates `migrations/catalog-schema.sql` — the canonical
 * post-migration snapshot — from a fresh in-memory apply of every
 * migration under `migrations/catalog/`.
 *
 * Workflow:
 *
 *     # after editing a migration file
 *     npm run db:dump-schema
 *
 * The snapshot is the review artefact for migration changes: a
 * reviewer reads `migrations/catalog-schema.sql` rather than
 * piecing the schema together from the per-migration deltas. CI
 * runs the migrations smoke test (`scripts/seed-catalog.test.ts`)
 * and fails the PR if a contributor edited a migration without
 * regenerating the snapshot — the test rebuilds the snapshot
 * in-memory and compares to the on-disk file byte-for-byte.
 *
 * The dump runs against in-memory SQLite, *not* the Wrangler
 * `.wrangler/state` file. Wrangler's migration runner strips
 * inline comments before executing CREATE statements, so the SQL
 * stored in the on-disk database differs from what `db.exec()`
 * preserves. Standardising on the in-memory path keeps the dump
 * working for contributors who haven't run `npm run db:migrate`
 * yet and keeps the dump and the test definitionally identical.
 */

import { writeFileSync } from 'node:fs'
import { freshMigratedDb, renderSchemaSnapshot, SCHEMA_SNAPSHOT_PATH } from './lib/catalog-migrations.ts'

function main(): void {
  const db = freshMigratedDb()
  const snapshot = renderSchemaSnapshot(db)
  db.close()
  writeFileSync(SCHEMA_SNAPSHOT_PATH, snapshot)
  console.log(`Wrote ${SCHEMA_SNAPSHOT_PATH}`)
}

main()
