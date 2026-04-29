/**
 * Build-time switch that controls where `dataService.ts` and
 * `datasetLoader.ts` source their catalog data from.
 *
 *   - `legacy` (default): existing behaviour — pull SOS catalog
 *     JSON from `s3.dualstack.us-east-1.amazonaws.com`, merge with
 *     `/assets/sos_dataset_metadata.json`, point video playback at
 *     `https://video-proxy.zyra-project.org/video/{vimeoId}`.
 *   - `node`: pull the rendered catalog from this deployment's own
 *     `/api/v1/catalog`, follow each dataset's `dataLink`
 *     (`/api/v1/datasets/{id}/manifest`) for video / image
 *     resolution. The wire shape is the same as today's `Dataset`
 *     plus a few additive fields, so call sites that already work
 *     against `Dataset` need no further changes.
 *
 * Defaulting to `legacy` keeps this commit a no-op for the
 * production bundle. Commit I (or a later flip) sets the bundle
 * default to `node` once the catalog backend has been validated
 * end-to-end against a real deployment.
 */

export type CatalogSource = 'legacy' | 'node'

export function getCatalogSource(): CatalogSource {
  const raw = (import.meta.env.VITE_CATALOG_SOURCE as string | undefined) ?? 'legacy'
  return raw === 'node' ? 'node' : 'legacy'
}

/**
 * True when a `dataLink` URL is shaped like one of this node's
 * manifest endpoints. Used by the dataset loader to decide whether
 * to fetch the manifest envelope or treat the link as a direct
 * asset URL (the sample tours' `/assets/test-tour.json` paths, or
 * any legacy URL the SOS source still hands us).
 */
export function isManifestUrl(dataLink: string): boolean {
  return /^\/api\/v\d+\/datasets\/[^/]+\/manifest$/.test(dataLink)
}
