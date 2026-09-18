// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { isPublicStacUrl, type StacResolvedAsset } from './stac-builders'
import { evaluateMetadataReadiness } from './metadata-readiness'
import { resolveHttpAssetUrl } from './r2-public-url'
import type { StacPublicationInput } from './stac-publication-store'

interface VerifiedUrl { href: string; type: string }

export async function verifyStacAssets(env: CatalogEnv, model: StacPublicationInput): Promise<Map<string, StacResolvedAsset>> {
  const origins = new Set((env.STAC_ASSET_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean))
  if (env.R2_PUBLIC_BASE && isPublicStacUrl(env.R2_PUBLIC_BASE)) origins.add(new URL(env.R2_PUBLIC_BASE).origin)
  const allowed = (href: string): boolean => isPublicStacUrl(href) && new URL(href).protocol === 'https:' && origins.has(new URL(href).origin)
  const references = new Set<string>()
  for (const dataset of model.datasets) {
    const readiness = evaluateMetadataReadiness({ ...dataset.row, publication_kind: dataset.publicationKind })
    if (dataset.row.transcoding === 1 || ['excluded', 'needs_review'].includes(readiness.decision)) continue
    for (const ref of [dataset.row.data_ref, ...dataset.renditions.map(entry => entry.ref), dataset.row.thumbnail_ref,
      dataset.row.sphere_thumbnail_ref, dataset.row.legend_ref, dataset.row.caption_ref, dataset.row.license_url]) {
      if (ref) references.add(ref)
    }
  }
  if (model.branding?.logo_ref) references.add(model.branding.logo_ref)
  const verified = new Map<string, StacResolvedAsset>()
  const byUrl = new Map<string, VerifiedUrl | null>()
  for (const ref of references) {
    const href = resolveHttpAssetUrl(env, ref.startsWith('url:') ? ref.slice(4) : ref)
    if (!href || !allowed(href)) continue
    if (!byUrl.has(href)) {
      if (byUrl.size >= 40) continue
      let result: VerifiedUrl | null = null
      try {
        const response = await fetch(href, { method: 'HEAD', redirect: 'manual', credentials: 'omit',
          signal: AbortSignal.timeout(3000), headers: { Accept: '*/*' } })
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (response.ok && type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) result = { href, type }
        await response.body?.cancel()
      } catch { result = null }
      byUrl.set(href, result)
    }
    const result = byUrl.get(href)
    if (result) verified.set(ref, { ...result, sourceRef: ref, anonymous: true,
      ...(ref.startsWith('r2:') && model.node ? { hostedBy: model.node.identity.node_id } : {}) })
  }
  return verified
}