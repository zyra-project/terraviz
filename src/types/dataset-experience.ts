/**
 * TerraViz-owned presentation metadata for dataset features that do not belong
 * in a Tour: synchronized audio/captions, endpoint dwell, simultaneous layers,
 * and globe/data-synchronized overlays. Tours remain the home for sequential
 * narration, camera choreography, and room/projector presentation cards.
 */

export interface DatasetTextTrack {
  source: string
  format: 'vtt' | 'srt' | 'unknown'
  language: string
  label?: string
  isDefault?: boolean
}

export interface DatasetAudioTrack {
  source: string
  volume?: number
  startOffsetMs?: number
  sync: 'dataset-clock'
}

export interface DatasetPlaybackPolicy {
  firstDwellMs?: number
  lastDwellMs?: number
}

export interface DatasetCompositionLayer {
  ordinal: number
  name: string
  source: string
  opacity?: number
  visible?: boolean
  blendMode?: 'normal' | 'multiply' | 'screen' | 'add'
  syncGroup?: string
  sourceMetadata?: Record<string, string>
}

export interface DatasetOverlayTrack {
  ordinal: number
  source: string
  kind: 'image' | 'video' | 'text' | 'live' | 'unknown'
  placement: 'viewport' | 'globe' | 'projector'
  pathSource?: string
  opacity?: number
  width?: number
  height?: number
  sourceMetadata?: Record<string, string>
}

export interface DatasetAssetRights {
  source: string
  licenseSpdx?: string
  licenseUrl?: string
  licenseStatement?: string
  attributionText?: string
  rightsHolder?: string
}

export interface DatasetExperienceManifest {
  version: 1
  textTracks?: DatasetTextTrack[]
  audioTracks?: DatasetAudioTrack[]
  playbackPolicy?: DatasetPlaybackPolicy
  composition?: { layers: DatasetCompositionLayer[] }
  overlays?: DatasetOverlayTrack[]
  assetRights?: DatasetAssetRights[]
}

/** Fail closed: malformed manifests are omitted from the public catalog. */
export function parseDatasetExperience(value: unknown): DatasetExperienceManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const manifest = value as Record<string, unknown>
  if (manifest.version !== 1) return null
  for (const key of ['textTracks', 'audioTracks', 'overlays', 'assetRights']) {
    const field = manifest[key]
    if (field !== undefined && (!Array.isArray(field) || field.length > 64)) return null
  }
  const composition = manifest.composition
  if (composition !== undefined) {
    if (!composition || typeof composition !== 'object' || Array.isArray(composition)) return null
    const layers = (composition as Record<string, unknown>).layers
    if (!Array.isArray(layers) || layers.length < 2 || layers.length > 32) return null
  }
  return value as DatasetExperienceManifest
}

