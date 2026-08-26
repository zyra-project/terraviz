// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare's published rates, and the arithmetic the cost estimate
 * runs on them.
 *
 * ## This file goes stale and nothing here can stop it
 *
 * Every other fact on `/setup` is imported from a module the setup
 * tool uses, so the page cannot drift from the code. These numbers
 * have no such anchor: they are a third party's prices, and Cloudflare
 * changes them without telling us. `crossCheck` cannot help.
 *
 * So the mitigations are the honest ones rather than the clever ones:
 * every rate lives here in one block, `CHECKED_ON` is rendered on the
 * page beside the estimate, and the page links Cloudflare's own
 * pricing pages, which are authoritative in a way this file is not.
 *
 * Sources, fetched and read on the date below:
 *   https://developers.cloudflare.com/r2/pricing/
 *   https://developers.cloudflare.com/d1/platform/pricing/
 */

/** When a human last read the two pricing pages above. */
export const CHECKED_ON = '2026-08-03'

export const R2_PRICING = {
  /** Free every month, Standard storage only. */
  freeStorageGb: 10,
  freeClassA: 1_000_000,
  freeClassB: 10_000_000,
  /** USD per GB-month beyond the free allowance. */
  storagePerGbMonth: 0.015,
  classAPerMillion: 4.5,
  classBPerMillion: 0.36,
  /** The one that surprises people coming from S3. */
  egressPerGb: 0,
} as const

export const D1_PRICING = {
  /** Workers Free: a hard cap, not an allowance you can exceed. */
  freePlanStorageGb: 5,
  /** Workers Paid: included, then billed. */
  paidIncludedStorageGb: 5,
  paidStoragePerGbMonth: 0.75,
} as const

/**
 * Where the node's *compute* happens, and what it costs.
 *
 * Easy to miss when reading a Cloudflare bill: transcoding a video and
 * running a Zyra data pipeline are not Cloudflare workloads at all.
 * They run on GitHub Actions, fired by `repository_dispatch` from the
 * publisher API — `transcode-hls.yml`, `zyra-run.yml`, and the
 * scheduled `zyra-scheduler` / `import-events` / `analytics-export` /
 * `refresh-video-sources` jobs. Cloudflare never sees that CPU time,
 * which is why none of it appears in the storage numbers above.
 *
 * Quoted from GitHub's billing docs, read on CHECKED_ON:
 *
 *   "GitHub Actions usage is free for self-hosted runners and for
 *    public repositories that use standard GitHub-hosted runners."
 *
 * So a fork kept public gets its transcode compute free. That is a
 * real subsidy and worth saying plainly — but it comes with a
 * condition from GitHub's terms, also quoted rather than paraphrased,
 * because paraphrasing someone else's acceptable-use policy is how
 * you end up misrepresenting it:
 *
 *   "...any other activity unrelated to the production, testing,
 *    deployment, or publication of the software project associated
 *    with the repository where GitHub Actions are used."
 *
 * Publishing a node's own datasets reads as within that. Pointing the
 * runners at unrelated batch work does not.
 */
export const GITHUB_ACTIONS = {
  /** Standard GitHub-hosted runners, public repositories. */
  freeForPublicRepos: true,
  /** Also free, if an operator would rather run their own hardware. */
  freeForSelfHosted: true,
  /** Hard stop per job, whatever the plan. */
  jobLimitDays: 5,
  /** Concurrent standard-runner jobs on a Free account. */
  concurrentJobsFree: 20,
  billingDocs:
    'https://docs.github.com/en/billing/managing-billing-for-your-products/about-billing-for-github-actions',
  limitsDocs: 'https://docs.github.com/en/actions/reference/limits',
  termsDocs:
    'https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features',
} as const

/**
 * A real node's actual usage, used to calibrate the estimate.
 *
 * This is measured, not modelled. It is the project's own public
 * instance, cross-checked three ways: the R2 dashboard reports the
 * stored bytes, the catalog API reports the dataset counts, and a
 * Cloudflare invoice confirms what was billed — 87 GB-month after the
 * 10 GB free allowance, at $0.015, which is $1.31.
 *
 * The first version of this file modelled cost as
 * `duration × MB-per-minute`, with both terms guessed. Measuring the
 * real bucket showed why that was a bad idea: sampled clip durations
 * run from 4 seconds to 8½ minutes (median 60s, mean 118s), and the
 * per-dataset footprint came out at nearly double what the duration
 * model predicted — the HLS ladder is not the only thing stored per
 * video. Two guessed terms multiplied together were never going to
 * land, so the estimate now scales one measured number instead.
 */
export const REFERENCE_NODE = {
  datasets: 178,
  videoDatasets: 126,
  storedGb: 97.1,
  billedGbMonth: 87,
  monthlyUsd: 1.31,
} as const

/**
 * Measured GB per published video dataset, averaged over a real
 * catalog. Covers everything stored for that dataset — every rendition
 * in the ladder, plus thumbnail, legend and tour JSON.
 */
export const GB_PER_VIDEO_DATASET =
  REFERENCE_NODE.storedGb / REFERENCE_NODE.videoDatasets

export interface Estimate {
  /** Total stored, GB. */
  storageGb: number
  /** Covered by R2's free allowance. */
  freeGb: number
  /** Charged for. */
  billableGb: number
  /** USD per month, storage only. */
  monthlyUsd: number
}

/**
 * Storage cost for a catalog of published video datasets.
 *
 * Deliberately storage-only. Operations are the other half of an R2
 * bill, but the reference node's real usage sits at 2% of the free
 * Class A allowance and 4% of Class B, so including them would add
 * noise and a false sense of precision. Its invoice charged $0.00 for
 * every operation line. The page says so rather than implying the
 * number is complete.
 *
 * R2's free allowance applies on both Workers plans — the point the
 * old copy missed by filing storage under "Workers Paid".
 */
export function estimateStorage(videoDatasets: number): Estimate {
  const n = Number.isFinite(videoDatasets) && videoDatasets > 0 ? videoDatasets : 0
  const storageGb = n * GB_PER_VIDEO_DATASET
  return {
    storageGb,
    freeGb: Math.min(storageGb, R2_PRICING.freeStorageGb),
    billableGb: Math.max(0, storageGb - R2_PRICING.freeStorageGb),
    monthlyUsd:
      Math.max(0, storageGb - R2_PRICING.freeStorageGb) * R2_PRICING.storagePerGbMonth,
  }
}

/** How many video datasets fit inside the free allowance. */
export function freeVideoDatasets(): number {
  return Math.floor(R2_PRICING.freeStorageGb / GB_PER_VIDEO_DATASET)
}
