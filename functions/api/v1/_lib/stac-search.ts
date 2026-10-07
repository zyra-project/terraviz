// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { StacItem } from './stac-types'
import { matchesStacQuery, MAX_INTERSECTS_POSITION_TESTS, type StacQuery } from './stac-query'

export async function searchStacItems(items: StacItem[], query: StacQuery): Promise<StacItem[]> {
  const budget = { remaining: MAX_INTERSECTS_POSITION_TESTS, intersections: new Map<string, boolean>() }
  return items.filter(item => matchesStacQuery(item, query, budget)).sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
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
  try {
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
  } catch { throw new Error('invalid_query') }
  return params
}