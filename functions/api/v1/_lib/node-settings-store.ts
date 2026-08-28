// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `node_settings` singleton row helpers
 * (`migrations/catalog/0037_node_settings.sql`) — the per-node
 * feature toggles.
 *
 * Mirrors `node-profile-store.ts`: pure data access + body
 * validation; authorisation lives in the route handler (admin-only
 * writes via `isAdmin` — stricter than the profile's `isPrivileged`,
 * deliberately, so a service token cannot flip node-level features).
 * Absence of a row means "never configured" — every feature enabled.
 *
 * `getEffectiveFeatures` is the hot-path read consumed by the
 * `/publish` middleware gate and the gated public handlers. It is
 * KV-cached and **fail-open**: any D1/KV/parse error returns
 * all-enabled rather than throwing. A KV outage or a corrupt row
 * must never take down the publisher API or blank the public site;
 * the worst failure mode is a disabled feature briefly reappearing
 * (same semantics as the telemetry kill switch in
 * `functions/api/ingest.ts`).
 */

import {
  FEATURE_KEYS,
  defaultFeatures,
  normalizeFeatures,
  type FeatureKey,
  type FeatureMap,
} from '../../../../src/types/node-features'
import type { CatalogEnv } from './env'
import type { FieldError } from './node-profile-store'
import type { PublisherRow } from './publisher-store'

/** KV key for the effective feature map. Bump on shape changes. */
export const NODE_FEATURES_CACHE_KEY = 'node-features:v1'

/** Cache TTL — toggles change rarely; a stale read self-heals. */
const CACHE_TTL_SECONDS = 300

/** Best-effort bust of the effective-features cache. */
export async function bustNodeFeaturesCache(kv: KVNamespace | undefined): Promise<void> {
  if (!kv) return
  try {
    await kv.delete(NODE_FEATURES_CACHE_KEY)
  } catch {
    // Best-effort — a stale entry expires on its own TTL.
  }
}

/** The `node_settings` row as stored. */
export interface NodeSettingsRow {
  features_json: string
  updated_by: string
  updated_at: string
}

/** Fetch the singleton settings row, or null when never configured. */
export async function getNodeSettings(db: D1Database): Promise<NodeSettingsRow | null> {
  const row = await db
    .prepare(
      `SELECT features_json, updated_by, updated_at
         FROM node_settings
        WHERE id = 1
        LIMIT 1`,
    )
    .first<NodeSettingsRow>()
  return row ?? null
}

/** Parse a stored row's `features_json` into a complete map.
 *  Corrupt JSON degrades to all-enabled rather than failing the read. */
export function featuresFromRow(row: NodeSettingsRow | null): FeatureMap {
  if (!row) return defaultFeatures()
  try {
    return normalizeFeatures(JSON.parse(row.features_json))
  } catch {
    return defaultFeatures()
  }
}

/**
 * Upsert the singleton feature map. Stores the complete normalized
 * map (only `false` values matter, but storing every key keeps the
 * row self-describing). Audit trail is written by the route handler
 * (`node_settings.update`), matching the node-profile split of
 * concerns.
 */
export async function setNodeFeatures(
  db: D1Database,
  publisher: PublisherRow,
  features: FeatureMap,
  now: string = new Date().toISOString(),
): Promise<NodeSettingsRow> {
  await db
    .prepare(
      `INSERT INTO node_settings (id, features_json, updated_by, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         features_json = excluded.features_json,
         updated_by    = excluded.updated_by,
         updated_at    = excluded.updated_at`,
    )
    .bind(JSON.stringify(features), publisher.id, now)
    .run()
  const row = await getNodeSettings(db)
  if (!row) throw new Error('node_settings upsert did not persist')
  return row
}

/**
 * Validate a `PUT /api/v1/publish/node-settings` body. The body is
 * `{ features: { <key>: boolean, ... } }` — partial is fine (missing
 * keys stay enabled), unknown keys are a field error rather than a
 * silent drop so the operator sees what the form refused, and
 * non-boolean values are rejected.
 */
export function validateFeaturesInput(
  raw: unknown,
): { ok: true; value: FeatureMap } | { ok: false; errors: FieldError[] } {
  const errors: FieldError[] = []
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>

  const featuresRaw = body.features
  if (featuresRaw == null || typeof featuresRaw !== 'object' || Array.isArray(featuresRaw)) {
    errors.push({
      field: 'features',
      code: 'invalid',
      message: '`features` must be an object of {feature: boolean}.',
    })
    return { ok: false, errors }
  }

  const rec = featuresRaw as Record<string, unknown>
  const known = new Set<string>(FEATURE_KEYS)
  for (const [key, value] of Object.entries(rec)) {
    if (!known.has(key)) {
      errors.push({
        field: `features.${key}`,
        code: 'unknown',
        message: `\`${key}\` is not a known feature.`,
      })
      continue
    }
    if (typeof value !== 'boolean') {
      errors.push({
        field: `features.${key}`,
        code: 'invalid',
        message: `\`features.${key}\` must be a boolean.`,
      })
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  const value = defaultFeatures()
  for (const key of FEATURE_KEYS) {
    if (rec[key] === false) value[key] = false
  }
  return { ok: true, value }
}

/** The keys currently disabled — audit metadata + log lines. */
export function disabledKeys(features: FeatureMap): FeatureKey[] {
  return FEATURE_KEYS.filter(key => !features[key])
}

/**
 * The hot-path read: the effective feature map for this node.
 * One KV hit when warm; on miss reads D1 and fills the cache.
 * FAIL-OPEN — any binding gap, D1/KV error, or corrupt JSON returns
 * all-enabled. Never throws.
 */
export async function getEffectiveFeatures(env: CatalogEnv): Promise<FeatureMap> {
  try {
    if (env.CATALOG_KV) {
      try {
        const cached = await env.CATALOG_KV.get(NODE_FEATURES_CACHE_KEY)
        if (cached) return normalizeFeatures(JSON.parse(cached))
      } catch {
        // KV failure = cache miss; D1 is the source of truth.
      }
    }
    if (!env.CATALOG_DB) return defaultFeatures()
    const features = featuresFromRow(await getNodeSettings(env.CATALOG_DB))
    if (env.CATALOG_KV) {
      try {
        await env.CATALOG_KV.put(NODE_FEATURES_CACHE_KEY, JSON.stringify(features), {
          expirationTtl: CACHE_TTL_SECONDS,
        })
      } catch {
        // Best-effort fill.
      }
    }
    return features
  } catch {
    return defaultFeatures()
  }
}
