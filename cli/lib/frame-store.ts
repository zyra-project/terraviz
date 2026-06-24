/**
 * Content-addressed frame store helpers, runner side
 * (`docs/INCREMENTAL_FRAME_UPLOAD_PLAN.md`).
 *
 * Frames live at the shared key
 * `videos/{datasetId}/frames/sha256/{hex}.{ext}` — keyed by the SHA-256
 * of their bytes, the same digest the publisher records in
 * `source_filenames.json`. The transcode resolves each frame to
 * download by digest (not a per-upload index), the publish path HEAD-
 * skips keys already present, and the mark-and-sweep GC prunes frames
 * no live upload references — exactly mirroring the HLS *segment* store
 * (`cli/lib/hls-incremental.ts`). The server-side equivalent of these
 * builders is `buildContentAddressedFrameKey` /
 * `buildFramesContentPrefix` in `functions/api/v1/_lib/r2-store.ts`;
 * the two must agree byte-for-byte.
 */

/** 64-char lowercase hex of a `sha256:<hex>` (or bare hex) digest, or
 *  null when it doesn't look like a SHA-256. */
export function frameHexFromDigest(digest: string): string | null {
  const hex = digest.replace(/^sha256:/, '')
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null
}

/** Shared content-addressed key for a frame:
 *  `videos/{datasetId}/frames/sha256/{hex}.{ext}`. Throws on a
 *  malformed digest or extension (callers pass manifest-validated
 *  values, so a throw means a real desync, not user input). */
export function frameContentKey(datasetId: string, digest: string, ext: string): string {
  const hex = frameHexFromDigest(digest)
  if (!hex) throw new Error(`frame-store: bad digest "${digest}"`)
  if (!/^[a-z0-9]+$/.test(ext)) throw new Error(`frame-store: bad extension "${ext}"`)
  return `${frameStorePrefix(datasetId)}${hex}.${ext}`
}

/** Prefix holding all content-addressed frames for a dataset:
 *  `videos/{datasetId}/frames/sha256/` (trailing slash). Scopes the
 *  GC's R2 list to exactly the frame objects. */
export function frameStorePrefix(datasetId: string): string {
  return `videos/${datasetId}/frames/sha256/`
}

/** Extract the `{hex}` from a content-addressed frame key (the value
 *  the GC's R2 list yields), or null when the key isn't one. */
export function frameHexFromKey(key: string): string | null {
  const m = /\/frames\/sha256\/([0-9a-f]{64})\.[a-z0-9]+$/.exec(key)
  return m ? m[1] : null
}

/**
 * Pure mark-and-sweep selection: given every hex currently in the
 * store and the digests referenced by the live + previous manifests
 * (the grace window), return the orphan hexes safe to delete.
 *
 * Keeping the previous upload's frames as well as the current one's
 * gives in-flight readers on the prior bundle a one-run grace window,
 * matching the HLS segment GC (`pruneSegments`).
 */
export function selectFrameOrphans(
  allHexes: readonly string[],
  keepDigests: readonly string[],
): string[] {
  const keep = new Set<string>()
  for (const d of keepDigests) {
    const hex = frameHexFromDigest(d)
    if (hex) keep.add(hex)
  }
  return allHexes.filter(hex => !keep.has(hex))
}
