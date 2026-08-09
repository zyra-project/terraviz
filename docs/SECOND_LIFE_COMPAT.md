# Second Life Compatibility — Scoping TerraViz for SL and OpenSimulator

**Status: draft for review.** Scopes whether TerraViz can run in, or
usefully connect to, Second Life — and by extension the
OpenSimulator grids that share its protocol and scripting model.
Answers four separable questions that the phrase "is TerraViz
compatible with Second Life?" collapses into one, and recommends a
sequence. Nothing here is committed work; this is a research
document written to be argued with. Companion to
[`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md) (the contract any
in-world handoff composes against),
[`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md)
(the same "host-side adapter, not a fork" reframing applied to a
different host), and
[`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md) (the
rendering contract that is hardest to port).

**Last reviewed:** 2026-08-09 (initial scoping from Eric's brief: he
spent significant time building content and writing LSL in Second
Life, and asked whether TerraViz could be compatible with the
platform).

**Revisit when any of the following becomes true:**

- **[secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189)
  closes.** WebGL crashing in the viewer's embedded browser is the
  single fact that decides §4 Path C's ceiling and rules out the
  naive port entirely. If WebGL becomes reliable in shared media,
  most of §2 needs rewriting and a genuine embed becomes arguable.
- **SLua leaves beta and the LSL runtime gets a deprecation date.**
  §4 Path A is written against `llHTTPRequest` limits that SLua
  inherits unchanged today. If the HTTP surface itself is
  modernised — streaming, larger response bodies, native JSON — the
  bridge design should be redrawn against the better primitive.
- **Media-on-a-prim support in the mobile app is confirmed either
  way** (§7, open question 1). It is currently unknown, and it
  determines whether an in-world exhibit built on shared media is
  visible to the platform's growth audience or invisible to it.
- **A concrete in-world host is named** — an SL region, an
  OpenSimulator grid, or an institutional partner with land. Several
  recommendations below trade cost against audience, and we are
  guessing at both.
- **Full glTF scene import ships in SL.** Only PBR materials landed
  grid-wide; scene/mesh/animation import is unscheduled. It does not
  change the rendering answer, but it changes how a globe asset gets
  authored and maintained.

**Supersedes when:** an in-world TerraViz presence exists and is
maintained. At that point this doc becomes the record of why the
integration was shaped this way, and the in-world artefact's own
README becomes the active source of truth.

---

## Reframing — four questions wearing one coat

"Can TerraViz be compatible with Second Life?" reads as one
question. It is four, and they have sharply different answers:

1. **Can the TerraViz web app run inside Second Life?** No, not
   today. §2.
2. **Can TerraViz's data be rendered on an in-world globe?** Yes,
   with a caveat about how the frames get there. §3, §4 Path B.
3. **Can in-world objects talk to a TerraViz node?** Yes, cheaply,
   today. §4 Path A.
4. **Can a *live* TerraViz globe exist in an SL-compatible world?**
   Yes — on OpenSimulator. §4 Path D.

The instinct to answer (1) and stop is the trap. (1) is the least
achievable and the least valuable; (3) is the most achievable and,
per hour spent, probably the most valuable. This doc is ordered to
make that inversion visible rather than to flatter the original
framing.

The framing that follows is the same one
[`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md)
arrived at for a different host: **an in-world presence is a
distribution channel, not a runtime.** Nothing here reimplements the
globe, the catalog, or Orbit in LSL. It is an adapter that shows
TerraViz content where an audience already stands, and hands off to
the real app when the visitor wants the real app.

---

## 1. Platform current-state assessment (mid-2026)

Second Life is smaller than its peak and is not dying. The
engineering has moved more since 2023 than in the decade before it.

| Dimension | State as of August 2026 |
|---|---|
| Concurrency | Peak 48,802 (1 Mar 2026); June max 44,931 (7 Jun); daily range 26k–44k |
| Accounts | ~500k monthly active, 70M+ registered |
| Grid size | Net **+334 regions** since January 2026 (+259 private estate, +75 Linden-owned) |
| Scripting | **SLua** (Luau) open beta on the production grid since 2 Dec 2025; runtime selectable per script (LSO2 / Mono / Luau); LSL not deprecated |
| Rendering | glTF 2.0 PBR materials grid-wide; reflection probes, ACES tonemapping, mirrors. Full glTF scene/mesh/animation import **not** shipped |
| Graphics API | Still OpenGL. Vulkan/DX12 discussed as a multi-year problem, unscheduled |
| Voice | WebRTC replaced Vivox grid-wide, May 2026 |
| Mobile | iOS/Android public beta, free to all. No inventory, marketplace, building, HUD attachments, or LLDialog |
| Org | Patch Linden (Eric Nix, ~20 years) departed in a May 2026 reorg; June 2026 brought lower land tier and higher Premium pricing |

### What changed that matters to a returning LSL developer

**SLua is the substantive one.** Luau — Roblox's Lua dialect —
brings tables and real data structures, coroutines, multiple timers,
multiple event handlers in one script, and dynamic event
subscription, at roughly half Mono's memory. Existing LSL knowledge
transfers directly; the ergonomics that made LSL painful are the
part being replaced. A Lua Editor project viewer shipped July 2026.

**What SLua does not change** is the sandbox boundary. The HTTP
limits in §4 Path A are simulator-side, not language-side. A
rewrite in SLua is more pleasant to write and no more capable at the
network edge. Plan against the limits, not the language.

---

## 2. The blocking constraint — WebGL in shared media

TerraViz is WebGL2 end to end. The globe is a MapLibre GL custom
layer drawing an equirectangular sphere
(`src/services/mapRenderer.ts:1434-1435`); video datasets become GL
textures uploaded per frame (`setVideoTexture`,
`src/services/mapRenderer.ts:1485`); the data-encoded value readout
reads texels through a dedicated WebGL2 context and **deliberately
refuses a 2D fallback** (`src/services/glLumaSampler.ts:131-141`);
VR is Three.js. There is no meaningful software path.

Second Life's only mechanism for running a web app in-world is
**Media on a Prim** (shared media), which is CEF via Dullahan,
rendered off-screen.

WebGL in that browser is broken.
[secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189),
filed 28 December 2025 against CEF 139.0.7258.139 and Dullahan
1.24.0.202510081738, reports WebGL content going blank and
unresponsive after a few frames while the viewer itself survives.
The issue is open, unassigned, and carries no milestone.

Note the historical irony: Project Valhalla, which brought CEF to SL
in 2015, was announced with the promise that the new plugin
"renders modern web technologies like HTML5, CSS3, and WebGL."
Off-screen-rendered CEF has never made good on the WebGL half, and
#5189 is the current form of an old gap.

**Even if #5189 were fixed tomorrow**, four structural limits remain:

- **Resolution.** Media textures above 1024×1024 require the texture
  backdrop to be resized, and enlarged views cut off content outside
  the bounds. A 2:1 equirectangular frame is therefore capped at
  about 1024×512 in practice — coarse for a data product whose value
  readout depends on texel precision.
- **Per-viewer rendering.** Shared media renders client-side, per
  avatar. Forty avatars in a region is forty Chromium instances and
  forty concurrent sessions against the node's `/api` — a load
  profile the Cloudflare deployment has never seen and the analytics
  tiering never modelled.
- **One face per call.** `llSetPrimMediaParams` takes a single face;
  multi-face media means repeated calls, and there is no bitwise
  face selection.
- **Whitelist ceiling.** Up to 64 URLs or 1024 characters, whichever
  comes first — workable for a single-origin embed, tight if the app
  reaches across origins for tiles and assets.

**Conclusion:** iframing TerraViz onto a prim is off the table today,
and would be marginal even after the bug closes. Everything below
routes around it rather than waiting on it.

---

## 3. What transfers for free — the equirectangular coincidence

One piece of luck is worth stating plainly because it shapes every
path that follows.

TerraViz datasets are **2:1 equirectangular frames**. The publisher
tooling says so in as many words — "the dataset's data *is* a 2:1
equirectangular image" (`src/ui/publisher/components/asset-uploader.ts:94`,
`src/ui/publisher/components/dataset-form.ts:1662`) — and the globe
renderer maps them with equirectangular UV rather than Mercator
(`src/services/mapRenderer.ts:1434-1435`).

That is exactly the UV layout a UV-sphere wants, in Second Life as
in Three.js. `src/services/photorealEarth.ts:203` already notes the
same alignment for Three.js `SphereGeometry`'s default wrap.

**So the format problem is already solved.** A TerraViz frame is a
correct globe texture in-world with no reprojection, no resampling,
and no new pipeline stage. What remains is purely a *delivery*
question: how does a frame get onto a prim, and how often can it
change? Each path in §4 is a different answer to that one question.

What does **not** transfer is everything downstream of the shader.
Palette swap, contrast stretch, and thresholding are a rebuilt 256×1
LUT (`src/types/color-scale.ts:173`); hover values are
`lumaToValue` over a sampled texel (`:227`). Second Life exposes no
custom GLSL on prims — PBR gives base colour, metallic-roughness,
normal, and emissive, and nothing programmable. **The analysis
surface cannot be ported natively at all.** In-world, TerraViz is a
picture of the data; the measurement stays in the web app. Any path
that pretends otherwise is overselling.

---

## 4. The four paths

| Path | What it delivers | Works today | Cost | Audience reach |
|---|---|---|---|---|
| **A. Script→node API bridge** | Kiosks, tickers, handoff links | Yes | Low | Every viewer |
| **B. Texture-flip globe** | An animated in-world globe | Yes | Low + L$ per frame | Every viewer |
| **C. Shared-media video panel** | A moving globe or data wall, no upload fee | Probably — untested | Medium | Desktop; mobile unknown |
| **D. OpenSimulator dynamic texture** | A genuinely live globe | Yes | Medium + hosting | Small |

### Path A — LSL/SLua → node API bridge

**Recommended first, independent of everything else.**

`llHTTPRequest` is the whole surface, and its limits are the design
constraints:

| Limit | Value |
|---|---|
| Response body | **2,048 bytes default; 16,384 max on Mono** via `HTTP_BODY_MAXLENGTH` (LSO: 4,096) |
| Request body | Up to 32 KB UTF-8, bounded by script memory |
| Throttle | 25 requests / 20 s per object; 1,000 / 20 s per owner |
| Timeout | 60 s, then discarded with status 499 |
| Methods | GET, POST, PUT, DELETE |
| Custom headers | Permitted, ≤4,096 chars combined; setting `Content-Type` this way is a runtime error |

The 16 KB response ceiling is the fact that shapes the design. The
existing public reads are JSON shaped for browsers and the docent —
`/api/v1/featured` returns `{ datasets: [{ id, title,
abstract_snippet, thumbnail_url, categories, position }] }` and will
blow the budget at modest limits. **Do not make in-world scripts
parse that.** Add a narrow companion surface instead:

```
GET /api/v1/lsl/hero    → id|title|iso_time|thumb_url
GET /api/v1/lsl/events  → one pipe-delimited record per line
```

Pipe-delimited lines are trivially parsed by `llParseString2List`
in LSL and by `string.split` in SLua, cost no JSON parser, and fit
the budget with room to spare. The routes are thin projections over
`featured-datasets` and the approved-events store, KV-cached on the
same TTL discipline as their JSON siblings.

What it buys, in order of effort:

- An in-world **"Right now" kiosk** — hovertext plus the hero
  dataset's thumbnail, refreshed on a timer well inside the
  25-per-20s throttle.
- An **events board** off the approved-events tables, which is the
  same content the catalog's events overlay already consumes.
- A **handoff**: `llLoadURL` into
  `https://<node>/?embed=1&dataset=<id>`. The embed grammar is
  already stable and versioned
  ([`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md)), so this needs no
  upstream change at all — it is the one piece of this document that
  is buildable this afternoon.

Path A does not fight the platform anywhere. It is the highest
value per hour by a wide margin.

### Path B — texture-flip globe

Pre-upload equirectangular frames and swap them on a timer with
`llSetLinkPrimitiveParamsFast(PRIM_TEXTURE)`, or pack a grid into
one texture and drive it with `llSetTextureAnim`.

- SL downscales uploads to 1024×1024, so each frame lands at about
  **1024×512** for a 2:1 equirectangular.
- Upload fee is L$10 per texture at time of writing — verify against
  the current schedule, which moved in June 2026. A 30-frame loop is
  roughly L$300, on the order of US$1.20.
- Works on **every viewer, including mobile**, with no browser, no
  WebGL, and client-side texture caching.
- PBR emissive gives a globe that reads well without depending on
  region lighting.

Lost: hover values, palette swap, Analyze, Orbit, and any time
axis longer than the frames you paid to upload. Gained: an exhibit
that works everywhere, forever, with no runtime dependency on the
node being up.

Build-side, this is a `scripts/` exporter over frames the pipeline
already produces — closest in shape to the existing image-sequence
work rather than anything new.

### Path C — shared-media video panel

**Worth a prototype specifically because reasoning cannot settle it.**

hls.js needs Media Source Extensions, not WebGL. A page that is
*only* a full-bleed `<video>` — no MapLibre, no custom layer, no
sampler — plausibly renders in shared media today, on the same CEF
build that crashes on WebGL. On a flat prim that is a data wall; on
a sphere face the equirectangular frame wraps and yields a moving
globe with no WebGL anywhere in the stack.

The honest caveat about scope: **`?embed=1` will not do this.**
Embed mode is purely presentational — it applies body classes and
lets `src/styles/embed.css` hide chrome, and explicitly "nothing is
torn out of the boot path" (`src/utils/embedMode.ts`). A bare-video
surface needs a real boot branch that never constructs MapLibre, not
another CSS flag. That is a small change, but it is a different
*kind* of change than the embed grammar has absorbed so far, and it
deserves its own grammar decision rather than being smuggled in as a
fifth truthy query parameter.

Prototype cost is roughly a day; it settles the ceiling for every
in-world rendering ambition. Do it before committing to B or D at
scale.

### Path D — OpenSimulator dynamic texture

`osSetDynamicTextureURL` displays an external or dynamically
generated image on a prim face — no upload fee, no per-viewer
browser instance. The node serves a rendered equirectangular frame
per timestep and the result is a genuinely live globe.

This is the only path that delivers the thing the original question
was reaching for. The trade is audience: OpenSimulator's stable
release is 0.9.3.0 (November 2024), grids are hyperlinked but
individually small, and the total concurrent population across all
public grids is a fraction of SL's 26k–44k.

It is also, notably, the path most aligned with TerraViz's own
posture. A self-hosted OpenSimulator grid pulling frames from a
self-hosted TerraViz node is the same architecture as
[`SELF_HOSTING.md`](SELF_HOSTING.md) and
[`architecture/federation-scoping.md`](architecture/federation-scoping.md)
describe, wearing a different client.

---

## 5. Non-goals

Stated explicitly so they are not rediscovered as ideas later.

- **Porting the analysis surface.** §3 explains why: no custom
  shaders on prims. Probe, Analyze, transects, contours, and palette
  transforms stay in the web app. In-world links out to them.
- **A custom viewer.** SL's viewer is open source and Firestorm
  proves third-party viewers are viable, but a viewer patched to
  render TerraViz is a product with a userbase of zero and a
  maintenance burden forever.
- **Reimplementing the catalog in LSL.** Path A is a read-only
  projection. In-world objects display TerraViz state; they are not
  a second publishing surface, and nothing in-world writes to the
  catalog.
- **A native in-world Orbit.** Possible in principle, but Orbit
  streams SSE from `/api/chat/completions` and LSL cannot consume
  SSE, on top of the 16 KB response cap. It would need a
  non-streaming, length-capped shim — and per
  [`CONTRIBUTING.md`](../CONTRIBUTING.md) §LLM Integrations, any such
  work must speak through the existing contract and be
  availability-gated with a working fallback. Not in scope here;
  raise it in
  [`LLM_INTEGRATION_OPPORTUNITIES.md`](LLM_INTEGRATION_OPPORTUNITIES.md)
  if it is wanted.

---

## 6. Suggested sequence

Each phase is independently valuable and independently abandonable.

**Phase 0 — settle the unknown.** Build the bare-video page from
Path C and load it on a prim in-world. One day. It answers whether
any live-rendering ambition has a ceiling above "static texture,"
and the answer changes what Phases 2–3 are worth.

**Phase 1 — the bridge (Path A).** Add the compact `/api/v1/lsl/*`
projections plus a reference kiosk script in both LSL and SLua.
Small, useful the day it lands, and it makes every later in-world
artefact cheaper because the data plumbing already exists.

**Phase 2 — the exhibit (Path B).** A frame exporter and an in-world
globe object with a curated loop. This is the artefact an
institution can actually stand next to.

**Phase 3 — live, if warranted (Path D, or C if Phase 0 succeeded).**
Only worth doing against a named host with a named audience.

---

## 7. Open questions

1. **Does the mobile app support shared media?** The public-beta FAQ
   lists inventory, marketplace, building, HUD attachments, and
   LLDialog as unsupported, and does not mention media on a prim in
   either direction. Needs in-world verification. If unsupported,
   Path C reaches only desktop viewers — which weakens it
   considerably, since mobile is the platform's growth story.
2. **Does a sphere prim's default UV wrap match 2:1 equirectangular
   closely enough?** §3's claim is confident for a mesh sphere with
   authored UVs and merely probable for a default prim sphere, whose
   pole behaviour needs checking against a graticule test texture
   before anyone commits to Path B or C.
3. **What is the current texture upload fee?** L$10 is the
   long-standing figure, but SL pricing moved in June 2026 and Path
   B's cost model depends on it.
4. **Is there a named host?** Every recommendation trades cost
   against audience and we are guessing at both. An existing
   education or science presence changes the sequencing more than
   any technical finding here.
5. **What is the per-viewer load profile of shared media against a
   Cloudflare node?** Unmodelled, and it is a real question if an
   event ever puts forty avatars in one region.

---

## 8. Evidence

**Platform state**
- [SLua open beta announcement](https://community.secondlife.com/news/featured-news/announcing-the-slua-open-beta-modern-scripting-comes-to-second-life-r11237/) — Luau, 2 Dec 2025, runtime selection, memory claim
- [Lua Alpha](https://wiki.secondlife.com/wiki/Lua_Alpha) — language feature list
- [SL grid statistics, mid-June 2026](https://danielvoyager.wordpress.com/2026/06/17/second-life-grid-statistics-mid-june-2026-update/) — concurrency, region net growth
- [SL Technology Report, June 2026](http://blog.nalates.net/2026/07/01/second-life-technology-report-june-2026/) and [SL23B engineering team](https://danielvoyager.wordpress.com/2026/06/25/sl23b-meet-the-lindens-second-life-engineering-team/) — OpenGL→Vulkan posture, WebRTC voice, Lua timelines
- [PBR Materials Are Here](https://community.secondlife.com/news/tools-and-technology/pbr-materials-are-here-r3900/) and [GLTF Material Import release notes](https://releasenotes.secondlife.com/viewer/7.0.0.581368.html) — materials shipped, scene import not
- [SL Mobile public beta FAQ](https://lindenlab.freshdesk.com/support/solutions/articles/31000173486-second-life-mobile-public-beta-faq) — unsupported feature list (§7 q1)
- [June 2026 fee changes](https://modemworld.me/2026/06/08/ll-announces-second-life-fee-changes-reductions-increases/) — pricing movement (§7 q3)

**Constraints**
- [secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189) — WebGL crash; CEF 139.0.7258.139, Dullahan 1.24.0.202510081738, filed 28 Dec 2025, open
- [Project Valhalla, 2015](https://modemworld.me/2015/10/08/vallhalla-cef-comes-to-second-life/) — the original CEF/WebGL promise
- [`llSetPrimMediaParams`](https://wiki.secondlife.com/wiki/LlSetPrimMediaParams) — 1024px backdrop behaviour, whitelist ceiling, per-face calls, permission masks
- [`llHTTPRequest`](https://wiki.secondlife.com/wiki/LlHTTPRequest) — body limits, throttles, timeout, header rules
- [`osSetDynamicTextureURL`](http://opensimulator.org/wiki/OsSetDynamicTextureURL) and [OpenSimulator](https://en.wikipedia.org/wiki/OpenSimulator) — dynamic texture, 0.9.3.0, hypergrid

**Repository**
- `src/services/mapRenderer.ts:1434-1435,1485` — equirectangular custom-layer sphere; per-frame video texture
- `src/services/glLumaSampler.ts:131-141` — WebGL2 required, no 2D fallback by design
- `src/types/color-scale.ts:173,227` — `buildColorScaleLut`, `lumaToValue`
- `src/ui/publisher/components/asset-uploader.ts:94`, `components/dataset-form.ts:1662` — the 2:1 equirectangular contract
- `src/services/photorealEarth.ts:203` — the same UV alignment in Three.js
- `src/utils/embedMode.ts` — embed mode is presentational only (§4 Path C)
- `functions/api/v1/featured.ts:1-30` — the JSON shape Path A must not make scripts parse
- `docs/EMBED_URL_GRAMMAR.md` — the stable handoff contract
