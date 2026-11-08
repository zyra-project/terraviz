# Hero override admin — scoping

**Status:** superseded on 2026-11-08 by
[`CATALOG_PUBLISHING_TOOLS.md` §"Right now" hero override](CATALOG_PUBLISHING_TOOLS.md#right-now-hero-override).
**Owner:** catalog / publisher-portal track

> **Superseded.** All three phases below shipped, and the decisions
> as built now live in `CATALOG_PUBLISHING_TOOLS.md`. Read that
> section for how the hero works today. This doc is kept as the
> scoping record and is no longer maintained, so it carries no
> review date.
>
> The code differs from this plan in several places, all listed
> there:
> - writes need the `hero.manage` capability (editor, admin, service),
>   not `isPrivileged`;
> - a bad body returns 400, not 422;
> - an approved current event sits between the pin and the automatic
>   pick;
> - a `hero` switch on the Features card can turn it off;
> - a pin that is not showing no longer blocks the file.
>
> The page does not yet show who set the pin or whether it has
> expired (§6). Both are listed there as follow-ups.

A curator-facing UI for the §9.1 "Right now" hero panel, so the
homepage pin can be set from the publisher portal instead of a
hand-edited `public/featured-now.json` PR.

This is a scoping artifact, not an implementation. It lays out the
architecture, the data model, the API surface, the UI, the security
posture, and the phasing, with explicit open questions at the end.

---

## 1. Why

§9.1 shipped the hero panel with a static override file
(`public/featured-now.json`, schema `{ datasetId, window: { start,
end }, headline? }`). Updating the pin means: edit JSON → open a PR →
review → merge → wait for a Pages deploy. That's fine as a v1 (cheap,
auditable, no new infra) but it's real friction for a non-technical
curator, and the loop is minutes-to-hours when the whole point of a
"Right now" pin is timeliness (active hurricane, aurora tonight).

The goal: let an authorised operator set/clear the hero from a UI in
**seconds**, with the same audit trail and a safe fallback.

### Non-goals

- **Replacing the static file.** `featured-now.json` stays as the
  fallback for static-only deploys and as the zero-config default.
  The admin store is *read first*, the file is the floor.
- **A general CMS.** This manages exactly one thing: the single hero
  override (+ its window + headline). Not a page builder.
- **Auto-pilot curation.** No analytics-driven "trending" auto-pin.
  The auto-derive path (`Real-Time` tag + fresh `endTime`) already
  covers the no-override case; this UI is the *manual* override.
- **Per-tenant / per-locale heroes.** One operator-wide hero, matching
  §9.1's "one hero per visitor, deterministic" rule.

---

## 2. The good news: most of the backend already exists

The publisher portal and catalog backend already provide every
primitive this needs except the hero-specific store and one UI page:

| Primitive | Where it lives today | Reuse |
|---|---|---|
| Authn/authz | `functions/api/v1/publish/_middleware.ts` — Cloudflare Access JWT → JIT `publishers` row → `context.data.publisher` | Wrap the new routes; gate writes on `isPrivileged()` |
| Role gate | `publisher-store.ts` `isPrivileged()` (staff/admin/service-token) | Hero writes are privileged-only, same as featured curation |
| Typed error envelopes | `{ error, message }` / `{ errors: [...] }` across the publisher API | Match exactly |
| KV cache + TTL | `CATALOG_KV`, e.g. `featured:v1:<limit>` 60 s TTL in `/api/v1/featured` | Same pattern for the public hero read |
| Audit trail | `functions/api/v1/_lib/audit-store.ts` | Log every hero set/clear |
| D1 catalog | `CATALOG_DB`, `datasets` table | FK the hero's `dataset_id` |
| Portal shell | `src/ui/publisher/` — router, `api.ts` client, pages, components | Add one page |

So this is **~1 small table + 2 routes + 1 portal page + a read-path
tweak**, not a from-scratch admin system.

### 2.1 Disambiguation: hero ≠ `featured_datasets`

There's already a `featured_datasets` table + `/api/v1/featured`
(public) + `/api/v1/publish/featured` (admin add/update/remove). It is
**not** the hero, and the two should stay separate:

| | `featured_datasets` (exists) | Hero "Right now" (§9.1) |
|---|---|---|
| Cardinality | a **list** (position-ordered) | a **single** pin |
| Purpose | docent cold-start (`list_featured_datasets` LLM tool) | catalog homepage hero card |
| Time semantics | none | mandatory activation `window` |
| Headline | none | optional curator headline |
| Expiry | manual remove | auto-expires at `window.end` |

Folding the hero into `featured_datasets` (e.g. a `position = -1`
sentinel + nullable window columns) was considered and **rejected**:
it overloads a table with clear, different semantics, complicates the
docent query, and couples two features that should ship and roll back
independently. A dedicated single-row store is cleaner and cheaper to
reason about.

---

## 3. Proposed architecture

```
 Publisher portal (Cloudflare Access)          Public catalog (anon)
 ┌───────────────────────────────┐             ┌────────────────────┐
 │ pages/featured-hero.ts        │   writes    │ heroService.ts     │
 │  set / clear / preview        │────────────▶│  getHeroCandidate  │
 └───────────────┬───────────────┘             └─────────┬──────────┘
                 │ PUT/DELETE                              │ GET
                 ▼                                         ▼
   /api/v1/publish/featured-hero          /api/v1/featured-hero (KV-cached)
                 │  (isPrivileged)                         ▲
                 ▼                                         │ on write: bust KV
        D1: hero_override (single row) ───────────────────┘
                 │
                 ▼  (fallback floor)
        public/featured-now.json  (static, unchanged)
```

**Client read path becomes backend-first, file-fallback:**

1. `heroService.getHeroCandidate()` fetches `/api/v1/featured-hero`
   (KV-cached). If it returns an active override → use it.
2. Else fetch `public/featured-now.json` (today's path) → if active →
   use it.
3. Else auto-derive (`Real-Time` + fresh `endTime`).
4. Else null.

This keeps static-only forks working (the endpoint 404s → fall to the
file) and makes the admin store an *additive* layer, not a breaking
change. The window/expiry semantics from §9.1 are unchanged and apply
identically to both sources.

---

## 4. Data model

`migrations/catalog/00NN_hero_override.sql`:

```sql
CREATE TABLE hero_override (
  id          INTEGER PRIMARY KEY CHECK (id = 1), -- singleton row
  dataset_id  TEXT NOT NULL,
  window_start TEXT NOT NULL,   -- ISO 8601, mandatory (§9.1 rule)
  window_end   TEXT NOT NULL,   -- ISO 8601, mandatory
  headline    TEXT,             -- optional
  set_by      TEXT NOT NULL,    -- publishers.id (audit)
  set_at      TEXT NOT NULL,    -- ISO 8601
  FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE,
  FOREIGN KEY (set_by)     REFERENCES publishers(id)
);
```

- **Singleton** via `CHECK (id = 1)` — there is at most one hero.
  "Set" is an upsert on `id = 1`; "clear" is a delete.
- `ON DELETE CASCADE` on `dataset_id` means retiring a dataset
  auto-clears a stale pin — no dangling hero.
- The window stays **mandatory** at the data layer (NOT NULL),
  enforcing §9.1's "no window ⇒ ignored, can't go stale" invariant at
  the source rather than only in the client.

---

## 5. API surface

### 5.1 `GET /api/v1/featured-hero` (public, anon)

Mirrors `/api/v1/featured`'s shape + caching exactly.

- Returns `{ hero: { datasetId, window: { start, end }, headline? } }`
  or `{ hero: null }`.
- **Does not** evaluate the window or resolve the dataset — it returns
  the raw override and lets `heroService` apply the same window/resolve
  logic it already has (single source of truth for "is it active").
- KV-cached at `hero:v1` with a short TTL (60 s, matching featured).
  Write routes bust the key so a set/clear is live within a tick (and
  within 60 s even if the bust is missed).
- `503 binding_missing` if `CATALOG_DB` unbound (→ client falls to the
  static file).

### 5.2 `PUT /api/v1/publish/featured-hero` (privileged)

Body: `{ dataset_id, window: { start, end }, headline? }`.

- `isPrivileged(publisher)` required → `403 forbidden_role` otherwise.
- Validates: `dataset_id` exists (`404`/`422`), both window bounds
  present + parseable ISO + `start < end` (`422` with the `{ errors }`
  array shape), headline length cap.
- Upserts the singleton row, writes an audit entry, busts `hero:v1`.

### 5.3 `DELETE /api/v1/publish/featured-hero` (privileged)

Clears the pin (delete row), audits, busts cache. Idempotent (`204`
even if already empty).

All three live under the existing `_middleware.ts`, so auth, JIT
publisher provisioning, and the failure envelopes are inherited.

---

## 6. Publisher portal UI

New page `src/ui/publisher/pages/featured-hero.ts`, one route in the
portal router, one nav entry (privileged-only).

Controls:

- **Dataset picker** — reuse the existing dataset search the portal
  already has (datasets page lists/searches the catalog); pick one.
- **Window** — start + end datetime inputs. Default a sensible span
  (e.g. now → now + 7 d) but require explicit values. Inline validation
  mirrors the API (`start < end`, both required).
- **Headline** — optional text, length-capped, with a char counter.
- **Live preview** — render the actual `heroPanelUI` card from the
  current form state so the curator sees exactly what ships.
- **Set / Clear** buttons → `PUT` / `DELETE`. Show the current pin
  (dataset title, window, who set it, when) when one is active.
- **Expiry hint** — "expires in 3 days" / "expired" surfaced from the
  window so a stale pin is obvious.

No new visual language — reuse the portal's form components
(`dataset-form`, `chip-input`, `error-card`) and `api.ts` client.

---

## 7. Caching, invalidation, failure

- **Public read:** KV `hero:v1`, 60 s TTL, `Cache-Control` to match.
  Write routes call `KV.delete('hero:v1')` so a set/clear is effectively
  immediate; the TTL is the backstop if a bust is dropped.
- **Client 5-min cache** (`heroService` `OVERRIDE_CACHE_MS`) already
  exists and applies to the endpoint fetch too — so a curator change is
  visible to an *already-open* session within ≤5 min, immediately on
  reload. If that's too slow for "Right now", drop the client cache to
  ~60 s for the endpoint path (keep 5 min for the static file). Open
  question §10.
- **Fail-closed everywhere:** endpoint error/timeout → fall to the
  static file → auto-derive → null. The catalog never breaks because
  the hero backend is down.

---

## 8. Security

- **Writes are privileged-only** (`isPrivileged`) — community
  publishers can't pin operator-wide homepage content. This is the
  same gate `POST /publish/featured` already enforces.
- **Audit every mutation** (`set_by` / `set_at` + `audit-store`), so
  "who pinned the homepage and when" is answerable. This is the audit
  trail the PR-based flow gave us for free; we must not lose it.
- **`dataset_id` is FK-checked** — can't pin a non-existent row.
- **Headline is escaped at render** (the UI already `escapeHtml`s it);
  the API also length-caps and could strip control chars. The headline
  is operator-authored, but defense-in-depth is cheap.
- **No new public write surface** — the anon endpoint is read-only.

---

## 9. Phasing

| Phase | Scope | Ships independently? |
|---|---|---|
| **A — read path** | `GET /api/v1/featured-hero` + `hero_override` table + `heroService` backend-first/file-fallback. No UI yet (set via SQL/seed). | Yes — unlocks the store without UI risk |
| **B — write API** | `PUT`/`DELETE /publish/featured-hero`, validation, audit, KV bust. Curl-able. | Yes — backend complete, still no UI |
| **C — portal page** | `pages/featured-hero.ts` + route + nav + live preview. | Yes — the curator-facing payoff |

Each phase is a small PR. Phase A is the only one that touches the
public client; B and C are publisher-portal-only and invisible to
anonymous visitors until a pin is set.

**Rollback:** drop the endpoint (client falls to the file) or delete
the table row. The static-file path is never removed, so there's
always a working floor.

---

## 10. Open questions (decisions for review)

1. **Store: D1 vs KV.** D1 `hero_override` (proposed) gives FK
   integrity (`ON DELETE CASCADE`), audit joins, and matches
   `featured_datasets`. A single KV key is simpler but loses the FK
   and the cascade. **Recommendation: D1**, for the cascade alone
   (auto-clear on dataset retire).
2. **Endpoint freshness vs the 5-min client cache.** Keep 5 min for
   parity, or shorten the endpoint path to ~60 s so "Right now" is
   actually now? **Recommendation: 60 s for the endpoint, keep 5 min
   for the static file.**
3. **Does the portal page need its own role, or is `isPrivileged`
   enough?** Featured curation already uses `isPrivileged`; reusing it
   avoids a new role. **Recommendation: reuse `isPrivileged`.**
4. **Scheduling.** Set-now is the MVP. Future-dated pins fall out of
   the `window.start` semantics for free (a pin with `start` in the
   future is inert until then), so "schedule a hero for Saturday"
   works with zero extra code — worth calling out as a built-in, not a
   follow-up.
5. **Preview fidelity.** Render the real `heroPanelUI` in the portal
   (proposed) vs a static mock. Real render is more faithful but pulls
   a client module into the portal bundle. **Recommendation: real
   render**, lazy-imported.

---

## 11. Effort estimate

Rough, assuming the existing publisher-portal patterns:

- Phase A: ~0.5–1 day (migration + read endpoint + heroService tweak +
  tests).
- Phase B: ~1 day (two routes + validation + audit + KV bust + tests).
- Phase C: ~1.5–2 days (portal page + live preview + form validation +
  tests).

Total ~3–4 days, shippable in three independent PRs. Compare: the
static-file v1 was a few hours. The delta buys the seconds-not-hours
curator loop and a UI — worth it once a curator will use it regularly.
