# Draft feature issues for `interrupt21h/tubeviz`

These are **drafts**, staged here for review — nothing has been filed on
[`interrupt21h/tubeviz`](https://github.com/interrupt21h/tubeviz). Each file is
a complete, paste-ready GitHub issue body with a suggested title and labels.

## Context

[tubeviz](https://github.com/interrupt21h/tubeviz) is an AI-directed,
video-first music visualizer by Scott Muller — it builds a persistent local clip
library, analyzes music for rhythm/structure/vibe, plans beat-aligned edits, and
renders through a native C++/FFmpeg backend or a browser renderer. It is not a
TerraViz project and has no affiliation with it.

Reviewed at commit
[`87b048a`](https://github.com/interrupt21h/tubeviz/commit/87b048a5c54ea8ed6054651b32dda5adb7b87b45)
(v0.24.0). Every code link in these drafts is pinned to that commit, so the line
numbers stay correct as the project moves.

## Attribution

Several proposals port a pattern that **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`, NOAA Global Systems Laboratory / the Zyra project)
already solved. Where that is the case, the issue says so explicitly in a
**"Where this idea comes from — credit"** section that names TerraViz, links the
specific module at commit
[`420a1fd`](https://github.com/zyra-project/terraviz/commit/420a1fd6242cc0fe97c242234955f4f1b7ddb07a),
and states the transferable lesson rather than just gesturing at the repo. None
of these ask tubeviz to depend on TerraViz — the two share no code and no
runtime. What travels is the design pattern, and it is credited by name.

TerraViz is public, so every link resolves for anyone reading the issue.

## The issues

### Features

| # | Title | Idea credited to |
|---|---|---|
| [01](01-pluggable-ingest-sources.md) | Pluggable ingest sources: decouple the clip library from YouTube | TerraViz `media-suggest.ts` — independent per-source builders behind one result type |
| [02](02-clip-rights-provenance.md) | Track per-clip rights/licence provenance, and make render rights-aware | TerraViz — PD/CC0-only acquisition filter; the schema expresses the obligation or the ingest rejects the asset |
| [03](03-director-driver-seam.md) | `DirectorDriver`: let something other than audio drive the timeline | TerraViz `tourEngine.ts` + `catalogEvents.ts` — a pure feed→scene transform feeding a driver-agnostic player |
| [04](04-visual-fingerprint-similarity.md) | Expose the visual fingerprint as retrieval: `tubeviz library similar` | TerraViz `relatedDatasets.ts` / `relatedDatasetsService.ts` — cheap tier first, expensive tier as progressive enhancement that degrades to "keep what you had" |
| [05](05-timeline-contract-versioning.md) | Make the timeline an explicit versioned contract | TerraViz `types/color-scale.ts` — one shared module owns the format, the fail-closed parser, and every derived table |
| [06](06-visual-regression-harness.md) | Deterministic visual regression harness: golden frames + an HTML report | TerraViz `scripts/screenshots/` — one maintained scene list, masks for non-deterministic regions, **advisory** pixel diff + **gating** smoke |
| [07](07-renderer-parity.md) | Renderer parity: one planner, two thin renderers, and a conformance test | TerraViz pure-transform / thin-wiring split (`catalogGraph.ts`, `datasetStats.ts`) — the planner decides *what*, a renderer decides only *how* |

### Foundations

| # | Title |
|---|---|
| [08](08-add-a-license.md) | Add a LICENSE |
| [09](09-repo-hygiene.md) | Remove the nested duplicate tree, committed bytecode, and the third copy of the C++ source |
| [10](10-ci-run-the-test-suite.md) | CI: run the existing test suite on every push and PR |
| [11](11-studio-network-hardening.md) | Studio: default to loopback, add an access token, and warn on `--host 0.0.0.0` |

## Suggested order

**08 → 09 → 10** first: they are hours of work, unblock everyone else, and make
the rest reviewable. **01 → 02** is the pair that changes what the project can
be used for. **05 → 07** are the architectural ones and share a contract, so
they want to land together. **06** is the highest-value test infrastructure but
wants **10** underneath it. **03** and **04** are independent and can go any time.

## Dependencies between them

```
08 ─┐
09 ─┼─→ 10 ─→ 06
    │
01 ─┴─→ 02

05 ─→ 07
03 (independent)   04 (independent)   11 (independent)
```

## A note on tone

These are written as proposals to another maintainer's project, not as a
verdict on it. The code is better than a quick skim suggests — the vector
renderer really does implement the contour tracing, RDP simplification, Chaikin
smoothing, Delaunay/Voronoi construction and block-matched optical flow that the
README claims, and the v0.24 changelog entry about the "hair"-like overlay is
the kind of self-criticism you only get from someone actually watching the
output. Each issue tries to lead with what already works before proposing a change.
