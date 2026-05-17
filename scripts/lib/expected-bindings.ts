/**
 * Expected binding manifest for the production Cloudflare Pages
 * project. The check-pages-bindings script (Phase 1f/B) diffs the
 * actual project's bindings against this list and prints the
 * delta — missing, unexpected, or wrong-environment.
 *
 * The manifest is the source of truth for the table in
 * `CATALOG_BACKEND_DEVELOPMENT.md` "Step 4 — Set Pages env vars and
 * bindings (Production AND Preview)". When a new binding is added
 * to the deploy story, add it here and reference it from the dev
 * doc — operators will then see a clean missing-binding row in the
 * script's output before the route 503s in production.
 *
 * Phase 1d/AB called out the most common foot-gun the live cutover
 * exposed: the dashboard offers a separate Production / Preview
 * toggle per binding, and forgetting either one shows up later as
 * "works on preview, breaks on production" (or vice versa). This
 * manifest models that explicitly — every entry declares which
 * environments it must cover.
 */

export type BindingType =
  | 'plaintext'
  | 'secret'
  | 'd1'
  | 'kv'
  | 'r2'
  | 'vectorize'
  | 'ai'
  | 'analytics_engine'

export type Environment = 'production' | 'preview'

export interface ExpectedBinding {
  name: string
  type: BindingType
  environments: Environment[]
  /** Operator-facing hint shown when the binding is missing. */
  hint?: string
}

const BOTH: Environment[] = ['production', 'preview']

export const EXPECTED_BINDINGS: ExpectedBinding[] = [
  // ── Cloudflare Access (publisher API auth) ────────────────────
  {
    name: 'ACCESS_TEAM_DOMAIN',
    type: 'plaintext',
    environments: BOTH,
    hint:
      'Without this the publisher middleware 503s with access_unconfigured. ' +
      'Set to the team domain (no protocol).',
  },
  {
    name: 'ACCESS_AUD',
    type: 'plaintext',
    environments: BOTH,
    hint:
      'The AUD tag from the Access application. Mismatch surfaces as 401 ' +
      '"Invalid or expired Access assertion".',
  },

  // ── Node identity + preview signing (secrets) ─────────────────
  {
    name: 'NODE_ID_PRIVATE_KEY_PEM',
    type: 'secret',
    environments: BOTH,
    hint:
      'Generate with `npm run gen:node-key`, then ' +
      '`wrangler pages secret put NODE_ID_PRIVATE_KEY_PEM`.',
  },
  {
    name: 'PREVIEW_SIGNING_KEY',
    type: 'secret',
    environments: BOTH,
    hint:
      'HMAC-SHA-256 secret for preview tokens. Without it the preview ' +
      'endpoints fail closed (503 preview_unconfigured).',
  },

  // ── Catalog data plane bindings ───────────────────────────────
  {
    name: 'CATALOG_DB',
    type: 'd1',
    environments: BOTH,
    hint: 'D1 database carrying the catalog schema (datasets, tours, publishers).',
  },
  {
    name: 'CATALOG_KV',
    type: 'kv',
    environments: BOTH,
    hint:
      'KV namespace for the public catalog snapshot. Without it `/api/v1/catalog` ' +
      'burns ~5 D1 reads per browse-page load.',
  },
  {
    name: 'CATALOG_R2',
    type: 'r2',
    environments: BOTH,
    hint: 'R2 bucket for sphere thumbnails, image data refs, and tour JSON.',
  },
  {
    name: 'AI',
    type: 'ai',
    environments: BOTH,
    hint:
      'Workers AI binding. Without it /api/v1/search returns 200 with ' +
      "{ degraded: 'unconfigured' } and a Warning header (the route never 5xxs " +
      "for missing bindings); the docent's [RELEVANT DATASETS] block stays empty " +
      'and chip rendering relies on the local-engine fallback (1f/O).',
  },
  {
    name: 'CATALOG_VECTORIZE',
    type: 'vectorize',
    environments: BOTH,
    hint:
      'Vectorize index `terraviz-datasets`. Provision via ' +
      '`wrangler vectorize create terraviz-datasets --dimensions=768 --metric=cosine` ' +
      'plus the metadata-index commands in CATALOG_BACKEND_DEVELOPMENT.md.',
  },

  // ── Other catalog/feedback/telemetry bindings ─────────────────
  {
    name: 'FEEDBACK_DB',
    type: 'd1',
    environments: BOTH,
    hint:
      'Sphere feedback D1 — same physical database as CATALOG_DB on the reference ' +
      'deploy, separate binding for migration scoping.',
  },
  {
    name: 'ANALYTICS',
    type: 'analytics_engine',
    environments: BOTH,
    hint: 'Analytics Engine dataset `terraviz_events` — backs the Grafana dashboards.',
  },
  {
    name: 'TELEMETRY_KILL_SWITCH',
    type: 'kv',
    environments: BOTH,
    hint:
      'KV namespace for the telemetry runtime kill switch. Read on every ingest ' +
      'request. The endpoint deliberately fails OPEN when this binding is missing ' +
      'or its read throws (`functions/api/ingest.ts` `isKillSwitchOn`) — telemetry ' +
      'continues to ingest. So a missing binding is operator-actionable (you lose ' +
      'the emergency lever) but does not stop ingest.',
  },

  // ── R2 public-bucket serving (Phase 3 r2-hls + Phase 3b assets + Phase 3c tours) ─
  // Required for the manifest endpoint to construct playable HLS
  // URLs for r2:videos/<id>/master.m3u8 data_refs (Phase 3), the
  // publisher API + SPA to resolve r2:datasets/<id>/<asset>
  // references on thumbnail / legend / caption / color_table
  // columns (Phase 3b), AND the SPA tour engine to fetch
  // r2:tours/<id>/tour.json + sibling assets after the Phase 3c
  // tour migration. Phase 3 migrates ~136 video rows; Phase 3b
  // migrates up to ~370 auxiliary asset URLs; Phase 3c migrates
  // ~198 tour.json files + 71 sibling assets. Missing on either
  // env → /api/v1/datasets/<id>/manifest returns 503
  // r2_unconfigured for the HLS branch specifically (the
  // R2_S3_ENDPOINT fallback is intentionally skipped there — see
  // `functions/api/v1/_lib/r2-public-url.ts:resolveR2HlsPublicUrl`).
  {
    name: 'R2_PUBLIC_BASE',
    type: 'plaintext',
    environments: BOTH,
    hint:
      'Public origin for the R2 bucket — set to your custom domain ' +
      '(e.g. https://video.zyra-project.org). Bind the domain in ' +
      'Cloudflare dashboard → R2 → bucket → Settings → Connect Domain ' +
      'first. The manifest endpoint uses this base to construct HLS ' +
      'master playlist URLs for Phase 3 r2:videos/ data_refs, the ' +
      'publisher API + SPA use it for Phase 3b r2:datasets/<id>/<asset> ' +
      'auxiliary-asset references, and the SPA tour engine uses it ' +
      'for Phase 3c r2:tours/<id>/tour.json + sibling references. ' +
      'Note: R2_S3_ENDPOINT is NOT a fallback for the HLS branch — ' +
      'that endpoint is for signed S3-API access, not public reads, ' +
      'and falling through to it would yield an hls URL that 403s at ' +
      'play time on a typical (non-public-bucket) production setup.',
  },

  // ── R2 S3-API credentials (Phase 3 + 3b + 3c operator-side migrations) ─
  // The migrate-r2-hls (Phase 3), migrate-r2-assets (Phase 3b),
  // and migrate-r2-tours (Phase 3c) CLIs talk to R2 via the S3
  // API (no native R2 binding outside the Worker runtime). One
  // set of three env vars covers all three CLIs. The audit
  // lists these here so the operator sees them as MISSING
  // before the migration attempt errors out at
  // credential-validation.
  {
    name: 'R2_S3_ENDPOINT',
    type: 'secret',
    environments: BOTH,
    hint:
      'R2 S3-API endpoint URL (e.g. https://<acct>.r2.cloudflarestorage.com). ' +
      'Shown alongside the access key when the R2 API token is minted. ' +
      'Read by the migrate-r2-hls / rollback-r2-hls (Phase 3), ' +
      'migrate-r2-assets / rollback-r2-assets (Phase 3b), and ' +
      'migrate-r2-tours / rollback-r2-tours (Phase 3c) CLIs from ' +
      "the operator's shell as well — same value goes in all three places.",
  },
  {
    name: 'R2_ACCESS_KEY_ID',
    type: 'secret',
    environments: BOTH,
    hint:
      'R2 S3-API access key id. Mint via R2 dashboard → Manage R2 API Tokens → ' +
      'Create token with Read+Write on the catalog bucket.',
  },
  {
    name: 'R2_SECRET_ACCESS_KEY',
    type: 'secret',
    environments: BOTH,
    hint:
      'R2 S3-API secret access key. Paired with R2_ACCESS_KEY_ID; shown once ' +
      'at token mint time.',
  },

  // ── GitHub Actions transcode dispatch (Phase 3pd) ─────────────
  // Wired into asset/{upload_id}/complete via
  // functions/api/v1/_lib/github-dispatch.ts. Without these, the
  // publisher API's video-upload finalisation 503s with
  // `github_dispatch_unconfigured`. The matching GHA repo secrets
  // (R2 + Access creds for the workflow runner) live on the
  // GitHub side; see SELF_HOSTING.md §8e.
  {
    name: 'GITHUB_OWNER',
    type: 'plaintext',
    environments: BOTH,
    hint:
      'Repo owner that hosts the transcode-hls workflow (e.g. zyra-project). ' +
      'Paired with GITHUB_REPO + GITHUB_DISPATCH_TOKEN to build the ' +
      'repository_dispatch URL.',
  },
  {
    name: 'GITHUB_REPO',
    type: 'plaintext',
    environments: BOTH,
    hint:
      'Repo name that hosts the transcode-hls workflow (e.g. terraviz). ' +
      'See GITHUB_OWNER.',
  },
  {
    name: 'GITHUB_DISPATCH_TOKEN',
    type: 'secret',
    environments: BOTH,
    hint:
      'GitHub fine-grained PAT (Contents: write on the workflow repo) or ' +
      'classic PAT with `repo` scope. Used by /asset/.../complete to fire ' +
      'the transcode-hls repository_dispatch on a video upload.',
  },
]
