---
name: import-sos
description: Inventory, analyze, and plan migration of native NOAA Science On a Sphere playlist.sos trees and sos_sqlite.db catalog metadata into TerraViz. Use when working with SOS FTP datasets, all.sos or rt_all.sos roots, SOS playlist properties, SOS-to-TerraViz mappings, conversion policy YAML, captions, synchronized audio, firstdwell/lastdwell, PIPs, multiple layers, licensing review, R2 migration preparation, or importer compatibility reports. Do not use SOS Explorer metadata as the native SOS source.
---

# Import native SOS datasets

Treat native SOS and SOS Explorer as separate systems. Read metadata from the
provided SOS code/database/playlist tree; never infer native SOS behavior from
SOS Explorer. Keep TerraViz metadata authoritative and map only SOS -> TerraViz.

## Inventory first

1. Confirm the current Git branch and preserve unrelated changes.
2. Read `docs/SOS_IMPORT.md` completely before changing importer behavior.
3. Read [references/mapping.md](references/mapping.md) when interpreting feature
   mappings or readiness findings.
4. Run the metadata-only inventory before downloading media or publishing:

```powershell
npm run terraviz -- import-sos inventory `
  "D:\NOAA\SOS Codebase\all.sos" `
  "D:\NOAA\SOS Codebase\rt_all.sos" `
  "D:\NOAA\SOS Codebase\spotlight.sos" `
  --catalog "D:\NOAA\SOS Codebase\sos_sqlite.db" `
  --output ".cache\terraviz\sos-import-inventory.json" `
  --cache-dir ".cache\terraviz\sos-playlists"
```

The command may fetch included `.sos` files from FTP. It must not mirror media,
execute playlist scripts, publish records, or write R2.

## Review the report

- Require a catalog match or explicitly approve an unmatched playlist.
- Keep `license_unknown` plans private. `SetSource`, Creator, and contacts are
  provenance/attribution, not permission.
- Resolve every `unsupported` issue before migration. Deprecation is an explicit
  policy decision, never an implicit drop.
- Review every unknown property. Preserve it in `source_import_state` even when
  no canonical mapping exists.
- Use `--no-network` to replay from cache and verify reproducibility.

## Apply policy

Start from `docs/examples/sos-import-policy.yaml`. Key overrides by stable
`legacy_id` (`sos:<DataID>:primary` or `sos:<DataID>:<variation>`). Record
license evidence, not assumptions. Re-run inventory after every policy change.

## Preserve authority and safety

- Store canonical synchronized features in TerraViz `experience_manifest`.
- Store SOS fingerprints/source facts in privileged `source_import_state` for a
  future three-way merge; never overwrite later TerraViz edits blindly.
- Route sequential narration/camera/presentation cards to Tours. Keep
  simultaneous layers, dataset-clock audio, timed captions, endpoint dwell,
  and globe/data-synchronized overlays with the dataset experience.
- Convert SRT captions to WebVTT during asset transfer while preserving the
  source reference and language.
- Never run `mirror --delete`, execute `script=`, or treat an FTP host as proof
  of licensing.
- Do not publish directly from the inventory. The current command produces the
  trusted migration manifest; bulk media transfer/R2 apply must consume only
  reviewed `ready_for_transfer` plans through the publisher APIs.

## Validate changes

Run focused importer tests, `npm run check:migrations`, regenerate the catalog
schema snapshot, run the CLI/function type checks, and validate this skill with
the repository-independent skill validator before reporting completion.

