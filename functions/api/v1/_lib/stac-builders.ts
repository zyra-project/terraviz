// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { parseColorScale } from '../../../../src/types/color-scale'
import { evaluateMetadataReadiness, evaluateTemporal, isSafeLicenseUrl } from './metadata-readiness'
import type { StacDatasetReadModel, StacNodeContext } from './stac-read-model'
import { applyStacPolicy, approvedStacSelection, stacPlainText, stacVocabularyReferences, type StacSchemaValidator } from './stac-policy'
import { STAC_VERSION, type StacAsset, type StacCatalog, type StacCollection, type StacDocument, type StacItem, type StacLink, type StacProvider, type StacSpatial, type StacTemporal } from './stac-types'

export const TERRAVIZ_SCHEMA = 'https://terraviz.zyra-project.org/schema/stac/terraviz/v1.0.0/schema.json'
export const FILE_SCHEMA = 'https://stac-extensions.github.io/file/v2.1.0/schema.json'
export const CITATION_SCHEMA = 'https://stac-extensions.github.io/scientific/v1.0.0/schema.json'

export interface StacResolvedAsset {
  href: string
  type: string
  anonymous: true
  sourceRef: string
  hostedBy?: string
  byteSize?: number
}
export interface StacResolvers {
  /** Publication adapters must return deployed, public routes; manifest is the existing native playback manifest, not a STAC endpoint.
   *  `dataset` is the native wire record (`/api/v1/datasets/:id`) and `discovery` the node's `/.well-known/terraviz.json`;
   *  both are the canonical-origin side of the STAC ↔ native link (metadata Phase 5). Optional so older adapters still build. */
  resource(kind: 'catalog' | 'collection' | 'item' | 'manifest' | 'dataset' | 'discovery', id: string): string
  listing?(kind: 'collections' | 'items', collectionId?: string): string
  asset(ref: string, purpose: string): StacResolvedAsset | null
  origin?(nodeId: string, datasetId: string): string | null
  schemas?: StacSchemaValidator
}
export type StacBuildResult<T> = { ok: true; value: T; reasons: string[] } | { ok: false; reasons: string[] }
export interface StacProduct { collection: StacCollection | null; item: StacItem | null }

export function isPublicStacUrl(value: unknown): value is string {
  if (!isSafeLicenseUrl(value)) return false
  const url = new URL(value)
  return !url.search && !url.hash
}

function link(rel: string, href: string, type = 'application/json'): StacLink {
  if (!isPublicStacUrl(href)) throw new Error('STAC resolver returned an unsafe resource URL')
  return { rel, href, type }
}

function resourceUrl(resolvers: StacResolvers, kind: Parameters<StacResolvers['resource']>[0], id: string): string | null {
  let href: string
  try { href = resolvers.resource(kind, id) } catch { return null }
  return isPublicStacUrl(href) ? href : null
}

function listingUrl(resolvers: StacResolvers, kind: 'collections' | 'items', collectionId?: string): string | null {
  try {
    const href = resolvers.listing?.(kind, collectionId)
    return isPublicStacUrl(href) ? href : null
  } catch { return null }
}

export function buildStacGeometry(bounds: { n: number; s: number; w: number; e: number } | null): StacSpatial {
  if (!bounds) return { geometry: null }
  const { n, s, w, e } = bounds
  if (![n, s, w, e].every(Number.isFinite) || n <= s || n > 90 || s < -90 || w < -180 || w > 180 || e < -180 || e > 180 || w === e || (w === 180 && e === -180)) throw new Error('Degenerate or invalid STAC extent')
  const ring = (west: number, east: number) => [[west, s], [east, s], [east, n], [west, n], [west, s]]
  if (w <= e) return { bbox: [w, s, e, n], geometry: { type: 'Polygon', coordinates: [ring(w, e)] } }
  const parts = []
  if (w < 180) parts.push([ring(w, 180)])
  if (e > -180) parts.push([ring(-180, e)])
  return { bbox: [w, s, e, n], geometry: { type: 'MultiPolygon', coordinates: parts } }
}

export function sha256Multihash(digest: string | null): string | null {
  return digest && /^sha256:[0-9a-f]{64}$/.test(digest) ? `1220${digest.slice(7)}` : null
}

function verifiedAsset(ref: string, purpose: string, resolvers: StacResolvers): StacResolvedAsset | null {
  let resolved: StacResolvedAsset | null
  try { resolved = resolvers.asset(ref, purpose) } catch { return null }
  return resolved?.anonymous === true && resolved.sourceRef === ref && isPublicStacUrl(resolved.href)
    && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(resolved.type) ? { ...resolved, type: resolved.type.toLowerCase() } : null
}

function assetFrom(resolved: StacResolvedAsset, roles: string[], digest: string | null = null): StacAsset {
  const asset: StacAsset = { href: resolved.href, type: resolved.type, roles }
  const checksum = sha256Multihash(digest)
  if (checksum) asset['file:checksum'] = checksum
  if (Number.isSafeInteger(resolved.byteSize) && resolved.byteSize! >= 0) asset['file:size'] = resolved.byteSize
  return asset
}

function distinct(values: string[]): string[] { return [...new Set(values.filter(value => value.trim()).map(value => value.trim()))].sort() }

function utcInstant(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match) return null
  let iso: string
  try { iso = new Date(match[1] + match[3]).toISOString() } catch { return null }
  const wholeSeconds = iso.replace(/\.000Z$/, '')
  if (wholeSeconds.length !== 19) return null
  return wholeSeconds + (match[2] ?? '') + 'Z'
}

function providers(model: StacDatasetReadModel, node: StacNodeContext, hostedBy: string | undefined): StacProvider[] {
  const result: StacProvider[] = []
  if (model.row.organization?.trim()) result.push({ name: model.row.organization.trim() })
  for (const developer of model.decorations.developers) {
    const role = developer.role === 'data' ? 'producer' : developer.role === 'visualization' ? 'processor' : null
    if (!developer.name.trim()) continue
    result.push({ name: developer.name.trim(), ...(role ? { roles: [role] } : {}), ...(isPublicStacUrl(developer.affiliation_url) ? { url: developer.affiliation_url } : {}) })
  }
  const ordered = [...new Map(result.map(provider => [JSON.stringify(provider), provider])).entries()].sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0).map(([, provider]) => provider)
  if (hostedBy === node.identity.node_id) ordered.push({ name: node.publicOrgName?.trim() || node.identity.display_name, roles: ['host'], ...(isPublicStacUrl(node.identity.base_url) ? { url: node.identity.base_url } : {}) })
  return ordered
}

function declarations(document: StacDocument): void {
  const fields = document.type === 'Feature' ? document.properties : document
  const assets = document.type === 'Catalog' ? [] : Object.values(document.assets ?? {})
  const keys = [...Object.keys(fields), ...assets.flatMap(Object.keys)]
  document.stac_extensions = distinct([
    ...document.stac_extensions,
    ...(keys.some(key => key.startsWith('terraviz:')) ? [TERRAVIZ_SCHEMA] : []),
    ...(keys.some(key => key.startsWith('file:')) ? [FILE_SCHEMA] : []),
    ...(keys.some(key => key.startsWith('sci:')) ? [CITATION_SCHEMA] : []),
  ])
}

export function buildStacCatalog(node: StacNodeContext, resolvers: StacResolvers, children: StacProduct[] = []): StacBuildResult<StacCatalog> {
  const { identity } = node
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identity.node_id) || !identity.display_name.trim()) return { ok: false, reasons: ['node_identity_invalid'] }
  const root = resourceUrl(resolvers, 'catalog', identity.node_id)
  if (!root) return { ok: false, reasons: ['resource_url_invalid'] }
  if (node.customFields?.some(field => field.scope !== 'Catalog')) return { ok: false, reasons: ['custom_field_scope_invalid'] }
  const links = [link('self', root), link('root', root)]
  const discovery = resourceUrl(resolvers, 'discovery', identity.node_id)
  if (discovery) links.push({ ...link('describedby', discovery), title: 'TerraViz node discovery document' })
  if (resolvers.listing) {
    const collections = listingUrl(resolvers, 'collections')
    const items = listingUrl(resolvers, 'items')
    if (!collections || !items) return { ok: false, reasons: ['resource_url_invalid'] }
    links.push(link('data', collections), link('items', items, 'application/geo+json'))
  }
  for (const product of children) {
    const child = product.collection ?? product.item
    if (!child) continue
    const href = resourceUrl(resolvers, child.type === 'Feature' ? 'item' : 'collection', child.id)
    if (!href) return { ok: false, reasons: ['resource_url_invalid'] }
    links.push(link(child.type === 'Feature' ? 'item' : 'child', href, child.type === 'Feature' ? 'application/geo+json' : 'application/json'))
  }
  const selection = approvedStacSelection(node)
  for (const selected of selection?.links ?? []) {
    const resolved = verifiedAsset(selected.url, selected.purpose, resolvers)
    if (resolved) links.push({ ...link(selected.purpose === 'organization' ? 'related' : selected.purpose, resolved.href, resolved.type), title: selected.label })
  }
  if (node.publicLogo) {
    const logo = verifiedAsset(node.publicLogo.href, 'icon', resolvers)
    if (logo && logo.type.startsWith('image/')) links.push(link('icon', logo.href, logo.type))
  }
  const catalog: StacCatalog = {
    type: 'Catalog', stac_version: STAC_VERSION, stac_extensions: [], id: identity.node_id,
    title: identity.display_name,
    description: identity.description?.trim() || (selection?.mission ? stacPlainText(selection.mission, 1000) : '')
      || (selection?.about_md ? stacPlainText(selection.about_md) : '') || `Scientific data catalog for ${node.publicOrgName?.trim() || identity.display_name}.`,
    links: [...new Map(links.map(value => [JSON.stringify(value), value])).entries()].sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0).map(([, value]) => value),
  }
  declarations(catalog)
  const policy = applyStacPolicy(catalog, node, node.customFields ?? [], resolvers.schemas)
  if (!policy.ok) return { ok: false, reasons: policy.reasons }
  return { ok: true, value: catalog, reasons: policy.reasons }
}

export function buildStacProduct(model: StacDatasetReadModel, node: StacNodeContext, resolvers: StacResolvers): StacBuildResult<StacProduct> {
  const { row } = model
  if (row.visibility !== 'public' || row.is_hidden !== 0 || row.retracted_at !== null || !row.published_at) return { ok: false, reasons: ['not_public'] }
  if (row.transcoding === 1) return { ok: false, reasons: ['transcoding_in_progress'] }
  const readiness = evaluateMetadataReadiness({ ...row, publication_kind: model.publicationKind, item_identity: model.itemIdentity, curated_license_evidence: model.licenseReferenceEvidence
    ? Object.fromEntries(Object.entries(model.licenseReferenceEvidence).map(([key, statement]) => [key, { statement }])) : undefined })
  if (readiness.decision === 'excluded' || readiness.decision === 'needs_review') return { ok: false, reasons: readiness.reasons }
  if (!row.title.trim()) return { ok: false, reasons: ['title_missing'] }
  const primary = verifiedAsset(row.data_ref, 'data', resolvers)
  if (!primary || !['image/png', 'image/jpeg', 'image/webp', 'video/mp4', 'application/vnd.apple.mpegurl', 'application/x-mpegurl'].includes(primary.type)) return { ok: false, reasons: ['data_asset_unresolved'] }
  const reasons: string[] = []
  const spatial = buildStacGeometry(readiness.spatial.bounds)
  const collectionId = readiness.identity.collection_id!
  const itemId = readiness.identity.item_id!
  const root = resourceUrl(resolvers, 'catalog', node.identity.node_id)
  const collectionUrl = spatial.geometry ? resourceUrl(resolvers, 'collection', collectionId) : null
  const collectionItemsUrl = collectionUrl && resolvers.listing ? listingUrl(resolvers, 'items', collectionId) : null
  if (collectionUrl && resolvers.listing && !collectionItemsUrl) return { ok: false, reasons: ['resource_url_invalid'] }
  const itemUrl = readiness.temporal.ready ? resourceUrl(resolvers, 'item', itemId) : null
  const manifestUrl = resourceUrl(resolvers, 'manifest', row.id)
  if (!root || !manifestUrl || (spatial.geometry && !collectionUrl) || (readiness.temporal.ready && !itemUrl)) return { ok: false, reasons: ['resource_url_invalid'] }
  let interval: [string, string] | undefined
  if (readiness.temporal.interval) {
    const start = utcInstant(readiness.temporal.interval[0]), end = utcInstant(readiness.temporal.interval[1])
    if (!start || !end) return { ok: false, reasons: ['temporal_utc_invalid'] }
    interval = [start, end]
  }
  const licenseLinks: StacLink[] = []
  if (readiness.license.kind === 'other') {
    const references = model.licenseReferenceEvidence && row.license_spdx?.includes('LicenseRef-')
      ? Object.entries(model.licenseReferenceEvidence).sort(([first], [second]) => first < second ? -1 : 1)
      : [['License', row.license_url || row.license_statement]]
    for (const [title, reference] of references) {
      const licenseAsset = reference ? verifiedAsset(reference, 'license', resolvers) : null
      if (!licenseAsset && reference && !isPublicStacUrl(reference)) return { ok: false, reasons: ['license_text_asset_pending'] }
      if (!licenseAsset || !['text/plain', 'text/html', 'application/pdf'].includes(licenseAsset.type)) return { ok: false, reasons: ['license_asset_unresolved'] }
      licenseLinks.push({ ...link('license', licenseAsset.href, licenseAsset.type), title: title! })
    }
  }
  const assets: Record<string, StacAsset> = {
    data: assetFrom(primary, ['data', 'visual'], /mpegurl/i.test(primary.type) ? null : row.content_digest),
    manifest: { href: manifestUrl, type: 'application/json', roles: ['metadata'] },
  }
  for (const [key, ref, roles] of [
    ['thumbnail', row.thumbnail_ref, ['thumbnail']], ['overview', row.sphere_thumbnail_ref, ['overview', 'visual']],
    ['legend', row.legend_ref, ['metadata', 'visual']], ['captions', row.caption_ref, ['metadata']],
    ['color-table', row.color_table_ref, ['metadata', 'visual']],
  ] as const) {
    if (!ref) continue
    const resolved = verifiedAsset(ref, key, resolvers)
    const validType = resolved && (key === 'captions' ? ['text/vtt', 'application/x-subrip'].includes(resolved.type)
      : key === 'color-table' ? ['application/json', 'text/plain'].includes(resolved.type) || resolved.type.startsWith('image/')
        : ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(resolved.type))
    if (resolved && validType) assets[key] = assetFrom(resolved, [...roles])
    else reasons.push(`${key}_asset_unresolved`)
  }
  for (const rendition of [...model.renditions].sort((first, second) => first.rendition_id < second.rendition_id ? -1 : 1)) {
    const key = `rendition-${rendition.rendition_id}`
    const resolved = verifiedAsset(rendition.ref, key, resolvers)
    if (!resolved || resolved.type !== rendition.mime_type.toLowerCase()) { reasons.push('rendition_asset_unresolved'); continue }
    assets[key] = assetFrom(resolved, ['data', 'visual'], /mpegurl/i.test(resolved.type) ? null : rendition.content_digest)
  }
  const extensionFields: Record<`${string}:${string}`, unknown> = {
    'terraviz:origin_node': row.origin_node, 'terraviz:schema_version': row.schema_version,
  }
  const media = Object.fromEntries(Object.entries(model.media).filter(([, value]) => value !== null))
  if (Object.keys(media).length) assets.data['terraviz:media'] = media
  if (row.legacy_id) extensionFields['terraviz:legacy_id'] = row.legacy_id
  if (row.period) extensionFields['terraviz:cadence'] = row.period
  if (row.lon_origin != null) extensionFields['terraviz:longitude_origin'] = row.lon_origin
  if (row.is_flipped_in_y != null) extensionFields['terraviz:flipped_y'] = row.is_flipped_in_y === 1
  if (row.playback_fps != null) extensionFields['terraviz:playback_fps'] = row.playback_fps
  if (row.rights_holder) extensionFields['terraviz:rights_holder'] = row.rights_holder
  if (row.attribution_text) extensionFields['terraviz:attribution'] = row.attribution_text
  const categories = Object.fromEntries(distinct(model.decorations.categories.map(category => category.facet)).map(facet => [facet, distinct(model.decorations.categories.filter(category => category.facet === facet).map(category => category.value))]))
  if (Object.keys(categories).length) extensionFields['terraviz:categories'] = { owner_node: row.origin_node, values: categories, alignment: 'unaligned' }
  if (row.render_encoding === 'data-luma') {
    const scale = parseColorScale(row.color_scale)
    if (scale) { extensionFields['terraviz:render_encoding'] = 'data-luma'; extensionFields['terraviz:color_scale'] = scale }
    else reasons.push('data_luma_invalid_as_picture')
  }
  if (row.doi) {
    const doi = row.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').trim()
    if (/^10\.\d{4,9}\/\S+$/.test(doi)) extensionFields['sci:doi'] = doi
    else reasons.push('doi_invalid')
  }
  if (row.citation_text) extensionFields['sci:citation'] = row.citation_text
  const keywords = distinct([...model.decorations.keywords, ...model.decorations.tags])
  const attribution = providers(model, node, primary.hostedBy)
  const extraLinks: StacLink[] = [...licenseLinks]
  if (isPublicStacUrl(row.website_link)) extraLinks.push(link('via', row.website_link, 'text/html'))
  for (const related of model.decorations.related) if (isPublicStacUrl(related.related_url)) extraLinks.push({ ...link('related', related.related_url, 'text/html'), title: related.related_title })
  if (row.origin_node !== node.identity.node_id) {
    let origin: string | null | undefined
    try { origin = resolvers.origin?.(row.origin_node, row.id) } catch { return { ok: false, reasons: ['origin_link_unresolved'] } }
    if (!origin || !isPublicStacUrl(origin)) return { ok: false, reasons: ['origin_link_unresolved'] }
    extraLinks.push(link('via', origin))
  } else {
    // The native record this projection was built from, at its canonical origin; `(origin_node, id)` is the join key.
    const native = resourceUrl(resolvers, 'dataset', row.id)
    if (native) extraLinks.push({ ...link('alternate', native), title: 'TerraViz native dataset record' })
  }
  extraLinks.sort((first, second) => JSON.stringify(first) < JSON.stringify(second) ? -1 : JSON.stringify(first) > JSON.stringify(second) ? 1 : 0)
  const license = readiness.license.kind === 'spdx' ? row.license_spdx! : 'other'
  const common = { ...extensionFields, title: row.title, description: row.abstract?.trim() || row.title, keywords, providers: attribution }
  const collection: StacCollection | null = collectionUrl && spatial.bbox ? {
    type: 'Collection', stac_version: STAC_VERSION, stac_extensions: [], id: collectionId, ...common, license,
    extent: { spatial: { bbox: [spatial.bbox] }, temporal: { interval: [interval ?? [null, null]] } },
    links: [link('self', collectionUrl), link('root', root), link('parent', root),
      ...(collectionItemsUrl ? [link('items', collectionItemsUrl, 'application/geo+json')] : []),
      ...(itemUrl ? [link('item', itemUrl, 'application/geo+json')] : []), ...extraLinks],
    ...(!itemUrl ? { assets } : {}),
  } : null
  let item: StacItem | null = null
  if (itemUrl && interval) {
    const [start, end] = interval
    const temporal: StacTemporal = readiness.temporal.status === 'instant' ? { datetime: start } : { datetime: null, start_datetime: start, end_datetime: end }
    item = { type: 'Feature', stac_version: STAC_VERSION, stac_extensions: [], id: itemId, ...spatial,
      ...(collection ? { collection: collectionId } : {}),
      properties: { ...common, ...temporal, ...(!collection || model.itemIdentity ? { license } : {}) }, assets,
      links: [link('self', itemUrl, 'application/geo+json'), link('root', root), link('parent', collectionUrl ?? root), ...(collectionUrl ? [link('collection', collectionUrl)] : []), ...extraLinks],
    }
    for (const [key, value] of [['created', row.created_at], ['updated', row.updated_at]] as const) {
      if (!evaluateTemporal({ temporal_semantics: 'represented', temporal_evidence: 'Metadata timestamp syntax check', start_time: value, end_time: value }).ready) continue
      const instant = utcInstant(value)
      if (!instant) return { ok: false, reasons: [`${key}_utc_invalid`] }
      item.properties[key] = instant
    }
  }
  for (const field of model.customFields ?? []) {
    if (!['Collection', 'Item', 'Asset'].includes(field.scope)) return { ok: false, reasons: ['custom_field_scope_invalid'] }
    if (field.essential && ((field.scope === 'Collection' && !collection) || (field.scope === 'Item' && !item))) return { ok: false, reasons: ['essential_field_target_missing'] }
  }
  for (const document of [collection, item]) {
    if (!document) continue
    if (model.vocabularyReferences?.length) {
      const references = stacVocabularyReferences(model.vocabularyReferences, node)
      if (!references.ok) return { ok: false, reasons: references.reasons }
      for (const reference of references.value) {
        if (reference.ownerNodeId !== row.origin_node) return { ok: false, reasons: ['vocabulary_origin_mismatch'] }
        const resolved = verifiedAsset(reference.vocabularyUri, 'vocabulary', resolvers)
        if (!resolved) return { ok: false, reasons: ['vocabulary_resource_unresolved'] }
        document.links.push(link('related', resolved.href, resolved.type))
      }
      const target = document.type === 'Feature' ? document.properties : document
      target['terraviz:vocabularies'] = structuredClone(references.value).sort((first, second) => JSON.stringify(first) < JSON.stringify(second) ? -1 : 1)
    }
    // Built-in declarations precede schema validation; policy owns custom URIs and rejects reserved prefixes.
    declarations(document)
    const policy = applyStacPolicy(document, node, model.customFields ?? [], resolvers.schemas)
    if (!policy.ok) return { ok: false, reasons: policy.reasons }
    reasons.push(...policy.reasons)
  }
  return { ok: true, value: { collection, item }, reasons: distinct(reasons) }
}

export function stacEtagInput(document: StacDocument): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value
  return JSON.stringify(canonical(document))
}