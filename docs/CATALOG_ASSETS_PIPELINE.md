# Catalog Asset & Video Pipeline

How catalog datasets resolve to playable assets — the `data_ref`
scheme, video transcoding, image variants, sphere thumbnails, and
the manifest response that ties them together. Companion to
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md); schema
referenced from
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md).

The catalog stores *references*, not bytes. A `data_ref` value is one
of:

| Scheme | Example | Resolved by `/manifest` to |
|---|---|---|
| `stream:` | `stream:abcdef0123` | Cloudflare Stream HLS URL (signed if non-public) |
| `r2:` | `r2:datasets/01HX.../map.png` | Cloudflare Images variant URL or signed R2 URL |
| `vimeo:` | `vimeo:123456789` | Existing video-proxy.zyra-project.org URL (cutover bridge only) |
| `url:` | `url:https://noaa.example/...` | Pass-through to external URL (legacy NOAA imagery) |
| `peer:` | `peer:01HW.../01HX...` | Federated. Resolves via the peer's `/api/v1/federation/feed/manifest/{id}` |

The reference scheme keeps the catalog row stable while assets move
between backends. A dataset uploaded as a Vimeo link, later
re-encoded into Stream, swaps `data_ref` from `vimeo:...` to
`stream:...` without any client-visible change.

## Video pipeline (Cloudflare Stream)

Stream replaces every Vimeo responsibility we currently rely on:

| Need | Vimeo today | Stream replacement |
|---|---|---|
| Upload | Manual via Vimeo UI | `POST /api/v1/publish/datasets/{id}/asset` returns a Stream direct-upload URL; browser uploads straight to Stream. |
| Transcoding | Vimeo internal | Stream auto-transcodes to HLS + DASH ladder. |
| Playback URL | Vimeo proxy | `https://customer-<id>.cloudflarestream.com/<uid>/manifest/video.m3u8` for public; signed JWT for restricted. |
| ABR bitrate ladder | Vimeo presets | Stream presets (matches our existing 360p/720p/1080p tiers). |
| Captions | Existing `closedCaptionLink` | Stream native VTT track upload, or keep external VTT in R2 (the `caption_ref` column accepts either). |
| Thumbnails | Manual | Stream auto-thumbnail at 0s; publisher can override via UI. |

`hlsService.ts` is unchanged — it still consumes an HLS manifest URL
and an optional MP4 fallback. `datasetLoader.ts` swaps its current
`fetch('https://video-proxy.zyra-project.org/...')` for
`fetch('/api/v1/datasets/{id}/manifest')`. Same JSON shape minus
`dash` (we don't use it) and minus `files[]` for restricted videos
where signed-URL semantics make a long-lived MP4 link a leak.

### Cutover bridge

For Phase 1 a `vimeo:` `data_ref` resolves through the existing
proxy unchanged, so cutover is a one-line frontend change with no
asset re-uploads. Phase 2 ships the publisher-portal upload path
and a backfill job that pulls each Vimeo source into Stream and
flips the `data_ref`.

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

To avoid over-scoping Phase 2:

- **Phase 2 (asset hosting):** ship the manifest shape above, but
  only the H.264 / Rec.709 / no-alpha rendition path. The schema
  fields exist; the renderer changes don't.
- **Phase 4–5 follow-on:** add packed-alpha encoding in the
  upload pipeline, the layer compositor in `mapRenderer.ts`,
  and the HDR path in the globe shader. This is its own piece
  of work — call it "Layered visualisation" — and it should get
  its own short plan rather than ride on this one.

The catalog backend's job is to *not preclude* these capabilities.
Reserving the schema fields, the manifest structure, and the
`data_ref` scheme namespaces in Phase 2 means the renderer work
in Phase 4–5 is purely client-side.

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
