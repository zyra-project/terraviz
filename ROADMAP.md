# Roadmap

**Status: draft for review.** This roadmap tracks the work that is
still ahead. It is organised around the two walls named in
[`MISSION.md`](MISSION.md) — the one between public data and the
public, and the one between a publisher and their audience — because
that is the split that now decides what gets built.

**Last reviewed:** 2026-08-26 (rewrite: the previous version tracked
a 2026-era viewer backlog that has since shipped out from under it,
and never adopted the catalog backend, publisher portal or federation
work that has been the bulk of the project's activity since).

**Revisit when any of the following becomes true:**

- Phase 4 federation ships. The near-term section below becomes
  history and [`docs/CATALOG_BACKEND_PLAN.md`](docs/CATALOG_BACKEND_PLAN.md)
  takes over as the sequencing authority.
- The publisher-CLI pilot returns its first external-partner result
  (see *On-ramp discovery* below) — a bad result reorders everything
  under **Wall 2**.
- Any §8 decision in
  [`docs/architecture/federation-scoping.md`](docs/architecture/federation-scoping.md)
  changes, or that doc passes its own "Supersedes when" condition.
- A second SOS-class installation partner arrives, which would pull
  the installation-output work out of *Deferred*.

---

## How to read this

The first wall is close to down: the viewer is built, it runs on the
web, on the desktop, on a headset, and inside someone else's page.
Nearly every numbered item in the previous roadmap was a viewer item,
and nearly every one is now finished. Keeping that list around as a
column of ticked boxes made this document look active while telling
nobody what to do next.

The second wall is where the work is. A publisher can already author
and publish through the portal, but only onto *our* node. The whole
"reach without surrender" promise — your data, your name, your
domain — depends on federation and on the on-ramps that let an
institution join without a platform-engineering team. None of that
was on this roadmap before; the planning for it lives in the
`docs/CATALOG_*` set and in the federation scoping doc, which has
been asking for a roadmap row since May.

Two honest caveats. Dates are absent on purpose: this is a
priority order, not a schedule. And "shipped" below means the code
is on `main` and exercised, not that it is finished — several
entries carry named residuals.

---

## Wall 1 — between the data and the public

Largely down. What remains is reach into contexts the viewer does not
serve yet, not features for contexts it already serves.

### Mobile — ship it, don't just build it

The largest gap between "built" and "reaching anyone". iOS and
Android targets build in CI ([`mobile.yml`](.github/workflows/mobile.yml))
and [`docs/MOBILE_APP_PLAN.md`](docs/MOBILE_APP_PLAN.md) is thorough,
including the on-device Orbit provider work. What does not exist is a
release path: no store listings, no signing pipeline in
[`release.yml`](.github/workflows/release.yml), no `docs/RELEASE_MOBILE.md`.
A build that never reaches a phone reaches nobody. This is the single
highest-leverage unfinished item on the viewer side.

*Residual on the desktop equivalent, for contrast:* desktop has the
full path — signed builds, updater key, `latest.json`, draft release.
Mobile needs the same and has none of it.

### Localization beyond the UI chrome — L2 and L3

L1 and L1.5 shipped: the i18n runtime, the lint gate, RTL-safe CSS,
Weblate inbound, and five locales (`ar`, `en`, `es`, `et`, `kab`).
[`docs/I18N_PLAN.md`](docs/I18N_PLAN.md) gated **L2** (partner
locale overrides) and **L3** (translated dataset metadata) on the
catalog backend — which has since shipped. **They are unblocked and
nobody has picked them up.**

This matters more than a normal i18n phase. A translated interface
wrapped around 600 English dataset titles is a half-open door, and
L3 is the half that is still shut. It is also the first localization
work that is genuinely a *publisher* feature, which puts it on the
seam between both walls.

### Viewer residuals

Small, real, and no longer worth a section each:

| Item | State |
|---|---|
| Date ranges for image datasets | Video datasets infer a display interval from `startTime`/`endTime`; the image path does not surface a range. Worth confirming against the current info panel before scheduling. |
| `extractVimeoId` URL coverage | The old roadmap claimed it "fails on URLs with query parameters" — it does not; `/vimeo\.com\/(\d+)/` handles those. It *does* miss `player.vimeo.com/video/<id>`. Re-verify before fixing; the recorded bug was wrong. |
| Related datasets linkable | **Done** — `wireRelatedLinks()` in `datasetLoader.ts`, with semantic enhancement layered over the lexical list. Carried as open for months after it shipped. |

---

## Wall 2 — between the publisher and the audience

This is the frontier. Everything here is planned in depth somewhere
in `docs/` and absent from every previous version of this file.

### Where it stands

Shipped: the node catalog, the publisher portal (datasets, tours,
workflows, events, blog, analytics, feedback, roles, feature
toggles), the Zyra workflow pipeline, and semantic search. An
institution can author and publish today — onto our node, under our
domain. That is the platform relationship `MISSION.md` explicitly
refuses to settle for.

Not shipped: federation. No handshake, feed or signing routes, no
federation tables, no peer subscription. Phase 4 is the whole of the
second half of the mission and it has not started.

### The on-ramp ladder

[`docs/architecture/federation-scoping.md`](docs/architecture/federation-scoping.md)
§8 resolved how an institution joins, and the answer is a ladder
rather than a single path. Ordered as that doc sequences it:

| Tier | What it is | Status |
|---|---|---|
| **0 — publisher CLI** | Publish to someone else's node, keep your name on your data, run no servers. `terraviz` bin exists in-repo, unpublished. | **Next.** See below. |
| **1 — peer appliance** | Small container, no Cloudflare dependency, well-known doc + feed consumption + read-only catalog API. Committed deliverable per decision 3, not an optional follow-on. | Blocked on Phase 4 wire format. |
| **2/3 — full node** | Fork the Cloudflare implementation, or write your own against the published spec. Zyra ships zero non-Cloudflare adapters. | Tier 2 works today via `docs/SELF_HOSTING.md`; Tier 3 needs the spec published. |

### On-ramp discovery — the next real step

Publishing `@zyra/terraviz-cli` and running one partner pilot.
Decision 4 is explicit that this is **discovery, not delivery**: the
Cloudflare Access service-token flow has never been tried by anyone
outside the project, and if it fails as an onboarding step then
alternative auth (OIDC, magic-link, bearer tokens) becomes a Phase 4
*prerequisite* rather than a later nicety.

Treat the pilot's outcome as an input to Phase 4's design, and do not
schedule Phase 4's auth surface until it returns.

### Phase 4 — federation

Sequenced by the scoping doc's §7 directives, which supersede the
Phase 4 ordering in `CATALOG_BACKEND_PLAN.md` where they disagree.
Two commitments worth restating here because they are easy to defer
into never:

- **STAC alignment ships with the feed, not after it.** The wire
  `Dataset` lands as a STAC Item profile in the same PR as the
  federation feed (decision 5).
- **Public-only at first.** Phase 4 federates `public` and
  `federated` visibility; restricted and private wait for Phase 5
  and are not pulled forward speculatively (decision 9).

### The fork-sustainability gap

Decided, sized, and unbuilt. Every item below is named in the scoping
doc; none of it exists:

| Gap | Form | Why it blocks |
|---|---|---|
| `npm run fork:rename` | Script (S) | Flips package name, binary name, bundle ID in one shot. Without it, rebranding a fork is a grep. |
| `docs/TRADEMARK_POLICY.md` | Doc (P1, leadership) | Decision 8's Mozilla/Firefox model — free code, restrictive trademark — is unenforceable while unwritten. |
| `docs/FORK_CONFIG.md` | Doc | The "what to change in your fork" surface: every hardcoded URL, binding, Access policy. Operators currently find these by grepping. |
| `docs/UPSTREAM_MERGE.md` | Doc | How an operator pulls upstream without losing local config. |
| `SELF_HOSTING.md` split | Doc (M) | Operator (run a node) vs fork contributor (modify and send upstream) are different readers sharing one page. |

---

## Deliberate non-goals

Stated so they stop being re-proposed, and so their absence reads as
a decision rather than an oversight.

- **No Zyra-run directory.** NOAA SOS is the de facto dataset
  directory. Node discovery is deferred at launch — peer-of-peer
  browsing handles the first wave, and if demand emerges a partner
  consortium runs a directory against a published spec. Zyra never
  operates one. (Decision 7.)
- **No non-Cloudflare adapters for full nodes.** The portable
  artifact is the specification, not a compatibility layer we
  maintain. (Decision 3.)
- **Not an analysis suite.** The Analyze panel answers questions
  about the frame on screen. It is not a replacement for the
  systems a publisher already runs — `MISSION.md` says so and it
  should stay true.

---

## Deferred

Real work, correctly not now.

- **Installation-grade multi-output** (LED sphere / operator control
  window). Scoped in depth, motivated by a narrow and concrete set
  of installations. Waiting on a second partner site to justify the
  surface area.
- **Orbit avatar in VR** (VR plan Phase 4). The `OrbitController`
  character exists and works on the standalone page; embedding it in
  the WebXR scene was attempted and abandoned mid-debug. Worth
  re-attempting from the current renderer, not from that branch.
- **Voice Phase 4** (fully on-device). Phases 1 through 3.5 have
  landed, including wake-word and realtime streaming. What remains
  is on-hardware validation, which needs hardware time rather than a
  roadmap slot.

### Installation displays — LED spheres, domes, and projector walls
The people standing in front of a physical Science On a Sphere are the audience this project was named for, and today it cannot drive one. A second window rendering a projection-correct equirectangular view of the same globe the operator is steering would let a museum run the whole exhibit from this app — and the same plumbing serves planetarium domes, edge-blended projector arrays, and a presenter mirroring onto a lecture-hall wall. Design doc: [`docs/MULTI_MONITOR_PLAN.md`](docs/MULTI_MONITOR_PLAN.md) (desktop only; planned, not built).

---

## What shipped

Kept short deliberately. The previous roadmap's failure mode was
letting the completed list crowd out the pending one; the detail
lives in each subsystem's plan doc.

**Viewer** — MapLibre globe with day/night, atmosphere and terrain;
multi-globe layouts; HLS playback with adaptive quality; tours;
playlists; catalog Graph / Map / Timeline views; the Analyze panel
and data-encoded hover values; accessibility and error-handling
passes; log-level gating; the module and test structure the old
"code health" section asked for.

**Reach** — desktop app (Tauri, signed, auto-updating) with offline
dataset downloads; web offline caching; embed mode as a *versioned
public contract* ([`docs/EMBED_URL_GRAMMAR.md`](docs/EMBED_URL_GRAMMAR.md),
grammar v1) with an external WordPress consumer; WebXR VR and AR;
i18n L1/L1.5 across five locales.

**Publishing** — node catalog and backend; publisher portal end to
end; Zyra workflow pipeline; current-events ingestion and review;
blog; privacy-first analytics and feedback review.

Both former "Longer Term" entries — offline support and
embeddability — are among these. They were listed as horizon items
long after they were finished.

---

*The project exists because the inspiration Science on a Sphere
creates shouldn't be limited by where you happen to be standing —
and, increasingly, because the institutions holding that data
shouldn't have to surrender it to be seen. The first half is nearly
built. The second half is what this roadmap is now for.*
