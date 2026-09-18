// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import Ajv from 'ajv'
import { addStacFormats, createStacSchemaValidator, type StacSchemaSource } from './stac-schema'
import { buildStacCatalog, buildStacProduct, TERRAVIZ_SCHEMA } from './stac-builders'
import { stacFixture, stacRouteFixture } from './stac-test-helpers'
import { onRequestGet } from '../stac/[[path]]'
import { makeCtx } from './test-helpers'
import { readStacPublication } from './stac-publication'

function source(bytes: Uint8Array, uri = TERRAVIZ_SCHEMA): StacSchemaSource {
  return { uri, bytes, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }
}

describe('pinned local extension schemas', () => {
  it('counts references across all schemas in a bundle', async () => {
    const schema = (name: string, count: number) => {
      const uri = `https://lab.example/${name}.json`
      return source(new TextEncoder().encode(JSON.stringify({ $id: uri, $schema: 'http://json-schema.org/draft-07/schema#',
        definitions: { anything: {} }, allOf: Array.from({ length: count }, () => ({ $ref: '#/definitions/anything' })) })), uri)
    }
    const first = schema('first', 20), second = schema('second', 20)
    await expect(createStacSchemaValidator([first])).resolves.toHaveProperty('validate')
    await expect(createStacSchemaValidator([second])).resolves.toHaveProperty('validate')
    await expect(createStacSchemaValidator([first, second])).rejects.toThrow('across the bundle')
    await expect(createStacSchemaValidator([schema('first', 16), schema('second', 16)])).resolves.toHaveProperty('validate')
  })

  it.each(['unknown-keyword', 'unknown-format', 'bad-pointer', 'nested-id', 'reference-limit', 'depth-limit'])('rejects %s schema input', async mode => {
    let body: Record<string, unknown> = {}
    if (mode === 'unknown-keyword') body = { inventedKeyword: true }
    if (mode === 'unknown-format') body = { type: 'string', format: 'unreviewed-format' }
    if (mode === 'bad-pointer') body = { $ref: '#/definitions/missing' }
    if (mode === 'nested-id') body = { properties: { nested: { $id: 'https://nested.example/schema.json' } } }
    if (mode === 'reference-limit') body = { definitions: { text: { type: 'string' } }, allOf: Array.from({ length: 33 }, () => ({ $ref: '#/definitions/text' })) }
    if (mode === 'depth-limit') {
      const definitions: Record<string, unknown> = { end: { type: 'string' } }
      for (let index = 9; index >= 0; index--) definitions[`depth${index}`] = { $ref: `#/definitions/${index === 9 ? 'end' : `depth${index + 1}`}` }
      body = { definitions, $ref: '#/definitions/depth0' }
    }
    const schema = source(new TextEncoder().encode(JSON.stringify({ $id: TERRAVIZ_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#', ...body })))
    await expect(createStacSchemaValidator([schema])).rejects.toThrow()
  })

  it('resolves local external refs and fails digest mismatches without fetching', async () => {
    const dependencyUri = 'https://lab.example/definition.json'
    const dependency = source(new TextEncoder().encode(JSON.stringify({ $id: dependencyUri, $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' })), dependencyUri)
    const root = source(new TextEncoder().encode(JSON.stringify({ $id: TERRAVIZ_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#', $ref: dependencyUri })))
    const validator = await createStacSchemaValidator([root, dependency])
    const { node, resolvers } = await stacFixture()
    const catalog = buildStacCatalog(node, resolvers)
    if (!catalog.ok) throw new Error(catalog.reasons.join(','))
    expect(validator.validate(root.uri, root.sha256, catalog.value)).toBe('valid')
    expect(validator.validate(root.uri, 'sha256:' + '0'.repeat(64), catalog.value)).toBe('invalid')
    expect(validator.validate('https://absent.example/schema.json', root.sha256, catalog.value)).toBe('unavailable')
  })

  it('validates the emitted Terraviz fields and rejects unknown fields', async () => {
    const schema = source(readFileSync('docs/metadata/schemas/terraviz-v1.0.0.json'))
    const validator = await createStacSchemaValidator([schema])
    const { model, node, resolvers } = await stacFixture()
    model.row.render_encoding = 'data-luma'
    model.row.color_scale = JSON.stringify({ vmin: 0, vmax: 100, stops: [{ t: 0, rgba: [0, 0, 0, 0] }, { t: 1, rgba: [255, 255, 255, 255] }] })
    const built = buildStacProduct(model, node, resolvers)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    for (const document of [built.value.collection!, built.value.item!]) expect(validator.validate(schema.uri, schema.sha256, document)).toBe('valid')
    built.value.item!.properties['terraviz:unknown'] = true
    expect(validator.validate(schema.uri, schema.sha256, built.value.item!)).toBe('invalid')
  })

  it.each(['digest', 'unresolved', 'cycle', 'oversize'])('rejects %s bundles without network', async kind => {
    const schema = source(new TextEncoder().encode(JSON.stringify({ $id: TERRAVIZ_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#',
      ...(kind === 'unresolved' ? { $ref: 'https://unavailable.example/schema.json' } : kind === 'cycle' ? { $ref: '#' } : {}) })))
    if (kind === 'digest') schema.sha256 = 'sha256:' + '0'.repeat(64)
    if (kind === 'oversize') schema.bytes = new Uint8Array(1048577)
    await expect(createStacSchemaValidator([schema])).rejects.toThrow()
  })
})

describe('official STAC 1.1.0 contracts', () => {
  const ajv = new Ajv({ strict: false, allErrors: true })
  addStacFormats(ajv)
  const manifest = JSON.parse(readFileSync('docs/metadata/schemas/official/manifest.json', 'utf8')) as { uri: string; file: string; sha256: string }[]
  for (const entry of manifest) {
    const bytes = readFileSync(`docs/metadata/schemas/official/${entry.file}`)
    expect(source(bytes, entry.uri).sha256).toBe(entry.sha256)
    ajv.addSchema(JSON.parse(bytes.toString()), entry.uri)
  }
  ajv.addSchema(JSON.parse(readFileSync('docs/metadata/schemas/terraviz-v1.0.0.json', 'utf8')))

  it('validates real persisted read-model to HTTP output against core and every declared schema', async () => {
    const { sqlite, env } = stacRouteFixture()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { headers: { 'Content-Type': 'image/png' } })))
    try {
      const publication = await readStacPublication(env)
      for (const document of [publication.catalog, publication.products[0].collection!, publication.products[0].item!]) {
        const response = await onRequestGet(makeCtx({ env, url: document.links.find(link => link.rel === 'self')!.href }) as never)
        expect(response.status).toBe(200)
        const output = await response.json()
        const kind = document.type === 'Feature' ? 'item' : document.type.toLowerCase()
        for (const uri of [`https://schemas.stacspec.org/v1.1.0/${kind}-spec/json-schema/${kind}.json`, ...document.stac_extensions]) {
          const validate = ajv.getSchema(uri)!
          expect(validate(output), JSON.stringify(validate.errors)).toBe(true)
        }
      }
    } finally { sqlite.close(); vi.unstubAllGlobals() }
  })

  it.each(['https://node.example/with space', 'https://node.example/tab\tpath', 'https://node.example/new\nline'])('uses the same rejecting format checks in official and local validators: %j', async href => {
    const { node, resolvers } = await stacFixture()
    const root = buildStacCatalog(node, resolvers)
    if (!root.ok) throw new Error(root.reasons.join(','))
    root.value.links = [{ rel: 'self', href }]
    expect(ajv.getSchema('https://schemas.stacspec.org/v1.1.0/catalog-spec/json-schema/catalog.json')!(root.value)).toBe(false)
    const schema = source(new TextEncoder().encode(JSON.stringify({ $id: TERRAVIZ_SCHEMA, $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object', properties: { links: { type: 'array', items: { type: 'object', properties: { href: { type: 'string', format: 'iri' } } } } } })))
    const validator = await createStacSchemaValidator([schema])
    expect(validator.validate(schema.uri, schema.sha256, root.value)).toBe('invalid')
  })

  it.each(['interval', 'instant', 'offset', 'antimeridian', 'unknown-geometry', 'unknown-time'])('validates %s output against core and every declared schema', async mode => {
    const { model, node, resolvers } = await stacFixture()
    model.row.content_digest = 'sha256:' + 'a'.repeat(64)
    model.row.doi = 'https://doi.org/10.1234/test'
    if (mode === 'instant') model.row.end_time = model.row.start_time
    if (mode === 'offset') {
      model.row.start_time = '2026-01-01T01:00:00.123456789+01:00'
      model.row.end_time = '2026-01-01T01:00:00.123456790+01:00'
    }
    if (mode === 'antimeridian') { model.row.bbox_w = 170; model.row.bbox_e = -170 }
    if (mode === 'unknown-geometry') model.row.bbox_provenance = 'unknown'
    if (mode === 'unknown-time') model.row.temporal_semantics = 'unknown'
    const product = buildStacProduct(model, node, resolvers)
    expect(product.ok).toBe(true)
    if (!product.ok) return
    const root = buildStacCatalog(node, resolvers, [product.value])
    expect(root.ok).toBe(true)
    if (!root.ok) return
    for (const document of [root.value, product.value.collection, product.value.item]) {
      if (!document) continue
      const kind = document.type === 'Feature' ? 'item' : document.type.toLowerCase()
      const uri = `https://schemas.stacspec.org/v1.1.0/${kind}-spec/json-schema/${kind}.json`
      for (const schemaUri of [uri, ...document.stac_extensions]) {
        const validate = ajv.getSchema(schemaUri)!
        expect(validate(document), JSON.stringify(validate.errors)).toBe(true)
      }
    }
    if (mode === 'offset') expect(product.value.item!.properties.start_datetime).toBe('2026-01-01T00:00:00.123456789Z')
  })
})