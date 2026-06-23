# Incremental HLS re-encoding for real-time workflows

**Status: draft for review.**

Realizes [`CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md)
§Phase 2 "option B (VOD segment append)", generalized to append + replace +
window-slide, and closes the loop that [`ZYRA_INTEGRATION_PLAN.md`](ZYRA_INTEGRATION_PLAN.md)
§Update model reserved behind `update_mode`.

## Context

Every scheduled Zyra workflow run currently re-encodes the **entire** video from
scratch. For the clouds dataset (P30D window, 10-min cadence ≈ 4,300 frames) that
was ~30 minutes of x264 compute per run — to regenerate a video almost identical to
the previous one. The day-over-day delta is tiny: ~144 new frames at the tail, a
handful of padded→real swaps, and old frames sliding off the front.

Goal: **encode only the parts that changed and recycle the rest.** The current
encoder already makes this tractable — `cli/lib/ffmpeg-hls.ts` `encodeHls()` pins
`-r 30 -g 180 -keyint_min 180 -sc_threshold 0 -hls_time 6`, so **exactly 180 source
frames = one keyframe-led 6-second segment**. Each segment is independently
decodable, so segments can be encoded one chunk at a time and concatenated in a
playlist.

Outcome: ~5–6× less encode compute per run for sliding-window datasets (only the
churning head/tail chunks + any changed interior chunks re-encode; the stable
interior is reused untouched), plus bounded R2 storage via segment GC.

### Resolved decisions

- **Default for all frame-sequence transcodes** — no per-workflow opt-in. The runner
  uses incremental whenever a prior segment manifest exists **and** a chunk grid is
  derivable; otherwise it falls back to the current full-encode path (cold start, or
  a pure-sequence row with no stable ordinal). MP4 sources always take the legacy
  path — no per-frame digests to diff.
- **Include segment GC** — reclaim orphaned segments each run (mark-and-sweep with a
  one-cadence grace window).

### Non-goals

- No change to the SOS encode spec (4096×2048 / 30 fps / H.264 main / 6 s segments /
  3 renditions) or the rendition ladder.
- No change to the `/manifest` resolution, the `transcode-complete` swap, or the
  `data_ref` contract — playback is byte-for-byte the same shape.
- No live-HLS / sliding-window-playlist delivery (`CATALOG_IMAGE_SEQUENCE_PLAN.md`
  option C, rejected). The output stays seekable VOD.
- MP4-source datasets are out of scope (no per-frame digests).

## Why default-on is safe

The transcode runner auto-selects per row: incremental needs a prior
`segment-manifest.json` **and** a derivable chunk grid. First run for any dataset
(no manifest) → a full encode that *writes* the manifest + the content-addressed
segments. Pure-sequence rows without a stable ordinal base → full encode. So
default-on degrades gracefully; nothing breaks when a precondition is missing.

## Core design

### 1. Anchored chunk grid (stable under a sliding window)

Chunk by **absolute frame identity on a fixed grid**, never by relative position in
the current window — relative indexing shifts every chunk when the front drops, which
defeats reuse.

- **Time-series rows** (`start_time` + `period`): frame `i`'s absolute time is
  `start_time + period × i`; its grid step is `s = round((t − EPOCH) / period)`, its
  chunk `floor(s / 180)`. `EPOCH` is frozen once (first run) in the segment manifest,
  so a given real frame keeps the same chunk across runs regardless of where it now
  sits in the window. The runner reads `start_time`/`period` from the dataset row
  (the metadata sidecar PATCHed them this run) and `EPOCH` from the prior manifest.
- **Pure-sequence rows** (no period): anchor to a frozen `chunk_base_name` (grid step
  0's filename); ordinal = cadence steps from the base. No stable base → full encode.

**Partial chunks.** Head/tail chunks usually hold < 180 frames → a shorter segment.
Never assume 6.000 s: read each produced segment's real `#EXTINF` and write it
verbatim, with `#EXT-X-TARGETDURATION = 6`. A chunk containing any padded/synthetic
frame carries a `padded` marker in its descriptor so it re-encodes once the real
frame lands — dovetailing with the `excludeNames` freshening already in
`cli/lib/r2-frames.ts`.

### 2. Content-addressed shared segments

```
videos/{dataset}/segments/sha256/{hex}.ts          # shared, content-addressed
videos/{dataset}/segment-manifest.json             # mutable diff state (grid → hashes, EPOCH)
videos/{dataset}/{upload}/master.m3u8              # per-upload — UNCHANGED contract
videos/{dataset}/{upload}/stream_{0,1,2}/playlist.m3u8
```

- **Segment hash** = `sha256` over a canonical descriptor
  `{ gridIndex, renditionId(height+crf), orderedFrameDigests, padded }`. Frame digests
  come from `source_filenames.json` (validated by `verifySourceFilenamesBlob`). Reuse
  iff the descriptor is unchanged → **x264 byte non-determinism is irrelevant** (we
  match on inputs, not output bytes). Rendition is folded into the hash → a flat
  `segments/sha256/{hex}.ts` space (simplest GC).
- **Playlists use relative URIs** `../../segments/sha256/{hex}.ts` from the per-upload
  variant playlist to the shared store — spec-legal, hls.js/Safari-compatible, no
  hard-coded hostname. The `/manifest` endpoint and `data_ref` swap are untouched: the
  server still resolves `r2:videos/{dataset}/{upload}/master.m3u8` to a public URL and
  knows nothing about sharing.

### 3. Diff + assemble — new `cli/lib/hls-incremental.ts` (pure core)

```
computeChunkGrid(frameManifest, gridParams) -> Chunk[]
segmentDescriptorHash(chunk) -> hex
diffGrids(prevManifest, newGrid) -> { reuse: hex[], encode: Chunk[], orphans: hex[] }
assemblePlaylists(orderedChunks, hashByChunk, extinfByHash) -> { master, stream_N }
```

Runner flow (incremental branch):

1. GET prior `segment-manifest.json` (absent → full-encode fallback).
2. Build the new grid from the verified `source_filenames.json` + grid params.
3. `diffGrids` → reuse / encode / orphan sets.
4. For each **encode** chunk: copy its frames into a temp subdir renumbered `0..N-1`,
   run the per-chunk ffmpeg (§4) → one `.ts` per rendition, read `#EXTINF`, HEAD-gate
   then PUT to `segments/sha256/{hex}.ts` (content-addressed → idempotent).
5. **Reuse** chunks: zero encode, zero upload — the hex already exists.
6. `assemblePlaylists` → write master + variant playlists into the per-upload prefix.
7. PUT the new `segment-manifest.json`.
8. **GC**: list `videos/{dataset}/segments/`, keep `new ∪ prevManifest` hexes (grace
   window for in-flight players on the prior master), delete the rest. Best-effort,
   never fails the run.
9. POST `/transcode-complete` exactly as today.

### 4. Per-chunk ffmpeg

Reuse the `ffmpeg-hls.ts` rendition/codec constants verbatim (`DEFAULT_RENDITIONS`,
CRF, `preset slow`, `profile main`, `yuv420p`, `OUTPUT_FRAME_RATE`). Feed ≤180 frames
→ exactly one keyframe-led segment per rendition. CRF keeps per-frame quality uniform;
the only GOP boundary is the chunk seam, which is **already** a segment boundary in
the monolithic encode — no new seams. Read the produced `#EXTINF` (don't assume 6.0).
`hasAudio=false` (frames are silent).

**Playlist faithfulness (required, learned in production).** Each chunk is encoded
as a standalone HLS output, so two details of ffmpeg's own playlists must be
reproduced or hls.js stalls:

- **`CODECS` in the master.** ffmpeg's master declares
  `CODECS="avc1.4d40xx"` per rendition; hls.js needs it to set up MSE before the
  first segment is probed. The hand-built master parses ffmpeg's emitted
  `master.m3u8` for the exact strings (`parseMasterCodecs`) and persists them in the
  segment manifest so reuse-only runs still emit them. Omitting `CODECS` leaves the
  player unable to reach `canplay` (the first shipped version did this and broke a
  live single-segment dataset).
- **`#EXT-X-DISCONTINUITY` between segments.** Each independently-encoded segment
  restarts its internal PTS at the muxer base (~1.4 s) rather than continuing the
  prior segment's timeline, so a discontinuity tag precedes every segment after the
  first; without it hls.js sees overlapping PTS across segments and stalls. A
  single-segment playlist needs none (the first fragment's PTS offset is handled
  natively — exactly like ffmpeg's monolithic single-segment output).

## Files

**New**

- `cli/lib/hls-incremental.ts` — chunking, descriptor hash, diff, playlist assembly,
  segment/manifest key builders, manifest load/save, GC. All pure logic, unit-tested.

**Modify**

- `cli/transcode-from-dispatch.ts` — for `sourceKind==='frames'`, attempt incremental
  (default); fall back to the existing `encodeHls → uploadHlsBundle` on cold start /
  no grid. Fetch the dataset row for `start_time`/`period`.
- `cli/lib/ffmpeg-hls.ts` — export `encodeChunkSegment()` (or parameterize
  `buildFfmpegArgs`) so one ≤180-frame chunk → one segment per rendition.
- `cli/lib/r2-upload.ts` — add a HEAD-exists check + content-addressed single-object
  PUT (or reuse `uploadR2Object` + HEAD).

**Reuse unchanged**

- `runPool` (bounded concurrency, `cli/lib/r2-frames.ts`), `parseFrameManifest` /
  `verifySourceFilenamesBlob` (frame digests), `listPrefixKeys` (paginated LIST),
  `AwsClient` / `buildObjectUrl` / `deleteR2Object` / `parseListKeys`.
- No `functions/` changes for playback: `/manifest`, `transcode-complete`, the
  `data_ref` swap, and `update_mode` are all untouched (`update_mode` stays a future
  hook for a "force full re-encode" override).

## Implementation order (one effort, staged commits)

1. **Pure core + tests** — `hls-incremental.ts` chunking/diff/assembly + the per-chunk
   `encodeChunkSegment` export. No runner wiring yet. Heavy unit coverage.
2. **Runner incremental path** — branch + dataset fetch + R2 segment store/manifest +
   full-encode fallback. Default-on for frames.
3. **GC** — mark-and-sweep with grace window, wired post-swap.

## Verification

- **Unit** (pure fns): `computeChunkGrid` boundaries (exactly 180, 181, partial tail,
  padded chunk, window-slide front-drop), `segmentDescriptorHash` stability +
  sensitivity, `diffGrids` for append / interior-replace / front-drop, `assemblePlaylists`
  EXTINF + TARGETDURATION + relative-URI correctness, GC orphan selection + grace set.
- **E2E** on a small frame set (e.g. 400 frames = 3 chunks) via a real `ffmpeg`:
  - run 1 (cold) → full encode, manifest written, master plays in hls.js;
  - run 2 append 40 frames → only the tail chunk re-encodes, reused hexes byte-identical,
    durations sum correctly, master plays;
  - run 3 replace a padded frame mid-stream → only that chunk re-encodes;
  - run 4 slide the window (drop oldest chunk) → surviving chunks still match by hash,
    GC deletes exactly the orphaned hexes (minus the grace set).
- **Live check**: run the clouds workflow twice; the second run's transcode job logs
  "reused N / encoded M" with M ≪ N, the dataset still plays, and `/frames` recall is
  unaffected.

## Assumptions / watch-items

- The runner can `GET /api/v1/datasets/{id}` for `start_time`/`period` (it already
  holds API creds and posts `transcode-complete`). If not, extend
  `TranscodeFramesDispatchPayload` with those two fields (small `github-dispatch.ts`
  change).
- Grid correctness depends on the published sequence being contiguous at `period`
  cadence — guaranteed by `pad-missing` (the no-time-gaps invariant we already enforce
  in `ZYRA_INTEGRATION_PLAN.md` §Real-time frame store).
- Per-upload `master.m3u8` / variant playlists (tiny text) still accumulate per run;
  the segment GC handles the large `.ts` bytes. The leftover text files fold into the
  existing stale-upload GC open question (`ZYRA_INTEGRATION_PLAN.md` §Open questions #1).
