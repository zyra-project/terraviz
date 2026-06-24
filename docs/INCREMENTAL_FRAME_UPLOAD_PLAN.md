# Content-addressed frame uploads (incremental frame store)

**Status: draft for review.**

## Problem

Every scheduled Zyra workflow run that publishes a frame sequence
re-uploads the **entire** window to R2. For the clouds dataset
(P30D window, 10-min cadence ≈ 4,300 frames) that is ~4.7 GB pushed
from the GitHub Actions runner on every run — even though the
day-over-day delta is ~144 new frames at the tail and a handful of
padded→real swaps. The frames are keyed per-upload
(`uploads/{dataset}/{upload}/frames/{index5}.{ext}`), so a fresh
`upload_id` each run means none of the prior run's identical bytes are
reused: the runner re-PUTs everything.

This is the frame-upload analogue of the problem the **incremental
HLS** work already solved for *segments*. The transcode reuses
unchanged segments (content-addressed at
`videos/{dataset}/segments/sha256/{hex}.ts`); the frame **upload** that
feeds it does not.

Goal: **upload only the frames whose bytes changed, reuse the rest** —
~4.7 GB/run → the daily delta (~150 MB).

## Why content-addressing (not server-side copy)

Two shapes were considered:

- **Server-side R2 copy** (keep per-upload keys; the `/complete`
  handler `CopyObject`s unchanged frames from the prior upload). Keeps
  recall + transcode untouched, but copying ~4,300 objects inside one
  Workers invocation blows the subrequest cap (1,000/invocation). A
  non-starter without multi-invocation orchestration.
- **Content-addressed shared store** (this plan). Frames live at
  `videos/{dataset}/frames/sha256/{hex}.{ext}`, shared across uploads.
  The runner HEAD-checks each hash and PUTs only the missing ones —
  the dedupe runs client-side on the runner (no subrequest cap), and
  it mirrors the segment store the repo already ships. Chosen.

## The one consumer-visible change: the recall URL

Today all of a dataset's frames share one prefix, so the public recall
is a single `urlTemplate` with a literal `{index}` token that
consumers substitute (`src/services/downloadService.ts`,
`src/utils/frames.ts`). Content-addressing breaks that invariant:
frame *i* now lives at an arbitrary hash, so no single index→URL
template can exist.

Resolution — lean on the indirection that already exists. The
`/api/v1/datasets/{id}/frames/{index}` redirect endpoint was
explicitly designed as the stable consumer-facing URL whose "redirect
target adapts" to bucket-layout changes. So:

- **Dataset-level `frames.urlTemplate`** becomes the absolute redirect
  form `${base_url}/api/v1/datasets/{id}/frames/{index}`. The SPA's
  `{index}` substitution is **unchanged**; following the URL hits the
  redirect, which 302s to the content-addressed R2 object. No SPA
  change.
- **`GET /frames` (list)** keeps emitting **direct** content-addressed
  R2 URLs per frame (it already loads the manifest, so it has each
  frame's digest). Bulk download stays direct-to-R2, no redirect hop.
- **`GET /frames/{index}` (redirect)** resolves the target from the
  manifest digest → `videos/{dataset}/frames/sha256/{hex}.{ext}`.

`framesDigest` (the manifest SHA-256) still changes on every re-upload,
so consumers that cache the enumeration keep their re-upload signal.
Content-addressed per-frame URLs are now **stable across re-uploads**
(same bytes → same URL), which is strictly better for edge caching.

## Storage layout

```
videos/{dataset}/frames/sha256/{hex}.{ext}     # shared, content-addressed (NEW)
uploads/{dataset}/{upload}/source_filenames.json  # per-upload manifest (UNCHANGED — index→filename→digest)
videos/{dataset}/segments/sha256/{hex}.ts      # HLS segments (unchanged)
videos/{dataset}/{upload}/master.m3u8          # per-upload playlist (unchanged)
```

The `source_filenames.json` manifest stays per-upload and remains the
value of the `frame_source_filenames_ref` column — it is the
index→digest map every reader resolves content-addressed keys through.
No schema migration.

## Touch points

**Server (`functions/`)**
- `_lib/r2-store.ts` — add `buildContentAddressedFrameKey(dataset,
  digest, ext)` + `buildFramesContentPrefix(dataset)` +
  `isContentAddressedFrameKey`. Keep the old `buildFrameKey` until the
  read paths migrate, then retire.
- `publish/datasets/[id]/asset.ts` (`handleImageSequenceInit`) — mint
  presigned PUTs at the content-addressed key (from each frame's
  `digest`) instead of the per-upload index key. The browser portal
  uploads all (it can't HEAD-skip); that's fine for one-off manual
  uploads.
- `_lib/r2-public-url.ts` — add `buildFrameRecallUrl(env, dataset,
  digest, ext)` (content-addressed public URL). Repurpose the
  dataset-level template to the redirect form.
- `_lib/dataset-serializer.ts` — `urlTemplate` →
  `${base_url}/api/v1/datasets/{id}/frames/{index}`.
- `datasets/[id]/frames.ts` — per-frame `url` from the manifest digest.
- `datasets/[id]/frames/[frameIndex].ts` — redirect target from the
  manifest digest.

**Runner / CLI (`cli/`)**
- `lib/frames-publish.ts` — inject an optional `exists(key)` HEAD gate
  (R2 S3); skip the PUT for frames already in R2. PUT only the delta.
- `lib/frames-gc.ts` (NEW) — mark-and-sweep over
  `videos/{dataset}/frames/sha256/`: keep hashes referenced by the
  current + previous manifest (one-run grace window), delete orphans.
  Best-effort; never fails the run. Mirrors `pruneSegments`.
- `zyra-publish-from-dispatch.ts` — build the R2 config, pass the
  `exists` gate + run frame GC after a successful publish.
- `transcode-from-dispatch.ts` — `downloadFrames` resolves each frame
  by `manifest[i].digest` → content-addressed key, not
  `uploads/{upload}/frames/{index}`. Digest verification is unchanged
  (and now tautological-but-cheap; kept as a guard).

**Workflow**
- `.github/workflows/zyra-run.yml` — add the R2 S3 credential trio to
  the "Publish to TerraViz" step (already present on the frame-cache
  steps) so the runner can HEAD-gate + GC.

**SPA** — none. `urlTemplate` stays `{index}`-substitutable;
`framesDigest` unchanged.

## Garbage collection

Shared frames accumulate as the window slides (a frame that drops off
the front is no longer in any manifest). GC after a successful publish:

1. List `videos/{dataset}/frames/sha256/`.
2. Keep = digests in the **current** upload's `source_filenames.json` ∪
   the **previous** upload's. The previous set is read **at publish
   start** (`fetchAdvertisedFrameDigests`), before this run's transcode
   can swap the advertised manifest — so the grace window for in-flight
   readers on the prior bundle is race-proof, not dependent on the
   transcode-vs-GC timing.
3. Delete the rest. Best-effort, logged, never fails the run.

Mirrors `pruneSegments` in `cli/lib/hls-incremental-runner.ts` (same
one-run grace window).

## Safety / migration

- **Transition (self-healing, no fallback code).** On deploy, the
  serializer immediately emits the new recall shape for every row,
  including ones last published under the old per-upload layout. Those
  rows' content-addressed objects don't exist yet, so per-frame
  **recall** (a secondary surface — per-frame download / tooling) 404s
  until the dataset's next publish rewrites it into the
  content-addressed world. For the scheduled real-time datasets this is
  a re-publish within hours, and the **primary video playback is
  unaffected** the whole time: `data_ref` still points at the existing
  HLS bundle, which the manifest endpoint resolves independently of the
  frame store. We accept that brief, self-healing gap rather than carry
  permanent legacy-key fallback code. (A one-time re-publish of the
  handful of live frame datasets closes it immediately if desired.)
- The transcode re-verifies each frame's digest after download, so a
  hash collision or a corrupted object fails the encode loudly rather
  than producing a bad bundle.

## Non-goals

- Changing the **browser portal** upload to HEAD-skip (browsers can't
  read R2 directly; manual uploads are one-off and small).
- Reworking the offline download manager to fetch the `/frames` list
  for direct URLs — it keeps using `urlTemplate` (redirect) for now; a
  later optimization can switch it to direct content-addressed URLs.
- The broader stale-upload prefix GC (`ZYRA_INTEGRATION_PLAN.md` open
  question #1) — this plan GCs only the content-addressed frame store.

## Open decisions (for review)

1. **GC grace window.** One prior upload (matches the segment GC) vs. N.
