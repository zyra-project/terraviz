# Phase 0 decision record

**Status:** Implementation decision for review; effective when PR merged
**Decision date:** 2026-09-11
**Scope:** Phase 0 step 7 — public-profile selection and permissions,
node-owned extensions, and node-local vocabulary declarations (issue #428).

These are **chosen defaults submitted for maintainer approval**, not a claim
that maintainers have already ratified them. The PR may mark step 7's decision
record and executable input-contract work complete, **ratification pending
merge**. Merge ratifies this policy; it does not complete the other Phase 0
steps or authorize public exposure. This record resolves the proposed decisions
in the [metadata design](README.md#node-owned-extensions), including its
[private-profile](README.md#node-profile-and-publication-policy) and
[vocabulary](README.md#node-local-vocabularies) sections. It does not amend the
federation handshake, feed, signing, or native wire protocol.

## 1. Authorization and approval evidence

Use the existing **`operator.manage`** capability, via `roleCan`, for authoring,
approving, replacing, or revoking these node-level policy records. There is no
`node.profile.manage` capability. The actual
[role matrix](../../src/types/publisher-roles.ts) grants `operator.manage` to
**`admin` and `service` only**. `editor`, `author`, `contributor`, and `reviewer`
cannot perform these operations. In particular, the role named `reviewer` is
read-only; “reviewer” in an approval record means an approving actor, not that
role. Existing content publish/edit capabilities do not grant policy authority.
This matches the [current profile PUT](../../functions/api/v1/publish/node-profile.ts)
through `isPrivileged` → `roleCan(role, 'operator.manage')`.

New optional publication requires a **two-actor review**: author and approving
actor must have different authenticated principal IDs, and each must hold
`operator.manage`. A service principal is allowed, preserving the existing
matrix; two tokens for one principal do not constitute two actors. An operator
without a second authorized principal can keep using identity-only publication.
Do not weaken the gate just to enable the optional profile enhancement.

The executable evidence shape is exactly:

```typescript
{
  authorId: string, authorRole: Role,
  reviewerId: string, reviewerRole: Role,
  changeId: string, reason: string
}
```

IDs/change ID are nonempty, trimmed strings of at most 128 UTF-16 code units;
reason is nonempty, trimmed, at most 1,000 units. Control characters are
forbidden. Roles must be canonical values from the actual shared matrix.
`approval: null` explicitly means not approved; absence, boolean approval, or
unknown evidence fields is invalid. The pure code imports the shared `Role`
under the local name `PublisherRole`, not a server account/storage type.

**Evidence is not authentication.** Later write handlers must derive active
principal IDs, roles, ownership authority, and approval from authenticated
server context, not trust role strings in submitted JSON. They must bind
`changeId` to the exact reviewed content, persist the author/approver, private
UTC review timestamp and content digest, and recheck current capability on
every operation. Evidence shape validation does not verify signatures, remote
ownership, human independence, schema hashes, or whether review actually occurred.
Audit identities/reasons are operator-only, never public descriptor fields.

## 2. Private profile: optional immutable publication snapshots

**Decision:** implement the optional enhancement later as a separate,
versioned public selection, never as a view of the mutable private profile row.
There are **no approval defaults for existing private values**. Selecting a
checkbox or saving the private draft does not publish anything. A preview shows
exactly the selected field values, individual links and their purposes, derived
root description, provider URLs, and public about content before review.

Future snapshots have `{ nodeId, revision, selectedValues, approval }` with a
monotonically increasing positive safe-integer revision. Store immutable copied
values, not references back to mutable draft columns. Publish the whole reviewed
selection in one atomic transaction with an optimistic expected-revision check;
write its audit record and advance the public pointer in the same transaction.
The stored review binds the complete selection. Any selected field value,
selection, or link-purpose change requires a new review and new revision.
Private draft edits leave the published revision and its ETag unchanged.

### Selection allowlist and exact bounds

| Optional private value | Public meaning | Limit |
|---|---|---|
| `mission` | Root description fallback | 1,000 UTF-16 code units |
| `about_md` | Sanitized public about page and plain-text description fallback | 10,000 units; derived summary at most 600 Unicode code points |
| `region_focus` | Organizational-interest prose on approved about page only | 200 units |
| Individually selected links | Explicit `organization`, `about`, or `related` purpose | At most 10; label 100 units; URL 2,048 units; at most one organization and one about link |

Selections contain only allowlisted, nonempty values; omitted fields are not
published. An empty selection is valid and represents withdrawal of all optional
private fields. Whole selection serialized JSON is bounded to **32,768 UTF-8
bytes**, including keys and values. Reject unknown fields, not just unknown UI
checkboxes. `default_tone`, `updated_by`, audit/review identities, private update
timestamps, credentials, and arbitrary profile keys are never selectable.

Revalidate public link syntax: absolute HTTP(S), no credentials, whitespace,
backslashes, or controls. Require anonymous reachability before advertising
about/icon/organization resources; URL syntax alone is not proof. Link purpose
is chosen by an operator, never guessed from a label or URL pattern. Sanitize
Markdown/HTML on public rendering; no embedded HTML execution. The 600-code-point
summary is deterministic plain text without markup or partial surrogate pairs.
No automatic geocoding of `region_focus`, and no inference of scientific extent,
license, producer, processor, or licensor from organization prose.

### Compatibility and independent identity metadata

- Preserve the existing anonymous `{ profile: { orgName, logoUrl } | null,
  features }` response and its existing editing/logo behavior. No new approval
  gate is retroactively imposed on these already-public fields.
- Preserve existing public org name (up to 200 units) for verified host
  attribution; do not rename a node Catalog or any dataset identity. A local
  host is listed at most once, last, only for actually hosted data. An index-only
  mirror retains origin provider facts. An unresolved logo is omitted; optional
  MIME type comes from verified asset metadata, not a guessed filename.
- Root description precedence: nonempty intended-public
  `node_identity.description` → approved `mission` → bounded approved
  `about_md` summary → deterministic generic node/public-org-name fallback.
  The separate upgrade review/clear notices for identity description still
  apply before a publishing release. Do not expose that column in the native
  well-known response as part of this policy.
- **No snapshot is a fully supported state. Phase 1 is not blocked by snapshot
  storage, review UI, or profile publication.** Identity/generic root projection
  can proceed independently. Never fill a missing approved field from the draft.

### Revocation, cache and version rules for the future surface

Any active `operator.manage` actor may immediately revoke selected fields (or
the entire optional selection), without waiting for a second actor. Removal is
not a new disclosure. Record actor/reason and create a **new** immutable revision
containing only the still-approved copied values, with a new revocation event;
never roll back to an older public snapshot. Re-publication requires fresh
two-actor review. Retain withdrawn snapshots for private audit only; public
revision URLs must not keep serving withdrawn content.

Choose an **absolute 300-second maximum staleness from revocation**, across
root resources, derived Collection providers, and public about resources.
Later implementation must enforce a shared absolute freshness deadline anchored
to an authoritative approval/revocation read: application caches expire within
**60 seconds**, CDN/browser responses have `max-age` and `s-maxage` no greater
than **60 seconds**, and must use the *remaining* freshness budget, not restart
it at each cache hop. A stale `304` must not reset that deadline. Disable
`stale-while-revalidate`, `stale-if-error`, and offline/service-worker persistence
for richer profile resources. Purge all affected application/CDN keys on
publication/revocation but never rely on successful purge for the bound.

If approval state cannot be refreshed within its absolute deadline, omit all
optional private-profile-derived fields and serve identity-only with `no-store`;
do not reuse stale approvals. ETags include the published selection revision,
serialized public identity/description, already-public branding, and other actual
response inputs, never private draft timestamps. Test layered caches, failed
purges, revocation racing regeneration, `304`, origin errors, and about URLs
before enabling the feature. This bound covers caches the service controls,
not copies an external client has already downloaded. Existing lean native
orgName/logo caching is unchanged; do not add private fields to that endpoint.

## 3. Node-owned extension registration

**Decision:** institution fields belong to an independently owned, immutable
schema identity. Native APIs gain no property bag. Registration is a trusted
operator workflow, not an arbitrary remote-schema fetch by a serializer.

The exact executable internal registration shape is:

```typescript
{
  prefix: string,
  ownerNodeId: string,
  schemaUri: string,
  version: string,
  schemaSha256: string,
  scopes: ("Catalog" | "Collection" | "Item" | "Asset")[],
  fields: { key: string, scopes: ("Catalog" | "Collection" | "Item" | "Asset")[] }[],
  maxPayloadBytes: number,
  approval: MetadataReviewEvidence | null
}
```

All keys are required, unknown keys rejected, and no coercion/default approval
occurs. A valid unapproved registration is retainable input, not export permission.

| Property | Chosen rule |
|---|---|
| Owner | Persisted stable node ID matching `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`, the same namespace contract as [metadata readiness](../../functions/api/v1/_lib/metadata-readiness.ts). Preserve case exactly, including uppercase IDs minted by `newUlid`; never lowercase. Not a display name, institution label, hostname, or email. Later adapters compare it to the authenticated/curated owner record. |
| Prefix | `[a-z][a-z0-9]{1,15}`; 2–16 characters, case-sensitive. Reserve `terraviz`, `sci`, `file`, `proj`, **and `core`**. Adopted standard/project fields use their own reviewed serializers, never this node-registration path. |
| Field key | Exact `prefix:local_id`; local ID `[a-z][a-z0-9_-]{0,63}`. Unprefixed keys are forbidden, categorically preventing core identity/geometry/license/access overrides. Also reject `constructor`, `prototype`, and `__proto__` as local IDs or JSON object keys. |
| Schema URI | Absolute canonical HTTPS, ≤2,048 UTF-16 units, no credentials/query/fragment/whitespace/backslash, `new URL(uri).href === uri`; suffix exactly `/v{version}/schema.json`. No `latest` or mutable query-version aliases. |
| Version | Exactly three nonnegative decimal integers, each 1–6 digits, no leading zero except `0`; no prerelease/build suffix. |
| Digest | `sha256:` plus exactly 64 lowercase hexadecimal digits; digest of exact reviewed schema bytes, not a reserialized JSON object. |
| Scope | Nonempty unique subset of Catalog/Collection/Item/Asset. Each field has its own nonempty unique subset of registration scopes. Item fields go in `properties`; Asset fields belong to the Asset and declare the schema on their parent resource. No arbitrary dotted paths. |
| Allowlist | 1–64 distinct fully qualified field keys; 0–32 active registrations, exactly one active version per prefix. |
| Payload | Per registration integer 1–16,384 UTF-8 JSON bytes, including field keys; complete registration ≤32,768 bytes. Later serializer enforces the sum of all fields from that extension across one containing resource, including all its Assets. |

Identity is `(ownerNodeId, prefix, versioned schema URI)`, never prefix alone.
Reject any active prefix collision, even when versions differ; do not pick the
first, rename, merge, or reinterpret source fields. Across versions the same
prefix retains its stable owner and schema base URI. Schema bytes, field
allowlists, scopes and payload bounds at an existing URI are immutable; change
them only under a new version/URI/digest with renewed approval. Approval or
revocation is a separate state transition, not a schema-content edit.

Renaming an institution or moving its deployment preserves the node ID and
schema URI; keep immutable schema hosting available at the old URI. There is
**no automatic owner transfer or URI migration**. A genuine replacement owner
or lost URI requires a new prefix/schema identity and explicit remapping review;
old identities remain reserved, not silently reassigned. Retain the complete
identity ledger, including withdrawn versions, for collision checks.
`validateExtensionRegistry` accepts up to 1,024 historical registrations per
call; a future larger ledger must check all batches and active collisions,
never truncate history. Registry lookup/storage is not implemented here.

### Strict field-decision contract

`decideExtensionField` takes exactly `{ key, value, scope, ownerNodeId,
essential }` and a registry. `ownerNodeId` identifies the **extension's owner**,
which may be the resource's origin rather than the local hosting node.
`essential` is explicit curated interpretation metadata, not guessed from a
value and not a user-controlled escape hatch. Every rejection has a bounded
machine-readable operator reason code; results never echo private field values.

| Input | Executable decision |
|---|---|
| Unknown prefix or null approval, nonessential field | `omit`, reason `unknown_prefix` / `extension_unapproved` |
| Same omission but essential to interpretation | `withhold` the affected resource |
| Core/reserved key, invalid JSON, invalid context, namespace/owner collision, disallowed scope/key, or oversized value | `withhold`, even if nonessential |
| Approved, allowlisted, bounded field at correct scope/owner | `validate_with_serializer`, reason `schema_validation_required` — **not permission to emit** |

The future serializer must validate the combined extension payload and full
resource against a locally available pinned schema and its pinned references,
enforce aggregate limits and cross-field requirements, and reject invalid
values. Only then may it emit fields and declare the exact schema URI once on
the containing Catalog/Collection/Item. No fields means no declaration. Missing
validated schema means omit optional fields with an operator reason; if an
omitted field is essential, withhold. Invalid schema/value means withhold. A
node cannot use these contracts to override core fields or visibility filtering.
Unknown peer data stays in its authorized source/origin representation; retain
the origin link and namespace, without claiming a lossless public round trip.

**No schema fetching or runtime schema validation is implemented here.** Digest
format checking is not digest verification. Later schema ingestion must pin and
verify all referenced bytes, disallow network resolution during validation,
bound total schema bytes to 1 MiB, reference documents to 32 and reference depth
to 8, and reject unresolved/cyclic reference expansion. Prefer vetted operator
bundles; any future network ingestion requires separate SSRF/redirect/timeout
design and tests. Public schema hosting and actual Terraviz/standard extension
adoption are Phase 1/2 work, not enabled by this record.

## 4. Node-local vocabulary: plain JSON, not JSON-LD

**Decision:** use a strict plain-JSON versioned descriptor. No `@context`,
JSON-LD expansion, remote context loading, inferred `sameAs`, or optional project
starter vocabulary in this rollout. Existing free-text categories and keywords
remain valid native data, explicitly unaligned until curated. No retroactive
project-wide controlled vocabulary is imposed.

The internal reviewed descriptor has exactly this shape (TypeScript notation
describes the JSON contract; it is not a public JSON Schema or public route):

```typescript
{
  formatVersion: 1,
  vocabularyUri: string,
  ownerNodeId: string,
  revision: number,
  facets: [{
    id: string,
    labels: [{ language: string, label: string }],
    definition: string,
    terms: [{
      id: string,
      labels: [{ language: string, label: string }],
      definition: string,
      mappings: [{ relation: string, conceptUri: string }]
    }]
  }],
  approval: MetadataReviewEvidence | null
}
```

Use a canonical HTTPS vocabulary URI (same 2,048-unit syntax restrictions as
schema URIs, without the schema-version suffix requirement) and stable owner
node ID under the same case-preserving namespace contract as extension owners;
descriptor, reference, and field-decision owner comparisons are case-sensitive.
Revision is a positive safe integer, independent of `formatVersion`.
Facet and term IDs match `[a-z][a-z0-9_-]{0,63}`, exclude the dangerous keys
listed above, and are unique across **all** facets and terms in one descriptor.
Concept identity is `(vocabularyUri, termId)`; labels never determine identity.
Changing labels/translations/definitions/mappings increments revision while
retaining IDs for unchanged concepts. An ID must not move to another facet,
change from facet to term, or be reused for a different meaning. Retain removed
IDs in a private tombstone ledger; meaningful semantic replacement needs a new
ID. The pure previous-revision check detects structural repurposing, not whether
new prose secretly changes meaning or reuses a long-removed ID. Curator review
and the future full historical ledger must enforce those additional rules.

Bounds: **1–32 facets**, **1–512 terms per facet and 512 terms total**,
**1–8 labels** per facet/term, **1–200 units** per label, **1–2,000 units** per
definition, and **0–16 mappings** per term; entire descriptor ≤**262,144 UTF-8
JSON bytes**. Text is trimmed/nonempty with no control characters. Language
tags are a deliberately restricted lowercase profile
`(?:und|[a-z]{2,3})(?:-[a-z0-9]{2,8}){0,3}`, unique per label list; not a claim of
full BCP 47 registry validation. Definitions are plain prose in the descriptor's
curatorial language; multilingual labels are explicit. JSON nesting is bounded
to **16**, with at most **32,768 visited nodes** per byte-bound check. Arrays
must be dense, numbers finite, and inputs inert JSON data (not JavaScript
proxies/accessors/custom objects).

Mappings use exactly these **SKOS relation URI strings**, not bare property
names or new semantic predicates:

| URI | Meaning, from this local term to the target |
|---|---|
| `http://www.w3.org/2004/02/skos/core#exactMatch` | Curated equivalent concept for discovery |
| `http://www.w3.org/2004/02/skos/core#broadMatch` | Target is broader than the local term |
| `http://www.w3.org/2004/02/skos/core#narrowMatch` | Target is narrower than the local term |
| `http://www.w3.org/2004/02/skos/core#relatedMatch` | Related, explicitly not equivalence |

Targets are canonical absolute HTTP(S) concept URIs ≤2,048 units; fragments are
allowed, credentials/query/whitespace/backslashes are not. HTTP identifiers are
permitted because established vocabularies use them; no URI is fetched or
rewritten to HTTPS. One target URI may occur at most once per term, prohibiting
duplicate/conflicting relations to that target. New/changed mappings require
the same two-actor operator review and a new revision; empty `mappings: []`
means explicitly unaligned. A descriptor with null approval is retainable but
must not support a public alignment claim.

### Detached and mixed-origin resources

The internal per-resource reference array has 0–64 entries of exactly
`{ vocabularyUri, ownerNodeId, revision, facetId, termIds }`, with 1–512 distinct
term IDs per entry. Each reference resolves to a supplied approved descriptor
with matching URI, revision, owner, facet and terms. Duplicate URI/revision/facet
entries, conflicting descriptor identities, and unknown terms fail validation.
Multiple revisions of the same vocabulary and multiple origin nodes are allowed;
equal labels remain separate. `validateVocabularyReferences` accepts at most 64
locally supplied descriptors; it never resolves them over a network.

Later detached Collections/Items carrying local facets must preserve these
per-resource identities/revisions. A mixed-origin Catalog must not stamp the
local node's vocabulary over imported data. Core `keywords` may stay lexical;
they do not establish alignment. Curated exact mappings may support a common
discovery filter, never merge dataset identities, facet definitions, counts,
providers, licenses, or extents automatically. Broad/narrow/related mappings
remain distinct; no inferred reverse/transitive equivalence or label/case/
translation/embedding-based alignment is performed.

Later publish an anonymous descriptor **without private `approval` evidence**
and link it and its schema from the root plus per-resource provenance through
a reviewed extension. Exact route/link-relation/extension field names belong
to that published schema design in Phase 1/2; none is fabricated or exposed
here. Published revision content is immutable; retain revisions needed by
resources, or withhold/remove affected claims explicitly on revocation rather
than relabeling them with a newer/local revision.

## 5. Executable coverage versus deferred work

The new [pure policy module](../../functions/api/v1/_lib/metadata-policy.ts)
exports the limits/types/relation vocabulary and:

- `canManageMetadataPolicy`: existing `roleCan` capability check.
- `isCanonicalMetadataUri`: bounded URL syntax only.
- `validateExtensionRegistration` / `validateExtensionRegistry`: strict input,
  evidence, bounds, scope, namespace/owner and supplied-history immutability.
- `decideExtensionField`: deterministic operator reasons and omit/withhold/
  pending-schema-validation decisions, never an emitted STAC field.
- `validateVocabularyDescriptor`: strict plain-JSON shape and optional
  previous-revision checks.
- `validateVocabularyReferences`: exact per-resource provenance resolution over
  supplied approved descriptors, including mixed origins.

All are synchronous and deterministic; no clock, random IDs, environment
reads, global mutable registry, network, or storage. Success returns validated
input data without normalization, and does not freeze it; callers must treat
validated values as immutable or revalidate after edits. These functions are
input-contract validators, **not** executable JSON Schema validators, semantic
mapping proof, or public-export authorization on their own.

The [unit tests](../../functions/api/v1/_lib/metadata-policy.test.ts) cover those
contracts, actual role gates, malformed JSON/URIs/unknown keys, byte/count bounds,
reserved namespaces/core overrides, collisions, supplied-history immutability,
essential omission, approved evidence shape, SKOS relation restrictions,
vocabulary revision/ID preservation, and mixed-origin references without label
merging. They do **not** test profile snapshot storage/publication/revocation,
authentication, hash verification, runtime schema validation, anonymous link
reachability, schema hosting, public serialization, or CDN/cache behavior.

Those are explicit future enabling gates. There are no migrations, public
schema fixtures/routes, serializers, registry persistence, profile APIs, or
federation edits in this step. In particular, **no unapproved private profile
field is exposed and no runtime STAC-schema compliance is claimed**.