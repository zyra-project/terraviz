/**
 * Constants shared between the publisher API (functions/), the
 * GHA runner (cli/), and the publisher portal (src/) for the
 * image-sequence upload pipeline (Phase 3pf).
 *
 * Living under `src/types/` puts the file inside the root
 * tsconfig's `rootDir`, inside functions/tsconfig's
 * `../src/types/...` include, and inside cli/tsconfig's reach
 * (via an explicit include line). It's the only path all three
 * tsconfigs can see — putting the constants under cli/lib/
 * tripped TS6059 "not under rootDir" from the SPA side.
 *
 * Copilot review on PR #117 (discussion_r3263124306) flagged
 * that the prior cross-reference comment wasn't sufficient — the
 * cap was duplicated as three bare literals across
 * `functions/api/v1/_lib/asset-uploads.ts`,
 * `cli/transcode-from-dispatch.ts`, and
 * `src/ui/publisher/components/asset-uploader.ts`, and silent
 * drift was the foreseeable failure mode. This module is the
 * single source of truth.
 */

/**
 * Frame-count cap for an image-sequence upload. Covers ~5.5
 * minutes of 30 fps content or ~1.1 years of hourly timeseries
 * data, while keeping the in-browser SHA-256 hash budget
 * (~10 ms per frame on a typical laptop) and the `POST /asset`
 * response size (~1 KB presigned URL per frame, ~10 MB JSON at
 * the cap) both bounded. See
 * `docs/CATALOG_IMAGE_SEQUENCE_PLAN.md` §Open questions Q4 for
 * the rationale.
 *
 * The `buildFrameKey` helper in `functions/api/v1/_lib/r2-store.ts`
 * hard-bounds at 99 999 via its five-digit index format, so this
 * cap is the binding constraint in practice.
 */
export const MAX_IMAGE_SEQUENCE_FRAMES = 10_000
