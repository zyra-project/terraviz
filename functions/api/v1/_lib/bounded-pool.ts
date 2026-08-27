// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tiny bounded-concurrency helper for parallelizable async work
 * that can't safely fan-out to N at once.
 *
 * Two production sites need it for image-sequence uploads at the
 * 10 000-frame cap:
 *
 *   - `POST /asset` mints one presigned PUT per frame. Each
 *     `presignPut` call is a SigV4 HMAC computation; firing
 *     10 001 in parallel risks blowing the Workers CPU-time
 *     budget on a single invocation (Copilot review on PR #117
 *     discussion_r3263466400).
 *
 *   - `POST .../complete` HEAD-checks every frame's R2 key plus
 *     the source-filenames blob. Cloudflare Workers cap outbound
 *     subrequests at 50 (free) / 1000 (paid) per invocation, so
 *     `Promise.all(allKeys.map(verifyObjectExists))` at the cap
 *     would surface as a `Too many subrequests` 5xx with the
 *     dataset row stranded `transcoding=NULL` and the
 *     asset_uploads row stuck `pending` (Copilot review
 *     discussion_r3263466382).
 *
 * Pattern: first-failure-wins (subsequent workers exit between
 * iterations) mirrors `cli/transcode-from-dispatch.ts`'s
 * `downloadFrames` helper and the SPA's `runBoundedQueue` in
 * `src/ui/publisher/components/asset-uploader.ts`. Three
 * implementations exist because each side has subtly different
 * cancellation / error-aggregation hooks; extracting a single
 * shared helper across the Workers / Node / browser runtimes
 * adds package-boundary complexity that the simple cursor
 * pattern doesn't earn.
 *
 * The worker count is the caller's choice — for HEAD requests
 * against R2 the right number is "well below the subrequest cap
 * after subtracting our other side requests", typically 16. For
 * SigV4 presigns it's "low enough that CPU time stays bounded",
 * also 16 in practice.
 */
export async function runBoundedPool<T>(
  jobs: ReadonlyArray<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  if (concurrency < 1) throw new Error('concurrency must be ≥ 1')
  const results: T[] = new Array(jobs.length)
  let cursor = 0
  let firstError: Error | null = null

  async function worker(): Promise<void> {
    while (firstError === null) {
      const i = cursor++
      if (i >= jobs.length) return
      try {
        results[i] = await jobs[i]()
      } catch (err) {
        if (firstError === null) {
          firstError = err instanceof Error ? err : new Error(String(err))
        }
        return
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  )
  if (firstError) throw firstError
  return results
}

/**
 * Bounded-concurrency cap that keeps the Workers subrequest /
 * CPU budgets healthy at the documented 10 000-frame upper
 * bound (`MAX_IMAGE_SEQUENCE_FRAMES`). 16 is safely below the
 * paid-tier 1000 subrequest cap (we use this for HEADs against
 * R2 + presign computations) while still being parallel enough
 * to avoid serializing the work end-to-end.
 */
export const FRAME_OPERATION_CONCURRENCY = 16
