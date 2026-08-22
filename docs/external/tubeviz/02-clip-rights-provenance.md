# Track per-clip rights/licence provenance, and make render rights-aware

**Labels:** `enhancement`, `library`, `provenance`

## Summary

Store licence and attribution for every clip in the library, surface it in
Studio and `library` commands, and let `render` refuse (or loudly warn) when a
timeline draws on footage with unknown rights. Optionally emit an attribution
credits file next to the rendered MP4.

## Background (current state)

The library already tracks *discovery* provenance carefully — where a clip came
from, which term found it, its AI ranking, its duplicates, its hashes:

- [`src/tubeviz/library.py#L102-L131`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/library.py#L102-L131)
  — `clips` carries `source`, `source_id`, `source_url`, `channel`,
  `webpage_url`, `extractor`, `original_sha256`, `normalized_sha256`,
  `discovered_at`, plus a free-form `metadata_json`.
- [`src/tubeviz/cli.py#L684`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/cli.py#L684)
  — `library show` is already documented as showing "one clip and its
  provenance/files".

What is missing is the *rights* half. There is no `license`, no
`attribution_required`, no rights status. A finished MP4 therefore has no
recoverable answer to "may I post this, and whom must I credit?", even though
every fact needed to answer it was available at ingest time.

There is also a working migration precedent to copy — v0.23 added
`usable_start` / `usable_end` with an automatic schema bump:

- [`src/tubeviz/library.py#L196-L203`](https://github.com/interrupt21h/tubeviz/blob/87b048a5c54ea8ed6054651b32dda5adb7b87b45/src/tubeviz/library.py#L196-L203)
  — column probe, `ALTER TABLE`, `schema_meta` version write.

## Why this is worth doing

1. **It is the difference between a private toy and a publishable tool.** Every
   other quality signal in this project (deterministic timelines, reproducible
   seeds, content-hashed media) points at work someone wants to keep and share.
   Rights metadata is the one missing link in that chain.
2. **It is nearly free once #1 lands.** An open-licence adapter knows the licence
   at search time; it is a column write, not a research project.
3. **It degrades honestly.** Existing YouTube-sourced libraries simply get
   `rights_status = 'unknown'`, which is the truth, and the render gate is
   advisory by default.

## Where this idea comes from — credit

From **[TerraViz](https://github.com/zyra-project/terraviz)**
(`zyra-project/terraviz`), which enforces this at the point of acquisition
rather than the point of publication. Its Wikimedia Commons source keeps a
candidate **only** when the licence is public domain or CC0, precisely because
the record it writes has nowhere to put an attribution string:

- [`media-suggest.ts#L223`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L223)
  — `const FREE_LICENSE_RE = /public domain|cc0/i`
- [`media-suggest.ts#L244-L249`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L244-L249)
  — the filter, applied before the suggestion is ever offered to a curator.
- The module header states the reasoning outright: kept only when the licence is
  public domain / CC0, because *"the stored `image_url` carries no attribution
  field"* —
  [`media-suggest.ts#L13-L15`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/publisher/components/events/media-suggest.ts#L13-L15).

TerraViz also treats source citation as a first-class output rather than an
afterthought — its public blog surface renders the approved-event source
citation alongside the story
([`src/ui/blog/index.ts`](https://github.com/zyra-project/terraviz/blob/420a1fd6242cc0fe97c242234955f4f1b7ddb07a/src/ui/blog/index.ts)).

The transferable rule: **either the schema can express the obligation, or the
ingest must reject the asset.** Don't defer the question to render time.

## Proposal

**Schema** (one migration, mirroring the v0.23 pattern):

```sql
ALTER TABLE clips ADD COLUMN license TEXT;          -- SPDX-ish or source string
ALTER TABLE clips ADD COLUMN license_url TEXT;
ALTER TABLE clips ADD COLUMN attribution TEXT;      -- rendered credit line
ALTER TABLE clips ADD COLUMN rights_status TEXT NOT NULL DEFAULT 'unknown';
                                                    -- unknown | open | permission | restricted
```

**Surfaces**

- `library show` prints rights alongside provenance; `library list --rights open`
  filters; `library stats` reports the mix.
- Studio library cards show a rights chip next to the existing trim badge.
- `library set-rights VIDEO_ID --license CC0-1.0 --attribution "…"` for manual curation.

**Render gate**

- `tubeviz render --require-rights open` fails with the offending clip list.
- Default stays advisory: a summary line naming how many shots have unknown rights.
- `--credits credits.txt` writes one attribution line per distinct clip used by
  the timeline's `scene_plan`.

## Acceptance criteria

- [ ] Migration runs automatically on an existing library and is idempotent.
- [ ] Adapters from #1 populate `license` / `rights_status` where the source knows it.
- [ ] `render --require-rights open` exits non-zero and names every failing clip.
- [ ] `--credits` output lists each distinct source used, deduplicated, in shot order.
- [ ] Existing libraries keep rendering unchanged, reported as `unknown`.

## Notes

Deliberately not a licence *classifier*. If a source cannot state the licence,
the answer is `unknown` — an honest gap beats a guess.
