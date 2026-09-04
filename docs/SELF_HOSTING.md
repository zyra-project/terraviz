# Self-hosting Terraviz

Status: rewritten 2026-08-01 for strict install order.

This guide walks you from an empty Cloudflare account to a running
Terraviz node.

**It is ordered so that no step ever asks you for a value that an
earlier step has not already produced.** That is the single rule this
document is built around, and the previous revision broke it three
ways:

- It asked for Access service tokens three phases before it told you
  how to mint one.
- It told you to paste resource IDs into `wrangler.toml` before the
  resources existed.
- It never created the Access application whose audience tag it told
  you to configure.

If you hit a step that references something you don't have yet,
that's a bug in this document — please file it.

Two companion reads:

- [`CATALOG_BACKEND_DEVELOPMENT.md`](CATALOG_BACKEND_DEVELOPMENT.md)
  — contributor setup for hacking on the backend, not deploying it.
- [`ANALYTICS_CONTRIBUTING.md`](ANALYTICS_CONTRIBUTING.md) — if
  you're working on the upstream repo rather than running a fork.

---

## Pick your node type first

Everything below is written for **Tier 2**. Tier 1 operators stop
after Phase 5; Tier 3 operators add Phase 15. Every tier finishes
with Phase 13 before going public — it is the CSP a fork does not
inherit. Phase 14 is genuinely optional and comes after it for
exactly that reason.

| Tier | What you get | What it costs you | Stop after |
|---|---|---|---|
| **1 — Viewer node** | The globe, the upstream SOS dataset catalog, Orbit chat, telemetry. No publishing. | ~30 min, $5/mo (Workers Paid) | Phase 5, then 13 |
| **2 — Publisher node** | Everything above, plus your own datasets/tours, the publisher portal, semantic search, events, blog. | ~2–3 h, $5/mo + storage | Phase 13 |
| **3 — Publisher node + desktop app** | Tier 2 plus branded Tauri desktop builds with your own update feed. | + ~1 h | Phase 15 |

> **Time estimates assume nothing goes wrong and your domain is
> already on Cloudflare DNS.** Budget a working afternoon for a
> first Tier 2 run. The bulk of the wall-clock is waiting on
> deploys and DNS, not typing.

---

## The worksheet

Every phase that *produces* a value tells you to write it down
here. Every phase that *consumes* one refers to it by line number.

**If you use `npm run setup`, most of this is kept for you** in
`.terraviz-setup.json` — the resource IDs, the Access AUD (the audience tag that identifies your application), the team
domain. What it cannot keep is anything marked 🔒: secrets are never
written to that file. Capture those yourself, in a password manager.

Four of them are shown **exactly once** and cannot be read back
afterwards — by three different vendors, at four different points in
the install:

| | What | Shown once by |
|---|---|---|
| `W11` | `CLOUDFLARE_API_TOKEN` | Cloudflare, at mint time (Phase 5) |
| `W15` | `CF_ACCESS_CLIENT_SECRET` | Cloudflare, in the service-token dialog (Phase 6) |
| `W20b` | `R2_SECRET_ACCESS_KEY` | Cloudflare, with `W20` (Phase 8.5) |
| `W22` | `GITHUB_DISPATCH_TOKEN` | GitHub, at mint time (Phase 8.6) |

Losing one is recoverable but tedious: revoke it, mint a new one, and
repoint everything already using it. `W16` and `W18` are different —
they are generated locally into `.dev.vars` and can be read back from
there. The worksheet below is still the reference for a by-hand
install, and for knowing what you should have when the tool is done.

```
── Phase 0 ───────────────────────────────────────────────
W1   Cloudflare account ID          ......................
W2   Your node hostname             ......................
        e.g. terraviz.your-org.org
W3   Your Git remote (owner/repo)   ......................

── Phase 2 ───────────────────────────────────────────────
W4   D1 database ID                 ......................
W5   KV id — TELEMETRY_KILL_SWITCH  ......................
W6   KV id — CATALOG_KV             ......................
W7   R2 bucket name                 ...... terraviz-assets
W8   Vectorize index name           .... terraviz-datasets
W9   Analytics Engine dataset name  ...... terraviz_events

── Phase 5 ───────────────────────────────────────────────
W10  Pages project name             ......................
W11 🔒 CLOUDFLARE_API_TOKEN          ......................
        scope: see the token table below

── Phase 6 ───────────────────────────────────────────────
W12  Access team domain             ......................
        e.g. your-org.cloudflareaccess.com
W13  Access AUD (publisher app)     ......................
W14 🔒 CF_ACCESS_CLIENT_ID           ......................
W15 🔒 CF_ACCESS_CLIENT_SECRET       ......................

── Phase 7 ───────────────────────────────────────────────
W16 🔒 NODE_ID_PRIVATE_KEY_PEM       ......................
W17  Node public key (ed25519:...)  ......................
W18 🔒 PREVIEW_SIGNING_KEY           ......................

── Phase 8.5–8.6 (assets and video) ──────────────────────
W19  R2 public origin               ......................
W20 🔒 R2_ACCESS_KEY_ID              ......................
W20b 🔒 R2_SECRET_ACCESS_KEY         ......................
        shown once, at mint time — with W20
W21  R2 S3 endpoint                 ......................
W22 🔒 GITHUB_DISPATCH_TOKEN         ......................
```

---

## Shortcut: `npm run setup`

Most of the phases below are mechanical, and a tool does them.
Four ways to run it — these are alternatives, not a sequence:

```bash
npm run setup -- --manual        # what only a human can do, with click paths
npm run setup -- --interactive   # answer the questions, guided and validated
npm run setup                    # plan only — writes nothing
npm run setup -- --apply         # provision + wire
```

**If you are installing for the first time, start with those top two.**
`--manual` prints the prerequisites no API can do for you: Workers
Paid, DNS, Zero Trust, and the API token with its exact permission
list. Each one comes with what breaks if you skip it.
`--interactive` then asks for
the handful of values only you know, explains where each one comes
from, and rejects a wrong answer *at the prompt* rather than three
phases later:

```
[2/5] Public hostname
    The address people will visit. Its zone must already be on
    Cloudflare DNS — Cloudflare provisions the certificate and the
    CNAME for you, but only for a zone it controls.
    Hostname only: no https://, no trailing path.
    e.g. terraviz.your-org.org
  Public hostname: https://terraviz.example.org
    → drop the https:// — just the hostname
  Public hostname: terraviz.example.org
```

It asks only what it cannot discover: anything already in your
environment or recorded by an earlier run is skipped, so a second run
asks nothing. Answers are saved as you go, so an interview abandoned
halfway does not start over.

Every run — interactive or not — ends with a **handoff report**. That
is the list of values you still have to paste somewhere this tool
cannot reach. Each one comes with its destination, and with the value
itself where it is known and not secret.

```
════ Values you need to paste elsewhere ════

  ✓ already handled    → do this    · optional

── Wherever your build runs
   → VITE_API_ORIGIN = https://terraviz.example.org
   · VITE_EARTH_ASSET_BASE
       from: nothing — the Earth textures ship in your own build
       (set it only to serve them from a CDN instead)

── GitHub → Settings → Secrets and variables → Actions
   → CF_ACCESS_CLIENT_SECRET
       from: same — save it at creation or rotate the token
   → TERRAVIZ_SERVER = https://terraviz.example.org

── Already handled — recorded in .terraviz-setup.json
   ✓ ACCESS_AUD = 7c1e…
```

| Phase | What the tool does |
|---|---|
| **5** | Creates the Pages project with the right build settings and attaches your custom domain. |
| **2** | Creates (or adopts) the D1 database, both KV namespaces, the R2 bucket, the Vectorize index and its three metadata indexes. |
| **3** | Repoints the `wrangler.toml` resource IDs at what it just created. |
| **4** | Applies both migration sets, in the order that works. |
| **6** | Discovers your Access team domain; creates the publisher application (six destinations), the Staff and Automation policies, and the service token — returning the AUD (`W13`) and the token pair (`W14`/`W15`). |
| **7** | Generates `PREVIEW_SIGNING_KEY` into `.dev.vars`. |
| **8** | Writes every binding, variable and available secret to **both** Production and Preview. |
| **8.5** | Sets the R2 CORS policy and attaches the public bucket domain. |
| **8.6/14.1** | Appends the two web-application-firewall (WAF) skip rules, preserving your existing rules. |

Two flags select different things, and it is worth keeping them
straight. **`--only=` picks which steps run.** **`--with=` declares
which optional features you want** — that is what adds the matching
questions to the interview, and the matching sections to the handoff
report. So `--with=r2 --only=r2` both asks you for the public asset
origin and then configures it; `--with=transcode` adds no step at
all, it just includes the transcode secrets in the handoff.

`r2` and `waf` are opt-in via `--only=r2` / `--only=waf`, not part of
a default run. The rulesets API replaces a zone's whole custom-rule
list rather than appending to it. Rewriting your zone security config
should be something you asked for, not something that happens on the
way past. (The merge preserves every existing rule and is tested for
exactly that; a failed read aborts rather than writing.)

It is **plan-by-default** — a bare `npm run setup` prints what it
would do and exits. It is idempotent: re-running adopts what already
exists rather than duplicating it. And it is resumable. Resolved IDs
land in `.terraviz-setup.json` as they are found — gitignored, never
any secret values — so a run that dies partway through picks up where
it left off.

It reads the same manifest the audit does
([`scripts/lib/expected-bindings.ts`](../scripts/lib/expected-bindings.ts)),
so it cannot provision a deploy that
`npm run check:pages-bindings` then calls broken.

**What stays manual**, and why:

| Phase | Why the tool can't |
|---|---|
| **0** | Cloudflare account, Workers Paid, nameservers — billing and registrar actions. |
| **5** (part) | *Connecting* the project to a Git remote. That handshake is an OAuth flow between Cloudflare and GitHub with no API — a token cannot grant Cloudflare access to your repos on your behalf. The tool creates the project; you either click Connect, or deploy from CI with `wrangler pages deploy dist/`. |
| **6.1** | Zero Trust onboarding + choosing an identity provider. One-time, per account. |
| **7** (half) | The node keypair — `npm run gen:node-key` owns it, because it also writes `node-public-key.txt` that Phase 9 reads and stamps your local D1. One command. |
| **11** | The first single sign-on (SSO) sign-in, which is what makes you admin. |
| **8.5** (part) | Minting the R2 S3 API token. Doing that over the API needs a bootstrap token that can *create tokens* — a strictly larger credential than anything else here, one that could mint itself more authority. Two clicks in the R2 dashboard, once. |
| **8.6** (part) | Writing GitHub Actions secrets, which requires libsodium sealed-box encryption (BLAKE2b, absent from `node:crypto`). Rather than add a dependency, `npm run setup -- --github-secrets` prints the exact `gh secret set` script, with values as `"$VAR"` references so it is safe to paste anywhere. |

The tool names whichever of these is blocking it. A typical Tier 2
install, guided:

```bash
npm run setup -- --manual         # do these in the dashboard first
export CLOUDFLARE_API_TOKEN=...   # the "Mint a Cloudflare API token" step

npm run gen:node-key              # Phase 7, the half the tool doesn't own
npm run setup -- --interactive    # answer 4-5 questions, see the plan
npm run setup -- --interactive --apply

# save the service-token pair it prints — Cloudflare shows it once —
# work through the handoff report, then redeploy and run Phases 9-12.
```

Or non-interactively, if you would rather drive it from a script:

```bash
export CLOUDFLARE_ACCOUNT_ID=<W1> CLOUDFLARE_API_TOKEN=<W11>
export TERRAVIZ_HOSTNAME=<W2> TERRAVIZ_STAFF_EMAIL_DOMAIN=your-org.org
export CLOUDFLARE_PAGES_PROJECT_NAME=<W10>
npm run setup -- --apply
```

`--interactive` refuses to run without a terminal rather than
blocking, so a CI job that reaches it fails cleanly instead of
burning its timeout.

`npm run setup -- --help` lists every flag and environment variable.

**Token scope.** The single `CLOUDFLARE_API_TOKEN` this needs.
Every node needs these five, because Phase 2 creates all five
resources:

| Permission | For |
|---|---|
| Account → Cloudflare Pages → **Edit** | Phases 5 and 8 |
| Account → D1 → **Edit** | Phase 2 creates it, Phase 4 migrates it |
| Account → Workers KV Storage → **Edit** | both namespaces, Phase 2 |
| Account → Workers R2 Storage → **Edit** | the bucket in Phase 2, the origin in 8.5 |
| Account → Vectorize → **Edit** | the search index, Phase 2 |

A publisher node adds Access. A viewer node never calls it:

| Permission | For |
|---|---|
| Account → Access: Apps and Policies → **Edit** | Phase 6 |
| Account → Access: Service Tokens → **Edit** | Phase 6 |
| Account → Access: Organizations → **Read** | discovering the team domain |

These two are needed only for the step named beside each:

| Permission | For |
|---|---|
| Zone → Zone → **Read** | `--only=r2` and `--only=waf` |
| Zone → Zone WAF → **Edit** | `--only=waf` |

Each step names the permission it is missing rather than failing
with a bare `10000: Authentication error`.

> **The two Zone rows are the ones people cannot find.** Each
> permission row has three dropdowns, and the first one — the
> scope — starts on **Account**. Zone permissions are not in the
> Account list at all. Change that first dropdown to **Zone** and
> the middle one refills with `Zone`, `Zone WAF` and the rest.
>
> A zone-scoped row also needs the **Zone Resources** section
> below Permissions. Leave it unset and the token carries the
> permission but reaches no zone. Include the zone your node runs
> on, or every zone in the account.
>
> **`export CLOUDFLARE_API_TOKEN=…` outranks `wrangler login`.**
> Wrangler prefers the token over your browser session, so Phases 2
> and 4 run with the scopes above rather than your own account
> access. This is why a Pages-only token reaches Phase 2 and then
> fails on D1, KV or Vectorize.
>
> The names above are current. If some other permission is missing
> from the list, `GET /user/tokens/permission_groups` returns every
> one with its scope.

---

# Phase 0 — Before you touch Cloudflare

## 0.1 Accounts and spend

| Requirement | Why | Automatable? |
|---|---|---|
| Cloudflare account | Everything runs here. | No — sign up by hand |
| **Workers Paid ($5/mo)** | Workers AI is capped at 10,000 Neurons/day on the free plan — roughly 200 Orbit turns — and you cannot exceed that without upgrading. Orbit then degrades to its local keyword engine mid-demo. | No — billing UI |
| A domain on **Cloudflare DNS** | For `W2`. Moving DNS to Cloudflare is free; you change nameservers at your registrar. Registering a new domain through Cloudflare also works. | No — registrar action |
| **A GitHub account** | This guide assumes GitHub throughout, and the automation needs it: you fork on GitHub, and video transcode fires a `repository_dispatch` at a GitHub Actions workflow in your own repo. Cloudflare Pages itself can build from any Git remote, or from Direct Upload — but nothing here is written or tested for another host. | No — sign up by hand |
| **Somewhere to keep secrets** | Four values in this guide are shown **exactly once** and cannot be read back: `W11`, `W15`, `W20b`, `W22`. A password manager is enough; a text file you will lose is not. | No — before you start |
| **Node.js 22+ and npm** | Build, test, migrate — and every `npm run` command in this guide. If you have no Node, install the LTS build from [nodejs.org](https://nodejs.org/en/download); it carries npm with it. `nvm` is fine if you already use it. | No — before you start |
| **git** | §0.2 clones your fork, and Cloudflare Pages builds from that remote. Downloading the repo as a zip gets you the code and no remote. Install it from [git-scm.com](https://git-scm.com/install/); macOS and most Linux ship with it. | No — before you start |
| `curl` | The verification steps in Phase 10. Ships with macOS, Linux and Windows 10+. | — |
| `openssl` | One command, in Phase 7 — and only if you generate `W18` by hand rather than letting the tool do it. Absent on stock Windows without WSL or Git Bash. | — |

Write your account ID (`W1`), your intended hostname (`W2`), and
your Git remote (`W3`) on the worksheet now. The account ID is in
the Cloudflare dashboard sidebar and in every dashboard URL.

> **Can I skip Workers Paid?** More than you might expect. D1, KV,
> R2, Vectorize, Analytics Engine and Workers AI all have free
> allocations, so a free-plan node provisions and runs. What you give
> up is headroom, and it fails soft: Orbit falls back to its local
> keyword engine once the day's 10,000 Neurons are gone. For a kiosk
> that will field questions all day, pay the $5. See
> [§0.6](#06-what-the-free-plan-actually-costs-you) for the numbers.

## 0.2 Fork the repository

Everything after this assumes you are working from **your own copy**
of `zyra-project/terraviz`, not from upstream. Phase 3 rewrites
`wrangler.toml` with your resource IDs, Phase 5 points Cloudflare
Pages at your remote, and Phase 8.6 runs the transcode workflow in
your repo. None of that is possible against a repo you cannot push
to.

**Record the result as `W3`** — `owner/repo`. It is the value the
`/setup` console reads to retarget its documentation links at your
fork, and the one Phase 5 hands to the Pages Git integration.

There are two ways to get your own copy, and they behave
differently. Pick before you clone; changing your mind later means
redoing Phase 5.

| | GitHub's **Fork** button | A separate repository |
|---|---|---|
| Actions | **Disabled** until you enable them in the Actions tab | On by default |
| Pulling upstream changes | Built in — Sync fork | Add a second remote by hand |
| Secrets on PRs raised from it | Never sent | Sent as normal |
| Shows as a fork of upstream | Yes | No |

**Take the Fork button** unless you have a reason not to. Staying
linked to upstream is how you get later fixes, and the disabled
Actions are one click to turn on.

Go to [the fork page](https://github.com/zyra-project/terraviz/fork)
and press **Create fork**. Nothing on that page needs changing. The
owner is you, the repository name stays `terraviz`, the description
carries over, and **Copy the `main` branch only** stays ticked —
`main` is the only branch a node needs.

**Take a separate repository** if your node is a hard divergence you
never intend to sync, or if your organisation forbids forks of
outside repos. Create an empty repo, then:

```bash
git clone https://github.com/zyra-project/terraviz.git
cd terraviz
git remote set-url origin https://github.com/<you>/terraviz.git
git push -u origin main
```

> **Do not skip this and clone upstream directly.** The clone works,
> the app runs locally, and nothing complains until Phase 3 has
> rewritten `wrangler.toml` with your IDs and you have no remote of
> your own to push them to.

## 0.3 Tools

```bash
node --version          # 22 or 24 — see the LTS note below
git lfs install         # once per machine; see the LFS note below
npm install -g wrangler
wrangler login          # opens a browser; needs an interactive terminal
wrangler whoami         # confirms the account you just authorised
```

If `git lfs` reports an unknown command, install Git LFS first —
[git-lfs.com](https://git-lfs.com) has installers for every
platform, and on macOS and most Linux it is one package
(`brew install git-lfs`, `apt install git-lfs`). Git for Windows
bundles it, but you still need to run `git lfs install` once.

`wrangler whoami` should print the account matching `W1`. If you
have several accounts, note which one — every `wrangler` command
below acts on the account you logged into.

> **Headless machine?** `wrangler login` needs a browser. Set
> `CLOUDFLARE_API_TOKEN` in the environment instead (see Phase 5.3
> for the permission set) and skip `wrangler login`.

> **Take an LTS release — 22 or 24.** Either works; the download
> button on nodejs.org gives you 24. One dependency
> (`better-sqlite3`) ships precompiled binaries only for the Node
> majors that were current when it was published. A Node that is
> past end-of-life, or newer than the dependency, has no binary to
> download. npm then tries to compile it from source, which needs a
> C++ toolchain you should not have to install. §0.4 says what that
> failure looks like.

> **Do this before you clone.** Seven images the globe renders —
> the star-field skybox and the specular map — are stored with Git
> LFS. Clone without it and you get 131-byte text files with `.jpg`
> names in their place. Nothing reports this. `npm run build`
> succeeds, the deploy succeeds, and the globe renders without
> stars. §0.4 has the check.

## 0.4 Get the code

```bash
git clone https://github.com/<W3>.git
cd terraviz
npm install
```

Check the LFS images arrived before you go further:

```bash
git lfs pull                          # no-op if they already did
ls -l public/assets/skybox/nx.jpg     # ~790 KB, not 131 bytes
```

131 bytes means it is a pointer, not an image. Run `git lfs install`
(§0.3), then `git lfs pull`, and check again. Doing this now costs a
few seconds; finding out later means a deployed node whose globe has
no stars and no clue why.

That checks one file because it is all you can check before
installing anything. Once `npm install` below has finished,
`npm run check:lfs` reports every LFS file at once.

`npm install` is not optional and is not only for contributors. It
puts the tooling every later `npm run` command needs on your path.
Skip it and the first one fails with something like
`'tsx' is not recognized`.

It also runs a `postinstall` that generates `src/styles/tokens.css`
and the i18n message modules. Both are build artifacts and
gitignored; if a later build complains about missing tokens,
`npm run tokens && npm run locales` regenerates them.

> **If `npm install` dies on `better-sqlite3`**, read the first
> warning line, not the last error. It says:
>
> ```
> prebuild-install warn install No prebuilt binaries found (target=… platform=win32)
> ```
>
> That means your Node has no precompiled binary, so npm fell back
> to building from source and hit a missing Python or C++ compiler.
> The fix is almost always to change Node, not to install a
> compiler. Check `node --version` and move to 22 or 24. This is
> the one dependency in the tree that compiles anything.

## 0.5 What the tool finds out, and what only you can

Eight things in this guide cannot be done by an API, and
`npm run setup -- --manual` prints all eight with their click paths.
They are not equally your problem, and the difference is worth
knowing before you start ticking boxes.

**Five of the eight, a later step detects.** You do not need to
verify them, remember them, or write anything down — if one is not
done, the tool says so, by name, at the point it matters:

| Prerequisite | Needed by | How you find out |
|---|---|---|
| Put your domain on Cloudflare DNS | Phase 5 | Attaching the custom domain prints Cloudflare's status for it, which never reaches `active` for a zone Cloudflare does not control |
| Mint a Cloudflare API token | Phase 5 | The first API call fails and names the missing permission |
| Complete Zero Trust onboarding | Phase 6 | Reading the team domain 404s, and the tool says so |
| Generate the node keypair | Phase 7 | The secrets step reports `NODE_ID_PRIVATE_KEY_PEM` absent |
| Connect Pages to your Git remote | Phase 5 | Project creation reports whether a Git source is attached |

**Three are genuinely on you**, because nothing in the API can see
them:

| Prerequisite | Needed by | Why it cannot be detected |
|---|---|---|
| **Fork the repository** ([§0.2](#02-fork-the-repository)) | Phase 3 onward | The tool asks for `W3` and validates its shape. It cannot check that the repo exists, that you own it, or that your checkout points at it |
| **Workers Paid ($5/mo)** | Phase 8 onward | Billing state is not exposed to the token. A free-plan account provisions everything successfully, then throttles Orbit once the day's Workers AI allocation is spent |
| **Mint the R2 S3 API token** | Phase 8.5 | Automating it would need a token that can mint tokens — a credential able to grant itself more authority. It stays manual on purpose. (The secret is also shown exactly once, so capture all three values then) |

That asymmetry is the whole reason the pre-flight list is short.
Confirm those three; let the tool tell you about the rest.

> This table is generated from `MANUAL_STEPS` in
> `scripts/lib/setup/interview.ts` on the [`/setup`](/setup) page,
> which is where to look if it ever disagrees with this one.

## 0.6 What the free plan actually costs you

Less than the rest of this guide used to claim. Every product a
Terraviz node binds has a free allocation, so a free-plan account
provisions the whole stack and serves real traffic.

| Product | Workers Free allocation | What happens at the ceiling |
|---|---|---|
| **Workers AI** (Orbit) | 10,000 Neurons/day | Requests fail. Orbit falls back to its local keyword engine. **You cannot buy past this without upgrading** — this is the one that bites |
| **Analytics Engine** (telemetry) | 100,000 data points + 10,000 read queries/day | Writes rejected past the cap. Not billed at all today |
| **Vectorize** (semantic search) | 30M queried + 5M stored vector dimensions/month | At 768 dimensions that is ~6,500 stored datasets |
| **D1** (catalog) | 5 GB total | A hard cap on Free, not an overage — writes start failing. Paid includes the same 5 GB, then $0.75/GB-month |
| **R2** (assets) | 10 GB-month | Billed at $0.015/GB-month past it, on either plan |
| **KV**, **Pages** | Ample for a single node | — |

The practical reading: Orbit is the reason to pay $5. Roughly 200
conversations a day exhausts the Neuron allocation, and a kiosk in a
museum lobby will pass that before lunch. Everything else on this
list either has room to spare at node scale, or is billed the same
whichever plan you are on.

> **Checked against Cloudflare's published pricing on 2026-08-03.**
> These allocations move, so re-read the
> [Workers pricing page](https://developers.cloudflare.com/workers/platform/pricing/)
> before you rely on them.
>
> One caveat on that page. Its Vectorize section still carries a
> stale "only available on the Workers paid plan" sentence, sitting
> directly above a table with a Workers Free column. Trust the
> [Vectorize pricing page](https://developers.cloudflare.com/vectorize/platform/pricing/)
> instead.

---

# Phase 1 — Run it on your laptop

Do this before touching Cloudflare. It costs five minutes and
tells you whether a problem later is yours or the deploy's.

## 1.1 The viewer (no backend, no account)

```bash
npm run dev          # http://localhost:5173
```

**Gate:** the globe renders, you can open Browse and search, and a
video dataset plays. The app is talking to public NASA GIBS tiles
and the upstream SOS catalog snapshot; there is no backend
involved. Orbit falls back to its local keyword engine because
`/api` isn't served by the Vite dev server — that is expected here.

## 1.2 The backend (optional, but do it if you're going Tier 2)

This runs the Pages Functions against a local SQLite file — the
catalog API, the publisher API, and the events and blog surfaces.
Mocks stand in for Workers AI, Vectorize, R2 and Stream.

**Run these three in exactly this order.** The order matters and
the previous guide never stated it:

```bash
npm run db:migrate    # 1. create the schema in .wrangler/ SQLite
npm run db:seed       # 2. insert 20 sample datasets + the node_identity row
npm run gen:node-key  # 3. generate the keypair AND stamp its public
                      #    half onto the node_identity row seeded in (2)
```

Reversing 2 and 3 leaves `node_identity.public_key` as the literal
string `ed25519:placeholder-key-replaced-by-gen-node-key-script`,
and `/.well-known/terraviz.json` will serve that placeholder. The
script warns when you get it wrong ("No node_identity row found in
local D1"), but it exits 0, so it's easy to miss.

`npm run db:reset` is `clean-d1-state && db:migrate && db:seed` — the
first two steps only. It re-seeds the placeholder and does **not**
re-stamp the key, so follow it with the third step every time:

```bash
npm run db:reset && npm run gen:node-key
```

Then start the Functions dev server:

```bash
npm run dev:functions   # http://localhost:8788
```

> ### This step needs no Cloudflare account
>
> Phase 1 runs entirely on your laptop. Every binding is served
> from `.wrangler/` on local disk, and `.dev.vars` sets
> `MOCK_AI=true` so the paths that would call Workers AI use a
> local mock. You do not need `wrangler login` until Phase 2.
>
> **To exercise the real Workers AI** — Orbit chat, voice, live
> embeddings rather than the mock — sign in and use the `:ai`
> variant instead:
>
> ```bash
> wrangler login
> npm run dev:functions:ai   # same server, plus --ai AI
> ```
>
> That one binding is the exception: wrangler can only run Workers
> AI against Cloudflare, never locally, so `dev:functions:ai`
> opens an authenticated proxy session and fails without
> credentials. `wrangler.toml` therefore does not declare `[ai]`,
> and the flag is how you opt in. Everything else stays local
> either way. See the comment at the top of `wrangler.toml`, and
> Phase 8 for wiring `AI` on the deployed node.

Before starting, seed `.dev.vars` from the template:

```bash
cp .dev.vars.example .dev.vars
npm run gen:node-key       # appends NODE_ID_PRIVATE_KEY_PEM
```

The template ships `DEV_BYPASS_ACCESS=true`, which skips Cloudflare
Access locally and provisions you as an admin publisher. The
middleware refuses to honour that flag on a non-loopback hostname,
so it cannot leak into production.

**Gate — all four should answer:**

```bash
curl -s localhost:8788/api/v1/catalog          | head -c 120  # 200 + datasets[]
curl -s localhost:8788/.well-known/terraviz.json               # 200, real public_key
curl -s localhost:8788/api/v1/publish/me                       # 200, role "admin"
curl -s "localhost:8788/api/v1/search?q=ocean"                 # 200 (mock embedder)
```

If `/publish/me` returns 503 `access_unconfigured`, `.dev.vars`
isn't being read — check you copied it to `.dev.vars`, not
`.dev.vars.example`.

---

# Phase 2 — Create the Cloudflare resources

> **Automated.** `npm run setup -- --apply --only=resources` runs all
> of this and records the IDs for you. Re-running adopts what already
> exists rather than making a second `sphere-feedback`. The commands
> below are the same thing by hand.

**Nothing consumes these yet.** This phase exists so that when
Phases 3 and 8 ask for IDs, you already have them written down.
Run the whole block, then fill in `W4`–`W9`.

```bash
# W4 — D1. One physical database carries both the feedback tables
# and the catalog tables; they differ only by migrations directory.
wrangler d1 create sphere-feedback

# W5, W6 — two KV namespaces.
wrangler kv namespace create TELEMETRY_KILL_SWITCH
wrangler kv namespace create CATALOG_KV

# W7 — R2 bucket for thumbnails, legends, captions, tour JSON,
# HLS renditions, and feedback screenshots.
wrangler r2 bucket create terraviz-assets

# W8 — Vectorize index + the three metadata indexes the query
# filters need. All four commands are required.
wrangler vectorize create terraviz-datasets --dimensions=768 --metric=cosine
wrangler vectorize create-metadata-index terraviz-datasets --property-name=peer_id    --type=string
wrangler vectorize create-metadata-index terraviz-datasets --property-name=category   --type=string
wrangler vectorize create-metadata-index terraviz-datasets --property-name=visibility --type=string
```

Each `create` prints the ID. **Copy them onto the worksheet now** —
`d1 create` in particular prints a ready-made TOML block, and that
ID is the one thing you cannot recover from a later error message.
To re-read them: `wrangler d1 list`, `wrangler kv namespace list`.

**W9 — Analytics Engine.** There is no dataset to create. AE
datasets come into existence the first time something writes to
them; you name the dataset in the binding (Phase 8) and it
appears. Use `terraviz_events` unless you have a reason not to —
the Grafana dashboards and the export pipeline default to that
name.

> ⚠️ **The product itself does have to be turned on.** Open
> **Workers & Pages → Analytics Engine** once. Until you do, the
> Pages deploy in Phase 8.8 fails with `Failed to publish your
> Function. You need to enable Analytics Engine.` — not a
> degraded feature, a deploy that will not publish.
>
> The dialog asks for two values, and both are fixed by the code:
> Dataset Name `terraviz_events`, Dataset Binding `ANALYTICS`.
> Those are the names Phase 8.1 binds and
> `functions/api/ingest.ts` writes through.

**Tier 1 operators:** you only need `W4` (D1) and `W5` (KV). Skip
the R2 and Vectorize commands; add them later if you upgrade.

---

# Phase 3 — Point the repo at your resources

`wrangler.toml` ships with **the upstream project's real resource
IDs**. Replace them now that yours exist. This is the step the old
guide put *first*, which made it impossible to complete.

> **Automated.** `npm run setup -- --apply --only=wrangler-toml` does
> this from the IDs the resources step recorded. It edits per binding
> block rather than by string replace. A global replace cannot tell
> the blocks apart: the two D1 blocks share a `database_name`, and
> the two KV blocks share a section header. It refuses to apply while
> any ID is still unknown.

| Block | Field | Ships as | Replace with |
|---|---|---|---|
| `[[d1_databases]]` `FEEDBACK_DB` | `database_id` | `78fbe5c3-…` | `W4` |
| `[[d1_databases]]` `CATALOG_DB` | `database_id` | `78fbe5c3-…` | `W4` — the *same* ID; one database, two migration dirs |
| `[[kv_namespaces]]` `TELEMETRY_KILL_SWITCH` | `id` | `9c022b12…` | `W5` |
| `[[kv_namespaces]]` `CATALOG_KV` | `id` | `0000…0000` | `W6` |

Resource *names* (`sphere-feedback`, `terraviz-assets`,
`terraviz-datasets`, `terraviz_events`) are yours to rename. If you
do, keep the dashboard bindings and the `CATALOG_R2_BUCKET` /
`ANALYTICS_AE_DATASET` overrides in sync.

> **Your `wrangler.toml` now diverges from upstream, permanently.**
> That is the intended end state, not drift to be tidied up. Expect a
> conflict on this file every time you merge upstream — keep your IDs
> and take upstream's other changes.
>
> Two tests assert that the committed file still points at upstream's
> own resources. They are repo hygiene for the upstream project, so
> they skip unless `GITHUB_REPOSITORY` says the checkout is
> `zyra-project/terraviz`. On your fork they will show as skipped,
> which is correct.

> **Why this file matters when Pages ignores it.** Pages reads its
> live bindings from the dashboard. But every `wrangler` command
> you run from your shell — `d1 migrations apply`, `d1 execute` —
> resolves its target through `wrangler.toml`. Getting this wrong
> means Phase 4 runs migrations against **upstream's database**,
> not yours.

Verify before continuing:

```bash
wrangler d1 info CATALOG_DB     # should print YOUR database, 0 tables
```

---

# Phase 4 — Create the schema

Two migration sets live in this repo, keyed by **binding name**.

> **Automated.** `npm run setup -- --apply --only=migrations` applies
> both and stops on any failure. Add `--local-migrations` to rehearse
> against the local `.wrangler/` database first.

```bash
wrangler d1 migrations apply CATALOG_DB  --remote    # migrations/catalog/
wrangler d1 migrations apply FEEDBACK_DB --remote    # migrations/
```

> ⚠️ **Always select by binding name, never by database name.**
> Both `[[d1_databases]]` blocks declare
> `database_name = "sphere-feedback"` with *different*
> `migrations_dir`. Passing the bare name `sphere-feedback` is
> ambiguous; wrangler resolves it to the first match
> (`FEEDBACK_DB` → `migrations/`), silently applies the wrong set,
> and leaves the catalog tables uncreated. The symptom lands much
> later as `D1_ERROR: table datasets has no column named bbox_n`
> when someone clicks Save draft in the portal.

**Gate:**

```bash
wrangler d1 migrations list CATALOG_DB --remote     # "No migrations to apply"
wrangler d1 migrations list FEEDBACK_DB --remote    # "No migrations to apply"
```

Both should be clean. `FEEDBACK_DB` used to report one file pending
forever — the generated `catalog-schema.sql` snapshot lived in its
migrations directory, so wrangler queued a file that was never a
migration. The snapshot moved to `schema/`, so a pending entry here
now means what it says.

That command diffs the whole `migrations/catalog/` directory
against the remote tracker table, so it stays correct as the
directory grows. Don't hard-code "the newest migration is NNNN"
anywhere — it climbs every release.

Re-run both commands after every `git pull` that brings new
migration files. They're idempotent; already-applied files are
skipped.

> **No wrangler on the deploy host?** You can paste each file's SQL
> into the dashboard D1 console in filename order, then record it
> so a future `migrations apply` doesn't re-run it:
>
> ```sql
> INSERT INTO d1_migrations (name, applied_at)
> VALUES ('0043_playback_fps.sql', CURRENT_TIMESTAMP);
> ```
>
> Note `migrations/catalog/` currently contains two files numbered
> `0036` (`0036_blog_cover_image.sql` and
> `0036_youtube_channels_disabled.sql`). Wrangler orders them
> lexicographically and both are independent, so automated apply is
> fine — but if you're pasting by hand, apply both.

---

# Phase 5 — Create the Pages project

## 5.1 Push your code

Pages' Git connector watches a remote. Push to `W3`.

> **Automated, mostly.** `npm run setup -- --apply --only=pages`
> creates the project with these build settings and attaches your
> custom domain. What it cannot do is *connect* the Git remote —
> that handshake is OAuth between Cloudflare and GitHub, with no API.
> A project it creates is **Direct Upload**, which means Cloudflare
> never runs your build, so the `VITE_*` variables below must be set
> wherever the build actually runs (your CI job). Click Connect in
> the dashboard afterwards to convert it in place, or stay on Direct
> Upload and deploy from CI.

## 5.2 Create the project

**Workers & Pages → Create application → Pages → Connect to Git**,
authorise, pick `W3`, then:

- Framework preset: **None**
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: *(empty)*

**Build-time environment variables.** None of these is required —
the build succeeds with all of them unset, and each falls back to
a working default. But `VITE_*` values are baked into the bundle
at build time, so setting one later means a rebuild rather than
just a redeploy. Cheaper to decide now.

`VITE_API_ORIGIN` is the one most likely to be wanted later:
desktop builds and deep-link host recognition read it, and adding
it afterwards means a rebuild. The Earth textures need no
variable at all — they ship in your own build.

> `VITE_*` is a naming convention, not a Cloudflare product. Vite
> is the bundler that builds this app, and it copies variables
> carrying that prefix into the JavaScript it emits. So they have
> to be set wherever the build runs — the Cloudflare dashboard if
> Cloudflare builds, your CI job if CI builds. By the time a
> visitor loads the page the values are already inside the file
> being served.

| Variable | Value | Notes |
|---|---|---|
| `VITE_BUILD_CHANNEL` | *(unset)* | Already `public`. Set it only for an `internal` or `canary` build. |
| `VITE_TELEMETRY_ENABLED` | *(unset)* | Already on. `false` is the only value that changes anything, for a telemetry-free build. |
| `VITE_EARTH_ASSET_BASE` | *(unset)* | Leave it. The Earth textures are committed to the repo, so your build ships them and serves them from your domain. Set it only to put them on a CDN instead. |
| `VITE_API_ORIGIN` | `https://` + `W2` | Only needed for desktop builds (Phase 15), harmless to set now. |
| `VITE_DEFAULT_UI_SCALE` | *(unset)* | `1.5` suits kiosks. Clamped to [0.5, 2.0]; a visitor's own choice always wins. |
| `VITE_SAMPLE_TOURS` | `false` | Set it unless you ran `import-snapshot`. Drops the two bundled sample tours, which drive SOS datasets your node doesn't have. See [Reference C](#reference-c--fork-pinned-source-values). |

Save and Deploy. Record the project name as `W10`.

**Gate:** the build goes green and the site loads at
`<W10>.pages.dev`. Backend features won't work yet — no bindings.

## 5.3 Pick exactly one deploy path

The repo ships a `deploy` job in `.github/workflows/ci.yml` (and
`poster.yml`) that runs `wrangler pages deploy dist/ --project-name
terraviz`. On a fresh fork that job either fails for lack of
secrets, or — worse, if you've set them — deploys to a project name
that isn't yours.

Both paths are configured in the **Cloudflare** dashboard, not on
GitHub. Cloudflare asks GitHub for repository access partway
through the first one; you never start from the GitHub side.

- **Using the dashboard Git integration (recommended):** delete or
  disable the `deploy` job in `ci.yml` and `poster.yml`. Keep
  `type-check`, `unit-tests`, and `build` — they're fork-safe and
  need no secrets. Take this one if you want pushes to deploy
  themselves and would rather not maintain a workflow.
- **Using GitHub Actions to deploy (Direct Upload):** four things.
  Set repo secrets `CLOUDFLARE_API_TOKEN` (`W11`) and
  `CLOUDFLARE_ACCOUNT_ID` (`W1`). Change every
  `--project-name terraviz` to `W10`. Set the repo **Variable**
  `TERRAVIZ_SERVER` to `https://<W2>`. And do *not* connect the Git
  integration. Take this one if you want deploys gated on the tests
  your fork already runs, or would rather not grant Cloudflare
  access to the repository.

A token used only by CI needs **Account → Cloudflare Pages → Edit**
and nothing else. Add **Account → D1 → Edit** if you enable CI
migrations (Phase 14.3). Mint it at
`https://dash.cloudflare.com/profile/api-tokens`.

If you reuse the token you minted for `npm run setup`, it already
carries more than this — see the token-scope table under
[Shortcut: `npm run setup`](#shortcut-npm-run-setup). That is fine
for a repo you control, and worth narrowing for one you share.

> Forks created with GitHub's **Fork** button land with Actions
> **disabled** and no secrets, variables, or environments — GitHub
> never copies those. Enable workflows in the Actions tab; recreate
> the `production` / `preview` / `poster-production` /
> `poster-preview` environments if you keep the jobs that reference
> them. PRs opened *from* a fork never receive secrets, so fork-PR
> runs are compile-only by design.

## 5.4 Custom domain

Pages → your project → **Custom domains → Set up a custom domain**
→ enter `W2`. Cloudflare creates the CNAME automatically when the
zone is on its DNS.

**Gate:** `https://<W2>` serves the app over TLS.

---

**Tier 1 operators stop here** — jump to Phase 8, wire only the
five bindings marked *Tier 1* in the table, redeploy, and run the
Phase 10 smoke tests. Phases 6, 7, 9, 11 and 12 are publisher-node
concerns.

---

# Phase 6 — Cloudflare Access and the service token

**This phase did not exist in the previous guide.** It told you to
configure `ACCESS_AUD` without ever creating the application that
issues one, and used `$CF_ACCESS_CLIENT_ID` in three commands
without saying where it comes from. Everything from here to Phase
12 depends on this phase.

Access is **not optional for a publisher node**. The publisher
middleware fails closed: without `ACCESS_TEAM_DOMAIN` and
`ACCESS_AUD`, every `/api/v1/publish/**` route returns 503
`access_unconfigured`, and the `terraviz` CLI cannot do anything.

> **Automated.** 6.1 is Zero Trust onboarding, a one-time dashboard
> flow you have to do yourself. Once it is done,
> `npm run setup -- --apply --only=access` does 6.2 and 6.3. It
> discovers your team domain, creates the application with all six
> destinations, creates both policies, mints the service token, and
> attaches it. It records the AUD and prints the token pair once. The
> click-by-click below is the reference for what it builds, and the
> path to take if you would rather do it by hand.

## 6.1 Set up Zero Trust

Zero Trust dashboard → complete onboarding if you haven't. You'll
choose a **team name**; your team domain becomes
`<team>.cloudflareaccess.com`. **Record it as `W12`.**

Add at least one identity provider (Zero Trust → Settings →
Authentication). One-time PIN over email works and needs no identity provider (IdP)
setup; Google/Okta/Entra are better for a real team.

## 6.2 Create the publisher application

This is the application whose audience tag becomes `ACCESS_AUD`.
One application covers both the API and the browser portal.

Zero Trust → **Access → Applications → Add an application →
Self-hosted**:

- **Application name:** `Terraviz Publisher`
- **Session duration:** 24 hours (publishers shouldn't time out
  mid-form)
- **Destinations** — add all six, so both hostnames and both
  surfaces are covered:

  | Host | Path |
  |---|---|
  | `<W2>` | `/api/v1/publish` |
  | `<W2>` | `/publish` |
  | `<W2>` | `/publish/*` |
  | `<W10>.pages.dev` | `/api/v1/publish` |
  | `<W10>.pages.dev` | `/publish` |
  | `<W10>.pages.dev` | `/publish/*` |

- **Policies** — create two, in this order:

  1. **`Staff`** — Action **Allow**, Include → **Emails ending in**
     → `@your-org.org`.
  2. **`Automation`** — Action **Service Auth**, Include →
     **Service Token** → *(the token from 6.3; come back and add it)*.

> ⚠️ Use **"Emails ending in"**, not **"Emails"**. The latter is an
> exact match against one address and is the single most common
> Access misconfiguration.

After saving, open the application's **Overview** tab and copy the
**Application Audience (AUD) Tag** — a 64-char hex string.
**Record it as `W13`.**

## 6.3 Mint the service token

Zero Trust → **Access → Service Auth → Service Tokens → Create
Service Token**. Name it `terraviz-cli`.

Cloudflare shows the **Client ID** and **Client Secret exactly
once.** Record them as `W14` and `W15` before closing the dialog;
there is no way to retrieve the secret later, only to reissue.

Now go back to the `Automation` policy from 6.2 and add this token
to its Service Token include list. A service token that isn't
attached to a policy authenticates but is authorised for nothing.

Export them into your shell for the rest of this guide:

```bash
export CF_ACCESS_CLIENT_ID=<W14>
export CF_ACCESS_CLIENT_SECRET=<W15>
export TERRAVIZ_SERVER=https://<W2>
```

The publisher API JIT-provisions the token as `role='service'` on
first use — admin-equivalent for content and operator work, but
never for user management.

## 6.4 The other two Access applications (optional)

Independent of the publisher app, and both genuinely optional:

**Admin dashboard.** One app, name `Terraviz Admin`, destination
`api/feedback-admin` on both hostnames, one Allow policy on your
email domain. Without it, those endpoints fall back to a
`FEEDBACK_ADMIN_TOKEN` bearer.

**Telemetry staff-tagging.** Lets dashboards filter staff dogfood
out of metrics. Destinations `<W2>/api/ingest` and
`<W10>.pages.dev/api/ingest`, and **two policies in this exact
order** — first match wins:

1. `Staff` — Action **Allow**, Include → Emails ending in →
   `@your-org.org`
2. `Public` — Action **Bypass**, Include → **Everyone**

Allow fires for staff (adding the SSO header, which the ingest
function reads to stamp `internal=true`); Bypass catches everyone
else so public traffic passes unchallenged.

---

# Phase 7 — Generate your node's secrets

Two secrets are yours to create, and neither exists until you make
it. The previous guide asked you to set both in the bindings table
before introducing the commands that generate them.

> **Half automated.** `npm run setup` generates `PREVIEW_SIGNING_KEY`
> into `.dev.vars` and pushes it in the same run. It deliberately does
> *not* generate the node keypair — `npm run gen:node-key` owns that,
> because it also writes `node-public-key.txt` (which Phase 9 reads)
> and stamps your local D1. Run that one command first.

## 7.1 Node identity keypair

```bash
npm run gen:node-key
```

This writes:

- `NODE_ID_PRIVATE_KEY_PEM` into `.dev.vars` — a single-line
  base64-DER PKCS8 blob. **This is `W16`**, and it is the value you
  put into Pages as a secret in Phase 8.
- `node-public-key.txt` containing an `ed25519:<base64>` line —
  **`W17`**, consumed by `terraviz init-node` in Phase 9.

Both files are gitignored. Back up `W16` somewhere durable: it
signs your node's federation responses, and regenerating it means
re-provisioning your identity.

## 7.2 Preview signing key

Any high-entropy string. The preview endpoints fail closed (503
`preview_unconfigured`) without it.

```bash
openssl rand -base64 32      # → W18
```

---

# Phase 8 — Wire bindings, storage and transcode

Everything referenced below now exists. Pages → your project →
**Settings → Bindings** (and **Variables and secrets**).

> **Automated.** `npm run setup -- --apply --only=bindings` writes
> every one of these to both environments in a single API call —
> roughly forty dashboard interactions, and the step where the
> per-environment mistake below actually happens. It reads the same
> manifest `check:pages-bindings` audits against, so it cannot
> produce a deploy that audit then calls broken. Anything it has no
> value for is listed as skipped with the reason, rather than written
> blank.

> ⚠️ **Set every entry on BOTH Production and Preview.** The
> environment selector is at the top of the page, and forgetting it
> is the most common cutover failure — "works on preview, breaks on
> production" or the reverse. Phase 10's audit catches it.

## 8.1 Bindings

| Variable name | Type | Value | Tier 1? | Without it |
|---|---|---|---|---|
| `FEEDBACK_DB` | D1 | `sphere-feedback` (`W4`) | ✅ | In-app feedback form 500s |
| `CATALOG_DB` | D1 | `sphere-feedback` (`W4`) | | Everything in Tier 2 |
| `ANALYTICS` | Analytics Engine | dataset `W9` | ✅ | `/api/ingest` returns 204 and drops the write |
| `TELEMETRY_KILL_SWITCH` | KV | `W5` | ✅ | Fails **open** — ingest keeps working, you just lose the kill lever |
| `CATALOG_KV` | KV | `W6` | | `/api/v1/catalog` burns ~5 D1 reads per browse-page load |
| `CATALOG_R2` | R2 | `terraviz-assets` (`W7`) | | Asset uploads and feedback screenshots |
| `AI` | Workers AI | *(no value)* | ✅ | `/api/v1/search` returns **200** with `{ degraded: 'unconfigured' }` and a `Warning` header — the route never 5xxs for a missing binding. Orbit's `[RELEVANT DATASETS]` block stays empty and chips fall back to the local engine |
| `CATALOG_VECTORIZE` | Vectorize | `terraviz-datasets` (`W8`) | | Semantic search returns empty |

## 8.2 Plaintext variables

| Variable | Value | Tier 1? |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `W12` — team domain only, no `https://` | |
| `ACCESS_AUD` | `W13` | |
| `TRUSTED_PUBLISHER_DOMAINS` | `your-org.org` (comma-separated, optional) | |

## 8.3 Secrets (encrypted)

| Secret | Value |
|---|---|
| `NODE_ID_PRIVATE_KEY_PEM` | `W16` |
| `PREVIEW_SIGNING_KEY` | `W18` |

Or from the CLI, which prompts for each value:

```bash
wrangler pages secret put NODE_ID_PRIVATE_KEY_PEM --project-name <W10>
wrangler pages secret put PREVIEW_SIGNING_KEY     --project-name <W10>
```

> **What `TRUSTED_PUBLISHER_DOMAINS` actually does.** Verified
> against `provisioningDefaults()` in
> `functions/api/v1/_lib/publisher-store.ts`: a matching login
> provisions as **`role='reviewer'`, `is_admin=0`,
> `status='active'`** — approved without waiting in the queue, but
> **read-only**. It does *not* make anyone an admin. (The previous
> guide claimed it granted `role=admin, is_admin=1`; that was
> wrong, and the doc comment in `functions/api/v1/_lib/env.ts` is
> wrong the same way.) You don't need this to seat your first
> admin — see Phase 11. Domain matching is exact and
> case-insensitive; `noaa.gov` does not match `x.noaa.gov`.

## 8.4 The other seven the audit expects

`EXPECTED_BINDINGS` in `scripts/lib/expected-bindings.ts` carries
**19** entries; 8.1–8.3 above are twelve of them. Here are the other
seven, listed together because **`npm run check:pages-bindings`
reports them as missing whether or not you want the feature behind
them.** That is deliberate — the audit would rather name a value you
have chosen not to set than stay quiet about one you meant to.

Four are R2. Set them in 8.5 below, which is part of this phase
rather than a later one: without them a published dataset has no
readable image, and that is not really publishing.

The other three are for video transcode. Set them in 8.6, which is
also part of this phase — 138 of the upstream catalog's 204 datasets
are video, so this is the common case rather than an extra. If your
node genuinely publishes no video, those three rows are expected to
read MISSING and you can ignore them.

Plaintext:

| Variable | Set in | Value | Without it |
|---|---|---|---|
| `R2_PUBLIC_BASE` | 8.5 | `W19` — the R2 bucket's public origin | HLS manifests, `r2:datasets/…` assets and `r2:tours/…` JSON resolve to `r2_unconfigured`. **`R2_S3_ENDPOINT` is not a fallback here** — it signs S3-API access, not public reads, so falling through would produce an `hls` URL that 403s at play time |
| `GITHUB_OWNER` | 8.6 | repo owner hosting `transcode-hls` | With `GITHUB_REPO` + `GITHUB_DISPATCH_TOKEN`, builds the `repository_dispatch` URL |
| `GITHUB_REPO` | 8.6 | repo name hosting `transcode-hls` | See `GITHUB_OWNER` |

Secrets:

| Secret | Set in | Value | Without it |
|---|---|---|---|
| `R2_S3_ENDPOINT` | 8.5 | `W21` — `https://<acct>.r2.cloudflarestorage.com` | The `migrate-r2-hls` / `-assets` / `-tours` CLIs (and their rollbacks) fail at credential validation. The operator's shell needs the same value |
| `R2_ACCESS_KEY_ID` | 8.5 | `W20` | As above |
| `R2_SECRET_ACCESS_KEY` | 8.5 | `W20b` — shown once, when the token is minted | As above |
| `GITHUB_DISPATCH_TOKEN` | 8.6 | `W22` — fine-grained personal access token (PAT) with Contents: write, or a classic PAT with `repo` | Video-upload finalisation 503s with `github_dispatch_unconfigured` |

## 8.5 Asset storage — R2 public origin, CORS, and the S3 token

**Do this now unless your node will only ever carry metadata.** The
bucket exists (Phase 2, `W7`) but nothing can be read out of it yet.
Until this is done, `resolveR2PublicUrl` returns null: uploaded
thumbnails come back as `null`, HLS manifests answer
`r2_unconfigured`, and the web zip-download cannot size a file. A
dataset with no image is not much of a published dataset, which is
why this is here rather than in the optional phase it used to live
in.

Skip it only for a node that mirrors the upstream catalog or
publishes metadata-only rows. You can come back and do it later —
nothing else depends on it — but you will redeploy again.

> **Automated.** `npm run setup -- --apply --only=r2` sets the CORS
> policy (built from your origins, so the two easy-to-mistype details
> below cannot be got wrong) and attaches the public domain from
> `R2_PUBLIC_BASE`. Step 4 — minting the S3 API token — stays manual
> on purpose: automating it would need a token that can create
> tokens.

1. R2 → `terraviz-assets` → **Settings → Connect Domain** → e.g.
   `assets.<W2>`. Record as `W19`.
2. Pages variable `R2_PUBLIC_BASE` = `https://<W19>`, both
   environments.
3. R2 → bucket → **Settings → CORS policy**:

```json
[
  {
    "AllowedOrigins": ["https://terraviz.your-org.org"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["Content-Length", "Content-Range"],
    "MaxAgeSeconds": 3600
  },
  {
    "AllowedOrigins": ["https://terraviz.your-org.org"],
    "AllowedMethods": ["PUT", "POST"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

R2's CORS is strict in two ways. `HEAD` must be listed explicitly,
even though Fetch treats it as a simple method. And `Content-Range`
must be in `ExposeHeaders` — it isn't CORS-safelisted, so the zip
dialog's Range-GET size probe can't read it otherwise. Add
`http://localhost:5173` for dev; add `tauri://localhost`,
`http://tauri.localhost` and `https://tauri.localhost` to the
GET/HEAD rule for desktop builds.

4. R2 → **Manage R2 API Tokens** → create a token with **Read+Write**
   on the bucket. Record the endpoint (`W21`) and key pair (`W20`),
   then set `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY` as Pages **secrets** on both environments.
   These mint presigned PUT URLs server-side and verify upload
   digests.

## 8.6 Video transcode

**Do this now if publishers will upload video.** In the upstream
catalog 138 of 204 datasets are `video/mp4` — for a node in the
Science On a Sphere lineage, video is not a side case, it is most of
the content. Without the three bindings below, finalising a video
upload returns 503 `github_dispatch_unconfigured` and rolls the
dataset's transcoding state back. It does not degrade; it fails.

Skip it for a node that publishes only images, tours or metadata.
Skip it too for data-encoded video built by a Zyra pipeline, and for
a mirror of the upstream catalog — those rows carry `vimeo:` refs
and never touch this. As with 8.5 you can come back later, at the
cost of another redeploy.

Publisher video uploads hand off to a GitHub Actions workflow that
runs the ffmpeg 4K/1080p/720p 2:1 spherical HLS ladder, via
`repository_dispatch`. Both source shapes — a single `source.mp4`,
or up to 10 000 image-sequence frames — feed the same pipeline and
encode to **30 fps output** regardless of source rate (the tour
engine's `frameRate` task assumes 30).

**Pages side** (both environments):

| Binding | Value |
|---|---|
| `GITHUB_OWNER` | your fork's owner |
| `GITHUB_REPO` | your fork's name |
| `GITHUB_DISPATCH_TOKEN` | **Secret** — PAT with `repo` scope (or fine-grained Contents:write) on that repo. `W22`. |

**GitHub side** (repo Settings → Secrets and variables → Actions):
`R2_S3_ENDPOINT` (`W21`), `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
(`W20`), `TERRAVIZ_SERVER` (`https://<W2>`), `CF_ACCESS_CLIENT_ID`
(`W14`), `CF_ACCESS_CLIENT_SECRET` (`W15`), and optionally
`CATALOG_R2_BUCKET`.

`npm run setup -- --github-secrets` prints the exact `gh secret set`
commands for all of them, annotated with what each is for and which
ones your current shell can't supply. Values are emitted as `"$VAR"`
references rather than inlined, so the script is safe to paste into a
runbook.

Both halves are required and fail closed. Missing
`GITHUB_DISPATCH_TOKEN` → `/asset/complete` returns 503
`github_dispatch_unconfigured`; the source bytes stay in R2 and the
upload can be retried. Missing GitHub secrets → the workflow exits
non-zero with a stage code (2 download, 3 encode, 4 upload, 5
PATCH), the row stays `transcoding=1`, and the portal's
"Transcoding…" badge is your signal.

**Recovery is operator-only.** `/asset/…/complete` refuses a
different upload while `transcoding=1` and the active-upload
binding is set, so publishers can't self-recover. Clear the row:

```sql
UPDATE datasets SET transcoding = NULL, active_transcode_upload_id = NULL
WHERE id = '…';
```

**Cost.** GitHub Actions' free tier (2000 min/mo, public repos)
comfortably covers ~50 uploads/month. R2 **storage** dominates: a
4K ladder is ~250 MB per minute of source, billed until deleted.
Egress is zero-rated.

**Local dev:** `MOCK_GITHUB_DISPATCH=true` in `.dev.vars` skips the
dispatch while still stamping `transcoding=1`, so you can exercise
the portal's polling surface. Refused on non-loopback hostnames.

### WAF skip rule for the transcode-complete callback

Access service tokens bypass Access but **not** Bot Fight Mode, the
Managed Ruleset, or custom WAF rules. Bot Fight Mode is on by
default from the Free plan up. If any of those are active, the
runner's final POST to
`/api/v1/publish/datasets/{id}/transcode-complete` gets a `Just a
moment...` interstitial and never reaches the Worker. ffmpeg
finishes, the HLS bundle lands in R2, and the runner exits non-zero
at stage 5. The CLI detects the challenge HTML and prints a
one-line pointer at this section rather than a 30 KB blob.

> **Automated (opt-in).** `npm run setup -- --apply --only=waf`
> appends this rule *and* the 14.1 feedback rule, preserving every
> existing rule in the zone. It is deliberately excluded from a
> default run: the rulesets API replaces a zone's whole custom-rule
> list rather than appending, so a careless implementation deletes
> your WAF config. The merge is a pure, tested function, and a failed
> read aborts rather than writing. Step 2 below (plain Bot Fight
> Mode) has no per-path override and stays manual.

**Step 1 — WAF Custom Rule.** Security → WAF → Custom rules →
Create rule, `transcode-complete service token skip`:

```
(starts_with(http.request.uri.path, "/api/v1/publish/")
  and ends_with(http.request.uri.path, "/transcode-complete")
  and len(http.request.headers["cf-access-client-id"][0]) > 0)
```

Action **Skip**, ticking: all remaining custom rules, all managed
rules, all Super Bot Fight Mode rules, Browser Integrity Check,
and Security Level.

This is safe for three reasons. Only requests carrying a
service-token id can match. Access still validates the token
afterwards, so a forged header without the secret can't
authenticate. And the route handler independently enforces
`role='service'`.

**Step 2 — plain Bot Fight Mode (Free/Pro).** The Skip action's
"All Super Bot Fight Mode Rules" covers SBFM (Pro+) but not plain
BFM, which runs zone-wide at a different layer and has no per-path
override on Free. Options, best first:

1. **Disable BFM zone-wide** (Security → Bots → Configure). For a
   small portal where authenticated traffic dominates and the
   public single-page app is cache-served, Bot Fight Mode adds little over Access + the
   role-gated routes + the Step 1 rule. Recommended on Free.
2. **Upgrade to Pro** — SBFM *is* skippable from Step 1's rule.
3. **Live with manual recovery** — re-issue `/transcode-complete`
   from an authenticated browser session when it fails.

**Which rule fired?** Security → Events, "Service" column:

| Says | Fixed by |
|---|---|
| `Bot fight mode` | Step 2 |
| `Managed challenge` | Step 1, "All managed rules" |
| `Super Bot Fight Mode` | Step 1, SBFM checkbox |
| `Browser Integrity Check` | Step 1, that checkbox |
| `Security level` | Step 1, that checkbox |

## 8.7 Orbit's chat provider — nothing to do

Listed here because this is where you wired the `AI` binding, and
because the question "how do I configure Orbit?" has a surprising
answer: you already did.

**Default — Cloudflare Workers AI. Nothing to configure.**
`functions/api/chat/completions.ts` calls the `AI` binding from
Phase 8 and streams an OpenAI-shaped SSE response;
`functions/api/models.ts` backs the "Test Connection" button. No
API key reaches the browser. Model choice lives in `MODEL_MAP` in
that file.

There is **no server-side proxy for third-party providers.** Older
docs described `LLM_PROVIDER_URL` / `LLM_PROVIDER_KEY` — those env
vars are read by nothing. To use OpenAI or a local model, set the
API URL + key in the running app under **Tools → Orbit Settings**
(localStorage on web, OS keychain on desktop). Because the key
lives client-side, that path suits a single operator's browser or a
desktop install — not a shared public deployment. Local endpoints
(`http://localhost:11434/v1` Ollama, `:1234` LM Studio, `:8080`
llama.cpp) only work from desktop or dev, since Pages can't reach
your localhost.

Routing Workers AI through an AI Gateway is a **code change** — the
`AI.run()` call accepts a `gateway` option but the current code
doesn't pass one. A gateway URL in config does nothing on its own.

## 8.8 Redeploy

Bindings take effect on the *next* deployment, not immediately.
**Deployments → ⋯ → Retry deployment**, or push a commit.

Doing 8.5 and 8.6 before this point is what keeps it to one
redeploy. Both used to be set five phases later, which meant
deploying again to pick them up.

**Gate:** open `https://<W2>` in a private window. The privacy
disclosure banner appears on first load, and the DevTools network
tab shows `204` responses from `/api/ingest`.

---

# Phase 9 — Provision the node identity

The migrations **create** the `node_identity` table but never
populate it, and neither `npm run db:seed` nor `npm run
gen:node-key` writes to remote D1 — both only touch the local
`.wrangler/` SQLite file. So right now your production
`node_identity` is empty, which breaks two things:

- `/.well-known/terraviz.json` returns 503 `identity_missing`.
- **Every publish fails.** Dataset inserts stamp `origin_node` from
  `(SELECT node_id FROM node_identity LIMIT 1)`, and the column is
  `NOT NULL` — an empty table makes the subquery `NULL` and the
  insert aborts on the constraint.

```bash
npm run terraviz -- init-node \
  --server "$TERRAVIZ_SERVER" \
  --client-id "$CF_ACCESS_CLIENT_ID" \
  --client-secret "$CF_ACCESS_CLIENT_SECRET" \
  --display-name "Terraviz — Your Org" \
  --base-url "https://<W2>" \
  --contact ops@your-org.org
```

It reads `node-public-key.txt` (`W17`) automatically, and writes
through the publisher API — so it needs only the service token from
Phase 6.3, no `wrangler` or direct D1 access. It's idempotent:
re-running updates the row in place, preserving `node_id` so
existing `origin_node` references stay valid, and keeping the
existing key unless you pass `--public-key`.

**Gate:**

```bash
curl -s https://<W2>/.well-known/terraviz.json | head -c 200
# 200, with your display_name and W17's public key — not 503
```

<details>
<summary>Fallback: write the row directly with wrangler</summary>

```bash
wrangler d1 execute sphere-feedback --remote --config wrangler.toml \
  --command "INSERT INTO node_identity
    (node_id, display_name, base_url, description, contact_email, public_key, created_at)
    VALUES (
      lower(hex(randomblob(16))),
      'Terraviz — Your Org',
      'https://<W2>',
      'Your org''s Terraviz node.',
      'ops@your-org.org',
      'ed25519:PASTE_W17',
      strftime('%Y-%m-%dT%H:%M:%fZ','now')
    )"
```

If you later rotate the keypair, push the new public half to remote
D1 too — `init-node … --public-key ed25519:…`. `gen:node-key` only
updates your local copy.
</details>

---

# Phase 10 — Verify

Run both. They check different layers and neither subsumes the
other.

```bash
# Layer 1 — is the dashboard's binding state what the code expects?
CLOUDFLARE_API_TOKEN=<W11> \
CLOUDFLARE_ACCOUNT_ID=<W1> \
CLOUDFLARE_PAGES_PROJECT_NAME=<W10> \
npm run check:pages-bindings

# Layer 2 — does the deployed node actually answer correctly?
TERRAVIZ_ACCESS_CLIENT_ID=<W14> \
TERRAVIZ_ACCESS_CLIENT_SECRET=<W15> \
npm run terraviz -- verify-deploy --server https://<W2>
```

`verify-deploy` runs six checks: node identity advertised, catalog
reachable, catalog populated, search responsive, Access service
token round-trips, publisher list reads cleanly. Without a service
token the last two SKIP rather than fail, so it's useful before
Phase 6 too.

**Expected results at this point:**

| Check | Expected now |
|---|---|
| `node-identity` | PASS (Phase 9) |
| `catalog-reachable` | PASS |
| `catalog-populated` | **FAIL** until Phase 12 — the catalog is genuinely empty |
| `search-reachable` | PASS |
| `access-me` | PASS |
| `publisher-list` | PASS |

`check:pages-bindings` will report `R2_PUBLIC_BASE`,
`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`GITHUB_OWNER`, `GITHUB_REPO` and `GITHUB_DISPATCH_TOKEN` as
**MISSING**. That is expected if your node publishes no video —
they belong to 8.6. Its source of truth is
[`scripts/lib/expected-bindings.ts`](../scripts/lib/expected-bindings.ts),
not this document; if you're never going to run uploads or
transcode, prune those entries so the audit reflects your node's
actual surface.

---

# Phase 11 — Sign in and become admin

Open `https://<W2>/publish` in a browser. Access challenges you,
you SSO in, and the publisher middleware JIT-provisions a row for
your email.

**The first human to sign in on a deploy with no active admin is
bootstrapped to `role='admin', status='active'` automatically.**
Service tokens are excluded — a machine credential never
self-elevates. So on a fresh node, you become the admin by signing
in. No SQL required.

Everyone after you lands at `reviewer`/`pending` (or
`reviewer`/`active` if their domain is in
`TRUSTED_PUBLISHER_DOMAINS`), and you approve and promote them from
**/publish/users**. The five roles are `admin`, `editor`, `author`,
`contributor`, `reviewer` — see
[`PUBLISHER_ROLES_PLAN.md`](PUBLISHER_ROLES_PLAN.md). Admins can't
demote themselves or remove the last admin, so a node always keeps
one operator.

**Gate:** `/publish/me` shows your email with role **admin**, and
the sidebar shows the Users tab.

<details>
<summary>If you somehow have no admin</summary>

Only reachable if a service token was the first identity *and* a
human signed in during a window where the bootstrap didn't fire.
One-shot fix from the dashboard D1 console:

```sql
UPDATE publishers
SET role = 'admin', is_admin = 1, status = 'active'
WHERE email = 'you@your-org.org';
```
</details>

---

# Phase 12 — Put content in

Your node works but its catalog is empty. Two ways to fill it.

## 12.1 Publish your own (the normal path)

`/publish/datasets/new` in the portal. Metadata-only drafts work
immediately. Asset uploads need 8.5, and video uploads need 8.6 as
well. If you skipped 8.5, uploads land in R2 but nothing can read
them back; if you skipped 8.6, finalising a video returns 503. Both
are fixable after the fact — do the step and redeploy.

## 12.2 Mirror the upstream SOS catalog

Gives you about 200 datasets — everything upstream publishes. Note
the tradeoff: those rows carry `vimeo:` data refs that resolve
through **upstream's** video proxy, so their playback depends on
upstream's uptime unless you also mirror the proxy (Reference C).

```bash
npx tsx scripts/refresh-sos-snapshot.ts

npm run terraviz -- import-snapshot \
  --server "$TERRAVIZ_SERVER" \
  --client-id "$CF_ACCESS_CLIENT_ID" \
  --client-secret "$CF_ACCESS_CLIENT_SECRET" \
  --dry-run                                   # always dry-run first

# then drop --dry-run
```

Idempotent — re-running skips rows whose `legacy_id` is already
published. Takes a few minutes; embedding jobs backfill Vectorize
asynchronously over the following ~10 minutes.

**Gate:** re-run `verify-deploy`. `catalog-populated` now PASSes,
and all six checks are green. **That's a complete Tier 2 node.**

---

# Phase 13 — Content-Security-Policy

**All tiers, and the last thing before you put the node in front of
the public.** It used to be the bottom entry of an optional list,
which was wrong twice over. It is hardening rather than a feature.
And *every* fork needs it: upstream enforces its policy at the
Cloudflare edge, and edge rules do not travel with a fork.

It sits ahead of the optional phase deliberately. Everything from
here to Phase 13 is work every node does; Phase 14 is the first
thing you may genuinely skip.

**The repo ships no CSP.** `src/index.html` has no `<meta>` policy,
and `public/_headers` sets `X-Content-Type-Options`,
`Referrer-Policy` and `Permissions-Policy` but no CSP. Upstream's
production deploy enforces a strict `connect-src` policy **at the
Cloudflare edge** via Transform Rules — which a fork does **not**
inherit. Your node works without one; you should still add your
own, as an edge rule or a `Content-Security-Policy` line in
`public/_headers`:

- `connect-src`: `'self'`, `gibs.earthdata.nasa.gov`,
  `s3.dualstack.us-east-1.amazonaws.com` (SOS snapshot), your video
  and caption proxies, and `W19`.
- `img-src` / `media-src`: `'self' data: blob:`, the SOS/CloudFront
  asset hosts, and `W19`. The Earth basemap textures need no entry —
  they are served from your own origin, so `'self'` already covers
  them. Add a host here only if you set `VITE_EARTH_ASSET_BASE`.

The app uses `blob:` for preview tours and screenshots — omitting
it reproduces the "may not load data from blob:" failure. Test
playback, VR and a tour before locking it down.

---

---

# Phase 14 — Optional features

Everything here is genuinely optional: your node is complete and
serving content without any of it. Independent of each other, so
read the trigger and take what you want.

| | Do it when |
|---|---|
| **14.1 Feedback widget** | You ship the standalone HTML build and want its reports to reach `/publish/feedback` |
| **14.2 Analytics export** | You want `/publish/analytics` to hold more than the 30–90 days Analytics Engine keeps |
| **14.3 CI migrations** | You want schema applied automatically on push to `main` |
| **14.4 Grafana** | You want ad-hoc SQL against the raw telemetry stream. 14.2 covers the normal case |
| **14.5 Voice, events, blog, YouTube** | Per-feature. Each degrades quietly when its variables are unset |

**Four things used to be filed here and are not,** because calling
them optional was wrong:

| Was | Now | Why |
|---|---|---|
| R2 asset storage | **8.5** | A published dataset with no readable image is not published |
| Video transcode | **8.6** | 138 of upstream's 204 datasets are video, and an upload without it 503s |
| Orbit chat providers | **8.7** | Not a task — Orbit already works. It is a note next to the `AI` binding |
| Content-Security-Policy | **Phase 13** | Hardening, and every fork needs it |

## 14.1 Standalone feedback widget

`POST /api/feedback` serves the standalone HTML build's widget with
wildcard CORS and no `Origin` requirement (it also runs from
`file://`). Needs `FEEDBACK_DB`; screenshots additionally need
`CATALOG_R2` (PNGs land under `feedback/screenshots/`, only the key
goes to D1 — without the binding, reports still store, screenshots
drop).

**It must never be served a challenge.** The widget runs without
cookies and its fallback is a `mailto:` draft, so an interstitial
silently degrades every submission. JS Detections and AI Labyrinth
can stay on zone-wide, but if you have Bot Fight Mode, Managed
Rules, or custom WAF rules acting on those signals, add a skip:

```
(http.request.uri.path eq "/api/feedback" and http.request.method eq "POST")
```

Same Skip checklist as 8.6. The endpoint keeps its own abuse
controls (JSON-only, ~12 MB cap, 10/hour per IP). Verify from a
cookie-less client:

```bash
curl -X POST https://<W2>/api/feedback \
  -H 'Content-Type: application/json' \
  -d '{"source":"terraviz-standalone","type":"idea","rating":4,
       "text":"Test from curl","name":null,"email":null,
       "meta":{"ua":"curl"},"screenshot":null}'
# → 200 {"ok":true,"id":"…"}   (challenge HTML means the rule isn't matching)
```

## 14.2 Analytics long-term export

Analytics Engine retains 30–90 days. The export drains each
completed UTC day into an R2 newline-delimited JSON (NDJSON) archive plus D1 rollups — the
data behind `/publish/analytics`.

```bash
wrangler r2 bucket create terraviz-analytics
```

Bind as `ANALYTICS_R2` (deliberately separate from
`terraviz-assets` — telemetry shouldn't share asset lifecycle rules
or public read). No CORS needed; only the Function writes to it.

Then, Production environment:

| Variable | Type | Value |
|---|---|---|
| `CF_ACCOUNT_ID` | Plaintext | `W1` |
| `ANALYTICS_SQL_TOKEN` | **Secret** | Token with exactly **Account → Account Analytics → Read** |
| `ANALYTICS_AE_DATASET` | Plaintext | Only if you renamed `W9` |

Redeploy, then enable `.github/workflows/analytics-export.yml`
(daily 00:25 UTC; forks start with scheduled workflows disabled).
It reuses `TERRAVIZ_SERVER` / `CF_ACCESS_CLIENT_ID` /
`CF_ACCESS_CLIENT_SECRET`, exits quietly when unset, and logs a
warning rather than failing on 503 `export_unconfigured`. It walks
every day since its bookmark (capped at 7/run), so missed ticks
self-heal.

**Backfill once** while AE still remembers: Actions → **Analytics
Backfill** → Run workflow. Blank inputs default to "90 days ago
through yesterday". Idempotent.

```bash
# verify
wrangler r2 object get terraviz-analytics/events/v1/2026/03/15.ndjson.gz --pipe | gunzip | head -3
wrangler d1 execute sphere-feedback --remote --config wrangler.toml \
  --command "SELECT day, COUNT(*) FROM analytics_daily GROUP BY day ORDER BY day"
```

## 14.3 CI-applied migrations (opt-in)

`ci.yml` can apply pending `CATALOG_DB` migrations on every push to
`main`, just before deploy. **Off by default.** Enable by setting
repo variable `ENABLE_D1_MIGRATE=1` — but only *after* granting
`W11` **Account → D1 → Edit**. A Pages-only token yields Cloudflare
error `7403` (no D1 access) or `7500` (read but not write), and
because the step runs before the deploy, that blocks the whole
deploy. Editing a token's permissions keeps its value, so no
rotation is needed.

It applies `CATALOG_DB` only. That was once a safety requirement and
is now just scope. Both bindings point at the same physical database,
so the catalog migrations are all the backend needs, and feedback
schema changes are rare enough to apply by hand. Gated to
`refs/heads/main`, because preview deploys share the same physical D1
as production.
`npm run check:migrations` (in the type-check job) fails the build
on destructive schema statements (DDL) unless the migration opts in with a
`-- destructive: reviewed` comment.

## 14.4 Grafana

> **Probably skip this.** The primary analytics surface is the
> in-app `/publish/analytics` tab — privilege-gated, no external
> service, turned on by 14.2. Grafana remains for ad-hoc AE SQL
> against the raw stream.

Four dashboard JSONs ship under `grafana/dashboards/`; see
[`grafana/README.md`](../grafana/README.md). There's no native AE
plugin — the dashboards use Infinity (HTTP-over-JSON) POSTing SQL
to
`https://api.cloudflare.com/client/v4/accounts/<W1>/analytics_engine/sql`,
with `root_selector: "data"`.

## 14.5 Voice, events, blog, YouTube

| Feature | Variables | Notes |
|---|---|---|
| Orbit voice (batch speech-to-text and text-to-speech) | none | Runs on the `AI` binding. `KILL_VOICE=1` is the kill switch. |
| Realtime streaming STT | `CF_ACCOUNT_ID`, `CF_AI_GATEWAY`, `CF_AIG_TOKEN` (**secret**), optional `VOICE_STREAM_MODEL` | Opt-in. Absent any of them, `/api/voice/stream` sends a JSON error frame and the client falls back to batch Whisper. See [`ORBIT_VOICE_PLAN.md`](ORBIT_VOICE_PLAN.md) §3. |
| Wake word | `VITE_VOICE_WAKEWORD_MODEL_URL` (build-time) | [`ORBIT_WAKEWORD.md`](ORBIT_WAKEWORD.md) |
| YouTube media suggestions | `YOUTUBE_API_KEY` (**secret**) | Absent = source stays off, nothing errors. [`YOUTUBE_API_KEY.md`](YOUTUBE_API_KEY.md) |
| Current events / blog | none beyond Phase 8 | Feeds console at `/publish/feeds`. [`CURRENT_EVENTS_PLAN.md`](CURRENT_EVENTS_PLAN.md) |

# Phase 15 — Desktop app fork (Tier 3)

Three upstream-pinned values need changing. Skip entirely for a
web-only node.

**15.1 Updater endpoint + signing key.** `src-tauri/tauri.conf.json`
hardcodes upstream's feed and public key. Leave them and your
users' apps poll *upstream's* releases and reject anything you
sign.

```bash
npm run tauri signer generate -- -w "<password>"
```

Paste the public half into `updater.pubkey`; point
`updater.endpoints` at
`https://github.com/<W3>/releases/latest/download/latest.json`; set
repo secrets `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

**15.2 macOS notarization (optional).** `release.yml` signs and
notarizes only when all six `APPLE_*` secrets are present
(`APPLE_DEVELOPER_ID_CERTIFICATE_BASE64`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Without them the
build succeeds but ships unsigned, and macOS users hit the
Gatekeeper "damaged" warning.

**15.3 `VITE_API_ORIGIN`.** Desktop webviews are served from
`tauri://localhost`, so relative `/api/` paths don't resolve.
`src/services/catalogSource.ts` rewrites them to an absolute
origin, defaulting to `https://terraviz.zyra-project.org`. Set
`VITE_API_ORIGIN=https://<W2>` at build time so your app talks to
*your* backend. The same value drives deep-link host recognition,
so setting it also makes your node accept its own `/dataset/<id>`
links.

**15.4 Weblate.** `sync-weblate.yml` targets upstream's Weblate
project and needs `WEBLATE_TOKEN`. Disable the workflow unless you
run your own pipeline; otherwise it fails on every push to `main`.

---

# Updating an existing node

Everything above assumes a fresh install. This is the other path:
your node is already running, upstream has moved, and you want the
changes.

## Sync your fork

Your node deploys from your fork, so upstream work reaches you
only when you merge it.

```bash
git remote add upstream https://github.com/zyra-project/terraviz.git
git fetch upstream main
git merge upstream/main
```

Add the remote once. The fetch and merge are the routine part.

**Then pull the LFS content before you build.**

```bash
git lfs install    # once per machine
git lfs pull
```

This is not optional tidiness. Most images here are Git LFS
objects, and a clone or fetch without LFS leaves them as small
text files still wearing `.jpg` and `.png` names. The build
succeeds, the deploy succeeds, and the skybox arrives as garbage.
`npm run check:lfs` reports the state, and it is advisory — it
will not stop a build that is about to ship pointer text as
imagery.

## Rebuild, do not just redeploy

`VITE_*` values are read at build time and written into the
JavaScript. Redeploying an existing `dist/` therefore carries the
old values forward regardless of what you changed in a dashboard.

- **Cloudflare builds your project** — push to your default
  branch, or use Retry deployment.
- **Direct Upload** — run `npm run build` yourself, then
  `wrangler pages deploy dist/ --project-name <W10>`.

## Check whether a default you overrode has changed

This is the failure mode worth naming, because it is silent.
`normalizeBase` in [`src/config/endpoints.ts`](../src/config/endpoints.ts)
takes any non-empty value ahead of the built-in fallback. So when
upstream improves a default, a variable you set once — for a
reason that has since gone away — keeps winning, and the upgrade
appears to do nothing.

**The current case: Earth textures.** They used to be served from
upstream's CDN, and Reference C used to tell you to mirror the
files to your own bucket and point `VITE_EARTH_ASSET_BASE` there.
They are now committed to the repository and served from your own
origin with nothing set.

If you followed that advice, unset the variable. Otherwise you
ship 18.5 MB of textures in your bundle and go on loading them
from your mirror.

- **Cloudflare Pages** → Settings → Variables and Secrets →
  Build, delete `VITE_EARTH_ASSET_BASE`, then rebuild.
- **Direct Upload** — remove the export from your CI job, then
  rebuild.

Keep it only if you deliberately want a CDN in front of them. It
is an optimisation now rather than a workaround.

## Verify

The Phase 10 checks apply unchanged after an upgrade, and are the
fastest way to catch a binding that drifted while you were away.
Run both.

For the textures specifically, the useful check is local and
happens before you deploy:

```bash
npm run build
grep -rl "cloudfront.net/terraviz/basemaps" dist/assets/*.js
# → no output. A hit means VITE_EARTH_ASSET_BASE is still set.
```

Then, once deployed:

```bash
curl -sI https://<W2>/assets/basemaps/earth_diffuse_4096.jpg | head -1
# → HTTP/2 200
```

The first command is the one that matters. The second only proves
Vite copied the files into `dist/`. It stays green even when the
bundle points somewhere else, because the unused copy sits right
there at that path.

## What else an upgrade can need

- **New bindings.** Phase 8 creates them; `check:pages-bindings`
  names anything missing, so run it first and let it tell you.
- **Schema migrations.** Phase 14.3 if you opted into CI-applied
  migrations, otherwise apply them with wrangler yourself.
- **New manual steps.** `npm run setup -- --manual` reprints the
  current pre-flight sheet, including any step added since you
  installed. Turning on Analytics Engine arrived this way.

---

# Reference A — Complete variable inventory

Everything the deployed backend reads. The audit's source of truth
is [`scripts/lib/expected-bindings.ts`](../scripts/lib/expected-bindings.ts).

| Name | Kind | Phase | Required for |
|---|---|---|---|
| `FEEDBACK_DB` | D1 | 8 | Feedback form |
| `CATALOG_DB` | D1 | 8 | All of Tier 2 |
| `ANALYTICS` | AE | 8 | Telemetry storage |
| `TELEMETRY_KILL_SWITCH` | KV | 8 | Kill lever (fails open) |
| `CATALOG_KV` | KV | 8 | Catalog read cache |
| `CATALOG_R2` | R2 | 8 | Assets, screenshots |
| `AI` | Workers AI | 8 | Orbit, embeddings, voice |
| `CATALOG_VECTORIZE` | Vectorize | 8 | Semantic search |
| `ACCESS_TEAM_DOMAIN` | plaintext | 8 | Publisher API |
| `ACCESS_AUD` | plaintext | 8 | Publisher API |
| `TRUSTED_PUBLISHER_DOMAINS` | plaintext | 8 | Skip approval queue (→ `reviewer`, read-only) |
| `NODE_ID_PRIVATE_KEY_PEM` | secret | 8 | Federation signing |
| `PREVIEW_SIGNING_KEY` | secret | 8 | `terraviz preview` |
| `R2_PUBLIC_BASE` | plaintext | 8.5 | Serving any R2 asset |
| `R2_S3_ENDPOINT` | secret | 8.5 | Presigned uploads |
| `R2_ACCESS_KEY_ID` | secret | 8.5 | Presigned uploads |
| `R2_SECRET_ACCESS_KEY` | secret | 8.5 | Presigned uploads |
| `GITHUB_OWNER` | plaintext | 8.6 | Video transcode |
| `GITHUB_REPO` | plaintext | 8.6 | Video transcode |
| `GITHUB_DISPATCH_TOKEN` | secret | 8.6 | Video transcode |
| `ANALYTICS_R2` | R2 | 14.2 | Analytics archive |
| `CF_ACCOUNT_ID` | plaintext | 14.2 / 14.5 | AE SQL API, voice gateway |
| `ANALYTICS_SQL_TOKEN` | secret | 14.2 | AE SQL API |
| `ANALYTICS_AE_DATASET` | plaintext | 14.2 | Renamed AE dataset |
| `CF_AI_GATEWAY` | plaintext | 14.5 | Realtime STT |
| `CF_AIG_TOKEN` | secret | 14.5 | Realtime STT |
| `VOICE_STREAM_MODEL` | plaintext | 14.5 | STT model override |
| `YOUTUBE_API_KEY` | secret | 14.5 | YouTube suggestions |
| `KILL_VOICE` | plaintext | — | Voice kill switch |
| `KILL_TELEMETRY` | plaintext | — | Telemetry kill switch (410) |
| `FEEDBACK_ADMIN_TOKEN` | secret | 6.4 | Bearer fallback for legacy admin routes |
| `CATALOG_R2_BUCKET` | plaintext | — | Bucket-name override |

**Build-time (`VITE_*`, Pages → Environment variables):**
`VITE_BUILD_CHANNEL`, `VITE_TELEMETRY_ENABLED`,
`VITE_EARTH_ASSET_BASE`, `VITE_API_ORIGIN`,
`VITE_DEFAULT_UI_SCALE`, `VITE_VIDEO_PROXY_BASE`,
`VITE_CAPTION_PROXY_BASE`, `VITE_SAMPLE_TOURS`,
`VITE_VOICE_WS_STREAMING`,
`VITE_VOICE_WAKEWORD_MODEL_URL`. Changing one needs a **rebuild**,
not just a redeploy.

**Local-dev only** (`.dev.vars`, refused on non-loopback hosts):
`DEV_BYPASS_ACCESS`, `DEV_PUBLISHER_EMAIL`,
`ALLOW_DEV_PREVIEW_FALLBACK`, `MOCK_AI`, `MOCK_VECTORIZE`,
`MOCK_R2`, `MOCK_STREAM`, `MOCK_GITHUB_DISPATCH`.

---

# Reference B — CI/CD workflow matrix

Workflows travel with the fork; the secrets that make them run do
not.

| Workflow | Needs | Drop it if… |
|---|---|---|
| `ci.yml` type-check / unit-tests / build | nothing | **keep** — fork-safe |
| `ci.yml` **deploy** job | `CLOUDFLARE_API_TOKEN` (`W11`), `CLOUDFLARE_ACCOUNT_ID` (`W1`); envs `production`/`preview`; rename `--project-name` to `W10` | you deploy via the dashboard Git integration (Phase 5.3) |
| `poster.yml` | same, plus `terraviz-poster` rename; envs `poster-*` | no poster sub-site |
| `visual-report.yml` | smoke/report/diff: nothing. Optional report deploy: the two Cloudflare secrets + a `terraviz-visual` project; optional `vars.VISUAL_DEPLOY_URL` | **keep** the gating jobs; drop only the deploy step |
| `transcode-hls.yml` | the seven Phase 8.6 GitHub secrets | no publisher video uploads |
| `analytics-export.yml` / `analytics-backfill.yml` | `TERRAVIZ_SERVER`, `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | you skipped 14.2 |
| `release.yml` / `desktop.yml` | `TAURI_SIGNING_PRIVATE_KEY` + `_PASSWORD`, 6× `APPLE_*` | web-only node |
| `sync-weblate.yml` | `WEBLATE_TOKEN` | no translation pipeline of your own |
| `codeql.yml`, `mobile.yml` | nothing | **keep** — fork-safe |

**The visual report site** is optional and mostly Cloudflare-free.
To host the generated report:
`npx wrangler pages project create terraviz-visual --production-branch main`.
No bindings, no new secrets, no custom domain needed — it's a
static `index.html` plus PNGs, and it reuses `W11`/`W1`. Set
`VISUAL_DEPLOY_URL` (a repo **Variable**) to re-capture against the
live site with the a11y scan on. If `/publish/**` is behind Access,
the headless capture hits the SSO wall. It already reuses
`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`, so there's nothing
new to set — as long as that token's Service Auth policy covers the
publisher app. Headers go only to first-party origins, never to
tile CDNs. The deploy step is `continue-on-error`, so skipping all
of it breaks nothing. The regression baseline is a GitHub Actions
artifact, not a Cloudflare resource; the first `main` run
bootstraps it.

---

# Reference C — Fork-pinned source values

Phase 3 covers the `wrangler.toml` IDs every node must change.
These are the remaining upstream pointers. None break a web
deploy's same-origin `/api/` calls, but they leave your node
quietly dependent on upstream infrastructure.

| Env var | Default | What it is | Change it when |
|---|---|---|---|
| `VITE_EARTH_ASSET_BASE` | *(unset — served from your own origin)* | Earth basemap textures (diffuse / night lights / normal / borders) for the photoreal Earth and 2D overlays — loaded by **every** node. | **Nothing to do.** The eleven files are committed under `public/assets/basemaps/`, so your clone has them and your build serves them itself — no install-time fetch, and it works air-gapped. Set this only to move them to a CDN. |
| `VITE_VIDEO_PROXY_BASE` | `https://video-proxy.zyra-project.org/video` | Resolves **legacy SOS** `vimeo:` data refs into HLS/MP4. | Only if you ran `import-snapshot` and want video independent of upstream. The proxy worker isn't in this repo. |
| `VITE_CAPTION_PROXY_BASE` | `https://video-proxy.zyra-project.org/captions` | CORS shim for legacy `sos.noaa.gov` `.srt` captions. | Same. |
| `VITE_SAMPLE_TOURS` | *(unset — the two bundled tours are shown)* | "Climate Connections" and "Climate Futures", the sample tours committed under `public/assets/`. They are injected into the catalog **client-side**, after `/api/v1/catalog` returns, so they appear even on a node that has published nothing — and they load SOS handles (`INTERNAL_SOS_25_VIDEO`, `INTERNAL_SOS_SSP_GA_19`, …) that only exist upstream. On your node the cards open a tour that can load nothing, and Orbit recommends them to newcomers besides. | **Set it to `false`** unless you ran `import-snapshot` and hold those datasets. It drops those two rows only — your own published tours are unaffected (that is the `tours` node-feature toggle, which is broader). If CI builds, it is a **GitHub Variable** (Settings → Secrets and variables → Actions → Variables — repo-level, not the `production` Environment, or your preview deploys keep the tours). `ci.yml`, `desktop.yml`, `mobile.yml` and `release.yml` all pass it through, so one Variable covers web, desktop and mobile alike. If Cloudflare builds the web bundle instead, set it in Pages → Settings → Environment variables — that reaches the web build only, and your desktop/mobile builds still need the GitHub Variable. |
| `TERRAVIZ_DOCS_URL` | `https://github.com/zyra-project/terraviz/blob/main/docs/SELF_HOSTING.md` | Base for the 19 links the `/setup` console makes into this guide (17 anchored per phase). Read at **build** time by `npm run build:setup-page`. | Once your fork's copy of this guide diverges from upstream's. Set it to your own blob URL — including the branch, if yours isn't `main` — and rebuild. |

Content you publish through the portal is transcoded to your own
R2 (`r2:` data refs) and never touches either proxy — the proxies
only matter for mirrored SOS rows.

> `TERRAVIZ_DOCS_URL` only matters for people reading your node's
> `/setup` without filling anything in. The console also retargets
> those links at runtime from `W3`, your git remote. So anyone
> actually working through the install gets your fork's guide as soon
> as they enter it, whether or not you set the variable.

The SOS metadata snapshot, the cloud-texture bucket, and NASA GIBS
tiles are third-party **public data sources** shared by all nodes,
not upstream infrastructure. Leave them pointed at NOAA/NASA.

Cosmetic, change at leisure: `src/ui/creditsPanel.ts` and
`docs/PRIVACY.md` link to `github.com/zyra-project/terraviz` (after
editing `PRIVACY.md`, run `npm run build:privacy-page` — CI's
`check:privacy-page` enforces the diff). Deep links resolve
automatically from `VITE_API_ORIGIN` plus any `*.pages.dev` and
`localhost`. The `terraviz` CLI defaults to `https://terraviz.app`
but takes `--server`, `TERRAVIZ_SERVER`, or
`~/.terraviz/config.json`.

---

# Reference D — Troubleshooting

### `npm install` fails building `better-sqlite3`
Your Node has no precompiled binary for this version of
`better-sqlite3`, so npm fell back to `node-gyp`, which needs
Python and a C++ compiler. The error names whichever of those is
missing first — on Windows, usually Python. That is the symptom,
not the cause. The cause is a few lines above it:

```
prebuild-install warn install No prebuilt binaries found (target=… platform=…)
```

Run `node --version`. `better-sqlite3` builds binaries only for the
Node majors current at its release, so both a Node past end-of-life
and a Node newer than the dependency land here. Install 22 or 24
from [nodejs.org](https://nodejs.org/en/download), delete
`node_modules`, and run `npm install` again. It is the only
dependency here that compiles anything, so nothing else in the tree
needs a toolchain.

### The globe has no stars, or the Earth has no specular highlight
Your clone has Git LFS (Large File Storage) pointers where the
textures should be. Check:

```bash
ls -l public/assets/skybox/nx.jpg     # ~790 KB if real, 131 bytes if a pointer
```

131 bytes is a text file naming the object it stands for. Fix it
with `git lfs install` then `git lfs pull`, rebuild, redeploy.

`npm run check:lfs` reports every one of them at once, with the
repair, so you do not have to guess which files to look at:

```bash
npm run check:lfs
```

It is advisory and exits 0, because a build that skips LFS on
purpose is a legitimate thing to do. Add `--strict` to make it a
gate in your own workflow.

The build will not tell you: `npm run build` copies `public/`
verbatim without looking inside, so it reports no errors and the
pointers ship to `dist/` under their `.jpg` names.

Deploying from GitHub Actions? `actions/checkout` does **not**
fetch LFS unless you pass `lfs: true`. Both `ci.yml` and
`poster.yml` already pass it. `ci.yml`'s deploy also runs
`check:lfs --strict` straight after the checkout, so a missing
texture stops the deploy rather than reaching your visitors.

### `npm run …` says `'tsx' is not recognized`
You skipped `npm install`, or ran it somewhere other than the
repository root. Every `npm run` command in this guide runs from
inside your clone, after a successful install. See §0.4.

### Deploy fails: "You need to enable Analytics Engine"
The product is off on your account, and stays off until somebody
opens it once. A Pages Function that declares an
`analytics_engine_datasets` binding cannot publish without it, so
this fails the whole deploy rather than degrading one route.

Open **Workers & Pages → Analytics Engine** and create a dataset:
Dataset Name `terraviz_events`, Dataset Binding `ANALYTICS`. Then
retry the deployment. The error links straight to the page.

Creating the dataset is not strictly what fixes it — AE datasets
appear on first write regardless. Enabling the product is. The
dialog is just the shortest path to both.

### `/api/ingest` returns 204 but nothing lands in Analytics Engine
The `ANALYTICS` binding is missing in the environment serving
traffic. Check both Production and Preview.
`functions/api/ingest.ts` reads `context.env.ANALYTICS` and
silently skips the write when undefined.

### `/api/ingest` returns 403
The cross-origin (CORS) gate rejected it, for one of two reasons.

1. The `Origin` header is missing. Browsers always send it; curl
   doesn't, unless you pass `-H "Origin: …"`.
2. The origin isn't in the allowlist, doesn't match the request URL,
   and doesn't end with `.pages.dev`.

### Publisher API returns 503 `access_unconfigured`
`ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is missing — most often set on
Production but not Preview. Confirm with
`npm run check:pages-bindings`.

### Publisher API returns 401 "Invalid or expired Access assertion"
`ACCESS_AUD` doesn't match the application that issued the token.
Access signs every request with a JSON Web Token (JWT), and the `aud`
claim inside it names the application. `ACCESS_AUD` has to be that
same audience tag.
Re-copy `W13` from the application's Overview tab. A token minted
for a *different* application of the same team is rejected by
design.

### `/.well-known/terraviz.json` 503s, or publishing fails on `origin_node`
Remote `node_identity` is empty — Phase 9 wasn't run. The local
`db:seed` / `gen:node-key` paths do **not** write remote D1. (The
error text's "Run `npm run gen:node-key`" hint is wrong; use
`terraviz init-node`.)

### `Save draft` 500s with `table datasets has no column named bbox_n`
The catalog migrations weren't applied — usually because
`migrations apply` was given the database *name* instead of the
binding name (Phase 4). Confirm with
`wrangler d1 migrations list CATALOG_DB --remote`.

### A Zyra run builds its frames, then every frame PUT 401s
The workflow fires, downloads its data and renders images, and dies
on the upload:

```
[zyra-run] frames-publish: 85 image/png frame(s), 30354195 bytes total
[zyra-run] FAIL: frame-sequence publish → frames-publish: frame PUT
  20260804T140000.png failed (401): <Error><Code>Unauthorized</Code>…
```

**The runner did not sign this, and your GitHub secrets are not what
failed.** It asks your node for presigned URLs and PUTs bytes at
them. The signing happens inside the publisher API, using the R2
credentials you set as Pages secrets in 8.5.

**Those secrets are set.** A missing `R2_S3_ENDPOINT`,
`R2_ACCESS_KEY_ID` or `R2_SECRET_ACCESS_KEY` raises a configuration
error, which the route returns as **503 `*_unconfigured`**. You would
have seen `asset init failed (503)` and never reached a frame PUT.

So they are set, and R2 rejected them. Cloudflare defines this exact
code — `Unauthorized`, HTTP 401 — as **"missing or invalid
authentication credentials"**, and the documented fix is to check the
access key is correct and unexpired
([R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)).
That narrows it to three things:

- The token was **deleted, rotated or expired** in R2 after you set
  the secrets.
- **`R2_ACCESS_KEY_ID` holds the wrong string.** R2 shows three
  values when a token is minted: Access Key ID, Secret Access Key,
  and a token value. Only the first two belong here.
- **`R2_S3_ENDPOINT` belongs to a different account** than the token,
  so the key is unknown at that host.

**What it is not.** These are the usual suspects, and each fails
with a different status — so a 401 rules them out:

| Suspicion | What you would actually see |
|---|---|
| Token scoped to the wrong bucket | 403 — that is authorization, not authentication |
| `R2_SECRET_ACCESS_KEY` wrong | 403 `SignatureDoesNotMatch` — the key id still resolves |
| A different `Content-Type` sent than signed | 403 `SignatureDoesNotMatch` — it is a signed header |
| Presigned URL expired | 403, and the 15-minute TTL is nowhere near tight for 85 frames |

**You can read the key id off the URL.** These are query-string
presigned, so the credential rides in the clear:

```
X-Amz-Credential=<access-key-id>/<YYYYMMDD>/auto/s3/aws4_request
```

Compare that against the token list in the R2 dashboard. A Pages
secret cannot be read back, so this is the only way to see which key
your node is actually signing with.

The fix either way: mint a fresh token (8.5 step 4), set all three
secrets again on **both** environments, and redeploy.

To test the credentials first, make a signed request from your own
shell with the same three values. Use `aws s3api put-object
--endpoint-url "$R2_S3_ENDPOINT"` against the bucket, with the key
pair in `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. A 401 there
too confirms the credentials rather than the wiring.

`npm run terraviz -- migrate-r2-assets --dry-run` is **not** that
check. It prints its plan and returns before it ever reaches the
credential code.

### Access blocks your own `@your-org.org` account
The policy uses **Emails** (exact match) instead of **Emails ending
in** (suffix match).

### Portal shows "Your session has expired"
Expected before Phase 6.2's application covers `/publish/*`.
Cloudflare answers unauthenticated requests with a cross-origin 302
the portal can't follow — it's fetched with `redirect: 'manual'` so
it can *detect* the redirect, but it can't complete the sign-in.
The Refresh button is the escape hatch: refreshing triggers Access
at top-level navigation, you sign in, and the next fetch succeeds.

### Console fills with CORS errors on `/api/tile/`, but the globe still renders
Your Access application covers the whole hostname instead of the six
destinations Phase 6.2 lists. Three request paths in the SPA are
deliberately uncredentialed. On a fully-protected host each one draws
a 302 to `<team>.cloudflareaccess.com`. The redirect then fails the
CORS check, because the login origin sends no
`Access-Control-Allow-Origin`:

| Request | What you see |
|---|---|
| `tilePreloader.ts` z0–z3 warm-up | ~170 CORS errors and nothing else — the preloader catches per URL and moves on |
| `POST /api/ingest` | telemetry retries and backs off forever; only the `sendBeacon()` pagehide flush lands |
| `/site.webmanifest` | no install prompt, no theme colour, no shortcuts |

The globe keeps working throughout, which makes this look like a
service worker bug. It is not. `sw.js` re-issues
`fetch(request.clone())`, and a clone carries the caller's own
credentials mode. So the worker fails exactly the requests that were
already failing. It never sees `/site.webmanifest` at all:
`shouldCache` claims only `/api/tile/`, `/assets/skybox/` and the
specular map. MapLibre's raster sources set no `transformRequest`,
so its tile fetches use the default `same-origin` credentials and
succeed. The discriminator is which caller issued the request, not
the zoom level and not a `clients.claim()` race.

Two fixes, and you want the first:

1. **Narrow the Access application** to the Phase 6.2 destinations.
   `/api/tile/`, `/api/ingest` and the SPA shell are public surfaces;
   only `/publish*` and `/api/v1/publish` need a policy.
2. **If whole-host protection is deliberate**, deploy a build new
   enough to send `credentials: 'same-origin'` on those three paths.
   That is the staging-node case: nobody outside the org should reach
   it, and anonymous visitors get nothing either way.

Do not reach for `credentials: 'include'` inside `sw.js`. It would
apply to the cross-origin rules too, and both of those origins answer
with `Access-Control-Allow-Origin: *`, which a browser rejects
outright on a credentialed request. One of them is the SOS catalog,
so it trades some missing tiles for an empty dataset list.

### Publisher portal shows `role: service` for a real user
A pre-3pa middleware bug — the classifier read `claims.type ===
'app'` as the service-token signal, but Cloudflare stamps
`type: 'app'` on every application-level JWT. Fixed; rows
provisioned before the fix keep the wrong classification. Correct
it from the Users tab, or by SQL if no admin exists.

### `terraviz verify-deploy` shows SKIP for the publisher checks
No service token configured. Re-run with
`TERRAVIZ_ACCESS_CLIENT_ID` / `TERRAVIZ_ACCESS_CLIENT_SECRET`
(`W14`/`W15`), and confirm the token is attached to a Service Auth
policy on the publisher app.

### `terraviz import-snapshot` 409s on the second run
Working as designed — the `legacy_id` idempotency check skips rows
already published. To genuinely re-import, `terraviz retract <id>`
first.

### Orbit stops showing dataset chips after working briefly
Workers AI free-tier neuron exhaustion. The chat panel shows a
"Reduced functionality" badge; the node is healthy, just throttled.
Quota resets daily. Sustained use needs Workers Paid — a docent
turn that tool-calls `search_datasets` burns ~50 neurons across the
embed + chat round-trip, so ~200 turns/day exhausts the free
ceiling.

### Zip-download shows "size unknown"
R2 CORS. No console error means the request succeeded but
`Content-Length` / `Content-Range` weren't exposed — add both to
`ExposeHeaders`. A `Access-Control-Allow-Origin missing` error
means it was blocked outright, usually because `HEAD` isn't in
`AllowedMethods` (R2 treats HEAD and GET as distinct for CORS even
though Fetch doesn't). See Phase 13.1.

"Asset hosted externally; see manifest for source URLs" is a
*different*, harmless signal: the asset's hostname isn't in
`PUBLISHER_HOSTS` (`src/services/downloadService.ts`). Patch that
list to include hosts you control and rebuild.

<details>
<summary>Legacy CloudFront-fronted S3 origins (SOS mirrors only)</summary>

If some imported rows still resolve to a CloudFront distribution
backed by S3, CORS lives in two places:

1. **S3 bucket CORS** — same fields as the R2 policy, as XML or
   JSON. `HEAD` in `<AllowedMethod>`, `Content-Length` +
   `Content-Range` in `<ExposeHeader>`.
2. **CloudFront** — it caches by URL and strips CORS headers unless
   told otherwise. You have two options.

   Attach a **Response Headers Policy** to the default cache
   behaviour, then invalidate `/*`. Use `Allow-Origin: *`,
   `Allow-Methods: GET, HEAD`, `Expose-Headers: Content-Length,
   Content-Range`, and Origin Override: Yes. This wins over
   S3-side config.

   Or use the AWS-managed `CORS-S3Origin` cache policy. It is less
   invasive, but it fragments the cache and still needs the S3 fix.

The S3 fix alone suffices if the distribution already forwards
`Origin`. Cheapest test: apply it, hard-refresh, open the
zip-download dialog on a CloudFront-served dataset.
</details>

### `wrangler kv key put` says namespace not found
`--namespace-id` wants the raw 32-char hex ID, not the title.
`wrangler kv namespace list` to confirm.

### Grafana shows "Leanne Graham, Devops Engineer"
The Infinity plugin is on its bundled demo URL because the
datasource isn't configured. Panel targets use a relative `/sql`;
the datasource needs the absolute base
`https://api.cloudflare.com/client/v4/accounts/<W1>/analytics_engine`.

### Privacy page is stale relative to `docs/PRIVACY.md`
```bash
npm run build:privacy-page && git add public/privacy.html
```
CI's `check:privacy-page` fails when the HTML drifts.

### Tour quiz / VR events missing from Tier A queries
`tour_question_answered` and `vr_interaction` are **Tier B** —
they only fire for users who opted into Research mode under
Tools → Privacy.

---

## After a successful launch

- **Kill switches.** You have two: `wrangler kv key put
  telemetry_enabled disabled --namespace-id=<W5>` (clients get 410
  + `Retry-After: 300`; `wrangler kv key delete` to resume), and
  the `KILL_TELEMETRY=1` env var. Document who can flip them.
- **Token expiry.** If `W11` or `ANALYTICS_SQL_TOKEN` has an expiry (a TTL),
  put the date in a calendar. A silently expired token is a
  silently broken dashboard.
- **Watch the first week.** Errors-by-category: a flood of
  `network` usually means the content delivery network serving an
  asset is rate-limiting; `auth` means a language-model key issue.
  Watch Orbit rounds/day against the free-tier ceiling.
- **Test your own feedback loop.** File a report through the in-app
  form and confirm it appears in `/publish/feedback`.
- **Add a CSP** — Phase 13, if you have not already.

If something here is wrong or under-documented, please open an
issue — most of this document exists because someone hit a snag
and it was worth writing down.
