// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { buildStacCatalog, buildStacGeometry, buildStacProduct, sha256Multihash, stacEtagInput } from './stac-builders'
import { stacFixture } from './stac-test-helpers'
import { buildStacVocabulary, stacPlainText } from './stac-policy'
import { createStacSchemaValidator } from './stac-schema'
import type { ExtensionRegistration, MetadataReviewEvidence, VocabularyDescriptor } from './metadata-policy'

const approval: MetadataReviewEvidence = { authorId: 'author', authorRole: 'admin', reviewerId: 'reviewer', reviewerRole: 'service', changeId: 'review', reason: 'Reviewed publication' }
const registration = (): ExtensionRegistration => ({ prefix: 'lab', ownerNodeId: 'NODE000', schemaUri: 'https://lab.example/ext/v1.0.0/schema.json', schemaSha256: 'sha256:' + 'a'.repeat(64), version: '1.0.0', scopes: ['Item', 'Asset'], fields: [{ key: 'lab:code', scopes: ['Item', 'Asset'] }], maxPayloadBytes: 1024, approval })
const vocabulary = (ownerNodeId = 'NODE000'): VocabularyDescriptor => ({ formatVersion: 1, vocabularyUri: `https://vocab.example/${ownerNodeId}`, ownerNodeId, revision: 1, approval,
  facets: [{ id: 'theme', labels: [{ language: 'en', label: 'Theme' }], definition: 'Local theme', terms: [{ id: 'ocean', labels: [{ language: 'en', label: 'Ocean' }], definition: `${ownerNodeId} meaning`, mappings: [{ relation: 'http://www.w3.org/2004/02/skos/core#relatedMatch', conceptUri: 'https://concept.example/ocean' }] }] }] })

describe('pure STAC builders', () => {
  it('builds an identity-only root without reading private profile prose', async () => {
    const { node, resolvers } = await stacFixture()
    node.identity.description = 'Public node description'
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: 'Public node description', stac_extensions: [] } })
    node.identity.description = null
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: 'Scientific data catalog for ' + node.identity.display_name + '.' } })
  })

  it('links the root to native discovery and each local product to its native record', async () => {
    const { model, node, resolvers } = await stacFixture()
    const root = buildStacCatalog(node, resolvers)
    expect(root.ok && root.value.links).toContainEqual(expect.objectContaining({ rel: 'describedby', href: 'https://node.example/discovery/NODE000' }))
    const built = buildStacProduct(model, node, resolvers)
    if (!built.ok) throw new Error('expected a product')
    const native = { rel: 'via', type: `application/json; profile="${node.identity.base_url}/schema/v1/dataset.schema.json"`, href: `https://node.example/dataset/${model.row.id}` }
    expect(built.value.collection!.links).toContainEqual(expect.objectContaining(native))
    expect(built.value.item!.links).toContainEqual(expect.objectContaining(native))
  })

  it('keeps the native link on a history-backed Collection but not its historical Item', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.itemIdentity = { kind: 'frame', persisted_id: 'frame-one' }
    model.publicationKind = 'sequence'
    const built = buildStacProduct(model, node, resolvers)
    if (!built.ok) throw new Error(JSON.stringify(built.reasons))
    const href = `https://node.example/dataset/${model.row.id}`
    expect(built.value.collection!.links).toContainEqual(expect.objectContaining({ rel: 'via', href }))
    expect(built.value.item!.links.some(candidate => candidate.href === href)).toBe(false)
  })

  it('builds deterministic linked resources and separates data from manifest', async () => {
    const { model, node, resolvers } = await stacFixture()
    const built = buildStacProduct(model, node, resolvers)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.value.collection?.id).toBe(`NODE000-${model.row.id}`)
    expect(built.value.item).toMatchObject({ id: model.row.id, properties: { datetime: null, start_datetime: model.row.start_time, end_datetime: model.row.end_time }, assets: { data: { type: 'image/png', href: 'https://data.example/image.png' }, manifest: { type: 'application/json', roles: ['metadata'] } } })
    model.row.slug = 'renamed'
    expect(buildStacProduct(model, node, resolvers)).toEqual(built)
    expect(stacEtagInput(built.value.item!)).toBe(stacEtagInput(structuredClone(built.value.item!)))
  })

  it('supports honest unknown geometry and open collection time', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.row.bbox_provenance = 'unknown'
    expect(buildStacProduct(model, node, resolvers)).toMatchObject({ ok: true, value: { collection: null, item: { geometry: null } } })
    model.row.bbox_provenance = 'measured'
    model.row.temporal_semantics = 'unknown'
    expect(buildStacProduct(model, node, resolvers)).toMatchObject({ ok: true, value: { item: null, collection: { extent: { temporal: { interval: [[null, null]] } }, assets: { data: { type: 'image/png' } } } } })
  })

  it('splits antimeridian rings and does not invent bundle or upload hashes', () => {
    expect(buildStacGeometry({ n: 20, s: -20, w: 170, e: -170 })).toMatchObject({ bbox: [170, -20, -170, 20], geometry: { type: 'MultiPolygon', coordinates: [expect.any(Array), expect.any(Array)] } })
    expect(buildStacGeometry(null)).toEqual({ geometry: null })
    expect(sha256Multihash(`sha256:${'a'.repeat(64)}`)).toBe(`1220${'a'.repeat(64)}`)
    expect(sha256Multihash('sha256:wrong')).toBeNull()
  })

  it('requires current reviewed selections and never falls back to private draft fields', async () => {
    const { node, resolvers } = await stacFixture()
    node.identity.description = null
    node.publicSelection = { nodeId: node.identity.node_id, revision: 1, selectedValues: { mission: 'Approved mission' }, approval: { authorId: 'author', authorRole: 'admin', reviewerId: 'reviewer', reviewerRole: 'service', changeId: 'change', reason: 'Public selection' } }
    expect(buildStacCatalog(node, resolvers)).not.toMatchObject({ value: { description: 'Approved mission' } })
    node.policyCurrent = true
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: 'Approved mission' } })
    node.publicSelection.selectedValues = {}
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: `Scientific data catalog for ${node.identity.display_name}.` } })
  })

  it('omits unknown optional custom fields and withholds essential ones', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.customFields = [{ key: 'lab:code', value: 'hidden', scope: 'Item', ownerNodeId: 'LAB', essential: false }]
    expect(buildStacProduct(model, node, resolvers)).toMatchObject({ ok: true, reasons: expect.arrayContaining(['unknown_prefix']) })
    model.customFields[0].essential = true
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['unknown_prefix'] })
  })
})

describe('eligibility and mapping matrix', () => {
  it.each(['catalog', 'collection', 'item', 'manifest'] as const)('reports only resolver failures as resource URL errors (%s)', async kind => {
    const { model, node, resolvers } = await stacFixture()
    const product = buildStacProduct(model, node, resolvers)
    if (!product.ok) throw new Error(product.reasons.join(','))
    const original = resolvers.resource
    resolvers.resource = (requested, id) => { if (requested === kind) throw new Error('Resource unavailable'); return original(requested, id) }
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['resource_url_invalid'] })
    if (kind === 'catalog' || kind === 'collection') expect(buildStacCatalog(node, resolvers, [product.value])).toEqual({ ok: false, reasons: ['resource_url_invalid'] })
  })

  it('reports failed origin resolution without masking implementation errors', async () => {
    const { model, node, resolvers } = await stacFixture()
    node.identity.node_id = 'MIRROR'
    resolvers.origin = () => { throw new Error('Unavailable origin') }
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['origin_link_unresolved'] })
  })

  it('reports UTC normalization overflow as a temporal error', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.row.start_time = model.row.end_time = '9999-12-31T23:59:59-23:59'
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['temporal_utc_invalid'] })
  })

  it.each([{ bbox_n: -30 }, { bbox_w: 60 }, { bbox_w: 180, bbox_e: -180 }])('returns actionable degenerate bounds reasons: %j', async bounds => {
    const { model, node, resolvers } = await stacFixture()
    Object.assign(model.row, bounds)
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['spatial_bounds_degenerate'] })
    expect(() => buildStacGeometry({ n: model.row.bbox_n!, s: model.row.bbox_s!, w: model.row.bbox_w!, e: model.row.bbox_e! })).toThrow('Degenerate')
  })

  it.each([['video/mp4', 'VIDEO/MP4'], ['VIDEO/MP4', 'video/mp4']])('maps rendition MIME %s to %s without using upload digests', async (storedType, resolvedType) => {
    const { model, node, resolvers } = await stacFixture()
    model.row.thumbnail_ref = 'url:https://data.example/thumb.png'
    model.row.caption_ref = 'url:https://data.example/captions.vtt'
    model.renditions = [{ dataset_id: model.row.id, rendition_id: 'REN1', codec: 'h264', color_space: 'rec709', bit_depth: 8, has_alpha: 0, alpha_encoding: null,
      width: 2048, height: 1024, bitrate_kbps: 1000, ref: 'r2:rendition.mp4', mime_type: storedType, content_digest: 'sha256:' + 'c'.repeat(64), created_at: '2026-01-01T00:00:00Z' }]
    const original = resolvers.asset
    resolvers.asset = (ref, purpose) => purpose === 'rendition-REN1' || purpose === 'captions'
      ? { sourceRef: ref, href: `https://assets.example/${purpose}`, type: purpose === 'captions' ? 'TEXT/VTT' : resolvedType, anonymous: true, byteSize: 1000 } : original(ref, purpose)
    const result = buildStacProduct(model, node, resolvers)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.item!.assets['rendition-REN1']).toMatchObject({ 'file:checksum': '1220' + 'c'.repeat(64), 'file:size': 1000 })
    expect(result.value.item!.assets.captions.type).toBe('text/vtt')
    expect(result.value.item!.assets.thumbnail.roles).toEqual(['thumbnail'])
    model.renditions[0].mime_type = 'image/png'
    const mismatch = buildStacProduct(model, node, resolvers)
    if (mismatch.ok) expect(mismatch.value.item!.assets).not.toHaveProperty('rendition-REN1')
    else throw new Error('Optional rendition mismatch must not withhold the primary asset')
  })

  it('stabilizes ordering and preserves provider roles without guessing', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.decorations.developers = [{ role: 'data', name: 'Producer', affiliation_url: 'https://producer.example/' }, { role: 'visualization', name: 'Processor', affiliation_url: null }, { role: 'unknown', name: 'Contributor', affiliation_url: null }]
    model.decorations.keywords = ['Z', 'A', 'Z']
    model.decorations.related = [{ related_title: 'Z', related_url: 'https://related.example/z' }, { related_title: 'A', related_url: 'https://related.example/a' }]
    const first = buildStacProduct(model, node, resolvers)
    model.decorations.developers.reverse()
    model.decorations.related.reverse()
    model.decorations.keywords.reverse()
    expect(buildStacProduct(model, node, resolvers)).toEqual(first)
    if (!first.ok) throw new Error(first.reasons.join(','))
    expect(first.value.collection!.providers).toContainEqual({ name: 'Processor', roles: ['processor'] })
    expect(first.value.collection!.providers).toContainEqual({ name: 'Contributor' })
    const reordered = Object.fromEntries(Object.entries(first.value.item!).reverse()) as typeof first.value.item
    expect(stacEtagInput(reordered!)).toBe(stacEtagInput(first.value.item!))
  })

  it.each([
    ['private', { visibility: 'private' }], ['restricted', { visibility: 'restricted' }], ['federated', { visibility: 'federated' }],
    ['hidden', { is_hidden: 1 }], ['draft', { published_at: null }], ['retracted', { retracted_at: '2026-01-01' }],
    ['transcoding', { transcoding: 1 }], ['tour', { format: 'tour/json' }], ['non-Earth', { celestial_body: 'Mars' }],
    ['unknown kind', { resource_kind: 'unknown' }], ['sequence', { frame_count: 10 }], ['unknown schema', { schema_version: 2 }],
    ['no title', { title: ' ' }], ['degenerate box', { bbox_n: -30 }], ['inferred extent', { bbox_provenance: 'inferred' }],
    ['missing extent evidence', { bbox_evidence: null }], ['invalid interval', { end_time: '2025-01-01T00:00:00Z' }],
    ['missing time', { end_time: null }], ['bad calendar', { start_time: '2026-02-30T00:00:00Z' }],
    ['malformed license', { license_spdx: 'not-a-license' }], ['missing license', { license_spdx: null, license_url: null, license_statement: null }],
  ])('withholds %s', async (_name, fields) => {
    const { model, node, resolvers } = await stacFixture()
    Object.assign(model.row, fields)
    expect(buildStacProduct(model, node, resolvers).ok).toBe(false)
  })

  it.each(['workflow', 'sequence', 'unknown'] as const)('does not fabricate %s identities', async publicationKind => {
    const { model, node, resolvers } = await stacFixture()
    model.publicationKind = publicationKind
    expect(buildStacProduct(model, node, resolvers).ok).toBe(false)
  })

  it.each([
    { n: 90, s: -90, w: -180, e: 180 }, { n: 30, s: 20, w: 10, e: 20 },
    { n: 30, s: 20, w: 180, e: -170 }, { n: 30, s: 20, w: 170, e: -180 },
  ])('produces closed rings for %j', bounds => {
    const spatial = buildStacGeometry(bounds)
    const polygons = spatial.geometry!.type === 'Polygon' ? [spatial.geometry!.coordinates] : spatial.geometry!.coordinates
    for (const polygon of polygons) expect(polygon[0][0]).toEqual(polygon[0].at(-1))
  })

  it.each([
    ['url:https://data.example/file.png', 'image/png'], ['url:https://data.example/file.mp4', 'video/mp4'],
    ['r2:private-internal-key/file.png', 'image/png'], ['stream:opaque-id', 'application/vnd.apple.mpegurl'],
    ['vimeo:12345', 'video/mp4'], ['peer:origin/asset', 'image/jpeg'], ['r2:bundle/master.m3u8', 'application/x-mpegURL'],
    ['r2:bundle/master.m3u8', 'application/x-mpegurl'], ['stream:opaque-id', 'application/VND.APPLE.MPEGURL'],
    ['url:https://data.example/file.png', 'IMAGE/PNG'],
  ])('uses only resolved %s assets', async (ref, type) => {
    const { model, node, resolvers } = await stacFixture()
    model.row.data_ref = ref
    model.row.content_digest = 'sha256:' + 'a'.repeat(64)
    model.row.source_digest = 'sha256:' + 'b'.repeat(64)
    resolvers.asset = sourceRef => sourceRef === ref ? { sourceRef, href: 'https://assets.example/delivered', type, anonymous: true } : null
    const result = buildStacProduct(model, node, resolvers)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const asset = result.value.item!.assets.data
    expect(asset).toMatchObject({ href: 'https://assets.example/delivered', type: type.toLowerCase() })
    expect(asset['file:checksum']).toBe(/mpegurl/i.test(type) ? undefined : '1220' + 'a'.repeat(64))
    expect(JSON.stringify(result)).not.toContain('b'.repeat(64))
    expect(JSON.stringify(result)).not.toContain('private-internal-key')
  })

  it.each(['https://assets.example/file?token=secret', 'https://user:secret@assets.example/file', 'r2:key', 'javascript:alert(1)'])('rejects unsafe resolver URL %s', async href => {
    const { model, node, resolvers } = await stacFixture()
    resolvers.asset = sourceRef => ({ sourceRef, href, type: 'image/png', anonymous: true })
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['data_asset_unresolved'] })
  })

  it('converts resolver exceptions to structured failures', async () => {
    const { model, node, resolvers } = await stacFixture()
    resolvers.asset = () => { throw new Error('unavailable') }
    expect(buildStacProduct(model, node, resolvers).ok).toBe(false)
  })

  it.each(['MIT OR Apache-2.0', 'GPL-2.0-only WITH Classpath-exception-2.0'])('preserves SPDX expression %s', async license => {
    const { model, node, resolvers } = await stacFixture()
    model.row.license_spdx = license
    expect(buildStacProduct(model, node, resolvers)).toMatchObject({ ok: true, value: { collection: { license } } })
  })

  it('requires resolved text for every curated LicenseRef', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.row.license_spdx = 'LicenseRef-One AND LicenseRef-Two'
    model.licenseReferenceEvidence = { 'LicenseRef-One': 'First terms', 'LicenseRef-Two': 'Second terms' }
    const original = resolvers.asset
    resolvers.asset = (ref, purpose) => purpose === 'license' ? { sourceRef: ref, href: `https://licenses.example/${ref === 'First terms' ? 'one' : 'two'}`, type: 'text/plain', anonymous: true } : original(ref, purpose)
    const result = buildStacProduct(model, node, resolvers)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.collection!.links.filter(link => link.rel === 'license')).toHaveLength(2)
    resolvers.asset = (ref, purpose) => ref === 'Second terms' ? null : original(ref, purpose)
    expect(buildStacProduct(model, node, resolvers).ok).toBe(false)
  })

  it.each([true, false])('keeps mirror origin and host attribution distinct (host=%s)', async hosted => {
    const { model, node, resolvers } = await stacFixture()
    node.identity.node_id = 'MIRROR'
    node.publicOrgName = 'Index organization'
    resolvers.origin = () => 'https://origin.example/dataset/original'
    const original = resolvers.asset
    resolvers.asset = (ref, purpose) => { const asset = original(ref, purpose); return asset ? { ...asset, hostedBy: hosted ? 'MIRROR' : 'NODE000' } : null }
    const result = buildStacProduct(model, node, resolvers)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.collection!.id).toBe(`NODE000-${model.row.id}`)
    expect(result.value.collection!.providers!.filter(provider => provider.roles?.includes('host'))).toHaveLength(hosted ? 1 : 0)
    expect(result.value.collection!.links).toContainEqual(expect.objectContaining({ href: 'https://origin.example/dataset/original' }))
    // A mirror never claims its own copy is the native record; the origin link is the join.
    expect(result.value.collection!.links.some(l => l.rel === 'alternate')).toBe(false)
  })

  it('omits invalid data-luma pairs without reporting numeric data', async () => {
    const { model, node, resolvers } = await stacFixture()
    model.row.render_encoding = 'data-luma'
    model.row.color_scale = '{broken'
    const result = buildStacProduct(model, node, resolvers)
    expect(result).toMatchObject({ ok: true, reasons: expect.arrayContaining(['data_luma_invalid_as_picture']) })
    if (result.ok) expect(result.value.item!.properties).not.toHaveProperty('terraviz:render_encoding')
  })
})

describe('policy integration matrix', () => {
  it.each(['Catalog', 'Item'] as const)('does not disguise unexpected %s policy exceptions as resolver errors', async scope => {
    const { model, node, resolvers } = await stacFixture()
    const extension = registration()
    extension.scopes.push('Catalog')
    extension.fields[0].scopes.push('Catalog')
    node.extensions = [extension]
    node.policyCurrent = true
    const fields = [{ key: 'lab:code', value: 'valid', scope, ownerNodeId: 'NODE000', essential: true }]
    const error = new TypeError('Unexpected validator defect')
    resolvers.schemas = { validate: () => { throw error } }
    if (scope === 'Catalog') {
      node.customFields = fields
      expect(() => buildStacCatalog(node, resolvers)).toThrow(error)
    } else {
      model.customFields = fields
      expect(() => buildStacProduct(model, node, resolvers)).toThrow(error)
    }
  })

  it.each(['__proto__', 'constructor', 'missing'])('rejects non-own Asset target %s', async assetKey => {
    const { model, node, resolvers } = await stacFixture()
    node.policyCurrent = true
    node.extensions = [registration()]
    resolvers.schemas = { validate: () => 'valid' }
    model.customFields = [{ key: 'lab:code', value: 'not-an-asset', scope: 'Asset', ownerNodeId: 'NODE000', essential: true, assetKey }]
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['custom_field_target_invalid'] })
    expect(Object.prototype).not.toHaveProperty('lab:code')
  })

  it.each(['unapproved', 'stale', 'missing-schema'])('omits optional %s fields without declaring unused schemas', async mode => {
    const { model, node, resolvers } = await stacFixture()
    node.policyCurrent = mode !== 'stale'
    node.extensions = [{ ...registration(), approval: mode === 'unapproved' ? null : approval }]
    model.customFields = [{ key: 'lab:code', value: 'private', scope: 'Item', ownerNodeId: 'NODE000', essential: false }]
    const result = buildStacProduct(model, node, resolvers)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.item!.properties).not.toHaveProperty('lab:code')
    expect(result.value.item!.stac_extensions).not.toContain(registration().schemaUri)
  })

  it('publishes only origin-owned reviewed vocabulary references and links', async () => {
    const { model, node, resolvers } = await stacFixture()
    const descriptor = vocabulary()
    node.policyCurrent = true
    node.vocabularies = [descriptor]
    model.vocabularyReferences = [{ vocabularyUri: descriptor.vocabularyUri, ownerNodeId: 'NODE000', revision: 1, facetId: 'theme', termIds: ['ocean'] }]
    const original = resolvers.asset
    resolvers.asset = (ref, purpose) => purpose === 'vocabulary' ? { sourceRef: ref, href: ref, type: 'application/json', anonymous: true } : original(ref, purpose)
    const result = buildStacProduct(model, node, resolvers)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result)).not.toContain('reviewerId')
    if (result.ok) expect(result.value.item!.properties['terraviz:vocabularies']).toEqual(model.vocabularyReferences)
    node.vocabularies[0].approval = null
    expect(buildStacProduct(model, node, resolvers).ok).toBe(false)
  })

  it('resolves public logos without leaking raw R2 refs or private profile fields', async () => {
    const { node, resolvers } = await stacFixture()
    node.identity.description = null
    node.publicOrgName = 'Public organization'
    node.publicLogo = { href: 'r2:internal/logo.png', type: 'image/png' }
    Object.assign(node, { profile: { mission: 'Private mission', tone: 'Private tone' } })
    const unresolved = buildStacCatalog(node, resolvers)
    expect(JSON.stringify(unresolved)).not.toMatch(/r2:|Private/)
    resolvers.asset = sourceRef => ({ sourceRef, href: 'https://assets.example/logo.png', type: 'image/png', anonymous: true })
    expect(buildStacCatalog(node, resolvers)).toMatchObject({ ok: true, value: { description: 'Scientific data catalog for Public organization.', links: expect.arrayContaining([expect.objectContaining({ rel: 'icon', href: 'https://assets.example/logo.png' })]) } })
  })

  it.each(['Item', 'Asset'] as const)('validates a registered %s field using actual pinned bytes', async scope => {
    const { model, node, resolvers } = await stacFixture()
    const extension = registration()
    const fieldSchema = { type: 'object', properties: { 'lab:code': { type: 'string' } } }
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#', $id: extension.schemaUri, type: 'object', properties: { properties: fieldSchema, assets: { type: 'object', additionalProperties: fieldSchema } } }
    const bytes = new TextEncoder().encode(JSON.stringify(schema))
    extension.schemaSha256 = 'sha256:' + createHash('sha256').update(bytes).digest('hex')
    node.extensions = [extension]
    node.policyCurrent = true
    resolvers.schemas = await createStacSchemaValidator([{ uri: extension.schemaUri, sha256: extension.schemaSha256, bytes }])
    model.customFields = [{ key: 'lab:code', value: 'verified', scope, ownerNodeId: 'NODE000', essential: true, ...(scope === 'Asset' ? { assetKey: 'data' } : {}) }]
    expect(buildStacProduct(model, node, resolvers).ok).toBe(true)
    model.customFields[0].value = 42
    expect(buildStacProduct(model, node, resolvers)).toEqual({ ok: false, reasons: ['extension_schema_invalid'] })
  })

  it.each(['unapproved', 'stale', 'unavailable', 'owner', 'scope', 'reserved', 'aggregate', 'invalid-schema'])('handles %s policy inputs explicitly', async mode => {
    const { model, node, resolvers } = await stacFixture()
    node.policyCurrent = true
    node.extensions = [registration()]
    model.customFields = [{ key: 'lab:code', value: 'valid', scope: 'Item', ownerNodeId: 'NODE000', essential: true }]
    resolvers.schemas = { validate: vi.fn(() => 'valid' as const) }
    if (mode === 'unapproved') node.extensions[0].approval = null
    if (mode === 'stale') node.policyCurrent = false
    if (mode === 'unavailable') delete resolvers.schemas
    if (mode === 'owner') model.customFields[0].ownerNodeId = 'OTHER'
    if (mode === 'scope') model.customFields[0].scope = 'Catalog'
    if (mode === 'reserved') model.customFields[0].key = 'terraviz:origin_node'
    if (mode === 'aggregate') {
      node.extensions[0].maxPayloadBytes = 30
      node.extensions[0].fields.push({ key: 'lab:more', scopes: ['Item'] })
      model.customFields.push({ ...model.customFields[0], key: 'lab:more' })
    }
    if (mode === 'invalid-schema') resolvers.schemas = { validate: () => 'invalid' }
    expect(buildStacProduct(model, node, resolvers).ok).toBe(false)
  })

  it('retains vocabulary meanings and removes private approval identities', async () => {
    const { node } = await stacFixture()
    node.policyCurrent = true
    const first = buildStacVocabulary(vocabulary(), node)
    const second = buildStacVocabulary(vocabulary('OTHER'), node)
    expect(first.ok && second.ok).toBe(true)
    expect(JSON.stringify(first)).not.toContain('reviewerId')
    expect(first).not.toEqual(second)
    if (first.ok) expect(first.value.facets[0].terms[0].mappings[0].relation).toContain('relatedMatch')
  })

  it('requires vocabulary ownership to match the resource origin', async () => {
    const { model, node, resolvers } = await stacFixture()
    const descriptor = vocabulary('OTHER')
    node.policyCurrent = true
    node.vocabularies = [descriptor]
    model.vocabularyReferences = [{ vocabularyUri: descriptor.vocabularyUri, ownerNodeId: 'OTHER', revision: 1, facetId: 'theme', termIds: ['ocean'] }]
    const original = resolvers.asset
    resolvers.asset = (ref, purpose) => purpose === 'vocabulary' ? { sourceRef: ref, href: ref, type: 'application/json', anonymous: true } : original(ref, purpose)
    expect(buildStacProduct(model, node, resolvers).ok).toBe(false)
  })

  it('uses approved Markdown only as safe bounded text', async () => {
    expect(stacPlainText('A **bold** [link](javascript:alert(1)) <img src=x onerror=alert(1)>')).not.toMatch(/<img|javascript:|onerror/)
    expect(Array.from(stacPlainText('x'.repeat(1000)))).toHaveLength(600)
    const { node, resolvers } = await stacFixture()
    node.identity.description = null
    node.policyCurrent = true
    node.publicSelection = { nodeId: node.identity.node_id, revision: 1, approval, selectedValues: { about_md: '**Public** about' } }
    const root = buildStacCatalog(node, resolvers)
    expect(root).toMatchObject({ ok: true, value: { description: 'Public about' } })
    node.publicSelection.selectedValues.links = [{ purpose: 'related', label: 'Unsafe', url: 'javascript:alert(1)' }]
    expect(buildStacCatalog(node, resolvers)).not.toEqual(root)
    node.publicSelection.selectedValues = {}
    expect(JSON.stringify(buildStacCatalog(node, resolvers))).not.toContain('Public about')
  })
})