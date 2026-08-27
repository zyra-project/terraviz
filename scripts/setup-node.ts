// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * `npm run setup` — provision a Terraviz node's Cloudflare resources
 * and wire its Pages bindings.
 *
 * Automates Phases 5, 2, 3, 4, 6, 7, 8 and (opt-in) 13.1 to 13.3 of
 * `docs/SELF_HOSTING.md`: create the Pages project and attach its
 * custom domain, create the D1 / KV / R2 / Vectorize resources,
 * repoint `wrangler.toml` at them, apply both migration sets,
 * provision the Cloudflare Access application + policies + service
 * token, generate the preview signing key, write every binding to
 * both environments, and — when asked — set the R2 CORS policy and
 * public domain and append the two WAF skip rules.
 *
 * ## What it deliberately does not do
 *
 * Account creation, Workers Paid, nameservers, Zero Trust onboarding
 * and identity-provider choice, connecting the Pages project to a Git
 * remote (an OAuth handshake with no API), minting the R2 S3 token
 * (it needs a token that can mint tokens — a security boundary worth
 * keeping manual), writing GitHub Actions secrets (they need
 * libsodium sealed-box encryption; it prints the `gh` commands
 * instead), the node keypair (`npm run gen:node-key` owns that), and
 * the first SSO sign-in.
 *
 * ## Plan by default
 *
 * A bare `npm run setup` writes nothing. It prints what it would
 * create and what it would set, and exits. `--apply` is the explicit
 * opt-in. Provisioning cloud resources and mutating a live deploy's
 * bindings is not something to do as a side effect of running a
 * command to see what it does.
 *
 * ## Resumability
 *
 * State lands in `.terraviz-setup.json` (gitignored) after every
 * resolution, not at the end — a run that dies partway through
 * Vectorize still records the D1 and KV IDs it resolved, so the next
 * run adopts rather than re-creates. Secret *values* are never
 * written there.
 *
 * Usage:
 *   npm run setup                    # plan only
 *   npm run setup -- --apply         # provision + wire
 *   npm run setup -- --only=bindings # one step
 *   npm run setup -- --apply --local-migrations
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXPECTED_BINDINGS } from './lib/expected-bindings.ts'
import {
  NODE_DOWNLOAD_URL,
  requiredNodeLabel,
  requiredNodeMajor,
} from './lib/node-version.ts'
import {
  buildPatchBody,
  formatBindingsPlan,
  OPTIONAL_EXTRAS,
  planBindings,
  type SecretSource,
} from './lib/setup/bindings-plan.ts'
import {
  AccessApi,
  ensureAccessApplication,
  ensurePolicies,
  ensureServiceToken,
  publisherDestinations,
} from './lib/setup/access.ts'
import { PagesProjectWriter } from './lib/setup/cf-pages-write.ts'
import { CfApi, matchZone } from './lib/setup/cf-request.ts'
import { renderGithubSecretsScript } from './lib/setup/github-secrets.ts'
import { buildHandoff, renderHandoff } from './lib/setup/handoff.ts'
import {
  applyAnswer,
  pendingQuestions,
  renderManualSteps,
} from './lib/setup/interview.ts'
import {
  InteractivePrompter,
  NonInteractivePrompter,
  type Prompter,
} from './lib/setup/prompt.ts'
import {
  ensureCustomDomain,
  ensurePagesProject,
  PagesProjectApi,
} from './lib/setup/pages-project.ts'
import {
  buildCorsRules,
  ensureR2CustomDomain,
  R2ConfigApi,
  toDashboardJson,
} from './lib/setup/r2-config.ts'
import {
  buildFeedbackRule,
  buildTranscodeRule,
  ensureWafRules,
  WafApi,
} from './lib/setup/waf.ts'
import {
  applyMigrations,
  ensureD1,
  ensureKv,
  ensureR2Bucket,
  ensureVectorizeIndex,
  ensureVectorizeMetadata,
  type CommandResult,
  type CommandRunner,
} from './lib/setup/provision.ts'
import { ensureSecrets } from './lib/setup/secrets.ts'
import {
  applyEnvOverrides,
  DEFAULT_NAMES,
  hydrateState,
  serialiseState,
  VECTORIZE_METADATA_PROPERTIES,
  type SetupEnv,
  type SetupState,
} from './lib/setup/state.ts'
import { repointWranglerToml, stillPinnedUpstream } from './lib/setup/wrangler-toml.ts'

const STEPS = [
  'pages',
  'resources',
  'wrangler-toml',
  'migrations',
  'access',
  'secrets',
  'bindings',
  'r2',
  'waf',
] as const
type Step = (typeof STEPS)[number]

/**
 * Steps a bare run performs. `waf` is excluded deliberately: it
 * rewrites the zone's custom-rule list, and the rulesets API replaces
 * rather than appends, so it is something you ask for rather than
 * something that happens on the way past. `r2` is excluded because
 * the public bucket domain is a Phase 13 add-on many nodes never
 * need.
 */
const DEFAULT_STEPS: Step[] = [
  'pages',
  'resources',
  'wrangler-toml',
  'migrations',
  'access',
  'secrets',
  'bindings',
]

/**
 * Is the running Node new enough?
 *
 * Pure and exported so the failure path is testable — the alternative
 * is trusting a check nobody can exercise on the one version we cannot
 * reproduce here.
 */
export function checkNodeVersion(version: string): { ok: boolean; found: string } {
  const found = version.replace(/^v/, '')
  const major = Number(/^(\d+)/.exec(found)?.[1] ?? NaN)
  return { ok: Number.isFinite(major) && major >= requiredNodeMajor(), found }
}

/**
 * The Cloudflare API token, trimmed, with blank read as unset.
 *
 * The token is minted in the dashboard and pasted into a shell —
 * `export CLOUDFLARE_API_TOKEN=$(cat token.txt)` keeps the file's
 * newline, and so does a copy that caught a trailing space.
 * Untrimmed it goes straight into an `Authorization: Bearer`
 * header, and Cloudflare answers 401, which reads like a token
 * with the wrong permissions rather than a token with an extra
 * byte. Every read of the token in this file goes through here.
 */
function apiToken(env: Record<string, string | undefined>): string | undefined {
  return env.CLOUDFLARE_API_TOKEN?.trim() || undefined
}

export interface SetupDeps {
  argv: string[]
  env: SetupEnv & Record<string, string | undefined>
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
  runner: CommandRunner
  readFile: (path: string) => string
  writeFile: (path: string, contents: string) => void
  exists: (path: string) => boolean
  fetchImpl?: typeof fetch
  /**
   * Interactive prompting. Absent (or non-interactive) means every
   * question resolves to null, which callers report as a missing
   * value rather than blocking — a prompt that waits forever in CI is
   * worse than a clean failure.
   */
  prompter?: Prompter
  /**
   * The running Node version, as `process.version`. Injectable so the
   * check can be tested against versions this process is not on.
   */
  nodeVersion?: string
}

interface Options {
  apply: boolean
  steps: Set<Step>
  statePath: string
  wranglerPath: string
  devVarsPath: string
  localMigrations: boolean
  githubSecrets: boolean
  interactive: boolean
  manual: boolean
  features: Set<'r2' | 'transcode'>
  help: boolean
}

function parseArgs(argv: string[]): Options | { error: string } {
  const opts: Options = {
    apply: false,
    steps: new Set(DEFAULT_STEPS),
    statePath: '.terraviz-setup.json',
    wranglerPath: 'wrangler.toml',
    devVarsPath: '.dev.vars',
    localMigrations: false,
    githubSecrets: false,
    interactive: false,
    manual: false,
    features: new Set(),
    help: false,
  }
  for (const arg of argv) {
    if (arg === '--apply') opts.apply = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--local-migrations') opts.localMigrations = true
    else if (arg === '--github-secrets') opts.githubSecrets = true
    else if (arg === '--interactive' || arg === '-i') opts.interactive = true
    else if (arg === '--manual') opts.manual = true
    else if (arg.startsWith('--with=')) {
      const wanted = arg.slice('--with='.length).split(',').map(s => s.trim())
      const valid = ['r2', 'transcode']
      const bad = wanted.filter(w => !valid.includes(w))
      if (bad.length > 0) {
        return { error: `unknown feature(s): ${bad.join(', ')}. Valid: ${valid.join(', ')}` }
      }
      opts.features = new Set(wanted as Array<'r2' | 'transcode'>)
    }
    else if (arg.startsWith('--only=')) {
      const wanted = arg.slice('--only='.length).split(',').map(s => s.trim())
      const bad = wanted.filter(w => !STEPS.includes(w as Step))
      if (bad.length > 0) {
        return { error: `unknown step(s): ${bad.join(', ')}. Valid: ${STEPS.join(', ')}` }
      }
      opts.steps = new Set(wanted as Step[])
    } else if (arg.startsWith('--state=')) opts.statePath = arg.slice('--state='.length)
    else if (arg.startsWith('--config=')) opts.wranglerPath = arg.slice('--config='.length)
    else return { error: `unrecognised argument: ${arg}` }
  }
  return opts
}

const HELP = `
npm run setup — provision a Terraviz node (docs/SELF_HOSTING.md)

  npm run setup                     Plan only. Writes nothing.
  npm run setup -- --apply          Run the default steps.

Steps (default run: ${DEFAULT_STEPS.join(', ')})
  pages          Phase 5     Pages project + custom domain
  resources      Phase 2     D1, KV x2, R2, Vectorize + metadata indexes
  wrangler-toml  Phase 3     repoint the resource ids
  migrations     Phase 4     both migration sets, in the order that works
  access         Phase 6     Access app, policies, service token
  secrets        Phase 7     generate PREVIEW_SIGNING_KEY
  bindings       Phase 8     every binding, both environments
  r2             Phase 13.1  CORS policy + public bucket domain   [opt-in]
  waf            Phase 13.2  transcode + feedback skip rules      [opt-in]

r2 and waf are opt-in via --only. waf rewrites the zone's custom-rule
list (the rulesets API replaces rather than appends), so it is something
you ask for rather than something that happens on the way past.

Guided setup
  -i, --interactive       Ask for the values it can't discover, with
                          instructions for where each one comes from, and
                          validate each answer before accepting it.
  --manual                Print the prerequisites no API can do for you
                          (Workers Paid, DNS, Zero Trust, the API token)
                          with click-by-click instructions, and exit.
  --with=<features>       Include optional features in the interview and
                          the handoff report: r2, transcode.

Options
  --apply                 Actually make changes. Off by default.
  --only=<steps>          Comma-separated subset of: ${STEPS.join(', ')}
  --local-migrations      Apply migrations to the local .wrangler/ DB
                          instead of --remote. Useful for a dry run.
  --github-secrets        Print the \`gh secret set\` script and exit.
  --state=<path>          State file (default .terraviz-setup.json)
  --config=<path>         Wrangler config (default wrangler.toml)

Environment
  CLOUDFLARE_ACCOUNT_ID          Required by the access and bindings steps.
  CLOUDFLARE_API_TOKEN           Required by the access and bindings steps.
                                 Needs Account -> Cloudflare Pages -> Edit,
                                 Access: Apps and Policies -> Edit,
                                 Access: Service Tokens -> Edit, and
                                 Access: Organizations -> Read.
  CLOUDFLARE_PAGES_PROJECT_NAME  Defaults to the state file's value.
  TERRAVIZ_HOSTNAME              Your public host, e.g. terraviz.your-org.org.
                                 Without it only *.pages.dev is gated.
  TERRAVIZ_STAFF_EMAIL_DOMAIN    Email domain for the Allow policy, e.g.
                                 your-org.org. Without it no human can sign in.
  TERRAVIZ_ACCESS_APP_NAME       Defaults to "Terraviz Publisher".
  TERRAVIZ_SERVICE_TOKEN_NAME    Defaults to "terraviz-cli".
  ACCESS_TEAM_DOMAIN, ACCESS_AUD, TRUSTED_PUBLISHER_DOMAINS,
  R2_PUBLIC_BASE, GITHUB_OWNER, GITHUB_REPO
                                 Optional; set the matching binding when present.
                                 The access step discovers the first two.

Secrets are read from the environment first, then from .dev.vars, and only
for names the binding manifest declares as secrets. Their values are never
logged and never written to the state file. The one exception is the service
token secret, which Cloudflare returns exactly once at creation -- it is
printed once, and you must save it.

Prerequisites this tool cannot do for you (see docs/SELF_HOSTING.md):
  Phase 0  Cloudflare account, Workers Paid, domain on Cloudflare DNS
  Phase 5  connecting the Pages project to a Git remote (OAuth, no API)
  Phase 6.1 Zero Trust onboarding + an identity provider
  Phase 13.1 minting the R2 S3 API token (needs a token that mints tokens)
  Phase 7  npm run gen:node-key (owns the node keypair)
  Phase 11 the first SSO sign-in
`

/**
 * Read secret values for manifest-declared secrets only.
 *
 * The allowlist matters: `.dev.vars` also carries `DEV_BYPASS_ACCESS`
 * and the `MOCK_*` flags, and pushing those to a production Pages
 * environment would disable Access authentication on the publisher
 * API. Reading strictly by manifest name makes that unexpressible.
 */
export function collectSecrets(
  env: Record<string, string | undefined>,
  devVars: string | null,
): SecretSource {
  const names = EXPECTED_BINDINGS.filter(b => b.type === 'secret').map(b => b.name)
  const out: Record<string, string> = {}
  const fromFile = devVars ? parseDotEnv(devVars) : {}
  for (const name of names) {
    const value = env[name] ?? fromFile[name]
    if (value) out[name] = value
  }
  return out
}

/** Minimal dotenv parse — `KEY=value`, `#` comments, optional quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    if (value) out[key] = value
  }
  return out
}

export async function runSetup(deps: SetupDeps): Promise<number> {
  const parsed = parseArgs(deps.argv)
  if ('error' in parsed) {
    deps.stderr.write(`setup: ${parsed.error}\n${HELP}`)
    return 2
  }
  const opts = parsed
  if (opts.help) {
    deps.stdout.write(HELP)
    return 0
  }

  // Node is the one prerequisite this tool can check for certain — it
  // is running on it. The pre-flight sheet says "setup will catch
  // this", so it has to actually catch it rather than trust that a
  // reader saw the prose above the checklist.
  const node = checkNodeVersion(deps.nodeVersion ?? process.version)
  if (!node.ok) {
    deps.stderr.write(
      `setup: Node ${node.found} is too old — this repo needs ${requiredNodeLabel()}.\n` +
        `       Install the LTS build from ${NODE_DOWNLOAD_URL}, then run this again.\n`,
    )
    return 2
  }

  // ── State ───────────────────────────────────────────────────────
  let stateForSecrets = hydrateState(
    deps.exists(opts.statePath) ? safeJson(deps.readFile(opts.statePath)) : null,
  )
  stateForSecrets = applyEnvOverrides(stateForSecrets, deps.env)

  if (opts.githubSecrets) {
    const repo =
      stateForSecrets.githubOwner && stateForSecrets.githubRepo
        ? `${stateForSecrets.githubOwner}/${stateForSecrets.githubRepo}`
        : undefined
    const available = new Set(
      Object.entries(deps.env)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => k),
    )
    deps.stdout.write(renderGithubSecretsScript({ repo, available }) + '\n')
    return 0
  }

  if (opts.manual) {
    deps.stdout.write(renderManualSteps(opts.features))
    return 0
  }

  let state = hydrateState(
    deps.exists(opts.statePath) ? safeJson(deps.readFile(opts.statePath)) : null,
  )
  state = applyEnvOverrides(state, deps.env)

  const persist = (): void => {
    if (opts.apply) deps.writeFile(opts.statePath, serialiseState(state))
  }

  // ── Interview ───────────────────────────────────────────────────
  if (opts.interactive) {
    const prompter = deps.prompter ?? new NonInteractivePrompter(deps.stdout.write)
    const pending = pendingQuestions(state, deps.env, { features: opts.features })

    prompter.say(
      '\nTerraviz node setup — interactive\n\n' +
        'This asks only for values it cannot discover, explains where each\n' +
        'one comes from, and checks the shape before accepting it. Nothing\n' +
        'is written until you confirm at the end.\n\n' +
        'Run `npm run setup -- --manual` for the prerequisites no API can\n' +
        'do for you (Workers Paid, DNS, Zero Trust, the API token).\n\n',
    )

    if (pending.length === 0) {
      prompter.say('Everything is already answered — nothing to ask.\n\n')
    }

    for (const [index, question] of pending.entries()) {
      prompter.say(`\n[${index + 1}/${pending.length}] ${question.label}\n`)
      const answer = await prompter.ask(question)
      if (answer === null) {
        if (!question.optional) {
          prompter.say(
            `    skipped — set ${question.envVar} and re-run, or answer next time\n`,
          )
        }
        continue
      }
      state = applyAnswer(state, question.key, answer)
      // Persist as we go: an interview abandoned halfway should not
      // have to be repeated from the top.
      if (opts.apply) deps.writeFile(opts.statePath, serialiseState(state))
    }

    // Answers are worth keeping even on a plan run — the whole point
    // of the interview is that you only answer once. Announced rather
    // than silent, because "plan mode writes nothing" is otherwise the
    // promise this makes an exception to.
    if (!opts.apply) {
      deps.writeFile(opts.statePath, serialiseState(state))
      prompter.say(`\n  Answers saved to ${opts.statePath}.\n`)
    }

    if (!apiToken(deps.env)) {
      prompter.say(
        '\n  ! CLOUDFLARE_API_TOKEN is not set in this shell.\n' +
          '    Everything that talks to Cloudflare needs it. See\n' +
          '    `npm run setup -- --manual` step 3 for the permission list.\n',
      )
    }

    if (opts.apply) {
      prompter.say('\n')
      const go = await prompter.confirm(
        'Apply these changes to your Cloudflare account?',
        false,
      )
      if (!go) {
        prompter.say('  Nothing applied. Answers saved — re-run when ready.\n')
        prompter.close()
        return 0
      }
    }
    prompter.close()
    deps.stdout.write('\n')
  }

  const mode = opts.apply ? 'APPLY' : 'PLAN (no changes — pass --apply to execute)'
  deps.stdout.write(`Terraviz node setup — ${mode}\n`)
  deps.stdout.write(`  state:   ${opts.statePath}\n`)
  deps.stdout.write(`  project: ${state.pagesProject}\n\n`)

  // Only known once the pages step has actually looked; undefined
  // means "we never checked", which the handoff report words
  // differently from either answer.
  let gitConnected: boolean | undefined

  // ── Step: pages ─────────────────────────────────────────────────
  if (opts.steps.has('pages')) {
    deps.stdout.write('── Phase 5 — Pages project ─────────────────────────\n')
    if (!opts.apply) {
      deps.stdout.write(
        `  would ensure project  ${state.pagesProject} (production branch main)\n` +
          (state.hostname
            ? `  would ensure domain   ${state.hostname}\n\n`
            : '  ! TERRAVIZ_HOSTNAME unset — no custom domain will be attached\n\n'),
      )
    } else {
      const token = apiToken(deps.env)
      if (!token || !state.accountId) {
        deps.stderr.write(
          '  ✘ CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.\n' +
            '    The token needs Account → Cloudflare Pages → Edit.\n\n',
        )
        return 2
      }
      const api = new PagesProjectApi(state.accountId, {
        apiToken: token,
        fetchImpl: deps.fetchImpl,
      })
      try {
        const res = await ensurePagesProject(api, { name: state.pagesProject })
        gitConnected = res.gitConnected
        deps.stdout.write(`  project  ${res.project.name}  ${verb(res.created)}\n`)
        if (!res.gitConnected) {
          deps.stdout.write(
            '  ! Direct Upload project — Cloudflare will NOT run your build.\n' +
              '    The Git connection is an OAuth handshake with no API; connect it\n' +
              '    in the dashboard, or deploy from CI with `wrangler pages deploy dist/`.\n' +
              '    Either way the VITE_* build variables must be set wherever the\n' +
              '    build actually runs (Phase 5.2).\n',
          )
        }
        if (state.hostname) {
          const domain = await ensureCustomDomain(api, state.pagesProject, state.hostname)
          deps.stdout.write(
            `  domain   ${domain.name}  ${verb(domain.created)}` +
              `${domain.status ? ` (${domain.status})` : ''}\n`,
          )
        }
        deps.stdout.write('\n')
      } catch (e) {
        deps.stderr.write(`  ✘ ${errText(e)}\n\n`)
        return 1
      }
    }
  }

  // ── Step: resources ─────────────────────────────────────────────
  if (opts.steps.has('resources')) {
    deps.stdout.write('── Phase 2 — Cloudflare resources ──────────────────\n')
    if (!opts.apply) {
      deps.stdout.write(
        `  would ensure D1        ${state.d1.name}${idNote(state.d1.id)}\n` +
          `  would ensure KV        ${state.telemetryKv.name}${idNote(state.telemetryKv.id)}\n` +
          `  would ensure KV        ${state.catalogKv.name}${idNote(state.catalogKv.id)}\n` +
          `  would ensure R2        ${state.r2Bucket.name}\n` +
          `  would ensure Vectorize ${state.vectorizeIndex.name} (768/cosine)\n` +
          `  would ensure metadata  ${VECTORIZE_METADATA_PROPERTIES.join(', ')}\n` +
          '  Analytics Engine       no action — the dataset is created on first write\n' +
          '                         (enable the product once in the dashboard, or\n' +
          '                          the Phase 8.8 deploy fails to publish)\n\n',
      )
    } else {
      try {
        const d1 = await ensureD1(deps.runner, state.d1.name)
        state.d1.id = d1.id
        persist()
        deps.stdout.write(`  D1        ${state.d1.name}  ${verb(d1.created)} (${d1.id})\n`)

        const tel = await ensureKv(deps.runner, state.telemetryKv.name)
        state.telemetryKv.id = tel.id
        persist()
        deps.stdout.write(
          `  KV        ${state.telemetryKv.name}  ${verb(tel.created)} (${tel.id})\n`,
        )

        const cat = await ensureKv(deps.runner, state.catalogKv.name)
        state.catalogKv.id = cat.id
        persist()
        deps.stdout.write(
          `  KV        ${state.catalogKv.name}  ${verb(cat.created)} (${cat.id})\n`,
        )

        const r2 = await ensureR2Bucket(deps.runner, state.r2Bucket.name)
        deps.stdout.write(`  R2        ${state.r2Bucket.name}  ${verb(r2.created)}\n`)

        const vec = await ensureVectorizeIndex(deps.runner, state.vectorizeIndex.name)
        deps.stdout.write(
          `  Vectorize ${state.vectorizeIndex.name}  ${verb(vec.created)}\n`,
        )
        const meta = await ensureVectorizeMetadata(
          deps.runner,
          state.vectorizeIndex.name,
          VECTORIZE_METADATA_PROPERTIES,
        )
        state.vectorizeMetadata = [...meta.created, ...meta.existing]
        persist()
        deps.stdout.write(
          `  metadata  ${state.vectorizeMetadata.join(', ')}  ` +
            `(${meta.created.length} created, ${meta.existing.length} existing)\n\n`,
        )
      } catch (e) {
        deps.stderr.write(`\n  ✘ ${errText(e)}\n\n`)
        return 1
      }
    }
  }

  // ── Step: wrangler.toml ─────────────────────────────────────────
  if (opts.steps.has('wrangler-toml')) {
    deps.stdout.write('── Phase 3 — repoint wrangler.toml ─────────────────\n')
    if (!deps.exists(opts.wranglerPath)) {
      deps.stderr.write(`  ✘ ${opts.wranglerPath} not found\n\n`)
      return 1
    }
    const source = deps.readFile(opts.wranglerPath)
    const result = repointWranglerToml(source, {
      d1DatabaseId: state.d1.id,
      telemetryKvId: state.telemetryKv.id,
      catalogKvId: state.catalogKv.id,
      d1DatabaseName: state.d1.name,
      r2BucketName: state.r2Bucket.name,
      vectorizeIndexName: state.vectorizeIndex.name,
      analyticsDataset: state.analyticsDataset.name,
    })
    if (result.unmatched.length > 0) {
      deps.stderr.write(
        `  ! no block found for: ${result.unmatched.join(', ')} — ` +
          'wrangler.toml has drifted from what this tool expects\n',
      )
    }
    if (result.changes.length === 0) {
      const pinned = stillPinnedUpstream(source)
      if (pinned.length > 0) {
        // On a fresh clone this is the expected state, so in plan
        // mode it is information, not an error — the operator wants
        // to see the rest of the plan. Under --apply it is fatal:
        // leaving upstream IDs in place aims `d1 migrations apply` at
        // a database the operator does not own.
        const message =
          `still pinned to upstream: ${pinned.join(', ')}\n` +
          '    Resource IDs are not known yet — run the resources step first.\n\n'
        if (opts.apply) {
          deps.stderr.write(`  ✘ ${message}`)
          return 1
        }
        deps.stdout.write(`  ! ${message}`)
      } else {
        deps.stdout.write('  already correct — no changes\n\n')
      }
    } else {
      for (const c of result.changes) {
        deps.stdout.write(
          `  ${opts.apply ? 'set ' : 'would set '}${c.binding}.${c.key} ` +
            `${short(c.from)} → ${short(c.to)}  (line ${c.line})\n`,
        )
      }
      if (opts.apply) deps.writeFile(opts.wranglerPath, result.text)
      deps.stdout.write('\n')
    }
  }

  // ── Step: migrations ────────────────────────────────────────────
  if (opts.steps.has('migrations')) {
    const target = opts.localMigrations ? '--local' : '--remote'
    deps.stdout.write(`── Phase 4 — migrations (${target}) ─────────────────\n`)
    if (!opts.apply) {
      deps.stdout.write(
        '  would apply CATALOG_DB   (migrations/catalog/)\n' +
          '  would apply FEEDBACK_DB  (migrations/)\n\n',
      )
    } else {
      // The order used to matter: the generated catalog snapshot lived
      // in FEEDBACK_DB's migrations dir, so running that binding first
      // on a fresh database applied the whole catalog schema outside
      // the migration tracker. The snapshot now lives in `schema/`,
      // the two migration sets are disjoint, and either order works.
      for (const binding of ['CATALOG_DB', 'FEEDBACK_DB'] as const) {
        const res = await applyMigrations(deps.runner, binding, !opts.localMigrations)
        if (res.code === 0) {
          deps.stdout.write(`  ${binding}  applied\n`)
          continue
        }
        deps.stderr.write(
          `  ✘ ${binding}: ${(res.stderr || res.stdout).trim().slice(0, 400)}\n\n`,
        )
        return 1
      }
      deps.stdout.write('\n')
    }
  }

  // `.dev.vars` is read once and threaded through the secrets and
  // bindings steps. Re-reading after the secrets step wrote it would
  // work on disk but makes the two steps implicitly coupled through
  // the filesystem, which is exactly the sort of ordering dependency
  // this tool exists to remove.
  let devVarsText: string | null = deps.exists(opts.devVarsPath)
    ? deps.readFile(opts.devVarsPath)
    : null

  // ── Step: access ────────────────────────────────────────────────
  if (opts.steps.has('access')) {
    deps.stdout.write('── Phase 6 — Cloudflare Access ─────────────────────\n')
    const appName = state.accessAppName ?? DEFAULT_NAMES.accessApp
    const tokenName = state.serviceTokenName ?? DEFAULT_NAMES.serviceToken
    const pagesHost = `${state.pagesProject}.pages.dev`
    const destinations = state.hostname
      ? publisherDestinations(state.hostname, pagesHost)
      : publisherDestinations(pagesHost)

    if (!state.hostname) {
      deps.stdout.write(
        '  ! TERRAVIZ_HOSTNAME is unset — only the *.pages.dev host will be\n' +
          '    gated. Set it and re-run to cover your custom domain.\n',
      )
    }

    if (!opts.apply) {
      deps.stdout.write(`  would ensure application  ${appName}\n`)
      for (const d of destinations) deps.stdout.write(`    destination  ${d}\n`)
      deps.stdout.write(
        `  would ensure policy       Staff (Allow, emails ending in ` +
          `${state.staffEmailDomain ?? '<TERRAVIZ_STAFF_EMAIL_DOMAIN unset>'})\n` +
          `  would ensure policy       Automation (Service Auth)\n` +
          `  would ensure token        ${tokenName}\n\n`,
      )
    } else {
      const token = apiToken(deps.env)
      if (!token || !state.accountId) {
        deps.stderr.write(
          '  ✘ CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.\n' +
            '    The token needs Access: Apps and Policies → Edit and\n' +
            '    Access: Service Tokens → Edit.\n\n',
        )
        return 2
      }
      const api = new AccessApi({
        apiToken: token,
        accountId: state.accountId,
        fetchImpl: deps.fetchImpl,
      })
      try {
        const teamDomain = await api.getTeamDomain()
        if (!teamDomain) {
          // Narrow by construction: getTeamDomain() returns null only
          // for a 404 (or an org with no auth domain) and rethrows
          // everything else, so this is no longer the catch-all it
          // once was and does not have to hedge about permissions.
          deps.stderr.write(
            '  ✘ this account has no Zero Trust team domain yet.\n' +
              '    Onboard Zero Trust once in the dashboard — Phase 6.1 —\n' +
              '    then re-run. (A token missing Access: Organizations →\n' +
              '    Read reports itself as an API error, not as this.)\n\n',
          )
          return 1
        }
        state.accessTeamDomain = teamDomain
        persist()
        deps.stdout.write(`  team domain  ${teamDomain}\n`)

        const { app, created } = await ensureAccessApplication(api, {
          name: appName,
          destinations,
        })
        state.accessAppId = app.id
        state.accessAppName = app.name
        state.accessAud = app.aud
        persist()
        deps.stdout.write(`  application  ${app.name}  ${verb(created)} (aud ${app.aud})\n`)

        const tok = await ensureServiceToken(api, tokenName)
        state.serviceTokenId = tok.id
        state.serviceTokenName = tok.name
        state.serviceTokenClientId = tok.clientId
        persist()
        deps.stdout.write(`  token        ${tok.name}  ${verb(tok.created)}\n`)

        const policies = await ensurePolicies(api, app.id, {
          emailDomain: state.staffEmailDomain,
          serviceTokenId: tok.id,
        })
        deps.stdout.write(
          `  policies     ${[...policies.created, ...policies.existing].join(', ') || '(none)'}` +
            `  (${policies.created.length} created)\n`,
        )
        if (!state.staffEmailDomain) {
          deps.stdout.write(
            '  ! no Staff policy — set TERRAVIZ_STAFF_EMAIL_DOMAIN and re-run,\n' +
              '    or add the Allow policy by hand. Without it no human can sign in.\n',
          )
        }

        // Printed once, never persisted, never re-retrievable.
        if (tok.created && tok.clientSecret) {
          deps.stdout.write(
            '\n  ┌─ Service token — Cloudflare shows the secret ONCE ─────────\n' +
              '  │ Save these now (password manager, and as GitHub repo secrets\n' +
              '  │ CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET for Phase 13.2).\n' +
              '  │\n' +
              `  │ export CF_ACCESS_CLIENT_ID=${tok.clientId ?? '(missing)'}\n` +
              `  │ export CF_ACCESS_CLIENT_SECRET=${tok.clientSecret}\n` +
              '  └────────────────────────────────────────────────────────────\n\n',
          )
        } else if (!tok.created) {
          deps.stdout.write(
            '  ! adopted an existing token, so its secret is not recoverable —\n' +
              '    Cloudflare only returns it at creation. Use the value you saved,\n' +
              '    or delete the token in Zero Trust and re-run to mint a new one.\n\n',
          )
        }
      } catch (e) {
        deps.stderr.write(`  ✘ ${errText(e)}\n\n`)
        return 1
      }
    }
  }

  // ── Step: secrets ───────────────────────────────────────────────
  if (opts.steps.has('secrets')) {
    deps.stdout.write('── Phase 7 — node secrets ──────────────────────────\n')
    const result = ensureSecrets(devVarsText)
    for (const o of result.outcomes) {
      const label =
        o.status === 'present' ? 'present  ' : o.status === 'generated' ? 'generated' : 'MANUAL   '
      deps.stdout.write(`  ${label}  ${o.name}${o.action ? `  — ${o.action}` : ''}\n`)
    }
    if (result.text !== null) {
      if (opts.apply) {
        deps.writeFile(opts.devVarsPath, result.text)
        deps.stdout.write(`  wrote ${opts.devVarsPath}\n`)
      } else {
        deps.stdout.write(`  would write ${opts.devVarsPath}\n`)
      }
      // Thread the new text through so the bindings step below can
      // push the freshly-generated key in the same run.
      if (opts.apply) devVarsText = result.text
    }
    deps.stdout.write('\n')
  }

  // ── Step: bindings ──────────────────────────────────────────────
  if (opts.steps.has('bindings')) {
    deps.stdout.write('── Phase 8 — Pages bindings (Production + Preview) ──\n')
    const devVars = devVarsText
    const secrets = collectSecrets(deps.env, devVars)
    const plan = planBindings(state, secrets, [...EXPECTED_BINDINGS, ...OPTIONAL_EXTRAS])
    deps.stdout.write(formatBindingsPlan(plan) + '\n\n')

    // R2 / Vectorize / Analytics Engine / AI bindings address their
    // resource by name, so they "resolve" from defaults even on a
    // completely fresh state. Only the D1 and KV IDs prove the
    // resources step actually ran. Writing the name-based half alone
    // would leave a deploy that looks wired and isn't — exactly the
    // half-configured state this tool exists to prevent — so require
    // the IDs before touching a live project.
    const unresolvedIds = [
      state.d1.id ? null : 'D1',
      state.telemetryKv.id ? null : 'TELEMETRY_KILL_SWITCH',
      state.catalogKv.id ? null : 'CATALOG_KV',
    ].filter((x): x is string => x !== null)

    if (opts.apply && unresolvedIds.length > 0) {
      deps.stderr.write(
        `  ✘ no resource ID for: ${unresolvedIds.join(', ')}\n` +
          '    Run the resources step first, or fill the IDs into ' +
          `${opts.statePath} by hand.\n\n`,
      )
      return 1
    }

    if (opts.apply) {
      const token = apiToken(deps.env)
      const accountId = state.accountId
      if (!token || !accountId) {
        deps.stderr.write(
          '  ✘ CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required to write bindings.\n' +
            '    The token needs Account → Cloudflare Pages → Edit.\n\n',
        )
        return 2
      }
      const writer = new PagesProjectWriter({
        apiToken: token,
        accountId,
        projectName: state.pagesProject,
        fetchImpl: deps.fetchImpl,
      })
      try {
        await writer.patchBindings(buildPatchBody(plan))
      } catch (e) {
        deps.stderr.write(`  ✘ ${errText(e)}\n\n`)
        return 1
      }
      state.lastAppliedAt = new Date().toISOString()
      persist()
      deps.stdout.write(
        `  wrote ${plan.resolved.length} binding(s) to both environments\n\n`,
      )
    }

    if (plan.skipped.length > 0) {
      deps.stdout.write(
        `  ${plan.skipped.length} binding(s) left unset — these are the manual\n` +
          '  pieces (Access values from Phase 6, secrets from Phase 7, and the\n' +
          '  Phase 13 add-ons). Re-run once you have them.\n\n',
      )
    }
  }

  // ── Step: r2 ────────────────────────────────────────────────────
  if (opts.steps.has('r2')) {
    deps.stdout.write('── Phase 13.1 — R2 public domain + CORS ────────────\n')
    const site = state.hostname ? `https://${state.hostname}` : null
    if (!site) {
      deps.stderr.write(
        '  ✘ TERRAVIZ_HOSTNAME is required — the CORS policy is built from\n' +
          '    your site origin, and guessing it would silently block uploads.\n\n',
      )
      return 2
    }
    const rules = buildCorsRules({ site, includeLocalhost: true, includeTauri: true })
    const publicDomain = state.r2PublicBase?.replace(/^https?:\/\//, '')

    if (!opts.apply) {
      deps.stdout.write(
        `  would set CORS on  ${state.r2Bucket.name}\n` +
          `    read   ${rules[0].allowed.methods.join('/')} from ` +
          `${rules[0].allowed.origins.join(', ')}\n` +
          `    write  ${rules[1].allowed.methods.join('/')} from ` +
          `${rules[1].allowed.origins.join(', ')}\n` +
          (publicDomain
            ? `  would attach domain  ${publicDomain}\n\n`
            : '  ! R2_PUBLIC_BASE unset — no public domain will be attached\n\n'),
      )
    } else {
      const token = apiToken(deps.env)
      if (!token || !state.accountId) {
        deps.stderr.write(
          '  ✘ CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required.\n' +
            '    The token needs Workers R2 Storage → Edit and Zone → Read.\n\n',
        )
        return 2
      }
      const api = new R2ConfigApi(state.accountId, {
        apiToken: token,
        fetchImpl: deps.fetchImpl,
      })
      try {
        await api.putCors(state.r2Bucket.name, rules)
        deps.stdout.write(`  CORS     applied to ${state.r2Bucket.name}\n`)
      } catch (e) {
        // The dashboard's JSON editor takes a different encoding of
        // the same policy, so a failed call still leaves the operator
        // with something they can paste rather than re-derive.
        deps.stderr.write(
          `  ✘ CORS: ${errText(e)}\n\n` +
            '  Paste this into R2 → bucket → Settings → CORS policy instead:\n' +
            JSON.stringify(toDashboardJson(rules), null, 2) +
            '\n\n',
        )
        return 1
      }
      if (publicDomain) {
        try {
          const res = await ensureR2CustomDomain(api, state.r2Bucket.name, publicDomain)
          deps.stdout.write(`  domain   ${res.domain}  ${verb(res.created)}\n\n`)
        } catch (e) {
          deps.stderr.write(`  ✘ ${errText(e)}\n\n`)
          return 1
        }
      } else {
        deps.stdout.write(
          '  ! R2_PUBLIC_BASE unset — set it and re-run to attach a public\n' +
            '    domain. Without one, R2-hosted assets do not resolve.\n\n',
        )
      }
    }
  }

  // ── Step: waf ───────────────────────────────────────────────────
  if (opts.steps.has('waf')) {
    deps.stdout.write('── Phase 13.2 / 13.3 — WAF skip rules ──────────────\n')
    const wanted = [buildTranscodeRule(), buildFeedbackRule()]
    if (!state.hostname) {
      deps.stderr.write(
        '  ✘ TERRAVIZ_HOSTNAME is required to resolve the zone.\n\n',
      )
      return 2
    }
    if (!opts.apply) {
      for (const rule of wanted) {
        deps.stdout.write(`  would add  ${rule.description}\n`)
      }
      deps.stdout.write(
        '  Existing custom rules are preserved — new rules are appended last.\n\n',
      )
    } else {
      const token = apiToken(deps.env)
      if (!token) {
        deps.stderr.write(
          '  ✘ CLOUDFLARE_API_TOKEN is required (Zone → Zone WAF → Edit).\n\n',
        )
        return 2
      }
      try {
        const zones = await new CfApi({
          apiToken: token,
          fetchImpl: deps.fetchImpl,
        }).requireResult<Array<{ id: string; name?: string }>>('/zones?per_page=200')
        const zone = matchZone(zones, state.hostname)
        if (!zone) {
          deps.stderr.write(
            `  ✘ no Cloudflare zone on this account matches ${state.hostname}\n\n`,
          )
          return 1
        }
        const waf = new WafApi(zone.id, { apiToken: token, fetchImpl: deps.fetchImpl })
        const res = await ensureWafRules(waf, wanted, true)
        deps.stdout.write(
          `  zone     ${zone.name} (${res.existing} existing rule(s) preserved)\n` +
            (res.added.length
              ? res.added.map(d => `  added    ${d}\n`).join('')
              : '  nothing to add — both rules already present\n') +
            '\n',
        )
      } catch (e) {
        deps.stderr.write(`  ✘ ${errText(e)}\n\n`)
        return 1
      }
    }
  }

  // ── Next steps ──────────────────────────────────────────────────
  // ── Handoff ─────────────────────────────────────────────────────
  // The values that have to go somewhere this tool cannot reach. A
  // provisioner that stops at "done" leaves the most forgettable part
  // of an install undocumented.
  deps.stdout.write(
    renderHandoff(
      buildHandoff(state, {
        features: opts.features,
        gitConnected,
        available: new Set(
          Object.entries(deps.env)
            .filter(([, v]) => Boolean(v))
            .map(([k]) => k),
        ),
      }),
    ),
  )

  if (opts.apply) {
    const host = state.hostname ? `https://${state.hostname}` : 'https://<your-host>'
    deps.stdout.write(
      'Next:\n' +
        '  1. Redeploy — bindings take effect on the next deployment, not immediately.\n' +
        '  2. npm run check:pages-bindings      (audits what we just wrote)\n' +
        '  3. Provision the node identity (Phase 9), with the service token:\n' +
        '       npm run terraviz -- init-node \\\n' +
        `           --server ${host} \\\n` +
        '           --client-id "$CF_ACCESS_CLIENT_ID" \\\n' +
        '           --client-secret "$CF_ACCESS_CLIENT_SECRET" \\\n' +
        '           --display-name "..." --base-url ' + host + '\n' +
        `  4. npm run terraviz -- verify-deploy --server ${host}\n`,
    )
  } else {
    deps.stdout.write('Re-run with --apply to execute.\n')
  }
  return 0
}

// ── helpers ───────────────────────────────────────────────────────

function idNote(id: string | undefined): string {
  return id ? `  (known: ${id})` : '  (id unknown — will resolve)'
}
function verb(created: boolean): string {
  return created ? 'created ' : 'adopted '
}
function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 8)}…` : s || '(empty)'
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Real wrangler execution. Never inherits stdio — output is parsed. */
export const wranglerRunner: CommandRunner = argv =>
  new Promise<CommandResult>(res => {
    execFile(
      'npx',
      ['wrangler', ...argv],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0
        res({ code, stdout: String(stdout), stderr: String(stderr) })
      },
    )
  })

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

/**
 * Build the real prompter, or a non-blocking stub when there is no
 * terminal. `mute` swaps stdout's write so a secret answer is read
 * without echo — see prompt.ts for why it is not asterisk-masked.
 */
async function createPrompter(interactive: boolean): Promise<Prompter> {
  if (!interactive || !process.stdin.isTTY) {
    return new NonInteractivePrompter(s => process.stdout.write(s))
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let muted = false
  const original = process.stdout.write.bind(process.stdout)
  ;(process.stdout as unknown as { write: (c: string) => boolean }).write = (chunk: string) =>
    muted ? true : original(chunk)
  return new InteractivePrompter(
    rl,
    { write: (chunk: string) => original(chunk) },
    on => void (muted = on),
  )
}

if (isMain) {
  const wantsInteractive =
    process.argv.includes('--interactive') || process.argv.includes('-i')
  if (wantsInteractive && !process.stdin.isTTY) {
    process.stderr.write(
      'setup: --interactive needs a terminal. Set the values as environment\n' +
        'variables instead (npm run setup -- --help lists them).\n',
    )
    process.exit(2)
  }
  const code = await runSetup({
    prompter: await createPrompter(wantsInteractive),
    argv: process.argv.slice(2),
    env: process.env as SetupEnv & Record<string, string | undefined>,
    stdout: { write: s => process.stdout.write(s) },
    stderr: { write: s => process.stderr.write(s) },
    runner: wranglerRunner,
    readFile: p => readFileSync(resolve(p), 'utf-8'),
    writeFile: (p, c) => writeFileSync(resolve(p), c, 'utf-8'),
    exists: p => existsSync(resolve(p)),
  })
  process.exit(code)
}
