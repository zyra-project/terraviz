// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { StacLink } from './stac-types'
import { MAX_INTERSECTS_POSITIONS, MAX_INTERSECTS_MEMBERS, MAX_INTERSECTS_POSITION_TESTS } from './stac-query'

export const STAC_API_CONFORMANCE: readonly string[] = [
  'https://api.stacspec.org/v1.0.0/core',
  'https://api.stacspec.org/v1.0.0/collections',
  'https://api.stacspec.org/v1.0.0/ogcapi-features',
  'https://api.stacspec.org/v1.0.0/item-search',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson',
]
export const STAC_OPENAPI_MEDIA = 'application/vnd.oai.openapi+json;version=3.0'

export function stacServiceLinks(root: string): StacLink[] {
  return [
    { rel: 'conformance', href: `${root}/conformance`, type: 'application/json' },
    { rel: 'service-desc', href: `${root}/api`, type: STAC_OPENAPI_MEDIA },
    { rel: 'service-doc', href: `${root}/api.html`, type: 'text/html' },
    { rel: 'search', href: `${root}/search`, type: 'application/geo+json', method: 'GET' },
    { rel: 'search', href: `${root}/search`, type: 'application/geo+json', method: 'POST' },
  ]
}

export function stacOpenApi(root: string) {
  const intersectsDescription = `GeoJSON Geometry encoded as JSON. Mutually exclusive with bbox. At most ${MAX_INTERSECTS_POSITIONS} positions and ${MAX_INTERSECTS_MEMBERS} GeometryCollection members in total; nesting depth at most 8. Exact intersection work is limited to ${MAX_INTERSECTS_POSITION_TESTS} query-position tests across distinct Item footprints over the whole filtered result set before pagination, on every page request. Repeated bboxes reuse positive and negative results within the request. Excess work returns 400 intersects_budget_exceeded, never partial results. Narrow datetime or ids, or collections across datasets; limit does not reduce this budget.`
  const parameter = (name: string, schema: object, description: string) => ({ name, in: 'query', required: false, description, schema })
  const limitSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 50 }
  const bboxSchema = { oneOf: [4, 6].map(length => ({ type: 'array', minItems: length, maxItems: length, items: { type: 'number' } })) }
  const identifierList = { type: 'array', description: 'Nonempty list of 1 to 100 identifiers, each at most 256 characters.', minItems: 1, maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^,\\s\\u0000-\\u001f]+$' } }
  const cursorDescription = 'Opaque. Use only values from next links.'
  const limit = parameter('limit', limitSchema, 'Maximum page size. Values above 100 are clamped to 100.')
  const cursorSchema = { type: 'string', minLength: 1, maxLength: 256 }
  const cursor = parameter('cursor', cursorSchema, cursorDescription)
  const bbox = { ...parameter('bbox', bboxSchema, 'WGS84 bounding box; four or six decimal coordinates. Antimeridian crossing is supported.'), style: 'form', explode: false }
  const datetime = parameter('datetime', { type: 'string' }, 'RFC3339 instant or interval with inclusive overlap at millisecond precision; use .. for an open endpoint.')
  const pathParameter = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } })
  const exception = (description: string) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Exception' } } } })
  const operation = (operationId: string, schema: string, media: string, parameters: object[] = [], post = false) => ({ operationId, parameters, responses: {
    '200': { description: 'Success', content: { [media]: { schema: { $ref: `#/components/schemas/${schema}` } } } },
    ...(post ? { '413': exception('POST body exceeds 128 KiB'), '415': exception('POST requires application/json') } : { '304': { description: 'Not modified' } }),
    '400': exception('Invalid query'), '404': exception('Not found'), '405': exception('Method not allowed'),
    '406': exception('Unsupported response format'), '503': exception('Publication unavailable'),
  } })
  const collectionParameters = [pathParameter('collectionId')]
  const links = { type: 'array', items: { $ref: '#/components/schemas/Link' } }
  return {
    openapi: '3.0.3', info: { title: 'Terraviz STAC API', version: '1.0.0', description: 'Public verified Earth datasets. Native catalog APIs remain independent.' },
    servers: [{ url: root }], paths: {
      '/': { get: operation('getCatalog', 'Catalog', 'application/json') },
      '/conformance': { get: operation('getConformance', 'Conformance', 'application/json') },
      '/api': { get: operation('getServiceDescription', 'ServiceDescription', STAC_OPENAPI_MEDIA) },
      '/api.html': { get: operation('getServiceDocumentation', 'ServiceDocumentation', 'text/html') },
      '/collections': { get: operation('getCollections', 'Collections', 'application/json', [limit, cursor]) },
      '/collections/{collectionId}': { get: operation('getCollection', 'Collection', 'application/json', collectionParameters) },
      '/collections/{collectionId}/items': { get: operation('getCollectionItems', 'ItemCollection', 'application/geo+json', [...collectionParameters, limit, cursor, bbox, datetime]) },
      '/collections/{collectionId}/items/{itemId}': { get: operation('getCollectionItem', 'Item', 'application/geo+json', [...collectionParameters, pathParameter('itemId')]) },
      '/items': { get: operation('getItems', 'ItemCollection', 'application/geo+json', [limit, cursor, bbox, datetime]) },
      '/items/{itemId}': { get: operation('getItem', 'Item', 'application/geo+json', [pathParameter('itemId')]) },
      '/search': {
        get: operation('searchItemsGet', 'ItemCollection', 'application/geo+json', [limit, cursor, bbox, datetime,
          { ...parameter('ids', identifierList, 'Nonempty list of 1 to 100 Item identifiers, each at most 256 characters.'), style: 'form', explode: false },
          { ...parameter('collections', identifierList, 'Nonempty list of 1 to 100 Collection identifiers, each at most 256 characters.'), style: 'form', explode: false },
          parameter('intersects', { type: 'string' }, intersectsDescription)]),
        post: { ...operation('searchItemsPost', 'ItemCollection', 'application/geo+json', [], true), requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: {
          limit: limitSchema, cursor: { ...cursorSchema, description: cursorDescription },
          bbox: bboxSchema, datetime: { type: 'string', description: datetime.description },
          ids: identifierList, collections: identifierList, intersects: { type: 'object', description: intersectsDescription, additionalProperties: true },
        } } } } } },
      },
    }, components: { schemas: {
      Link: { type: 'object', required: ['rel', 'href'], properties: { rel: { type: 'string' }, href: { type: 'string', format: 'uri' }, type: { type: 'string' }, method: { type: 'string', enum: ['GET', 'POST'] }, body: { type: 'object', additionalProperties: true } }, additionalProperties: true },
      Exception: { type: 'object', required: ['code'], properties: { code: { type: 'string' }, error: { type: 'string', description: 'Compatibility alias for code.' }, description: { type: 'string' } } },
      Catalog: { type: 'object', required: ['id', 'type', 'stac_version', 'description', 'links', 'conformsTo'], properties: {
        id: { type: 'string' }, type: { type: 'string', enum: ['Catalog'] }, stac_version: { type: 'string' }, description: { type: 'string' }, links,
        conformsTo: { type: 'array', items: { type: 'string', format: 'uri' } },
      }, additionalProperties: true },
      Collection: { type: 'object', required: ['id', 'type', 'stac_version', 'description', 'license', 'extent', 'links'], properties: {
        id: { type: 'string' }, type: { type: 'string', enum: ['Collection'] }, stac_version: { type: 'string' }, description: { type: 'string' }, license: { type: 'string' }, extent: { type: 'object', additionalProperties: true }, links,
      }, additionalProperties: true },
      Item: { type: 'object', required: ['id', 'type', 'stac_version', 'geometry', 'properties', 'assets', 'links'], properties: {
        id: { type: 'string' }, type: { type: 'string', enum: ['Feature'] }, stac_version: { type: 'string' }, geometry: { type: 'object', nullable: true, additionalProperties: true }, properties: { type: 'object', additionalProperties: true }, assets: { type: 'object', additionalProperties: true }, links,
      }, additionalProperties: true },
      Collections: { type: 'object', required: ['collections', 'links'], properties: { collections: { type: 'array', items: { $ref: '#/components/schemas/Collection' } }, links } },
      ItemCollection: { type: 'object', required: ['type', 'features', 'links'], properties: { type: { type: 'string', enum: ['FeatureCollection'] }, features: { type: 'array', items: { $ref: '#/components/schemas/Item' } }, links, numberMatched: { type: 'integer', minimum: 0 }, numberReturned: { type: 'integer', minimum: 0 } } },
      Conformance: { type: 'object', required: ['conformsTo'], properties: { conformsTo: { type: 'array', items: { type: 'string', format: 'uri' } } } },
      ServiceDescription: { type: 'object', required: ['openapi', 'info', 'paths'], properties: { openapi: { type: 'string' }, info: { type: 'object', additionalProperties: true }, paths: { type: 'object', additionalProperties: true } }, additionalProperties: true },
      ServiceDocumentation: { type: 'string' },
    } },
  }
}

export function stacServiceHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Terraviz STAC API</title></head><body><h1>Terraviz STAC API</h1><p>Browse verified public Earth datasets through <a href="collections">collections</a>. Item lists accept limit (a positive safe integer, clamped to 100), cursor, WGS84 bbox (4 or 6 decimal coordinates), and RFC3339 datetime instants or intervals. Cursors are opaque, nonempty and at most 256 characters; use only values from next links. Spatial bounds are inclusive; temporal ranges match by inclusive overlap, at millisecond precision rather than containment. The canonical Item URL is /items/{id}; collection-route Items link to it with rel=canonical.</p><p><a href="search">/search</a> supports GET query parameters and POST application/json bodies: limit, cursor, bbox, datetime, ids, collections, and intersects. ids and collections accept nonempty lists of 1 to 100 identifiers each, with at most 256 characters per identifier. intersects is a GeoJSON Geometry with closed polygon rings, bounded to ${MAX_INTERSECTS_POSITIONS} positions and ${MAX_INTERSECTS_MEMBERS} GeometryCollection members in total, nesting depth 8, and 64 KiB of text. Supplied bbox metadata is validated then stripped from geometry and links; bounds are recomputed from coordinates. Exact intersections consume at most ${MAX_INTERSECTS_POSITION_TESTS} query-position tests across distinct Item footprints over the whole filtered result set before pagination, on every page request. Repeated bboxes reuse positive and negative results within the request. Excess work returns 400 intersects_budget_exceeded, never partial results. Narrow datetime or ids, or collections across datasets; limit does not reduce this budget, and collections cannot narrow frames within one collection. bbox and intersects are mutually exclusive. POST bodies are limited to 128 KiB. GET intersects must also fit the hosting platform URL limit; use POST for larger geometries. All listing next links remain valid if the previously returned resource disappears, using deterministic code-unit ID ordering.</p><p>Cross-origin GET, HEAD and POST clients are supported without credentials; OPTIONS permits Content-Type and If-None-Match for known route patterns with a 600-second Access-Control-Max-Age. Unknown route patterns return 404 without publication probes. GET and HEAD support conditional 304 responses. POST search ignores If-None-Match and returns no-store results. Errors include code and description, with error retained as a compatibility alias.</p><p><a href="api">OpenAPI service description</a> | <a href="conformance">Validated conformance classes</a></p></body></html>`
}