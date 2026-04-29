/**
 * Test helpers — adapters that let Vitest exercise the catalog
 * route handlers against real SQL (better-sqlite3) and an
 * in-memory KV map.
 *
 * The dev doc's "integration" tier wants Miniflare with real
 * bindings; the cheaper "unit" tier wraps a sync better-sqlite3
 * handle in a D1-shaped façade. The façade implements the methods
 * the catalog-store, snapshot, mutations, and middleware reach for:
 *   - D1Database.prepare(sql) → D1PreparedStatement
 *   - D1PreparedStatement.bind(...args) → D1PreparedStatement
 *   - D1PreparedStatement.first<T>() → T | null
 *   - D1PreparedStatement.all<T>() → { results: T[] }
 *   - D1PreparedStatement.run() → D1Response (writes, returns
 *                                   `lastInsertRowid` + `changes`)
 *   - D1PreparedStatement.raw<T>() → T[][]  (decoration tests)
 *
 * Production D1 also exposes `batch()`, `exec()`, and `dump()`;
 * the catalog backend doesn't use those yet, so the façade
 * doesn't either. The KV shim mirrors the same approach: a
 * Map-backed get/put/delete sufficient for the snapshot module's
 * needs.
 */

import Database from 'better-sqlite3'
import { vi } from 'vitest'
import { freshMigratedDb } from '../../../../scripts/lib/catalog-migrations'

export interface FakeD1Bindings {
  /** Return the underlying better-sqlite3 handle for direct seeding. */
  raw(): Database.Database
}

/**
 * Wrap a better-sqlite3 handle in a D1Database-shaped façade so
 * production code under test can call it as if it were running on
 * Cloudflare. Tests pass the result into `env.CATALOG_DB`.
 */
export function asD1(db: Database.Database): D1Database & FakeD1Bindings {
  function wrapStmt(sql: string, binds: unknown[] = []): D1PreparedStatement {
    return {
      // `__sql` / `__binds` are intentionally exposed on the
      // statement object so the `batch` shim below can re-execute
      // the prepared statement inside a synchronous transaction
      // (better-sqlite3's transaction wrapper). Production D1
      // exposes no such backdoor, but tests have always squinted
      // through the façade.
      __sql: sql,
      __binds: binds,
      bind(...values: unknown[]) {
        return wrapStmt(sql, [...binds, ...values])
      },
      async first<T = unknown>(): Promise<T | null> {
        const stmt = db.prepare(sql)
        const row = (binds.length ? stmt.get(...binds) : stmt.get()) as T | undefined
        return row ?? null
      },
      async all<T = unknown>(): Promise<D1Result<T>> {
        const stmt = db.prepare(sql)
        const rows = (binds.length ? stmt.all(...binds) : stmt.all()) as T[]
        return {
          results: rows,
          success: true,
          meta: { duration: 0, last_row_id: 0, changes: 0, served_by: 'fake', changed_db: false },
        } as unknown as D1Result<T>
      },
      async run(): Promise<D1Response> {
        const stmt = db.prepare(sql)
        const info = binds.length ? stmt.run(...binds) : stmt.run()
        return {
          success: true,
          meta: {
            duration: 0,
            last_row_id: Number(info.lastInsertRowid),
            changes: info.changes,
            served_by: 'fake',
            changed_db: info.changes > 0,
          },
        } as unknown as D1Response
      },
      async raw<T extends unknown[] = unknown[]>(): Promise<T[]> {
        const stmt = db.prepare(sql).raw()
        return (binds.length ? stmt.all(...binds) : stmt.all()) as T[]
      },
    } as unknown as D1PreparedStatement
  }

  // `batch` runs prepared statements in a single transaction so a
  // mid-batch failure rolls everything back — matching D1's
  // documented behaviour. Tests that exercise the
  // `applyAssetAndMarkCompleted` helper rely on this shim.
  async function batch(statements: D1PreparedStatement[]): Promise<D1Response[]> {
    const tx = db.transaction(() => {
      const results: D1Response[] = []
      for (const stmt of statements) {
        const internal = stmt as unknown as { __sql: string; __binds: unknown[] }
        const prepared = db.prepare(internal.__sql)
        const info = internal.__binds.length
          ? prepared.run(...internal.__binds)
          : prepared.run()
        results.push({
          success: true,
          meta: {
            duration: 0,
            last_row_id: Number(info.lastInsertRowid),
            changes: info.changes,
            served_by: 'fake',
            changed_db: info.changes > 0,
          },
        } as unknown as D1Response)
      }
      return results
    })
    return tx()
  }

  return {
    prepare: (sql: string) => wrapStmt(sql),
    batch,
    raw: () => db,
  } as unknown as D1Database & FakeD1Bindings
}

/** A minimal in-memory KVNamespace fake for snapshot tests. */
export function makeKV(): KVNamespace & { _store: Map<string, string> } {
  const store = new Map<string, string>()
  const kv = {
    _store: store,
    get: vi.fn(async (key: string, type?: unknown) => {
      const v = store.get(key)
      if (v == null) return null
      if (type === 'json') return JSON.parse(v)
      return v
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, typeof value === 'string' ? value : JSON.stringify(value))
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key)
    }),
  } as unknown as KVNamespace & { _store: Map<string, string> }
  return kv
}

/**
 * Apply migrations to a fresh in-memory SQLite, then insert a
 * minimal `node_identity` row plus N seeded `datasets` rows for
 * tests that don't care about specific dataset content.
 *
 * Each fixture row is deterministic — same inputs → same ULIDs,
 * timestamps, and content — so snapshot tests stay stable.
 */
export interface FixtureOptions {
  /** How many datasets to insert. Defaults to 3. */
  count?: number
  /** Override `node_identity.base_url` (default `https://test.local`). */
  baseUrl?: string
}

export function seedFixtures(
  options: FixtureOptions = {},
): Database.Database {
  const db = freshMigratedDb()
  const count = options.count ?? 3
  const baseUrl = options.baseUrl ?? 'https://test.local'

  db.prepare(
    `INSERT INTO node_identity
       (node_id, display_name, base_url, public_key, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('NODE000', 'Test Node', baseUrl, 'ed25519:test', '2026-01-01T00:00:00.000Z')

  const insertDataset = db.prepare(`
    INSERT INTO datasets (
      id, slug, origin_node, title, abstract, organization, format, data_ref,
      thumbnail_ref, weight, visibility, is_hidden,
      schema_version, created_at, updated_at, published_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `)
  const insertCategory = db.prepare(
    `INSERT INTO dataset_categories (dataset_id, facet, value) VALUES (?, ?, ?)`,
  )
  const insertKeyword = db.prepare(
    `INSERT INTO dataset_keywords (dataset_id, keyword) VALUES (?, ?)`,
  )
  const insertTag = db.prepare(
    `INSERT INTO dataset_tags (dataset_id, tag) VALUES (?, ?)`,
  )

  for (let i = 0; i < count; i++) {
    // ULID-shaped 26-char id: "DS" + 3-digit i + 21 A's = 26 chars.
    const id = `DS${String(i).padStart(3, '0')}` + 'A'.repeat(21)
    const ts = `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`
    insertDataset.run(
      id,
      `dataset-${i}`,
      'NODE000',
      `Test Dataset ${i}`,
      `Abstract for dataset ${i}`,
      'NOAA',
      'video/mp4',
      `vimeo:${100 + i}`,
      `https://example.com/thumb-${i}.jpg`,
      i,
      'public',
      0,
      1,
      ts,
      ts,
      ts,
    )
    insertCategory.run(id, 'Theme', 'Climate')
    insertKeyword.run(id, 'temperature')
    insertTag.run(id, 'demo')
  }

  return db
}

/**
 * Build a minimal `EventContext` shaped object for invoking a
 * Pages Function handler directly. Mirrors the pattern in
 * `functions/api/ingest.test.ts` so the look-and-feel is the same
 * across feature areas.
 */
export interface MakeCtxOpts {
  url?: string
  method?: string
  headers?: Record<string, string>
  params?: Record<string, string | string[]>
  env: Record<string, unknown>
}

export function makeCtx<P extends string = never>(
  opts: MakeCtxOpts,
): Parameters<PagesFunction<Record<string, unknown>, P>>[0] {
  const url = opts.url ?? 'https://test.local/api/v1/catalog'
  const headers = new Headers(opts.headers ?? {})
  const request = new Request(url, { method: opts.method ?? 'GET', headers })
  return {
    request,
    env: opts.env,
    params: (opts.params ?? {}) as { [K in P]: string | string[] },
    data: {},
    waitUntil: () => {},
    passThroughOnException: () => {},
    next: async () => new Response(null),
    functionPath: new URL(url).pathname,
  } as unknown as Parameters<PagesFunction<Record<string, unknown>, P>>[0]
}
