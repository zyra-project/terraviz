/** Convert crawled native-SOS metadata into an explicit TerraViz migration plan. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import type { CrawledSosPlaylist, SosResolvedReference } from './sos-crawler'
import {
  matchSosCatalog,
  type SosCatalog,
  type SosCatalogMatch,
} from './sos-catalog'
import { propertyValue, propertyValues, type SosClip, type SosProperty } from './sos-playlist'
import { resolveSosReference } from './sos-source'
import type { DatasetExperienceManifest } from '../../src/types/dataset-experience'

export interface SosLicenseOverride {
  license_spdx?: string
  license_url?: string
  license_statement?: string
  attribution_text?: string
  rights_holder?: string
}

export interface SosDatasetOverride extends SosLicenseOverride {
  title?: string
  visibility?: 'public' | 'federated' | 'restricted' | 'private'
  disposition?: 'import' | 'deprecate' | 'skip'
  notes?: string
  /** Key by raw or resolved source asset URL; no inheritance is assumed. */
  asset_rights?: Record<string, SosLicenseOverride>
}

export interface SosImportPolicy {
  version: 1
  defaults?: {
    visibility_when_license_unknown?: 'restricted' | 'private'
    caption_language?: string
  }
  datasets?: Record<string, SosDatasetOverride>
}

export interface SosConversionIssue {
  severity: 'info' | 'review' | 'unsupported'
  code: string
  message: string
  terravizFeature?: string
}

export interface SosFeatureManifest {
  textTracks: Array<{
    source: string
    format: 'srt' | 'unknown'
    language: string
    conversion: 'srt-to-vtt' | 'preserve'
  }>
  mediaTracks: Array<{
    kind: 'audio'
    source: string
    volume: number | null
    sync: 'dataset-clock'
  }>
  playbackPolicy?: {
    firstDwellMs?: number
    lastDwellMs?: number
  }
  composition?: {
    layers: Array<{
      ordinal: number
      name: string
      source: string | null
      properties: Record<string, string>
    }>
  }
  overlays: Array<{
    ordinal: number
    source: string | null
    style: string | null
    pathSource: string | null
    properties: Record<string, string>
    proposedTarget: 'tour' | 'composition-overlay' | 'manual'
  }>
}

export interface SosConversionPlan {
  legacyId: string
  sourcePlaylist: string
  sourceFingerprint: string
  clipIndex: number
  catalogDataId: number | null
  catalogVariation: string | null
  title: string
  disposition: 'import' | 'deprecate' | 'skip'
  readiness: 'ready_for_transfer' | 'needs_review' | 'unsupported'
  draft: Record<string, unknown>
  features: SosFeatureManifest
  sourceAssets: SosResolvedReference[]
  unknownProperties: SosProperty[]
  issues: SosConversionIssue[]
  /** Canonical TerraViz metadata; source-only details stay in features/import state. */
  experience: DatasetExperienceManifest
  /** Generated only for presentation PIPs; asset URLs are rewritten during transfer. */
  companionTour?: { tourTasks: Array<Record<string, unknown>> }
}

const KNOWN_PROPERTIES = new Set([
  'name', 'rename', 'include', 'data', 'datadir', 'layer', 'layerdata',
  'audio', 'volume', 'caption', 'captionformat', 'label', 'labelformat',
  'labelcolor', 'labelposition', 'background', 'overlay', 'firstdwell',
  'lastdwell', 'fps', 'animate', 'category', 'majorcategory', 'keywords',
  'creator', 'description', 'script', 'loop', 'projection', 'startdate',
  'enddate', 'pip', 'pipname', 'pipstyle', 'pipwidth', 'pipheight',
  'pipcoords', 'pipalpha', 'pippath', 'pippathformat', 'pipdelay',
  'piptimer', 'pipfadein', 'pipfadeout', 'piploop', 'pipvolume',
])

function propertyMap(properties: SosProperty[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const property of properties) out[property.name] = property.value
  return out
}

function parseNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value.trim())) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}

function parseVolume(value: string | undefined): number | null {
  if (value === undefined) return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return null
  return number > 1 ? Math.min(number / 100, 1) : Math.min(number, 1)
}

function resolvedValues(source: string, properties: SosProperty[], name: string): string[] {
  return propertyValues(properties, name).map(value => resolveSosReference(source, value))
}

function inferFormat(source: string | undefined): string {
  if (!source) return 'image/png'
  const clean = source.split(/[?#]/, 1)[0].toLowerCase()
  if (/\.(mp4|mov|m4v|avi|webm)$/.test(clean)) return 'video/mp4'
  if (/\.jpe?g$/.test(clean)) return 'image/jpeg'
  if (/\.webp$/.test(clean)) return 'image/webp'
  return 'image/png'
}

function safeDate(value: string | null): string | undefined {
  if (!value) return undefined
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value)
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString()
}

function fallbackLegacyId(source: string, clip: SosClip): string {
  const hash = createHash('sha256')
    .update(`${source}\n${clip.index}\n${clip.name}`)
    .digest('hex')
    .slice(0, 16)
  return `sos-playlist:${hash}`
}

function chooseLegacyId(match: SosCatalogMatch | null, clip: SosClip): string {
  if (!match) return fallbackLegacyId(clip.source, clip)
  return clip.index === 0 ? match.legacyId : `${match.legacyId}:clip-${clip.index + 1}`
}

function classifyPip(properties: Record<string, string>): 'tour' | 'composition-overlay' | 'manual' {
  const source = properties.pip?.toLowerCase() ?? ''
  const style = properties.pipstyle?.toLowerCase() ?? 'room'
  if (/^(rtsp|udp):/.test(source) || source === 'webcam') return 'manual'
  if (properties.pippath || style === 'globe') return 'composition-overlay'
  return 'tour'
}

function mediaKind(source: string): 'image' | 'video' | 'text' | 'live' | 'unknown' {
  if (/^(rtsp|udp):/i.test(source) || source.toLowerCase() === 'webcam') return 'live'
  if (/\.(png|jpe?g|gif|webp|tiff?)$/i.test(source)) return 'image'
  if (/\.(mp4|mov|m4v|webm|avi)$/i.test(source)) return 'video'
  if (/\.(txt|html?)$/i.test(source)) return 'text'
  return 'unknown'
}

function canonicalExperience(
  features: SosFeatureManifest,
  sourceAssets: SosResolvedReference[],
  override: SosDatasetOverride,
): DatasetExperienceManifest {
  const experience: DatasetExperienceManifest = { version: 1 }
  if (features.textTracks.length) {
    experience.textTracks = features.textTracks.map(track => ({
      source: track.source,
      format: track.format,
      language: track.language,
    }))
  }
  if (features.mediaTracks.length) {
    experience.audioTracks = features.mediaTracks.map(track => ({
      source: track.source,
      sync: track.sync,
      ...(track.volume == null ? {} : { volume: track.volume }),
    }))
  }
  if (features.playbackPolicy) experience.playbackPolicy = features.playbackPolicy
  if (features.composition) {
    const layers = features.composition.layers
      .filter(layer => layer.source !== null)
      .map(layer => ({
        ordinal: layer.ordinal,
        name: layer.name,
        source: layer.source!,
        sourceMetadata: layer.properties,
      }))
    if (layers.length > 1) experience.composition = { layers }
  }
  const overlays = features.overlays
    .filter(overlay => overlay.proposedTarget !== 'tour' && overlay.source !== null)
    .map(overlay => ({
      ordinal: overlay.ordinal,
      source: overlay.source!,
      kind: mediaKind(overlay.source!),
      placement: overlay.style === 'projector' ? 'projector' as const : 'globe' as const,
      ...(overlay.pathSource ? { pathSource: overlay.pathSource } : {}),
      sourceMetadata: overlay.properties,
    }))
  if (overlays.length) experience.overlays = overlays
  const rights = sourceAssets.flatMap(asset => {
    const value = override.asset_rights?.[asset.resolved] ?? override.asset_rights?.[asset.raw]
    if (!value) return []
    return [{
      source: asset.resolved,
      ...(value.license_spdx ? { licenseSpdx: value.license_spdx } : {}),
      ...(value.license_url ? { licenseUrl: value.license_url } : {}),
      ...(value.license_statement ? { licenseStatement: value.license_statement } : {}),
      ...(value.attribution_text ? { attributionText: value.attribution_text } : {}),
      ...(value.rights_holder ? { rightsHolder: value.rights_holder } : {}),
    }]
  })
  if (rights.length) experience.assetRights = rights
  return experience
}

function companionTour(
  legacyId: string,
  features: SosFeatureManifest,
): { tourTasks: Array<Record<string, unknown>> } | undefined {
  const presentation = features.overlays.filter(overlay =>
    overlay.proposedTarget === 'tour' && overlay.source,
  )
  if (!presentation.length) return undefined
  const tourTasks: Array<Record<string, unknown>> = [
    { loadDataset: { id: legacyId, datasetID: 'sos-dataset', worldIndex: 1 } },
  ]
  for (const overlay of presentation) {
    const source = overlay.source!
    const timer = Number(overlay.properties.piptimer)
    if (/\.(mp4|mov|m4v|webm|avi)$/i.test(source)) {
      tourTasks.push({ playVideo: { filename: source, showControls: false } })
    } else {
      const imageID = `sos-pip-${overlay.ordinal + 1}`
      tourTasks.push({
        showImage: {
          imageID,
          filename: source,
          isAspectRatioLocked: true,
          isClosable: true,
        },
      })
      if (Number.isFinite(timer) && timer > 0) {
        tourTasks.push({ pauseSeconds: timer / 1000 })
        tourTasks.push({ hideImage: imageID })
      }
    }
  }
  return { tourTasks }
}

function buildFeatures(
  clip: SosClip,
  policy: SosImportPolicy,
): SosFeatureManifest {
  const language = policy.defaults?.caption_language ?? 'en'
  const captions = resolvedValues(clip.source, clip.properties, 'caption')
  const audio = resolvedValues(clip.source, clip.properties, 'audio')
  const firstDwellMs = parseNonNegativeInteger(propertyValue(clip.properties, 'firstdwell'))
  const lastDwellMs = parseNonNegativeInteger(propertyValue(clip.properties, 'lastdwell'))

  const layers = clip.layers.map(layer => {
    const properties = propertyMap(layer.properties)
    const rawSource = properties.datadir
    return {
      ordinal: layer.index,
      name: properties.layer ?? `Layer ${layer.index + 1}`,
      source: rawSource ? resolveSosReference(clip.source, rawSource) : null,
      properties,
    }
  })
  const overlays = clip.pips.map(pip => {
    const properties = propertyMap(pip.properties)
    return {
      ordinal: pip.index,
      source: properties.pip ? resolveSosReference(clip.source, properties.pip) : null,
      style: properties.pipstyle ?? null,
      pathSource: properties.pippath
        ? resolveSosReference(clip.source, properties.pippath)
        : null,
      proposedTarget: classifyPip(properties),
      properties,
    }
  })

  return {
    textTracks: captions.map(source => ({
      source,
      format: source.toLowerCase().endsWith('.srt') ? 'srt' : 'unknown',
      language,
      conversion: source.toLowerCase().endsWith('.srt') ? 'srt-to-vtt' : 'preserve',
    })),
    mediaTracks: audio.map(source => ({
      kind: 'audio',
      source,
      volume: parseVolume(propertyValue(clip.properties, 'volume')),
      sync: 'dataset-clock',
    })),
    playbackPolicy:
      firstDwellMs !== undefined || lastDwellMs !== undefined
        ? { firstDwellMs, lastDwellMs }
        : undefined,
    composition: layers.length > 1 ? { layers } : undefined,
    overlays,
  }
}

function buildIssues(
  clip: SosClip,
  features: SosFeatureManifest,
  override: SosDatasetOverride,
): SosConversionIssue[] {
  const issues: SosConversionIssue[] = []
  if (!override.license_spdx && !override.license_url && !override.license_statement) {
    issues.push({
      severity: 'review',
      code: 'license_unknown',
      message: 'SOS has provenance/attribution but no reliable dataset license; keep private until reviewed.',
      terravizFeature: 'dataset-rights',
    })
  }
  if (features.mediaTracks.length) {
    issues.push({
      severity: 'review',
      code: 'dataset_audio_track',
      message: 'Preserve as a dataset-synchronized audio track, not Tour narration.',
      terravizFeature: 'dataset-media-tracks',
    })
  }
  if (features.textTracks.length > 1) {
    issues.push({
      severity: 'review',
      code: 'multiple_caption_tracks',
      message: 'Multiple caption tracks require language/default selection beyond legacy caption_ref.',
      terravizFeature: 'dataset-text-tracks',
    })
  }
  if (features.playbackPolicy) {
    issues.push({
      severity: 'review',
      code: 'endpoint_dwell',
      message: 'Preserve firstdwell/lastdwell in the dataset playback state machine.',
      terravizFeature: 'dataset-playback-policy',
    })
  }
  if (features.composition) {
    issues.push({
      severity: 'review',
      code: 'multiple_layers',
      message: 'Simultaneous SOS layers map to a TerraViz composition, not a sequential Tour.',
      terravizFeature: 'dataset-compositions',
    })
  }
  for (const overlay of features.overlays) {
    if (overlay.proposedTarget === 'manual') {
      issues.push({
        severity: 'unsupported',
        code: 'live_pip',
        message: `PIP ${overlay.ordinal + 1} uses a live/unsupported source and needs a gateway or deprecation decision.`,
        terravizFeature: 'live-media-gateway',
      })
    } else if (overlay.proposedTarget === 'composition-overlay') {
      issues.push({
        severity: 'review',
        code: 'synchronized_pip',
        message: `PIP ${overlay.ordinal + 1} is globe/path synchronized and maps to a composition overlay track.`,
        terravizFeature: 'dataset-composition-overlays',
      })
    } else {
      issues.push({
        severity: 'info',
        code: 'presentation_pip',
        message: `PIP ${overlay.ordinal + 1} can become a companion Tour media task after asset migration.`,
        terravizFeature: 'tours',
      })
    }
  }
  if (propertyValue(clip.properties, 'script')) {
    issues.push({
      severity: 'unsupported',
      code: 'script_blocked',
      message: 'SOS playlist scripts are recorded for review and never executed by the importer.',
      terravizFeature: 'none-security-boundary',
    })
  }
  return issues
}

export function loadSosImportPolicy(path?: string): SosImportPolicy {
  if (!path) return { version: 1 }
  const parsed = parseYaml(readFileSync(path, 'utf8')) as Partial<SosImportPolicy> | null
  if (!parsed || parsed.version !== 1) throw new Error(`${path}: policy version must be 1`)
  return parsed as SosImportPolicy
}

export function buildSosConversionPlans(
  crawled: CrawledSosPlaylist[],
  catalog: SosCatalog,
  policy: SosImportPolicy,
): SosConversionPlan[] {
  const plans: SosConversionPlan[] = []
  for (const item of crawled) {
    const match = matchSosCatalog(catalog, item.source)
    for (const clip of item.playlist.clips) {
      const legacyId = chooseLegacyId(match, clip)
      const override = policy.datasets?.[legacyId] ?? {}
      const features = buildFeatures(clip, policy)
      const issues = buildIssues(clip, features, override)
      if (!match) {
        issues.push({
          severity: 'review',
          code: 'catalog_unmatched',
          message: 'Playlist did not match a native SOS catalog dataset or variation.',
        })
      }
      const datadirRaw = propertyValue(clip.properties, 'datadir')
      const datadir = datadirRaw ? resolveSosReference(clip.source, datadirRaw) : undefined
      if (!datadir) {
        issues.push({
          severity: 'unsupported',
          code: 'missing_primary_media',
          message: 'Clip has no data/datadir source.',
        })
      }
      const unknownProperties = clip.properties.filter(property => !KNOWN_PROPERTIES.has(property.name))
      if (unknownProperties.length) {
        issues.push({
          severity: 'review',
          code: 'unknown_properties',
          message: `${unknownProperties.length} property occurrence(s) have no approved mapping.`,
        })
      }

      const licenseKnown = Boolean(
        override.license_spdx || override.license_url || override.license_statement,
      )
      const visibility = override.visibility ??
        (licenseKnown ? 'private' : policy.defaults?.visibility_when_license_unknown ?? 'private')
      const catalogDataset = match?.dataset
      const title = override.title ?? match?.variation?.name ?? catalogDataset?.name ?? clip.name
      const draft: Record<string, unknown> = {
        title,
        format: inferFormat(datadir),
        data_ref: datadir ? `url:${datadir}` : '',
        visibility,
        legacy_id: legacyId,
      }
      if (catalogDataset?.description) draft.abstract = catalogDataset.description
      if (catalogDataset?.setSource) draft.attribution_text = catalogDataset.setSource
      if (catalogDataset?.directory) draft.website_link = catalogDataset.directory
      const start = safeDate(catalogDataset?.startDate ?? null)
      const end = safeDate(catalogDataset?.endDate ?? null)
      if (start) draft.start_time = start
      if (end) draft.end_time = end
      if (override.license_spdx) draft.license_spdx = override.license_spdx
      if (override.license_url) draft.license_url = override.license_url
      if (override.license_statement) draft.license_statement = override.license_statement
      if (override.attribution_text) draft.attribution_text = override.attribution_text
      if (override.rights_holder) draft.rights_holder = override.rights_holder
      if (features.textTracks.length === 1) draft.caption_ref = features.textTracks[0].source
      if (catalogDataset?.categories.length) {
        const grouped: Record<string, string[]> = {}
        for (const category of catalogDataset.categories) {
          const values = grouped[category.major] ?? []
          if (category.subcategory) values.push(category.subcategory)
          grouped[category.major] = values
        }
        draft.categories = grouped
      }
      if (catalogDataset?.keywords.length) draft.keywords = catalogDataset.keywords

      const sourceAssets = item.references.filter(reference =>
        reference.role !== 'playlist' && clip.properties.some(property =>
          property.name === reference.property && property.value === reference.raw,
        ),
      ).filter((reference, index, all) =>
        all.findIndex(other => other.property === reference.property && other.resolved === reference.resolved) === index,
      )
      const disposition = override.disposition ?? 'import'
      const unsupported = issues.some(issue => issue.severity === 'unsupported')
      const needsReview = issues.some(issue => issue.severity === 'review')
      const experience = canonicalExperience(features, sourceAssets, override)
      const tour = companionTour(legacyId, features)
      if (Object.keys(experience).length > 1) {
        draft.experience_manifest = JSON.stringify(experience)
      }
      draft.source_import_state = JSON.stringify({
        version: 1,
        sourceSystem: 'sos',
        sourcePlaylist: item.source,
        sourceFingerprint: item.sha256,
        sourceFeatures: features,
        unknownProperties,
      })
      plans.push({
        legacyId,
        sourcePlaylist: item.source,
        sourceFingerprint: item.sha256,
        clipIndex: clip.index,
        catalogDataId: catalogDataset?.dataId ?? null,
        catalogVariation: match?.variation?.path ?? null,
        title,
        disposition,
        readiness: unsupported ? 'unsupported' : needsReview ? 'needs_review' : 'ready_for_transfer',
        draft,
        features,
        sourceAssets,
        unknownProperties,
        issues,
        experience,
        ...(tour ? { companionTour: tour } : {}),
      })
    }
  }
  return plans
}
