/** Recursive, metadata-only crawler for native SOS playlist trees. */

import { createHash } from 'node:crypto'
import {
  parseSosPlaylist,
  SOS_REFERENCE_PROPERTIES,
  type SosPlaylist,
  type SosProperty,
} from './sos-playlist'
import { resolveSosReference, type SosPlaylistReader } from './sos-source'

export interface SosResolvedReference {
  property: string
  raw: string
  resolved: string
  line: number
  role: 'playlist' | 'media' | 'control' | 'script'
}

export interface CrawledSosPlaylist {
  source: string
  depth: number
  sha256: string
  playlist: SosPlaylist
  references: SosResolvedReference[]
}

export interface SosCrawlIssue {
  source: string
  code: 'fetch_failed' | 'depth_exceeded' | 'cycle' | 'invalid_reference'
  message: string
}

export interface SosCrawlResult {
  roots: string[]
  playlists: CrawledSosPlaylist[]
  issues: SosCrawlIssue[]
}

export interface SosCrawlerOptions {
  maxDepth?: number
}

function roleForProperty(name: string): SosResolvedReference['role'] {
  if (name === 'include') return 'playlist'
  if (name === 'script') return 'script'
  if (name.endsWith('format') || name === 'pippath' || name === 'label') return 'control'
  return 'media'
}

function allProperties(playlist: SosPlaylist): SosProperty[] {
  const out = [...playlist.properties]
  for (const clip of playlist.clips) out.push(...clip.properties)
  return out
}

export async function crawlSosPlaylists(
  roots: string[],
  reader: SosPlaylistReader,
  options: SosCrawlerOptions = {},
): Promise<SosCrawlResult> {
  const maxDepth = options.maxDepth ?? 9
  const result: SosCrawlResult = { roots: [...roots], playlists: [], issues: [] }
  const visited = new Set<string>()
  const active = new Set<string>()

  const visit = async (source: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      result.issues.push({
        source,
        code: 'depth_exceeded',
        message: `include depth ${depth} exceeds SOS limit ${maxDepth}`,
      })
      return
    }
    if (active.has(source)) {
      result.issues.push({ source, code: 'cycle', message: 'recursive include ignored' })
      return
    }
    if (visited.has(source)) return
    visited.add(source)
    active.add(source)

    try {
      const text = await reader(source)
      const playlist = parseSosPlaylist(text, source)
      const references: SosResolvedReference[] = []
      for (const property of allProperties(playlist)) {
        if (!SOS_REFERENCE_PROPERTIES.has(property.name) || !property.value) continue
        try {
          references.push({
            property: property.name,
            raw: property.value,
            resolved: resolveSosReference(source, property.value),
            line: property.line,
            role: roleForProperty(property.name),
          })
        } catch (error) {
          result.issues.push({
            source,
            code: 'invalid_reference',
            message: `${property.name} at line ${property.line}: ${error instanceof Error ? error.message : error}`,
          })
        }
      }
      result.playlists.push({
        source,
        depth,
        sha256: createHash('sha256').update(text).digest('hex'),
        playlist,
        references,
      })
      for (const include of references.filter(reference => reference.role === 'playlist')) {
        await visit(include.resolved, depth + 1)
      }
    } catch (error) {
      result.issues.push({
        source,
        code: 'fetch_failed',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      active.delete(source)
    }
  }

  for (const root of roots) await visit(root, 0)
  return result
}

