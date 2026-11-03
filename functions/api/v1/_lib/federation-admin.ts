// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared front matter for the federation admin routes under
 * `publish/federation/` (Metadata Phase 5, step 5b): the JSON helpers
 * and the gate every one of them applies first.
 *
 * The gate's order is the contract. Federation off answers 404 before
 * anything else, so a node that has not switched it on shows no
 * federation surface, not even to an admin; then the binding; then the
 * role. Every response is `private, no-store`, since peer state changes
 * on each sync and a cached list would show an old error.
 */

import type { CatalogEnv } from './env'
import { isAdmin, type PublisherRow } from './publisher-store'

const CONTENT_TYPE = 'application/json; charset=utf-8'

export function federationJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': CONTENT_TYPE, 'Cache-Control': 'private, no-store' },
  })
}

export function federationError(status: number, error: string, message: string): Response {
  return federationJson(status, { error, message })
}

/** A refusal, or `null` when the caller may manage federation peers. */
export function federationAdminGate(env: CatalogEnv, publisher: PublisherRow): Response | null {
  if (env.FEDERATION_ENABLED !== 'true') {
    return federationError(404, 'not_found', 'Federation is not enabled on this node.')
  }
  if (!env.CATALOG_DB) {
    return federationError(503, 'binding_missing', 'CATALOG_DB binding is not configured on this deployment.')
  }
  if (!isAdmin(publisher)) {
    return federationError(403, 'forbidden_role', 'Managing federation peers requires the admin role.')
  }
  return null
}
