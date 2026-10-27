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

The two scoping gates that `federation-scoping.md` names ahead of
Phase 4 federation work (the publisher-CLI auth pilot and the Pages
CPU/D1 measurement) were set aside for this work by the maintainer.
The scoping document has not been updated to say so.

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
replayed as the answer to another. The verifier re-canonicalizes the
value it parsed, so what is verified is the object it goes on to use;
a consequence is that whitespace and key order are not signed, while
any change of value is. Values with no single canonical form are
refused on both sides rather than coerced.

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

A page is every published row with `visibility = 'public'`, ordered by
`(updated_at, id)`, after the cursor and no later than a settle
watermark 30 s behind now. A row that is currently public under
`PUBLIC_DATASET_PREDICATE` is sent as a full `WireDataset`; one that is
published and public-visibility but hidden or retracted is sent as a
tombstone, its id alone. Drafts and other visibilities never appear.
The watermark exists because `updated_at` is stamped by the writer
rather than by commit order: a cursor that ran up to now would skip a
write that committed late with an earlier stamp.

Two changes cannot be tombstoned: a hard delete, and a visibility
change away from `public`, both of which take the row out of the scan.
A pull with no cursor is therefore a **full sync**, authoritative once
its last page arrives, and the subscriber drops every row it did not
see in it. Subscribers should run one periodically.

The route answers 404 unless federation is enabled, 503 when it is
enabled without a usable abuse contact or when the node cannot sign
(no private key, or one that does not match the advertised public
key), and signs every 200.

## Step 3: Discovery

`federation-config.ts` decides whether this node serves a feed:
`FEDERATION_ENABLED` is `'true'`, the signing key is configured, and
`FEDERATION_ABUSE_CONTACT` is a valid contact. Only then does
`/.well-known/terraviz.json` advertise the feed endpoint and contact.
A node that switched federation on without a contact serves no feed,
because a peer has no one to report a problem to.

## Step 4: STAC to native links

The STAC Collection and Item for a row this node hosts carry an
`alternate` link to `/api/v1/datasets/:id`; a mirrored row would carry
a `via` link to its origin instead, never an `alternate`. The root
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

One pull reads at most 10 pages of 100 rows, each at most 4 MiB with
no row over 1 MiB, with a 15 s timeout per request and no redirects.
Every page is verified before any of it is applied; a page that fails
stops the pull with the reason recorded as the peer's
`last_sync_error`, and the cursor stays at the last page applied. A
full sync stamps a run id on every row it delivers and keeps it across
pulls, so a full sync larger than one pull's caps still reconciles
when it finishes.

Mirrored rows are stored as the wire carried them, with the signature
header of the page that delivered them as evidence. They are never
joined with `datasets` and are not served by any route.

`POST /api/v1/publish/federation/sync` runs one bounded pull now;
`GET`/`POST /api/v1/publish/federation/peers` list and add peers. Both
are admin-only and 404 unless federation is enabled.

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

## Configuration

| Variable | Effect |
|---|---|
| `FEDERATION_ENABLED` | `'true'` turns on the feed, the admin routes and the discovery advertisement. Anything else is off. |
| `FEDERATION_ABUSE_CONTACT` | Required for the feed to serve and be advertised. |
| `NODE_ID_PRIVATE_KEY_PEM` | The node's Ed25519 private key; must match `node_identity.public_key`. |

## Deferred

- **Handshake, HMAC and grants.** Only public rows are federated, and
  only by pull. Nothing grants a peer more than the public catalog.
- **Scheduled sync.** `sync_interval_minutes` is stored and nothing
  reads it; pulls are manual.
- **Serving mirrored rows.** No catalog, search, STAC or Orbit surface
  reads `federated_datasets`, so the `via` link of Step 4 has no
  producer yet.
- **Key rotation.** A rotated key breaks every subscriber until each
  re-adds the peer.
- **Tours, subscribers table, asset proxy policy.** Later phases.

## Known disclosures and deviations

- **Tombstones disclose ids.** The feed sends the id of a public row
  an operator later hid or retracted. The public catalog does not.
- **`origin_node` is the peer's claim.** It is stored as sent and
  checked against nothing; a peer re-publishing another node's rows
  can name that node.
- **Stored signatures cover pages, not rows.** `feed_signature` is the
  header of the page that delivered a row. Re-verifying it needs that
  whole page, which is not kept, so it is evidence of where a row came
  from rather than something a later reader can check on its own.
- **Module layout.** The `_lib/federation-*` modules are flat rather
  than the subdirectory `federation-scoping.md` §7 Directive 1
  sketches; the store-interface split it asks for is followed.
- **Schema.** `0058` is a reduced form of the tables in
  `docs/CATALOG_DATA_MODEL.md`: columns no code reads yet are left
  out and arrive as `ADD COLUMN` with the code that reads them.
- **Deployment.** Nothing here has run against a deployed node or
  between two deployments.
