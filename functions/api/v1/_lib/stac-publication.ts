// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { buildStacCatalog, buildStacProduct, isPublicStacUrl, type StacProduct, type StacResolvers, type StacResolvedAsset } from './stac-builders'
import { type StacDatasetReadModel, type StacNodeContext } from './stac-read-model'
import { readStacPublicationInput } from './stac-publication-store'
import { verifyStacAssets } from './stac-assets'
import { computeEtag } from './snapshot'
import type { StacCatalog, StacCollection } from './stac-types'
import { historyMatchesDataset, historyModels, linkHistoryRevisions, mergeHistoryCollections } from './stac-history'
import { evaluateMetadataReadiness, evaluateTemporal } from './metadata-readiness'

export interface StacPublication {
  catalog: StacCatalog
  products: StacProduct[]
  publicationIssues: string[]
  report: { id: string; included: boolean; reasons: string[]; items_included: number; items_total: number }[]
}

export function stacBaseUrl(base: string): string {
  if (!isPublicStacUrl(base)) throw new Error('Invalid public node base URL')
  return `${base.replace(/\/$/, '')}/api/v1/stac`
}

export function stacResolvers(node: StacNodeContext, assets: Map<string, StacResolvedAsset>, dataset?: StacDatasetReadModel): StacResolvers {
  const base = stacBaseUrl(node.identity.base_url)
  return {
    resource: (kind, id) => kind === 'catalog' ? base
      : kind === 'discovery' ? `${node.identity.base_url.replace(/\/$/, '')}/.well-known/terraviz.json`
      : kind === 'dataset' ? `${node.identity.base_url.replace(/\/$/, '')}/api/v1/datasets/${encodeURIComponent(id)}`
      : kind === 'manifest' ? `${node.identity.base_url.replace(/\/$/, '')}/api/v1/datasets/${encodeURIComponent(id)}/manifest`
        : `${base}/${kind === 'collection' ? 'collections' : 'items'}/${encodeURIComponent(id)}`,
    listing: (kind, collectionId) => collectionId ? `${base}/collections/${encodeURIComponent(collectionId)}/items` : `${base}/${kind}`,
    asset: (ref, purpose) => {
      const asset = assets.get(ref)
      if (!asset) return null
      if (purpose === 'data' && dataset) {
        const format = dataset.row.format.toLowerCase()
        if (!dataset.row.data_ref.startsWith('url:') && !dataset.row.data_ref.startsWith('r2:')) return null
        if (!(format.startsWith('image/') && asset.type.startsWith('image/'))
          && !(format.startsWith('video/') && (asset.type === 'video/mp4' || /mpegurl$/.test(asset.type)))) return null
      }
      return asset
    },
  }
}

export async function readStacPublication(env: CatalogEnv, options: { operatorReport?: boolean } = {}): Promise<StacPublication> {
  if (!env.CATALOG_DB) throw new Error('Missing catalog database')
  const model = await readStacPublicationInput(env.CATALOG_DB, options.operatorReport === true)
  if (!model.node) throw new Error('Missing node identity')
  const branding = model.branding
  if (branding) model.node.publicOrgName = branding.org_name
  const seed = JSON.stringify({ version: 10, operatorReport: options.operatorReport === true, model, r2: env.R2_PUBLIC_BASE ?? null, origins: env.STAC_ASSET_ORIGINS ?? null })
  const key = `stac:publication:v1:${(await computeEtag(seed)).replace(/"/g, '')}`
  if (env.CATALOG_KV && !options.operatorReport) {
    try {
      const cached = await env.CATALOG_KV.get(key, 'json') as StacPublication | null
      if (cached?.catalog && Array.isArray(cached.products) && Array.isArray(cached.report)) return cached
    } catch { /* Cache failures do not bypass fresh D1 eligibility reads. */ }
  }
  const products: StacProduct[] = []
  const report: StacPublication['report'] = []
  const reportById = new Map<string, StacPublication['report'][number]>()
  const collectionModels = new Map<string, StacDatasetReadModel>()
  const historyByDataset = new Map<string, typeof model.history>()
  for (const publication of model.history) {
    const group = historyByDataset.get(publication.dataset_id) ?? []
    group.push(publication)
    historyByDataset.set(publication.dataset_id, group)
  }
  const datasets = model.datasets.flatMap(dataset => {
    const publications = [...(historyByDataset.get(dataset.row.id) ?? [])]
      .sort((first, second) => Date.parse(first.captured_at) - Date.parse(second.captured_at) || first.id.localeCompare(second.id))
    if (!publications.length) return [dataset]
    if (!historyMatchesDataset(publications.at(-1)!, dataset)) {
      const latest = publications.at(-1)!
      const readiness = evaluateMetadataReadiness({ ...dataset.row, publication_kind: dataset.publicationKind,
        item_identity: { kind: latest.kind, persisted_id: latest.items[0]?.id } })
      const entry = { id: dataset.row.id, included: false, reasons: ['history_stale', ...readiness.reasons], items_included: 0,
        items_total: dataset.publicationKind === 'workflow' ? publications.filter(publication => publication.kind === 'revision').length + 1
          : dataset.row.frame_count ?? 0 }
      report.push(entry)
      reportById.set(entry.id, entry)
      return []
    }
    // Saved Items replace the live Item; only the latest frame set is public. Collection descriptions stay live.
    const latestFrames = publications.filter(publication => publication.kind === 'frame').at(-1)
    const historical = publications.filter(publication => publication.kind === 'revision' || publication === latestFrames)
      .flatMap(publication => historyModels(publication, dataset.row, dataset.decorations))
    const representative = historical.at(-1)
    if (representative) {
      const descriptive = ['title', 'abstract', 'organization', 'license_spdx', 'license_url', 'license_statement',
        'rights_holder', 'attribution_text', 'doi', 'citation_text', 'website_link'] as const
      collectionModels.set(dataset.row.id, { ...representative, decorations: dataset.decorations,
        row: { ...representative.row, ...Object.fromEntries(descriptive.map(key => [key, dataset.row[key]])) } })
    }
    return historical
  })
  const { assets, issues, budgetExhausted } = await verifyStacAssets(env, { ...model, datasets: [...datasets, ...collectionModels.values()] })
  if (budgetExhausted && !options.operatorReport) throw new Error('STAC asset probe budget exceeded')
  const logo = branding?.logo_ref ? assets.get(branding.logo_ref) : undefined
  if (logo?.type.startsWith('image/')) {
    model.node.publicLogo = { href: logo.href, type: logo.type }
    assets.set(logo.href, { ...logo, sourceRef: logo.href })
  }
  const resolvers = stacResolvers(model.node, assets)
  const liveCollections = new Map<string, StacCollection>()
  const collectionIssues = new Map<string, string[]>()
  const availableByDataset = new Map<string, StacDatasetReadModel>()
  for (const dataset of datasets) {
    if (assets.has(dataset.row.data_ref) && !availableByDataset.has(dataset.row.id)) availableByDataset.set(dataset.row.id, dataset)
  }
  for (const [id, dataset] of collectionModels) {
    const available = availableByDataset.get(id)
    const candidate = available ? { ...dataset, row: { ...dataset.row, data_ref: available.row.data_ref,
      format: available.row.format, content_digest: available.row.content_digest } } : dataset
    const result = buildStacProduct(candidate, model.node, stacResolvers(model.node, assets, candidate))
    if (!result.ok) collectionIssues.set(id, result.reasons)
    else if (result.value.collection) liveCollections.set(result.value.collection.id, result.value.collection)
  }
  for (const dataset of datasets) {
    const blocked = collectionIssues.get(dataset.row.id)
    const result = blocked ? { ok: false as const, reasons: blocked }
      : buildStacProduct(dataset, model.node, stacResolvers(model.node, assets, dataset))
    const detail = result.reasons.includes('data_asset_unresolved') ? issues.get(dataset.row.data_ref) : undefined
    const existing = reportById.get(dataset.row.id)
    const itemsTotal = dataset.itemIdentity || evaluateTemporal(dataset.row).ready ? 1 : 0
    const reasons = [...result.reasons, ...(detail ? [detail] : [])]
    if (existing) {
      existing.included ||= result.ok
      existing.reasons = [...new Set([...existing.reasons, ...reasons])]
      existing.items_total += itemsTotal
      existing.items_included += result.ok && result.value.item ? 1 : 0
    } else {
      const entry = { id: dataset.row.id, included: result.ok, reasons, items_total: itemsTotal,
        items_included: result.ok && result.value.item ? 1 : 0 }
      report.push(entry)
      reportById.set(entry.id, entry)
    }
    if (result.ok) products.push(result.value)
  }
  mergeHistoryCollections(products, liveCollections)
  linkHistoryRevisions(products, model.history)
  const roots = [...new Map(products.map(product => [product.collection?.id ?? product.item!.id, product])).values()]
  const catalog = buildStacCatalog(model.node, resolvers, roots)
  if (!catalog.ok) throw new Error(`Invalid STAC catalog: ${catalog.reasons.join(',')}`)
  const publication = { catalog: catalog.value, products, report,
    publicationIssues: budgetExhausted ? ['asset_probe_budget_exceeded'] : [] }
  if (env.CATALOG_KV && !options.operatorReport) {
    try { await env.CATALOG_KV.put(key, JSON.stringify(publication), { expirationTtl: 300 }) } catch { /* Best-effort cache. */ }
  }
  return publication
}