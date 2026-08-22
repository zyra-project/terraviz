# Make the timeline an explicit versioned contract (schema version + migrations)

> **Not for filing.** tubeviz is upstream and unaffiliated; nothing here is to be opened as an issue on that repository. Kept as the analysis record behind [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md). See that document's §3 for why none of this code may be imported.

**Labels:** `enhancement`, `architecture`, `compatibility`

## Summary

Add a `timeline_version` to `DirectedTimeline`, and move the ad-hoc
"downgrade an old timeline at read time" logic out of the two renderers into
one shared migration module.

## Background (current state)

`DirectedTimeline` is the project's central contract — it is what `analyze`
emits, what `serve` replans, what the browser renderer plays, and what the
native manifest writer translates:

- [`src/tubeviz/models.py#L293`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/models.py#L293)
  — `DirectedTimeline`, `model_config = ConfigDict(extra="forbid")`.

It carries no version field. Meanwhile v0.24 shipped **two independent
implementations of backwards compatibility**, one per renderer. From
[`CHANGELOG.md`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/CHANGELOG.md):

> Added browser-runtime and native-manifest pruning for legacy v0.22/v0.23
> timelines so old over-dense vector plans no longer stack every visible family.

- Browser side: the visible-vector budget is applied inline while building the
  effect list —
  [`static/visualizer.js#L1057`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/static/visualizer.js#L1057).
- Native side: a parallel implementation in
  [`native_render.py#L198`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/native_render.py#L198)
  (`_native_vector_effects`) feeding the `VEC` manifest records at
  [`#L236`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/native_render.py#L236).

Both must decide what an old timeline *means*, in different languages, with no
declared input version to branch on. They currently infer it from the shape of
the data. The next format change requires editing both again, and any drift
between them shows up as "the preview and the final render disagree".

Note the library layer already solved the same problem properly, with an
explicit `schema_meta` version and a migration step —
[`library.py#L97`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/library.py#L97)
and [`#L196-L203`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/library.py#L196-L203).
This issue asks for the same treatment one level up.

## Why this is worth doing

1. **Timelines are meant to be kept.** The README states old timelines stay
   valid ("Existing timeline JSON is immutable"). That promise needs a version
   field to survive more than one more format change.
2. **`extra="forbid"` makes forward compatibility a hard failure.** A v0.25
   timeline opened by a v0.24 install won't degrade — it will raise. A version
   field turns that into a clear message instead of a validation traceback.
3. **One migration beats N renderers.** Migration is planner-side logic; putting
   it in each renderer guarantees eventual divergence.

## Where this idea comes from — credit

From **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`), which has the same many-consumers-one-contract
problem: a sidecar describing how a video encodes data must be read identically
by a Cloudflare Worker, two WebGL renderers, and an authoring portal. Its answer
is a single shared types module that owns the format, the parser and the
derived tables:

- [`src/types/color-scale.ts#L105`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/types/color-scale.ts#L105)
  — `parseColorScale(input: unknown): ColorScale | null`, **fail-closed**: an
  unparseable sidecar yields `null` and the caller falls back, rather than each
  consumer guessing.
- [`#L173`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/types/color-scale.ts#L173)
  `buildColorScaleLut` and [`#L227`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/types/color-scale.ts#L227)
  `lumaToValue` — every derived artefact is built **through** the shared module,
  never re-derived per consumer.
- [`src/types/zyra-workflow-constants.ts`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/types/zyra-workflow-constants.ts)
  — the same discipline for the workflow pipeline: one module of shared
  constants imported by the API, the runner and the portal.

TerraViz's own contributor docs state the rule plainly: a shared contract module
is *"the single source of truth"*, and consumers import it rather than
reimplementing it. That is precisely what `visualizer.js` and `native_render.py`
are currently doing twice.

## Proposal

1. Add `timeline_version: int` to `DirectedTimeline`, defaulting to the current
   format when absent (so today's files load as v24).
2. New `src/tubeviz/timeline_migrations.py`:
   - `migrate(payload: dict) -> dict` — normalizes any older timeline to the
     current version, including the v0.22/v0.23 vector-budget pruning.
   - Raises a clear "timeline is newer than this tubeviz" error on the reverse case.
3. `serve`, `render`, `materialize` and the native manifest writer all load
   through it, and thereafter only ever see current-version data.
4. Delete the inline legacy handling from `visualizer.js` and `native_render.py`.
5. Document the format and its versions in `docs/TIMELINE_FORMAT.md`.

## Acceptance criteria

- [ ] A v0.22 and a v0.23 timeline both load through one migration path and
      produce identical shot plans in both renderers.
- [ ] Neither renderer contains version-sniffing logic afterwards.
- [ ] A synthetic "future" timeline yields a readable error rather than a
      pydantic `extra="forbid"` traceback.
- [ ] Migration is covered by tests on fixture timelines — no rendering required.
