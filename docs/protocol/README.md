# Terraviz Protocol Schemas

Machine-readable JSON Schema for the **public wire contract** — the
shapes a non-TypeScript consumer needs to read a Terraviz node
without reading the TypeScript source. This is
[`architecture/federation-scoping.md`](../architecture/federation-scoping.md)
§7 Directive 2 ("pin the wire format publicly") and Phase 0 of
[`WORDPRESS_INTEGRATION_PLAN.md`](../WORDPRESS_INTEGRATION_PLAN.md)
— the WordPress plugin's PHP server-side blocks generate their types
from these instead of hand-rolling them and drifting.

## Where they live and how they're served

The generated schemas are committed under **`public/schema/v1/`**, so
Cloudflare Pages serves them at the stable URL:

```
https://terraviz.zyra-project.org/schema/v1/<file>
```

Committing a generated, served artifact and guarding it with a
drift-check is the same idiom this repo already uses for
`public/privacy.html` (`check:privacy-page`). The canonical location
for **all** protocol schemas, the federation feed's included, is
`public/schema/v1/`.

## The schemas (v1)

| File | Describes | API surface |
|---|---|---|
| [`dataset.schema.json`](../../public/schema/v1/dataset.schema.json) | `WireDataset` — one catalog dataset | `GET /api/v1/datasets/:id`, and each entry of the catalog list |
| [`catalog.schema.json`](../../public/schema/v1/catalog.schema.json) | `CatalogResponseBody` — the catalog envelope | `GET /api/v1/catalog` |
| [`well-known.schema.json`](../../public/schema/v1/well-known.schema.json) | `WellKnownDoc` — node discovery document | `/.well-known/terraviz.json` |
| [`feed.schema.json`](../../public/schema/v1/feed.schema.json) | `FederationFeedBody` — one signed page of the federation feed | `GET /api/v1/federation/feed` |

`catalog.schema.json` and `feed.schema.json` each self-contain the
dataset shape (each `datasets[]` item is the full `WireDataset`
inlined), so every file is independently usable — a consumer needs
only the one it validates against, no cross-file `$ref` resolution.

## How they're generated

Generated from the authoritative TypeScript interfaces by
[`scripts/build-protocol-schemas.ts`](../../scripts/build-protocol-schemas.ts)
(via the `ts-json-schema-generator` **devDependency** — build-time
only, nothing new ships to the runtime):

```bash
npm run gen:protocol-schemas     # regenerate + commit the JSON
npm run check:protocol-schemas   # CI drift guard (in the type-check chain)
```

`check:protocol-schemas` runs in the `type-check` chain and fails if
the committed schemas drift from the types — so the wire format and
its published contract can never silently diverge. If you change
`WireDataset`, `CatalogResponseBody`, `WellKnownDoc`, or
`FederationFeedBody`, regenerate and commit in the same change (and
add a CHANGELOG entry).

**Forks / non-canonical nodes:** each schema's `$id` base defaults to
the canonical origin (`https://terraviz.zyra-project.org/schema/v1`),
which is what the committed files carry. A fork, staging, or partner
node that serves these from its own origin can regenerate with a
matching `$id` by setting the base:

```bash
SCHEMA_BASE_URL=https://terraviz.example.org/schema/v1 npm run gen:protocol-schemas
```

## Design choices

- **`additionalProperties` is left open (defaults to `true`).** The
  wire format evolves **additively** — a consumer validating a
  response against v1 must not reject a payload that carries a newer,
  unknown field. Strict `additionalProperties: false` would make
  every additive field a breaking change for existing consumers.
- **No prose descriptions in the schema (`jsDoc: 'none'`).** The
  schema is the machine contract — field names, types, required-ness.
  Field *semantics* live in
  [`CATALOG_DATA_MODEL.md`](../CATALOG_DATA_MODEL.md); keeping them out
  of the JSON keeps the artifact small and stable (a comment edit
  doesn't churn the contract).
- **Deterministic output (`sortProps`)** so the drift diff is stable.
  That orders the *schema's* properties, not the wire's.
- **Except for signed feed pages, key order, whitespace and byte offsets are not part of
  the contract.** A consumer parses the JSON; a producer that orders
  keys differently is conformant. Promising an order would make every
  new field a contract decision for every producer. Three LSL scripts
  in Second Life are **not conformant readers**, and are supported only
  against a node running this codebase's serializer: they can afford
  only the start of a record, so they read by position. The probe
  kit's globe script reads `id`, `slug`, `title` and `format` from the
  first 1,024 bytes (2,048 in its earliest copies, as in the exhibit's
  globe script's, which no longer reads at all). Copies of the exhibit's
  info script from before it read the exhibit's card (below) read
  twelve text and time fields from before `createdAt`, within the first
  9,000 bytes in the earliest copies and 3,072 in later ones, and a
  video manifest's `duration` and, in all but the earliest, its `id`,
  trusting the duration only when that id is the dataset's, which a
  Vimeo row's manifest replaces with Vimeo's. Those reads are of the
  manifest's first 1,024 to 4,096 bytes. Pointed at a node that orders
  keys differently, they can miss fields. They read under `/api/v1/`,
  so they will meet that prefix's 410 one day whatever is pinned.
  [`dataset-serializer.test.ts`](../../functions/api/v1/_lib/dataset-serializer.test.ts)
  and
  [`exhibit.test.ts`](../../scripts/second-life-exhibit/exhibit.test.ts)
  pin the record's order, and
  [`manifest.test.ts`](../../functions/api/v1/datasets/[id]/manifest.test.ts)
  the manifest's leading keys and a Vimeo manifest's own id, so a
  reorder fails a test rather than a globe. Copies once rezzed can't be updated remotely, so these pins
  stay while old copies may still read this way.
- **The exhibit reads are where an LSL script should read instead:**
  `GET /api/exhibit/v1/datasets/{id}`, `GET /api/exhibit/v1/datasets`
  and `GET /api/exhibit/v1/tags`, small replies within byte budgets
  they state, with their own contract for scripts already rezzed:
  additive only, no field changes meaning, a breaking change gets a
  new path, `/api/exhibit/v2/`, and `/api/exhibit/v1/` stays. Their
  version is their own, outside
  `/api/v1/`, so the 410 this protocol's `/api/v1/` answers once a
  later major version has run its window never reaches a script that
  can't be updated ([`exhibit-reads.ts`](../../functions/api/v1/_lib/exhibit-reads.ts),
  [`SECOND_LIFE_COMPAT.md`](../SECOND_LIFE_COMPAT.md) §9 Phase 2). They
  are convenience reads of nodes running this codebase from October
  2026 on, not part of the federation protocol, and not in
  `public/schema/v1/`. A node without them answers their paths with
  the app's page and a 200, which a script has to tell from a reply.

## Versioning

- **`v1`** is the current major. The path (`/schema/v1/`) and each
  `$id` carry the version.
- **Additive changes** (new optional field, new enum value) ship
  under `v1` without a path bump; note them in
  [`CHANGELOG.md`](CHANGELOG.md).
- **Breaking changes** (rename/remove a field, change a type or an
  existing value's meaning) mint `/schema/v2/` and a CHANGELOG entry
  with a migration note.

## The federation feed

`GET /api/v1/federation/feed` serves a node's **public** catalog to
other nodes, one page at a time. The schema pins the body; the rest of
the contract is here, because a schema cannot carry it.

- **Off unless the node turns it on.** The route answers 404
  `{"error":"not_found"}` unless `FEDERATION_ENABLED` is exactly
  `true`, so a node that never opted in looks like one that predates
  the route. An older deployment may instead return the SPA HTML with
  status 200; readers must check the media type and JSON shape.
- **No feed without an abuse contact.** A node that turns it on must
  also set `FEDERATION_ABUSE_CONTACT` to one plain email address
  (`abuse@example.org`; no display name, no `mailto:`, no list). Until
  it does, the feed answers 503 `abuse_contact_missing`, because a
  peer that finds a problem in a federated record needs someone to
  tell. The address is published as `abuse_contact` in
  `/.well-known/terraviz.json`.
- **Discovery says whether it is live.** `/.well-known/terraviz.json`
  carries `federation: {"feed": true}` only when the switch, contact
  and matching usable signing-key pair pass the same readiness checks
  as the route. This is not a storage-health or rate-limit guarantee.
  `endpoints.feed` names where the feed lives whether or not it is on.
  Both fields are additive and optional on the wire: a reader treats a
  document without `federation` as a node with no feed. The document
  has `max-age=300, stale-while-revalidate=600`, so a cached readiness
  value can remain visible for up to fifteen minutes after a change.
- **Open, and signed.** Anyone may read it; there is no handshake.
  Every 200 carries a detached Ed25519 signature in
  `Terraviz-Signature: v=1, keyid=<node_id>, created=<unix seconds>,
  sig=<base64url>`. The body is RFC 8785 canonical JSON, and the
  signature covers a domain string, `keyid`, `created`, the request
  target (WHATWG URL `pathname + search`) and the SHA-256 of the
  body, so a page cannot be replayed as the answer to another cursor.
  The operator obtains the id and key out of band and pins them;
  unsigned discovery is only a cross-check, never the source of trust.
  A reader verifies against that pinned key and rejects a
  signature older than five minutes or more than a minute ahead.
  [`federation-signature.ts`](../../functions/api/v1/_lib/federation-signature.ts)
  is the reference.
- **Paged by an opaque cursor.** `?since=<cursor>` resumes after the
  last page; `?limit=` takes 1 to 250 (default 100). Any other
  parameter, a repeated one, a malformed cursor or an out-of-range
  limit is a 400. Omit `since` for a full sync: `since=` is invalid.
  New parameters require discovery advertisement before clients send
  them. A reader stores `cursor` and
  sends it back unchanged; its internal encoding is not part of the
  contract, but its wire alphabet is: `^[A-Za-z0-9._~-]{1,512}$`.
  Standard base64 cursors containing `+`, `/` or `=` are not accepted.
  Node ids (`node_id` and `originNode`), dataset `id` values, and
  tombstone and held ids must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`
  (1 to 128 characters, starting with an ASCII letter or digit).
  A page's datasets, tombstones and held ids together must not exceed
  the requested `limit`; the subscriber refuses the whole page otherwise.
- **Settled, not live.** A page holds rows changed up to
  `generated_at`, which trails the clock by 30 seconds so a row
  stamped before commit is unlikely to slip behind the cursor. This
  assumes commits become visible within that settle window; it is not
  a database snapshot or a commit-order cursor. Keep
  asking while `has_more` is true; after that, ask again later with
  the last cursor.
- **Tombstones are ids only.** A public, non-hidden row that is retracted
  arrives as its id in `tombstones[]`, and a reader drops its copy.
  Hidden rows never enter the scan, including rows hidden before
  their first publication. A hidden row, hard delete or move away
  from public visibility leaves no tombstone. To withdraw a dataset
  from subscribers promptly, retract it while it is still public and
  not hidden: a tombstone is the only withdrawal an incremental pull
  carries, and it reaches the first pull made after the 30 s settle
  window. Hide it, if at all, only after peers have pulled. To withdraw
  many datasets at once, retract them too: a sweep that drops most of a
  mirror is refused (below), and tombstones are not counted in it. Run
  periodic full syncs
  by omitting `since`. Do not delete unseen rows immediately: finish
  the full scan, wait the 30 s settle period plus 60 s clock-skew
  allowance (`sweep_after`), then finish an incremental pull
  covering that window before sweeping. A row edited in both windows
  can still be temporarily removed; a later pull restores it. Repeated
  full syncs alone do not apply withdrawals because each replaces the
  pending sweep. Local admin `full: true` explicitly restarts even an
  interrupted full sync; use it to recover `invalid_cursor` failures.
- **Errors** are `{error, message?}` with `Cache-Control: no-store`:
  400 `unknown_parameter` / `duplicate_parameter` / `invalid_query`
  (a query not spelled as plain `name=value` pairs) / `invalid_cursor` /
  `invalid_limit`, 503 `abuse_contact_missing` for a node switched on
  without an abuse contact, and 503 `binding_missing` /
  `identity_missing` / `signing_key_unavailable` for a node not yet
  set up to sign, and 503 `feed_unavailable` for publication/storage
  failures. On a 503, keep the cursor you sent and retry later; a page
  is never skipped by a refusal. GET and HEAD are supported; HEAD has no body. Other
  methods return JSON 405 with `Allow: GET, HEAD`. Unimplemented paths
  such as `/federation/handshake` return JSON 404, not SPA HTML.
  500 `unsignable_row` is a page-level canonicalization failure. Lone
  surrogates become U+FFFD and invalid probing metadata is omitted,
  including nesting beyond 60 levels to reserve space for the feed
  envelope. No CORS access is promised.
- **A row that cannot be served is held.** A public, non-hidden row
  the node cannot serialize is left out of `datasets`, and its id goes
  in `held`. The cursor advances past it, however many such rows a
  page has. `held` is optional and appears only on a page that holds a
  row, so other pages are signed exactly as before. Held ids count
  against `limit` with the rest, and none may also appear in
  `datasets` or `tombstones`. A subscriber keeps its copy of each held
  row unchanged, and its sweep keeps it too. A held id it has no copy
  of adds nothing. The cursor has moved past a held row, so a repair
  reaches a subscriber only if it moves the row's `updated_at` (an edit
  through the publisher API), or at the subscriber's next full sync. A
  serializer fixed by a deploy moves no `updated_at`. After one, touch
  the held rows, or ask peers for one full sync. Until then a subscriber
  keeps the copy from before the row broke, so to take content down,
  retract the row: a retraction needs no serializer and arrives as a
  tombstone. The publisher logs one line per page that holds rows: the
  count, the first ten ids, and the first error's name, never its text.
- **A sweep that would empty the mirror is refused.** A feed that does
  not send `held`, or loses rows some other way, serves pages with rows
  missing. A full sync over them would sweep those rows away. So before
  dropping the rows a full sync did not deliver, a subscriber counts
  what the sweep keeps and drops. It refuses one that keeps nothing or
  drops most of the mirror. The reference subscriber refuses one that
  keeps no row, or drops more than half the mirror and more than five
  rows. So it still lets up to five rows go whatever share they are,
  which on a small mirror can be most of it. A subscriber with a guard
  should also follow these rules, which close the ways past it:
  - **Judge the full sync's own counts too.** Count when the full sync
    finishes as well as when its sweep comes due. Rows delivered in
    between are kept, so the later counts alone can be carried past the
    guard. The full sync's counts miss rows the settle window held back,
    so a sweep they fail must still run once it would drop nothing.
  - **Latch a refusal.** Once refused, a sweep runs only on an
    operator's approval, or once it would drop nothing. It never runs
    because later counts look ordinary.
  - **Bind an approval to its sweep.** Name the sweep's run and the most
    rows it may drop, and let the approval lapse once a full sync
    starts. That is enough because within one run the drop set only
    shrinks: delivered, held and new rows are stamped with the run, and
    a retraction only removes rows. A full sync stamps another run, so
    rows the operator saw as kept could join the drop set.

  The reference subscriber refuses the sweep again on every complete
  pull, until a new full sync completes and replaces it (§Subscriber
  Operations). An approval is how a peer that really withdrew most of
  its catalog is applied.
- **Anonymous-read bounds.** A best-effort per-isolate limiter allows
  600 requests per source IP per minute, before D1 work, then returns
  429 `rate_limited` and `Retry-After: 60`. This is not a global quota:
  configure edge/WAF limits for deployment-wide abuse protection. The
  limiter groups IPv6 addresses by /64 (an IPv4-mapped address counts as
  the IPv4 address it carries) and tracks at most 10,000 buckets
  per isolate, evicting the oldest when full. Cloudflare Worker requests
  to another zone share a source IP and therefore a bucket; configure a
  zone rate-limit rule for deployment-wide control. Requests without
  `CF-Connecting-IP` share one `unknown` bucket (notably off Cloudflare).
  The 600/minute limit still permits substantial D1 load; operators
  should set tighter edge limits for their peers' expected pull rate.
  The `(visibility, is_hidden, origin_node, updated_at, id)` index
  bounds the scan range.

### Signature Bytes And Version Rules

Version 1 uses `keyid === node_id`. It has no rotating key-id namespace;
that requires a v2 contract. Unknown or repeated signature parameters
are rejected. Public keys are canonical 32-byte Ed25519 points encoded
as `ed25519:<padded standard base64>`; operator input may omit padding
or carry surrounding whitespace. Small-order points are rejected.

The body is UTF-8 RFC 8785 canonical JSON, with no BOM or trailing
newline. Verify the received bytes before parsing, then require byte
equality with the canonicalized parsed value. This rejects duplicate
members, changed whitespace and alternate number spellings even when
ordinary JSON parsing would produce the same object.

The Ed25519 message is exactly these five LF-separated lines, with
no trailing LF. `digest` is SHA-256 of the received body bytes,
unpadded base64url, not hexadecimal:

```text
terraviz-federation-signature-v1
keyid=<node_id>
created=<whole Unix seconds>
target=<WHATWG URL pathname + search>
digest=sha-256:<unpadded base64url>
```

Keep the query order and percent-encoding produced by that URL;
do not decode, sort, add an empty `?` or include a fragment. Fragment
data is never sent in HTTP. Signature freshness uses `created`, not
the feed's `generated_at` watermark.

An unsupported page `schema_version` rejects the whole page. A row's
`schemaVersion` identifies the native dataset shape, not the page or
signature version: v1 readers preserve unknown additive row fields.
Changing identity, withdrawal or signature semantics requires a new
major version. Relative `dataLink` URLs resolve against the serving
peer's base URL. A v1 origin feed must set each row's `originNode` to
its own node id; relays are not supported. The join key is
`(originNode, id)` within that peer; rows from different pinned peers
are not silently deduplicated or treated as identical claims.

### Fixed Signature Vector

This uses RFC 8032 section 7.1 test 1's seed
`9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60`
and raw public key
`d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a`.
The body below is one line, literal UTF-8 accented characters, no LF:

```json
{"cursor":"opaque","datasets":[{"colorScale":{"units":"kg m-3","vmax":2e-7,"vmin":0},"id":"sample","originNode":"NODE000","probingInfo":{"nested":[true,null,{"label":"Océan"}]},"title":"Aérosol"}],"generated_at":"2026-09-22T14:13:20.000Z","has_more":false,"node_id":"NODE000","schema_version":1}
```

With `keyid=NODE000`, `created=1790086400` and
`target=/api/v1/federation/feed?limit=25`, its digest is
`qBJOVgfc8lKGhbuCyVFWyrYLjjwohaDJWbIT31jfOpM`. The header is:

```text
Terraviz-Signature: v=1, keyid=NODE000, created=1790086400, sig=FcqWiT3nDEmUhyHN0p2w_kvsWa8uuX9Wtuw5rbC6P_WxSqkjV8hckjOv4YtV1SIQJ7bxNeyp9je96oWMlaDbAQ
```

The vector is pinned in `federation-signature.test.ts` against an
independent Node crypto signer. It tests bytes, not signature freshness
at today's clock.

### Subscriber Operations

The manual admin sync is `POST /api/v1/publish/federation/sync` with
`{ peer_id, full?, page_size?, accept_sweep? }`. It reads one page per
invocation, at most 25 entries (`page_size`: integer 1-25, default 25).
A counted endpoint test includes route reads and audit writes and stays
below 50 D1 statements. Continue invoking without `full` until
`complete`, then use incremental pulls to finish deferred
reconciliation. That loop ends at `reconcile_pending: false`, or at a
`sweep_refused`, which needs a person rather than another call.
Core-library defaults are separately 100 entries times 8 pages; they
are not Free-plan endpoint bounds.

A `result` means a pull ran and may have applied a page. A top-level
`error` means none ran, except 500 `sync_failed`: a store failure can
raise it after a page was applied, though not after a sweep this node
saw complete, which is reported even if recording the pull then fails.
If that last write fails, the peer's `last_sync_at` and
`last_sync_error` keep their previous values; the audit row has the
outcome. 409 `sync_in_progress` is another pull holding
the lease: retry once it expires. 409 `peer_not_active` is a paused or
blocked peer: stop. A pull that fails answers 503 with `result.error`;
most codes are the peer's, but `lease_lost` is this node's. Results are
snake_case, with `upstream_status`, `reconcile_pending` and `held` (rows
the page held). The peer's `last_sync_error` stores the same failure in
kebab-case, with any status appended (`http-status:503`).

A refused sweep answers 409 with `result.error` `sweep_refused` and
`result.sweep_refused: {sweep_id, kept, dropped}`; the page the pull
read is still applied. Do not retry it on a loop. Check the peer first:
compare `kept` with the peer's public catalog, or ask its operator. To
accept, send `sweep_refused` back unchanged as `accept_sweep`:

```text
POST /api/v1/publish/federation/sync
{"peer_id":"<node id>","accept_sweep":{"sweep_id":"<from the 409>","kept":3,"dropped":40}}
```

The sweep runs if it is still that `sweep_id` and would drop at most
`dropped` rows. An audit row naming who accepted which sweep is written
before any pull that could run it, and nothing runs if it cannot be; the
pull's own audit row carries its id as `accept_audit_id`. An accept that
does not name the pending sweep cannot run one, gets no such row, and is
not passed to the pull at all.
`result.accept_sweep_result` says what became of the accept, and the run
is compared first. `stale` means it named a sweep that is not the one
pending, or one a full sync is replacing. That can come with a 200: when
the sweep it named has gone, or while a full sync is under way, which
the call then carries on by a page. For the pending sweep it is `ran` (the
result carries `sweep_accepted`), `not_needed` (the sweep ran without
it), `stale` (it would drop more rows than accepted; the 409 carries the
current counts), or `not_reached`. `not_reached` means the call did not
get to the sweep: the page had more after it, the sweep was not yet due,
or the pull failed first.
Send it again on a call that completes; on a peer changing more than a
page of rows between calls, keep calling until one does. `accept_sweep`
cannot be combined with `full`.

While a sweep is refused, and no full sync is under way, the peer list
shows `sweep_refused: true` and a null `sweep_after`. Once a full sync
starts it shows `sweep_refused: false` and `full_sync_in_progress: true`,
though the old sweep stays latched until that full sync completes.
`sweep_flagged: true` says the pending sweep's own full sync failed the
guard, which is why a sweep can be refused on counts that look ordinary.
Check the peer, then accept, or run a new full sync once the peer has
settled. Every complete pull recounts a refused sweep's rows, so a
scheduler, when one exists, should back off such a peer. A full
sync replaces a refused sweep only when it completes. Until then the
refused sweep cannot be accepted, and a full sync cannot be abandoned,
so start one only for a peer whose feed can be read to its end. Peer lists expose `sweep_after`
and `sync_lease_expires` as epoch milliseconds. A cancelled invocation
may leave its lease held for up to five minutes. GET `mirrored_count`
counts present rows; DELETE `removed_rows` counts rows actually removed.
Bodies over 4 MiB, individual rows over 1 MiB, or invalid row ids stop
the page without cursor advancement. Recover by repairing the source
or deliberately restarting a full sync. Per-peer storage quotas and a
scheduler remain deferred. On Cloudflare, runtime egress restrictions
complement hostname validation; an off-Cloudflare adapter must add
DNS/address validation and connection pinning to prevent private-IP
resolution and rebinding. Deployment-specific Access cookie/CSRF
behavior still requires verification before enabling admin federation.

### Showing Mirrored Rows

A verified signature proves which node wrote a page, not that what it
says is true. A peer's admin account can be compromised like any
other, so every mirrored row is that peer's claim. A subscriber shows
it on its own terms.

The reference subscriber keeps mirrored rows apart from its own
catalog, in `federated_datasets`, and shows none of them to visitors
yet. A subscriber that does show them follows these rules.

- **A peer's `weight` orders that peer's catalog, not the
  subscriber's.** A subscriber must not use it to rank a peer's rows
  against its own rows or another peer's. Rescaling does not make it
  safe: a compromised peer still chooses which of its rows come
  first. Show mirrored rows in their own section, or below the
  subscriber's own. Order them by signals the subscriber controls,
  such as recency and a per-peer setting the operator chooses. Using
  `weight` to order a list of one peer's rows is fine.
- **A peer's text is untrusted input.** Titles, descriptions,
  keywords and every other string are the peer's words. Render them
  through the same sanitizer as any other untrusted input, never as
  raw HTML. Search relevance is computed from that text, so a peer can
  stuff it with keywords. A peer's match should not rank above a
  local one for that reason alone. Peer text must never reach a
  language model as instructions. If it goes to one at all (Orbit,
  enrichment), it goes as quoted data, per
  [CONTRIBUTING.md §LLM Integrations](../../CONTRIBUTING.md#llm-integrations),
  and only for a peer the operator has chosen.
- **Media is outside the signature.** The signature covers a row's
  URLs, not the bytes they return. A peer can change what a video or
  image shows without changing its row, and the subscriber cannot
  tell. Each visitor's browser also fetches that media from wherever
  the URLs point, usually the peer's servers, which shows the peer the
  visitor's IP address. Until a subscriber proxies or caches peer
  assets (deferred), show a peer's media only for peers the operator
  has vetted. Say on the page which node it comes from. v1 rows carry
  no digest of their media; the `content_digest` claim
  [`CATALOG_FEDERATION_PROTOCOL.md`](../CATALOG_FEDERATION_PROTOCOL.md)
  describes is not implemented.
- **Removing a peer removes its rows.**
  `DELETE /api/v1/publish/federation/peers/:id` drops every row
  mirrored from that peer in one call. That is the response to a
  compromised peer: stopping pulls alone leaves its last rows in
  place. The stored `paused` and `blocked` statuses stop pulls, but no
  route sets them yet. Once the peer has secured its node, re-add it
  like a new peer. If its signing key may have leaked, pin only its
  new key.
- **Watch for mass edits.** The reference subscriber refuses a sweep
  that would empty the mirror. It has no equivalent for a pull that
  rewrites most of the mirror, such as every title or `weight` at
  once. A subscriber should flag such a pull for an operator to
  check. This is not implemented yet.

## Deferred

- **The federation handshake** (peer registration, shared secrets,
  request signing by the subscriber). The open signed feed above needs
  none of it, and inventing it before a second operator asks would
  bake in accidents — what Directive 2 warns against.
- **STAC projection.** The repository-grounded
  [metadata and STAC audit](../metadata/README.md) supersedes Directive 3's
  earlier native-wire plan. `WireDataset`, `/api/v1/catalog`, signed
  federation feeds, and their `schema/v1` contracts remain native. Separate
  STAC 1.1.0 routes and schemas project eligible D1 records as explicit
  Collections and Items, so `dataset.schema.json` does not gain STAC fields.

## See also

- [`CATALOG_DATA_MODEL.md`](../CATALOG_DATA_MODEL.md) — field semantics for the dataset shape
- [`EMBED_URL_GRAMMAR.md`](../EMBED_URL_GRAMMAR.md) — the sibling contract (URL grammar) the embed blocks consume
- [`architecture/federation-scoping.md`](../architecture/federation-scoping.md) §7 — the directives this implements
- [`WORDPRESS_INTEGRATION_PLAN.md`](../WORDPRESS_INTEGRATION_PLAN.md) §7 — the plugin consumer
