/** Read the native SOS catalog database. This is intentionally not SOS Explorer. */

import { createRequire } from 'node:module'
import { basename } from 'node:path'
import { sosPathToFtpUrl } from './sos-source'

interface DatabaseStatement {
  all(...params: unknown[]): unknown[]
}

interface DatabaseSyncLike {
  prepare(sql: string): DatabaseStatement
  close(): void
}

interface NativeDataSetRow {
  DataID: number
  Name: string
  Description: string | null
  NotableFeatures: string | null
  Directory: string | null
  Video_Preview: string | null
  Video_Download: string | null
  Thumbnail_Small: string | null
  Thumbnail_Big: string | null
  SetSource: string | null
  DateAdded: string | null
  IsNarratedMovie: number
  IsMovie: number
  IsRealtime: number
  HasAudio: number
  HasPIP: number
  WebGL: number
  InteractiveSphere: string | null
  KML: string | null
  StartDate: string | null
  EndDate: string | null
  LiveProgramsPlaylist: string | null
  FrameWidth: number
  IsSOSx: number
  IsSOS: number
}

interface NativeVariationRow {
  DataID: number
  Name: string
  Path: string
  HasAudio: number
  HasPIP: number
  IsTranslated: number
  FrameWidth: number
}

export interface SosCatalogContact {
  type: string
  name: string
  organization: string | null
  url: string | null
  email: string | null
}

export interface SosCatalogDataset {
  dataId: number
  name: string
  description: string | null
  notableFeatures: string | null
  directory: string | null
  setSource: string | null
  dateAdded: string | null
  startDate: string | null
  endDate: string | null
  liveProgramsPlaylist: string | null
  flags: {
    narratedMovie: boolean
    movie: boolean
    realtime: boolean
    audio: boolean
    pip: boolean
    webgl: boolean
    sosx: boolean
    sos: boolean
  }
  categories: Array<{ major: string; subcategory: string | null }>
  keywords: string[]
  contacts: SosCatalogContact[]
  variations: SosCatalogVariation[]
}

export interface SosCatalogVariation {
  dataId: number
  name: string
  path: string
  hasAudio: boolean
  hasPip: boolean
  isTranslated: boolean
  frameWidth: number
}

export interface SosCatalog {
  path: string
  datasets: SosCatalogDataset[]
}

function asRows<T>(db: DatabaseSyncLike, sql: string): T[] {
  return db.prepare(sql).all() as T[]
}

export function normalizeSosLocation(value: string): string {
  const mapped = sosPathToFtpUrl(value) ?? value
  try {
    const url = new URL(mapped)
    url.hash = ''
    url.search = ''
    return url.toString().replace(/\/$/, '').toLowerCase()
  } catch {
    return mapped.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  }
}

export function loadSosCatalog(path: string): SosCatalog {
  const require = createRequire(import.meta.url)
  const { DatabaseSync } = require('node:sqlite') as {
    DatabaseSync: new (filename: string, options: { readOnly: boolean }) => DatabaseSyncLike
  }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const sourceRows = asRows<NativeDataSetRow>(db, 'SELECT * FROM DataSet ORDER BY DataID')
    const variations = asRows<NativeVariationRow>(
      db,
      'SELECT * FROM DataSetVariation ORDER BY DataID, Path',
    )
    const categories = asRows<{
      DataID: number
      Major: string
      Subcategory: string | null
    }>(
      db,
      `SELECT j.DataID, m.Name AS Major, s.Name AS Subcategory
         FROM DataSetCategoryJct j
         JOIN MajorCategory m ON m.MajorCategoryID = j.MajorCategoryID
         LEFT JOIN SubCategory s ON s.SubCategoryID = j.SubCategoryID
        ORDER BY j.DataID, m.Name, s.Name`,
    )
    const keywords = asRows<{ DataID: number; Name: string }>(
      db,
      `SELECT j.DataID, k.Name
         FROM DataSetKeywordJct j JOIN Keyword k ON k.KeywordID = j.KeywordID
        ORDER BY j.DataID, k.Name`,
    )
    const contacts = asRows<{
      DataID: number
      Type: string
      Name: string
      Organization: string | null
      URL: string | null
      Email: string | null
    }>(
      db,
      `SELECT j.DataID, t.Name AS Type, c.Name, c.Organization, c.URL, c.Email
         FROM DataSetContactJct j
         JOIN Contact c ON c.ContactID = j.ContactID
         JOIN ContactType t ON t.ContactTypeID = j.ContactTypeID
        ORDER BY j.DataID, t.Name, c.Name`,
    )

    return {
      path,
      datasets: sourceRows.map(row => ({
        dataId: row.DataID,
        name: row.Name,
        description: row.Description,
        notableFeatures: row.NotableFeatures,
        directory: row.Directory,
        setSource: row.SetSource,
        dateAdded: row.DateAdded,
        startDate: row.StartDate,
        endDate: row.EndDate,
        liveProgramsPlaylist: row.LiveProgramsPlaylist,
        flags: {
          narratedMovie: row.IsNarratedMovie === 1,
          movie: row.IsMovie === 1,
          realtime: row.IsRealtime === 1,
          audio: row.HasAudio === 1,
          pip: row.HasPIP === 1,
          webgl: row.WebGL === 1,
          sosx: row.IsSOSx === 1,
          sos: row.IsSOS === 1,
        },
        categories: categories
          .filter(category => category.DataID === row.DataID)
          .map(category => ({ major: category.Major, subcategory: category.Subcategory })),
        keywords: keywords
          .filter(keyword => keyword.DataID === row.DataID)
          .map(keyword => keyword.Name),
        contacts: contacts
          .filter(contact => contact.DataID === row.DataID)
          .map(contact => ({
            type: contact.Type,
            name: contact.Name,
            organization: contact.Organization,
            url: contact.URL,
            email: contact.Email,
          })),
        variations: variations
          .filter(variation => variation.DataID === row.DataID)
          .map(variation => ({
            dataId: variation.DataID,
            name: variation.Name,
            path: variation.Path,
            hasAudio: variation.HasAudio === 1,
            hasPip: variation.HasPIP === 1,
            isTranslated: variation.IsTranslated === 1,
            frameWidth: variation.FrameWidth,
          })),
      })),
    }
  } finally {
    db.close()
  }
}

export interface SosCatalogMatch {
  dataset: SosCatalogDataset
  variation?: SosCatalogVariation
  legacyId: string
}

function variationToken(path: string): string {
  return basename(path)
    .replace(/\.sos$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'variation'
}

export function matchSosCatalog(catalog: SosCatalog, playlistSource: string): SosCatalogMatch | null {
  const target = normalizeSosLocation(playlistSource)
  for (const dataset of catalog.datasets) {
    for (const variation of dataset.variations) {
      if (normalizeSosLocation(variation.path) === target) {
        return {
          dataset,
          variation,
          legacyId: `sos:${dataset.dataId}:${variationToken(variation.path)}`,
        }
      }
    }
  }

  const candidates = catalog.datasets
    .filter(dataset => dataset.directory && target.startsWith(normalizeSosLocation(dataset.directory!)))
    .sort((a, b) => (b.directory?.length ?? 0) - (a.directory?.length ?? 0))
  const dataset = candidates[0]
  return dataset ? { dataset, legacyId: `sos:${dataset.dataId}:primary` } : null
}

