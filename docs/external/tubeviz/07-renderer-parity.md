# Renderer parity: one planner, two thin renderers, and a conformance test

> **Not for filing.** tubeviz is upstream and unaffiliated; nothing here is to be opened as an issue on that repository. Kept as the analysis record behind [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md). See that document's §3 for why none of this code may be imported.

**Labels:** `enhancement`, `architecture`, `rendering`

## Summary

The browser and native renderers each re-derive parts of the *plan* rather than
just executing it. Move the shared decisions into the planner, document the
intended parity, and add conformance tests over the manifest.

## Background (current state)

The README is refreshingly honest that the two renderers differ:

> The browser renderer is the reference vector implementation. […] The native
> path intentionally uses cheaper geometry for high-throughput final rendering
> while preserving the same Visual Director decisions.

"Same decisions, different geometry" is a good design. The problem is that
"the decisions" are currently re-implemented on each side rather than shared:

- Native: [`native_render.py#L198`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/native_render.py#L198)
  `_native_vector_effects(scene)` decides which effects survive into the
  manifest; [`#L185`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/native_render.py#L185)
  `_curve_sample(...)` re-samples the same automation curves the browser
  evaluates in [`visualizer.js#L698`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/static/visualizer.js#L698)
  (`effectCurveValue`) and [`#L630`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/static/visualizer.js#L630)
  (`automationValue`).
- Browser: the visible-vector budget is applied at draw time —
  [`visualizer.js#L1057`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/static/visualizer.js#L1057).

Two implementations of one policy, in two languages, is the classic setup for
"the preview looked different from the final render" — the most expensive class
of bug for a tool whose workflow is *preview, tweak, then render for real*.

Related: [`tests/test_native_vector_manifest.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_native_vector_manifest.py)
already tests one side of this. The proposal is to make it a two-sided contract.

## Why this is worth doing

1. **Preview fidelity is the product.** Every parameter in `analyze` is tuned by
   watching `serve`. If `render` disagrees, the tuning was wasted.
2. **It shrinks both renderers.** Policy moves up; the renderers get to be dumb
   and fast, which is what you want them to be.
3. **It makes the difference auditable.** Divergence becomes a documented list
   instead of an emergent property.

## Where this idea comes from — credit

From **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`), which enforces a strict pure-transform / thin-wiring
split precisely so multiple renderers can't drift. Its module map states the
rule for each pair, and the pattern repeats throughout:

- [`src/services/catalogGraph.ts`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/services/catalogGraph.ts)
  — a **pure transform** from a filtered catalog to nodes and edges —
  paired with [`src/ui/catalogGraphUI.ts`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/catalogGraphUI.ts),
  which only mounts it into cytoscape. Same split for the Map and Timeline views.
- [`src/services/datasetStats.ts#L176`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/services/datasetStats.ts#L176)
  — statistics with "no DOM, no GL, no fetch" as an explicit contract, so the
  numbers a panel shows and the numbers an export writes cannot differ.
- [`src/types/color-scale.ts#L173`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/types/color-scale.ts#L173)
  — both WebGL renderers sample a LUT **built by the shared module**, rather
  than each building its own from the same stops.

The transferable rule: **anything that decides *what* is drawn belongs to the
planner; a renderer decides only *how*.** TerraViz gets a related guarantee out
of it — a display transform can change appearance but can never change a
reported value — which is the same class of invariant as "preview and final
render make the same cut".

## Proposal

1. **Move the visible-vector budget into the planner.** `visual_director.py`
   already owns the policy conceptually
   ([`#L193`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_director.py#L193),
   `_vector_effects`). Emit a resolved `visible: bool` per `VectorEffect` in the
   timeline; both renderers obey it and neither recomputes it.
2. **Share automation sampling.** Sample curves planner-side into the timeline,
   or specify the interpolation exactly in `docs/TIMELINE_FORMAT.md` (see **#5**)
   and test both implementations against the same fixture table.
3. **Write a parity matrix** — `docs/RENDERER_PARITY.md`, one row per effect
   kind: browser support, native support, and whether the difference is
   *intended* (cheaper geometry) or *unimplemented*.
4. **Conformance tests** — for a fixture timeline, assert the native manifest
   contains a `VEC` record for exactly the effects the shared policy marks
   visible, and that per-shot effect families match.

## Acceptance criteria

- [ ] The visible-vector budget is computed once, in the planner.
- [ ] `docs/RENDERER_PARITY.md` exists and distinguishes intended from missing.
- [ ] Conformance tests fail if one renderer gains an effect the other silently ignores.
- [ ] Preview and native render of the same timeline produce the same shot
      boundaries, sources, and effect families.

## Explicit non-goal

Not asking for pixel-identical output. Cheap native geometry is a deliberate,
correct tradeoff. The ask is that the *decisions* match and the differences are
written down.
