// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * scripts/dump-catalog-schema.ts
 *
 * Regenerates `schema/catalog-schema.sql` — the canonical
 * post-migration snapshot — from a fresh in-memory apply of every
 * migration under `migrations/catalog/`.
 *
 * Workflow:
 *
 *     # after editing a migration file
 *     npm run db:dump-schema
 *
 * The snapshot is the review artefact for migration changes: a
 * reviewer reads `schema/catalog-schema.sql` rather than
 * piecing the schema together from the per-migration deltas. CI
 * runs the migrations smoke test (`scripts/seed-catalog.test.ts`)
 * and fails the PR if a contributor edited a migration without
 * regenerating the snapshot — the test rebuilds the snapshot
 * in-memory and compares to the on-disk file byte-for-byte.
 *
 * The dump runs against in-memory SQLite, *not* the Wrangler
 * `.wrangler/state` file. Whether Wrangler's migration runner keeps
 * inline comments in the stored CREATE statements has changed
 * between versions (4.112 stripped them, 4.153 keeps them), so the
 * on-disk SQL text is not a stable thing to snapshot. Standardising
 * on the in-memory path keeps the dump working for contributors who
 * haven't run `npm run db:migrate` yet and keeps the dump and the
 * test definitionally identical.
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
