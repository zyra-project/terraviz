# Native SOS dataset import

TerraViz now includes a metadata-only importer for the native NOAA Science On a
Sphere catalog and `playlist.sos` format. It is intentionally separate from SOS
Explorer: the native SOS code, SQLite catalog, and playlists define the source
semantics. TerraViz remains authoritative after conversion.

## What is implemented

`terraviz import-sos inventory`:

- reads `sos_sqlite.db` with Node's built-in read-only SQLite API;
- starts from one or more local master playlists such as `all.sos`,
  `rt_all.sos`, and `spotlight.sos`;
- resolves `/shared/sos/media/...` and `/shared/sos/rt/noaa/...` to the public
  FTP hierarchy;
- fetches only included `.sos` files, with a byte cap, timeout, depth limit,
  cycle detection, and a content cache;
- parses native SOS name/value, clip, layer, and PIP behavior while preserving
  unknown properties;
- matches playlists to catalog datasets and variations;
- writes a deterministic conversion/readiness report with source asset
  references but does not fetch those assets;
- applies optional license/disposition overrides from YAML; and
- emits canonical TerraViz `experience_manifest` and privileged
  `source_import_state` draft values for later reviewed migration.

The command does not download bulk media, list whole FTP trees, execute scripts,
publish datasets, or write Cloudflare R2. This boundary prevents a multi-week
mirror and prevents incomplete feature conversions from becoming public.

## First inventory

From the TerraViz repository:

```powershell
npm run terraviz -- import-sos inventory `
  "D:\NOAA\SOS Codebase\all.sos" `
  "D:\NOAA\SOS Codebase\rt_all.sos" `
  "D:\NOAA\SOS Codebase\spotlight.sos" `
  --catalog "D:\NOAA\SOS Codebase\sos_sqlite.db" `
  --output ".cache\terraviz\sos-import-inventory.json" `
  --cache-dir ".cache\terraviz\sos-playlists"
```

Use `--no-network` for a reproducible cache-only replay and `--refresh` when an
upstream playlist is known to have changed. The default playlist cap is 5 MiB,
timeout is 30 seconds, and include depth is 9, matching native SOS's recursion
limit. A failed child include is recorded without discarding the rest of the
inventory; a failed root returns a nonzero exit code.

The FTP reader invokes `curl` without a shell, passes the URL as a distinct
argument, caps bytes, and stores only playlist text. `curl` must be available on
PATH for FTP inventory. HTTP(S) playlists use the built-in fetch implementation.

## Conversion decisions

| Native SOS feature | TerraViz representation | Current handling |
|---|---|---|
| Primary data | dataset media/R2 | Referenced and planned; bulk transfer is not yet applied. |
| One caption | `caption_ref` plus text-track manifest | Planned; SRT must become VTT during transfer. |
| Multiple captions | `experience.textTracks` | Preserved; track-selection UI/runtime is still required. |
| Dataset audio | `experience.audioTracks` | Preserved on the dataset clock; synchronized playback runtime is still required. |
| `firstdwell` / `lastdwell` | `experience.playbackPolicy` | Preserved as milliseconds; playback state-machine support is still required. |
| Multiple layers | `experience.composition.layers` | Preserved; layer compositor support is still required. |
| Static room/projector PIP | companion Tour media task | Identified; generate only after asset migration. |
| Globe/path PIP | `experience.overlays` | Preserved; synchronized overlay renderer is still required. |
| Live PIP | live-media gateway or deprecation | Marked unsupported for ordinary imports. |
| Playlist script | none | Recorded and blocked; never executed. |
| Licensing | TerraViz rights fields | Requires evidence in policy; unknown stays private. |

This split keeps Tours focused on sequential presentation: narration, camera
movement, questions, pauses, and viewport media cards. Intrinsic dataset state
stays with the dataset so pausing/seeking the data also pauses/seeks synchronized
audio, captions, and overlays.

## Policy YAML

Copy [the example policy](examples/sos-import-policy.yaml) and key entries by the
stable importer ID. The primary row uses `sos:<DataID>:primary`; variations use a
normalized playlist filename. Policy may change title, visibility, disposition,
and verified rights fields.

`SetSource`, creators, and contacts are copied only as provenance/attribution.
They are never treated as licenses. Without `license_spdx`, `license_url`, or a
verified `license_statement`, the plan remains private and `needs_review`.

## Authoritative metadata and re-imports

`experience_manifest` is the TerraViz-owned versioned document consumed by
future runtime features. `source_import_state` stores the source playlist,
fingerprint, native feature representation, and unknown properties. It is
privileged-only and omitted from public catalog responses.

A future apply command must perform a three-way comparison:

1. the last imported source snapshot;
2. the current TerraViz record; and
3. the newly crawled SOS source.

It may update fields unchanged since the last import, but must report conflicts
instead of overwriting human TerraViz edits.

## R2 transfer design

The next stage should consume only reviewed `ready_for_transfer` plans. Process
one dataset at a time through a bounded temporary spool: download referenced
assets, validate/transcode, upload with the existing publisher/R2 APIs, verify
digests, commit metadata, then clear the spool. Journal every object and API
mutation so retries are idempotent. Add multipart/streaming support before
moving assets larger than the current single-buffer upload limit.

Pilot 10–20 representative datasets first: plain frames, movie, captions,
audio, dwell, multi-layer, static PIP, path/globe PIP, real-time, and unknown
license. Do not enable batch publishing until each planned feature has either
runtime support or an explicit deprecation decision.

