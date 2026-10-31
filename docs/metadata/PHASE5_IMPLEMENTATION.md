# Phase 5: federation integration

**Status:** Implemented behind `FEDERATION_ENABLED` and fixture-validated; deployment verification pending
**Last reviewed:** 2026-10-27
**Revisit when:** a second implementation reads the feed, the handshake or grant flow lands, a scheduler replaces the manual sync, mirrored rows are served anywhere, node keys rotate, or `docs/architecture/federation-scoping.md` §7 or §8 changes.

Phase 5 of the metadata plan asks for STAC and the native federation
protocol to be linked "by canonical origin and identity after both
contracts are stable". The native side had no signed contract to link
to, so this phase builds the smallest one that can carry a catalog
between two nodes: a signed, cursored public feed, a subscriber that
pulls and verifies it, and the links between that feed's records and
their STAC projections. It is deliberately the one-directional,
public-rows-only slice of the protocol in
`docs/CATALOG_FEDERATION_PROTOCOL.md`; what that document plans and
this phase leaves out is listed under _Deferred_.

`federation-scoping.md` section 7 Directive 5 gates federation merges
on the publisher CLI being on npm and a partner pilot. The Pages CPU/D1
measurement is instead metadata Phase 4's STAC rollout gate
(`PHASE4_IMPLEMENTATION.md`, Rollout Gate). The maintainer has said
they will record the dated scoping amendment and governance agreement
on PR #491; this document does not record approval on their behalf.

Everything below is off unless `FEDERATION_ENABLED` is exactly
`'true'`. With it off, no federation route answers anything but 404,
the discovery document advertises no feed, and the STAC output is
unchanged apart from the native links of Step 4.

## Step 1: Signatures

`functions/api/v1/_lib/federation-signature.ts`. A federation response
is signed with the node's Ed25519 key (`NODE_ID_PRIVATE_KEY_PEM`, the
private half of the `node_identity.public_key` the discovery document
already publishes) and carries a detached header:

```
Terraviz-Signature: v=1, keyid=<node_id>, created=<unix-s>, sig=<base64url>
```

The signature covers a domain-separated statement, not the body alone:
a version tag, the key id, the signing time, the request target (path
and query) and the SHA-256 of the body's RFC 8785 canonical JSON. The
target is what stops a validly signed page for one cursor being
replayed as the answer to another. The verifier authenticates received
bytes before parsing, then requires canonical-byte equality, rejecting
duplicate keys and formatting changes. The exact statement and fixed
UTF-8/float test vector are in `docs/protocol/README.md`. Version 1
uses `keyid === node_id`; a rotating key namespace requires v2.

Verification refuses, by named reason: a missing or malformed header,
a key id that is not the pinned peer's, a signature older than 300 s
or more than 60 s in the future, a body that is not canonicalizable
JSON, and a signature that does not verify.

## Step 2: The feed

`GET /api/v1/federation/feed` (`functions/api/v1/federation/feed.ts`,
built from `federation-feed.ts` over the store in
`federation-feed-d1.ts`), pinned by `public/schema/v1/feed.schema.json`.
It accepts `since` (an opaque cursor) and `limit` (default 100, at
most 250) and nothing else. An unknown or repeated parameter is a
400: the request target is part of what is signed, so the feed
accepts one spelling of each request rather than signing pages for
targets it ignored.

The feed carries public, non-hidden rows only. A page is every published row with `visibility = 'public'` and `is_hidden = 0`, ordered by
`(updated_at, id)`, after the cursor and no later than a settle
watermark 30 s behind now. A row that is currently public under
`PUBLIC_DATASET_PREDICATE` is sent as a full `WireDataset`; one that is
published and public-visibility but retracted is sent as a
tombstone, its id alone. Drafts and other visibilities never appear.
The watermark exists because `updated_at` is stamped by the writer
rather than by commit order: a cursor that ran up to now would skip a
write that committed late with an earlier stamp.

Three changes cannot be tombstoned: hiding, a hard delete, and a visibility
change away from `public`, all of which take the row out of the scan.
A pull with no cursor is therefore a **full sync**. A withdrawn row is
removed by a full sync followed by an incremental sweep (Step 5), not
an incremental pull alone. Subscribers should run full syncs periodically.

The route answers 404 unless federation is enabled, 503 when it is
enabled without a usable abuse contact or when the node cannot sign
(no private key, or one that does not match the advertised public
key), and signs every 200.

## Step 3: Discovery

`federation-config.ts` decides whether this node serves a feed:
`FEDERATION_ENABLED` is `'true'`, the signing key is usable and matches
the public key, and `FEDERATION_ABUSE_CONTACT` is a valid contact.
Only then does `/.well-known/terraviz.json` set `federation.feed` true.
The endpoint path is always listed, and a valid contact is published
independently of readiness; these fields are not availability claims.
A node that switched federation on without a contact serves no feed,
because a peer has no one to report a problem to.

## Step 4: STAC to native links

The live STAC Collection and Item for a row this node hosts carry a
`via` source-metadata link to `/api/v1/datasets/:id` with the native
JSON schema profile. A history-backed live Collection keeps it; an
immutable history Item does not link to today's native record. A
mirrored row would carry a `via` link to its origin instead. The root
catalog gains a `describedby` link to `/.well-known/terraviz.json`.
`(origin node, dataset id)` is the join key between the two
representations, which is what the metadata plan asked for. See the
link table in [README.md](README.md) (rows "Native record" and
"Native discovery").

## Step 5: Subscriber and mirror

Migration `0058_federation_mirror.sql` adds `federation_peers` and
`federated_datasets`. `federation-subscriber.ts` holds `pullPeer`, and
`federation-mirror-d1.ts` the D1 stores behind it.

A peer is added by an admin with `{ base_url, node_id, public_key }`
taken from the peer's operator out of band. The route fetches the
peer's discovery document (no redirects, 64 KiB cap, a timeout) and
refuses the peer unless it names the same id, key and base URL and
says its feed is serving. The discovery document is unsigned, so this
checks the operator's input and is never a source of trust: the key
that is stored is the one the operator typed, and every page pulled is
verified against it. A peer that rotates its key is re-added by an
operator; nothing re-pins a key automatically.

The core defaults to at most 8 pages of 100 entries, each at most 4 MiB with
no row over 1 MiB, with a 15 s timeout per request and no redirects.
Every page is verified before any of it is applied; a page that fails
stops the pull with the reason recorded as the peer's
`last_sync_error`, and the cursor stays at the last page applied. A
full sync stamps a run id on every row it delivers and keeps it across
pulls, so a full sync larger than one pull's caps still reconciles
when it finishes.

**Lease.** Each pull takes a per-peer lease and reads the peer's URL
and key from its stored row, never from the caller, so two pulls
cannot interleave pages. The sync route answers 409 while a lease is
held, and 500 with an audit row on a store error.

**Sweep.** A finished full sync does not delete what it did not see.
It schedules a sweep, which the next complete incremental pull runs
once the feed's 30 s settle window plus 60 s clock-skew allowance have closed, so rows held back by
the watermark on the last page are not dropped.

**Sweep guard.** The feed skips any row it cannot serialize, so a peer
whose serializer breaks serves empty signed pages and a full sync over
them sees nothing. Before deleting, the sweep counts what it keeps and
drops (`sweepIsPlausible`). It is refused when it keeps no row, or
drops more than half the mirror and more than five rows. A refused
sweep deletes nothing, clears itself, records `sweep-refused`, and the
sync route answers 409 with the counts. A peer that really withdrew
most of its catalog is removed and re-added by an operator.

`last_sync_at` records the last **attempt**, successful or not; read
it with `last_sync_error`.

Mirrored rows are stored as the wire carried them, with the signature
header of the page that delivered them as diagnostic metadata. They are never
joined with `datasets` and are not served by any route.

`POST /api/v1/publish/federation/sync` reads one page of at most 25
entries per invocation (`page_size`: 1-25). Its counted endpoint test
includes route reads and audit writes and remains below 50 D1 statements.
It returns snake_case fields and 503 for peer pull failures. `full: true`
restarts an interrupted full sync; subsequent calls omit `full` to
continue. An `invalid_cursor` result asks the operator to restart.
The peer list exposes sweep and lease-expiry epoch milliseconds.

`POST /api/v1/publish/federation/sync` runs this bounded pull now;
`GET`/`POST /api/v1/publish/federation/peers` list and add peers, and
`DELETE /api/v1/publish/federation/peers/:id` removes one with its
mirrored rows (404 `peer_not_found`, audited as
`federation_peer.remove`). All are admin-only and 404 unless
federation is enabled.

At 25 entries per request, a full sync of a roughly 600-row peer takes
about 24 manual requests. Repeat until `complete: true`, then allow
the deferred sweep window and complete an incremental pull; the
scheduler is still deferred.

## Step 6: Conformance

`functions/api/v1/federation/conformance.test.ts` runs the publisher
route and the subscriber against each other over two separate
fixture databases: a paged full sync mirrors exactly what the feed
serves, an incremental pull applies a tombstone, a page altered in
transit is refused with nothing applied, and a peer pinned to the
wrong key is refused. `npm run test:federation` runs it with the rest
of the federation tests.

Both ends are this repository's code, so the harness proves the two
halves agree with each other, not that the wire format is
unambiguous to a second implementation.

### Verification Evidence

2026-10-29, Windows/Node 24, base `1b9313f6` plus uncommitted PR #491
review corrections:

- All changed test files plus STAC publication integration: 12 files,
  483 tests passed.
- `npm run test:federation`: 9 files, 258 tests passed, including signed
  route/subscriber conformance, hidden withdrawals and deferred sweeps.
- `npm run type-check`: passed, including migration, documentation,
  license and generated protocol-schema gates.
- Required read-only reviews: TerraViz Federation Reviewer,
  Application Security Engineer, API Platform Engineer, Scientific
  Data Steward and Code Reviewer. Follow-up found no remaining
  actionable issues after BOM/depth/budget/documentation corrections.
  Skip-and-log remains the maintainer-requested tradeoff described in
  the protocol README.

This is AI-assisted review, not independent human approval. No human
outside the original loop has reviewed this change. WordPress contract
regeneration/checks and deployed-node tests are unconfirmed. The dated
scoping amendment and governance agreement remain maintainer-owned.

## Configuration

| Variable | Effect |
|---|---|
| `FEDERATION_ENABLED` | `'true'` turns on the feed, the admin routes and the discovery advertisement. Anything else is off. |
| `FEDERATION_ABUSE_CONTACT` | Required for the feed to serve and be advertised. |
| `NODE_ID_PRIVATE_KEY_PEM` | The node's Ed25519 private key; must match `node_identity.public_key`. |

## Deferred

`federated_datasets.payload_json` is untrusted peer content. Before serving
it, re-validate the payload, restrict URL schemes, and resolve relative
`dataLink` values against the peer.

- **Handshake, HMAC and grants.** Only public rows are federated, and
  only by pull. Nothing grants a peer more than the public catalog.
- **Scheduled sync.** Pulls are manual; a sync-interval setting arrives
  with the scheduler.
- **Storage and caching.** Per-peer storage quotas and feed-page caching
  remain deferred. Origin ids must match the pinned peer; display names
  and JSON media types are checked, and raw bytes are verified first.
- **Serving mirrored rows.** No catalog, search, STAC or Orbit surface
  reads `federated_datasets`, so the `via` link of Step 4 has no
  producer yet.
- **Key rotation.** A rotated key breaks every subscriber until each
  re-adds the peer.
- **Tours, subscribers table, asset proxy policy.** Later phases.

## Known disclosures and deviations

- **Retractions disclose ids.** A retracted public, non-hidden row
  produces a tombstone; hidden ids never enter the feed. Previously
  mirrored hidden rows disappear through full sync plus deferred sweep,
  and only a full sync that has not yet passed the row's page when it
  was hidden; one already past it keeps the row. With no scheduler,
  that waits on an operator. **To withdraw a dataset from peers,
  retract it while it is still public and not hidden.** The tombstone
  reaches them on the first pull after the 30 s settle window; a row
  hidden first never sends one.
- **Readiness is not health.** Discovery checks the signing-key pair
  but may be cached for fifteen minutes, and does not prove D1 health.
- **Origin is bounded.** Every row must name its serving peer as
  `originNode`; v1 does not accept relays. Different peers' claims are
  not deduplicated automatically.
- **Stored signatures cover pages, not rows.** `feed_signature` is the
  header of the page that delivered a row. Re-verifying it needs that
  whole page and target, which are not kept. The stored header is
  diagnostic metadata, not independently verifiable evidence.
- **Module layout.** The `_lib/federation-*` modules are flat rather
  than the subdirectory `federation-scoping.md` §7 Directive 1
  sketches; the store-interface split it asks for is followed.
- **Schema.** `0058` is a reduced form of the tables in
  `docs/CATALOG_DATA_MODEL.md`: columns no code reads yet are left
  out and arrive as `ADD COLUMN` with the code that reads them.
- **Deployment.** Nothing here has run against a deployed node or
  between two deployments.
- **Operational bounds.** The 30 s watermark assumes commits settle
  within that interval. A live row edited in both reconciliation
  windows can temporarily disappear and return on a later pull;
  repeated full syncs alone never run the deferred sweep. A cancelled
  invocation may hold its five-minute lease. Oversized or invalid-id
  rows stop a page. Edge/WAF rate limits, per-peer quotas, Access
  cookie/CSRF behavior and off-Cloudflare DNS/address pinning need
  deployment review before enabling the feature.
