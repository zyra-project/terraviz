// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { isPublicStacUrl, type StacResolvedAsset } from './stac-builders'
import { evaluateMetadataReadiness } from './metadata-readiness'
import { resolveHttpAssetUrl } from './r2-public-url'
import type { StacPublicationInput } from './stac-publication-store'

interface VerifiedUrl { href: string; type: string }

export async function verifyStacAssets(env: CatalogEnv, model: StacPublicationInput): Promise<{
  assets: Map<string, StacResolvedAsset>; issues: Map<string, string>
}> {
  const origins = new Set((env.STAC_ASSET_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean))
  if (env.R2_PUBLIC_BASE && isPublicStacUrl(env.R2_PUBLIC_BASE)) origins.add(new URL(env.R2_PUBLIC_BASE).origin)
  const allowed = (href: string): boolean => isPublicStacUrl(href) && new URL(href).protocol === 'https:' && origins.has(new URL(href).origin)
  const references = new Set<string>()
  for (const dataset of model.datasets) {
    if (dataset.row.visibility !== 'public' || dataset.row.is_hidden !== 0 || !dataset.row.published_at || dataset.row.retracted_at !== null) continue
    const readiness = evaluateMetadataReadiness({ ...dataset.row, publication_kind: dataset.publicationKind })
    if (dataset.row.transcoding === 1 || ['excluded', 'needs_review'].includes(readiness.decision)) continue
    for (const ref of [dataset.row.data_ref, ...dataset.renditions.map(entry => entry.ref), dataset.row.thumbnail_ref,
      dataset.row.sphere_thumbnail_ref, dataset.row.legend_ref, dataset.row.caption_ref, dataset.row.license_url]) {
      if (ref) references.add(ref)
    }
  }
  if (model.branding?.logo_ref) references.add(model.branding.logo_ref)
  const verified = new Map<string, StacResolvedAsset>()
  const issues = new Map<string, string>()
  const urlIssues = new Map<string, string>()
  const byUrl = new Map<string, VerifiedUrl | null>()
  const deadline = AbortSignal.timeout(15000)
  for (const ref of references) {
    const href = resolveHttpAssetUrl(env, ref.startsWith('url:') ? ref.slice(4) : ref)
    if (!href || !allowed(href)) { issues.set(ref, href ? 'asset_origin_untrusted' : 'asset_reference_unsupported'); continue }
    if (!byUrl.has(href)) {
      if (byUrl.size >= 40 || deadline.aborted) { issues.set(ref, 'asset_probe_budget_exceeded'); continue }
      let result: VerifiedUrl | null = null
      try {
        const response = await fetch(href, { method: 'HEAD', redirect: 'manual', credentials: 'omit',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(3000)]), headers: { Accept: '*/*' } })
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if (response.ok && type && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) result = { href, type }
        else urlIssues.set(href, response.ok ? 'asset_content_type_missing' : `asset_http_${response.status}`)
        await response.body?.cancel()
      } catch { result = null; urlIssues.set(href, 'asset_probe_failed') }
      byUrl.set(href, result)
    }
    const result = byUrl.get(href)
    if (result) verified.set(ref, { ...result, sourceRef: ref, anonymous: true,
      ...(ref.startsWith('r2:') && model.node ? { hostedBy: model.node.identity.node_id } : {}) })
    else issues.set(ref, urlIssues.get(href) ?? 'asset_probe_failed')
  }
  return { assets: verified, issues }
}