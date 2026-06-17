# v0.6.0 — Open for Submissions

Terraviz now has a full **publisher portal**: a staff or community publisher can sign in through Cloudflare Access and create, edit, preview, publish, and retract datasets and tours — including in-browser asset uploads with a 4K HLS transcode pipeline, image-sequence ingest, and globe-thumbnail generation — without ever touching the CLI. Around it, the catalog grew three new ways to explore it (**Graph**, **Map**, and **Timeline** views) plus a "Right now" hero, playlists, and zip downloads; real-time datasets gained a **Zyra workflow** automation layer; and the analytics pipeline grew a privileged in-portal dashboard. Behind the scenes, the catalog backend finished its non-global geographic foundation, both Earths picked up physically-based atmospheric scattering, and self-hosting forks became first-class.

## ⚠️ Read this first — opening the desktop app

The desktop downloads remain **technically valid but unsigned for distribution**. The full Apple Developer ID + Windows Authenticode CI wiring shipped back in v0.5.0, but the certificates themselves still aren't provisioned, so the binaries don't yet carry the signatures that suppress the operating-system "untrusted developer" prompts. They are the same artifacts CI smoke-tests on every push — you can open them safely with the one-time bypasses below.

### macOS — "Terraviz is damaged and can't be opened"

This is Gatekeeper rejecting the bundle because it isn't yet notarized — **not** a corrupted download. Pick one:

**Option A — Terminal (most reliable).** Drag `Terraviz.app` from the DMG into `/Applications`, then run:

```bash
xattr -dr com.apple.quarantine /Applications/Terraviz.app
```

Launch normally. This strips the `com.apple.quarantine` extended attribute that downloads pick up; you only need to do it once per download.

**Option B — System Settings (no terminal).** Double-click the app, click **Cancel** on the "damaged" dialog, open **System Settings → Privacy & Security**, scroll to **Security**, click **Open Anyway** next to the Terraviz line, then re-launch and click **Open** on the confirmation dialog.

> **Apple Silicon only.** The macOS DMG is `aarch64-apple-darwin` (M1/M2/M3/M4). Intel Macs aren't supported in this release — open an issue if you need one.

Full walkthrough, including how to verify a notarized build once the certs land: [`docs/MACOS_INSTALL.md`](https://github.com/zyra-project/terraviz/blob/v0.6.0/docs/MACOS_INSTALL.md).

### Windows — "Windows protected your PC"

SmartScreen blocks the unsigned `.msi` / `.exe` on first launch because there's no Authenticode signature. To open it:

1. Click **More info** on the blue SmartScreen dialog.
2. Click **Run anyway** at the bottom.

If your organisation enforces SmartScreen at the policy level, you may need an administrator to right-click the installer, choose **Properties**, and tick **Unblock** at the bottom of the General tab before running it. This is a per-download change.

Linux `.AppImage` and `.deb` builds are unaffected — they have no equivalent OS-level signing check.

---

## Installation

| Platform | Download |
|---|---|
| Windows | `.msi` (recommended) or `.exe` (NSIS) |
| macOS (Apple Silicon) | `.dmg` |
| Linux | `.AppImage` (portable) or `.deb` (Debian/Ubuntu) |

## Auto-Updates

Existing v0.5.0 desktop installations will receive this update automatically on next launch. The auto-updater uses the Tauri updater key (already in CI), which is independent of Apple Developer ID and Windows Authenticode — updates work even on the unsigned builds.

Web users do not need to do anything.

---

## What's in the desktop app vs. the web

A lot of this release's surface area is **authoring and operations**, which lives only on the deployed web node. The desktop app and the web app share 100% of the TypeScript source, but a few of the headline features below are web-only by design:

- **The desktop app is the viewer.** Globe rendering, datasets, Orbit, VR/AR, and offline downloads all ship in the desktop build and benefit from this release's rendering and catalog-exploration work.
- **The publisher portal, Zyra workflows, and the analytics / feedback dashboards are web-only.** They are reached at `/publish/*` on the deployed node, call that node's `/api/v1/publish/*` backend, and authenticate through Cloudflare Access — none of which is reachable from the desktop app's bundled `tauri://localhost` origin. The desktop window also has no address bar and no in-app link to the portal. Publishers and operators do this work in a browser on the node.

Each web-only highlight below is tagged accordingly.

---

## Highlights

### The publisher portal ships ([#111](https://github.com/zyra-project/terraviz/pull/111), [#112](https://github.com/zyra-project/terraviz/pull/112), [#116](https://github.com/zyra-project/terraviz/pull/116)–[#121](https://github.com/zyra-project/terraviz/pull/121), [#127](https://github.com/zyra-project/terraviz/pull/127), [#188](https://github.com/zyra-project/terraviz/pull/188))

> **Web-only.** Reached at `/publish/*` on the deployed node; not part of the desktop app.

The headline of this release. The node catalog backend that landed across v0.5.0 now has a complete authoring surface at `/publish/*`, lazy-loaded behind Cloudflare Access. A publisher signs in through the browser Access flow and gets a real editorial workflow — no `terraviz` CLI required (the CLI keeps working unchanged; the portal is an alternative surface on the same write API).

- **Browse, create, edit, publish, retract** — `/publish/datasets` lists the rows visible to the caller; a full create/edit form covers the recommended metadata (title, slug, format, visibility, organization, SPDX licensing, attribution, DOI, citation, time range, keywords/tags), a live markdown preview pane for the abstract, draft → publish → retract lifecycle, and a hard-delete for never-published drafts ([#177](https://github.com/zyra-project/terraviz/pull/177)).
- **In-browser asset uploads + 4K transcode** — drop an MP4 in the edit form and a GitHub Actions runner re-encodes it against the 4096×2048 / 2160×1080 / 1440×720 spherical HLS ladder, writes the bundle to a versioned R2 path, and flips `data_ref` when it's done. Chunked in-browser SHA-256, presigned PUT to R2, a transcoding badge with 5-second polling, and a per-upload prefix so a re-upload never clobbers the bundle the public manifest is mid-playback against ([#112](https://github.com/zyra-project/terraviz/pull/112)).
- **Image-sequence ingest** — many datasets originate as numbered frames (model dumps, hourly pipelines, rendered animations). The uploader now accepts a stack of PNG/JPEG/WebP frames and stitches them into the same HLS ladder via ffmpeg's image-sequence input, normalised to 30 fps. The frames then become first-class catalog citizens: a `/frames` + `/frames/{index}` API addressable by index or by timestamp, an Orbit `<<LOAD_FRAME:…>>` marker + `load_frame` tool, a time-range search filter, a browse date-scrubber, and `terraviz frames list/get` CLI commands ([#117](https://github.com/zyra-project/terraviz/pull/117)–[#121](https://github.com/zyra-project/terraviz/pull/121)).
- **Draft preview** — a Preview button mints a 15-minute HMAC token and surfaces a `/?preview=<token>&dataset=<id>` link that renders the unpublished draft on a live globe with full playback, so a reviewer can sign off before the row goes public ([#116](https://github.com/zyra-project/terraviz/pull/116)).
- **Admin user administration + two-tier roles** — the role taxonomy is now `admin | publisher | readonly | service`. A new admin-only **Users** tab (`/publish/users`) lets an admin approve/reject pending accounts, suspend/reactivate, and change roles, with guardrails against self-lockout and demoting the last active admin. Closes the gap where a new publisher could only be approved by hand-editing D1 ([#188](https://github.com/zyra-project/terraviz/pull/188)).

### Publisher tour creator ([#127](https://github.com/zyra-project/terraviz/pull/127), [#134](https://github.com/zyra-project/terraviz/pull/134), [#136](https://github.com/zyra-project/terraviz/pull/136))

> **Web-only** (authoring). The tours themselves play back everywhere, including in the desktop app.

The `/publish/tours` placeholder is now a working authoring flow. A publisher clicks **New tour**, lands on the SPA in tour-authoring mode, and captures camera positions, dataset loads, layout switches, environment toggles, rotation, and flow control through a floating dock — 18 capture types in all. Tasks reorder by drag-and-drop, edit via an inline JSON escape hatch, and the draft autosaves to R2. A **Preview** button plays the in-memory draft from the start; **Publish** snapshots it to an immutable key. Tours also gained a public discovery endpoint so published tours surface in browse, plus a retract gesture ([#136](https://github.com/zyra-project/terraviz/pull/136)).

### Globe thumbnails + geography controls ([#207](https://github.com/zyra-project/terraviz/pull/207), [#208](https://github.com/zyra-project/terraviz/pull/208), [#209](https://github.com/zyra-project/terraviz/pull/209))

> **Web-only.** Part of the publisher dataset form.

Three additions round out the dataset form:

- **In-browser thumbnail generator** — renders a 2:1 equirectangular data frame onto a sphere (lazy Three.js, no server round-trip) and captures a square globe thumbnail for `thumbnail_ref`. Defaults to the dataset's existing imagery, with an in-browser video frame-grab for video sources; transparent thumbnails blend into card and info surfaces ([#208](https://github.com/zyra-project/terraviz/pull/208)).
- **Thumbnail + legend upload** — both images can also be uploaded directly and preview inline in the table, edit form, and read-only detail page ([#207](https://github.com/zyra-project/terraviz/pull/207)).
- **Geography & projection controls** — a Geography card with per-corner bounding-box entry, inline validation, and a projection expectation note for non-global datasets ([#209](https://github.com/zyra-project/terraviz/pull/209)).

### New ways to explore the catalog ([#131](https://github.com/zyra-project/terraviz/pull/131), [#135](https://github.com/zyra-project/terraviz/pull/135), [#137](https://github.com/zyra-project/terraviz/pull/137), [#138](https://github.com/zyra-project/terraviz/pull/138), [#142](https://github.com/zyra-project/terraviz/pull/142))

The catalog landing surface grew from a single list into a Catalog ↔ Sphere segmented experience with three pure-transform views, all driven by a shared filter engine:

- **Chip-rail filter + predicate engine** — a faceted chip rail backed by a shared `datasetFilter` predicate, with filter state round-tripped through the URL and prefix search ([#135](https://github.com/zyra-project/terraviz/pull/135)).
- **Graph view** — a cytoscape.js facet/keyword co-occurrence graph over the filtered catalog (§6.7, [#137](https://github.com/zyra-project/terraviz/pull/137)).
- **Timeline view** — one row per dataset on a shared time axis, rendered as SVG (§6.8, [#138](https://github.com/zyra-project/terraviz/pull/138)).
- **Map view** — one bbox overlay per dataset on a flat MapLibre world map, surfacing geographic coverage (§6.9, [#142](https://github.com/zyra-project/terraviz/pull/142)).

Authoritative plan: [`docs/WEB_CATALOG_FEATURES_PLAN.md`](https://github.com/zyra-project/terraviz/blob/v0.6.0/docs/WEB_CATALOG_FEATURES_PLAN.md) ([#122](https://github.com/zyra-project/terraviz/pull/122)).

### "Right now" hero, playlists, visit memory, zip downloads ([#145](https://github.com/zyra-project/terraviz/pull/145), [#146](https://github.com/zyra-project/terraviz/pull/146), [#150](https://github.com/zyra-project/terraviz/pull/150), [#166](https://github.com/zyra-project/terraviz/pull/166), [#167](https://github.com/zyra-project/terraviz/pull/167))

- **"Right now" hero panel** — picks a single timely hero candidate for the catalog landing surface (§9.1), with a privileged admin override at `/publish/featured-hero` to pin a specific dataset ([#166](https://github.com/zyra-project/terraviz/pull/166), [#167](https://github.com/zyra-project/terraviz/pull/167)).
- **Playlists** — user-curated dataset sequences with CRUD, an "Add to playlist" popover from browse cards and the info panel, and an active-playlist playback state machine (§8.1, [#145](https://github.com/zyra-project/terraviz/pull/145)).
- **Continue exploring** — a local-only (localStorage) log of which datasets you've opened, surfaced as a "Continue exploring" rail (§9.2, [#150](https://github.com/zyra-project/terraviz/pull/150)).
- **Per-dataset zip downloads** — a web-only "package a dataset as a `.zip`" entry point (§8.2, [#146](https://github.com/zyra-project/terraviz/pull/146)).

### Zyra workflows — automation for real-time datasets ([#175](https://github.com/zyra-project/terraviz/pull/175), [#176](https://github.com/zyra-project/terraviz/pull/176), [#178](https://github.com/zyra-project/terraviz/pull/178), [#179](https://github.com/zyra-project/terraviz/pull/179))

> **Web-only.** Authored and run from `/publish/workflows` on the deployed node.

A new workflow layer lets publishers keep live datasets fresh on a schedule. Phase Z1 shipped the stage/command-allowlisted workflow contract + a runner; Z2 added the portal UI (`/publish/workflows` list, detail with run history and **Run now**, a YAML→JSON editor with server-side validation); Z3 added guided authoring with curated templates and live run-status polling; Z4 added period-driven freshness and frame-gap backfill templates so an hourly series can self-heal. Full design: [`docs/ZYRA_INTEGRATION_PLAN.md`](https://github.com/zyra-project/terraviz/blob/v0.6.0/docs/ZYRA_INTEGRATION_PLAN.md).

### Analytics storage & in-portal admin dashboard ([#180](https://github.com/zyra-project/terraviz/pull/180)–[#187](https://github.com/zyra-project/terraviz/pull/187))

> **Web-only** (operator dashboards). The desktop app still *emits* telemetry under the same two-tier consent model.

The privacy-first telemetry pipeline grew a durable storage tier and moved its operator surface into the portal:

- **Export pipeline + backfill** — a Phase A export job rolls Workers Analytics Engine data into D1, with a manual backfill workflow for historical fills ([#180](https://github.com/zyra-project/terraviz/pull/180), [#181](https://github.com/zyra-project/terraviz/pull/181)).
- **`/publish/analytics` dashboard** — a privileged in-portal dashboard over the D1 rollups, including a MapLibre spatial-attention heatmap, error breakdowns, configurable date ranges, idle-aware view-time, and true funnels — no charting library, hand-rolled SVG (Phase B, [#182](https://github.com/zyra-project/terraviz/pull/182), [#184](https://github.com/zyra-project/terraviz/pull/184)).
- **`/publish/feedback` review tab** — privileged review of Orbit thumbs + bug/feature reports over the D1 feedback tables, retiring the standalone feedback-admin HTML dashboard (Phase C, [#183](https://github.com/zyra-project/terraviz/pull/183)).
- **Grafana demoted to optional** — with the in-portal dashboard live, the Grafana stack is now an optional extra rather than the primary surface (Phase D, [#186](https://github.com/zyra-project/terraviz/pull/186)); Phase E rounded out event coverage and dashboard accuracy ([#187](https://github.com/zyra-project/terraviz/pull/187)).

### Non-global geographic foundation + atmospheric scattering ([#105](https://github.com/zyra-project/terraviz/pull/105)–[#110](https://github.com/zyra-project/terraviz/pull/110), [#107](https://github.com/zyra-project/terraviz/pull/107))

- **Regional datasets render on their real footprint** — the catalog backend's non-global metadata foundation (typed bounding boxes + non-Earth body fields) now drives the renderer: a dataset that only covers a region projects onto its actual geographic bbox instead of being stretched across the whole sphere, with matching VR / Three.js parity and gating for non-Earth bodies ([#106](https://github.com/zyra-project/terraviz/pull/106), [#108](https://github.com/zyra-project/terraviz/pull/108), [#110](https://github.com/zyra-project/terraviz/pull/110)). Tour JSON also completed its migration from NOAA hosting to R2 ([#105](https://github.com/zyra-project/terraviz/pull/105)).
- **Physically-based atmosphere** — Rayleigh + Mie + ozone scattering now lights both Earths (the 2D MapLibre globe and the VR / Orbit photoreal Earth), with quality Tiers 0–3 and a shared transmittance LUT ([#107](https://github.com/zyra-project/terraviz/pull/107)).

### Display tuning ([#143](https://github.com/zyra-project/terraviz/pull/143), [#144](https://github.com/zyra-project/terraviz/pull/144))

- **UI scale** — a `--ui-scale` token with a Tools-menu radio so the whole overlay UI can scale up or down (§7.1, [#143](https://github.com/zyra-project/terraviz/pull/143)).
- **Globe shader controls** — runtime contrast / saturation / specular / normals uniforms with a dev-only shader-tuner floating panel (§7.2, [#144](https://github.com/zyra-project/terraviz/pull/144)).

### Self-hosting becomes first-class ([#149](https://github.com/zyra-project/terraviz/pull/149), [#151](https://github.com/zyra-project/terraviz/pull/151), [#168](https://github.com/zyra-project/terraviz/pull/168), [#169](https://github.com/zyra-project/terraviz/pull/169), [#173](https://github.com/zyra-project/terraviz/pull/173))

Forking Terraviz to run your own instance is now a documented, supported path. A self-hosting review verified node independence and corrected [`docs/SELF_HOSTING.md`](https://github.com/zyra-project/terraviz/blob/v0.6.0/docs/SELF_HOSTING.md) ([#149](https://github.com/zyra-project/terraviz/pull/149)), which was then restructured into a step-by-step Cloudflare walkthrough with the D1 migration bug fixed ([#151](https://github.com/zyra-project/terraviz/pull/151)). Fork hostname handling (deploy URL + source-of-truth/share host) became generic ([#173](https://github.com/zyra-project/terraviz/pull/173)), and CI can now auto-apply D1 migrations on deploy — opt-in and guarded additive-only against `CATALOG_DB` ([#168](https://github.com/zyra-project/terraviz/pull/168), [#169](https://github.com/zyra-project/terraviz/pull/169)).

---

## Other developer-facing infrastructure

- **Visual testing & reporting tool** — the Weblate translator-screenshot pipeline was generalised into a full Playwright-driven visual-dev & CI tool ([#195](https://github.com/zyra-project/terraviz/pull/195)): `screenshots:report` captures every scene × viewport into a self-contained HTML gallery with per-scene problem badges, `screenshots:diff` pixel-diffs against a baseline, and `screenshots:smoke` gates interaction tests. PRs now get an advisory visual-report artifact + comment; `main` publishes the baseline. Hardening followed across live-auth capture behind Access ([#196](https://github.com/zyra-project/terraviz/pull/196)), richer publisher fixtures ([#197](https://github.com/zyra-project/terraviz/pull/197)), live-scene skips + clickable a11y violations ([#198](https://github.com/zyra-project/terraviz/pull/198)), faster stall recovery ([#199](https://github.com/zyra-project/terraviz/pull/199)), and targeted single-panel capture ([#201](https://github.com/zyra-project/terraviz/pull/201)).
- **Weblate screenshot sync** — translator screenshots are now created and associated automatically in CI, with the connector hardened for Weblate's rate limits via AIMD backoff ([#189](https://github.com/zyra-project/terraviz/pull/189)–[#194](https://github.com/zyra-project/terraviz/pull/194)).
- **graphify code-graph tool vendored** — a repo-wide knowledge-graph skill (SPA + `functions/` + `cli/` + Rust in one map) now backs an enforced module-map coverage check, so every module must appear in CLAUDE.md / `docs/BACKEND_MODULES.md` ([#174](https://github.com/zyra-project/terraviz/pull/174)).
- **Penpot mode-overrides** — the token pipeline gained bootstrap for Penpot mode-override sets and themes ([#77](https://github.com/zyra-project/terraviz/pull/77)).

---

## Smaller fixes

- Closed 20 open CodeQL findings on `main` ([#123](https://github.com/zyra-project/terraviz/pull/123)) and resolved the remaining Dependabot + code-scanning alerts ([#206](https://github.com/zyra-project/terraviz/pull/206)).
- Patched dependency advisories and enabled Dependabot ([#153](https://github.com/zyra-project/terraviz/pull/153)); later scoped it to security-only updates and fixed the CI `tsconfig` deprecation ([#165](https://github.com/zyra-project/terraviz/pull/165)).
- Filtered drafts out of the public catalog and rendered dataset abstracts as markdown in browse ([#115](https://github.com/zyra-project/terraviz/pull/115)).
- Fixed `NaN` coordinates in the admin Feedback general-tab bar chart ([#200](https://github.com/zyra-project/terraviz/pull/200)).
- Deflaked the `browse_search` emit assertions ([#185](https://github.com/zyra-project/terraviz/pull/185)) and gave playlists deterministic ids to kill a flaky uniqueness test ([#170](https://github.com/zyra-project/terraviz/pull/170)).

---

## Developer notes

- **New CLI subcommands**: `terraviz frames list` / `terraviz frames get` for addressing image-sequence frames by index or time.
- **New portal surfaces**: `/publish/datasets`, `/publish/tours`, `/publish/workflows`, `/publish/featured-hero`, `/publish/analytics`, `/publish/feedback`, `/publish/users`, `/publish/me` — all lazy-loaded behind Cloudflare Access.
- **New migrations**: the publisher portal + transcode pipeline + image-sequence + roles work add D1 migrations (0011 through 0023). They apply additively; `npx wrangler d1 migrations apply CATALOG_DB --remote` (or the opt-in CI auto-apply) brings a self-hosted instance current.
- **New GHA secrets** for the in-portal transcode pipeline (`GITHUB_DISPATCH_TOKEN`, plus the `R2_*` / `CF_ACCESS_*` / `TERRAVIZ_SERVER` runner secrets) — see the SELF_HOSTING walkthrough.
- **New scripts**: `npm run screenshots:report` / `:diff` / `:smoke`, `npm run check:doc-coverage` (module-map coverage), and the graphify skill at `.claude/skills/graphify/`.
- **CLAUDE.md / `docs/BACKEND_MODULES.md`** module maps are now coverage-enforced in CI.

---

## Known limitations

- **Desktop builds are still unsigned.** The Apple Developer ID + Windows Authenticode CI wiring is in place, but the certificates aren't provisioned yet. See the workaround section at the top of these notes.
- **macOS Intel is not supported** in this release. Only `aarch64-apple-darwin`.
- **Only English and Spanish are user-visible.** Kabyle, Estonian, and Arabic remain plumbed end-to-end but below the 80% string-coverage gate. Help close the gaps at <https://hosted.weblate.org/projects/terraviz>.
- **Restricted-visibility frames** (presigned-prefix path) and a few publisher polish items (per-task-type tour mini-forms, thumbnail strip on the frame uploader) are tracked as follow-ups.
- **Federation Tier 1+** is still unshipped — Phase 4 work, tracked separately against [`docs/architecture/federation-scoping.md`](https://github.com/zyra-project/terraviz/blob/v0.6.0/docs/architecture/federation-scoping.md).

---

## Bump

- `package.json`: `0.5.0` → `0.6.0`
- `src-tauri/tauri.conf.json`: `0.5.0` → `0.6.0`

See the [full changelog](https://github.com/zyra-project/terraviz/compare/v0.5.0...v0.6.0).
