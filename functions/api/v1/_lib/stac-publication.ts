// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { buildStacCatalog, buildStacProduct, isPublicStacUrl, type StacProduct, type StacResolvers } from './stac-builders'
import { readStacModel, type StacDatasetReadModel, type StacNodeContext } from './stac-read-model'
import { resolveHttpAssetUrl } from './r2-public-url'
import { computeEtag } from './snapshot'
import type { StacCatalog } from './stac-types'

export interface StacPublication {
  catalog: StacCatalog
  products: StacProduct[]
  report: { id: string; included: boolean; reasons: string[] }[]
}

export function stacBaseUrl(base: string): string {
  if (!isPublicStacUrl(base)) throw new Error('Invalid public node base URL')
  return `${base.replace(/\/$/, '')}/api/v1/stac`
}

function mediaType(href: string): string | null {
  const extension = new URL(href).pathname.split('.').pop()?.toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
    m3u8: 'application/vnd.apple.mpegurl', mp4: 'video/mp4', vtt: 'text/vtt',
    json: 'application/json', html: 'text/html', txt: 'text/plain' } as Record<string, string>)[extension ?? ''] ?? null
}

export function stacResolvers(env: CatalogEnv, node: StacNodeContext, dataset?: StacDatasetReadModel): StacResolvers {
  const base = stacBaseUrl(node.identity.base_url)
  return {
    resource: (kind, id) => kind === 'catalog' ? base
      : kind === 'manifest' ? `${node.identity.base_url.replace(/\/$/, '')}/api/v1/datasets/${encodeURIComponent(id)}/manifest`
        : `${base}/${kind === 'collection' ? 'collections' : 'items'}/${encodeURIComponent(id)}`,
    asset: (ref, purpose) => {
      const href = resolveHttpAssetUrl(env, ref.startsWith('url:') ? ref.slice(4) : ref)
      if (!href || !isPublicStacUrl(href)) return null
      const rendition = dataset?.renditions.find(entry => `rendition-${entry.rendition_id}` === purpose && entry.ref === ref)
      const type = rendition?.mime_type ?? (purpose === 'data' && dataset && !href.endsWith('.m3u8') ? dataset.row.format : mediaType(href))
      if (!type) return null
      return { href, type, sourceRef: ref, anonymous: true as const,
        ...(ref.startsWith('r2:') ? { hostedBy: node.identity.node_id } : {}) }
    },
  }
}

export async function readStacPublication(env: CatalogEnv): Promise<StacPublication> {
  if (!env.CATALOG_DB) throw new Error('Missing catalog database')
  const model = await readStacModel(env.CATALOG_DB)
  if (!model.node) throw new Error('Missing node identity')
  const branding = await env.CATALOG_DB.prepare('SELECT org_name, logo_ref FROM node_profile WHERE id = 1')
    .first<{ org_name: string; logo_ref: string | null }>()
  if (branding) {
    model.node.publicOrgName = branding.org_name
    const href = resolveHttpAssetUrl(env, branding.logo_ref)
    const type = href && isPublicStacUrl(href) ? mediaType(href) : null
    if (href && type?.startsWith('image/')) model.node.publicLogo = { href, type }
  }
  const seed = JSON.stringify({ version: 1, model, r2: env.R2_PUBLIC_BASE ?? null })
  const key = `stac:publication:v1:${(await computeEtag(seed)).replace(/"/g, '')}`
  if (env.CATALOG_KV) {
    try {
      const cached = await env.CATALOG_KV.get(key, 'json') as StacPublication | null
      if (cached?.catalog && Array.isArray(cached.products) && Array.isArray(cached.report)) return cached
    } catch { /* Cache failures do not bypass fresh D1 eligibility reads. */ }
  }
  const products: StacProduct[] = []
  const report: StacPublication['report'] = []
  for (const dataset of model.datasets) {
    const result = buildStacProduct(dataset, model.node, stacResolvers(env, model.node, dataset))
    report.push({ id: dataset.row.id, included: result.ok, reasons: result.reasons })
    if (result.ok) products.push(result.value)
  }
  const catalog = buildStacCatalog(model.node, stacResolvers(env, model.node), products)
  if (!catalog.ok) throw new Error(`Invalid STAC catalog: ${catalog.reasons.join(',')}`)
  const publication = { catalog: catalog.value, products, report }
  if (env.CATALOG_KV) {
    try { await env.CATALOG_KV.put(key, JSON.stringify(publication), { expirationTtl: 300 }) } catch { /* Best-effort cache. */ }
  }
  return publication
}