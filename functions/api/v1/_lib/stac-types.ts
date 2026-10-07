// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import type { MultiPolygon, Polygon } from 'geojson'

export const STAC_VERSION = '1.1.0' as const
export const STAC_MEDIA_TYPES = {
  Catalog: 'application/json', Collection: 'application/json', Feature: 'application/geo+json',
} as const

export type StacBbox = [number, number, number, number]
export interface StacExtensionFields {
  [key: `${string}:${string}`]: unknown
}
export interface StacLink {
  rel: string
  href: string
  type?: string
  title?: string
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
}
export interface StacAsset extends StacExtensionFields {
  href: string
  type: string
  roles: string[]
  title?: string
}
export interface StacProvider {
  name: string
  description?: string
  roles?: ('licensor' | 'producer' | 'processor' | 'host')[]
  url?: string
}
interface StacResource extends StacExtensionFields {
  stac_version: typeof STAC_VERSION
  stac_extensions: string[]
  id: string
  links: StacLink[]
}
export interface StacCatalog extends StacResource {
  type: 'Catalog'
  title?: string
  description: string
}
export interface StacCollection extends StacResource {
  type: 'Collection'
  title?: string
  description: string
  license: string
  extent: {
    spatial: { bbox: StacBbox[] }
    temporal: { interval: [string | null, string | null][] }
  }
  keywords?: string[]
  providers?: StacProvider[]
  assets?: Record<string, StacAsset>
}
export type StacTemporal =
  | { datetime: string; start_datetime?: never; end_datetime?: never }
  | { datetime: null; start_datetime: string; end_datetime: string }
export type StacSpatial =
  | { geometry: Polygon | MultiPolygon; bbox: StacBbox }
  | { geometry: null; bbox?: never }
export type StacItem = StacResource & StacSpatial & {
  type: 'Feature'
  collection?: string
  properties: StacTemporal & StacExtensionFields & {
    title?: string
    description?: string
    created?: string
    updated?: string
    license?: string
    keywords?: string[]
    providers?: StacProvider[]
  }
  assets: Record<string, StacAsset>
}
export type StacDocument = StacCatalog | StacCollection | StacItem