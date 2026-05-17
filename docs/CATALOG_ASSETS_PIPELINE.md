# Catalog Asset & Video Pipeline

How catalog datasets resolve to playable assets — the `data_ref`
scheme, video transcoding, image variants, sphere thumbnails, and
the manifest response that ties them together. Companion to
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md); schema
referenced from
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md).

> **Status: Cloudflare Stream removed.** Earlier drafts of this
> doc named Stream as the video backend. Live testing in Phase 2/3
> exposed Stream's standard-plan 1080p rendition ceiling, which is
> insufficient for the 4K spherical content the SPA renders. Phase 3
> shipped a CLI-driven R2 + ffmpeg migration ([`cli/migrate-r2-hls.ts`](../cli/migrate-r2-hls.ts))
> that's now the canonical pipeline. Sub-phase 3pd takes the same
> pipeline and drives it from the publisher portal instead of the
> operator's CLI. References to `stream:` below are kept for
> historical context; no row in the catalog currently uses it.

The catalog stores *references*, not bytes. A `data_ref` value is one
of:

| Scheme | Example | Resolved by `/manifest` to | Status |
|---|---|---|---|
| `r2:` | `r2:videos/01HX.../01YH.../master.m3u8` or `r2:datasets/01HX.../by-digest/sha256/{hex}/asset.png` | Public R2 URL (signed for restricted visibility) | **Current.** Everything new lands here. |
| `vimeo:` | `vimeo:123456789` | Existing video-proxy.zyra-project.org URL | Legacy. Phase 3's `migrate-r2-hls` converts rows to `r2:` as they're re-encoded. |
| `url:` | `url:https://noaa.example/...` | Pass-through to external URL | Legacy NOAA imagery only. |
| `peer:` | `peer:01HW.../01HX...` | Federated — resolves via the peer's `/api/v1/federation/feed/manifest/{id}` | Phase 4. |
| `stream:` | (none) | (none) | **Deprecated** — never reached production. Kept reserved so an importer parsing old docs doesn't 500 on the prefix. |

The reference scheme keeps the catalog row stable while assets move
between backends. A row first published as `vimeo:` and later
re-encoded to R2 HLS swaps `data_ref` from `vimeo:...` to
`r2:videos/{id}/{upload_id}/master.m3u8` without any client-visible change.

## Video pipeline (R2 + GitHub Actions — current)

The pipeline lives in two halves: the **transcoder** (proven and
operator-driven via `cli/migrate-r2-hls.ts`), and the **trigger**
(3pd's contribution — letting a publisher kick off the same
transcode from the portal instead of running the CLI by hand).

> **Future work — image-sequence input.** The publisher portal
> currently accepts a single MP4 as the video source. Many
> catalog datasets originate as numbered frames (one PNG per
> simulation step / model output / animation frame), and
> ffmpeg accepts image sequences as readily as MP4 files —
> the pipeline change is bounded. Design sketched in
> [`CATALOG_IMAGE_SEQUENCE_PLAN.md`](CATALOG_IMAGE_SEQUENCE_PLAN.md);
> tracking issue
> [zyra-project/terraviz#114](https://github.com/zyra-project/terraviz/issues/114).
> Lands as Phase 3pe; depends on 3pd merging first.

### What ffmpeg actually produces

Three renditions at the 2:1 spherical aspect the SPA's globe
texturing needs:

| Rendition | Size | Bitrate target |
|---|---|---|
| 4K | 4096 × 2048 | ~25 Mbps |
| 1080p | 2160 × 1080 | ~5 Mbps |
| 720p | 1440 × 720 | ~2 Mbps |

H.264 main profile, AAC 192kbps audio, **6-second VOD segments**.
The bundle is laid out under `r2:videos/{dataset_id}/{upload_id}/`:

```
videos/{dataset_id}/{upload_id}/master.m3u8        # the variant playlist consumed by hls.js
videos/{dataset_id}/{upload_id}/4k/index.m3u8      # per-rendition media playlist
videos/{dataset_id}/{upload_id}/4k/seg000.ts ...   # segments
videos/{dataset_id}/{upload_id}/1080p/index.m3u8
videos/{dataset_id}/{upload_id}/1080p/seg000.ts ...
videos/{dataset_id}/{upload_id}/720p/index.m3u8
videos/{dataset_id}/{upload_id}/720p/seg000.ts ...
```

The `{upload_id}` segment is the asset_uploads row ULID — versioning
by upload means a re-upload to an already-published row lands its
new bundle at a fresh prefix without overwriting the bytes a public
client is mid-playback against; `/transcode-complete` swaps
`data_ref` atomically when the new bundle is fully written. The
older bundle continues to serve until the swap (and stays in R2
until a future lifecycle pass cleans it up).

`data_ref` points at `master.m3u8`; the existing `hlsService.ts`
takes it from there and adaptively picks the rendition.

### How a portal upload triggers a transcode

Five hops from publisher click to playable row:

1. **Presigned PUT.** The publisher selects an MP4 in the portal's
   uploader. The form requests
   `POST /api/v1/publish/datasets/{id}/asset` with
   `{ kind: 'data', mime: 'video/mp4', size, content_digest }`.
   The handler validates the shape, mints an R2 presigned PUT URL
   pointing at `uploads/{dataset_id}/{upload_id}/source.mp4`
   (per-upload prefix so a re-upload to a row that's already
   transcoding doesn't overwrite the source bytes the prior
   workflow may still be reading), valid for the kind-specific
   TTL (`R2_PUT_TTL_VIDEO_SECONDS = 2 h` for video sources,
   `R2_PUT_TTL_SECONDS = 15 min` for images and aux assets —
   the 2 h ceiling covers the `MAX_BYTES_DATA = 10 GB` cap on a
   typical residential uplink), and returns
   `{ upload_id, target: 'r2', r2: { method, url, headers, key }, expires_at, mock }`.

2. **Direct upload.** The browser PUTs the MP4 straight to R2 over
   the presigned URL. No proxy through a Worker — that would mean
   streaming the bytes through Cloudflare's 100 MB request-body
   limit, which kills any video larger than a phone clip.

3. **Repository dispatch.** Once the PUT resolves 200, the portal
   POSTs `POST /api/v1/publish/datasets/{id}/asset/{upload_id}/complete`
   (no body). The Worker:

   - Looks up the asset_uploads row and verifies it belongs to
     this dataset.
   - **For video sources:** HEAD-checks that the R2 object
     exists (size + Last-Modified, no body read — the Workers
     128 MB memory cap can't accommodate `arrayBuffer()`-ing a
     multi-GB MP4), then **trusts the publisher's claimed
     SHA-256 digest**. The GHA runner re-hashes the bytes via
     Node's streaming `crypto.createHash` before invoking
     ffmpeg, so a tampered upload still surfaces — as the
     runner's exit-code-2 + stuck `transcoding=1` rather than
     a synchronous 409 here. Same security model the Stream
     path used pre-3pd ("trust the claim until the workflow
     completes").
   - **For non-video uploads:** the Worker recomputes SHA-256
     over the full R2 object (the existing 100 MB image / 1 MB
     caption caps stay comfortable for `arrayBuffer()`) and
     409s on `digest_mismatch`.
   - Stamps the row as `transcoding=1` (a new column added in
     migration 0011) and binds it to the specific upload via
     `active_transcode_upload_id` (added in migration 0012 — the
     overlap-rejection and stale-callback guards in
     `/asset/.../complete` and `/transcode-complete` both key
     off this column). For drafts also clears `data_ref` to
     empty string; for published rows leaves `data_ref` pointing
     at the existing HLS bundle so public playback continues
     uninterrupted while the new bundle transcodes.
   - Calls `POST https://api.github.com/repos/{owner}/{repo}/dispatches`
     with `event_type: 'transcode-hls'` and
     `client_payload: { dataset_id, upload_id, source_key, source_digest }`,
     using a PAT stored as the `GITHUB_DISPATCH_TOKEN`
     Cloudflare secret.

   The repo `git log` stays untouched — `repository_dispatch` is a
   pure event API, no push, no PR, no branch.

4. **GHA runs ffmpeg.** The workflow at
   `.github/workflows/transcode-hls.yml` listens on
   `on: repository_dispatch: types: [transcode-hls]`. It:

   - Checks out the repo (so it can reuse `cli/lib/ffmpeg-hls.ts`
     and `cli/lib/r2-upload.ts`).
   - Installs ffmpeg from the GHA runner's package manager.
   - Reads the source MP4 from R2 using S3-compatible credentials
     (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` as GitHub Actions
     repo secrets).
   - Runs the existing `encodeHls` helper.
   - Uploads the bundle via `uploadHlsBundle` to a per-upload
     prefix: `videos/{dataset_id}/{upload_id}/`. Versioning by
     upload_id keeps a re-upload to an already-published row
     from overwriting bytes a public client is mid-playback
     against; the swap below is atomic.
   - POSTs `/api/v1/publish/datasets/{id}/transcode-complete`
     with `{ upload_id, source_digest }`, authenticated by the
     Cloudflare Access service token
     (`CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` GHA
     secrets, provisioned as a `role=service` publisher). The
     route constructs `data_ref` server-side from the route id
     + upload id, flips it, and clears `transcoding`.

5. **Portal picks up the change.** The detail page polls
   `GET /api/v1/publish/datasets/{id}` every 5 s while
   `transcoding=true`. When the column flips, the polling stops
   and the badge swaps from "Transcoding…" to whatever lifecycle
   the row's at (typically still Draft — the publisher needs to
   click Publish separately).

Whole loop takes 1–10 minutes depending on source length. The
publisher can navigate away during transcoding; the next visit to
the detail page picks up wherever it is.

### Cost model

GHA free tier: 2000 CI-minutes/month for public repos.
Conservative estimate from `migrate-r2-hls.ts` calibration: a 5-min
1080p source encodes in ~3 min on the `ubuntu-22.04` runner. Even
at 50 uploads/month with average 5-min sources that's 150
CI-minutes — well under the free tier ceiling. Workers Paid usage
on the trigger side is negligible (one POST to GitHub per upload).
R2 **storage** dominates the R2 line item — R2 has zero egress
fees, so playback / download traffic doesn't add to the bill.
At 4K @ ~25 Mbps the ladder lands ~250 MB per minute of source,
billed monthly until manually deleted. R2 also charges per-
operation (class A/class B) fees but a small-volume deploy
sits well under the free-operation ceiling.

### Why GitHub Actions and not a Worker

Workers Cron + a queue could theoretically drive ffmpeg via WASM,
but:

- ffmpeg-wasm is a 10×–20× slowdown vs native, which turns a 3-min
  transcode into 30–60 min — past Workers' 30-min execution cap
  on the Unbound model.
- The native ffmpeg binary the CLI already uses is ~80 MB; way
  past the Worker bundle size limit.

GHA gives us a real ffmpeg binary on a 7 GB RAM, 2-core runner,
free for our workload size, and no new infrastructure to manage.
The trade-off is the upload→playable lag, which we surface in the
"Transcoding…" badge.

### Cutover bridge

For Phase 1 a `vimeo:` `data_ref` resolves through the existing
proxy unchanged, so cutover is a one-line frontend change with no
asset re-uploads. Phase 3 ships the CLI-driven `migrate-r2-hls`
backfill that pulls each Vimeo source into R2 HLS and flips the
`data_ref` to `r2:videos/.../master.m3u8`. 3pd takes the same
pipeline and exposes it through the portal so publishers can drive
it themselves on new uploads.

## Beyond 4K, HDR, and transparency

The Vimeo-era catalog standardised on 1080p / Rec.709 / 8-bit / no
alpha. That was a Vimeo limit, not a scientific one. Several SOS
datasets are produced at 8K equirectangular and stepped down for
delivery; HDR-graded climate visualisations exist; and "lay one
data layer on top of another" is something the multi-globe layout
already wants to do but can't without alpha. The new pipeline
should accommodate all three.

### Resolution tiers

| Tier | Path | Notes |
|---|---|---|
| ≤ 1080p | Stream | Default for legacy Vimeo backfill. |
| ≤ 2160p (4K) | Stream | Stream's documented input ceiling for HLS output ladders. |
| 4K → 8K | R2-hosted HLS | Encode out-of-band (CI job or local ffmpeg), upload the segments + manifest to R2, serve through Stream's playback API as an "external" source or directly via R2 + signed URL. The frontend's `hlsService.ts` doesn't care where the manifest came from. |
| > 8K (e.g., 16384×8192 SOS originals) | Tiled imagery, not video | Past ~8K, video codecs stop being the right tool — bandwidth and decode cost dominate. The right answer is GIBS-style tiled raster (XYZ tiles in R2 fronted by `/api/v1/tiles/...`) and let the globe sample the tiles instead of a video texture. Out of scope for Phase 2 but the schema reserves space (`format: 'tiles/raster'`). |

The dataset row stores intrinsic dimensions (`width`, `height`) so
the frontend knows ahead of time which tier to expect and can
choose between video texture and tiled sampler at load time.
`data_ref` distinguishes the two paths: `stream:<uid>` vs.
`r2-hls:<key>` vs. `tiles:<prefix>`.

### Codec matrix

The pipeline emits multiple codec variants per asset and the
manifest endpoint picks the best one the caller can play, the
same way Stream does for HLS bitrate ladders.

| Codec | Profile | Where it shines | Where it fails |
|---|---|---|---|
| **H.264** | High @ L5.1 | Universal baseline; every browser, every Tauri webview. | 8-bit only in practice; no alpha; size-inefficient at 4K+. |
| **H.265 / HEVC** | Main10 | Half the bitrate of H.264 at 4K; supports 10-bit and Rec.2020. Native HDR on Safari and Edge; hardware decode on Apple Silicon, recent Intel/AMD. | Patent-licensed; Chrome-on-desktop only added support recently and inconsistently. |
| **VP9** | Profile 2 | 10-bit, Rec.2020, alpha-channel via WebM. Universal in Chromium. | Safari support spotty; software decode is heavy at 4K. |
| **AV1** | Main 10 | Best compression; 10-bit + HDR + alpha (in AVIF cousin); royalty-free. Stream supports AV1 output. | Hardware decode needs a modern GPU; software decode is brutal on mobile. |

The plan's recommendation: encode H.264 universally as the
fallback, plus H.265 for HDR/10-bit datasets, plus VP9-with-alpha
for transparent datasets. AV1 is opt-in per dataset and primarily
for the high-res tier where its compression matters.

The catalog row carries the *intent* (`color_space`, `has_alpha`,
`hdr_transfer`); the manifest endpoint picks the right rendition
at request time based on `Accept` headers and a small client-side
capability probe.

### Color accuracy (HDR / 10-bit / wide gamut)

Scientific data benefits directly from wider color: a precipitation
anomaly map in Rec.2020 + 10-bit can resolve gradients that
Rec.709 + 8-bit crushes into banding. The constraints:

- **Stream HDR.** Cloudflare Stream supports HDR ingest and emits
  HEVC + AV1 HLS ladders with HDR metadata preserved
  (PQ / HLG transfer functions). Frontend playback works in
  Safari out of the box; Chrome needs the right codec preference
  in the manifest.
- **Browser surface.** A `<video>` element on a properly tagged
  HLS playlist will render HDR on supporting hardware. The
  WebGL2 globe sampling that video as a texture is the awkward
  part — the default sampler returns sRGB-tagged values, which
  loses the wider gamut. The globe shader needs a tone-mapping
  step (linear → display gamut) when the source is HDR.
  `mapRenderer.ts` already has a tone-mapping path for the
  photoreal Earth diffuse layer; the change is to thread an
  `is_hdr` flag from the dataset metadata through to the layer.
- **Authoring.** Publishers need a way to declare "this asset is
  HDR" so the manifest endpoint sets the right tags and the
  frontend takes the HDR code path. That's a publisher-portal
  field (`color_space`, `bit_depth`, `hdr_transfer`) plus a
  validation step that checks the upload's actual codec metadata
  against the declared values.

### Transparent video (alpha layering)

This is the most interesting of the three because it unlocks a
new capability for the globe, not just a fidelity improvement.
Today the multi-globe layout shows N independent data layers in
N adjacent globes. With alpha, a single globe can composite
multiple layers — temperature anomaly over precipitation, sea
surface temperature over ice extent — with proper transparency.

There's no universally supported transparent-video codec on the
web. The plan supports three encodings and the manifest endpoint
picks one per caller:

| Encoding | Pros | Cons |
|---|---|---|
| **VP9 with alpha (WebM)** | Native alpha; great in Chromium. | No Safari, no Tauri webview on Linux. |
| **HEVC with alpha** | Native alpha on Safari (the "transparent video" Apple uses for Memoji etc.). | Apple platforms only. |
| **Packed alpha (RGB+A side-by-side or stacked H.264)** | Universal. Standard H.264 video carrying RGB on top half and alpha on the bottom half (or left/right); a tiny WebGL shader splits them at sample time. | Doubles the video dimensions (a 2K alpha layer is encoded as a 2Kx4K video); decoder cost scales accordingly. |

Recommendation: **packed alpha is the default** because it works
everywhere with a single H.264/H.265 pipeline and only requires a
shader change. VP9-WebM is the optimisation when the caller is
Chromium and the dataset is heavy.

The globe rendering path needs:

- A new layer compositing model in `mapRenderer.ts`. Today a
  dataset is "the" texture for the globe; with alpha, layers are
  ordered, blended, and individually opacity-controllable. This
  is a real change — not invasive, but new.
- A shader variant that takes a packed-alpha video texture and
  splits RGB / A at sample time.
- UI: a layer panel in the dataset info pane that shows the
  current stack and lets the user reorder, hide, or adjust per-
  layer opacity. The Tools popover already has a "view toggles"
  pattern; layer controls slot in next to it.

Schema additions for a transparent dataset:

- `has_alpha = true`
- `alpha_encoding ∈ {'native_vp9', 'native_hevc', 'packed_below', 'packed_right'}`
- For packed encodings, the video's "logical" dimensions
  (`render_width`, `render_height`) are half the encoded
  dimensions on the packed axis. The frontend uses logical
  dimensions for camera framing and packed dimensions for the
  sampler.

### Manifest response, extended

`/api/v1/datasets/{id}/manifest` for video grows from "one URL"
to a small selection structure:

```jsonc
{
  "kind": "video",
  "intrinsic": {
    "width": 4096,
    "height": 2048,
    "color_space": "rec2020-pq",
    "bit_depth": 10,
    "has_alpha": true,
    "alpha_encoding": "packed_below"
  },
  "renditions": [
    { "codec": "av1",  "color": "rec2020-pq", "alpha": "packed_below",
      "url": "...", "type": "application/vnd.apple.mpegurl" },
    { "codec": "hevc", "color": "rec2020-pq", "alpha": "packed_below",
      "url": "...", "type": "application/vnd.apple.mpegurl" },
    { "codec": "h264", "color": "rec709",     "alpha": "packed_below",
      "url": "...", "type": "application/vnd.apple.mpegurl" }
  ],
  "captions": [...],
  "download_url": "..."
}
```

The frontend picks the first rendition whose `(codec, color)`
combination it can play, falls back, and uses the `intrinsic`
block to drive the shader. Packed alpha is uniform across
renditions (the encoding choice is made at upload time, not at
playback) so the shader doesn't have to branch.

### Phasing of these capabilities

To avoid over-scoping Phase 1b (the asset-hosting milestone,
formerly tracked as Phase 2):

- **Phase 1b (asset hosting):** ship the manifest shape above,
  but only the H.264 / Rec.709 / no-alpha rendition path. The
  schema fields exist; the renderer changes don't.
- **Phase 4–5 follow-on:** add packed-alpha encoding in the
  upload pipeline, the layer compositor in `mapRenderer.ts`,
  and the HDR path in the globe shader. This is its own piece
  of work — call it "Layered visualisation" — and it should get
  its own short plan rather than ride on this one.

The catalog backend's job is to *not preclude* these
capabilities. Reserving the schema fields, the manifest
structure, and the `data_ref` scheme namespaces in Phase 1b
means the renderer work in Phase 4–5 is purely client-side.

#### Layer compositor scope: additional, not replacement

When the layer compositor lands in Phase 4–5, it is an
**additional** affordance on the existing multi-globe layout,
not a replacement for it. The two presentations sit alongside
each other:

- **Multiple globes, one layer each** = pattern comparison.
  Showing hurricane Sandy 2012 next to hurricane Helene 2024
  asks the brain to flick between two complete fields and
  compare patterns. The existing 1 / 2 / 4 globe layout
  (`viewportManager.ts`, camera lockstep, panel promotion)
  is exactly the right tool for this and stays unchanged.
- **One globe, multiple layers stacked** = registered overlay.
  Showing temperature anomaly *over* precipitation asks the
  brain to read the relationship at each pixel. This is the
  new affordance the alpha pipeline unlocks.

The two affordances answer different questions; collapsing them
into one (a "replace multi-globe with stacked layers" approach
that some scientific viz tools take) loses the side-by-side
comparison case. Keeping both means the user picks the
presentation that matches their analysis.

Scope contained to `mapRenderer.ts`: each globe slot in the
multi-globe layout grows a layer compositor independently.
`viewportManager.ts` is untouched; per-slot layer controls slot
into the existing Tools popover pattern (per-slot, since each
slot can carry its own stack). The combinatorial space (up to
4 globes × up to 4 layers per globe = 16 simultaneous layers)
is more than analysis ever needs in practice; operator policy
can cap the per-slot layer count lower if it becomes a UX
concern.

## Image datasets (R2 + Cloudflare Images)

Most "image" datasets are huge equirectangular PNGs (4096+ wide).
The current pattern is a manual `_4096`/`_2048`/`_1024` suffix that
the client probes in order. That works but bakes assumptions into
the dataset URL.

The new flow:

1. Publisher uploads a single high-res original to R2 via a presigned
   PUT.
2. The asset-complete handler optionally registers the image with
   Cloudflare Images, which serves resolution variants on demand.
3. `/api/v1/datasets/{id}/manifest` returns a JSON object describing
   the variants:
   ```jsonc
   {
     "kind": "image",
     "variants": [
       { "width": 4096, "url": "..." },
       { "width": 2048, "url": "..." },
       { "width": 1024, "url": "..." }
     ],
     "fallback": "..."
   }
   ```
4. The frontend keeps its existing "try larger first, back off on
   failure" behaviour but reads from `variants` instead of
   string-mangling the URL.

For self-hosted nodes that don't enable Cloudflare Images, the
manifest endpoint can fall back to serving the original from R2 and
omit the variants array; the frontend handles that case by using
the fallback URL.

## Sphere thumbnails (2:1 equirectangular)

A flat thumbnail card is the obvious choice for a 2D browse list,
but a Terraviz dataset is fundamentally spherical — a 16:9 still
flattens away the property that makes it interesting. The plan
ships a second thumbnail variant alongside the flat one: a small
2:1 equirectangular texture that can be wrapped onto a low-cost
mini-globe in the UI.

Use cases this unlocks:

- **Rotating sphere on each browse card.** Hover (or auto-rotate)
  spins a small globe with the dataset's actual texture, so the
  card preview reads as "the dataset," not "a screenshot of a
  globe." Fits the existing `browseUI.ts` card layout with no
  layout change.
- **Network graph of datasets.** A force-directed layout where
  each dataset is a small sphere and edges are shared categories
  / keywords / tours. Acts as a visual table of contents for the
  catalog and works well as a federation explorer ("see how peer
  X's datasets connect to yours").
- **Federated peer overview.** A peer's well-known endpoint
  could surface a "constellation" of its datasets at a glance
  without pulling the full catalog.
- **Tour preview ribbons.** A horizontal strip of mini-globes,
  one per dataset the tour visits, rendered in playback order.
- **Empty-state and loading hero.** A slowly rotating sphere of
  a curated dataset is a much warmer placeholder than a spinner.

### Asset shape

| Property | Value |
|---|---|
| Aspect | 2:1 equirectangular (matches Terraviz's full-globe textures) |
| Default size | 512 × 256 (≈40 KB WebP, ≈100 KB JPEG) |
| Optional larger | 1024 × 512 for hero use, opt-in per dataset |
| Format | WebP primary, JPEG fallback for older webviews |
| Color | sRGB / 8-bit always (HDR is wasted on a thumbnail) |
| No alpha | Even for transparent datasets, the sphere thumbnail composites against the dataset's natural background |

### Generation pipeline

Generated at upload time, never by the publisher manually:

| Source | Method |
|---|---|
| Video dataset | First-frame extract via Stream's thumbnail API at t = duration / 4 (avoids title cards), downscaled to 512×256, WebP+JPEG. |
| Image dataset | Downsample the canonical original through Cloudflare Images to 512×256 with `fit=fill` (the image is already 2:1 in practice for SOS data; assert and warn otherwise). |
| Tour | Sphere-thumb of the tour's first `loadDataset` target, with a small "play" badge composited corner. |
| Tiled raster | Composite the lowest-zoom-level tiles into a single 512×256 image at ingest. |

The asset-complete handler runs the generation as part of the
existing transcode/upload finalization step — no separate publisher
action required. A "regenerate sphere thumbnail" button in the
publisher portal handles the rare case where the auto-pick frame
is unrepresentative (mid-fade, all-black, etc.).

### Storage & serving

Lives at a predictable R2 key alongside the flat thumbnail:

```
datasets/{id}/sphere-thumbnail.webp
datasets/{id}/sphere-thumbnail.jpg
datasets/{id}/sphere-thumbnail-1024.webp   (optional larger)
```

Public-visibility datasets serve through R2's public URL +
Cloudflare cache (long-TTL, immutable filename via content hash on
upload — the row stores the full key). Restricted datasets serve
via a presigned URL from the manifest endpoint, same pattern as
the rest of the asset stack.

### Catalog response

A new field on `Dataset` on the wire:

```jsonc
{
  "thumbnailLink": ".../thumbnail.jpg",          // existing flat
  "sphereThumbnailLink": ".../sphere-thumbnail.webp",
  "sphereThumbnailLinkLarge": null               // present only if generated
}
```

The flat `thumbnailLink` stays the default for any caller that
doesn't ask for the spherical one, so existing federation peers
running an older client see no change.

### Frontend rendering

A `MiniSphere` component lives in `src/ui/miniSphere.ts`, built on
the existing photoreal-Earth factory in
`src/services/photorealEarth.ts` but stripped to:

- One sphere geometry (shared instance across all mini-spheres on
  a page).
- One material per sphere with the equirectangular thumb as a
  texture.
- Optional auto-rotate (`y` axis, slow constant rate).
- Optional pointer-driven rotate while the cursor is over the card.
- No atmosphere, no clouds, no day/night shader, no sun.

Three.js is already lazy-loaded for VR; the same chunk powers
mini-spheres. The chunk is loaded the first time a view that
contains mini-spheres is rendered — browse cards, network graph,
or tour ribbon — and stays warm afterwards.

### Performance budget

Naïve "one WebGL canvas per card" doesn't scale past a few dozen
spheres. The plan's strategy:

- **Browse list (≤ ~30 visible at once):** one shared
  `WebGLRenderer` rendering into a single canvas that overlays
  the card grid via absolute positioning, with per-sphere
  scissor regions. Same renderer, N sub-viewports, vastly fewer
  GPU contexts than N canvases.
- **Network graph (50–500 nodes):** instanced rendering of one
  sphere geometry, with the per-sphere texture either:
  - sampled from a CSS-style "texture atlas" (a single 4Kx4K
    WebP with each dataset's 256x128 thumb tiled in), or
  - a `THREE.DataArrayTexture` of equirectangular tiles indexed
    per instance. The atlas approach is the simpler default.
- **Off-viewport / paused tab:** rAF stops when the tab is
  hidden (the page already does this for the main globe);
  mini-spheres inherit the pause for free.
- **Low-end fallback:** devices without WebGL2, or those that
  fail the existing capability probe, render the flat thumbnail
  unchanged. The component never crashes a browse view.

The overall rule: a hundred mini-spheres should cost less than
the main globe. If they don't, drop to the atlas billboard mode
(pre-render each sphere to a 256x256 canvas once and treat it as
a regular `<img>`) — visually similar at small sizes, almost free
to render in bulk.

### Network-graph view (defer the *design*, enable the *capability*)

The catalog backend's job here is to make the asset cheaply
available; the actual graph view is a separate piece of UI work
worth its own short plan. What the catalog provides:

- The `sphereThumbnailLink` field, populated for every dataset.
- An optional `/api/v1/catalog/graph` endpoint (Phase 4) that
  returns a slim payload — `{ id, sphereThumbnailLink, edges: [...] }`
  with edges derived from shared keywords, categories, and tour
  co-occurrence. Pre-computed on publish, cached in KV. Lets a
  client render a graph without pulling full catalog records for
  every node.
- Federation: a peer's mini-spheres come along for the ride in
  the federated catalog response. A network graph that spans
  peers visualises the federation itself — which is exactly the
  "constellation of nodes" mental model the user asked for.

The graph view's own design (layout algorithm, interaction model,
which edge predicates are exposed as filters) can land later
without re-touching the backend.

## Thumbnails, legends, captions

All small assets land in a single R2 bucket (`terraviz-assets`)
under predictable keys:

- `datasets/{id}/thumbnail.{ext}`
- `datasets/{id}/legend.{ext}`
- `datasets/{id}/caption.vtt`
- `tours/{id}/tour.json`
- `tours/{id}/overlays/{key}`

Public-visibility datasets serve thumbnails through the bucket's
public URL plus Cloudflare cache. Restricted datasets serve through
the `/manifest` endpoint, which issues short-lived presigned URLs.

### Legacy auxiliary-asset migration

The shape above is what the publisher portal writes for new
uploads, but the existing catalog rows imported from NOAA SOS
(Phase 1d) carry thumbnails, legends, and SRT captions as
absolute URLs to NOAA-hosted origins. Phase 3 migrated the
*video* `data_ref` (vimeo → r2:videos/.../master.m3u8); the
auxiliary assets are still served off external origins.

A follow-up backfill — call it **Phase 3b** — is needed before
the catalog is fully self-hosted and `/publish` / `/manifest`
can rely on a single origin per dataset. The shape mirrors
Phase 3:

- A `terraviz migrate-r2-assets` CLI subcommand (or one per
  asset class, depending on whether the auxiliary sources share
  an origin).
- Per-row pipeline: fetch the existing URL → PUT to
  `datasets/{id}/thumbnail.{ext}` (or `legend.{ext}` /
  `caption.vtt`) → PATCH the corresponding metadata column to
  the new R2 URL → emit a `migration_r2_assets` telemetry event.
- Idempotency by checking whether the metadata column already
  points at the R2 public base.
- Rollback subcommand symmetric to `rollback-r2-hls`.
- Decision deferred: whether to convert SRT → VTT inline during
  the captions migration (Stream's native track format is VTT;
  the manifest endpoint already accepts either via
  `caption_ref`), or leave as SRT and let downstream consumers
  convert. Probably worth doing once during the migration so
  every row ends up uniform.

This is intentionally not on the Phase 3 critical path — the
video migration unblocks 4K rendering, the auxiliary-asset
migration unblocks a fully self-hosted `/publish` endpoint and
NOAA-origin retirement. Both are needed before federation
peers can mirror datasets without reaching back to noaa.gov.

## Tour assets

Tour JSON is stored in R2 and referenced by `tours.tour_json_ref`.
The tour creator (see "Publishing tools") writes a draft to a
`drafts/{tour_id}/tour.json` key; publishing copies to the canonical
`tours/{id}/tour.json` and updates the row. Overlay images / audio
referenced by `showImage` / `playAudio` tour tasks live alongside
under `tours/{id}/overlays/`.

## Asset lifecycle

| State | Lives where | Cleaned up by |
|---|---|---|
| Draft (publisher portal) | R2 under `drafts/{publisher}/{id}/...` | Cron purges drafts older than 30 days. |
| Published | R2 under `datasets/{id}/...` or Stream | Lives until retracted. |
| Retracted | R2 path stays; Stream video stays; row marked retracted | After 90-day grace, a cron deletes assets and sets `data_ref` to `null` (catalog row remains as a tombstone for federation). |
| Federated mirror | Not stored locally — only metadata | Naturally expires via `expires_at`; refreshed by sync. |

## Asset integrity & verification

The federation contract is "the signed catalog row tells you what
bytes to expect." Without a way to verify that the bytes you
actually fetched match the bytes the publisher claimed, the
signature only protects metadata — a compromised origin bucket
or a tampering intermediate can swap the asset and the signature
still validates. This section closes that gap.

The threat model has three plausible attackers:

- **Origin operator's bucket compromise.** R2 credentials leak;
  bytes get swapped while the catalog row is unchanged.
- **In-transit substitution.** A misconfigured CDN, a
  man-in-the-middle, or a poisoned cache returns wrong bytes for
  a correct URL.
- **Federation-mirror drift.** A peer fetches our asset to mirror
  it, the mirror's storage is later corrupted (intentionally or
  not), and downstream subscribers fetch the corrupted copy.

The defense is content-addressed storage plus a `content_digest`
claim in the signed catalog row, verified once at the boundary
where bytes enter a cache.

### Content digests

Every dataset row carries a `content_digest` for the canonical
asset, and every rendition in the manifest response carries its
own. The format is multi-hash so the algorithm can be replaced
without a schema migration:

```
content_digest TEXT  -- "sha256:9f86d081884c..."
```

`sha-256` is the only algorithm Phase 1 emits. Verifiers reject
unknown algorithms rather than ignoring the prefix, so a future
upgrade to `sha3-256` or `blake3` is an opt-in per-publisher
decision, not a silent acceptance.

The digest covers the *delivered bytes* — for an HLS rendition
that's the master playlist; for a raw image it's the image file;
for a tour JSON it's the canonicalized JSON (same canonicalization
as the federation signature uses, so the digest is stable across
whitespace differences).

### R2 assets: content-addressed keys

Public R2 assets live at content-addressed paths:

```
datasets/{id}/by-digest/sha256/{hex}/asset.{ext}
datasets/{id}/by-digest/sha256/{hex}/legend.{ext}
```

The `{hex}` is the same value the row's `content_digest` carries.
This makes the path itself a verifiable claim — any consumer can
recompute the hash, compare it to the path component, and refuse
on mismatch.

Two consequences fall out for free:

- **Cache lifetime is forever.** A content-addressed key can never
  point at different bytes, so `Cache-Control: public, max-age=31536000, immutable`
  is correct. Cloudflare's edge cache and the browser cache both
  treat immutable URLs as long-term cacheable; the URL is the
  cache key, and the URL contains the digest.
- **Revisions don't invalidate caches.** When a publisher uploads
  a new version of an asset, the new bytes get a new digest →
  new path. The old path is still valid (it still points at the
  old bytes); the dataset row's `data_ref` and `content_digest`
  swap to the new pair atomically. Federation peers see a new
  digest in the next sync and fetch the new bytes; the old bytes
  age out via lifecycle rules, not invalidation.

Backwards-compatible aliases live alongside for any external
caller still pinned to the old `datasets/{id}/asset.png` shape:
the alias is a 302 to the content-addressed URL. The publisher
portal's upload UI shows both URLs and recommends the addressed
one for any new integration.

### Stream assets: bridging the model

Cloudflare Stream's `uid` is opaque — Stream picks it, and we can't
make it content-addressable at the URL level. The plan still
preserves byte-level integrity by hashing at two ends:

- **Source-of-truth hash.** The publisher's browser hashes the
  uploaded source file before the Stream direct-upload completes
  and POSTs the digest to the asset-complete handler. The handler
  cross-checks against Stream's reported `size` / `duration`
  metadata (sanity, not strict equivalence) and stores the source
  digest on the row as `source_digest`.
- **Rendition digests cached on first serve.** The first time the
  manifest endpoint resolves a Stream playback URL for a given
  rendition, it streams the master playlist through a hasher and
  caches the digest in KV keyed by `(stream_uid, rendition_id)`.
  Subsequent manifest responses include the cached digest. A
  rendition whose digest changes on re-fetch is logged as a Stream
  anomaly and the dataset is flagged for publisher review.

For HDR, packed-alpha, and >4K renditions encoded out-of-Stream
and served from R2, the normal content-addressed flow applies —
those paths are never opaque.

### Manifest response, integrity-extended

Every URL the manifest endpoint returns is paired with a digest:

```jsonc
{
  "kind": "video",
  "intrinsic": { ... },
  "renditions": [
    { "codec": "h264", "url": "...", "content_digest": "sha256:..." },
    { "codec": "hevc", "url": "...", "content_digest": "sha256:..." }
  ],
  "captions": [
    { "lang": "en", "url": "...", "content_digest": "sha256:..." }
  ],
  "thumbnail": { "url": "...", "content_digest": "sha256:..." },
  "sphere_thumbnail": { "url": "...", "content_digest": "sha256:..." },
  "download_url": "...",
  "download_digest": "sha256:..."
}
```

The frontend uses the digest for two things: the Tauri download
manager verifies after a complete download (cheap, the bytes are
already on disk) and the federation mirror flow verifies before
caching (mandatory). The webview playback path does not verify
during playback — per-segment hashing is too expensive in JS and
browsers don't do it natively. Trust there falls back on
TLS + the immutable URL.

### Publisher portal: upload verification

The publisher portal hashes uploads in the browser before sending,
shows the digest in the UI for confirmation, and POSTs the same
digest with the asset-complete request:

```
POST /api/v1/publish/datasets/{id}/asset/complete
{
  "stream_uid": "...",                 // for video uploads
  "r2_key":     "...",                 // for image / VTT / etc.
  "claimed_digest": "sha256:9f86..."
}
```

The handler computes its own digest server-side (R2 supports
`sha256` checksum on PUT; Stream returns the source size for
sanity) and compares. Mismatch returns a 409 with the two values
in the response so the UI can show "your browser computed X, the
server computed Y, please re-upload." The dataset row is not
updated until the digests agree.

This catches the boring case (corrupted upload, partial network
write) at the moment when re-trying is cheap, before any
downstream consumer has cached anything.

### Federation: peers verifying mirrored bytes

A subscriber that pulls our catalog now has, for each dataset:

- A signed row claiming `content_digest = sha256:...`
- A `data_ref` pointing at our R2 (or `peer:` indirection)

Mirror flow:

1. Peer fetches the bytes via the manifest endpoint or directly
   from the content-addressed R2 path.
2. Peer hashes the bytes once.
3. On match: store under the peer's own content-addressed path,
   keyed by the same digest. Subsequent serves are immutable.
4. On mismatch: reject the mirror, emit a `federation_integrity_failure`
   event with `(peer_id, dataset_id, expected_digest, actual_digest)`,
   and surface in the subscriber operator's portal. The mirror is
   not retried automatically — it requires operator review because
   a digest mismatch is either a publisher error worth knowing
   about or a real attack.

Trust is transitive but bounded: the peer trusts the publisher's
signed catalog row; the row claims a digest; the bytes either
hash to that digest or they don't. There's no honor system.

### Limits and non-goals

- **No per-segment HLS verification at playback.** Hashing each
  segment in JS as it arrives would dominate the playback CPU
  budget on mobile. The model is "verify once at cache boundary,
  trust the cache" — the same bargain Subresource Integrity
  makes for static assets.
- **No protection against the publisher uploading wrong bytes
  in the first place.** Integrity says "the bytes match what was
  claimed," not "the claim is correct." Publishing-policy
  controls — draft preview, review queues, the staff-only bulk
  import path — handle the upstream concern.
- **No non-repudiation beyond the catalog signature.** The
  digest is a hash, not a signature on the bytes themselves.
  Anyone with publisher credentials can produce a valid
  `(bytes, digest)` pair. The catalog row's Ed25519 signature
  is what binds them to the publishing node's identity.
- **No retroactive integrity for `vimeo:` or `url:` legacy refs.**
  Legacy `data_ref` schemes have `content_digest = NULL`. The
  manifest response stamps `integrity: "unverified"` on those
  responses so the frontend can decide whether to surface a
  warning. The Phase-2 backfill that pulls Vimeo sources into
  Stream is also where digests get computed for the first time.

## Offline (Tauri) compatibility

`download_manager.rs` already negotiates direct downloads. The
manifest endpoint adds an explicit `download_url` field for video
(an MP4 rendition URL from Stream) and image datasets so the desktop
app gets a single canonical URL per resolution tier. Existing
download flow keeps working; it just reads from a single
`/manifest` JSON instead of two endpoints.

### Federated datasets

For datasets owned by the local node, the existing flow is
unchanged. For datasets the local node mirrored from a peer's
catalog, the same flow still works without modification on the
desktop side: the desktop talks only to its local node, and the
local node handles the byte plumbing. `download_manager.rs`
never speaks to a foreign peer directly.

What that local-node-side plumbing looks like depends on the
operator's per-peer asset policy, stored on `federation_peers` as
`asset_proxy_policy`:

| Value | What the manifest endpoint returns for desktop downloads | Cost / use case |
|---|---|---|
| `metadata_only` | 403 with "this peer's content is not available for offline download from this node" | Zero. Desktop UI surfaces the message. Federation is a discovery layer only. |
| `proxy_lazy` | A signed URL pointing at a local-node proxy endpoint (`/api/v1/peer-proxy/{peer_id}/{dataset_id}/...`) that streams bytes from the peer on demand. | Worker CPU + bandwidth on every desktop download. No local storage cost. Use case: low-traffic federation with bandwidth-aware operators. |
| `proxy_cached` (default) | First request: a signed URL pointing at the local-node proxy endpoint; the proxy verifies `content_digest` while streaming and writes the bytes to local R2. Subsequent requests: a signed URL pointing directly at local R2, skipping the proxy. | Worker CPU + bandwidth on first download per asset, then cheap. Storage cost grows as the cache fills with content desktop users have actually requested. Most institutional deploys want this. |
| `mirror_eager` | A signed URL pointing at local R2 (the federation cron pre-mirrored the bytes during sync). | Maximum storage cost; minimum download latency. Use case: high-traffic mirrors / archival deploys / partner orgs that want their users' downloads to never depend on a peer's uptime. |

The four policies map cleanly onto operator preferences: "discovery
only" → `metadata_only`; "make peer content available, don't
pre-pay storage" → `proxy_lazy`; "make peer content available,
cache popular items naturally" → `proxy_cached`; "be a full
mirror of trusted peers" → `mirror_eager`.

### Integrity inheritance

The desktop never verifies `content_digest` itself for federated
datasets — that verification happens in the local node when bytes
enter its cache, the boundary described in
"Asset integrity & verification" above. The desktop trusts the
local node's signed-URL-bearing manifest response; the local node
trusts the peer's signed catalog row and verifies the bytes
against the claimed digest. A digest mismatch in the local-node
cache layer surfaces as a `federation_integrity_failure` event
before any desktop user ever sees the bytes.

This is the deliberate consequence of routing federated downloads
through the local node: integrity verification happens **once at
the right boundary**, instead of being duplicated in
`download_manager.rs`. The alternative — desktop talks to peer
directly, desktop verifies digest itself — was rejected for
exactly this reason: duplicated verification logic is the kind of
thing a one-line oversight breaks during a security review.

### Worker streaming considerations

Streaming a multi-GB video through a Pages Function bumps into
two real Cloudflare limits:

- **Request-duration ceiling.** Workers (including Pages
  Functions) have a wall-clock limit per invocation. Long
  streams need to handle disconnection-and-resume.
- **CPU-time billing on Workers Paid.** Streaming bytes through a
  Worker counts CPU time for the duration of the stream; this
  is real money on a high-traffic deploy.

Both are addressed by the same pattern:

- `proxy_lazy` and `proxy_cached` use **HTTP range requests**
  end-to-end. The Worker forwards the desktop's `Range` header
  to the peer (or to local R2, once cached), pipes the response,
  and closes the connection. The chunked-download logic already
  in `download_manager.rs` handles range-resume on its side.
- For `proxy_cached`, **once a fully-cached copy exists in local
  R2 and its digest has been verified**, the manifest endpoint
  returns a **direct R2 signed URL** instead of routing through
  the proxy. The Worker sits in the path for the first download
  only; subsequent downloads bypass it entirely. This caps the
  per-asset Worker cost at "one download's worth of streaming"
  no matter how many desktop users eventually pull the dataset.

Streaming-while-caching is the operationally tricky bit: the
proxy must hash bytes as they pass through (to verify the
digest at the cache-write boundary) and must not commit a
partial file to R2 if the upstream stream fails mid-flight. The
implementation pattern is "write to a temporary R2 key, finalize
to the canonical content-addressed key only on successful
digest match." Failed mid-streams leave a temporary key that a
nightly cron purges.

### Peer-proxy endpoint specification

The `/api/v1/peer-proxy/...` route ties this all together. URL
shape and behaviour are:

```
GET /api/v1/peer-proxy/{peer_id}/{dataset_id}/{rendition_id?}
```

Path params:

- **`peer_id`** — ULID of the peer that owns the dataset.
  Validated against `federation_peers`; a peer with
  `status != 'active'` returns `404`.
- **`dataset_id`** — ULID of the dataset. Validated against the
  local `federated_datasets` mirror; an unknown id returns `404`
  even if the peer is known (avoids leaking peer-side existence).
- **`rendition_id`** (optional) — ULID of a specific rendition
  for video datasets. Omit for the default rendition (master HLS
  playlist or the canonical image). Image datasets ignore this.

Query params:

- **`format`** (optional) — `hls` | `mp4` | `image` | `caption` |
  `legend` | `thumbnail`. Defaults to the dataset's primary
  format. Used to disambiguate auxiliary asset requests.
- **`expires_at`** (optional) — UNIX seconds; if present, the
  proxy refuses requests after this time. Used by the manifest
  endpoint to bind a proxy URL to a manifest's TTL.

Headers:

- **`Range`** (optional, supported end-to-end) — forwarded to the
  upstream peer or to local R2. Honored byte-range responses
  (`206 Partial Content`) flow back to the desktop unchanged.
- **`Authorization`** — required. The desktop's local-node
  session credential (Access cookie or, for the Tauri app, the
  same authenticated session it uses for `/api/v1/datasets/`).
  Foreign-peer credentials are not accepted here.

Response:

- **`200 OK`** with the asset bytes (full body) — the common
  steady-state path for a `proxy_cached` cache hit or a
  `mirror_eager` deploy.
- **`206 Partial Content`** with byte-range bytes — when a
  `Range` header is present and the underlying source supports
  it (R2 always does; the peer's response is forwarded
  unchanged).
- **`302 Found`** to a direct R2 signed URL — emitted when the
  asset is fully cached and the operator's policy permits a
  redirect (the cheapest path; the desktop follows the redirect
  on its own). The redirect target's TTL matches the
  `expires_at` query param if present.
- **`403 Forbidden`** with body `{ error: "policy_excluded",
  asset_proxy_policy: "metadata_only" }` — the operator has
  configured this peer as `metadata_only`. The desktop UI
  surfaces the message explaining federation-as-discovery-only
  for this peer.
- **`404 Not Found`** — peer or dataset unknown to this node.
- **`409 Conflict`** with body `{ error: "digest_mismatch",
  expected: "sha256:...", actual: "sha256:..." }` — the bytes
  the peer returned didn't match the locally-stored
  `content_digest`. The download is aborted; the local mirror
  is not written. A `federation_integrity_failure` audit event
  is also emitted (see "Asset integrity & verification" above).
- **`502 Bad Gateway`** — the peer is unreachable or returned
  an error. The desktop retries with backoff; the cache write
  is not committed.
- **`503 Service Unavailable`** with `Retry-After` header —
  rate-limited (the operator's per-peer download budget is
  exhausted). Desktop respects the header.

Caching headers on the proxy response:

- **`200`/`206`** carry `Cache-Control: private, max-age=<ttl>`
  where `<ttl>` is the manifest expiry (5 minutes by default).
- **`302`** carries `Cache-Control: private, max-age=300` so the
  desktop's HTTP cache reuses the redirect for the manifest TTL
  rather than re-asking the proxy on every byte range.
- Public CDN caching is deliberately disabled — the proxy is a
  per-user authenticated path.

Behaviour summary by `asset_proxy_policy`:

| Policy | First request | Subsequent requests |
|---|---|---|
| `metadata_only` | `403` immediately | `403` |
| `proxy_lazy` | `200`/`206`, streamed from peer; nothing cached | `200`/`206`, streamed from peer (every time) |
| `proxy_cached` | `200`/`206`, streamed from peer + verified + cached to local R2 | `302` to a direct R2 URL (cheap) |
| `mirror_eager` | `302` to a direct R2 URL (cron pre-mirrored on sync) | `302` to a direct R2 URL |
