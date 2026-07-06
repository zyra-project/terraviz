# WordPress Integration Plan — Terraviz as a WordPress Plugin

**Status: draft for review.** Scopes whether and how Terraviz can
become a WordPress plugin: WordPress admin as the publisher
interface, WordPress accounts for authentication, the WP post
system for blogs, and embeddable Gutenberg blocks (single dataset,
tour, or full catalog) for the front end. Evidence is drawn from
the repository at the `claude/terraviz-wordpress-plugin-plan-hh9iql`
branch tip. Companion to
[`architecture/federation-scoping.md`](architecture/federation-scoping.md),
[`CATALOG_PUBLISHING_TOOLS.md`](CATALOG_PUBLISHING_TOOLS.md),
[`CATALOG_DATA_MODEL.md`](CATALOG_DATA_MODEL.md), and
[`CURRENT_EVENTS_PLAN.md`](CURRENT_EVENTS_PLAN.md).

**Last reviewed:** 2026-07-04 (initial scoping from Eric's brief:
"WordPress is a popular CMS at NOAA; can Terraviz be a WP plugin
using the admin dashboard as the publisher interface and WP
accounts for auth?").

**Revisit when any of the following becomes true:**

- Phase 4 federation ships. The wire-format JSON Schema and
  publish-API auth work it carries (§7 Directives 1–2 of the
  federation scoping doc) are load-bearing dependencies for this
  plugin; the packaging recommendation here assumes they land
  first or alongside.
- The publisher-CLI pilot resolves the service-token auth question
  (federation scoping §8 decision 4). This plan's auth
  recommendation (§5) is the *same* open question wearing a
  different hat; the pilot's answer settles both.
- A concrete NOAA (or other) WordPress deployment target is named,
  with its hosting model (WordPress VIP / Pantheon / self-hosted /
  Federal cloud) and its WordPress version / block-editor posture
  known. Several recommendations below hinge on facts we do not
  have yet.
- The `?embed=` minimal-chrome mode (§3.1) ships in the main repo —
  at that point the "front-end embed" half of this plan moves from
  "needs a small upstream change" to "buildable today."

**Supersedes when:** a WordPress plugin repository exists, ships a
1.0 to the WordPress.org directory (or an internal NOAA plugin
registry), and this doc's phased plan (§8) has been fully executed.
At that point this doc becomes the historical record of *why* the
integration was shaped this way; the plugin repo's own README and
CHANGELOG become the active source of truth.

---

## Reframing — the plugin is a fourth distribution channel, not a fork

Before the point-by-point answer: the question "can Terraviz be a
WordPress plugin?" is really three separate questions wearing one
coat, and they have very different answers.

Terraviz today ships through three channels: the Cloudflare Pages
web app, the Tauri desktop app, and the (pre-launch) publisher CLI
(`architecture/federation-scoping.md` §1). A WordPress plugin is a
**fourth channel**, and — critically — it is not a new *runtime*.
It does not reimplement the globe, the catalog, or the docent in
PHP. It is a **host-side adapter** that does three things a WordPress
site wants:

1. **Embed** the existing Terraviz web app (which already runs
   fine in a cross-origin iframe) into WordPress pages and posts,
   parameterised to show one dataset, one tour, or the whole
   catalog.
2. **Publish** to a Terraviz catalog node from inside `wp-admin`,
   using the same public write API the CLI and the `/publish`
   portal already use.
3. **Bridge** WordPress's native primitives — user accounts, the
   post/blog system, roles — to Terraviz's equivalents.

Read that way, the plugin maps almost exactly onto the partner-tier
model in the federation scoping doc:

| Federation tier | WordPress plugin equivalent | Auth needed |
|---|---|---|
| (none — public reader) | **Embed blocks** — show datasets/tours/catalog in WP content | **None.** Public read + public embed URL. |
| **Tier 0 — Publisher** | **wp-admin publisher dashboard** — CRUD datasets/tours from WP against the canonical (or a forked) node | Service token, or per-user bridge. |
| **Tier 1–2 — Peer / node operator** | A NOAA office running its *own* Terraviz node *and* a WordPress front door to it | Node hosting (out of scope here) + the above. |

The embed half needs no authentication and almost no upstream code
change — it is buildable in weeks. The publish half inherits the
*exact* open auth question the federation doc has already flagged
as unresolved (Cloudflare Access service tokens vs. a per-user
bridge). Keeping those two halves separate is the backbone of the
phasing in §8: **ship the zero-auth embed first; treat publishing
as the harder, auth-gated follow-on.**

### Is it even possible?

**Yes, unambiguously — and the embed half is close to free.** The
three load-bearing facts:

- **The web app already iframes cross-origin in production.** The
  poster site embeds the live app and deep-links it via URL params
  (`poster/index.html:6090-6117`). Nothing in the repo sets
  `X-Frame-Options` or a `frame-ancestors` CSP —
  `public/_headers:1-7` sets only `X-Content-Type-Options`,
  `Referrer-Policy`, and a `Permissions-Policy`. So a WordPress
  page can embed Terraviz today.
- **Single dataset, single tour, and full catalog are already
  URL-addressable.** `?dataset=<id>` (`src/main.ts:503-538`),
  `/dataset/:id` (`src/services/deepLinkService.ts:72-77`),
  `?tour=<slug>` (`src/utils/posterDeepLinks.ts:34-37`), and
  `?catalog=true` (`src/utils/catalogMode.ts:21-28`) all boot the
  app into the right state. A Gutenberg block is, at its core, a
  UI for composing one of these URLs into an iframe.
- **The publish API is plain HTTP+JSON** the CLI already speaks
  (`cli/lib/client.ts`), so a PHP client can speak it too. The
  only genuine obstacle is auth (§5), which is a *known* problem,
  not a novel one.

The rest of this document is about doing it *well* — SEO,
accessibility, the auth model, the WP-post-vs-Terraviz-blog
reconciliation, and the repo/packaging decision — not about
whether it can be done.

---

## Design goals

Four goals scope every decision below. They are stated intent
derived from Eric's brief and the project mission
([`MISSION.md`](../MISSION.md): "publishers reach an audience
without giving up their data, their branding, and their control"),
not derived from the codebase.

### Goal 1 — Meet publishers where they already are

NOAA (and many science/education institutions) already run
WordPress. The plugin's value is that a communications officer or
domain scientist who lives in `wp-admin` can put a live globe in a
post, or publish a dataset, **without learning the Terraviz portal
or the CLI**. If using the plugin is harder than using the existing
`/publish` portal, it has failed.

### Goal 2 — The plugin depends on published contracts, not shared source

This mirrors Goal 2 of the federation scoping doc ("the spec is
the artifact; the runtime is the partner's choice"). The plugin
consumes **versioned, machine-readable contracts** — the public
read API, the publish API, the embed-URL grammar — not the
Terraviz TypeScript source. This is what lets the plugin live in
its own repo, on its own release cadence, in PHP, without becoming
a maintenance anchor on the TS monorepo. It also rides directly on
federation §7 Directive 2 (publish JSON Schema for the wire
format): the plugin is a second consumer that makes those schemas
pay for themselves.

### Goal 3 — Secrets never reach the browser; the read path needs no secrets at all

The embed/read path is entirely public and must ship with **zero
credentials**. The publish path requires a credential (§5), and
that credential must live **server-side in WordPress** (encrypted
option or a `wp-config.php` constant) with every authenticated call
proxied through PHP. A Terraviz service token in front-end
JavaScript would be a catastrophic leak — it is a node-wide
`service`-role credential (§5). The architecture must make that
leak impossible, not merely discouraged.

### Goal 4 — Degrade gracefully for crawlers, no-JS, and accessibility

A globe in an iframe is opaque to search crawlers, invisible
without JavaScript, and awkward for screen readers. For a public
NOAA site that is unacceptable. Every embed block must server-side
render (in PHP, from the public catalog read API) a real title,
abstract, thumbnail, and a link — the interactive globe is
*progressive enhancement* layered over indexable, accessible HTML.

---

## 1. Current-state assessment — what helps and what hurts

### What already exists that the plugin can lean on

| Capability | Status | Evidence |
|---|---|---|
| Cross-origin iframe embedding of the web app | **Works in prod** | `poster/index.html:6090-6117`; no `X-Frame-Options`/`frame-ancestors` anywhere shipped (`public/_headers:1-7`) |
| Boot into a single dataset | **Live** | `?dataset=<id>` `src/main.ts:503-538`; `/dataset/:id` `src/services/deepLinkService.ts:72-77` |
| Boot into a tour | **Live** | `?tour=<slug>` `src/utils/posterDeepLinks.ts:34-37,111-137` |
| Boot into the full catalog browser | **Live** | `?catalog=true` `src/utils/catalogMode.ts:21-28`, `src/main.ts:335-336,539-566` |
| Composable view flags | **Live** | `?terrain=on`/`?labels=on`/`?borders=on`/`?rotate=on`/`?layout=`/`?orbit=open` `src/utils/posterDeepLinks.ts:191-226` |
| Public, unauthenticated catalog read API | **Live** | `GET /api/v1/catalog`, `/datasets/:id`, `/datasets/:id/manifest`, `/related`, `/events`, `/search`, `/featured`, `/blog`, `/blog/:slug` (see §4 of the auth map) |
| Publish API the CLI already drives | **Live** | `/api/v1/publish/**`, one middleware `functions/api/v1/publish/_middleware.ts:113` |
| A validated postMessage bridge to copy | **Live (for `/orbit` only)** | `src/ui/orbitPostMessageBridge.ts` — allow-list-validated host↔iframe channel; good template |
| Blog data model that maps cleanly to WP posts | **Live** | `blog_posts` table `migrations/catalog/0029_blog_posts.sql:24-48`; markdown body, draft/published, slug |
| Wire `Dataset` as one source of truth | **Live** | `WireDataset` in `functions/api/v1/_lib/dataset-serializer.ts` |

### What is missing or hurts, and who owns the fix

| Gap | Impact on the plugin | Owner |
|---|---|---|
| **No minimal-chrome / "embed" mode.** All chrome (browse, tools, help, chat trigger, home) renders unconditionally; `?catalog=true` *adds* chrome (tabs) rather than removing it. | Embeds show full app chrome inside a post — cluttered, wrong affordances. | **Main repo** — small change at the `src/main.ts:503-618` boot seam (§3.1). |
| **Web build fetches its own origin's `/api`.** `VITE_API_ORIGIN` is only applied in Tauri builds (`src/services/catalogSource.ts:149-159,177-191`); web builds always hit relative `/api`. | *Not* a blocker for iframe embeds (the iframe `src` is a full Terraviz origin, so the SPA runs against its own `/api`). Only a problem if you tried to run the bundle *inside* WP's origin — which this plan does **not** do. | N/A (design choice: embed by origin, not by bundle). |
| **All writes require a Cloudflare Access JWT** via `Cf-Access-Jwt-Assertion`, mintable only by Cloudflare's edge (`functions/api/v1/publish/_middleware.ts:151`, `functions/api/v1/_lib/access-auth.ts:154`). No native API-key or username/password path. | The publish half cannot authenticate with a plain token; it must sit behind Access and use a **service token** or a per-user bridge. This is the central constraint (§5). | **Shared** — plugin holds the credential; main repo may need a per-user auth path. |
| **No machine-readable API contract** (OpenAPI / JSON Schema). Wire shapes live in TypeScript and prose. | A PHP client hand-rolls request/response types and drifts. | **Main repo** — federation §7 Directive 2 already commits to this; the plugin is a second consumer. |
| **Terraviz blog stores markdown through a deliberately narrow allowlist** (no `IMG`, no `TABLE`, no `H1`, `<a>` attrs only — `src/ui/sanitizeHtml.ts:37-48`); WP emits HTML. | A markdown-vs-HTML storage/format mismatch if WP tries to *own* Terraviz blog content (§6). | Design decision (§6 recommends WP owns posts natively, not a two-way body sync). |
| **`/dataset/:id` has no lightweight render path** — it boots the full globe SPA (`src/main.ts:3333-3335`); the blog surface deep-links, never embeds a thumbnail. | The plugin cannot rely on a "dataset preview" HTML endpoint; it must build SSR previews itself from the read API (Goal 4). | **Plugin** (server-render from `/api/v1/datasets/:id`). |

### The two halves, cleanly separated

The single most important structural fact for planning:

- **Read/embed = zero credentials, public API, iframe by origin.**
  Buildable now (modulo the small `?embed=` upstream change).
  Blast radius on a leak: none.
- **Publish = one shared node-scoped credential, server-side only,
  auth model unresolved.** Gated on the same pilot the federation
  doc is gated on. Blast radius on a leak: node-wide.

Everything below respects this seam.

---

## 2. Integration points — enumerated and scoped

Eric named four (admin-as-publisher, WP accounts for auth, post/blog
connection, embeddable Gutenberg blocks) and invited more. Here they
are, each with a scope and a difficulty read. The suggestions beyond
the original four are marked **[new]**.

| # | Integration point | What it is | Difficulty | Phase |
|---|---|---|---|---|
| A | **Embed blocks** | Gutenberg blocks: single dataset, tour, full catalog, "right now" hero, related-datasets rail. Each renders an SSR fallback + a lazy iframe. | **S–M** | 1 |
| B | **Shortcode + oEmbed** **[new]** | `[terraviz dataset="…"]` shortcode for Classic Editor (many gov sites), and an oEmbed provider so pasting a Terraviz dataset URL auto-embeds. | **S** | 1 |
| C | **Server-side embed proxy / SSR** **[new]** | PHP fetches the public read API, caches in transients, renders indexable/accessible HTML under every block (Goal 4). | **M** | 1 |
| D | **wp-admin publisher dashboard** | Admin screens for dataset/tour list + create/edit/publish/retract, driving `/api/v1/publish/**` through a server-side proxy. | **L** | 3 |
| E | **Asset upload from wp-admin** | Two-step presigned-R2 upload (init → direct PUT → complete), proxied so the browser can PUT to R2 but the service token stays server-side. | **M–L** | 3 |
| F | **WP accounts → Terraviz auth** | Map WP roles to Terraviz roles; decide service-token-shared vs. per-user bridge (§5). | **L** (per-user) / **S** (shared) | 2–3 |
| G | **Post/blog bridge** | WP owns posts natively; a "cite Terraviz datasets/tours" block embeds them in posts; optional one-way WP→Terraviz blog sync for in-globe discovery (§6). | **M** | 4 |
| H | **Catalog sync / caching** **[new]** | Pull the catalog into WP transients so dataset pickers, SSR, and internal search work without a live call per request. | **M** | 3 |
| I | **Node/site settings screen** **[new]** | One settings page: which Terraviz node (canonical vs. a NOAA fork), the service token (encrypted), default embed options, telemetry posture. | **S** | 1/3 |
| J | **Analytics reconciliation** **[new]** | The embed inherits Terraviz's two-tier telemetry (`docs/ANALYTICS.md`); the plugin must not double-count and must respect the site's consent banner. | **S** | 1 |

The **critical-path spine** is A + C + B + I (a self-contained,
zero-auth embed plugin), then F + D + E (the authenticated
publisher), then G (the blog bridge). H and J are supporting.

---

## 3. The front-end embed (Integration points A, B, C)

This is the high-value, low-risk half. It ships first.

### 3.1 The one upstream change: an `?embed=` minimal-chrome mode

> **Shipped on this branch** (2026-07-04). `?embed=1` (with the
> `?embed=1&chat=1` opt-in) is implemented in `src/utils/embedMode.ts`
> + `src/styles/embed.css`, wired at the `src/main.ts` catalog-mode
> boot seam, and specified in
> [`EMBED_URL_GRAMMAR.md`](EMBED_URL_GRAMMAR.md). The rest of this
> section is the original rationale.

Today there is no chromeless mode (grep for
`kiosk|minimal.?chrome|chromeless` finds nothing in `src/`; the
closest is `?catalog=true`, which *adds* chrome). The embed
experience needs the globe (or catalog) with the surrounding app
chrome suppressed.

**Change (main repo, small):** read an `?embed=1` (or
`?chrome=min`) flag early in `InteractiveSphere.initialize()` and
gate the chrome. The branch point is already there —
`src/main.ts:503-618` is where the boot decides what to show. Set
a `body.embed-mode` class and suppress: the browse overlay
(`#browse-overlay`), the tools menu (`#map-controls`), the help
trigger, the chat trigger, the home button, and the catalog↔sphere
tab control. Keep: the globe, playback transport, and (optionally,
via a sub-flag) the Orbit chat trigger for a "dataset + ask
questions" embed.

This is the single dependency the embed half has on the main repo.
It is small, additive, and independently useful (kiosk displays,
the poster, digital-signage). It should land as its own PR in the
main repo, referenced from the plugin repo.

**Optional companion:** a lightweight host→iframe postMessage
bridge on the main app, modelled on
`src/ui/orbitPostMessageBridge.ts` (allow-list-validated messages,
`terraviz:ready` handshake, origin lockdown). Useful for
auto-resizing the iframe to content height and for the block editor
to live-preview option changes without a full reload. Not required
for v1 — URL params alone cover the static case.

### 3.2 Block anatomy — SSR fallback + progressive iframe

Every embed block (single dataset, tour, catalog, hero, related)
follows one shape, satisfying Goal 4:

1. **Server render (PHP, `render_callback`).** On page render, the
   plugin calls the public read API (`GET /api/v1/datasets/:id`
   for a dataset block; `GET /api/v1/catalog` for the catalog
   block), cached in a WP transient (Integration H), and emits real
   HTML: heading (title), abstract, `<img>` thumbnail
   (`thumbnail_ref` resolved via the read API), category tags, and
   an anchor to the canonical `/dataset/:id` URL. This is what
   crawlers index and what shows with JS disabled.
2. **Progressive enhancement (JS).** A small front-end script
   replaces the fallback with a lazy `<iframe src="…?dataset=<id>&embed=1">`
   on interaction or when scrolled into view (globes are heavy;
   don't boot N of them on page load). `loading="lazy"`, a
   sensible `aspect-ratio`, a click-to-load poster for
   below-the-fold blocks.
3. **Accessibility.** The iframe carries a `title`; the SSR
   fallback remains in the accessibility tree as a described
   alternative; keyboard focus order is sane.

The block's editor sidebar exposes: dataset/tour picker (typeahead
backed by `GET /api/v1/search` or the cached catalog), view flags
(terrain/labels/borders/auto-rotate → the existing URL params),
layout (`?layout=`), start time, and "show Orbit" toggle. The
picker is where Integration H (cached catalog) earns its keep.

### 3.3 Block set (v1)

| Block | Embed URL it composes | SSR fallback |
|---|---|---|
| **Dataset** | `/?dataset=<id>&embed=1[&terrain=on…]` | Title + abstract + thumbnail + link |
| **Tour** | `/?tour=<slug>&embed=1` | Tour title + first-step thumbnail + link |
| **Catalog** | `/?catalog=true&embed=1[&category=…]` | A server-rendered list/grid of dataset cards from `/api/v1/catalog`, each linking to `/dataset/:id` |
| **Right-now hero** | `/?dataset=<heroId>&embed=1` (hero id from `/api/v1/featured-hero`) | Hero card |
| **Related rail** **[optional]** | N dataset links from `/api/v1/datasets/:id/related` | Horizontal card rail |

### 3.4 Classic Editor + oEmbed (Integration B)

Government WordPress installs are frequently on Classic Editor or
older versions. A `[terraviz dataset="INTERNAL_…" terrain="on"]`
shortcode with the same SSR+iframe rendering covers them — the
shortcode and the block share one `render()` function. (The one
representative NOAA site probed for this plan — `gsl.noaa.gov` —
runs the block editor, §11, so v1 **leads with Gutenberg blocks**
and treats the shortcode as the compatibility path, not a co-equal
bet.)

An **oEmbed provider** is a cheap polish win: register Terraviz
dataset/tour URLs as oEmbeddable so an author pasting
`https://terraviz.zyra-project.org/dataset/INTERNAL_…` on its own
line gets an automatic embed. This can be done entirely plugin-side
(the plugin registers the provider and renders the embed), or the
main repo can expose an `/api/v1/oembed?url=` endpoint for the
generic WordPress oEmbed discovery path. Plugin-side is enough for
v1.

### 3.5 Which node does the embed point at?

The iframe `src` is a full origin, so the block needs to know
*which* Terraviz deployment to embed:

- **Default:** the canonical `terraviz.zyra-project.org`.
- **Configurable (Integration I):** a NOAA office running its own
  fork/node points the plugin at their origin. One setting,
  site-wide, overridable per block.

Because the embed targets an origin (not a bundle served from WP),
the `VITE_API_ORIGIN`-only-in-Tauri limitation
(`src/services/catalogSource.ts:149-159`) is a non-issue: the
embedded SPA runs on its own origin against its own `/api`.

---

## 4. `frame-ancestors` — the one embed-security decision

Today nothing restricts who may iframe the app (§1). That is
permissive-by-default. Two postures:

- **Leave it open.** Any site may embed Terraviz. Matches today's
  behaviour; maximises reach (aligned with the mission). The
  plugin just works anywhere.
- **Add a `frame-ancestors` allow-list** at the Cloudflare edge (or
  `public/_headers`) so only approved sites embed. This is an
  operator decision, not a plugin feature, and it *gates* the
  plugin — a NOAA site not on the allow-list would break. If a node
  operator wants this, the plugin's settings page should surface a
  clear error when the node refuses to frame.

**Recommendation:** stay open by default (it is the current, mission-
aligned behaviour); document `frame-ancestors` as an opt-in
operator lever for nodes that want to restrict embedding, and have
the plugin detect a framing refusal and show a helpful message
rather than a blank box.

---

## 5. Authentication — the crux (Integration F)

Everything under `/api/v1/publish/**` is gated by one middleware
that reads a Cloudflare Access JWT from `Cf-Access-Jwt-Assertion`
(`functions/api/v1/publish/_middleware.ts:151`) and verifies it
locally against the team JWKS (`functions/api/v1/_lib/access-auth.ts:154`).
**Only Cloudflare's edge can mint that JWT.** There is no native
API-key, bearer, or username/password path. This is the same wall
the CLI hits, and the same open question the federation scoping doc
parked at §8 decision 4.

A WordPress plugin therefore cannot authenticate to the publish API
on its own. It has three options, in increasing cost and fidelity.

### Option 1 — Shared service token (ship this first)

The plugin stores a Cloudflare Access **service token** (a
`Cf-Access-Client-Id` + `Cf-Access-Client-Secret` pair) server-side
in WordPress. Every publish call the plugin makes is proxied
through PHP, which attaches those headers; Cloudflare's edge
exchanges them for a JWT before the request reaches the Worker —
exactly what the CLI does (`cli/lib/config.ts:102-107`).

- **Provisioning:** a service token JIT-provisions as role
  `service`, status `active` (`functions/api/v1/_lib/publisher-store.ts`
  `provisioningDefaults`). `service` is **privileged**
  (`isPrivileged = admin||service`) — it can create/edit/publish
  content and see all rows — but is **not admin** (`isAdmin`
  strictly `admin`), so it cannot manage users
  (`functions/api/v1/_lib/publisher-store.ts:213,224`). That is the
  right ceiling for a publishing bridge.
- **Attribution:** every action is attributed to one synthetic
  identity `<client-id>@service.local`
  (`functions/api/v1/_lib/access-auth.ts:234`), *not* to the WP
  user who performed it. The audit trail says "the WordPress
  plugin did this," not "Jane did this."
- **In-WP authorization:** because Terraviz sees one identity, the
  plugin must do its *own* per-user gating — map WP capabilities to
  what a WP user may do through the plugin (Integration F,
  in-WP half). E.g. only `edit_others_posts`-capable users may
  publish; `author`s may draft. This is WP-side policy on top of
  the one shared Terraviz credential.

**This is the recommended v1 publish auth.** It matches the CLI's
model exactly, keeps the secret server-side (Goal 3), and ships
without any main-repo change. Its honest limitation is
attribution: Terraviz's audit log and per-user role scoping don't
see individual WP users.

### Option 2 — Per-user bridge (the "leverage WP accounts" ideal)

Eric's brief asks to "leverage WordPress user accounts for
authentication." Done fully, that means each WP user's Terraviz
actions are attributed to *them*, with *their* Terraviz role. That
requires a Terraviz-side auth path that trusts an identity asserted
by WordPress — which does not exist today. Concretely, one of:

- **OIDC / SSO:** WordPress (via a plugin like miniOrange or a
  custom OIDC provider) acts as an identity provider; Terraviz adds
  an `authProvider` that accepts OIDC bearer tokens. The federation
  scoping doc already contemplates exactly this
  (`architecture/federation-scoping.md` §8 decision 4: "if service
  tokens prove a bottleneck… OIDC, magic-link signup, bearer
  tokens becomes a Phase 4 prerequisite"). This is real work in the
  **main repo**, not the plugin.
- **Cloudflare Access as the IdP for WP too:** if the WordPress
  site *also* sits behind the same Cloudflare Access team, an
  authenticated WP user already carries an Access cookie; the
  plugin could forward the user's `Cf-Access-Jwt-Assertion`
  instead of a service token. This attributes actions to the real
  user with no main-repo change — but it constrains the WP
  deployment to live behind the same Access team, which most NOAA
  sites will not.

**Recommendation:** do *not* build Option 2 speculatively. Ship
Option 1, and let the publisher-CLI pilot (federation §8 decision
4) tell us whether service-token attribution is actually a
blocker. If a real NOAA deployment needs per-user attribution,
Option 2-via-OIDC becomes a scoped main-repo project, tracked
against Phase 4's auth work — not invented here.

### Option 3 — WP as a thin publishing UI over the existing portal

A non-option worth naming to dismiss: embed the existing `/publish`
portal in an `wp-admin` iframe and let Cloudflare Access handle
login. This "works" but defeats the purpose — the user still logs
into Access, not WordPress, and the admin experience is a
foreign iframe, not native WP screens. Rejected: it satisfies
neither Goal 1 (native WP feel) nor the "WP accounts for auth"
intent.

### The in-WP half of Integration F (needed for every option)

Regardless of which Terraviz-facing option, the plugin must map WP
roles → intended Terraviz capabilities for its *own* gating:

| WP role/capability | Plugin-granted Terraviz action |
|---|---|
| `administrator` (or a custom `manage_terraviz` cap) | Configure node/token; full dataset/tour publish |
| `editor` (`edit_others_posts`) | Create/edit/publish datasets & tours |
| `author` (`publish_posts`) | Create/edit drafts; request publish |
| `contributor` / lower | Embed blocks only; no publish |

This mapping is plugin-side policy and ships with Option 1.

---

## 6. The post / blog bridge (Integration G)

Terraviz has its own blog subsystem — a `blog_posts` table
(`migrations/catalog/0029_blog_posts.sql:24-48`, `+0031` for
`tour_id`) with markdown bodies, draft/published status, unique
slugs, and dataset/event/tour *grounding*. WordPress obviously has
its own posts. The temptation is a two-way sync. Resist it.

### The mismatch that makes two-way sync a trap

- **Format:** Terraviz stores **markdown**
  (`body_md`), rendered through a deliberately narrow allowlist —
  no `IMG`, no `TABLE`, no `H1`, `<a>` attributes only
  (`src/ui/sanitizeHtml.ts:37-48`). WordPress stores **HTML** (or
  block markup) with a much wider surface. Round-tripping bodies
  between the two loses fidelity in both directions.
- **Grounding:** Terraviz posts cite catalog primitives —
  `dataset_ids` (JSON array), `event_id`, `tour_id` — that have no
  native WP equivalent and whose "Explore the data" / citation /
  companion-tour affordances are rendered by
  `src/ui/blog/index.ts:172-199`. These would have to be
  reconstructed as WP post meta + custom rendering.
- **AI generate + companion tour** (`/api/v1/publish/blog/generate`,
  `functions/api/v1/_lib/blog-generate.ts`) is grounding-dependent
  and Terraviz-proprietary; it has no WP analog and stays
  Terraviz-side.

### Recommended shape: WP owns posts; Terraviz content embeds into them

1. **WordPress remains the authoring surface for WordPress posts.**
   No attempt to make WP edit Terraviz's `blog_posts` bodies.
2. **A "cite Terraviz data" block** (a specialisation of the §3
   dataset/tour blocks) lets an author drop a live dataset, tour,
   or related-rail into a normal WP post — this is the *actual*
   thing a NOAA blogger wants: "here's my post about the hurricane,
   with the live globe in it."
3. **Optional one-way sync: WP post → Terraviz blog** for
   discovery *inside the globe app*. When an author opts a
   published WP post into "show in Terraviz," the plugin creates a
   Terraviz `blog_posts` row via `POST /api/v1/publish/blog` whose
   `body_md` is a short markdown **summary + canonical link back to
   the WP post**, with `dataset_ids`/`tour_id` grounding carried
   from the block's citations. The WP post stays the source of
   truth; Terraviz gets a discoverable, grounded stub that links
   home. This respects the markdown allowlist (a summary is
   trivially markdown-clean) and the grounding model, and avoids
   the fidelity trap.

Two-way body sync, or making WP the master of Terraviz blog
content, is an explicit **non-goal** (§9).

### Extending the bridge to Events & Feeds

The plugin team asked whether the same one-way sync can target
Terraviz **Events** and **Feeds**. The Terraviz-side answer —
with the exact route shapes, entity fields, auth, and the
gaps a blog-shaped reuse would hit — is in
[`WORDPRESS_EVENTS_FEEDS_SYNC.md`](WORDPRESS_EVENTS_FEEDS_SYNC.md).
Headline: the publish routes exist, but they do **not** mirror the
blog quartet, and they shouldn't — a Terraviz *event* is a
curator-gated news story (born `proposed`, no self-publish), and a
Terraviz *feed* is an ingest **connector** (an RSS/EONET source
URL), not a content item. The recommended shape reuses
`POST /publish/events` verbatim with the WP permalink as
`source.url` and the imported event landing in the curator queue,
rather than parameterising the blog sync engine.

---

## 7. Repo & packaging decision — separate repo, shared contracts

Eric asked directly: separate repo, or another CI build in this
one? **Recommendation: a separate repository, with the plugin
depending on published contracts from the main repo — not on its
source.**

### Why separate

| Force | Pull |
|---|---|
| **Language & toolchain** | The plugin is PHP + a little JS (`@wordpress/scripts` for blocks). The monorepo is TypeScript/Vite/Rust. Dragging Composer, PHPUnit, `wp-env`, and PHP linting into a TS repo pollutes its CI and cognitive surface. |
| **Release cadence & channel** | WordPress plugins release to the WordPress.org SVN directory (or an internal NOAA registry) with their own `readme.txt`, plugin header version, and `trunk`/`tags` layout — nothing like the Terraviz web/desktop/CLI release flows (`.github/workflows/{ci,release,desktop}.yml`). |
| **Licensing** | WordPress.org requires GPLv2-or-later. Vendoring the plugin into the monorepo would entangle license posture; a separate repo keeps it clean. |
| **Doc-coverage & i18n gates** | The monorepo's `check:doc-coverage` and `check:i18n-strings` gates (CLAUDE.md) are TS-shaped; PHP files would need carve-outs. A separate repo sidesteps this entirely. |
| **Contributor audience** | WordPress plugin contributors are a different community than globe/graphics engineers. |
| **Goal 2 discipline** | The federation doc already commits to "the spec is the artifact." The plugin is the first external proof that the published contract is real. A plugin that `import`s TS types has no such discipline. |

### The cost of separate, and how to pay it

The real risk of a separate repo is **contract drift**: the embed
URL grammar (`?dataset=`, `?tour=`, `?catalog=true`, `?embed=`) or
the wire `Dataset` shape changes upstream and the plugin silently
breaks. Mitigations, all of which the project wants anyway:

- **Publish the wire contracts as versioned JSON Schema** — exactly
  federation §7 Directive 2 (`docs/protocol/v1/*.schema.json`,
  served at a stable URL, drift-checked in CI). The plugin
  generates its PHP request/response types from these.
- **Specify the embed-URL grammar as a small versioned document**
  (a new `docs/EMBED_URL_GRAMMAR.md` in the main repo, or a section
  in the protocol schemas). The `?embed=` PR (§3.1) is the natural
  moment to write it. The plugin depends on a grammar version, not
  on `main.ts`.
- **A plugin-side smoke test in the plugin's CI** that hits the
  canonical node's public read API and asserts the block SSR still
  renders — catches drift within a day, not a release.

### Options considered and rejected

- **Monorepo subtree (`wordpress/`) + a dedicated CI workflow that
  builds the `.zip`.** Keeps everything in one place and makes
  atomic cross-cutting changes possible, but drags PHP tooling into
  the TS repo, complicates the doc-coverage manifest, and couples
  the plugin's release to the monorepo's. Reasonable if the team is
  small and wants one place to look; rejected as the *default*
  because the forces above outweigh the convenience.
- **Fork-and-reimplement (the globe in PHP).** Never. The plugin is
  an adapter, not a runtime.

### Where the small upstream pieces live

Even with a separate plugin repo, three small things belong in the
**main repo** because they are Terraviz-runtime concerns:

1. The `?embed=` minimal-chrome mode (§3.1).
2. The published JSON Schema + embed-URL-grammar doc (§7, riding on
   federation Directive 2).
3. Any per-user auth path, *if* Option 2 (§5) is ever green-lit.

Everything else — blocks, shortcodes, oEmbed, the admin dashboard,
the service-token proxy, the WP-role mapping, the post bridge —
lives in the plugin repo.

---

## 8. Phased implementation plan

Phases are ordered by value-over-risk and by the read/publish seam
(§1). Each phase is independently shippable.

### Phase 0 — Upstream enablers (main repo)

- ~~Add the `?embed=1` minimal-chrome mode at the `src/main.ts`
  boot seam; add a `docs/EMBED_URL_GRAMMAR.md`.~~ **Done
  (2026-07-04)** — `src/utils/embedMode.ts`, `src/styles/embed.css`,
  `docs/EMBED_URL_GRAMMAR.md`.
- ~~(Rides on / coordinates with federation §7 Directive 2) publish
  the wire `Dataset` + catalog JSON Schema at a stable URL.~~ **Done
  (2026-07-04)** — `public/schema/v1/{dataset,catalog,well-known}.schema.json`,
  generated + drift-checked by `scripts/build-protocol-schemas.ts`
  (`npm run check:protocol-schemas`, in the type-check chain), served
  at `https://<node>/schema/v1/`. Prose + versioning policy in
  [`protocol/README.md`](protocol/README.md) and
  [`protocol/CHANGELOG.md`](protocol/CHANGELOG.md). The federation
  `feed.schema.json` and STAC-profile fields are deferred to Phase 4
  (their serializer doesn't exist yet).

**Exit:** an embed URL renders a chromeless globe; the embed grammar
and wire schema are documented and versioned. **Phase 0 complete.**

### Phase 1 — Zero-auth embed plugin (plugin repo)

- Plugin scaffold (header, `readme.txt`, GPLv2, `@wordpress/scripts`
  build, `wp-env` dev, PHPUnit + a public-API smoke test).
- Settings page (Integration I): node origin, default embed
  options, telemetry posture. No token yet.
- Dataset, Tour, and Catalog blocks (§3.3) with SSR fallback
  (Integration C) + lazy iframe + a11y (Goal 4).
- Shortcode + oEmbed (Integration B).
- Catalog caching in transients (Integration H) for the picker/SSR.
- Analytics reconciliation (Integration J): document that the embed
  carries Terraviz telemetry; expose a toggle; respect the site's
  consent tooling.

**Exit:** a WordPress author can put a live, indexable, accessible
dataset/tour/catalog into any page or post, pointed at any Terraviz
node, with no credentials anywhere. **This is the demo that makes
the case.**

### Phase 2 — WP account mapping (plugin repo, no Terraviz auth yet)

- Map WP roles/capabilities to intended Terraviz publish
  capabilities (§5, in-WP half). Custom `manage_terraviz` cap.
- Node/site settings gain a (still-inert) credential slot with
  encrypted storage and a "test connection" that calls a
  *read-only* authenticated probe (e.g. `GET /api/v1/publish/me`)
  to validate a token before any writes.

**Exit:** the plugin knows who may do what in WP terms, and can
validate a service token, without yet mutating the catalog.

### Phase 3 — Authenticated publisher dashboard (plugin repo + service token)

- Server-side publish proxy (Goal 3): all `/api/v1/publish/**`
  calls go through PHP, which attaches the service token; the token
  never reaches the browser.
- Dataset list + create/edit/publish/retract screens (Integration
  D), driving the publish API (§2 of the auth map).
- Asset upload from wp-admin (Integration E): PHP mediates the
  two-step presigned-R2 flow — init (`POST /datasets/:id/asset`),
  browser PUTs bytes directly to the presigned R2 URL, then
  complete (`POST /datasets/:id/asset/:upload_id/complete`). The
  service token stays server-side; only the short-lived presigned
  R2 URL reaches the browser.
- Tour create/edit if scope allows (else Phase 4).

**Exit:** a NOAA communications officer publishes a dataset from
`wp-admin` without touching the CLI or the portal. Attribution is
the shared `service` identity (§5 Option 1's known limitation).

### Phase 4 — Post/blog bridge (plugin repo)

- "Cite Terraviz data" block for use inside normal WP posts (§6.2).
- Optional one-way WP-post → Terraviz-blog-stub sync (§6.3) for
  in-globe discovery.

**Exit:** a WP blog post can carry live Terraviz content and,
optionally, surface itself for discovery inside the globe app.

### Phase 5 (conditional) — Per-user auth

- Only if a real deployment needs per-user attribution: scope the
  main-repo OIDC/bearer `authProvider` (§5 Option 2), coordinated
  with federation Phase 4's auth work. Not built speculatively.

### Rough effort

| Phase | Effort |
|---|---|
| 0 — upstream enablers | S–M |
| 1 — zero-auth embed | M (a few engineer-weeks) |
| 2 — WP account mapping | S |
| 3 — authenticated publisher | L |
| 4 — post/blog bridge | M |
| 5 — per-user auth (conditional) | L, main-repo |

Phases 0–1 are the shippable proof and the natural first PR(s).
Everything after is gated on real demand and on the auth question
the federation pilot answers.

---

## 9. Non-goals

- **Reimplementing the globe, catalog, or docent in PHP.** The
  plugin embeds and calls; it does not port.
- **Two-way blog body sync / WP as master of Terraviz `blog_posts`
  content.** The format and grounding mismatch (§6) makes this a
  trap. One-way WP→Terraviz *stubs* only.
- **Speculatively building per-user OIDC auth** (§5 Option 2)
  before a deployment needs it and before the federation pilot
  settles the auth model.
- **Shipping the service token to the browser**, ever (Goal 3).
- **Running the SPA bundle inside WordPress's own origin.** Embeds
  target a Terraviz origin by iframe; the bundle is not re-hosted
  in WP.
- **Zyra maintaining WP hosting-specific adapters** (VIP vs.
  Pantheon vs. self-hosted). The plugin is standard PHP; hosting
  specifics are the site operator's concern, mirroring federation
  Goal 2.
- **A `frame-ancestors` lockdown by default** (§4). Embedding stays
  open unless a node operator opts to restrict it.

---

## 10. Open questions for Eric

1. **Which WordPress, where?** *Partially answered — see the
   §11 probe of a representative NOAA site.* Confirmed there: NOAA
   GSL (`gsl.noaa.gov`) runs **current WordPress core with the block
   editor (Gutenberg)**, behind Cloudflare with aggressive bot
   management. The Gutenberg confirmation resolves the "how hard do
   we lean on blocks vs. shortcodes" question — lead with blocks
   (§3.4). Still open for any *specific* target deployment: hosting
   model (WordPress VIP? Pantheon? self-hosted gov infra?),
   multisite/network, exact core version, and plugin set — the
   hosting model is what gates any WordPress VIP plugin-review
   constraints (§7).
2. **Attribution: does per-user matter for v1?** Is the shared
   `service`-identity audit trail (§5 Option 1) acceptable to
   start, or is per-user attribution a hard requirement that pulls
   Option 2 (and main-repo auth work) into scope immediately?
3. **Which node do embeds point at by default** — the canonical
   `terraviz.zyra-project.org`, or a NOAA-operated fork? (Affects
   whether Integration I is optional or central.)
4. **Blog: embed-into-WP-posts only, or also surface WP posts
   inside the globe** (§6.3 one-way sync)? The former is clearly
   wanted; the latter is optional and worth confirming before we
   build it.
5. **Embedding openness** (§4): keep framing open (mission-aligned,
   current behaviour), or does any node need a `frame-ancestors`
   allow-list?
6. **Directory / distribution:** public WordPress.org plugin
   directory, or an internal NOAA plugin registry only? (Affects
   licensing posture, review process, and update mechanism.)

---

## 11. Representative deployment probe — gsl.noaa.gov

To ground open question 1 in a real target rather than a
hypothetical, NOAA's Global Systems Laboratory site
(`gsl.noaa.gov`) was fingerprinted from the outside on 2026-07-04.
It is a useful sample of the environment this plugin would actually
land in.

**Confirmed:**

| Finding | Evidence |
|---|---|
| Genuine WordPress, current core (2025-era, 6.7/6.8 class) | `/license.txt` is the verbatim WordPress GPL license, "Copyright 2011–2025" |
| Stock WordPress-core robots + core sitemaps (no Yoast/RankMath owning sitemaps) | `/robots.txt` = core's generated `Disallow: /wp-admin/` + `Allow: /wp-admin/admin-ajax.php` + `Sitemap: …/wp-sitemap.xml` |
| **Block editor (Gutenberg)** | Confirmed by the site operator (Eric), 2026-07-04 |
| Fronted by Cloudflare with aggressive bot management + AI "Content-Signal" robots directives | 403 to every automated client (curl, real headless Chromium, Anthropic fetcher) on `/`, `/wp-json/`, `/wp-login.php`, `/wp-sitemap.xml`; `cf-ray` / `__cf_bm` on every response; Content-Signal + AI-bot disallows (GPTBot, ClaudeBot, CCBot, Amazonbot, …) in robots.txt |

**Not externally determinable** (masked by the Cloudflare WAF, which
strips origin headers and 403s the page HTML): exact core version,
theme, plugin set, whether it is multisite, and the hosting model.
No WP VIP (`x-ac`), Pantheon (`x-pantheon-styx`), or WP Engine
(`x-wpe`) header leaked — consistent with self-hosted gov
infrastructure behind Cloudflare, but unconfirmed. These are a
~30-second check for anyone with browser access: view-source for
`wp-block-*` / `wp-content/themes/<name>` / `<meta name="generator">`,
and `wp-admin` for the editor and Site Editor.

**What it changes in this plan:**

- **Gutenberg is confirmed on a real NOAA target**, so the plan
  leads with Gutenberg blocks (§3.2–3.3) and treats the Classic
  shortcode (§3.4) as the compatibility fallback, not an equal bet.
- The **strict WAF / bot-management posture validates the
  "self-contained, no phone-home" non-goal** (§9). The embed model
  sidesteps the WAF cleanly — the iframe loads from the Terraviz
  origin directly in the end-user's browser, not proxied through
  the WP site's Cloudflare — but any publisher-side plugin making
  outbound calls to a Terraviz node must expect gov-grade egress
  scrutiny.
- **Hosting model remains the open sub-question** (§10 q1) that
  gates WordPress VIP plugin-review constraints (§7); confirm per
  target deployment.

This is one sample, not the population. Other NOAA sites may run
Classic, older cores, or different hosting — which is exactly why
the dual block-plus-shortcode path (§3.4) and the
hosting-agnostic, self-contained posture (§9) stay in the plan.

---

## Appendix — Evidence index

Files cited or relied on for this scoping (via subsystem
exploration on the branch tip):

**Embed / front-end**
- `poster/index.html:6090-6117` — production cross-origin iframe embed
- `public/_headers:1-7` — shipped headers (no `X-Frame-Options`/CSP framing)
- `src/main.ts:503-618,3318-3335,714-717` — boot seam, deep-link routing, blog/publish gates
- `src/services/deepLinkService.ts:72-77` — `/dataset/:id` parsing
- `src/utils/catalogMode.ts:21-28` — `?catalog=true`
- `src/utils/posterDeepLinks.ts:34-37,74-94,111-137,191-226` — `?tour=`, layout, view flags
- `src/services/catalogSource.ts:28-33,88-98,149-159,177-191` — `VITE_CATALOG_SOURCE`, `VITE_API_ORIGIN` (Tauri-only)
- `src/config/endpoints.ts:40-66` — proxy base env vars
- `src/vite.config.ts:30-51,85-92` — two entry points, default base `/`, dev proxy
- `src/ui/orbitPostMessageBridge.ts` — validated host↔iframe bridge template

**Auth / publish API**
- `functions/api/v1/publish/_middleware.ts:113,136-149,151,167-179` — the single publish auth gate
- `functions/api/v1/_lib/access-auth.ts:38,84-108,154,186-238` — Access JWT verify, service-token distinction, synthetic email
- `functions/api/v1/_lib/publisher-store.ts:118,143,213,224` — JIT provisioning, `isPrivileged`/`isAdmin`
- `functions/api/v1/publish/me.ts:15`, `publishers.ts`, `publishers/[id].ts` — identity + user management
- `migrations/catalog/0005_publishers_audit.sql:21-31`, `0023_publisher_roles_two_tier.sql` — publisher roles
- `functions/api/v1/publish/datasets/[id]/asset.ts`, `.../asset/[upload_id]/complete.ts` — presigned-R2 two-step upload
- `cli/lib/client.ts`, `cli/lib/config.ts:102-107` — the reference HTTP client the plugin mirrors

**Read API**
- `functions/api/v1/catalog.ts`, `datasets/[id].ts`, `datasets/[id]/manifest.ts`, `related.ts`, `events.ts`, `search.ts`, `featured.ts`, `blog.ts`, `blog/[slug].ts`

**Blog**
- `migrations/catalog/0029_blog_posts.sql:24-48`, `0031_blog_post_tour.sql:9` — schema
- `functions/api/v1/_lib/blog-store.ts`, `blog-generate.ts:215-238` — model, mutators, grounded AI draft
- `src/ui/blog/index.ts:133-199`, `src/ui/publisher/pages/blog-edit.ts` — public render, authoring
- `src/services/markdownRenderer.ts`, `src/ui/sanitizeHtml.ts:37-53` — markdown + narrow allowlist

**Strategy / framing**
- `docs/architecture/federation-scoping.md` (esp. Goals, §7 Directives 1–2, §8 decisions 3–4) — partner tiers, the auth question, "spec is the artifact"
- `MISSION.md`, `ROADMAP.md`, `docs/CATALOG_PUBLISHING_TOOLS.md`, `docs/CATALOG_DATA_MODEL.md`, `docs/CURRENT_EVENTS_PLAN.md`

**Representative deployment probe (§11)**
- `gsl.noaa.gov/license.txt` — verbatim WordPress GPL license (core confirmation, "Copyright 2011–2025")
- `gsl.noaa.gov/robots.txt` — stock WordPress-core robots (`/wp-admin/` disallow, `admin-ajax.php` allow, `wp-sitemap.xml`) + Cloudflare AI "Content-Signal" directives
- External 403s on `/`, `/wp-json/`, `/wp-login.php`, `/wp-sitemap.xml` (curl, headless Chromium via proxy, Anthropic fetcher) — Cloudflare bot management
- Block editor (Gutenberg) confirmed by the site operator, 2026-07-04
