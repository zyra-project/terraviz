# `DirectorDriver`: let something other than audio drive the timeline

> **Not for filing.** tubeviz is upstream and unaffiliated; nothing here is to be opened as an issue on that repository. Kept as the analysis record behind [`docs/TOUR_DIRECTION_PLAN.md`](../../TOUR_DIRECTION_PLAN.md). See that document's §3 for why none of this code may be imported.

**Labels:** `enhancement`, `architecture`, `director`

## Summary

Extract the interface between "signal analysis" and "shot planning" so the
Visual Director can be driven by any time-varying signal — an event feed, a
data time series, a script — with music analysis becoming the first
implementation rather than the only one.

## Background (current state)

The director already has an almost perfectly clean internal seam; it just isn't
named. Analysis produces a `Section` / `SceneIntent` vocabulary, and everything
downstream consumes *that*, not the audio:

- [`src/tubeviz/models.py#L37`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/models.py#L37)
  — `Section`; [`#L128`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/models.py#L128)
  — `SceneIntent`; [`#L293`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/models.py#L293)
  — `DirectedTimeline`, the deterministic artefact both renderers consume.
- [`src/tubeviz/visual_director.py#L45`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_director.py#L45)
  — `motion_target(section)`; [`#L56`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_director.py#L56)
  — `visual_match_score(candidate, section)`; [`#L79`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/visual_director.py#L79)
  — `transition_score(...)`. Every one of these takes a `Section`, never audio.
- [`src/tubeviz/analysis.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/analysis.py)
  is the only thing that knows about librosa, sample rates and hop lengths.

So the director is *already* signal-agnostic in practice. What's missing is a
declared protocol saying so, plus a second implementation proving it.

## Why this is worth doing

1. **It multiplies the reach of the best code in the repo.** The scoring stack —
   novelty pressure, reuse cooldowns, continuity-vs-contrast by section
   character, motif callbacks with narrative roles — is genuinely good and
   currently reachable only by people with a music track.
2. **It is a naming exercise, not a rewrite.** The seam exists; this issue makes
   it explicit and adds one alternative driver.
3. **It gives the test suite a signal it can synthesize.** Directing from a
   hand-written driver means shot-planning tests without an audio fixture.

## Where this idea comes from — credit

From **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`), which runs the mirror image of this architecture: a
deterministic timeline of shots executed by a playback engine, where the
*driver* is a news/event feed rather than a song.

- [`src/services/tourEngine.ts#L149`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/services/tourEngine.ts#L149)
  — `TourEngine` plays an ordered task list (`loadDataset`, `setEnvView`,
  `setTime`, `unloadDataset`) against a renderer that knows nothing about why
  the sequence exists.
- [`src/services/catalogEvents.ts#L40`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/services/catalogEvents.ts#L40)
  — `buildCatalogEvents(...)`, a **pure transform** from approved events plus a
  visible dataset set to overlays. No DOM, no fetch — the same discipline
  `visual_director.py` already follows.
- [`docs/CURRENT_EVENTS_PLAN.md`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/docs/CURRENT_EVENTS_PLAN.md)
  §7 describes auto-generated tours: an external feed becomes a timed sequence
  of scenes, and the `setTime` task was added specifically to serve it.

The transferable idea: **the planner's input should be a declared signal
protocol, not a file format.** TerraViz got the same reuse by keeping the
event → overlay transform pure and separate from the thing that plays it.

## Proposal

```python
# src/tubeviz/drivers/base.py
class DirectorDriver(Protocol):
    duration: float
    def sections(self) -> list[Section]: ...
    def accents(self) -> list[float]: ...          # seconds; beats today
    def tempo_curve(self) -> list[TempoPoint]: ...  # may be flat/empty
    def motifs(self) -> list[MusicalMotif]: ...     # may be empty
```

- `src/tubeviz/drivers/audio.py` — wraps today's `analysis.py`. Default. Zero
  behaviour change; `analyze` keeps its current CLI surface.
- `src/tubeviz/drivers/script.py` — a JSON/YAML driver: explicit sections with
  energy/brightness/role, accents as a timestamp list. Enough to storyboard a
  cut by hand, and enough to test the director deterministically.
- `tubeviz analyze --driver script cues.json --duration 240` produces a
  `DirectedTimeline` with no audio at all.

`DirectedTimeline.track` currently requires `TrackAnalysis`; either relax it or
let a driver synthesize a minimal one. Worth resolving alongside **#5**
(timeline versioning), since it touches the same contract.

## Acceptance criteria

- [ ] `visual_director.py` and `scene_selector.py` import nothing from `analysis.py`.
- [ ] The audio driver reproduces today's output byte-for-byte at a fixed `--selection-seed`.
- [ ] A script driver ships and is covered by a test that plans shots with no audio fixture.
- [ ] Both renderers consume the resulting timeline unchanged.

## Non-goal

Not proposing tubeviz stop being a music visualizer. Music stays the flagship
driver; this only stops it being the *only* one.
