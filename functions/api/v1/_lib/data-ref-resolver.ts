// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Build the {@link DataRefResolver} the catalog read-paths pass into
 * {@link serializeDataset} so tour rows can surface a fetchable
 * `tourJsonUrl` alongside the manifest `dataLink`.
 *
 * The two schemes that resolve to a directly-fetchable file:
 *
 *   - `url:https://…` — the SOS-seeded tour rows (`mapDataRef` in
 *     `scripts/seed-catalog.ts` writes these). Strip the `url:`
 *     prefix and pass the URL through.
 *
 *   - `r2:<key>` — publisher-uploaded tour JSON sitting on the
 *     instance's R2 bucket. Resolve via {@link resolveR2PublicUrl}
 *     so the SPA fetches the public-domain URL the operator has
 *     configured (or the path-style S3 URL when none is set).
 *
 * Other schemes (`vimeo:`, `stream:`, `peer:`) aren't directly-
 * fetchable JSON files — they're video resolution targets the
 * manifest endpoint handles for video/image formats. Returning
 * null for those leaves `tourJsonUrl` unset on the wire shape,
 * which is correct: a tour dataset shouldn't have one of those
 * data refs in the first place.
 */

import type { CatalogEnv } from './env'
import { parseDataRef } from './data-ref'
import { resolveR2PublicUrl } from './r2-public-url'
import type { DataRefResolver } from './dataset-serializer'

export function makeDataRefResolver(env: CatalogEnv): DataRefResolver {
  return (dataRef: string) => {
    const parsed = parseDataRef(dataRef)
    if (!parsed) return null
    if (parsed.scheme === 'url') return parsed.value
    if (parsed.scheme === 'r2') return resolveR2PublicUrl(env, parsed.value)
    return null
  }
}
