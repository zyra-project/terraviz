# Build-tooling module map (`scripts/lib/`)

One row per non-test module under `scripts/lib/` — the shared library
behind the repo's build, provisioning and audit scripts. It is the third
map alongside the SPA + Rust maps in [`CLAUDE.md`](../CLAUDE.md) and the
backend map in [`BACKEND_MODULES.md`](BACKEND_MODULES.md), and lives here
for the same reason the backend map does: it is tooling rather than
product code, and adding twenty rows to CLAUDE.md would bloat the SPA map
without helping anyone reading it.

> **Enforced.** `npm run check:doc-coverage` (in the `type-check` chain)
> fails CI if a module under `scripts/lib/` is missing from this file.
> Add a row in the same PR; for a module that genuinely needs none
> (throwaway shim), add `// doc-exempt: <reason>` to its source.

**Scope is `scripts/lib/` only, deliberately.** The ~27 one-shot CLI
entry points at the top of `scripts/` (`build-privacy-page.ts`,
`gen-node-key.ts`, each `check:*` validator) are *not* covered: their
filenames are the documentation, and a row restating the filename is
ceremony that still has to be maintained. `scripts/lib/` is different —
it is imported from ~17 call sites across the repo, so a reader arriving
at one of these files needs to know what else depends on it.
`scripts/screenshots/` is also uncovered, because CLAUDE.md's _Visual
testing & reporting_ section already documents that subsystem in prose,
including the `Scene` convention; a per-module table there would
duplicate it.

Most of these files carry a substantial header comment explaining the
*why* — the rows below are a index, not a replacement for reading them.

## Shared helpers (`scripts/lib/`)

| File | Responsibility |
|---|---|
| `scripts/lib/build-channel.ts` | The `session_start.build_channel` a bundle reports, which `vite.config.ts` bakes into `__BUILD_CHANNEL__`: an explicit `VITE_BUILD_CHANNEL` wins, otherwise `internal` under the dev server and `public` for a build (#531). Keyed on `mode` to match the client's console-mode default. Moved out of the config file so `functions/tsconfig.json` type-checks it |
| `scripts/lib/catalog-migrations.ts` | Where the migrations live + how to apply them to an in-memory DB, shared so `dump-catalog-schema.ts` and the migrations smoke test cannot disagree about either |
| `scripts/lib/cf-pages-api.ts` | Cloudflare Pages REST **read** client for the bindings audit — pure mapping from `GET /accounts/{id}/pages/projects/{name}` into binding shapes |
| `scripts/lib/cli.ts` | Shared CLI helpers for the tsx-based scripts; `isInvokedAsScript()` is the cross-platform "is this file the entry point" check that gates `main()`-style top-level calls |
| `scripts/lib/d1-local.ts` | Locates the local D1 SQLite file Wrangler maintains under `.wrangler/state/v3/d1/` — used by `seed-catalog.ts` and the migrations smoke test |
| `scripts/lib/expected-bindings.ts` | The declared binding manifest for the production Pages project; `check-pages-bindings` diffs the live project against it, and `setup/bindings-plan.ts` builds the write payload from the same list |
| `scripts/lib/node-version.ts` | The required Node version, read from `package.json`'s `engines` — the generated surfaces interpolate it and a test fails the build when the hand-written prose in `SELF_HOSTING.md` or `README.md` disagrees. Exists because the version was written out by hand in three places and all three were wrong |
| `scripts/lib/plain-language.ts` | Readability measurement for the operator-facing docs, behind `check:plain-language` — prose extraction from Markdown and from generated HTML (the hard part: code fences, tables, click paths and code spans must not be measured as prose), sentence splitting, Flesch / Flesch–Kincaid, and the long-sentence gate. Scores are reported, sentence length is enforced |

## Node provisioning (`scripts/lib/setup/`)

Backs `npm run setup`. Each module maps to a numbered phase of
[`SELF_HOSTING.md`](SELF_HOSTING.md).

| File | Responsibility |
|---|---|
| `scripts/lib/setup/access.ts` | Cloudflare Access provisioning (Phase 6) — creates the Access application the pre-2026 guide told operators to configure `ACCESS_AUD` for without ever creating |
| `scripts/lib/setup/bindings-plan.ts` | Turns the declared binding manifest into a Pages PATCH body (Phase 8), sharing that manifest with the auditor so plan and audit cannot drift |
| `scripts/lib/setup/cf-pages-write.ts` | Pages project **write** client (Phase 8) — the one thing wrangler cannot do; counterpart to the read client in `cf-pages-api.ts` |
| `scripts/lib/setup/cf-request.ts` | Shared Cloudflare v4 transport — unwraps the common `{ success, result, errors }` envelope and normalizes failures so every caller does not re-implement it |
| `scripts/lib/setup/github-secrets.ts` | GitHub Actions repo secrets (Phase 13.2 / 13.4) — emits `gh` commands rather than calling the REST API, which would require client-side libsodium encryption |
| `scripts/lib/setup/handoff.ts` | The handoff report — every value the operator must place somewhere this tool cannot reach, so provisioning does not stop at "done" and leave the worst part undocumented |
| `scripts/lib/setup/interview.ts` | The interactive interview (`npm run setup -- --interactive`), separating what the tool can discover from what only the operator can decide |
| `scripts/lib/setup/pages-project.ts` | Pages project + custom domain (Phase 5), including the Git-remote OAuth handshake that genuinely cannot be automated and must be handed to the operator |
| `scripts/lib/setup/prompt.ts` | Terminal prompting behind an interface rather than direct readline calls, so re-prompting and validation are testable |
| `scripts/lib/setup/provision.ts` | Idempotent resource provisioning (Phase 2) — shells out to wrangler rather than the REST API, so resource creation matches what the operator would run by hand |
| `scripts/lib/setup/r2-config.ts` | R2 public domain + CORS policy (Phase 13.1) — generates the policy because R2's CORS implementation is stricter than the Fetch spec in ways a pasted example gets wrong |
| `scripts/lib/setup/secrets.ts` | Node secret material (Phase 7) — the two secrets that do not exist until someone creates them, which the old guide listed in its bindings table as though they did |
| `scripts/lib/setup/state.ts` | Resumable state for `npm run setup` — the machine-readable form of the `SELF_HOSTING.md` worksheet, so an install that dies partway through can continue rather than restart |
| `scripts/lib/setup/waf.ts` | WAF skip rules (Phase 13.2 / 13.3) for the endpoints that must stay reachable by clients which cannot solve a JS challenge |
| `scripts/lib/setup/wrangler-toml.ts` | Repoints the fork-pinned resource IDs in `wrangler.toml` (Phase 3) — the file ships with upstream's real IDs, which every `wrangler` command in a fork would otherwise target |
