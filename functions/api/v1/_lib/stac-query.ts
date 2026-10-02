// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { StacItem } from './stac-types'
import type { Geometry } from 'geojson'
import Ajv from 'ajv'
import booleanIntersects from '@turf/boolean-intersects'
import turfBbox from '@turf/bbox'
import geometrySchema from '../../../../docs/metadata/schemas/official/geojson.org-schema-Geometry-f67b736b0d3c.json'

const validateGeometry = new Ajv({ strict: false }).compile<Geometry>(geometrySchema)

function validGeometry(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false
  const geometry = value as Record<string, unknown>
  if (geometry.type === 'GeometryCollection') return Array.isArray(geometry.geometries)
    && geometry.geometries.length > 0 && geometry.geometries.every(child => validGeometry(child, depth + 1))
  if (!validateGeometry(value)) return false
  const bounds = turfBbox(value as Geometry)
  return bounds.every(Number.isFinite) && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90
}

export interface StacQuery {
  limit: number
  cursor?: string
  bbox?: number[]
  interval?: [number, number]
  ids?: string[]
  collections?: string[]
  intersects?: Geometry
}

export function parseStacQuery(params: URLSearchParams, search = false): StacQuery {
  for (const key of params.keys()) {
    if (!['limit', 'cursor', 'bbox', 'datetime', ...(search ? ['ids', 'collections', 'intersects'] : [])].includes(key) || params.getAll(key).length !== 1) throw new Error('invalid_query')
  }
  const text = params.get('limit') ?? '50'
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('invalid_limit')
  const query: StacQuery = { limit: Math.min(Number(text), 100) }
  for (const key of ['ids', 'collections'] as const) {
    if (!params.has(key)) continue
    const values = params.get(key)!.split(',')
    if (values.length > 100 || values.some(value => !value || value.length > 256 || /[\s\u0000-\u001f]/.test(value))) throw new Error(`invalid_${key}`)
    query[key] = values
  }
  if (params.has('intersects')) {
    if (params.has('bbox')) throw new Error('bbox_intersects_conflict')
    const text = params.get('intersects')!
    if (text.length > 65536) throw new Error('invalid_intersects')
    let geometry: unknown
    try { geometry = JSON.parse(text) } catch { throw new Error('invalid_intersects') }
    if (!validGeometry(geometry)) throw new Error('invalid_intersects')
    query.intersects = geometry as Geometry
  }
  if (params.has('cursor')) query.cursor = params.get('cursor')!
  if (params.has('bbox')) {
    const parts = params.get('bbox')!.split(',')
    if (parts.some(value => !value.trim())) throw new Error('invalid_bbox')
    const bbox = parts.map(Number)
    const dimensions = bbox.length / 2
    if (![4, 6].includes(bbox.length) || bbox.some(value => !Number.isFinite(value))
      || Math.abs(bbox[0]) > 180 || Math.abs(bbox[dimensions]) > 180
      || Math.abs(bbox[1]) > 90 || Math.abs(bbox[dimensions + 1]) > 90 || bbox[1] > bbox[dimensions + 1]
      || (dimensions === 3 && bbox[2] > bbox[5])) throw new Error('invalid_bbox')
    query.bbox = bbox
  }
  if (params.has('datetime')) {
    const datetime = params.get('datetime')!
    const parts = datetime.split('/')
    if (parts.length > 2) throw new Error('invalid_datetime')
    const instant = (value: string, open: number): number => {
      if (parts.length === 2 && (value === '..' || value === '')) return open
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('invalid_datetime')
      const parsed = Date.parse(value)
      if (!Number.isFinite(parsed)) throw new Error('invalid_datetime')
      const [year, month, day] = value.slice(0, 10).split('-').map(Number)
      if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new Error('invalid_datetime')
      return parsed
    }
    query.interval = [instant(parts[0], -Infinity), instant(parts.at(-1)!, Infinity)]
    if (query.interval[0] > query.interval[1] || (query.interval[0] === -Infinity && query.interval[1] === Infinity)) throw new Error('invalid_datetime')
  }
  return query
}

export function matchesStacQuery(item: StacItem, query: StacQuery): boolean {
  if (query.ids && !query.ids.includes(item.id)) return false
  if (query.collections && (!item.collection || !query.collections.includes(item.collection))) return false
  if (query.intersects && (!item.geometry || !booleanIntersects(item.geometry, query.intersects))) return false
  if (query.interval) {
    const start = Date.parse(item.properties.datetime ?? item.properties.start_datetime!)
    const end = Date.parse(item.properties.datetime ?? item.properties.end_datetime!)
    if (start > query.interval[1] || end < query.interval[0]) return false
  }
  if (query.bbox) {
    if (!item.bbox) return false
    const dimensions = query.bbox.length / 2
    if (dimensions === 3 && (query.bbox[2] > 0 || query.bbox[5] < 0)) return false
    const [west, south, east, north] = item.bbox
    if (south > query.bbox[dimensions + 1] || north < query.bbox[1]) return false
    const segments = (left: number, right: number): number[][] => left <= right ? [[left, right]] : [[left, 180], [-180, right]]
    if (!segments(west, east).some(first => segments(query.bbox![0], query.bbox![dimensions])
      .some(second => first[0] <= second[1] && first[1] >= second[0]))) return false
  }
  return true
}