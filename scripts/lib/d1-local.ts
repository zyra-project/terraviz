/**
 * Helpers for locating the local D1 SQLite file Wrangler maintains
 * under `.wrangler/state/v3/d1/`. Used by `seed-catalog.ts` and the
 * migrations smoke test.
 *
 * Wrangler stores each local D1 as a single `.sqlite` file under
 * `miniflare-D1DatabaseObject/<sha256>.sqlite`, where the SHA is
 * derived from the binding name. Both FEEDBACK_DB and CATALOG_DB
 * bindings point at the same `database_id` in `wrangler.toml`, but
 * Wrangler's local mode keeps a separate file *per binding name*.
 *
 * For Phase 1a we only ever seed CATALOG_DB; the helpers below
 * resolve that one. If multiple `.sqlite` files coexist (because
 * the contributor has run `wrangler` against both bindings), we
 * pick the larger one — the one with our migrations applied — and
 * surface a warning if that heuristic is ambiguous.
 */

import { readdirSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '../..')
const D1_DIR = resolve(REPO_ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')

/**
 * Returns the path of the local CATALOG_DB sqlite file, or null if
 * the catalog migrations have not been applied yet.
 *
 * Heuristic: among all *.sqlite files under the miniflare D1 dir,
 * pick the one that has a `node_identity` table (the Phase-1a
 * marker). If none qualify, return null. If multiple qualify (the
 * unlikely case where both bindings have migrations applied), the
 * largest file wins on the assumption it carries the most data.
 */
export function findCatalogD1File(): string | null {
  let entries: string[]
  try {
    entries = readdirSync(D1_DIR)
  } catch {
    return null
  }

  const candidates: Array<{ path: string; size: number }> = []
  for (const name of entries) {
    if (!name.endsWith('.sqlite')) continue
    const full = join(D1_DIR, name)
    let qualifies = false
    try {
      const db = new Database(full, { readonly: true })
      const row = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='node_identity' LIMIT 1`,
        )
        .get() as { name?: string } | undefined
      qualifies = row?.name === 'node_identity'
      db.close()
    } catch {
      // ignored — corrupt or locked file
    }
    if (qualifies) candidates.push({ path: full, size: statSync(full).size })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.size - a.size)
  if (candidates.length > 1) {
    // Multiple sqlite files carry the catalog schema — likely
    // both FEEDBACK_DB and CATALOG_DB have had migrations applied.
    // The size heuristic picks the larger file (the one with the
    // most rows) on the assumption it's the canonical CATALOG_DB,
    // but warn the operator so they can verify by hand if the
    // wrong one was chosen.
    // eslint-disable-next-line no-console
    console.warn(
      `[d1-local] Found ${candidates.length} candidate D1 files; picking the largest:\n` +
        candidates.map(c => `  ${c.path} (${c.size} bytes)`).join('\n'),
    )
  }
  return candidates[0].path
}
