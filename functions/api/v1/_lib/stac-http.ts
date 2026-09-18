// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { CatalogEnv } from './env'
import { readStacPublication } from './stac-publication'
import { computeEtag } from './snapshot'
import type { StacLink } from './stac-types'

export function stacError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}

export async function serveStac(request: Request, env: CatalogEnv): Promise<Response> {
  if (env.STAC_ENABLED !== 'true') return stacError(404, 'not_found')
  if (!env.CATALOG_DB) return stacError(503, 'binding_missing')
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/$/, '').replace(/^\/api\/v1\/stac\/?/, '').split('/').filter(Boolean)
  const listing = path.join('/') === 'collections' || path.join('/') === 'items' || (path.length === 3 && path[0] === 'collections' && path[2] === 'items')
  if ([...url.searchParams.keys()].some(key => !listing || !['limit', 'cursor'].includes(key))) return stacError(400, 'invalid_query')
  const limitText = url.searchParams.get('limit') ?? '50'
  if (!/^[1-9]\d{0,2}$/.test(limitText) || Number(limitText) > 100) return stacError(400, 'invalid_limit')
  const limit = Number(limitText)
  const publication = await readStacPublication(env)
  const root = publication.catalog.links.find(link => link.rel === 'self')!.href
  const canonical = root + (path.length ? '/' + path.join('/') : '')
  let document: unknown
  let geojson = false
  const collections = publication.products.flatMap(product => product.collection ? [product.collection] : [])
  const items = publication.products.flatMap(product => product.item ? [product.item] : [])
  if (!path.length) document = publication.catalog
  else if (listing) {
    const collection = path.length === 3 ? collections.find(entry => entry.id === path[1]) : null
    if (path.length === 3 && !collection) return stacError(404, 'not_found')
    const entries = path[0] === 'collections' && path.length === 1 ? collections : items.filter(item => !collection || item.collection === collection.id)
    const cursor = url.searchParams.get('cursor')
    const offset = cursor ? entries.findIndex(entry => entry.id === cursor) + 1 : 0
    if (cursor && offset === 0) return stacError(400, 'invalid_cursor')
    const page = entries.slice(offset, offset + limit)
    const self = new URL(canonical)
    self.searchParams.set('limit', String(limit))
    if (cursor) self.searchParams.set('cursor', cursor)
    geojson = !(path[0] === 'collections' && path.length === 1)
    const type = geojson ? 'application/geo+json' : 'application/json'
    const links: StacLink[] = [{ rel: 'self', href: self.href, type }, { rel: 'root', href: root, type: 'application/json' }]
    if (offset + page.length < entries.length) {
      const next = new URL(self)
      next.searchParams.set('cursor', page[page.length - 1].id)
      links.push({ rel: 'next', href: next.href, type })
    }
    document = geojson ? { type: 'FeatureCollection', features: page, links } : { collections: page, links }
  } else if (path.length === 2 && path[0] === 'collections') document = collections.find(entry => entry.id === path[1])
  else if (path.length === 2 && path[0] === 'items') { document = items.find(entry => entry.id === path[1]); geojson = true }
  else if (path.length === 4 && path[0] === 'collections' && path[2] === 'items') {
    document = items.find(entry => entry.collection === path[1] && entry.id === path[3]); geojson = true
  }
  if (!document) return stacError(404, 'not_found')
  const body = JSON.stringify(document)
  const etag = await computeEtag(body)
  const headers = { 'Content-Type': `${geojson ? 'application/geo+json' : 'application/json'}; charset=utf-8`,
    ETag: etag, 'Cache-Control': 'public, no-cache, must-revalidate',
    Link: `<${root}>; rel="root"; type="application/json"` }
  const matches = request.headers.get('if-none-match')?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)
  return new Response(matches ? null : body, { status: matches ? 304 : 200, headers })
}