// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Per-node feature-toggle constants shared by the publisher API
 * (`functions/`) and the portal + public SPA (`src/`). Mirrors the
 * role `zyra-workflow-constants.ts` plays for the workflow pipeline:
 * one definition both sides of the wire agree on.
 *
 * A node operator can turn whole feature areas off (a datasets-only
 * node with no newsroom; a commentary-only node with no dataset
 * authoring). Every key defaults to ON — absence of a stored value,
 * an unknown key, or any read failure must resolve to "enabled" so
 * a partial write or a cache blip can never dark-launch an outage
 * (the worst failure mode is a disabled feature briefly reappearing).
 */

/**
 * The toggleable feature areas.
 *
 * - `events`    — the current-events pipeline: feed connectors,
 *                 review queue, ingestion, media suggestions, and
 *                 the public events/"In the news" reads.
 * - `blog`      — newsroom blog authoring + the public `/blog` pages.
 * - `hero`      — the "Right now" featured-hero surface.
 * - `tours`     — tour authoring + the public tours read.
 * - `workflows` — the Zyra workflow pipeline.
 * - `analytics` — the portal analytics dashboard (the nightly
 *                 rollup export is deliberately NOT gated, so
 *                 re-enabling leaves no archive gap).
 * - `feedback`  — the portal feedback review page and the public
 *                 feedback write endpoints.
 * - `datasets`  — dataset AUTHORING only (portal pages + publisher
 *                 mutations); public catalog reads are never gated.
 */
export const FEATURE_KEYS = [
  'events',
  'blog',
  'hero',
  'tours',
  'workflows',
  'analytics',
  'feedback',
  'datasets',
] as const

export type FeatureKey = (typeof FEATURE_KEYS)[number]

/** The effective toggle set — one boolean per feature, no gaps. */
export type FeatureMap = Record<FeatureKey, boolean>

/** Every feature ON — the state of a node that never saved toggles. */
export function defaultFeatures(): FeatureMap {
  const map = {} as Record<FeatureKey, boolean>
  for (const key of FEATURE_KEYS) map[key] = true
  return map
}

/**
 * Normalize an untrusted value (parsed `features_json`, a wire
 * payload, a PUT body) into a complete {@link FeatureMap}. Missing
 * keys and non-boolean values resolve to `true`; unknown keys are
 * dropped. Forward- and backward-compatible across deploys: an old
 * server ignores keys it doesn't know, a new server treats an old
 * row's missing keys as enabled.
 */
export function normalizeFeatures(raw: unknown): FeatureMap {
  const map = defaultFeatures()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return map
  const rec = raw as Record<string, unknown>
  for (const key of FEATURE_KEYS) {
    if (rec[key] === false) map[key] = false
  }
  return map
}
