// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { StacItem } from './stac-types'
import { matchesStacQuery, type StacQuery } from './stac-query'

export async function searchStacItems(db: D1Database, items: StacItem[], query: StacQuery): Promise<StacItem[]> {
  const primary = db.withSession ? db.withSession('first-primary') : db
  const branches = [
    { id: 'datasets.id', collection: "datasets.origin_node || '-' || datasets.id", from: 'datasets',
      time: '', box: (axis: string) => `bbox_${axis}`, extra: 'NOT EXISTS (SELECT 1 FROM stac_history_publications WHERE dataset_id=datasets.id)' },
    { id: "history.dataset_id || '-' || history.kind || '-' || saved.id", collection: "datasets.origin_node || '-' || datasets.id",
      from: 'stac_history_items saved JOIN stac_history_publications history ON history.id=saved.publication_id JOIN datasets ON datasets.id=history.dataset_id',
      time: 'saved.', box: (axis: string) => `json_extract(history.model_json, '$.row.bbox_${axis}')`, extra: '1=1' },
  ]
  const statements = branches.map(branch => {
    const conditions = [branch.extra, "datasets.visibility='public'", 'datasets.is_hidden=0', 'datasets.published_at IS NOT NULL', 'datasets.retracted_at IS NULL', 'COALESCE(datasets.transcoding,0)=0']
    const bindings: (string | number)[] = []
    if (query.interval) {
      if (Number.isFinite(query.interval[1])) { conditions.push(`julianday(${branch.time}start_time)<=julianday(?)`); bindings.push(new Date(query.interval[1]).toISOString()) }
      if (Number.isFinite(query.interval[0])) { conditions.push(`julianday(${branch.time}end_time)>=julianday(?)`); bindings.push(new Date(query.interval[0]).toISOString()) }
    }
    if (query.bbox) {
      const dimensions = query.bbox.length / 2
      const [west, south] = query.bbox
      const east = query.bbox[dimensions], north = query.bbox[dimensions + 1]
      conditions.push(`${branch.box('s')}<=? AND ${branch.box('n')}>=?`)
      bindings.push(north, south)
      const segments = west <= east ? [[west, east]] : [[west, 180], [-180, east]]
      conditions.push('(' + segments.map(() => `(${branch.box('w')}<=${branch.box('e')} AND ${branch.box('w')}<=? AND ${branch.box('e')}>=?) OR (${branch.box('w')}>${branch.box('e')} AND (${branch.box('w')}<=? OR ${branch.box('e')}>=?))`).join(' OR ') + ')')
      for (const [left, right] of segments) bindings.push(right, left, right, left)
    }
    for (const [values, expression] of [[query.ids, branch.id], [query.collections, branch.collection]] as const) {
      if (values) { conditions.push(`${expression} IN (SELECT value FROM json_each(?))`); bindings.push(JSON.stringify(values)) }
    }
    return primary.prepare(`SELECT ${branch.id} AS id FROM ${branch.from} WHERE ${conditions.join(' AND ')}`).bind(...bindings)
  })
  const result = await primary.batch<{ id: string }>(statements)
  if (result.some(page => !page.success)) throw new Error('STAC search read failed')
  const candidates = new Set(result.flatMap(page => page.results.map(row => row.id)))
  return items.filter(item => candidates.has(item.id) && matchesStacQuery(item, query)).sort((first, second) => first.id.localeCompare(second.id))
}

export async function stacPostParameters(request: Request): Promise<URLSearchParams> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('unsupported_media_type')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('invalid_query')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.length
      if (length > 131072) { await reader.cancel(); throw new Error('query_too_large') }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new Error('invalid_query') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_query')
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (key === 'intersects') params.set(key, JSON.stringify(value))
    else if (['bbox', 'ids', 'collections'].includes(key)) {
      if (!Array.isArray(value) || value.some(entry => typeof entry !== (key === 'bbox' ? 'number' : 'string') || (typeof entry === 'string' && entry.includes(',')))) throw new Error('invalid_query')
      params.set(key, value.join(','))
    } else {
      if (typeof value !== (key === 'limit' ? 'number' : 'string')) throw new Error('invalid_query')
      params.set(key, String(value))
    }
  }
  return params
}