// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Editorial content for the generated `/setup` page.
 *
 * Everything in this file is prose and judgement: the phase
 * narrative, the traps, the gate sentences, the framing of the
 * dependency map. It is written by hand and reviewed like any other
 * copy.
 *
 * Everything the page says about *data* — which bindings exist, what
 * breaks without each one, which values the operator is asked for,
 * which prerequisites the tool can detect — is NOT here. That is
 * imported from the modules the setup tool itself uses, so the page
 * cannot disagree with `npm run setup`. See `render.ts`.
 *
 * The split matters: a wrong sentence here is a documentation bug an
 * editor can see. A wrong binding list would be a lie the operator
 * only discovers at 2am, and that class of bug is what this
 * generator exists to make impossible.
*
 * The two imports below are the exception that proves the rule: they
 * are type-only, and they exist so that a worksheet field naming a
 * question or a validator that the tool no longer has is a compile
 * error in *this* file, next to the prose that got it wrong.
 */

import type { AnswerKey } from '../lib/setup/interview'
import type { validators } from '../lib/setup/prompt'

/** Names of the validators `prompt.ts` actually implements. */
export type ValidatorName = keyof typeof validators

export type Tier = 1 | 2 | 3

export interface CodeBlock {
  /** Lines of the block. `#`-prefixed trailing text renders dimmed. */
  code: string
  /** Optional heading above the block. */
  label?: string
}

export interface Callout {
  kind: 'trap' | 'note' | 'gate'
  title: string
  /** Paragraphs. Inline `code` spans use backticks. */
  body: string[]
  code?: CodeBlock
}

export interface Phase {
  n: number
  /** Nav label — short. */
  label: string
  /** Slide-style heading. */
  title: string
  /** Minimum tier that needs this phase. 3 = Tier 3 only. */
  minTier: Tier
  /** Tier 3-only (the desktop fork). */
  tierExact?: Tier
  duration: string
  /** Sub-heading beside the duration. */
  aside?: string
  /** Opening paragraphs. */
  intro: string[]
  /** Worksheet keys this phase produces. */
  produces?: string[]
  /** The `npm run setup` invocation that does this phase, if any. */
  automated?: CodeBlock
  /** Prose explaining what the automated path does and does not do. */
  automatedNote?: string[]
  /** Blocks and callouts, in render order. */
  body?: Array<Callout | CodeBlock>
  /** Collapsed "Do it by hand" section. */
  manual?: {
    summary: string
    body: Array<Callout | CodeBlock | { html: string }>
  }
  /** The one thing that proves this phase worked. */
  gate: string
  /** Short form for the printable pre-flight sheet. */
  gateShort: string
  /** Anchor in SELF_HOSTING.md. */
  anchor: string
  /** Link text override. */
  linkText?: string
}

export const PHASES: Phase[] = [
  {
    n: 0,
    label: 'Before Cloudflare',
    title: 'Before you touch Cloudflare',
    minTier: 1,
    duration: '≈20 min',
    aside: 'all tiers · nothing here is automatable',
    intro: [
      'An account, a registrar, a login, and your own copy of the repository. Get these five values written down and everything after this has something to stand on.',
    ],
    produces: ['ORG', 'TRUST', 'W1', 'W2', 'W3'],
    body: [
      {
        kind: 'trap',
        title: 'Fork the repository first — {{W3}} is your fork, not upstream',
        body: [
          'Phase 3 rewrites `wrangler.toml` with your resource IDs, Phase 5 hands your remote to Cloudflare Pages, and Phase 8.6 runs the transcode workflow in your repo. A clone of upstream does all of that fine right up until you have IDs to push and nowhere to push them.',
          'Use GitHub\u2019s Fork button and keep every default. Then enable workflows in the Actions tab — GitHub creates forks with Actions off, so the transcode and deploy workflows never fire until you do.',
        ],
      },
      {
        code: `node --version          # must be >= 22
npm install -g wrangler
git lfs install         # once per machine, before the clone
wrangler login          # opens a browser
wrangler whoami         # confirms the account

git clone https://github.com/{{W3}}.git
cd terraviz && npm install`,
      },
    ],
    gate: '`wrangler whoami` prints the account matching {{W1}}.',
    gateShort: 'You are logged in to the right Cloudflare account.',
    anchor: 'phase-0--before-you-touch-cloudflare',
  },
  {
    n: 1,
    label: 'Run it locally',
    title: 'Run it on your laptop',
    minTier: 1,
    duration: '≈15 min',
    aside: 'all tiers',
    intro: [
      "Do this before touching Cloudflare. Five minutes now tells you whether a problem later is yours or the deploy's — and that's worth a great deal at hour three.",
    ],
    body: [
      { code: 'npm run dev          # http://localhost:5173' },
      {
        kind: 'trap',
        title: 'Order matters',
        body: [
          'Run these three in exactly this order. Reversing the last two leaves your node identity holding the literal placeholder key, and `/.well-known/terraviz.json` will serve it. The script warns but exits 0, so it is easy to miss.',
          '`npm run db:reset` is only the first two steps — it re-seeds the placeholder and does not re-stamp the key. Follow it with `npm run gen:node-key` every time: `npm run db:reset && npm run gen:node-key`.',
        ],
        code: {
          code: `npm run db:migrate    # 1. schema into .wrangler/ SQLite
npm run db:seed       # 2. 20 datasets + the node_identity row
npm run gen:node-key  # 3. keypair, and stamps its public half
                      #    onto the row seeded in step 2`,
        },
      },
      {
        kind: 'note',
        title: 'No Cloudflare account needed yet',
        body: [
          'Phase 1 runs entirely on your laptop. Every binding is served from `.wrangler/` on local disk, and `.dev.vars` sets `MOCK_AI=true` so the paths that would call Workers AI use a local mock. You do not need `wrangler login` until Phase 2.',
          'To exercise the real Workers AI — Orbit chat, voice, live embeddings — sign in and run `npm run dev:functions:ai` instead. That adds the `AI` binding, which wrangler can only run against Cloudflare rather than locally, so it is the one thing here that needs credentials.',
        ],
      },
      {
        code: `cp .dev.vars.example .dev.vars
npm run gen:node-key       # appends NODE_ID_PRIVATE_KEY_PEM
npm run dev:functions      # http://localhost:8788`,
      },
    ],
    gate: 'All four endpoints answer: 200 with datasets, a real public key, role `admin`, and a mock-embedder search result. If `/publish/me` returns 503, you copied to `.dev.vars.example` rather than `.dev.vars`.',
    gateShort: 'The globe loads on your laptop and all four test URLs answer.',
    anchor: 'phase-1--run-it-on-your-laptop',
  },
  {
    n: 2,
    label: 'Create resources',
    title: 'Create the Cloudflare resources',
    minTier: 1,
    duration: '≈10 min',
    aside: 'all tiers',
    intro: [
      'Nothing consumes these yet — and that is deliberate. This phase exists so that when Phases 3 and 8 ask for IDs, you already have them written down.',
    ],
    produces: ['W4', 'W5', 'W6', 'W7', 'W8', 'W9'],
    automated: { code: 'npm run setup -- --apply --only=resources' },
    automatedNote: [
      'Creates or adopts the D1 database, both KV namespaces, the R2 bucket, and the Vectorize index with its three metadata indexes — and records every ID for you. Re-running adopts what already exists rather than making a second one.',
    ],
    gate: 'W4 through W8 hold the IDs Cloudflare just printed, and W9 holds the dataset name you intend to use. No command creates W9 — an Analytics Engine dataset appears on first write. Turning the product on is a separate one-time click, and Phase 8.8 will not deploy without it.',
    gateShort: 'You have written down the six IDs Cloudflare just gave you.',
    anchor: 'phase-2--create-the-cloudflare-resources',
  },
  {
    n: 3,
    label: 'Point the repo',
    title: 'Point the repo at your resources',
    minTier: 1,
    duration: '≈5 min',
    aside: 'all tiers',
    intro: [
      "`wrangler.toml` ships with the upstream project's real resource IDs. Replace them now that yours exist.",
    ],
    automated: { code: 'npm run setup -- --apply --only=wrangler-toml' },
    automatedNote: [
      'It edits per binding block rather than by string replace. A global replace cannot tell the blocks apart: the two D1 blocks share a database name, and the two KV blocks share a section header. It refuses to apply while any ID is still unknown.',
    ],
    body: [
      {
        kind: 'note',
        title: 'Why this file matters when Pages ignores it',
        body: [
          'Pages reads its live bindings from the dashboard. But every wrangler command you run from your shell resolves its target through `wrangler.toml`. Getting this wrong means Phase 4 runs migrations against **upstream\u2019s database**, not yours.',
        ],
      },
    ],
    gate: '`wrangler d1 info CATALOG_DB` shows your database, 0 tables.',
    gateShort: 'Your commands now point at your database, not the original project\u2019s.',
    anchor: 'phase-3--point-the-repo-at-your-resources',
  },
  {
    n: 4,
    label: 'Create the schema',
    title: 'Create the schema',
    minTier: 1,
    duration: '≈10 min',
    aside: 'all tiers · the one that bites',
    intro: [],
    body: [
      {
        kind: 'trap',
        title: 'Select by binding name, never by database name',
        body: [
          'Both `[[d1_databases]]` blocks declare `database_name = "sphere-feedback"` with **different** migration directories. Passing the bare name is ambiguous: wrangler resolves it to the first match, silently applies the wrong set, and leaves the catalog tables uncreated.',
          'The symptom lands a long way from the cause — `table datasets has no column named bbox_n`, the first time somebody clicks Save draft in the portal.',
        ],
      },
    ],
    automated: { code: 'npm run setup -- --apply --only=migrations' },
    automatedNote: [
      'Applies both sets and stops on any failure. Add `--local-migrations` to rehearse against your local database first.',
    ],
    manual: {
      summary: 'Do it by hand',
      body: [
        {
          code: `wrangler d1 migrations apply CATALOG_DB  --remote   # migrations/catalog/
wrangler d1 migrations apply FEEDBACK_DB --remote   # migrations/`,
        },
        {
          html: 'Either order works now. FEEDBACK_DB used to have to run second: the generated catalog snapshot sat in its migrations directory and would apply for real on an empty database. That file lives in <code>schema/</code>.',
        },
      ],
    },
    gate: 'Both migration lists report nothing pending. Re-run both after every `git pull` that brings new migration files — they are idempotent.',
    gateShort: 'Your database has its tables, with nothing left to apply.',
    anchor: 'phase-4--create-the-schema',
  },
  {
    n: 5,
    label: 'Pages project',
    title: 'Create the Pages project',
    minTier: 1,
    duration: '≈25 min',
    aside: 'all tiers · Tier 1 finishes here',
    intro: [
      'Push your fork, then create the Pages project that builds from it and attach your hostname. This is the phase where your node gets a public address.',
    ],
    produces: ['W10', 'W11'],
    automated: { code: 'npm run setup -- --apply --only=pages' },
    automatedNote: [
      "Creates the project with the right build settings and attaches your custom domain. What it *cannot* do is connect the Git remote — that handshake is an OAuth flow between Cloudflare and GitHub with no API behind it. A project the tool creates is Direct Upload, so Cloudflare never runs your build and the `VITE_*` variables must be set wherever the build actually runs. Click Connect in the dashboard afterwards to convert it in place, or stay on Direct Upload and deploy from CI.",
    ],
    body: [
      {
        kind: 'note',
        title: 'Pick exactly one deploy path',
        body: [
          "The repo ships a `deploy` job that targets the project name `terraviz`. On a fresh fork it either fails for lack of secrets or — worse, if you have set them — deploys to a project that is not yours.",
          '**Dashboard Git integration (recommended):** delete or disable the deploy job in `ci.yml` and `poster.yml`. Keep type-check, unit-tests and build — they are fork-safe and need no secrets.',
          '**GitHub Actions (Direct Upload):** set repo secrets for your API token and account ID. Change every `--project-name` to yours, and set the repo variable `TERRAVIZ_SERVER`. Do *not* connect the Git integration. Note that forks land with Actions disabled and no secrets — GitHub never copies those.',
        ],
      },
    ],
    gate: 'The build goes green, the site loads at `{{W10}}.pages.dev`, and then `https://{{W2}}` serves it over TLS. Backend features will not work yet — no bindings.',
    gateShort: 'The site loads at your own domain, over HTTPS.',
    anchor: 'phase-5--create-the-pages-project',
  },
  {
    n: 6,
    label: 'Access + token',
    title: 'Cloudflare Access and the service token',
    minTier: 2,
    duration: '≈25 min',
    aside: 'Tier 2+ · everything after this depends on it',
    intro: [
      'Access is not optional for a publisher node. The middleware fails closed: without a team domain and an AUD, every publish route returns 503 and the CLI can do nothing.',
    ],
    produces: ['W12', 'W13', 'W14', 'W15'],
    body: [
      {
        kind: 'note',
        title: 'Do this part yourself first',
        body: [
          'Complete **Zero Trust onboarding** in the dashboard and add at least one identity provider. One-time PIN over email works and needs no IdP setup; Google, Okta or Entra are better for a real team. You will choose a team name — your team domain becomes `{{W12}}`.',
        ],
      },
    ],
    automated: { code: 'npm run setup -- --apply --only=access' },
    automatedNote: [
      'Discovers your team domain, creates the publisher application with all six destinations, creates both policies, mints the service token and attaches it. It records the AUD and prints the token pair **once** — have somewhere to put it.',
    ],
    gate: "The AUD is copied, the token pair is in your password manager, and the token appears in the Automation policy's include list.",
    gateShort: 'Staff sign-in works, and the token pair is saved somewhere safe.',
    anchor: 'phase-6--cloudflare-access-and-the-service-token',
    linkText: 'Full detail, plus the two optional Access apps',
  },
  {
    n: 7,
    label: 'Node secrets',
    title: "Generate your node's secrets",
    minTier: 2,
    duration: '≈5 min',
    aside: 'Tier 2+',
    intro: ['Two secrets are yours to create, and neither exists until you make it.'],
    produces: ['W16', 'W17', 'W18'],
    body: [
      {
        code: `npm run gen:node-key       # W16 into .dev.vars, W17 into node-public-key.txt
openssl rand -base64 32    # W18`,
      },
      {
        kind: 'trap',
        title: 'Back up the private key somewhere durable',
        body: [
          "It signs your node's federation responses. Regenerating it means re-provisioning your identity.",
        ],
      },
    ],
    automatedNote: [
      'The setup tool generates the preview signing key for you. It deliberately does *not* generate the node keypair — `gen:node-key` owns that. It has to, because it also writes the public key file Phase 9 reads, and stamps your local database. Both files are gitignored.',
    ],
    gate: '`.dev.vars` holds a single-line private key, and `node-public-key.txt` holds an `ed25519:` line.',
    gateShort: 'Your node has its own signing key, and you have backed it up.',
    anchor: 'phase-7--generate-your-nodes-secrets',
  },
  {
    n: 8,
    label: 'Wire it up',
    title: 'Wire bindings, storage and transcode',
    minTier: 1,
    duration: '≈35 min by hand, mostly one command',
    aside: 'all tiers',
    intro: [
      'Everything referenced here now exists. This is roughly forty dashboard interactions by hand, which is exactly why it is worth letting the tool do it.',
      'It also includes asset storage — the R2 public origin, its CORS policy and an S3 token — and video transcode. Both used to sit in the optional phase, after the phase that tells you to publish, while being prerequisites for publishing. Without R2 an uploaded thumbnail has no readable URL; without transcode, finalising a video upload returns 503 and rolls back. Do them here and one redeploy picks everything up.',
      '138 of the upstream catalog\u2019s 204 datasets are video, so transcode is the common case rather than an extra. Skip it only for a node publishing images, tours, metadata, or a mirror of upstream.',
    ],
    automated: { code: 'npm run setup -- --apply --only=bindings' },
    automatedNote: [
      'Writes every entry to both environments in a single call, from the same manifest the audit checks against — so it cannot produce a deploy that Phase 10 then calls broken. Anything it has no value for is listed as skipped, with the reason, rather than written blank.',
      '`npm run setup -- --apply --only=r2` does the storage half: it builds the CORS policy from your origins, so the two details that are easy to mistype cannot be, and attaches the public domain. Minting the S3 API token stays manual on purpose — automating it would need a token that can create tokens.',
    ],
    body: [
      {
        kind: 'trap',
        title: 'Set every entry on BOTH Production and Preview',
        body: [
          'The environment selector is at the top of the page and forgetting it is the most common cutover failure — "works on preview, breaks on production", or the reverse. Phase 10\u2019s audit catches it, but only if you run it.',
        ],
      },
      {
        kind: 'trap',
        title: 'There is a WAF trap in video transcode',
        body: [
          'Access service tokens bypass Access but not Bot Fight Mode. The runner\u2019s final callback gets an interstitial, ffmpeg finishes, the bundle lands, and the job still exits non-zero. You need a WAF skip rule on that path — and on the Free plan, plain Bot Fight Mode has no per-path override, so disabling it zone-wide is the recommended option.',
        ],
      },
      {
        kind: 'trap',
        title: "R2's CORS is strict in two ways",
        body: [
          '`HEAD` must be listed explicitly, even though Fetch treats it as a simple method. And `Content-Range` must be in `ExposeHeaders` — it is not CORS-safelisted, so the download dialog cannot read a file\u2019s size without it. Let the tool build the policy and neither can be mistyped.',
        ],
      },
    ],
    gate: 'Bindings take effect on the *next* deployment — **Deployments → ⋯ → Retry deployment**, or push a commit. Then open your node in a private window: the privacy disclosure banner appears on first load, and the network tab shows 204 responses from `/api/ingest`.',
    gateShort: 'Your node can reach its database, storage and AI. Check in a private window.',
    anchor: 'phase-8--wire-bindings-storage-and-transcode',
  },
  {
    n: 9,
    label: 'Node identity',
    title: 'Provision the node identity',
    minTier: 2,
    duration: '≈5 min',
    aside: 'Tier 2+',
    intro: [],
    body: [
      {
        kind: 'trap',
        title: 'Your production identity table is empty right now',
        body: [
          'The migrations create the table but never populate it, and neither `db:seed` nor `gen:node-key` touches remote D1 — both only write your local SQLite file. Until you run the command below, the well-known endpoint 503s and **every publish fails**: dataset inserts stamp their origin node from that table, and the column is NOT NULL.',
        ],
      },
      {
        code: `npm run terraviz -- init-node \\
  --server "$TERRAVIZ_SERVER" \\
  --client-id "$CF_ACCESS_CLIENT_ID" \\
  --client-secret "$CF_ACCESS_CLIENT_SECRET" \\
  --display-name "Terraviz — Your Org" \\
  --base-url "https://{{W2}}" \\
  --contact ops@{{ORG}}`,
      },
    ],
    automatedNote: [
      'It reads your public key file automatically and writes through the publisher API, so it needs only the service token — no wrangler, no direct database access. Idempotent: re-running updates the row in place, preserving the node ID so existing references stay valid.',
    ],
    gate: '`curl https://{{W2}}/.well-known/terraviz.json` returns 200, with your display name and your real public key. Not 503.',
    gateShort: 'Your node can say who it is when another node asks.',
    anchor: 'phase-9--provision-the-node-identity',
    linkText: 'Full detail, plus the wrangler fallback',
  },
  {
    n: 10,
    label: 'Verify',
    title: 'Verify',
    minTier: 1,
    duration: '≈5 min',
    aside: 'all tiers',
    intro: [
      'Run both. They check different layers and neither subsumes the other. One asks whether the dashboard\u2019s binding state matches what the code expects. The other asks whether the deployed node actually answers correctly.',
    ],
    body: [
      {
        code: `# layer 1 — bindings
CLOUDFLARE_API_TOKEN={{W11}} \\
CLOUDFLARE_ACCOUNT_ID={{W1}} \\
CLOUDFLARE_PAGES_PROJECT_NAME={{W10}} \\
npm run check:pages-bindings

# layer 2 — does the node answer?
TERRAVIZ_ACCESS_CLIENT_ID={{W14}} \\
TERRAVIZ_ACCESS_CLIENT_SECRET={{W15}} \\
npm run terraviz -- verify-deploy --server https://{{W2}}`,
      },
    ],
    gate: 'Bindings audit clean, and five of six deploy checks green.',
    gateShort: 'Both checks pass, except the empty-catalog one — that is expected here.',
    anchor: 'phase-10--verify',
  },
  {
    n: 11,
    label: 'Become admin',
    title: 'Sign in and become admin',
    minTier: 2,
    duration: '≈5 min',
    aside: 'Tier 2+ · no SQL required',
    intro: [
      'Open `https://{{W2}}/publish` in a browser. Access challenges you, you sign in, and the middleware provisions a row for your email.',
    ],
    body: [
      {
        kind: 'gate',
        title: 'How the first admin happens',
        body: [
          '**The first human to sign in on a deploy with no active admin is bootstrapped to admin automatically.** Service tokens are excluded — a machine credential never self-elevates. So on a fresh node, you become the admin by signing in.',
          'Everyone after you lands as a pending reviewer, and you approve and promote them from the Users tab. Admins cannot demote themselves or remove the last admin, so a node always keeps one operator.',
        ],
      },
    ],
    gate: '`/publish/me` shows your email with role **admin**, and the sidebar shows the Users tab.',
    gateShort: 'You are signed in as the admin and can add the rest of your team.',
    anchor: 'phase-11--sign-in-and-become-admin',
    linkText: 'Full detail, plus the no-admin escape hatch',
  },
  {
    n: 12,
    label: 'Put content in',
    title: 'Put content in',
    minTier: 2,
    duration: '≈15 min',
    aside: 'Tier 2+ · the last required phase',
    intro: [
      'Your node works but its catalog is empty. Publish your own from `/publish/datasets/new` — metadata-only drafts work immediately, asset uploads need Phase 8.5, and video needs 8.6 as well. Or mirror the upstream catalog, which is about 200 datasets.',
    ],
    body: [
      {
        code: `npx tsx scripts/refresh-sos-snapshot.ts

npm run terraviz -- import-snapshot \\
  --server "$TERRAVIZ_SERVER" \\
  --client-id "$CF_ACCESS_CLIENT_ID" \\
  --client-secret "$CF_ACCESS_CLIENT_SECRET" \\
  --dry-run                          # always dry-run first, then drop it`,
      },
      {
        kind: 'note',
        title: 'Know the tradeoff before you mirror',
        body: [
          "Those rows carry legacy video references that resolve through **upstream's** proxy, so their playback depends on upstream's uptime unless you mirror the proxy too. Content you publish yourself is transcoded to your own storage and never touches it. Import is idempotent — re-running skips rows already published.",
        ],
      },
    ],
    gate: 'Re-run `verify-deploy`. `catalog-populated` now passes and all six checks are green. That is a complete publisher node. Embedding jobs backfill semantic search asynchronously over the next ten minutes or so.',
    gateShort: 'All six checks pass. Your node is finished.',
    anchor: 'phase-12--put-content-in',
  },
  {
    n: 13,
    label: 'Add a CSP',
    title: 'Content-Security-Policy',
    minTier: 1,
    duration: '≈20 min',
    aside: 'all tiers · before you go public',
    intro: [
      '**The repo ships no CSP.** Upstream enforces one at the Cloudflare edge, and edge rules do not travel with a fork — so every fork is unprotected until its operator adds one. Your node works without it; do it anyway before the node faces the public.',
      'Remember `blob:` — the app uses it for preview tours and screenshots, and omitting it reproduces the "may not load data from blob:" failure. Test playback, VR and a tour before locking it down.',
    ],
    gate: 'Playback, VR and a tour all still work with the policy live.',
    gateShort: 'A CSP is in place and nothing broke.',
    anchor: 'phase-13--content-security-policy',
  },
  {
    n: 14,
    label: 'Optional features',
    title: 'Optional features',
    minTier: 2,
    duration: 'optional',
    aside: 'Tier 2+ · take what you want',
    intro: [
      'Everything up to here is work every node does. This is the first phase you can genuinely skip \u2014 the node is complete and serving content without any of it. All five are independent — read the trigger, take what you want, and come back for the rest whenever.',
      'Four things used to be filed here and are not, because calling them optional was wrong. R2 asset storage is now 8.5, video transcode 8.6, and Orbit chat providers 8.7 — that last one was never a task at all. The Content-Security-Policy is Phase 13, because every fork needs one.',
    ],
    gate: 'Each feature you turned on answers: the widget POST returns 200, the export writes an NDJSON object, `/publish/analytics` shows yesterday.',
    gateShort: 'The optional features you chose are working.',
    anchor: 'phase-14--optional-features',
    linkText: 'All five, in full',
  },
  {
    n: 15,
    label: 'Desktop app',
    title: 'Desktop app fork',
    minTier: 3,
    tierExact: 3,
    duration: '≈1 h',
    aside: 'Tier 3 only',
    intro: [
      "Three upstream-pinned values need changing, and each fails in its own way if you leave it. Skip this phase entirely for a web-only node.",
    ],
    body: [
      {
        kind: 'trap',
        title: 'The updater endpoint and signing key (15.1)',
        body: [
          "`src-tauri/tauri.conf.json` hardcodes upstream's release feed and public key. Leave them and your users' apps poll *upstream's* releases and reject every build you sign — the update path looks fine until the day you ship one.",
          'Generate a key pair, paste the public half into `updater.pubkey`, point `updater.endpoints` at your own fork\u2019s `latest.json`, and set `TAURI_SIGNING_PRIVATE_KEY` plus its password as repo secrets.',
        ],
        code: { code: 'npm run tauri signer generate -- -w "<password>"' },
      },
      {
        kind: 'trap',
        title: '`VITE_API_ORIGIN` (15.3)',
        body: [
          "Desktop webviews are served from `tauri://localhost`, so relative `/api/` paths do not resolve. The app rewrites them to an absolute origin that defaults to **upstream's**. Set `VITE_API_ORIGIN=https://{{W2}}` at build time or your desktop app talks to somebody else's backend.",
          'The same value drives deep-link host recognition, so setting it is also what makes your node accept its own `/dataset/…` links.',
        ],
      },
      {
        kind: 'note',
        title: 'Two more that only bite later',
        body: [
          '**macOS notarization (15.2)** is optional but conspicuous: `release.yml` signs only when all six `APPLE_*` secrets are present. Without them the build succeeds and ships unsigned, and macOS users meet the Gatekeeper "damaged" warning.',
          '**Weblate (15.4)** — `sync-weblate.yml` targets upstream\u2019s translation project. Disable the workflow unless you run your own, or it fails on every push to `main`.',
        ],
      },
    ],
    gate: 'A signed desktop build that talks to your API origin, not upstream. Install it and confirm the update check hits your fork\u2019s releases.',
    gateShort: 'Your desktop app talks to your node, not the original one.',
    anchor: 'phase-15--desktop-app-fork-tier-3',
    linkText: 'All four steps, in full',
  },
]

/**
 * Every optional feature, with its trigger. Not a curated subset:
 * the card used to show four of nine, so the ids read as an
 * arbitrary sample rather than a list — 13.2 sitting next to 13.7
 * with nothing between them. If it is in Phase 13, it is here.
 */
export const ADDONS: Array<{
  id: string
  title: string
  flag: string
  body: string
  extra?: string
}> = [
  {
    id: '14.1',
    title: 'Standalone feedback widget',
    flag: 'if you ship it',
    body: 'The standalone HTML build posts to `/api/feedback`, which takes wildcard CORS and no Origin so it works from `file://`. It needs a WAF skip rule: the widget runs without cookies and its fallback is a `mailto:` draft, so an interstitial silently swallows every submission rather than failing loudly.',
    extra:
      '**What it takes:** one WAF skip rule on `POST /api/feedback`, then a `curl` from a cookie-less client to confirm you get `200 {"ok":true}` rather than challenge HTML. The bindings it needs — `FEEDBACK_DB`, and `CATALOG_R2` for screenshots — you already set in Phase 8.',
  },
  {
    id: '14.2',
    title: 'Analytics long-term export',
    flag: 'recommended',
    body: 'Analytics Engine retains 30–90 days. A daily job drains each completed day into an archive bucket plus rollups — that is the data behind the in-app analytics tab. Run the backfill once while AE still remembers.',
    extra:
      '**What it takes:** `wrangler r2 bucket create terraviz-analytics`, bind it as `ANALYTICS_R2`, set `CF_ACCOUNT_ID` plus an `ANALYTICS_SQL_TOKEN` secret scoped to Account Analytics → Read, redeploy, then enable the daily workflow — forks start with scheduled workflows off. Run the backfill once from the Actions tab while Analytics Engine still remembers. Two commands verify it.',
  },
  {
    id: '14.3',
    title: 'CI-applied migrations',
    flag: 'opt-in',
    body: 'Lets `ci.yml` apply pending catalog migrations on every push to `main`, just before deploy. Off unless you set `ENABLE_D1_MIGRATE=1` — and only after granting your API token D1 Edit, because the step runs before the deploy and a token without it blocks the whole thing.',
    extra:
      "**What it takes:** grant your API token Account → D1 → Edit, *then* set the repo variable `ENABLE_D1_MIGRATE=1`. That order matters — the step runs before the deploy, so a token without D1 access blocks the whole deploy rather than just the migration. Editing a token's permissions keeps its value, so nothing needs rotating.",
  },
  {
    id: '14.4',
    title: 'Grafana',
    flag: 'probably skip',
    body: 'The in-app analytics tab is the primary surface and needs no external service. Grafana is here for ad-hoc SQL against the raw stream; there is no native Analytics Engine plugin, so the shipped dashboards post SQL over HTTP through Infinity.',
    extra:
      '**What it takes:** import the four dashboard JSONs from `grafana/dashboards/` and point an Infinity datasource at the Analytics Engine SQL endpoint. There is no native plugin, so the dashboards post SQL over HTTP with `root_selector: "data"`.',
  },
  {
    id: '14.5',
    title: 'Voice, events, blog, YouTube',
    flag: 'per-feature',
    body: 'Orbit voice runs on the `AI` binding with nothing set. Realtime streaming STT, the wake word and YouTube media suggestions each want their own variables. Each degrades quietly when those are absent rather than erroring, so turning one on is additive and turning it off is safe.',
    extra:
      '**What it takes:** nothing for Orbit voice or the events/blog feeds — both already run. Realtime streaming STT wants three variables plus an AI Gateway token, the wake word wants a build-time model URL, and YouTube suggestions want an API key. Each is independent, and each stays off rather than erroring when its variables are absent.',
  },
]

/** Symptom → cause → fix. The full sixteen live in the Markdown. */
export const TROUBLESHOOTING = [
  {
    symptom: '503 access_unconfigured on the publisher API',
    fix: 'The team domain or the AUD is missing — most often set on Production but not Preview. Confirm with the bindings audit rather than by eye.',
  },
  {
    symptom: '401 "Invalid or expired Access assertion"',
    fix: "Your AUD does not match the application that issued the JWT. Re-copy it from the application's Overview tab. A token minted for a different application in the same team is rejected by design.",
  },
  {
    symptom: 'Access blocks your own staff account',
    fix: 'The policy uses **Emails** (exact match against one address) instead of **Emails ending in** (suffix match). See Phase 6.',
  },
  {
    symptom: 'Save draft 500s: "table datasets has no column named bbox_n"',
    fix: 'The catalog migrations were not applied — usually because `migrations apply` was given the database *name* instead of the binding name. Confirm with `migrations list CATALOG_DB --remote`.',
  },
  {
    symptom: 'well-known 503s, or publishing fails on origin_node',
    fix: "Remote node identity is empty — Phase 9 was not run. The local seed and key-gen paths do **not** write remote D1. The 503's own error text tells you to run `gen:node-key`; that hint is wrong. Use `init-node`.",
  },
  {
    symptom: 'Deploy fails: "You need to enable Analytics Engine"',
    fix: 'The product is off on your account until somebody opens it once, and a Function declaring the binding cannot publish without it. Open Workers & Pages → Analytics Engine and create a dataset — name `terraviz_events`, binding `ANALYTICS` — then retry the deployment.',
  },
  {
    symptom: 'Ingest returns 204 but nothing lands in Analytics Engine',
    fix: "The binding is missing in the environment serving traffic — check *both* Production and Preview. The function silently skips the write when it is undefined. (A 403 instead means the CORS gate rejected it: curl does not send an Origin header unless you pass one.)",
  },
  {
    symptom: 'Portal shows "Your session has expired"',
    fix: 'Expected before your Access application covers the publish paths. Cloudflare answers with a cross-origin redirect the portal can detect but cannot follow. The Refresh button is the escape hatch — refreshing triggers Access at top-level navigation, you sign in, and the next fetch succeeds.',
  },
  {
    symptom: 'Zip download shows "size unknown"',
    fix: 'R2 CORS. No console error means the request succeeded but the length headers were not exposed — add both to ExposeHeaders. An allow-origin error means it was blocked outright, usually because HEAD is not in AllowedMethods. R2 treats HEAD and GET as distinct even though Fetch does not.',
  },
  {
    symptom: 'Orbit stops showing dataset chips after working briefly',
    fix: 'Free-tier neuron exhaustion, not a fault. The chat panel shows a reduced-functionality badge and quota resets daily. A docent turn burns roughly 50 neurons, so about 200 turns a day exhausts the free ceiling — sustained use needs Workers Paid.',
  },
  {
    symptom: 'verify-deploy SKIPs the publisher checks',
    fix: 'No service token configured. Re-run with the token env vars, and confirm the token is attached to a Service Auth policy on the publisher app.',
  },
]

/** Week-one operational advice. */
export const WEEK_ONE = [
  {
    title: 'Document who can flip the kill switches',
    body: 'You have two: a KV key that makes clients back off, and an environment variable. Write down who is allowed to use them.',
  },
  {
    title: 'Put token expiry in a calendar',
    body: 'A silently expired API token is a silently broken dashboard, and it will happen on a day nobody is looking.',
  },
  {
    title: 'Watch errors by category',
    body: 'A flood of network errors usually means an asset CDN rate-limiting you. Auth errors mean an LLM key issue.',
  },
  {
    title: 'Test your own feedback loop',
    body: 'File a report through the in-app form and confirm it arrives in the portal. Do it before a visitor does.',
  },
  {
    title: 'Add a Content-Security-Policy',
    body: "The repo ships none, and upstream's edge policy does not travel with a fork. See Phase 13.7 — and test playback, VR and a tour before you lock it down.",
    wide: true,
  },
]

/**
 * Worksheet presentation metadata.
 *
 * The *values* an operator is asked for come from the setup tool's
 * own `QUESTIONS`. This adds only what the tool has no reason to
 * carry: the W-numbers `SELF_HOSTING.md` uses, which phase produces
 * each one, and the substitution token that appears in command
 * blocks before a value is filled in.
 *
 * `fromTool` names the `AnswerKey` when the interview asks for this
 * value directly. Everything else is either discovered by the tool
 * (an ID Cloudflare assigns), generated locally (a keypair), or
 * shown once and never stored (a service-token secret) — and the
 * page says which, because "how many things must I actually type?"
 * is the question that decides whether someone starts at all.
 */
export type Origin = 'asked' | 'discovered' | 'generated' | 'shown-once' | 'default'

export interface WorksheetField {
  id: string
  label: string
  phase: number
  token: string
  placeholder: string
  note?: string
  secret?: boolean
  origin: Origin
  /**
   * The interview's `AnswerKey`, when the tool asks for this value.
   * Typed against the tool rather than left as a string, so renaming a
   * question fails to compile here instead of surfacing later as a
   * `crossCheck` message. The runtime check in `render.ts` still
   * earns its keep: `AnswerKey` is a hand-written union, so a question
   * can be dropped from `QUESTIONS` while its key lives on in the type.
   */
  fromTool?: AnswerKey
  /** Validator name from `scripts/lib/setup/prompt.ts`. */
  validator?: ValidatorName
  /** Consuming phases — drives the dependency map. */
  consumedBy: number[]
  /** Minimum tier that needs it. */
  minTier: Tier
}

export const WORKSHEET: WorksheetField[] = [
  { id: 'ORG', label: 'Your org domain', phase: 0, token: 'your-org.org', placeholder: 'your-org.org', note: 'The Access policy matches "emails ending in" this. A domain, not an address.', origin: 'asked', fromTool: 'staffEmailDomain', validator: 'emailDomain', consumedBy: [6, 8, 9], minTier: 2 },
  { id: 'W1', label: 'Cloudflare account ID', phase: 0, token: '‹account-id›', placeholder: '32-char hex', note: 'Dashboard sidebar, and in every dashboard URL.', origin: 'asked', fromTool: 'accountId', validator: 'accountId', consumedBy: [5, 10, 13], minTier: 1 },
  { id: 'W2', label: 'Node hostname', phase: 0, token: '‹your-hostname›', placeholder: 'terraviz.your-org.org', note: 'Hostname only. No https://, no trailing path.', origin: 'asked', fromTool: 'hostname', validator: 'hostname', consumedBy: [5, 6, 8, 9, 10, 13, 14], minTier: 1 },
  { id: 'W3', label: 'Git remote', phase: 0, token: '‹owner/repo›', placeholder: 'owner/repo', note: 'Where Pages watches for builds.', origin: 'asked', fromTool: 'githubRepo', validator: 'repoSlug', consumedBy: [5, 14], minTier: 1 },
  { id: 'TRUST', label: 'Auto-approve domains', phase: 0, token: '‹trusted-domains›', placeholder: 'your-org.org,partner.org', note: 'Optional, and reversible from the Users tab later. Sign-ins from these domains skip the approval queue but land READ-ONLY (role reviewer), able to publish nothing. It grants nobody admin — the first sign-in does that. Blank means every sign-in waits for you, your own team included.', origin: 'asked', fromTool: 'trustedPublisherDomains', validator: 'emailDomainList', consumedBy: [8, 11], minTier: 2 },
  { id: 'W4', label: 'D1 database ID', phase: 2, token: '‹d1-id›', placeholder: 'from wrangler d1 create', note: 'The one value you cannot recover from a later error.', origin: 'discovered', consumedBy: [3, 8], minTier: 1 },
  { id: 'W5', label: 'KV — TELEMETRY_KILL_SWITCH', phase: 2, token: '‹kv-killswitch-id›', placeholder: '32-char hex', origin: 'discovered', consumedBy: [3, 8], minTier: 1 },
  { id: 'W6', label: 'KV — CATALOG_KV', phase: 2, token: '‹catalog-kv-id›', placeholder: '32-char hex', origin: 'discovered', consumedBy: [3, 8], minTier: 2 },
  { id: 'W7', label: 'R2 bucket name', phase: 2, token: 'terraviz-assets', placeholder: 'terraviz-assets', note: 'Yours to rename; keep the bindings in sync if you do.', origin: 'default', consumedBy: [8, 13], minTier: 2 },
  { id: 'W8', label: 'Vectorize index', phase: 2, token: 'terraviz-datasets', placeholder: 'terraviz-datasets', origin: 'default', consumedBy: [8], minTier: 2 },
  { id: 'W9', label: 'Analytics Engine dataset', phase: 2, token: 'terraviz_events', placeholder: 'terraviz_events', note: 'Nothing to create — it appears on first write.', origin: 'default', consumedBy: [8, 13], minTier: 1 },
  { id: 'W10', label: 'Pages project name', phase: 5, token: '‹pages-project›', placeholder: 'terraviz', origin: 'asked', fromTool: 'pagesProject', validator: 'projectName', consumedBy: [6, 8, 10], minTier: 1 },
  { id: 'W11', label: 'CLOUDFLARE_API_TOKEN', phase: 5, token: '‹api-token›', placeholder: 'token value', note: 'Minimum scope: Account → Cloudflare Pages → Edit.', secret: true, origin: 'generated', consumedBy: [10, 13], minTier: 1 },
  { id: 'W12', label: 'Access team domain', phase: 6, token: '‹team›.cloudflareaccess.com', placeholder: 'your-org.cloudflareaccess.com', note: 'Team domain only, no https://. The tool discovers this for you.', origin: 'discovered', consumedBy: [8], minTier: 2 },
  { id: 'W13', label: 'Access AUD (publisher app)', phase: 6, token: '‹access-aud›', placeholder: '64-char hex', note: 'Application → Overview → Application Audience Tag.', validator: 'aud', origin: 'discovered', consumedBy: [8], minTier: 2 },
  { id: 'W14', label: 'CF_ACCESS_CLIENT_ID', phase: 6, token: '‹client-id›', placeholder: '….access', secret: true, origin: 'shown-once', consumedBy: [9, 10, 12, 13], minTier: 2 },
  { id: 'W15', label: 'CF_ACCESS_CLIENT_SECRET', phase: 6, token: '‹client-secret›', placeholder: 'shown once', note: 'Cloudflare shows this exactly once. Save it before closing the dialog.', secret: true, origin: 'shown-once', consumedBy: [9, 10, 12, 13], minTier: 2 },
  { id: 'W16', label: 'NODE_ID_PRIVATE_KEY_PEM', phase: 7, token: '‹node-private-key›', placeholder: 'from .dev.vars', note: 'Back this up. Regenerating it means re-provisioning your identity.', secret: true, origin: 'generated', consumedBy: [8], minTier: 2 },
  { id: 'W17', label: 'Node public key', phase: 7, token: 'ed25519:‹public-key›', placeholder: 'ed25519:…', note: 'Written to node-public-key.txt by gen:node-key.', origin: 'generated', consumedBy: [9], minTier: 2 },
  { id: 'W18', label: 'PREVIEW_SIGNING_KEY', phase: 7, token: '‹preview-signing-key›', placeholder: 'openssl rand -base64 32', secret: true, origin: 'generated', consumedBy: [8], minTier: 2 },
  { id: 'W19', label: 'R2 public origin', phase: 8, token: 'assets.‹your-hostname›', placeholder: 'https://assets.your-org.org', note: 'Phase 8.5 — needed for asset uploads.', origin: 'asked', fromTool: 'r2PublicBase', validator: 'url', consumedBy: [8], minTier: 2 },
  { id: 'W20', label: 'R2_ACCESS_KEY_ID', phase: 8, token: '‹r2-access-key›', placeholder: 'R2 S3 API token', note: 'Phase 8.5.', secret: true, origin: 'shown-once', consumedBy: [8], minTier: 2 },
  { id: 'W20b', label: 'R2_SECRET_ACCESS_KEY', phase: 8, token: '‹r2-secret-key›', placeholder: 'shown once at mint time', note: 'Phase 8.5. Paired with the access key id.', secret: true, origin: 'shown-once', consumedBy: [8], minTier: 2 },
  { id: 'W21', label: 'R2 S3 endpoint', phase: 8, token: '‹r2-s3-endpoint›', placeholder: 'https://….r2.cloudflarestorage.com', note: 'Phase 8.5.', origin: 'shown-once', consumedBy: [8], minTier: 2 },
  { id: 'W22', label: 'GITHUB_DISPATCH_TOKEN', phase: 8, token: '‹github-dispatch-token›', placeholder: 'PAT with repo scope', note: 'Phase 8.6 — needed for video uploads.', secret: true, origin: 'generated', consumedBy: [8], minTier: 2 },
]

export const ORIGIN_LABELS: Record<Origin, { label: string; hint: string }> = {
  asked: { label: 'you supply', hint: 'The interview asks for this one and validates your answer.' },
  discovered: { label: 'Cloudflare assigns', hint: 'Created or read by the tool. You never type it.' },
  generated: { label: 'you generate', hint: 'A local command or dashboard action produces it.' },
  'shown-once': { label: 'shown once', hint: 'Cloudflare displays it a single time. Save it immediately.' },
  default: { label: 'has a default', hint: 'Ships with a working value; change only if you renamed the resource.' },
}

/** Readings called out under the dependency map. */
export const MAP_READINGS = [
  {
    title: 'The long bars are the expensive ones',
    body: 'Your hostname and the Access service token stretch across most of the install. Mistype the hostname in Phase 0 and you will be correcting it in six later places; lose the token secret and you re-mint and re-attach across five.',
  },
  {
    title: 'Phase 2 produces nothing anyone needs yet',
    body: 'Six values born, none consumed until Phase 3. That gap is deliberate — it is what lets Phase 3 and Phase 8 ask for IDs you already have written down instead of sending you back to the dashboard mid-edit.',
  },
  {
    title: 'Phase 13 has no bars at all now',
    body: 'It used to own five — the R2 origin, its key pair and endpoint, and the GitHub dispatch token. All five moved to Phase 8. Neither asset storage nor video transcode was really optional: a dataset with no readable image is not published, and 138 of upstream\u2019s 204 datasets are video. What is left in Phase 13 needs nothing written down, which is a fair test of whether something belongs there.',
  },
]

export const TIERS = [
  {
    n: 1 as Tier,
    name: 'Viewer node',
    duration: '~30 min',
    body: 'Globe, upstream catalog, Orbit chat, telemetry. No publishing. Stops after Phase 5.',
  },
  {
    n: 2 as Tier,
    name: 'Publisher node',
    duration: '2–3 h',
    body: 'Your own datasets and tours, the publisher portal, semantic search, events, blog. The usual choice.',
  },
  {
    n: 3 as Tier,
    name: 'Publisher + desktop',
    duration: '+1 h',
    body: 'Everything in Tier 2, plus branded Tauri desktop builds with your own update feed.',
  },
]

export const MARKDOWN_URL =
  'https://github.com/zyra-project/terraviz/blob/main/docs/SELF_HOSTING.md'
