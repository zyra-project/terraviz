# WordPress → Terraviz Events & Feeds sync — contract answer

**Status: draft for review.** Terraviz-side answer to the WordPress
plugin team's requirements for syncing WP content into Terraviz
**Events** and **Feeds**, the way the plugin already syncs WP posts into
the Terraviz **Blog** (Phase 4 of
[`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md) §6).

This document answers the four open questions the plugin raised and,
where the answer is "not the way you expect," says so plainly. The
short version:

> **The publish routes for events and feeds already exist, but they do
> not mirror the blog quartet — and they shouldn't.** A Terraviz *event*
> is a curator-gated news story matched to datasets; a Terraviz *feed* is
> an ingest **connector** (an RSS/EONET source URL), not a content item.
> Neither is "a WordPress post." Forcing the create/update/get/publish
> shape onto them is the events/feeds equivalent of the two-way-blog-sync
> trap the plan already warns against (§6, "The mismatch that makes
> two-way sync a trap"). The blog sync is **not** a template you can
> parameterise here; the fast-follow estimate in the requirements'
> §8 does not hold.

Everything below is cited to code so the plugin team can verify each
claim against a specific line rather than this prose.

---

## TL;DR contract table

| | **Blog** (the precedent) | **Events** (today) | **Feeds** (today) |
|---|---|---|---|
| What it is | A markdown content item | A **news story** about the world, matched to datasets | An **ingest connector** (RSS/EONET source URL) |
| Create | `POST /publish/blog` → `{post}`, born **draft** | `POST /publish/events` → `{event}`, born **proposed** (curator-gated) | `POST /publish/feeds` → `{feed}` |
| Update in place | `PUT /publish/blog/:id` | **none** (no `PUT`) | `POST /publish/feeds/:id` (patch, not PUT) |
| Get by id | `GET /publish/blog/:id` | **none** (no `GET /:id`) | **none** (no `GET /:id`) |
| Lifecycle | `POST /publish/blog/:id` `{action:'publish'\|'unpublish'}` | `POST /publish/events/:id` = **curator review** (`{event,links,edits,…}`), *not* publish/unpublish | `POST /publish/feeds/:id` = enable/disable patch |
| Hard delete | (datasets have it) | **none** | `DELETE /publish/feeds/:id` |
| Goes public how | Author self-publishes | **A human curator approves.** No self-publish path. | N/A — a feed produces events, it isn't published |
| Idempotency key | plugin owns it (stores returned id) | server-side on `(feedId, externalId)` | none (each POST inserts a connector) |

Legend of routes referenced: `functions/api/v1/publish/{blog,events,feeds}.ts`
and `.../{blog,events,feeds}/[id].ts`.

---

## Q1 — Do publish routes for events and feeds already exist?

**Yes, both exist** under the same `/api/v1/publish/**` Access
application as blog and datasets — but their verbs and semantics differ
from the blog quartet. Here are their real shapes.

### Events

| Op | Route | Handler | Behaviour |
|---|---|---|---|
| List / review queue | `GET /api/v1/publish/events` | `functions/api/v1/publish/events.ts:82` | Privileged-only curator queue (`?status=proposed` default, `all` for every bucket). **Not** a get-by-id. |
| Create / ingest | `POST /api/v1/publish/events` | `functions/api/v1/publish/events.ts:139` | Born **`proposed`**. Idempotent on `(feedId, externalId)`. Runs the dataset matcher inline. |
| Curator review | `POST /api/v1/publish/events/:id` | `functions/api/v1/publish/events/[id].ts:236` | `{ event:'approve'\|'reject', links:[…], addDatasetIds:[…], edits:{…} }` — a **review submission**, not a `publish/unpublish` toggle. |

There is **no `GET /api/v1/publish/events/:id`** and **no
`PUT /api/v1/publish/events/:id`** (confirmed: `events/[id].ts` exports
only `onRequestPost`). The lifecycle model is
`proposed → approved | rejected | expired`
(`functions/api/v1/_lib/events-store.ts:59`), gated by a human curator —
not `draft → published` self-service.

Adjacent event routes that exist but are not part of a create/update
contract: `events/refresh.ts` (server-side re-ingest of a whole feed),
`events/[id]/image.ts`, `events/[id]/tour.ts`.

### Feeds

| Op | Route | Handler | Behaviour |
|---|---|---|---|
| List connectors | `GET /api/v1/publish/feeds` | `functions/api/v1/publish/feeds.ts:107` | Every connector, enabled + paused. |
| Add connector | `POST /api/v1/publish/feeds` | `functions/api/v1/publish/feeds.ts:119` | Body `{ kind, label, url, category?, enabled? }`. |
| Patch connector | `POST /api/v1/publish/feeds/:id` | `functions/api/v1/publish/feeds/[id].ts:63` | `{ label?, url?, category?, enabled? }` — enable/disable is the everyday op. |
| Delete connector | `DELETE /api/v1/publish/feeds/:id` | `functions/api/v1/publish/feeds/[id].ts:122` | Removes the connector; ingested events untouched. |

There is **no `GET /api/v1/publish/feeds/:id`**, **no `PUT`**, and **no
`publish/unpublish` lifecycle** — a feed has no draft/published states.
`feeds/preview.ts` validates a candidate RSS URL before you add it.

### What this means for the plugin's assumptions (requirements §2)

- *"The API needs no dedup on any WP identifier."* — For **events** this
  is actually **better than asked**: `POST /publish/events` is idempotent
  on `(feedId, externalId)` (`functions/api/v1/_lib/events-ingest.ts:335`),
  so a plugin that sends a stable `externalId` (e.g. the WP post ID) and a
  `feedId` gets refresh-in-place on retry for free, *without* needing to
  store the returned Terraviz id. If instead the plugin follows the blog
  pattern (store the returned id, no feed key), each retried create
  **inserts a new event** — events without a feed key always insert
  (`events-ingest.ts:354`, "Events without a feed key always insert
  (manual authoring)"). Pick one model deliberately.
- *"404 on GET/PUT ⇒ recreate."* — Not available for events or feeds:
  there is no `GET /:id` or `PUT /:id` on either. The plugin's existence
  probe + recreate loop has nothing to call. (This is the biggest missing
  piece if the blog engine is to be reused unchanged — see "What Terraviz
  would need to build" below.)
- *"Create born draft, then publish."* — **Events cannot be
  self-published.** They are born `proposed` and only a human curator
  approves them via `POST /publish/events/:id` with `{event:'approve'}`.
  A service token *can* call the review route (it is privileged), but a
  plugin auto-approving its own imported events defeats the curator gate
  that is the entire point of the events subsystem
  (`CURRENT_EVENTS_PLAN.md` §5). This should be a conscious product
  decision, not an accident of reusing the blog sync.

---

## Q2 — The event entity: exact fields

The create body parsed by `parseCreate`
(`functions/api/v1/_lib/events-ingest.ts:90`). Provenance is **mandatory**;
everything else optional.

```jsonc
{
  // required provenance
  "title":  "…",                         // required
  "source": {
    "name": "…",                         // required
    "url":  "https://…",                 // required, http(s) only (rendered as a public citation)
    "publishedAt": "2026-07-06T12:00:00Z" // optional
  },

  // optional content
  "summary": "…",                        // short summary, nullable

  // optional feed-dedupe key (the idempotency lever — see Q1)
  "feedId":     "…",
  "externalId": "…",                     // together, (feedId, externalId) is the upsert key

  // optional "when"
  "occurredStart": "2026-07-06T00:00:00Z",
  "occurredEnd":   "2026-07-07T00:00:00Z",

  // optional "where" — any subset of bbox / point / region
  "geometry": {
    "boundingBox": { "n": 40, "s": 30, "w": -80, "e": -70 },
    "point":       { "lat": 37.2, "lon": -76.8 },
    "regionName":  "…"                   // resolved through src/data/regions.ts
  },

  // optional decoration + media
  "categories": { "hazard": ["hurricane"] },  // Record<string,string[]>
  "keywords":   ["…"],
  "imageUrl":   "https://…",             // lead image; http(s), ≤2048 chars, else dropped

  // optional hand-picked dataset pairings (seeded as `proposed` links)
  "datasetIds": ["INTERNAL_…"]           // ≤ 50 (MAX_MANUAL_DATASET_IDS)
}
```

Stored row: `CurrentEventRow` (`events-store.ts:83`); public read shape:
`CurrentEventPublic` (`events-store.ts:140`). Table: `current_events`
(`migrations/catalog/0024_current_events.sql`, plus `+0025` external_id,
`+0027` inference, `+0032`/`+0033`/`+0034` image/alt/video).

Answers to the specific sub-questions in requirements §4/§7.2:

- **Date/time?** Yes — `occurredStart` / `occurredEnd` (the event's own
  "when"), plus `source.publishedAt` (when the article ran). If WP events
  map from a dated post, source that date into `occurredStart`.
- **Location?** Yes — `geometry` accepts a bounding box, a point, and/or a
  named region (`regions.ts`). All optional; the AI enrichment fills a
  missing date/place at ingest when the Workers-AI binding is configured
  (`events-ingest.ts:236`, slice C).
- **Dataset linkage?** Yes — `datasetIds` are hand-picked pairings seeded
  as `proposed` links, and the matcher proposes more automatically
  (`events-ingest.ts:363-371`). Links carry their own approve/reject
  status (`event_dataset_links`, `events-store.ts:121`).
- **Relation to the dataset "in the news" events and to the `eventId`
  blog stubs reference?** They are the **same entity**. The public
  "In the news" list on a dataset (`GET /api/v1/datasets/:id/events`,
  `src/services/eventsService.ts`) surfaces exactly the *approved* links
  of these `current_events`, and the `eventId` a blog post grounds against
  (`blog-store.ts`, `event_id`) is a `current_events.id`. So a WP-imported
  event, once **approved**, would appear in a dataset's "In the news"
  rail and be citable from a blog stub — which is precisely why the
  curator gate matters.

---

## Q3 — The feed entity: what *is* a feed?

**A feed is an auto-ingesting source, not a content item.** It is the
connector that *produces* events: an RSS/Atom URL or an EONET endpoint
that the refresh route polls, turning each item into a `proposed` event
(`feed-connectors-store.ts:1-16`, `CURRENT_EVENTS_PLAN.md` §9).

Create body (`parseCreateFeed`, `feeds.ts:63`):

```jsonc
{
  "kind":     "rss" | "eonet",   // FEED_CONNECTOR_KINDS (feed-connectors-store.ts:23)
  "label":    "…",               // ≤ 120 chars
  "url":      "https://…",       // http(s), ≤ 2048 chars
  "category": "hazards" | null,  // optional, ≤ 60 chars
  "enabled":  true               // optional, default true
}
```

Stored row `FeedConnectorRow` / public `PublicFeedConnector`
(`feed-connectors-store.ts:45,60`), incl. `last_run_at` / `last_run_status`
bookkeeping. Table: `feed_connectors`
(`migrations/catalog/0026_feed_connectors.sql`). Lifecycle is
**enabled ⇄ paused** (patch `enabled`) and delete — there is no
draft/published and no per-item body.

**Implication for the plugin:** "sync a WP *post* into a Terraviz feed"
is a category error — there is nowhere to put a post body, title, or
grounding on a feed. The one thing that *does* map is registering the WP
site's own RSS feed (e.g. `https://site/feed/`) as a single `rss`
connector so Terraviz ingests the site's posts as candidate events. That
is **one connector per site**, created once — not per-post sync, and not
something the blog sync engine's per-entity create/update/publish shape
describes. If that is the intent, it needs a different, much smaller
integration (a one-time "connect this site's feed" action), and every
resulting event still lands `proposed` behind the curator gate.

---

## Q4 — Gating: authorization beyond the `service` role

**No extra gating.** Confirmed end-to-end:

- One middleware guards the whole subtree
  (`functions/api/v1/publish/_middleware.ts:113`) — Cloudflare Access JWT
  via `Cf-Access-Jwt-Assertion`, JIT-provisioning a `publishers` row.
- A **service token** provisions as `role='service'`, `status='active'`
  (`publisher-store.ts:123`), and `isPrivileged()` returns true for it
  (`publisher-store.ts:213`).
- Every write handler on events and feeds gates on exactly that
  `isPrivileged` check — no per-type role, no per-feed ACL, no
  ownership check (`events.ts:87,144`; `events/[id].ts:241`;
  `feeds.ts:112,124`; `feeds/[id].ts:68,127`).

So **§5's auth claim holds unchanged**: a Cloudflare Access service token
under the existing `/api/v1/publish/**` Access app can write events and
feeds today, with no new auth work — the same conclusion the plan reached
for blog and datasets
([`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md) §5,
Option 1). The one caveat is the **curator gate on events** (a policy
gate, not an auth gate): the token *can* approve, but whether the plugin
*should* is a product decision (Q1).

---

## On requirements §4's `sourceUrl` link-back

- **Events already have it, mandatory.** `source.url` +
  `source.name` are required provenance and render as a public citation
  (`events-ingest.ts:99-109`). The plugin should put the WP permalink
  there. No API change needed for events.
- **Feeds' `url` is the *connector* URL** (the RSS endpoint), not a
  per-item link-back — there is no per-item link-back on a feed because
  there are no per-item rows.
- **Blog does not yet carry a dedicated `sourceUrl`** field
  (`blog-store.ts` — `BlogPostInput` has `title, summary, bodyMd,
  datasetIds, eventId, tourId`, no source URL). The plan's current
  recommendation is to fold the canonical link into the markdown `body_md`
  of the WP→blog stub (§6, "a short markdown summary + canonical link
  back to the WP post"). If a first-class `sourceUrl` column is wanted on
  blog/events, that is a schema + validator change to scope separately —
  flag for Eric.

---

## §6 stability — versioned contract

These routes are **internal / unversioned in practice** despite the
`/api/v1/` path prefix: the `/publish/**` subtree is the private authoring
API (Access-gated, `role=service`/admin only), distinct from the public
read contract that Phase 4 pins as versioned JSON Schema
(`docs/protocol/`). If Events/Feeds sync becomes a supported plugin
feature, promoting the events *create* body and the feeds *connector*
body to documented, versioned contracts (as the requirements §6 suggests)
is the right call — but that is a decision for the Terraviz side to make
deliberately, not a prerequisite this doc assumes. Recommend deciding it
alongside the blog-sync contract in the same pass so all three move
together.

---

## What Terraviz would need to build for a blog-shaped reuse (if desired)

If the plugin team wants events/feeds sync to be a near-drop-in
parameterisation of the blog sync engine (requirements §8), these are the
gaps the Terraviz side would have to close. None are large individually;
together they are more than "parameterisation":

1. **`GET /publish/events/:id`** — so the plugin's existence probe /
   404-⇒-recreate loop has something to call. (Data is all there; it is a
   thin read handler.)
2. **`PUT /publish/events/:id`** — update-in-place for the content fields,
   distinct from the curator-review `POST`. (Today a re-`POST` with the
   same `(feedId, externalId)` refreshes content — arguably this already
   covers "update," if the plugin adopts the feed-key idempotency model
   instead of the store-the-id model.)
3. **A decision on the curator gate** — either accept that WP-imported
   events sit in the `proposed` queue until a human approves (recommended;
   preserves the gate), or expose an explicit, deliberately-scoped
   auto-approve path for the service role (defeats the gate — needs Eric's
   sign-off).
4. **Feeds:** most likely *nothing per-post*. Reframe as a one-time
   "register this site's RSS feed" action rather than per-entity sync.

**Recommendation:** treat events like the blog bridge already treats
posts — **WordPress stays the source of truth; the WP permalink is the
`source.url`; the imported event lands `proposed` and a Terraviz curator
approves it.** That reuses the existing `POST /publish/events` verbatim
(with `externalId` = WP post ID for idempotency), needs no new endpoint,
and keeps the human gate intact. Feeds are a separate, smaller "connect
my site's feed" story, not a content sync at all.

---

## Evidence index

- Routes — `functions/api/v1/publish/events.ts`,
  `functions/api/v1/publish/events/[id].ts`,
  `functions/api/v1/publish/feeds.ts`,
  `functions/api/v1/publish/feeds/[id].ts`,
  `functions/api/v1/publish/blog.ts`,
  `functions/api/v1/publish/blog/[id].ts`.
- Event create/upsert core — `functions/api/v1/_lib/events-ingest.ts`
  (`parseCreate:90`, idempotency `ingestEvent:327`).
- Event store + statuses — `functions/api/v1/_lib/events-store.ts`
  (`CurrentEventStatus:59`, `CurrentEventRow:83`, `CurrentEventPublic:140`).
- Feed connector store — `functions/api/v1/_lib/feed-connectors-store.ts`
  (`FEED_CONNECTOR_KINDS:23`, `parseCreateFeed` in `feeds.ts:63`).
- Auth — `functions/api/v1/publish/_middleware.ts:113`,
  `functions/api/v1/_lib/publisher-store.ts` (`role='service'`:123,
  `isPrivileged`:213).
- Blog precedent + the sync-trap reasoning —
  [`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md) §6.
- Events subsystem design — [`CURRENT_EVENTS_PLAN.md`](CURRENT_EVENTS_PLAN.md)
  §5 (curator gate), §9 (feed connectors).
- Migrations — `migrations/catalog/0024_current_events.sql`,
  `0025_current_events_external_id.sql`, `0026_feed_connectors.sql`,
  `0027_event_inference.sql`, `0029_blog_posts.sql`.
