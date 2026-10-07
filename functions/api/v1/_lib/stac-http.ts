// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { readStacPublication } from './stac-publication'
import { computeEtag } from './snapshot'
import type { StacLink } from './stac-types'
import { matchesStacQuery, parseStacQuery } from './stac-query'
import { STAC_API_CONFORMANCE, STAC_OPENAPI_MEDIA, stacOpenApi, stacServiceHtml, stacServiceLinks } from './stac-service'
import { searchStacItems, stacPostParameters } from './stac-search'

const corsHeaders = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag, Link' }
const queryErrorCodes = new Set(['invalid_query', 'invalid_limit', 'invalid_cursor', 'invalid_bbox', 'invalid_datetime',
  'invalid_ids', 'invalid_collections', 'invalid_intersects', 'bbox_intersects_conflict', 'unsupported_media_type', 'query_too_large'])
const errorDescriptions: Record<string, string> = {
  not_found: 'The requested resource is not available.',
  binding_missing: 'The catalog service is not configured.',
  stac_unavailable: 'The verified publication is temporarily unavailable.',
  method_not_allowed: 'This resource does not support the requested method.',
  not_acceptable: 'The requested response format is not available.',
  invalid_query: 'The request contains invalid query parameters or JSON.',
  invalid_limit: 'Limit must be a positive safe integer.',
  invalid_cursor: 'Use an opaque cursor supplied by a next link.',
  invalid_bbox: 'Bbox must contain four or six decimal WGS84 coordinates.',
  invalid_datetime: 'Datetime must be a valid RFC3339 instant or ordered interval.',
  invalid_ids: 'Ids must contain 1 to 100 valid identifiers of at most 256 characters.',
  invalid_collections: 'Collections must contain 1 to 100 valid identifiers of at most 256 characters.',
  invalid_intersects: 'Intersects must be a valid bounded GeoJSON geometry with closed polygon rings.',
  bbox_intersects_conflict: 'Bbox and intersects cannot be used together.',
  unsupported_media_type: 'POST search requires application/json.',
  query_too_large: 'The POST body exceeds the allowed size.',
  intersects_budget_exceeded: 'Narrow datetime or ids, or collections across datasets, to reduce distinct-footprint work over the whole result set. Limit does not reduce this budget.',
}

function queryErrorCode(error: unknown): string {
  return error instanceof Error && queryErrorCodes.has(error.message) ? error.message : 'invalid_query'
}

export function stacError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error, code: error, description: errorDescriptions[error] ?? 'The request could not be completed.' }), { status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}

export async function serveStac(request: Request, env: CatalogEnv): Promise<Response> {
  if (env.STAC_ENABLED !== 'true') return stacError(404, 'not_found')
  if (!env.CATALOG_DB) return stacError(503, 'binding_missing')
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '').replace(/^\/api\/v1\/stac\/?/, '').split('/').filter(Boolean)
  const search = path.join('/') === 'search'
  const allow = search ? 'GET, HEAD, POST, OPTIONS' : 'GET, HEAD, OPTIONS'
  const knownPath = !path.length || (path.length === 1 && ['search', 'collections', 'items', 'conformance', 'api', 'api.html'].includes(path[0]))
    || (path.length === 2 && ['collections', 'items'].includes(path[0]))
    || ([3, 4].includes(path.length) && path[0] === 'collections' && path[2] === 'items')
  if (request.method === 'OPTIONS' && !knownPath) return stacError(404, 'not_found')
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
    ...corsHeaders, 'Access-Control-Max-Age': '600',
    Allow: allow, 'Access-Control-Allow-Methods': allow, 'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
    'Cache-Control': 'no-store',
  } })
  if (!['GET', 'HEAD'].includes(request.method) && !(search && request.method === 'POST')) {
    const response = stacError(405, 'method_not_allowed')
    response.headers.set('Allow', allow)
    return response
  }
  if (request.method === 'POST') {
    if (url.search) return stacError(400, 'invalid_query')
    try { url.search = (await stacPostParameters(request)).toString() }
    catch (error) { const reason = queryErrorCode(error); return stacError(reason === 'unsupported_media_type' ? 415 : reason === 'query_too_large' ? 413 : 400, reason) }
  }
  const listing = search || path.join('/') === 'collections' || path.join('/') === 'items' || (path.length === 3 && path[0] === 'collections' && path[2] === 'items')
  if ([...url.searchParams.keys()].some(key => !listing || (path.length === 1 && path[0] === 'collections' && !['limit', 'cursor'].includes(key)))) return stacError(400, 'invalid_query')
  let query
  try { query = parseStacQuery(url.searchParams, search) } catch (error) { return stacError(400, queryErrorCode(error)) }
  if (query.intersects) url.searchParams.set('intersects', JSON.stringify(query.intersects))
  const limit = query.limit
  const publication = await readStacPublication(env)
  const root = publication.catalog.links.find(link => link.rel === 'self')!.href
  const canonical = root + (path.length ? '/' + path.join('/') : '')
  let document: unknown
  let geojson = false
  let media = 'application/json'
  const collections = [...new Map(publication.products.flatMap(product => product.collection ? [[product.collection.id, product.collection] as const] : [])).values()]
  const items = publication.products.flatMap(product => product.item ? [product.item] : [])
  if (!path.length) document = { ...publication.catalog, conformsTo: STAC_API_CONFORMANCE, links: [...publication.catalog.links, ...stacServiceLinks(root)] }
  else if (path.join('/') === 'conformance') document = { conformsTo: STAC_API_CONFORMANCE }
  else if (path.join('/') === 'api') { document = stacOpenApi(root); media = STAC_OPENAPI_MEDIA }
  else if (path.join('/') === 'api.html') { document = stacServiceHtml(); media = 'text/html' }
  else if (listing) {
    const collection = path.length === 3 ? collections.find(entry => entry.id === path[1]) : null
    if (path.length === 3 && !collection) return stacError(404, 'not_found')
    let entries
    try { entries = search ? await searchStacItems(items, query) : path[0] === 'collections' && path.length === 1 ? collections : items.filter(item => (!collection || item.collection === collection.id) && matchesStacQuery(item, query)) }
    catch (error) {
      if (!(error instanceof Error) || !['intersects_budget_exceeded', 'invalid_intersects'].includes(error.message)) throw error
      return stacError(400, error.message)
    }
    const cursor = url.searchParams.get('cursor')
    entries.sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
    const nextIndex = cursor ? entries.findIndex(entry => entry.id > cursor) : -1
    const offset = cursor ? nextIndex < 0 ? entries.length : nextIndex : 0
    const page = entries.slice(offset, offset + limit)
    const self = new URL(canonical + url.search)
    if (cursor) self.searchParams.set('cursor', cursor)
    geojson = !(path[0] === 'collections' && path.length === 1)
    const type = geojson ? 'application/geo+json' : 'application/json'
    const links: StacLink[] = [{ rel: 'self', href: self.href, type }, { rel: 'root', href: root, type: 'application/json' }]
    if (collection) links.push({ rel: 'collection', href: `${root}/collections/${encodeURIComponent(collection.id)}`, type: 'application/json' })
    if (offset + page.length < entries.length) {
      const next = new URL(self)
      next.searchParams.set('cursor', page[page.length - 1].id)
      links.push({ rel: 'next', href: next.href, type })
    }
    if (request.method === 'POST') {
      for (const link of links.filter(value => ['self', 'next'].includes(value.rel))) {
        const parameters = new URL(link.href).searchParams
        link.body = Object.fromEntries([...parameters].map(([key, value]) => [key,
          key === 'limit' ? Number(value) : key === 'bbox' ? value.split(',').map(Number)
            : ['ids', 'collections'].includes(key) ? value.split(',') : key === 'intersects' ? JSON.parse(value) : value]))
        link.href = canonical
        link.method = 'POST'
      }
    }
    document = geojson ? { type: 'FeatureCollection', features: page, links, numberReturned: page.length, numberMatched: entries.length } : { collections: page, links }
  } else if (path.length === 2 && path[0] === 'collections') document = collections.find(entry => entry.id === path[1])
  else if (path.length === 2 && path[0] === 'items') { document = items.find(entry => entry.id === path[1]); geojson = true }
  else if (path.length === 4 && path[0] === 'collections' && path[2] === 'items') {
    document = items.find(entry => entry.collection === path[1] && entry.id === path[3]); geojson = true
  }
  if (!document) return stacError(404, 'not_found')
  if (geojson && !listing && path.length === 4) {
    const item = document as typeof items[number]
    document = { ...item, links: [...item.links.map(link => link.rel === 'self' ? { ...link, href: canonical } : link),
      { rel: 'canonical', href: item.links.find(link => link.rel === 'self')!.href, type: 'application/geo+json' }] }
  }
  if (geojson) media = 'application/geo+json'
  const body = media === 'text/html' ? document as string : JSON.stringify(document)
  const etag = await computeEtag(body)
  const headers = { ...corsHeaders, 'Content-Type': `${media}; charset=utf-8`, Vary: 'Accept',
    ETag: etag, 'Cache-Control': request.method === 'POST' ? 'no-store' : 'public, no-cache, must-revalidate',
    Link: `<${root}>; rel="root"; type="application/json"` }
  const matches = ['GET', 'HEAD'].includes(request.method) && request.headers.get('if-none-match')?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
  const accept = request.headers.get('accept')
  const mediaType = media.split(';')[0]
  const acceptedTypes = ['*/*', media.split('/')[0] + '/*', mediaType, ...(mediaType.endsWith('+json') ? ['application/json'] : [])]
  if (accept && !accept.split(',').some(value => acceptedTypes.includes(value.split(';')[0].trim().toLowerCase()) && !/;\s*q=0(?:\.0*)?(?:;|$)/.test(value))) return stacError(406, 'not_acceptable')
  return new Response(matches || request.method === 'HEAD' ? null : body, { status: matches ? 304 : 200, headers })
}