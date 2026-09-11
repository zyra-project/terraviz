# Phase 0 implementation and operator remediation

**Status:** Implemented for review in [PR #433](https://github.com/zyra-project/terraviz/pull/433);
deployment and scientific remediation are not claimed complete.
**Implementation inventory date:** 2026-09-11
**Scope:** [Phase 0 steps 1–8](README.md#phase-0-policy-and-remediation), retaining
the existing step 8 notices. This is not a fresh review of STAC standards or
the full historical source census in the parent design.

Phase 0 supplies persisted annotations, conservative lifecycle handling, pure
readiness/policy contracts, and an offline audit. It does **not** implement a
STAC builder, read model, public schema, route, discovery link, or native public
wire change. Existing native publication remains available for records that
are not future STAC candidates. Implementation of remediation tools is not
evidence that the catalog has been scientifically curated.

## Implementation matrix

| Step | Implemented in this PR | Operational or later gate |
|---|---|---|
| 1. Bounding provenance | [Migration 0054](../../migrations/catalog/0054_metadata_provenance.sql), [canonical row reads](../../functions/api/v1/_lib/catalog-store.ts), [validation](../../functions/api/v1/_lib/validators.ts), [merged PATCH/CAS](../../functions/api/v1/_lib/dataset-mutations.ts), and [source-aware uploads](../../functions/api/v1/_lib/asset-uploads.ts); evidence plus measured/declared-global/imported/inferred/unknown states | Apply migration before code. Review source bounds; an imported world box is not verified global coverage |
| 2. Represented time | Persisted `temporal_semantics` and `temporal_evidence`; represented timestamps validated as a complete interval or equal-endpoint instant; source/time changes invalidate stale assertions | Curate actual represented time. Publication dates, workflow schedule and cadence do not establish it; sidecar automation is not implemented |
| 3. Licensing | [Pure readiness](../../functions/api/v1/_lib/metadata-readiness.ts) parses SPDX expressions, requires evidence per `LicenseRef`, distinguishes `other` text from unverified links | Native license validation stays permissive. Curate rights and later expose required license text/verify public links; no asset fetch or legal verification occurs |
| 4. Identity | `buildMetadataIdentity` uses persisted `origin_node` + dataset ULID for Collection identity, the same dataset ULID for an indivisible Item, explicit persisted keys for frames/revisions | Audit callers must join workflow ownership/immutable identities. No frame/revision history is invented or newly stored |
| 5. Inventory/exclusions | [Offline command](../../cli/metadata-audit.ts) and [pure census](../../cli/lib/metadata-audit.ts) report candidates, exclusions and reason counts; baseline below | Run on an authorized canonical export for a deployed-node census; local bundled data is not that census. Resolve unknown scientific claims individually |
| 6. Stable enrichment join | [Crosswalk](../../public/assets/sos-enrichment-crosswalk.json), [resolver](../../cli/lib/snapshot-crosswalk.ts), [mapper](../../cli/lib/snapshot-import.ts), and [import CLI](../../cli/import-snapshot.ts); no authoritative title fallback; all duplicate operational rows withheld | Review one-time bootstrap candidate pairs in the PR, resolve unmatched identities with evidence; legacy viewer title merge remains for compatibility |
| 7. Node metadata policy | [Decision record](NODE_METADATA_POLICY.md) and [pure contracts](../../functions/api/v1/_lib/metadata-policy.ts) for operator authority, extension registration/field decisions, and plain-JSON vocabulary references | Selected defaults become ratified on maintainer merge approval, not before. Optional private-profile snapshot storage/UI, authenticated approval, schema-byte/runtime validation and public publication remain future work |
| 8. Identity description notice | Retained [CLI help](../../cli/commands.ts), [init-node warning](../../cli/init-node.ts), and [self-hosting upgrade notice](../SELF_HOSTING.md#91-existing-nodes-review-descriptions-before-stac-publication), including SQL bootstrap review/replace/clear guidance | Repeat notice at the Phase 2 publishing release. Direct identity-description precedence is unchanged; no private-profile approval gate or well-known wire change |

## Rollout: migration before code

Apply [0054_metadata_provenance.sql](../../migrations/catalog/0054_metadata_provenance.sql)
to the catalog D1 **before deploying Functions code that reads/writes these
columns**. The previous checked-in catalog migration is
[0045_link_provenance.sql](../../migrations/catalog/0045_link_provenance.sql).
The numeric gap is permitted: [check:migrations](../../scripts/check-migrations-additive.ts)
guards destructive statements and new number collisions, not contiguous
numbering. Do not rename existing migrations or insert placeholder migrations
to fill the gap. Wrangler tracks full filenames in its migration ledger.

The migration is additive: three non-null enum columns default to `unknown`,
and two nullable evidence columns default to `NULL`, bounded to 2,048
characters. It deliberately does not backfill scientific assertions from old
bounds, timestamps, globe defaults, titles, or licenses. The
[schema snapshot](../../schema/catalog-schema.sql) also contains the columns;
it is not a replacement for applying migrations on an existing database.
The [deployment workflow](../../.github/workflows/ci.yml) applies catalog
migrations before the new deploy. Forks/manual deploys must preserve that order,
verify the ledger and column presence, and stop rollout if migration fails.

No database migration or remote write is performed by `metadata-audit`. Code
rollback must not drop these additive columns or discard evidence. Older
writers do not enforce the new invalidation policy; avoid source changes through
them and re-audit affected records before trusting their annotations again.

## Publisher annotations and remediation

Use the existing authenticated `PATCH /api/v1/publish/datasets/:id` with the
persisted dataset ID and normal dataset-edit authorization. The CLI equivalent
is `npx tsx cli/terraviz.ts update <id> <body.json>`; unlike the audit command,
this is a configured, authenticated **network write**. Review the current row
and its actual source before submitting. The request uses **snake_case**, not
native public response spellings such as `boundingBox`, `startTime`, or
`originNode`.

| PATCH field | Accepted meaning |
|---|---|
| `bounding_box` | Complete `{ "n": number, "s": number, "w": number, "e": number }`, or `null` to clear; persists as `bbox_n/s/w/e`. West greater than east is permitted for antimeridian crossing |
| `bbox_provenance` | `unknown`, `measured`, `declared_global`, `imported`, `inferred`; `null` resets to `unknown` |
| `bbox_evidence` | Nullable source/curator text, at most 2,048 characters; every non-unknown bounding assertion needs nonempty evidence and complete valid bounds |
| `start_time`, `end_time`, `period` | Existing native time/cadence fields; cadence alone is not temporal extent |
| `temporal_semantics` | `unknown`, `represented`, `publication`, `schedule`; `null` resets to `unknown` |
| `temporal_evidence` | Nullable text, at most 2,048 characters; `represented` requires nonempty evidence and two real UTC timestamps, ordered start ≤ end; equal endpoints represent an instant |
| `resource_kind` | `unknown`, `product`, `presentation`; `null` resets to `unknown`. A recognized image/video format does not by itself prove a scientific product |

Illustrative PATCH body for an **already reviewed hypothetical source**; the
coordinates, dates and evidence below are not curation of any baseline dataset.
Replace them with the actual source-bound findings, or leave claims unknown:

```json
{
  "bounding_box": { "n": 90, "s": -90, "w": -180, "e": 180 },
  "bbox_provenance": "declared_global",
  "bbox_evidence": "Example only: reviewed source specification explicitly declares whole-Earth coverage; record the real source version and review here.",
  "start_time": "2026-09-01T00:00:00Z",
  "end_time": "2026-09-02T00:00:00Z",
  "temporal_semantics": "represented",
  "temporal_evidence": "Example only: reviewed acquisition/valid-time metadata gives this represented interval, not the upload date or run schedule.",
  "resource_kind": "product"
}
```

`declared_global` requires exactly `n=90, s=-90, w=-180, e=180`; a world-shaped
texture alone is not evidence. `imported`/`inferred` bounds remain review-only
for readiness even when valid native annotations. Evidence is bounded text, not
a URL-fetch instruction or proof that an authenticated curator's claim is true.
Unknown coverage stays unknown, not a synthesized whole-world box.

To withdraw assertions while retaining the existing numeric bounds/times:

```json
{
  "bbox_provenance": "unknown",
  "bbox_evidence": null,
  "temporal_semantics": "unknown",
  "temporal_evidence": null,
  "resource_kind": "unknown"
}
```

Omitted fields normally preserve stored values. An exception is invalidation
when their source facts change. PATCH is validated against the **merged stored
row**, so clearing evidence alone cannot leave an unsupported asserted state.

### Source lifecycle and conflict recovery

- Changing `bounding_box` resets bounding provenance/evidence unless explicitly
  renewed in the same PATCH. Changing `start_time`, `end_time`, or `period`
  similarly resets temporal semantics/evidence. Retaining the enum alone cannot
  inherit old evidence after a fact change: resupply the evidence (it may be
  the same text only when it really applies).
- An actual publisher `data_ref` or `format` change resets both source-bound
  annotation groups and `resource_kind` unless explicitly renewed, and clears
  old source/content digests. No-op values and unrelated edits preserve facts.
- Replacement video/frame upload stamps and direct R2/Stream data applies
  atomically clear source-bound bbox/time facts for a different or unverified
  attached source. Verified same-source/content digests preserve them, as does
  first attachment to an empty ref with both digests null. Uploads within the
  existing product preserve `resource_kind`; representation-only transcode
  completion preserves facts. Failure, rollback or abandonment does not
  resurrect facts already cleared by a replacement stamp. A same-source
  re-encode/rollback retains the untouched old facts.
- While `transcoding === 1`, explicit non-unknown `bbox_provenance`,
  `temporal_semantics`, or `resource_kind`, and nonempty evidence edits, reject
  with **409 `transcoding_in_progress`**, including same-value reaffirmations.
  Unknown/null/blank clearing is allowed if the resulting merged state is
  valid. Do not assert facts against an in-flight source that may roll back.
- Metadata PATCH uses an atomic optimistic comparison of the read source,
  format, digests, transcode/active-upload/frame state, bounds, times and
  annotations. A concurrent stamp or metadata change cannot attach stale
  evidence: the race returns **409 `concurrent_update`** (or the existing
  source/format transcode conflict). Reload, wait for the source to settle,
  review that source, then retry; do not blindly replay a stale assertion.
- Raw SQL is a **trusted writer boundary**. There is no invalidation trigger;
  SQL cannot distinguish omitted evidence from intentional same-value renewal.
  Operator scripts/future direct writers must explicitly clear or renew
  source-bound facts. Prefer the publisher mutation path.

Workflow metadata templates do **not** allowlist the five new annotation fields
or `cycle_evidence`. Existing workflow sidecars can supply native bounds/times,
but do not automatically assert verified represented time or global coverage.
Clock arithmetic, `valid_iso`, frame timestamps, and a workflow schedule are
not source evidence by themselves. Source-bound sidecar automation needs future
lifecycle coordination; do not add unsupported template keys as a workaround.

## Offline audit contract

With dependencies already installed, run from the repository root:

```text
npx tsx cli/terraviz.ts metadata-audit --snapshot
npx tsx cli/terraviz.ts metadata-audit --snapshot --strict
npx tsx cli/terraviz.ts metadata-audit --snapshot --list=local-list.json --enriched=local-enriched.json --crosswalk=local-crosswalk.json
npx tsx cli/terraviz.ts metadata-audit catalog-export.json --strict
```

The custom filenames are operator-supplied local inputs, not files
created by the command. Snapshot defaults are the committed
[operational source](../../public/assets/sos-dataset-list.json),
[enrichment source](../../public/assets/sos_dataset_metadata.json), and
[crosswalk](../../public/assets/sos-enrichment-crosswalk.json), resolved from the
working directory. The operational source accepts `{ "datasets": [...] }` or
a bare array; the enrichment source is an array. Crosswalk mode validates its
version/provenance/mappings contract. It never regenerates mappings on import.

Canonical-export mode accepts a **bare JSON array of D1-shaped rows**, not a
native `WireDataset` response, `{ "datasets": [...] }` envelope, SQL dump, or
Wrangler result envelope. Each row must at least have string `id` and
`origin_node`; missing assertions remain unknown, and invalid persisted identity
values become readiness reasons. Select the relevant typed fields below from
an authorized export, retaining nulls rather than inventing values:

| Input fields | Shape and authority |
|---|---|
| `id`, `origin_node`, `legacy_id`, `schema_version`, `format`, `celestial_body`, `resource_kind` | Persisted canonical identity/classification; `schema_version` numeric when present |
| `bbox_n`, `bbox_s`, `bbox_w`, `bbox_e`, `bbox_provenance`, `bbox_evidence` | Canonical numeric corners and annotation strings/nulls; **not** PATCH `bounding_box` |
| `start_time`, `end_time`, `temporal_semantics`, `temporal_evidence` | Canonical represented-time inputs; create/update/publish timestamps are never fallbacks |
| `license_spdx`, `license_statement`, `license_url` | Canonical license strings/nulls |
| `frame_count` | Persisted positive safe-integer sequence count when present |
| `publication_kind`, `workflow_id` | **Caller enrichment, not new columns:** `indivisible`, `sequence`, `workflow`, or explicitly unresolved `unknown`; join workflow ownership instead of assuming every mutable workflow is an indivisible product |
| `item_identity` | **Caller enrichment:** `{ "kind": "one_item" }`, or `{ "kind": "frame", "persisted_id": "actual-stored-immutable-key" }` (use `revision` instead of `frame` for a workflow revision) |
| `curated_license_evidence` | **Caller enrichment:** object keyed by each exact parsed `LicenseRef` leaf, with `{ "statement": "...", "url": "..." }` evidence (at least one usable value per reference) |

The parser rejects wrong field types; semantic gaps are reported per row.
Unknown annotations are ignored, not promoted into facts or echoed wholesale.
Caller enrichment is not persisted by this CLI, not accepted as new native
dataset columns, and not exposed by the public wire. The caller is responsible
for truthful joins and immutable key provenance; a string passing syntax checks
does not prove that a frame/revision exists in storage.

For example, this **synthetic canonical-export shape** intentionally leaves
scientific claims unknown. The IDs are illustrative, not baseline D1 records;
use real persisted IDs and joined facts in an actual export:

```json
[
  {
    "id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "origin_node": "example-node",
    "schema_version": 1,
    "format": "image/png",
    "resource_kind": "unknown",
    "bbox_n": null,
    "bbox_s": null,
    "bbox_w": null,
    "bbox_e": null,
    "bbox_provenance": "unknown",
    "bbox_evidence": null,
    "start_time": null,
    "end_time": null,
    "temporal_semantics": "unknown",
    "temporal_evidence": null,
    "license_spdx": null,
    "license_statement": null,
    "license_url": null,
    "publication_kind": "unknown"
  }
]
```

Identity is case-preserving `origin_node + "-" + dataset ULID` for a Collection.
The indivisible Item reuses exactly that ULID. Frame/revision Items require a
persisted key and use `datasetULID-frame-key` / `datasetULID-revision-key`.
No slug, current host name, timestamp, transient frame index or arbitrary new
UUID substitutes for persisted identity; this phase creates no revision history.

The command dispatches **before config/credentials/client setup**. It performs
no database, asset, credential, or network reads, writes no files, and always
prints JSON. Only local regular JSON files are accepted; URL/UNC inputs and
unsupported options (including audit `--server`/`--json`) are rejected. This
offline guarantee describes the installed command, not an `npx` dependency
download if dependencies have not been installed.

- Exit **0**: valid input, report produced; non-strict runs can contain unresolved
  records. Strict runs require no exclusions/unresolved rows or snapshot skips/
  unmatched/ambiguous/invalid crosswalk findings.
- Exit **1**: `--strict` with excluded or unresolved records or those snapshot
  findings. This is an expected result for the baseline below.
- Exit **2**: invalid invocation, unreadable/nonlocal/non-JSON input, malformed
  JSON, or invalid canonical input shape. A well-formed snapshot whose crosswalk
  has semantic findings produces an audit report, not automatically exit 2.

Decisions are `item_candidate`, `collection_candidate`,
`standalone_item_candidate`, `excluded`, and `needs_review`. Known space+time
can yield an Item candidate; known space only a Collection candidate; known
represented time with genuinely unknown space a standalone Item candidate.
All require the other identity/resource/license gates. Imported/inferred
bounds or malformed represented-time claims require review, not silent omission.
Presentation and non-Earth records are excluded initially, not deleted natively.

SPDX expressions are parsed strictly (including AND/OR/WITH). Malformed SPDX
never falls back to a statement. Every `LicenseRef` needs separate curated
evidence and is assessed as `other`. Text-only `other` may be candidate-ready
with `license_text_asset_pending`; a syntactically safe HTTP(S) license URL
remains `license_link_unverified`. These caveats do not alone force strict
failure for an otherwise candidate-ready row. Strict success is **not** STAC
schema validation, public link verification, rights verification, access-control
approval, or authorization to publish. Future routes must separately enforce
published/public/hidden/retracted policy and validate actual resources/assets.

## Checked-in baseline

Recomputed locally on 2026-09-11 using the pending Phase 0 mapper/audit. These
are **bundled snapshot** measurements, not a deployed D1 census or scientific
curation. Denominators differ intentionally:

| Measurement | Count |
|---|---:|
| Raw operational / enrichment rows | 204 / 520 |
| Unique crosswalk mapping pairs | 136 |
| Raw operational rows covered by those pairs | 137 |
| Raw rows unmatched / ambiguous groups / invalid crosswalk records | 67 / 0 / 0 |
| Retained mapped drafts / skipped raw rows | 194 / 10 |
| Retained drafts receiving enrichment | 131 |
| Audited mapped rows excluded / needing review | 29 / 165 |
| Item / Collection / standalone Item candidates | 0 / 0 / 0 |

Mapper skips: five missing data links, two unsupported formats, **two** duplicate
ID rows (both `INTERNAL_SOS_766_ONLINE`), one reversed time range invalid after
mapping. The historical 195-draft/9-skip mapper picked the first duplicate;
Phase 0 withholds both. One crosswalk pair still covers the two raw duplicate
occurrences, explaining 136 pairs versus 137 raw matches; skipped rows do not
contribute to the 194-row readiness census or 131 enriched retained drafts.

| Readiness inventory/reason | Rows among 194 mapped drafts |
|---|---:|
| Non-Earth exclusions (`resource_non_earth_excluded`) | 18 |
| Presentation/tour exclusions (`resource_presentation_excluded`) | 11 |
| Unknown resource kind (`resource_kind_unknown`) | 183 |
| Unknown spatial extent (`spatial_unknown`) | 171 |
| Imported bounds needing review (`spatial_imported_requires_review`) | 23 |
| Unknown represented time (`temporal_unknown`) | 194 |
| `other` license with future text asset needed (`license_text_asset_pending`) | 194 |
| Missing persisted dataset/node identities (`identity_dataset_ulid_invalid`, `identity_origin_node_invalid`) | 194 each |

Reasons overlap and include excluded rows; they must not be summed as mutually
exclusive outcomes. No mapped row has a verified represented instant/interval,
SPDX license, or persisted D1 identity in this local source. The importer records
explicit source bounds as `imported`, source timestamps as unverified/unknown,
tours as `presentation`, and other resource kinds as `unknown`. No assertion of
measured coverage, scientific product status, or licensing rights is invented.

### Crosswalk maintenance and remaining remediation

The one-time [bootstrap script](../../scripts/snapshot-crosswalk.ts) uses unique
normalized-title candidates to output stable operational-ID → exact SOS catalog
URL pairs for PR review. Source hashes identify its inputs; they are provenance,
not a runtime freshness gate invalidated by harmless title edits/reordering.
Pairs are reviewed as migration candidates, **not scientifically verified**.
The authoritative importer uses only the persisted pairs. Missing mappings keep
operational metadata without enrichment; invalid/ambiguous crosswalks stop the
import before API access. Duplicate operational rows are all withheld.

`npx tsx scripts/snapshot-crosswalk.ts --validate` checks the committed mapping;
`--bootstrap` prints new candidates to stdout without writing files. Review any
new output, resolve exact source identities, and apply selected pairs explicitly;
never regenerate a live join on each import or use fuzzy/first-wins fallback.
`import-snapshot --crosswalk=<path>` selects an alternate reviewed mapping.
Its `--dry-run` is not the offline audit: the importer uses configured catalog
access for idempotency/planning. `--update-existing` is a bounded backfill, not
general scientific remediation; it now includes bounding provenance/evidence
and can replace a curated assertion with imported source evidence. Inspect that
plan carefully and use targeted PATCHes for reviewed corrections.

The [viewer data service](../../src/services/dataService.ts) still merges by
title and synthesizes display fallbacks for legacy compatibility. Do not treat
that runtime object or the native public response as authoritative audit input.
For actual remediation: export authorized canonical rows with required joins,
inventory unknowns/exclusions, verify source identity, bounds, represented time
and license evidence, patch only supported claims after uploads settle, then
re-export/re-audit. Keep unsupported records native-only rather than manufacturing
coverage/time/license facts to improve the candidate count.

## Policy and next-phase boundaries

[NODE_METADATA_POLICY.md](NODE_METADATA_POLICY.md) is the step 7 implementation
decision record: **ratification pending maintainer merge approval**. It chooses
`operator.manage` (admin/service), two distinct operator principals for optional
new disclosure, immutable reviewed selections, removal-only revocation, and
bounded future caches. Pure extension/vocabulary contracts validate supplied
inputs; they do not authenticate evidence or fetch/validate schema bytes, store
registries, publish profiles, or authorize extension emission.

The [issue #428 clarification](README.md#migration-roadmap) remains intact:
`node_identity.description` is intended public metadata read directly for the
future root, not private prose behind snapshot approval. Optional mission/about
publication storage and UI do not block identity-only Phase 1. Existing anonymous
org-name/logo behavior and the well-known response remain unchanged. Repeat the
step 8 review/replace/clear notice before Phase 2 exposes existing descriptions.

Keep [Phases 1–5](README.md#phase-1-pure-projection) separate: Phase 1 pure
projection/read models/local schemas/fixtures; Phase 2 first public core-resource
routes/schemas/discovery; Phase 3 richer atomic resources; Phase 4 tested API
conformance; Phase 5 federation integration. Phase 0 candidate checks do not
complete any of these phases or change the existing issue #428 decisions.