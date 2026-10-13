# Second Life Compatibility — Can TerraViz Work Inside Second Life?

**Status: draft for review.** This document answers whether TerraViz
can run inside — or usefully connect to — Second Life, and the
OpenSimulator virtual worlds that copy its design. Nothing here has
been built or funded. It exists so that whoever picks this up starts
from what we know instead of rediscovering it.

**Who this is for.** Someone who knows the TerraViz codebase but not
Second Life, someone who knows Second Life but not this codebase, or
someone new to both. §0 is a glossary covering both sides; skip it if
you don't need it. Every claim about TerraViz cites a file and line.
Every claim about Second Life cites a public source in §9.

**Last reviewed:** 2026-08-09 (initial scoping from Eric's brief: he
spent significant time building content and writing LSL in Second
Life, and asked whether TerraViz could be compatible with the
platform).

**Revisit when any of the following becomes true:**

- **[secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189)
  closes.** That bug — 3D graphics crashing inside Second Life's
  embedded web browser — is the single fact that rules out the
  obvious approach. If it gets fixed, §3 needs rewriting and putting
  the real app in-world becomes arguable again.
- **SLua leaves beta, or Second Life's networking limits change.**
  Option A in §5 is designed around a 16 KB cap on what an in-world
  script can receive. That cap comes from the servers, not the
  language, so a new language alone changes nothing — but if the
  networking itself is modernised, redesign against the better
  version.
- **Someone confirms whether the Second Life phone app supports
  shared media** (§8, question 1). Unknown today, and it decides
  whether Option C reaches a growing audience or misses it.
- **A real host is named** — a Second Life region, an OpenSimulator
  world, or a partner organisation with land. Several
  recommendations here weigh cost against audience size, and we are
  guessing at both.
- **Second Life ships full 3D model import.** Only materials landed;
  importing whole scenes is unscheduled. It wouldn't change the
  rendering answer, but it would change how an in-world globe gets
  built and maintained.

**Supersedes when:** something TerraViz-related actually exists
in-world and is being maintained. At that point this becomes a record
of why it was built that way, and that project's own README takes
over.

---

## 0. Glossary

Terms used below, from both sides. Skip what you already know.

**Second Life side**

| Term | What it means |
|---|---|
| **Viewer** | The desktop or phone app you use to log in. Linden Lab ships one; third parties ship others (Firestorm is the most popular). |
| **Region** (or sim) | One 256 × 256 metre piece of the world, running on one server. Holds roughly 40–60 avatars before it struggles. |
| **Prim** | A primitive object — a cube, sphere, cylinder. The basic building block. A **mesh** is an imported 3D model used the same way. |
| **Face** | One surface of an object that can carry its own texture. A sphere has one; a cube has six. |
| **LSL** | Linden Scripting Language. The scripting language in-world objects have used since 2003. Event-driven, C-like, quite limited. |
| **SLua** | A newer scripting option based on Luau (the Lua dialect Roblox uses). In open beta since December 2025. LSL still works; you choose per script. |
| **Shared media** (also **media on a prim**, MOAP) | Second Life's feature for showing a live web page on an object's surface. Internally it runs a cut-down copy of Chrome. |
| **CEF** | Chromium Embedded Framework — the "Chrome as a building block" library that powers shared media. |
| **PBR** | Physically Based Rendering. The modern material system Second Life adopted, matching what Blender and similar tools export. Gives you colour, shininess, bumpiness, and glow — but no custom programming. |
| **L$** | Linden dollars, the in-world currency. Roughly L$250 to US$1. Uploading a texture costs L$10. |
| **OpenSimulator** | Open-source server software that speaks Second Life's protocol. You can run your own world on your own hardware, and the same viewers connect to it. |

**TerraViz / web side**

| Term | What it means |
|---|---|
| **WebGL** | The browser feature that lets a web page use the graphics card to draw 3D. TerraViz's globe is entirely built on it. |
| **Shader** | A small program that runs on the graphics card, deciding the colour of every pixel. This is how TerraViz recolours data live. |
| **Texture** | An image wrapped onto a 3D surface. |
| **Equirectangular** | The standard unrolled-world-map rectangle, exactly twice as wide as tall. Longitude runs left to right, latitude top to bottom. This is the shape all TerraViz data frames use. |
| **UV mapping** | The rule for how a flat image wraps onto a 3D shape. A sphere's default UV mapping expects an equirectangular image — which is the coincidence §4 is about. |
| **Data-encoded video** | TerraViz's technique of storing real measurements as brightness values in a video, so the app can read actual numbers back out of a pixel and recolour the data without re-downloading it. |
| **HLS** | The streaming video format TerraViz uses. Played in-browser by a library called hls.js. |

---

## 1. The question is really four questions

"Can TerraViz be compatible with Second Life?" sounds like one
question. It's four, and they have very different answers:

| # | Question | Answer |
|---|---|---|
| 1 | Can the TerraViz web app run inside Second Life? | **No**, not today. §3 |
| 2 | Can TerraViz's data appear on an in-world globe? | **Yes**, with a caveat about how frames get there. §4, §5 Option B |
| 3 | Can in-world objects talk to a TerraViz server? | **Yes**, cheaply, today. §5 Option A |
| 4 | Can a *live* TerraViz globe exist in a Second-Life-style world? | **Yes** — on OpenSimulator. §5 Option D |

The trap is answering (1) and stopping. It's the hardest and the
least useful. Question (3) is the easiest and, per hour of work,
probably the most valuable. This document is ordered to make that
inversion obvious rather than to flatter the original question.

The framing throughout: **an in-world presence is a place to show
TerraViz, not a second copy of it.** Nothing here rebuilds the globe,
the catalog, or Orbit in LSL. It shows TerraViz content where people
already are, and hands off to the real app when someone wants to dig
in. This is the same conclusion
[`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md)
reached about a completely different host.

---

## 2. Second Life today (mid-2026)

Worth stating plainly, because most people's mental image is from
2008: it's smaller than its peak, it is not dying, and the
engineering has moved more since 2023 than in the ten years before.

| | State as of August 2026 |
|---|---|
| **People online at once** | Peaked at 48,802 on 1 March 2026. Typical day runs 26,000–44,000. |
| **Accounts** | About 500,000 people log in monthly; 70 million accounts registered over the platform's life. |
| **World size** | Grew by 334 regions since January 2026. It is expanding, not contracting. |
| **Scripting** | SLua (a modern Lua) in open beta on the live world since December 2025. LSL is not deprecated — you pick per script. |
| **Graphics** | Modern PBR materials everywhere, plus reflections and mirrors. Importing whole 3D scenes is still not supported — only materials. |
| **Under the hood** | Still OpenGL. Moving to a modern graphics API is discussed as a multi-year problem with no date. |
| **Voice** | Replaced with WebRTC across the whole world in May 2026. |
| **Phone app** | Free, on iOS and Android, still in public beta. Missing inventory, marketplace, building, and in-world dialog menus. |
| **Company** | Patch Linden, a ~20-year veteran, left in a May 2026 reorganisation. Pricing changed in June 2026: land got cheaper, Premium got more expensive. |

### What changed that matters if you last looked years ago

**SLua is the big one.** Luau brings proper data structures, multiple
timers, several event handlers in one script, and about half the
memory usage of the old runtime. If you know LSL, it all transfers —
the awkward parts are what's being replaced.

**But SLua doesn't change what scripts can do over the network.** The
limits in §5 Option A come from Second Life's *servers*, not from the
language. A rewrite in SLua is nicer to write and no more capable at
the network edge. Design against the limits, not the language.

---

## 3. Why the app itself can't go in-world

TerraViz draws everything with WebGL — the graphics card. Three
places in the code make this concrete:

- The globe is a custom 3D sphere drawn into the map engine
  (`src/services/mapRenderer.ts:1434-1435`).
- Video datasets are handed to the graphics card as a fresh texture
  every frame (`setVideoTexture`, `src/services/mapRenderer.ts:1485`).
- The hover-value readout inspects individual pixels through a
  dedicated graphics context — and **deliberately refuses to fall
  back** to a slower non-graphics path if one isn't available
  (`src/services/glLumaSampler.ts:131-141`). That refusal is
  intentional: a wrong number is worse than no number.

Second Life's only way to run a web page in-world is **shared media**,
which is that cut-down Chrome painted onto an object's surface.

**WebGL in that browser is broken.** Bug
[secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189),
filed 28 December 2025, reports that WebGL content goes blank and
unresponsive after a few frames while the rest of the viewer keeps
working. It's open, unassigned, and has no target date.

There's some history here. Second Life's move to Chrome-based media
in 2015 was announced with the promise that it would render "HTML5,
CSS3, and WebGL." The WebGL half has never really worked, and #5189
is just the current shape of an old gap. Don't plan around it being
fixed soon.

**Even if it were fixed tomorrow, four limits remain:**

- **Resolution.** Media larger than 1024 × 1024 pixels needs the
  underlying surface resized, and anything beyond the edge gets cut
  off. An equirectangular frame is therefore capped around 1024 × 512
  — coarse for data whose whole point is reading precise values.
- **It runs once per person.** Shared media renders on each viewer's
  own machine. Forty avatars in a region means forty copies of Chrome
  and forty simultaneous connections to your server — a load pattern
  the Cloudflare deployment has never seen.
- **One face per call.** Setting media takes a single surface at a
  time; there's no way to do several at once.
- **Address whitelist.** Capped at 64 addresses or 1024 characters,
  whichever comes first. Fine for a single site, tight if the app
  pulls tiles and assets from several places.

**Conclusion:** putting the real TerraViz on a prim is off the table
today, and would be marginal even after the bug closes. Everything
below routes around it rather than waiting.

---

## 4. The lucky part

One thing works out unexpectedly well, and it shapes everything after
it.

TerraViz stores every dataset as **equirectangular** frames — that
unrolled-world-map rectangle, twice as wide as tall. The publisher
tools say so outright: "the dataset's data *is* a 2:1 equirectangular
image" (`src/ui/publisher/components/asset-uploader.ts:94`,
`src/ui/publisher/components/dataset-form.ts:1662`), and the globe
renderer wraps them that way rather than using a map projection
(`src/services/mapRenderer.ts:1434-1435`).

That is *exactly* the image shape a 3D sphere expects when you wrap a
texture around it — in Second Life just as much as in TerraViz's own
3D code, which notes the same alignment at
`src/services/photorealEarth.ts:203`.

**So there's no conversion work at all.** A TerraViz frame is already
a correct globe texture for an in-world sphere: no reprojection, no
resampling, no new pipeline step. What's left is purely a delivery
question — *how does a frame get onto the object, and how often can
it change?* Each option in §5 is a different answer to that one
question.

### What definitely doesn't come along

Everything that depends on running a program on the graphics card.
Palette switching, contrast stretch, and thresholds all work by
rebuilding a 256-colour lookup table
(`src/types/color-scale.ts:173`); the hover readout converts a pixel's
brightness back into a real measurement (`:227`).

Second Life gives you materials, not programs. You get colour,
shininess, bumpiness, and glow — nothing you can write code into. **So
the measurement features cannot be ported, at all.** In-world,
TerraViz is a *picture* of the data. The measuring stays in the web
app, and in-world objects link out to it. Any plan that implies
otherwise is overselling, and reviewers should push back on it.

---

## 5. The four options

| Option | What you get | Buildable now? | Cost | Who can see it |
|---|---|---|---|---|
| **A. Scripts talk to the server** | Kiosks, signs, event boards, links out | Yes | Low | Everyone |
| **B. Flipbook globe** | An animated in-world globe | Yes | Low + a few dollars | Everyone, phones included |
| **C. Video on a prim** | A moving globe, no WebGL needed | Probably — untested | Medium | Desktop; phones unknown |
| **D. OpenSimulator** | A genuinely live globe | Yes | Medium + hosting | A much smaller audience |

### Option A — in-world scripts talk to a TerraViz server

**Recommended first, regardless of what else happens.**

In-world scripts can make web requests with `llHTTPRequest`. Its
limits are the entire design constraint:

| Limit | Value |
|---|---|
| **Reply size** | **2 KB by default, 16 KB maximum.** This is the one that matters. |
| Request size | Up to 32 KB, bounded by the script's memory |
| Rate | 25 requests per 20 seconds per object; 1,000 per 20 seconds per owner |
| Timeout | 60 seconds, then discarded |
| Methods | GET, POST, PUT, DELETE |
| Custom headers | Allowed, up to 4,096 characters total |

The 16 KB reply cap drives everything. TerraViz's existing public
endpoints return JSON shaped for browsers — `/api/v1/featured` sends
back `{ datasets: [{ id, title, abstract_snippet, thumbnail_url,
categories, position }] }`, which blows the budget at even modest
result counts, and would need a JSON parser written in LSL to read.

**Don't make in-world scripts parse that.** Add a few tiny text
endpoints alongside it instead:

```
GET /api/v1/lsl/hero    → id|title|iso_time|thumb_url
GET /api/v1/lsl/events  → one pipe-separated record per line
```

Pipe-separated lines are one function call to split apart
(`llParseString2List` in LSL, `string.split` in SLua), need no parser,
and leave plenty of headroom. These are thin projections over data the
node already serves, cached the same way as their JSON siblings.

What you can build on it, easiest first:

- **A "Right now" kiosk** — floating text plus the current featured
  dataset's thumbnail, refreshed on a timer well within the rate
  limit.
- **An events board** driven by the approved-events data the catalog
  already uses.
- **A handoff link** — `llLoadURL` opening
  `https://<node>/?embed=1&dataset=<id>` in the visitor's browser. The
  embed URL format is already stable and documented
  ([`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md)), so **this
  particular piece needs no code changes at all.** It's the one thing
  in this document that could ship this afternoon.

Option A doesn't fight the platform anywhere. Best value per hour by a
wide margin.

### Option B — the flipbook globe

Upload a set of equirectangular frames as ordinary textures, then
swap them on a timer — either by changing the texture directly, or by
packing several frames into one image and cycling through them.

- Second Life shrinks uploads to 1024 × 1024, so each frame lands
  around **1024 × 512**.
- Uploading costs L$10 per texture. A 30-frame loop is about L$300 —
  roughly **US$1.20**. (Verify against current pricing; fees moved in
  June 2026.)
- Works in **every viewer, including the phone app**. No browser, no
  WebGL, and viewers cache the textures locally.
- Setting the material to glow slightly makes the globe read well
  regardless of the region's lighting.

**You lose:** hover values, palette switching, the Analyze panel,
Orbit, and any time range longer than the frames you paid to upload.
**You gain:** an exhibit that works everywhere, indefinitely, and
keeps working even if the TerraViz server is down.

On the build side this is an export script over frames the pipeline
already produces — closest in shape to the existing image-sequence
work, not something new.

### Option C — video on a prim

**Worth a one-day prototype, because you can't settle it by reasoning.**

Here's the hunch: streaming video in a browser uses a *different*
browser feature than 3D graphics does. So a page containing nothing
but a full-screen video element — no map engine, no 3D, no pixel
sampling — might well work in shared media on the very same Chrome
build that crashes on WebGL.

If it does: on a flat panel that's a video wall. On a **sphere**, the
equirectangular frame wraps around and you get a moving globe with no
3D programming anywhere in the stack.

**One honest scoping note:** `?embed=1` will not do this. Embed mode
only hides interface chrome using CSS — "nothing is torn out of the
boot path" (`src/utils/embedMode.ts`). A video-only page needs a real
branch in startup that never loads the map engine at all. That's a
small change, but it's a different *kind* of change than the embed
URL format has absorbed so far, so it deserves its own decision rather
than being quietly added as a fifth query parameter.

Roughly a day of work, and it settles the ceiling for every in-world
rendering ambition. **Do this before committing to B or D at scale.**

### Option D — OpenSimulator

OpenSimulator has a function Second Life doesn't:
`osSetDynamicTextureURL` puts an image straight onto an object's
surface from a web address. No upload fee, no per-person browser
instance. Your node serves a fresh equirectangular frame each time
step, and you have a genuinely live globe.

This is the only option that delivers what the original question was
reaching for. The trade is audience: the current release is 0.9.3.0
(November 2024), worlds are individually small, and the total number
of people online across all public OpenSimulator worlds is a fraction
of Second Life's 26,000–44,000.

It's also the option most aligned with how TerraViz already thinks. A
self-hosted OpenSimulator world pulling frames from a self-hosted
TerraViz node is the architecture in
[`SELF_HOSTING.md`](SELF_HOSTING.md) and
[`architecture/federation-scoping.md`](architecture/federation-scoping.md),
wearing a different client.

---

## 6. What we're deliberately not doing

Written down so these don't get re-proposed in six months.

- **Porting the measurement features.** §4 explains why: no custom
  graphics programming on objects. Probe, Analyze, transects,
  contours, and palette controls stay in the web app. In-world objects
  link to them.
- **Building a custom viewer.** Second Life's viewer is open source
  and third-party viewers are common, so this is *possible*. It would
  also be a product with no users and permanent maintenance. No.
- **Rebuilding the catalog in LSL.** Option A is read-only. In-world
  objects display TerraViz state; nothing in-world writes back to the
  catalog.
- **An in-world Orbit chatbot.** Possible in principle, but Orbit
  streams its replies continuously and in-world scripts can't consume
  a stream — on top of the 16 KB reply cap. It would need a
  non-streaming, length-limited adapter, and per
  [`CONTRIBUTING.md`](../CONTRIBUTING.md) §LLM Integrations, any such
  work has to go through the existing contract with a working
  fallback. Out of scope here; raise it in
  [`LLM_INTEGRATION_OPPORTUNITIES.md`](LLM_INTEGRATION_OPPORTUNITIES.md)
  if it's wanted.

---

## 7. Suggested order of work

Each phase stands alone. Any of them can be abandoned without
wasting the others.

**Phase 0 — settle the unknown.** Build the video-only page from
Option C and load it on a prim. One day. It tells you whether any
live-rendering ambition has a ceiling above "static image," and the
answer changes what Phases 2 and 3 are worth.

**Phase 1 — the bridge (Option A).** Add the small `/api/v1/lsl/*`
text endpoints plus an example kiosk script in both LSL and SLua.
Small, useful the day it lands, and it makes everything later cheaper
because the data plumbing already exists.

**Phase 2 — the exhibit (Option B).** A frame exporter and an
in-world globe with a curated loop. This is the thing an institution
can actually stand next to and point at.

**Phase 3 — live, if it's warranted (Option D, or C if Phase 0
worked).** Only worth doing once there's a real host and a real
audience.

---

## 8. Open questions

Listed rather than guessed at. Each needs someone to go and look.

1. **Does the Second Life phone app support shared media?** The beta
   FAQ lists inventory, marketplace, building, and dialog menus as
   unsupported, and doesn't mention shared media either way. **Anyone
   with the app installed can settle this in five minutes.** If it's
   unsupported, Option C reaches only desktop users — which weakens
   it considerably, since the phone app is the growth story.
2. **Does a sphere's default texture wrapping really match our
   frames?** §4 is confident for a properly made mesh sphere and only
   *fairly* confident for a basic prim sphere, whose behaviour at the
   poles needs checking against a grid-lines test image before anyone
   commits to Option B or C.
3. **What does a texture upload cost now?** L$10 is the long-standing
   figure, but pricing moved in June 2026 and Option B's budget
   depends on it.
4. **Is there a real host?** Every recommendation trades cost against
   audience, and we're guessing at both. An existing education or
   science presence would change the ordering more than any technical
   finding here.
5. **What does shared media do to server load?** Unmodelled. It
   becomes a real question the first time an event puts forty avatars
   in one region.

---

## 9. Evidence

**Platform state**
- [SLua open beta announcement](https://community.secondlife.com/news/featured-news/announcing-the-slua-open-beta-modern-scripting-comes-to-second-life-r11237/) — Luau, 2 Dec 2025, runtime selection, memory claim
- [Lua Alpha](https://wiki.secondlife.com/wiki/Lua_Alpha) — language feature list
- [Grid statistics, mid-June 2026](https://danielvoyager.wordpress.com/2026/06/17/second-life-grid-statistics-mid-june-2026-update/) — concurrency, region growth
- [Technology Report, June 2026](http://blog.nalates.net/2026/07/01/second-life-technology-report-june-2026/) and [SL23B engineering team](https://danielvoyager.wordpress.com/2026/06/25/sl23b-meet-the-lindens-second-life-engineering-team/) — graphics API plans, WebRTC voice, Lua timelines
- [PBR Materials Are Here](https://community.secondlife.com/news/tools-and-technology/pbr-materials-are-here-r3900/) and [GLTF Material Import release notes](https://releasenotes.secondlife.com/viewer/7.0.0.581368.html) — materials shipped, scene import not
- [Phone app public beta FAQ](https://lindenlab.freshdesk.com/support/solutions/articles/31000173486-second-life-mobile-public-beta-faq) — unsupported feature list (§8 q1)
- [June 2026 fee changes](https://modemworld.me/2026/06/08/ll-announces-second-life-fee-changes-reductions-increases/) — pricing movement (§8 q3)

**Constraints**
- [secondlife/viewer#5189](https://github.com/secondlife/viewer/issues/5189) — the WebGL crash; CEF 139.0.7258.139, Dullahan 1.24.0, filed 28 Dec 2025, still open
- [Project Valhalla, 2015](https://modemworld.me/2015/10/08/vallhalla-cef-comes-to-second-life/) — the original Chrome-in-Second-Life announcement and its WebGL promise
- [`llSetPrimMediaParams`](https://wiki.secondlife.com/wiki/LlSetPrimMediaParams) — 1024px behaviour, whitelist cap, one-face-per-call, permissions
- [`llHTTPRequest`](https://wiki.secondlife.com/wiki/LlHTTPRequest) — reply and request size limits, rate limits, timeout, header rules
- [`osSetDynamicTextureURL`](http://opensimulator.org/wiki/OsSetDynamicTextureURL) and [OpenSimulator](https://en.wikipedia.org/wiki/OpenSimulator) — dynamic textures, 0.9.3.0, linked worlds

**This repository**
- `src/services/mapRenderer.ts:1434-1435,1485` — the equirectangular globe; per-frame video texture upload
- `src/services/glLumaSampler.ts:131-141` — graphics card required, no fallback by design
- `src/types/color-scale.ts:173,227` — the colour lookup table; brightness-to-measurement conversion
- `src/ui/publisher/components/asset-uploader.ts:94`, `components/dataset-form.ts:1662` — the 2:1 equirectangular contract
- `src/services/photorealEarth.ts:203` — the same sphere-wrapping alignment in TerraViz's own 3D code
- `src/utils/embedMode.ts` — embed mode is CSS-only (§5 Option C)
- `functions/api/v1/featured.ts:1-30` — the JSON shape Option A must not ask scripts to parse
- [`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md) — the stable handoff URL format
