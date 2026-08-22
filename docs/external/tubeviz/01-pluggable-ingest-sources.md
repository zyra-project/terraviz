# Pluggable ingest sources: decouple the clip library from YouTube

**Labels:** `enhancement`, `ingest`, `architecture`

## Summary

Introduce a `SourceAdapter` seam in `ingest` so a clip library can be built
from media pools other than YouTube search — starting with keyless
public-domain / open-licence sources — without touching the selection,
direction or rendering stages.

## Background (current state)

Ingest is structurally excellent but bound to one provider at the type level:

- [`src/tubeviz/youtube.py#L57`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/youtube.py#L57)
  — `YouTubeSource` is the only implementation of search + download.
- [`src/tubeviz/ingest.py#L9`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/ingest.py#L9)
  imports it concretely (`from .youtube import DownloadFailure, SearchResult, YouTubeSource`).
- [`src/tubeviz/cli.py#L562`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/cli.py#L562)
  — the `ingest` subcommand is described as "Search YouTube and build/update a
  local clip library", and its provider-specific flags (`--cookies-from-browser`,
  `--verbose-ytdlp`) sit alongside provider-neutral ones (`--min-duration`,
  `--scene-threshold`, `--min-width`).

**The storage layer is already source-agnostic**, which is what makes this
change cheap:

- [`src/tubeviz/library.py#L102-L131`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/library.py#L102-L131)
  — the `clips` table keys on `UNIQUE(source, source_id)` with `source_url`,
  `extractor` and a free-form `metadata_json`. Nothing in the schema assumes YouTube.
- The v0.20.1 changelog already records the direction of travel: *"Studio
  playback now passes the clip's real source namespace instead of assuming
  every clip is `youtube`."*

Everything downstream of ingest — scene detection, OpenCLIP embedding, the
visual fingerprint, selection, direction, both renderers — operates on
normalized local media and never asks where it came from.

## Why this is worth doing

1. **It unblocks every non-hobby use.** yt-dlp + `--cookies-from-browser`
   against YouTube search is fine for personal work and a hard blocker for
   anything institutional, published, or archived. A source seam is the
   difference between "cool tool I can't show anyone" and "tool I can run at
   work."
2. **It makes ingest testable.** A fake adapter lets the ingest quota /
   pool-expansion logic be tested without a network or a real download —
   today [`tests/test_ingest.py`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/tests/test_ingest.py)
   has to work around a concrete provider.
3. **It costs almost nothing.** The seam is one protocol and one registry; the
   YouTube path becomes the default implementation and behaves identically.

## Where this idea comes from — credit

This is lifted directly from **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`), an Earth-data globe viewer built at NOAA's Global
Systems Laboratory. TerraViz faces the same problem in its newsroom tooling —
"find imagery for this event" — and solved it with a set of small, independent,
mostly keyless source builders behind one `MediaSuggestion` result type:

- [`src/ui/publisher/components/events/media-suggest.ts#L27-L50`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L27-L50)
  — the shared `MediaSuggestion` shape and its `kind` discriminator
  (`worldview | commons | shakemap | nhc | youtube | video-sitemap`).
- [`buildWorldviewSnapshot`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L93)
  — NASA Worldview Snapshots: keyless, public-domain satellite imagery for a
  bounding box + date. A pure URL builder, so it is trivially unit-testable.
- [`fetchCommonsSuggestions`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L263)
  — Wikimedia Commons geosearch, keyless, CORS-open.
- [`fetchShakemapSuggestion`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L381)
  and [`fetchNhcConeSuggestion`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L445)
  — hazard-gated USGS and NOAA/NHC sources that only run when the subject
  matches, so an irrelevant source costs zero requests.

The transferable lesson is the shape, not the endpoints: **each source is an
independent pure-builder-plus-thin-fetch pair returning one common type, and
a source that does not apply simply returns nothing.**

## Proposal

```python
# src/tubeviz/sources/base.py
class SourceAdapter(Protocol):
    name: str                       # stored in clips.source
    def search(self, term: str, *, pool: int) -> list[SearchResult]: ...
    def download(self, result: SearchResult, dest: Path) -> DownloadedMedia: ...
    def supports(self, term: str) -> bool: ...   # default True
```

- `src/tubeviz/sources/youtube.py` — the existing `YouTubeSource`, unchanged in
  behaviour, registered as `youtube` and kept as the default.
- `src/tubeviz/sources/commons.py`, `.../archive.py`, `.../worldview.py` — new
  open-licence adapters, each independently skippable.
- `tubeviz ingest --source youtube,commons` selects adapters; provider-specific
  flags become no-ops for adapters that don't consume them.
- `SearchResult` grows the fields the library already stores (`source`,
  `source_url`, `extractor`) so no adapter has to reach into `library.py`.

## Acceptance criteria

- [ ] `ingest.py` imports no provider module directly; adapters arrive through a registry.
- [ ] `tubeviz ingest --source ...` builds a library with mixed `clips.source`
      values and existing libraries keep working untouched.
- [ ] At least one non-YouTube adapter ships and is exercised in tests.
- [ ] `tests/test_ingest.py` drives quota / pool-expansion behaviour through a
      fake adapter, with no network.
- [ ] `tubeviz library stats` breaks counts down by source.

## Out of scope

Rights and attribution metadata — that is **#2**, and depends on this seam.
