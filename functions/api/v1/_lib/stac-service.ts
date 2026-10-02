// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { StacLink } from './stac-types'

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
  const parameter = (name: string, schema: object, description: string) => ({ name, in: 'query', required: false, description, schema })
  const limit = parameter('limit', { type: 'integer', minimum: 1, maximum: 100, default: 50 }, 'Maximum page size. Values above 100 are clamped to 100.')
  const cursor = parameter('cursor', { type: 'string' }, 'Last returned identifier from the next link.')
  const bbox = { ...parameter('bbox', { type: 'array', minItems: 4, maxItems: 6, items: { type: 'number' } }, 'WGS84 bounding box; four or six coordinates. Antimeridian crossing is supported.'), style: 'form', explode: false }
  const datetime = parameter('datetime', { type: 'string' }, 'RFC3339 instant or inclusive interval; use .. for an open endpoint.')
  const pathParameter = (name: string) => ({ name, in: 'path', required: true, schema: { type: 'string' } })
  const operation = (operationId: string, schema: string, media: string, parameters: object[] = []) => ({ operationId, parameters, responses: {
    '200': { description: 'Success', content: { [media]: { schema: { $ref: `#/components/schemas/${schema}` } } } },
    '304': { description: 'Not modified' }, '400': { description: 'Invalid query' }, '404': { description: 'Not found' },
    '406': { description: 'Unsupported response format' }, '503': { description: 'Publication unavailable' },
  } })
  const collectionParameters = [pathParameter('collectionId')]
  const links = { type: 'array', items: { $ref: '#/components/schemas/Link' } }
  return {
    openapi: '3.0.3', info: { title: 'Terraviz STAC API', version: '1.0.0', description: 'Public verified Earth datasets. Native catalog APIs remain independent.' },
    servers: [{ url: root }], paths: {
      '/': { get: operation('getCatalog', 'Catalog', 'application/json') },
      '/conformance': { get: operation('getConformance', 'Conformance', 'application/json') },
      '/api': { get: operation('getServiceDescription', 'ServiceDescription', STAC_OPENAPI_MEDIA) },
      '/api.html': { get: { operationId: 'getServiceDocumentation', responses: { '200': { description: 'Service documentation', content: { 'text/html': { schema: { type: 'string' } } } } } } },
      '/collections': { get: operation('getCollections', 'Collections', 'application/json', [limit, cursor]) },
      '/collections/{collectionId}': { get: operation('getCollection', 'Collection', 'application/json', collectionParameters) },
      '/collections/{collectionId}/items': { get: operation('getCollectionItems', 'ItemCollection', 'application/geo+json', [...collectionParameters, limit, cursor, bbox, datetime]) },
      '/collections/{collectionId}/items/{itemId}': { get: operation('getCollectionItem', 'Item', 'application/geo+json', [...collectionParameters, pathParameter('itemId')]) },
      '/items': { get: operation('getItems', 'ItemCollection', 'application/geo+json', [limit, cursor, bbox, datetime]) },
      '/items/{itemId}': { get: operation('getItem', 'Item', 'application/geo+json', [pathParameter('itemId')]) },
      '/search': {
        get: operation('searchItemsGet', 'ItemCollection', 'application/geo+json', [limit, cursor, bbox, datetime,
          { ...parameter('ids', { type: 'array', items: { type: 'string' } }, 'Item identifiers.'), style: 'form', explode: false },
          { ...parameter('collections', { type: 'array', items: { type: 'string' } }, 'Collection identifiers.'), style: 'form', explode: false },
          parameter('intersects', { type: 'string' }, 'GeoJSON Geometry encoded as JSON. Mutually exclusive with bbox.')]),
        post: { ...operation('searchItemsPost', 'ItemCollection', 'application/geo+json'), requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 }, cursor: { type: 'string' },
          bbox: { type: 'array', minItems: 4, maxItems: 6, items: { type: 'number' } }, datetime: { type: 'string' },
          ids: { type: 'array', maxItems: 100, items: { type: 'string' } }, collections: { type: 'array', maxItems: 100, items: { type: 'string' } }, intersects: { type: 'object', additionalProperties: true },
        } } } } } },
      },
    }, components: { schemas: {
      Link: { type: 'object', required: ['rel', 'href'], properties: { rel: { type: 'string' }, href: { type: 'string', format: 'uri' }, type: { type: 'string' } }, additionalProperties: true },
      Catalog: { type: 'object', required: ['id', 'type', 'stac_version', 'description', 'links', 'conformsTo'], properties: {
        id: { type: 'string' }, type: { type: 'string', enum: ['Catalog'] }, stac_version: { type: 'string' }, description: { type: 'string' }, links,
        conformsTo: { type: 'array', items: { type: 'string', format: 'uri' } },
      }, additionalProperties: true },
      Collection: { type: 'object', required: ['id', 'type', 'stac_version', 'description', 'license', 'extent', 'links'], additionalProperties: true },
      Item: { type: 'object', required: ['id', 'type', 'stac_version', 'geometry', 'properties', 'assets', 'links'], additionalProperties: true },
      Collections: { type: 'object', required: ['collections', 'links'], properties: { collections: { type: 'array', items: { $ref: '#/components/schemas/Collection' } }, links } },
      ItemCollection: { type: 'object', required: ['type', 'features', 'links'], properties: { type: { type: 'string', enum: ['FeatureCollection'] }, features: { type: 'array', items: { $ref: '#/components/schemas/Item' } }, links, numberMatched: { type: 'integer', minimum: 0 }, numberReturned: { type: 'integer', minimum: 0 } } },
      Conformance: { type: 'object', required: ['conformsTo'], properties: { conformsTo: { type: 'array', items: { type: 'string', format: 'uri' } } } },
      ServiceDescription: { type: 'object', required: ['openapi', 'info', 'paths'], additionalProperties: true },
    } },
  }
}

export function stacServiceHtml(): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Terraviz STAC API</title></head><body><h1>Terraviz STAC API</h1><p>Browse verified public Earth datasets through <a href="collections">collections</a>. Item lists accept limit (1-100), cursor, WGS84 bbox (4 or 6 coordinates), and RFC3339 datetime instants or intervals. Follow next links for pagination. Spatial and temporal bounds are inclusive.</p><p><a href="api">OpenAPI service description</a> | <a href="conformance">Validated conformance classes</a></p></body></html>'
}