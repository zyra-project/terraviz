# Native SOS to TerraViz mapping

## Hard boundary

The source is the native SOS repository, `sos_sqlite.db`, and native `.sos`
playlists. SOS Explorer snapshots may be compared after conversion but do not
define native SOS semantics.

## Mapping table

| SOS metadata | TerraViz target | Rule |
|---|---|---|
| `name`, database Name/Description | dataset draft | Catalog enriches the playlist; explicit policy can override. |
| `data` / `datadir` | primary media | `data` aliases `datadir`; transfer to R2 later. |
| `caption` | dataset text track | Convert lowercase/uppercase SRT to VTT; one legacy track may also populate `caption_ref`. |
| `audio`, `volume` | dataset audio track | Synchronize to dataset pause/seek/time. Tour audio is only for Tour narration. |
| `firstdwell`, `lastdwell` | playback policy | Integer milliseconds; implement as state, never duplicated frames. |
| multiple `layer` / `layerdata` | composition layers | Simultaneous layer stack; never flatten to a sequential Tour. |
| room/projector static PIP | companion Tour | Generate media tasks after referenced assets have TerraViz IDs/URLs. |
| globe PIP or `pippath` | composition overlay | Preserve spatial/data synchronization. |
| RTSP/UDP/webcam PIP | manual/live gateway | Unsupported for ordinary asset migration. |
| `script` | blocked source evidence | Record but never execute. |
| `SetSource`, Creator, contacts | attribution/provenance | Never infer a license. |
| license override evidence | dataset/asset rights | Unknown rights force private/review. |
| unknown property | import state + review | Preserve and require an explicit map/deprecate decision. |

## Readiness

- `ready_for_transfer`: metadata has no unresolved review/unsupported finding.
- `needs_review`: conversion is understood but needs policy or a TerraViz
  capability decision.
- `unsupported`: publishing would lose behavior or cross a security boundary.

