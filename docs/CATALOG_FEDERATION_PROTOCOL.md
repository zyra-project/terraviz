# Catalog Federation Protocol

The wire protocol two Terraviz nodes use to discover each other,
subscribe, and synchronise catalogs. Companion to
[`CATALOG_BACKEND_PLAN.md`](CATALOG_BACKEND_PLAN.md);
schema referenced from
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md).

A node is **discoverable** if it serves a `/.well-known/terraviz.json`
document. A node is **subscribable** if it accepts handshakes at
`/api/v1/federation/handshake`. Subscriptions are explicit, named,
and persisted; there is no implicit fan-out. A node operator adds
or removes peers from the publisher portal.

## The well-known document

```jsonc
{
  "node_id": "01HW...",
  "display_name": "NOAA SOS",
  "base_url": "https://sos.noaa.example",
  "public_key": "ed25519:...",
  "schema_versions_supported": [1],
  "endpoints": {
    "catalog":   "/api/v1/catalog",
    "feed":      "/api/v1/federation/feed",
    "handshake": "/api/v1/federation/handshake"
  },
  "policy": {
    "open_subscription": false,
    "auto_approve": false,
    "max_request_rate_per_minute": 600
  },
  "contact": "ops@noaa.example",
  "abuse_contact": "abuse@noaa.example"
}
```

`open_subscription: false` means handshakes go to "pending" and an
operator approves them via the publisher portal. `auto_approve` is
the soft default for friendly networks (e.g., a constellation of
science museums that trust each other); flipping it on is one
checkbox in the portal. `abuse_contact` is required — deployments
without one do not federate.

## Subscription handshake

Out-of-band exchange of base URLs is fine — it's a low-stakes
operation. Cryptographic identity is inline:

```
Subscriber A                                Publisher B
     │  GET https://B/.well-known/terraviz.json
     ├─────────────────────────────────────────────►
     │                                              │ returns identity + public key
     │◄─────────────────────────────────────────────┤
     │                                              │
     │  POST /api/v1/federation/handshake           │
     │  Body: { base_url, display_name,             │
     │          public_key }                        │
     │  Signed: HMAC-SHA256 with bootstrap secret   │
     │          (out-of-band shared one-time code)  │
     ├─────────────────────────────────────────────►│
     │                                              │ inserts federation_subscribers row,
     │                                              │ status=pending; signs response
     │◄─────────────────────────────────────────────┤
     │  { subscription_id, status: "pending",       │
     │    shared_secret: "<HMAC base64>",           │
     │    node_identity: { ... } }                  │
     │                                              │
     │  ── operator clicks Approve in B's portal ──│
     │                                              │
     │  GET /api/v1/federation/feed                 │
     │  X-Terraviz-Signature: HMAC over request    │
     ├─────────────────────────────────────────────►│
     │                                              │
```

The bootstrap secret is a one-time code the subscribing operator
pastes into a form during the handshake; after that, the
server-issued `shared_secret` is used for all future requests. This
keeps the protocol self-contained — no external CA, no separate
identity service.

## Sync protocol

Pull-based, cursor-driven. The subscriber does:

1. `GET /api/v1/federation/feed?since={cursor}` (signed).
2. Verify the response signature against the pinned peer public key.
3. For each dataset / tour in the response, upsert into
   `federated_datasets` / `federated_tours` keyed by
   `(peer_id, remote_id)`.
4. For each tombstone, delete or mark expired.
5. Save the new cursor.

Cadence is configurable per peer (default: every 15 minutes via
Cloudflare Cron). Peers can also call
`POST /api/v1/federation/webhook` to nudge the subscriber to pull
sooner; the receiver enqueues a Queue message and the worker drains
it.

A Durable Object per peer (Phase 4+) can replace the cron + queue
combo with a single coordinator that owns cursor + retry timer +
circuit breaker. Phase 4 starts with cron because it's simpler;
move to DOs only if we hit coordination problems.

## Catalog signing

Every federation response is signed:

```
Signature-Input: ed25519, key_id="<node_id>", timestamp=...
Body: { schema_version, generated_at, datasets: [...], tombstones: [...] }
Signature: <Ed25519 over canonicalized body + headers>
```

Subscribers verify on every fetch. A failed signature halts that
sync and surfaces an alert in the publisher portal. Pinning happens
at handshake — a peer that rotates its key has to either advertise
the new key in the well-known doc with a grace overlap or the
subscriber has to re-handshake.

## Merging into the browse UI

`browseUI.ts` today renders `state.datasets`. With federation, the
state becomes:

```ts
state.datasets = [
  ...localDatasets,        // origin_node === this node
  ...federatedDatasets,    // origin_node !== this node, fetched from peers
];
```

UI affordances:

- An origin badge on each card (own node logo / peer name + favicon).
- A peer filter chip: "All sources / This node / Peer X / Peer Y".
- Federated datasets that are unreachable (peer down, signature
  failure) are dimmed and labelled "temporarily unavailable" rather
  than removed, so a flapping peer doesn't blink datasets in and out.

## Tours that span peers

A tour can `loadDataset` on a federated dataset (id like
`peer:<peer_id>:<remote_id>`). The tour engine resolves the id via
the local federated cache, then calls the peer's
`/api/v1/federation/feed/manifest/{id}` to get a playback URL,
*not* the local node's. Data stays at home; the subscriber just
points its player at the peer's signed URL.

## License & attribution propagation

A dataset's license follows it across federation. The
`federated_datasets.payload_json` cache stores the full Dataset
including `license_spdx`, `license_url`, `license_statement`,
`attribution_text`, `rights_holder`, `doi`, and `citation_text`.
A subscriber:

- Renders the attribution next to the dataset in browse cards,
  the info panel, and any tour playback view (no exceptions —
  this is what makes the system safe to use for CC-BY content).
- Refuses to display datasets without a license declaration when
  the operator's policy is "require licenses" (a federation
  setting). Default policy is "permissive" — show with an
  "unspecified license" warning — to ease migration.
- Surfaces `license_spdx` and `attribution_text` in the embed
  snippet and citation export so attribution survives the dataset
  leaving the application.

Per-peer policy (`federation_peers.policy`) extends with
`require_license` and `allowed_license_spdx` (allowlist of
acceptable SPDX IDs). A peer publishing CC-BY content can subscribe
to peers that publish public-domain content without inheriting
license-incompatibility headaches.

For datasets without an SPDX-listed license (most U.S. government
work — "U.S. Government Work" isn't an SPDX identifier),
`license_statement` carries the human-readable terms and
`license_spdx` is null. The frontend treats null SPDX as "see
license_statement" and shows the statement verbatim.

## Failure modes the protocol has to survive

| Failure | Behaviour |
|---|---|
| Peer offline | Sync fails, last-good `federated_datasets` rows remain, UI dims items, operator alert via audit log + (optionally) Slack webhook. |
| Peer rotates key without overlap | All future syncs fail signature check. Operator re-handshakes from the portal. |
| Peer revokes a grant | On next sync, the previously-visible item disappears and a tombstone arrives. UI shows it as "unavailable" until the local cache evicts. |
| Schema drift (peer ships v2) | Subscriber refuses items with `schema_version` higher than supported, logs once per sync, keeps known-good items. |
| Hostile peer floods with bogus datasets | Per-peer item-count cap (configurable, default 10k). Beyond it, syncs degrade to error and require operator unblock. |
| Subscriber's clock is skewed | Signed timestamps + 5-minute window; persistent failure surfaces a "check your clock" alert. |
| Peer retracts a dataset after publishing | Tombstone delivered next sync; subscriber removes it. The window where a stale subscriber still has the metadata is bounded by sync cadence. |

## Why not ActivityPub / Atom / OAI-PMH?

We considered all three:

- **ActivityPub** is overkill — the inbox/outbox model is built
  around social posts and assumes an identity layer (Webfinger) we
  don't need.
- **Atom / RSS** has no signature story and no good cursor model
  for "deletes since."
- **OAI-PMH** is the closest fit conceptually (verbs like
  `ListRecords` with a resumption token), but it's XML-only, has no
  signed payloads, and the auth story is nonexistent.

A small JSON-over-HTTP protocol with Ed25519 signatures and HMAC
auth is the smallest thing that handles the requirements and stays
within the Cloudflare runtime without a third-party dependency.
