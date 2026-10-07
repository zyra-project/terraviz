// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { StacItem } from './stac-types'
import type { Geometry, Position } from 'geojson'
import Ajv from 'ajv'
import booleanIntersects from '@turf/boolean-intersects'
import turfBbox from '@turf/bbox'
import geometrySchema from '../../../../docs/metadata/schemas/official/geojson.org-schema-Geometry-f67b736b0d3c.json'

const validateGeometry = new Ajv({ strict: false }).compile<Geometry>(geometrySchema)
export const MAX_INTERSECTS_POSITIONS = 256
export const MAX_INTERSECTS_MEMBERS = 32
export const MAX_INTERSECTS_POSITION_TESTS = 16384

function countPositions(value: unknown, budget: { positions: number }, depth = 0): boolean {
  if (depth > 4 || !Array.isArray(value) || !value.length) return false
  if (typeof value[0] === 'number') return ++budget.positions <= MAX_INTERSECTS_POSITIONS
  return value.every(child => countPositions(child, budget, depth + 1))
}

function closedRing(ring: Position[]): boolean {
  const first = ring[0], last = ring.at(-1)
  return ring.length >= 4 && first.length === last?.length && first.every((coordinate, index) => coordinate === last[index])
}

function validGeometry(value: unknown, budget = { positions: 0, members: 0 }, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false
  const geometry = value as Record<string, unknown>
  if ('bbox' in geometry && (!Array.isArray(geometry.bbox) || ![4, 6].includes(geometry.bbox.length)
    || !geometry.bbox.every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate)))) return false
  if (geometry.type === 'GeometryCollection') {
    if (!Array.isArray(geometry.geometries) || !geometry.geometries.length
      || !geometry.geometries.every(child => ++budget.members <= MAX_INTERSECTS_MEMBERS && validGeometry(child, budget, depth + 1))) return false
  } else if (!countPositions(geometry.coordinates, budget) || !validateGeometry(value)) return false
  const validated = value as Geometry
  if (validated.type === 'Polygon' && !validated.coordinates.every(closedRing)) return false
  if (validated.type === 'MultiPolygon' && !validated.coordinates.every(polygon => polygon.length > 0 && polygon.every(closedRing))) return false
  delete geometry.bbox
  return true
}

function boxesOverlap(first: number[], second: number[]): boolean {
  const [west, south, east, north] = first
  const [left, bottom, right, top] = second
  if (south > top || north < bottom) return false
  if (west > east && left > right) return true
  if (west > east) return west <= right || east >= left
  if (left > right) return left <= east || right >= west
  return west <= right && east >= left
}

export interface StacQuery {
  limit: number
  cursor?: string
  bbox?: number[]
  interval?: [number, number]
  ids?: string[]
  collections?: string[]
  intersects?: Geometry
  intersectsBbox?: number[]
  intersectsPositions?: number
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
    const budget = { positions: 0, members: 0 }
    if (!validGeometry(geometry, budget)) throw new Error('invalid_intersects')
    const bounds = turfBbox(geometry as Geometry, { recompute: true })
    if (!bounds.every(Number.isFinite) || bounds[0] < -180 || bounds[2] > 180 || bounds[1] < -90 || bounds[3] > 90) throw new Error('invalid_intersects')
    query.intersects = geometry as Geometry
    query.intersectsBbox = bounds
    query.intersectsPositions = budget.positions
  }
  if (params.has('cursor')) {
    query.cursor = params.get('cursor')!
    if (!query.cursor.length || query.cursor.length > 256) throw new Error('invalid_cursor')
  }
  if (params.has('bbox')) {
    const parts = params.get('bbox')!.split(',')
    if (parts.some(value => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) throw new Error('invalid_bbox')
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
      if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('invalid_datetime')
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

export function matchesStacQuery(item: StacItem, query: StacQuery, budget?: { remaining: number; intersections: Map<string, boolean> }): boolean {
  if (query.ids && !query.ids.includes(item.id)) return false
  if (query.collections && (!item.collection || !query.collections.includes(item.collection))) return false
  if (query.interval) {
    const start = Date.parse(item.properties.datetime ?? item.properties.start_datetime!)
    const end = Date.parse(item.properties.datetime ?? item.properties.end_datetime!)
    if (start > query.interval[1] || end < query.interval[0]) return false
  }
  if (query.bbox) {
    if (!item.bbox) return false
    const dimensions = query.bbox.length / 2
    if (dimensions === 3 && (query.bbox[2] > 0 || query.bbox[5] < 0)) return false
    if (!boxesOverlap(item.bbox, [query.bbox[0], query.bbox[1], query.bbox[dimensions], query.bbox[dimensions + 1]])) return false
  }
  if (query.intersects) {
    if (!item.geometry || !item.bbox || !boxesOverlap(item.bbox, query.intersectsBbox ?? turfBbox(query.intersects))) return false
    const footprint = item.bbox.join(',')
    const cached = budget?.intersections.get(footprint)
    if (cached !== undefined) return cached
    if (budget) {
      budget.remaining -= query.intersectsPositions ?? MAX_INTERSECTS_POSITIONS
      if (budget.remaining < 0) throw new Error('intersects_budget_exceeded')
    }
    let intersects: boolean
    try { intersects = booleanIntersects(item.geometry, query.intersects) }
    catch { throw new Error('invalid_intersects') }
    budget?.intersections.set(footprint, intersects)
    if (!intersects) return false
  }
  return true
}