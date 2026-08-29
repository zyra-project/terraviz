# Expose the visual fingerprint as retrieval: `tubeviz library similar`

> **Not for filing.** tubeviz is upstream and unaffiliated; nothing here is to be opened as an issue on that repository. Kept as the analysis record behind [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md). Observations were true at `87b048a` (v0.24.0) and upstream has moved to v0.34.0 since; see the [index](README.md) for what is now resolved.

**Labels:** `enhancement`, `library`, `studio`

## Summary

The v0.21 scene fingerprint is computed, persisted, and used only inside the
selector's scoring loop. Expose it as a first-class retrieval surface —
"show me scenes that look like this one" — in the CLI and in Studio.

## Background (current state)

The expensive half is already built and stored:

- [`src/tubeviz/visual_features.py#L108`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_features.py#L108)
  — `analyze_scene_visuals(...)` produces brightness + variance, saturation,
  dominant hue, warmth, a 5-colour palette, complexity, entropy, motion
  magnitude/peak/entropy, global motion direction, internal cut rate, and
  natural motion accents.
- [`src/tubeviz/visual_features.py#L200`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_features.py#L200)
  — `index_scene_visual_features(...)`.
- [`src/tubeviz/library.py#L180`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/library.py#L180)
  — the `scene_visual_features` table, plus `scene_embeddings` at
  [`#L166`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/library.py#L166)
  for the OpenCLIP side.
- [`src/tubeviz/cli.py#L735`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/cli.py#L735)
  — `library visual-index` builds it.

But the only consumer is the scoring path:
[`visual_director.py#L56`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_director.py#L56)
(`visual_match_score`) and
[`#L79`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_director.py#L79)
(`transition_score`). A curator staring at a 400-clip library in Studio cannot
ask the question the machine is already answering internally.

## Why this is worth doing

1. **The index is already paid for.** This is a query, not a new pipeline.
2. **It makes curation tractable at scale.** The natural workflows —
   "find near-duplicates of this so I can reject them", "find three more shots
   like the one that worked" — are exactly what the fingerprint encodes.
3. **It makes the director debuggable.** When a cut picks a shot you hate, being
   able to inspect the neighbourhood the selector was choosing from turns a
   mystery into a tuning problem.

## Where this idea comes from — credit

From **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`), which ships exactly this as a two-tier
"more like this", and — more importantly — has a well-tested opinion about
*layering* the cheap and expensive answers:

- [`src/services/relatedDatasets.ts#L46`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/services/relatedDatasets.ts#L46)
  — `scoreRelatedness(target, candidate)`, a purely lexical, always-available,
  fully offline recommendation.
- [`src/services/relatedDatasetsService.ts#L43`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/services/relatedDatasetsService.ts#L43)
  — `fetchSemanticRelatedIds(...)`, the expensive embedding-backed version.

The pattern worth copying is how they compose: the UI **renders the cheap
lexical list immediately, then progressively enhances it** with the semantic
result, and the semantic path **degrades to `null`** — meaning "keep what you
had" — on any failure. The user never waits on the model and never sees an
empty state because a model was unavailable.

Mapped onto tubeviz: the visual fingerprint is the always-available tier
(it's local numeric data, no model load), and OpenCLIP embeddings are the
enhancement tier that may be absent because `[semantic]` extras aren't
installed or no GPU is present.

## Proposal

**Core** — a pure scoring function in `visual_features.py` or a new
`similarity.py`, taking two fingerprints and returning a distance. No DB, no
model, no I/O; unit-testable on literals. `visual_match_score` should end up
calling into it so there is one definition of "looks alike".

**CLI**

```bash
tubeviz library similar VIDEO_ID --library ./library --limit 20
tubeviz library similar VIDEO_ID --scene 3 --limit 20 --json
tubeviz library similar VIDEO_ID --semantic        # opt-in enhancement tier
```

Without `--semantic`: fingerprint distance only, instant, always works.
With `--semantic`: re-rank using `scene_embeddings` when present; on any
failure (extras missing, no embeddings, load error) fall back silently to the
fingerprint ranking rather than erroring.

**Studio** — a "Similar" action on a library card, opening a filtered grid
with the same two-tier behaviour: fingerprint results paint immediately,
semantic re-rank swaps in if it resolves.

## Acceptance criteria

- [ ] Similarity scoring is a pure function with tests over literal fingerprints.
- [ ] `library similar` works on a library with **no** embeddings and no OpenCLIP installed.
- [ ] `--semantic` degrades to the fingerprint ranking on any failure, without an error exit.
- [ ] `visual_match_score` and `library similar` share one scoring implementation.
- [ ] Studio surfaces it from a library card.

## Possible follow-up

The same distance gives near-duplicate detection at ingest time, which would
sharpen the existing `--ai-near-duplicate-threshold` — that one currently
works on OpenCLIP embeddings only, so it silently does nothing on a library
built without the semantic extras.
