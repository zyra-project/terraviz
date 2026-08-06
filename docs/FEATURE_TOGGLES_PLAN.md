# Per-node feature toggles (publisher portal + API gating)

> **Status: implemented** — shipped on branch
> `claude/feature-toggles-node-profile-pg8nds`
> ([PR #280](https://github.com/zyra-project/terraviz/pull/280)),
> 2026-07-14. This document is the implementation plan as approved
> before the work started, kept for the historical record — the
> design rationale, the resolved decisions, and the phase breakdown
> match what landed. For current behaviour, the code and its module
> maps are the source of truth.


## Context

Not every terraviz node wants every feature: some operators want a simplified datasets-only catalog with no newsroom (feeds/events/blog); others want the opposite — a commentary/syndication node with no dataset authoring. Today the publisher portal shows every tab to every admin and all API surfaces are always on. This plan adds **admin-controlled, per-node feature toggles**, stored alongside the node profile, that (a) hide portal tabs and gate portal pages, (b) gate the publisher API centrally, and (c) gate the public surfaces (blog routes, events/hero endpoints) so a disabled feature is genuinely off, not just hidden. The Overview page degrades to only the enabled features.

**Decisions made with the user:**
- **Fine-grained toggles**, one per feature: `events` (feeds + review queue + ingestion + media suggestions), `blog`, `hero` ("Right now"), `tours`, `workflows`, `analytics`, `feedback`, `datasets`. All default **ON**.
- **Public surfaces gated too** (soft-empty 200 for API reads; blog page renders not-found).
- **`datasets` is authoring-only**: hides portal Datasets/Import, blocks dataset/featured mutations; public catalog endpoints untouched.
- Toggle writes: **`isAdmin` only** (strictly `role === 'admin'`; deliberately stricter than node-profile's `isPrivileged`).
- **analytics-export stays ungated** (archive continuity); toggle hides the dashboard only.
- **Feedback off also gates public writes** (soft-accept 200 + drop so the app widget never errors).
- Fail-open: any store/KV error ⇒ all features treated ON (mirrors telemetry kill-switch semantics — worst failure is a disabled feature briefly reappearing).

Blast-radius analysis (Explore agents + graphify structural graph) found the key couplings this plan must honor: `blog-generate` uses events-store + tour-mutations; `publish/events/[id]/tour` creates tours; public `featured-hero` falls back to `featured-event`; `blog/[slug]` cites events; SPA consumers of events (`main.ts`, `datasetLoader.ts`, `docentService.ts`, `browseUI.ts`, `catalogEvents.ts`) all already degrade to empty.

## Design

### Storage — new singleton table (not a `node_profile` column)

`setNodeProfile()` does a full-column upsert and `validateProfileInput()` requires `orgName`, so a `features_json` column on `node_profile` would be clobbered by profile saves and unsaveable on an unfilled profile. Instead:

- **Migration `migrations/catalog/0037_node_settings.sql`** (0036 is taken twice; additive-only guard satisfied):
  ```sql
  CREATE TABLE node_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    features_json TEXT NOT NULL DEFAULT '{}',
    updated_by TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ```
  No seed row — absence = all defaults. Regenerate `schema/catalog-schema.sql` via `npm run db:dump-schema` in the same commit; apply locally with `npm run db:migrate`.

- **New store `functions/api/v1/_lib/node-settings-store.ts`** (template: `node-profile-store.ts`):
  - `getNodeSettings(db)`, `setNodeFeatures(db, publisher, features, now?)` (upsert id=1, audit `node_settings.update` via `_lib/audit-store.ts` with the disabled set in metadata), `validateFeaturesInput(raw)`, `bustNodeFeaturesCache(kv)`.
  - `getEffectiveFeatures(env: CatalogEnv): Promise<FeatureMap>` — **the hot-path read**: KV key `node-features:v1` (300s TTL), D1 on miss + fill; **fail-open, never throws**.
  - `features_json` stores only explicit values; normalization fills missing → `true`, drops unknown keys (forward-compatible).

- **Shared constants `src/types/node-features.ts`** (precedent: `src/types/zyra-workflow-constants.ts`, imported from `functions/` via relative path):
  ```ts
  export const FEATURE_KEYS = ['events','blog','hero','tours','workflows','analytics','feedback','datasets'] as const
  export type FeatureKey = (typeof FEATURE_KEYS)[number]
  export type FeatureMap = Record<FeatureKey, boolean>
  export function defaultFeatures(): FeatureMap
  export function normalizeFeatures(raw: unknown): FeatureMap
  ```

### API surface

- **New `functions/api/v1/publish/node-settings.ts`**:
  - `GET` — any signed-in publisher: `{ features, updatedBy, updatedAt }`, `private, no-store`.
  - `PUT` — **`isAdmin`-gated**; body `{ features: Partial<Record<FeatureKey, boolean>> }`; audits, busts `node-features:v1` **and** the public node-profile cache; returns the effective map.
- **Extend public `GET /api/v1/node-profile`** (`functions/api/v1/node-profile.ts`) payload to `{ profile, features }`. **Bump `NODE_PROFILE_CACHE_KEY` to `'node-profile:v2'`** in `node-profile-store.ts` so stale v1 bodies (no `features`) never serve; v1 entries expire via TTL. Both existing call sites (`resolvePortalChrome()` in `src/ui/publisher/index.ts`, blog boot in `src/ui/blog/index.ts`) get features for free.

### Server enforcement

**Publisher routes — central gate in `functions/api/v1/publish/_middleware.ts`** (after the publisher row resolves, before the `context.data` stash ~line 179). Match pathname against a prefix table with **segment-boundary** matching (`path === p || path.startsWith(p + '/')`) so `/publish/featured` (datasets) doesn't swallow `/publish/featured-hero` (hero). Export the table + matcher for direct testing.

| Prefix | Feature | Exemptions |
|---|---|---|
| `/api/v1/publish/events` | events | `/events/refresh` (in-handler no-op instead — cron stays green) |
| `/api/v1/publish/feeds` | events | |
| `/api/v1/publish/media` | events | |
| `/api/v1/publish/blog` | blog | |
| `/api/v1/publish/featured-hero` | hero | |
| `/api/v1/publish/tours` | tours | |
| `/api/v1/publish/workflows` | workflows | `/workflows/due` (in-handler `200 { workflows: [] }` — scheduler stays green) |
| `/api/v1/publish/analytics` | analytics | `analytics-export` naturally excluded by segment matching |
| `/api/v1/publish/datasets` | datasets | |
| `/api/v1/publish/featured` | datasets | |
| `/api/v1/publish/feedback` | feedback | |

Never gated: `me`, `node-profile` (+logo), `node-settings`, `node-identity`, `publishers`, `redirect-back`, `analytics-export`, all public catalog/search/dataset reads, `/api/ingest`, `/api/voice/*`.

Gated response: `403 { error: 'feature_disabled', feature: '<key>', message: ... }` (403 not 404 so the portal can render the right card).

**Public reads — per-handler gate, placed *before* each handler's KV-cache read** (so warm cached bodies never serve while off; no feature-cache busting needed on toggle). Response `Cache-Control: no-store`. Reuse each handler's existing empty/degraded constructor:

| Handler | Feature | Off behavior |
|---|---|---|
| `functions/api/v1/events.ts` | events | `200 { events: [] }` |
| `functions/api/v1/datasets/[id]/events.ts` | events | `200 { events: [] }` |
| `functions/api/v1/featured-event.ts` | events | `200 { event: null }` |
| `functions/api/v1/featured-hero.ts` | hero | `200 { hero: null }`; hero ON + events OFF ⇒ skip featured-event fallback |
| `functions/api/v1/blog.ts` | blog | `200 { posts: [] }` |
| `functions/api/v1/blog/[slug].ts` | blog | `404 not_found`; blog ON + events OFF ⇒ omit event citation, still 200 |
| `functions/api/v1/tours.ts` | tours | `200 { tours: [] }` |

**Public feedback writes** (`functions/api/feedback.ts`, `general-feedback.ts`, `general-feedback-screenshot.ts`): feedback OFF ⇒ soft-accept `200` and drop (widget never errors). These live outside `/api/v1`; extend their env type with `CATALOG_DB`/`CATALOG_KV` (Pages bindings are project-wide) and call `getEffectiveFeatures`.

**Cross-coupling rules:**
- `publish/blog/generate.ts` / `_lib/blog-generate.ts`: events OFF ⇒ reject `eventId` with field error `{ field: 'eventId', code: 'feature_disabled' }`; tours OFF ⇒ same for the companion-tour option.
- `publish/events/[id]/tour.ts`: in-handler check on **tours** (middleware maps this path to events).

### Portal UI

- **Sidebar** (`src/ui/publisher/components/sidebar.ts`): `NavItem` gains `feature?: FeatureKey`; `SidebarOptions` gains `features?: FeatureMap`; `buildNav` filter becomes `(!item.adminOnly || isAdmin) && (!item.feature || features?.[item.feature] !== false)`. Undefined features (optimistic first render) shows everything — matches the existing `isAdmin: false` boot. Tags: datasets/import→datasets, workflows→workflows, feeds/events→events, featured-hero→hero, blog→blog, tours→tours, analytics→analytics, feedback→feedback. Overview/node-profile/users/me untagged.
- **Chrome** (`src/ui/publisher/index.ts`): `PortalChrome` gains `features` from the already-fetched `/api/v1/node-profile`; default `defaultFeatures()` on failure; skip the events-badge probe when events off.
- **Shared helper — new `src/ui/publisher/features.ts`**: `fetchFeatures()` (module-cached promise over the public node-profile GET), `resetFeaturesCache()`, `renderFeatureDisabledCard(mount, feature)` (mirrors the restricted-card idiom, e.g. `feeds.ts`; i18n keys `publisher.featureDisabled.*` + `publisher.feature.<key>`; hint that an admin can re-enable under Node profile). Called first in the render of: datasets (+new/detail/edit), import, workflows (+new/detail/edit), feeds, events, featured-hero, blog (+edit), tours, analytics, feedback. API 403 is the backstop for deep links.
- **Features card on the node-profile page** (`src/ui/publisher/pages/node-profile.ts`) — not a new route. Own Save button → `PUT /api/v1/publish/node-settings` (independent of the profile PUT, so an unfilled profile never blocks toggles); one toggle row per feature with a short description; on save `resetFeaturesCache()` + re-render sidebar via the existing chrome path. Card visible/editable to admins only (page is already admin-gated in nav; writes enforce `isAdmin`).
- **Overview** (`src/ui/publisher/pages/overview.ts`): thread a `features: FeatureMap` alongside the existing `privileged` boolean through `loadOverview()` (skip `getOrNull` fetches for events/feeds/hero/blog/workflows/feedback when off) and the render fns (needs-you cards, glance tiles, newsroom pipeline, feedback column, "New event" header action).
- **Cross-coupling UI**: blog-edit hides the event-grounding picker when events off and the companion-tour option when tours off; events page hides its create-tour action when tours off.

### Public SPA

- **Blog** (`src/ui/blog/index.ts`): boot already fetches `/api/v1/node-profile`; when `features.blog === false` render the existing not-found/empty state for both `/blog` and `/blog/:slug` (server 404 is the backstop).
- Hero panel, events overlays, "In the news", docent events: no changes — `null`/empty responses already hide/degrade them.

## Files (summary)

New: `migrations/catalog/0037_node_settings.sql`, `functions/api/v1/_lib/node-settings-store.ts` (+test), `functions/api/v1/publish/node-settings.ts` (+test), `src/types/node-features.ts`, `src/ui/publisher/features.ts` (+test).
Modified (key): `functions/api/v1/publish/_middleware.ts`, `functions/api/v1/node-profile.ts` + `_lib/node-profile-store.ts` (cache key bump), the 7 public read handlers above, `publish/events/refresh.ts`, `publish/workflows/due.ts`, `publish/blog/generate.ts` + `_lib/blog-generate.ts`, `publish/events/[id]/tour.ts`, `functions/api/feedback.ts` + `general-feedback*.ts`, `src/ui/publisher/{index.ts, components/sidebar.ts, pages/node-profile.ts, pages/overview.ts, pages/blog-edit.ts, pages/events.ts}` + the ~12 gated pages (one-line gate call each), `src/ui/blog/index.ts`, `schema/catalog-schema.sql`, `locales/en.json` (+`npm run locales`), `scripts/screenshots/scenes.ts` (+fixtures), `docs/BACKEND_MODULES.md` + CLAUDE.md module-map rows.

## Phasing (one logical change per commit, `git commit -s`)

1. **Foundation**: shared types + migration + schema dump + node-settings store + tests + doc rows.
2. **Settings API**: `publish/node-settings.ts` GET/PUT (isAdmin), audit, cache busts + tests.
3. **Public wire**: `/api/v1/node-profile` payload + `node-profile:v2` cache-key bump + tests.
4. **Middleware gate**: prefix table + envelope + exemptions + tests.
5. **Public read gating + couplings + cron no-ops + feedback writes**: the 7 public handlers, hero fallback skip, blog citation degrade, blog-generate rejections, events-tour check, refresh/due no-ops, public feedback soft-drop + tests.
6. **Portal chrome + page gates**: sidebar feature filter, `PortalChrome.features`, `features.ts` helper, disabled cards, i18n + tests.
7. **Features card** on node-profile page + i18n + screenshot scene/fixtures + tests.
8. **Overview threading** + tests.
9. **Cross-coupling UI + public blog SPA** + final full gate run.

Phases 1–5 are shippable alone (API-enforced, UI unaware); 6–9 each independently shippable.

## Verification

- `npm run type-check` (includes `check:i18n-strings`, `check:locales`, `check:migrations`, `check:doc-coverage`) and `npm run test` after every phase.
- `npm run db:migrate` + `npm run db:reset` locally; confirm `db:dump-schema` is clean.
- End-to-end with the dev server + `DEV_BYPASS_ACCESS`: toggle blog/events off via the Features card, then confirm — sidebar tabs disappear; deep-link `/publish/blog` shows the disabled card; `curl /api/v1/blog` → `{posts: []}`, `/api/v1/events` → `{events: []}`, `/blog` renders not-found; Overview hides newsroom pipeline + event cards; `POST /api/v1/publish/events/refresh` returns a 200 no-op; re-enable and confirm everything returns (KV bust) within the 300s cache window.
- `npm run screenshots:report -- --scene <node-profile scene>` for the Features card; `screenshots:smoke` still green.

## Notes / accepted risks

- Toggle propagation is not instant: KV bust + 300s TTLs ⇒ up to ~1–5 min for edge-wide effect. Acceptable for operator settings.
- Fail-open means a KV+D1 outage silently re-enables features; revisit per-feature if a toggle ever becomes compliance-relevant.
- The toggle map is world-readable via the public node-profile payload — acceptable (off-state is observable anyway).
