# Visual Report & Testing — Planning Document

**Status:** draft for review
**Date:** 2026-06-14
**Owner:** Eric Hackathorn

## Context

The Weblate screenshot pipeline
([`WEBLATE_SCREENSHOT_SYNC_PLAN.md`](WEBLATE_SCREENSHOT_SYNC_PLAN.md))
gave us a small, disciplined machine: a headless Chromium that drives
the running app through a human-curated list of *scenes*
([`scripts/screenshots/scenes.ts`](../scripts/screenshots/scenes.ts)),
screenshots each one, and emits a manifest
([`scripts/screenshots/capture.ts`](../scripts/screenshots/capture.ts)).
It exists to feed translator context, but the capability underneath —
"drive the real UI to a known state and observe it" — is the foundation
of a great deal more: visual debugging, regression detection, deploy
health reporting, and smoke tests.

This document plans that generalization. The Weblate path keeps working
unchanged; it simply becomes **one consumer** of a shared capture core
alongside three new ones. The guiding discipline is the same one that
keeps the Explanation and screenshot syncs fresh: everything is
**generated from the running app**, in CI, keyed off the repo, so it
tracks development instead of decaying away from it.

This plan pairs with the Weblate plan (which owns the i18n-trace hook
and the per-string crops) and reuses its scene manifest verbatim.

---

## The four pillars

1. **Visual debugging for developers.** A single local command
   (`npm run screenshots:report`) captures the UI across every scene and
   a desktop + mobile viewport matrix, then writes a self-contained
   browsable HTML report. A developer scanning it spots layout, overflow,
   and styling regressions in seconds — without clicking through the app
   on each breakpoint by hand.

2. **CI visual regression.** On a pull request, the report's screenshots
   are pixel-diffed against a baseline produced by the latest `main`
   run. Changed scenes are flagged with a baseline / current / diff
   triptych. This is **advisory** — a comment and an artifact, never a
   failed check — while we tune masking for the inherently
   non-deterministic surfaces (WebGL globe, MapLibre tiles).

3. **Deploy report.** After a `main` deploy, the report runs once more
   against the *live* preview URL with the accessibility scan on, so it
   reflects production reality — real tiles, real network, real console
   — and surfaces problems that local capture structurally cannot
   (missing images, failed tile requests, broken backends). It lands at
   a stable URL on a dedicated Cloudflare Pages project.

4. **Smoke / interaction tests.** The same scene drivers, plus a
   fixture harness, carry *assertions*: search narrows the grid, Orbit's
   local engine answers and renders an inline load button, navigation
   mounts each surface with zero console errors. Unlike the visual diff,
   the smoke check **gates** the PR.

---

## Problems the report surfaces

For every scene × viewport the capturer attaches Playwright listeners
and records, alongside the PNG:

- **Console errors / warnings** (`console` events).
- **Uncaught page errors** (`pageerror`).
- **Failed and 4xx/5xx network requests** — broken images, missing
  tiles, dead API calls (`requestfailed` / `response`).
- **Accessibility violations** — an optional `@axe-core/playwright` scan
  (id, impact, node count), gated behind `VISUAL_AXE` so it doesn't slow
  the default local loop; on for the deploy report.
- **Broken scenes** — a stale selector fails the scene loudly (the
  existing capturer already does this), so the report never silently
  shrinks.

These render as per-scene problem badges in the HTML, which is what
makes the report a debugging *and* deploy-health surface, not just a
gallery.

---

## Architecture: one core, four consumers

The i18n key trace and the per-string crops are the *only*
Weblate-specific parts of today's capturer. Everything else — browser
launch, viewport parsing, the safe-output-directory guard, the
screenshot-with-retry, the per-scene page lifecycle — is generic. We
extract those primitives into `scripts/screenshots/core/`, and each
surface becomes a thin layer:

```
                 scripts/screenshots/core/
    browser.ts · types.ts · signals.ts · fixtures.ts
                         │
   ┌─────────────┬───────┴───────┬──────────────┐
 capture.ts    report.ts       diff.ts       smoke.ts
 (Weblate)    (report+a11y)  (regression)  (assertions)
                         │
                 report/render.ts → index.html
```

`capture.ts` keeps its i18n trace, `readTracedKeys`, `captureCrops`, and
coverage emit exactly as they are — it just imports the moved primitives
(re-exported from `capture.ts` so its existing tests' public surface is
preserved). The `screenshots.json` shape and the
[`sync-weblate-screenshots.ts`](../scripts/sync-weblate-screenshots.ts)
uploader are never touched.

---

## Resolved decisions

These were settled before drafting; each notes the tradeoff so a future
reader knows the path not taken.

- **Baselines: artifact from `main`, not committed PNGs.** The `main`
  run uploads `report-out/` as a long-retention `visual-baseline`
  artifact; PRs download it and diff against it. This keeps churny
  binaries out of git (every `*.png` is LFS-tracked here, so committed
  baselines would mean LFS bandwidth on every intentional UI change).
  *Tradeoff:* artifacts expire and the first PR before any `main`
  baseline exists has nothing to diff — both handled by treating a
  missing baseline as a **soft pass**. Revisit if cross-run
  non-determinism makes artifact baselines flaky.

- **Visual diff is advisory; smoke tests gate.** A visual diff over
  threshold posts a comment, never fails the check — pixel diffing a
  live globe is noisy until masking matures. Smoke assertions, by
  contrast, are deterministic and *do* fail the build. This split keeps
  the noisy signal informative and the crisp signal enforced.

- **WebGL / tile non-determinism is masked, not tolerated.** Scenes may
  declare `masks` (selectors) — the globe canvas, `#browse-map`, the
  timeline — that are excluded from the diff via Playwright's
  `screenshot({ mask })`. Combined with the existing
  `animations: 'disabled'`, this removes the dominant source of false
  positives. *Tradeoff:* a regression *inside* a masked region is
  invisible to the diff; those surfaces lean on the smoke tests and the
  full-scene visual instead.

- **Delivery: artifact on every PR, plus a deployed page.** PRs always
  get a downloadable `report-out/` artifact (zero infra). `main`
  additionally deploys the HTML to a dedicated `terraviz-visual`
  Cloudflare Pages project, following the established
  [`poster.yml`](../.github/workflows/poster.yml) separate-project
  pattern, for a stable, shareable deploy-report URL.

- **Fixtures: Playwright route stubs, not a seeded backend.** Data-backed
  publisher/admin surfaces render only "Loading…" against a local dev
  server (no backend/auth). `page.route('**/api/**', …)` serves minimal
  JSON fixtures typed against the portal wire types
  ([`src/ui/publisher/types.ts`](../src/ui/publisher/types.ts)),
  unlocking populated *and* forced-error/empty states for both the
  report and the smoke tests, with no CI infrastructure. *Tradeoff:*
  fixtures can drift from the real API shape — keeping them typed catches
  the structural half of that drift at `type-check`.

- **Orbit smoke scope: local engine only.** Orbit's hybrid architecture
  falls back to the deterministic local engine
  ([`docentEngine.ts`](../src/services/docentEngine.ts)) whenever the LLM
  is unreachable, which is always true on a local dev server. Smoke
  tests assert the local-engine path (open → send → response bubble →
  inline load-dataset button, with no `<<LOAD:…>>` leaking into visible
  text). The streamed LLM path is out of scope for now.

---

## Phases

Phases are independently shippable; each is one logical change,
DCO-signed.

- **V0 — Plan doc.** This document.
- **V1 — Extract the shared capture core.** Pure refactor; the Weblate
  manifest comes out byte-identical.
- **V2 — Problem-signal collection.** Console / page-error / network /
  axe collectors in the core, unit-tested against a fake emitter.
- **V3 — General capturer + multi-viewport + HTML report.** Delivers
  pillar 1; `npm run screenshots:report`.
- **V4 — Visual regression diff.** `pixelmatch` + masking; delivers the
  diff half of pillar 2.
- **V5 — CI workflow + PR comment + baseline plumbing.** Wires pillars 2
  and 3 into a workflow separate from the Weblate sync.
- **V6 — Deploy report against the live URL + a11y.** Completes pillar 3.
- **V7 — Route-stub fixture harness.** Promotes data-backed scenes from
  "Loading…" to populated views; enables pillar 4. The Weblate capturer
  installs fixtures too, so its publisher/admin per-string crops become
  populated rather than "Loading…" — a deliberate translator-context
  improvement. The "Weblate path untouched" guarantee is about *code*:
  the shared-core refactor (V1) keeps the manifest shape, the uploader,
  and the sync workflow byte-identical; it was never a promise that the
  rendered pixels for those scenes stay frozen.
- **V8 — Smoke / interaction tests.** Delivers pillar 4; the gating
  check.

Discoverability is wired in along the way: CLAUDE.md gains a **Visual
testing & reporting** section (the three `screenshots:*` commands and a
standing "add a `Scene` when you add a UI surface" convention, mirrored
on the module-map coverage rule), cross-linking this document — so a
future agent finds the tooling before touching `src/ui/`.

---

## Non-Goals

- **Not a Weblate replacement.** The Weblate sync
  ([`sync-weblate-screenshots.yml`](../.github/workflows/sync-weblate-screenshots.yml))
  keeps its own workflow, triggers, and i18n-specific capture path. This
  work runs beside it, never edits it.
- **Not per-locale.** The report and smoke tests run the default locale.
  Visual coverage of RTL / long-string locales is a possible later
  extension, not part of this plan.
- **The visual diff is not a hard gate.** Advisory by decision above;
  only the smoke check gates.
- **Not testing the Orbit LLM path.** Local engine only.
- **Not Tauri / WebXR.** Desktop-shell and immersive surfaces are out of
  scope; this is the web SPA's UI.

---

## New dependencies

All devDependencies. `@axe-core/playwright` + `axe-core` (V2),
`pixelmatch` + `pngjs` (V4). Playwright is already present; route
stubbing and assertions (V7/V8) add nothing new.

## Honest tradeoffs, in one place

- Artifact baselines are cheaper than committed ones but expire and miss
  the very first PR — accepted via soft-pass.
- Masking removes globe/tile noise but blinds the diff inside masked
  regions — accepted, covered by smoke + full-scene visual.
- Route-stub fixtures are infra-free but can drift from the real API —
  accepted, mitigated by typing them against the wire types.
- The advisory visual diff trades enforcement for low noise — a
  deliberate choice while masking matures; revisit promoting it to a
  gate once false positives are demonstrably rare.
