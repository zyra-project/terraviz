# Deterministic visual regression harness: golden frames + an HTML report

> **Not for filing.** tubeviz is upstream and unaffiliated; nothing here is to be opened as an issue on that repository. Kept as the analysis record behind [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md). See that document's §3 for why none of this code may be imported.

**Labels:** `enhancement`, `testing`, `rendering`

## Summary

Add a harness that renders a fixed set of frames from fixture timelines at a
fixed seed, diffs them against committed baselines, and publishes a
self-contained HTML gallery. The project's entire value is visual and none of
it is currently regression-tested.

## Background (current state)

The test suite is real — ~3,000 lines across ~40 files, including
[`test_render_optimization.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_render_optimization.py),
[`test_vector_rendering_quality.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_vector_rendering_quality.py)
and
[`test_visualizer_artifacts.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_visualizer_artifacts.py).
But these assert on *plans and artefacts*, not on pixels.

The gap shows up in the changelog. The whole of v0.24 is a visual-regression
fix, described in the [README](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/README.md)
as:

> Earlier vector releases could produce a "hair" or "fur" appearance because
> strong edge samples were rendered as many independent tangent strokes and flow
> ribbons began at pseudo-random screen positions.

That regression was found by a human watching output, and could only have been
found that way. Everything needed to automate the next one already exists:

- Determinism: `--selection-seed` and `--selection-variation`
  ([`cli.py#L760`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/cli.py#L760)),
  plus per-effect deterministic seeds in
  [`models.py#L227`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/models.py#L227)
  (`VectorEffect`) and geometry caching keyed on scene/effect/seed
  ([`visualizer.js#L926`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/static/visualizer.js#L926)).
- A headless browser path already used for offline rendering (Playwright, the
  `render` extra).
- A CLI that can render an exact frame range.

## Why this is worth doing

1. **This is the highest-value test infrastructure available to this project.**
   The unit tests can't see the thing users judge it by.
2. **The seeds make it honest.** Most visualizers can't do golden-frame testing
   because they're non-deterministic. tubeviz deliberately isn't.
3. **It pays for itself on the next effect refactor.** v0.24 touched contour
   extraction, ribbon seeding, the vector budget, *and* the native equivalents.
   A baseline gallery turns "does this still look right across 12 shots?" into
   one command.

## Where this idea comes from — credit

From **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`), which runs a Playwright capture harness over a real
UI for exactly this purpose, and — usefully — has already made the mistakes:

- [`scripts/screenshots/scenes.ts#L35`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/scripts/screenshots/scenes.ts#L35)
  — `Scene { name, description, setup(page), masks?, fixtures? }`. **One
  human-maintained list** is the whole configuration surface.
- [`#L70`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/scripts/screenshots/scenes.ts#L70)
  — `masks?: string[]`, regions excluded from the diff because they are
  legitimately non-deterministic (the WebGL globe, a map, a force-directed
  graph). Without this, a pixel diff is pure noise and gets ignored within a week.
- [`scripts/screenshots/diff.ts#L94`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/scripts/screenshots/diff.ts#L94)
  — `diffPngBuffers(...)`, and [`#L62`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/scripts/screenshots/diff.ts#L62)
  `parseThreshold(...)`.
- [`.github/workflows/visual-report.yml`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/.github/workflows/visual-report.yml)
  — the split that makes it survivable: the **pixel diff is advisory** (an
  artefact plus a PR comment) while a small **interaction smoke job gates**.

That last point is the one worth stealing outright. A gating pixel diff on
generative visual output produces false failures until someone disables it. An
advisory gallery plus a gating "did it render at all, without console errors"
check keeps the signal and drops the noise.

TerraViz's convention is also worth copying: **when you add a surface, you add a
scene for it in the same PR.**

## Proposal

- `tests/fixtures/timelines/` — 3–5 committed timelines chosen for coverage
  (one per effect family; one legacy v0.22 for the migration in **#5**), plus a
  tiny synthetic clip library generated by FFmpeg at test time so no media is
  committed.
- `scripts/visual_report.py`:
  - renders N fixed frame indices per fixture, per backend (`browser`, `native`);
  - writes `report-out/index.html` — a self-contained gallery, browser vs native
    side by side, with per-frame badges for console errors and missing media;
  - `--baseline <dir>` produces a masked pixel diff, advisory, non-zero exit only
    under `--strict`.
- CI (see **#10**): the gallery uploads as an artefact on every PR; a separate
  fast job gates on "every fixture renders, zero console errors, non-black output".

## Acceptance criteria

- [ ] Rendering a fixture twice at the same seed produces byte-identical frames.
- [ ] The report renders without network access and embeds its images.
- [ ] Masks are supported and documented, with the WebGL/timing rationale spelled out.
- [ ] The diff is advisory by default; `--strict` makes it exit non-zero.
- [ ] The smoke check runs in CI in under ~5 minutes.

## Prerequisite

Depends on the render path being reachable in CI without a GPU. If the native
backend can't build on a runner, ship browser-backend coverage first and add
native behind an opt-in job.
