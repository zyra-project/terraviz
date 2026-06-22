/**
 * Catalog API fixtures for the smoke tests.
 *
 * The catalog browse surface (`/?catalog=true`) boots from this
 * deployment's `/api/v1/catalog` (+ `/api/v1/tours`). On a CI dev
 * server there is no Pages Functions backend, so those paths return the
 * bundled `index.html` — HTML that fails JSON parse, leaving the
 * catalog empty and `#browse-overlay` hidden. The smoke catalog checks
 * then race a never-arriving grid against the 30s locator timeout and
 * flake.
 *
 * Stubbing the two endpoints makes the browse overlay populate
 * deterministically. Two of the four datasets carry "Ocean" in the
 * title so the search-narrowing assertion (search "ocean" → strictly
 * fewer cards) is stable. See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { FixtureRule } from '../core/fixtures'

/** Minimal subset of the `/api/v1/catalog` wire shape the SPA consumes. */
interface WireDatasetFixture {
  id: string
  title: string
  format: string
  dataLink: string
  organization?: string
  abstractTxt?: string
  tags?: string[]
  boundingBox?: { n: number; s: number; w: number; e: number }
}

const WORLDWIDE = { n: 90, s: -90, w: -180, e: 180 }

const DATASETS: WireDatasetFixture[] = [
  {
    id: 'INTERNAL_OCEAN_SST',
    title: 'Ocean Surface Temperature',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NOAA',
    abstractTxt: 'Sea surface temperature across the global ocean.',
    tags: ['Ocean'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_OCEAN_CURRENTS',
    title: 'Ocean Surface Currents',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NOAA',
    abstractTxt: 'Surface currents across the world ocean.',
    tags: ['Ocean'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_ATMO_CO2',
    title: 'Atmospheric Carbon Dioxide',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NASA',
    abstractTxt: 'Global atmospheric carbon dioxide concentration.',
    tags: ['Atmosphere'],
    boundingBox: WORLDWIDE,
  },
  {
    id: 'INTERNAL_LAND_NDVI',
    title: 'Vegetation Index',
    format: 'image',
    dataLink: '/assets/equirect-sample.png',
    organization: 'NASA',
    abstractTxt: 'Land vegetation greenness from satellite.',
    tags: ['Land'],
    boundingBox: WORLDWIDE,
  },
]

/** Route-stub rules for the catalog + tours endpoints. */
export function catalogFixtures(): FixtureRule[] {
  return [
    { url: '/api/v1/catalog', json: { datasets: DATASETS } },
    { url: '/api/v1/tours', json: { tours: [] } },
  ]
}
