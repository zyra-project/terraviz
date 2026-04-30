/**
 * Build-time switch that controls where `dataService.ts` and
 * `datasetLoader.ts` source their catalog data from.
 *
 *   - `node` (default, post-1d cutover): pull the rendered catalog
 *     from this deployment's own `/api/v1/catalog`, follow each
 *     dataset's `dataLink` (`/api/v1/datasets/{id}/manifest`) for
 *     video / image resolution. The wire shape is the same as the
 *     existing `Dataset` plus a few additive fields, so call sites
 *     that already work against `Dataset` need no further changes.
 *   - `legacy`: existing behaviour — pull SOS catalog JSON from
 *     `s3.dualstack.us-east-1.amazonaws.com`, merge with
 *     `/assets/sos_dataset_metadata.json`, point video playback at
 *     `https://video-proxy.zyra-project.org/video/{vimeoId}`. Kept
 *     behind the explicit flag for the cutover stabilisation
 *     window — operators can roll back to legacy with a single
 *     env-var change while the rest of the cutover commits are
 *     reverted in their own follow-on PR.
 *
 * Pre-1d/G the default was `legacy`. The flip to `node` is
 * reversed by `git revert` of this commit alongside the other two
 * cutover commits (1d/E, 1d/F) — no schema or data changes.
 */

export type CatalogSource = 'legacy' | 'node'

export function getCatalogSource(): CatalogSource {
  const raw = (import.meta.env.VITE_CATALOG_SOURCE as string | undefined) ?? 'node'
  return raw === 'legacy' ? 'legacy' : 'node'
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
