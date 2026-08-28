// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages REST API client for the bindings audit.
 *
 * Pure data-shape mapping: fetches `GET /accounts/{account_id}/pages/
 * projects/{project_name}` and shells the response into the
 * `EnvironmentBindings` shape the diff function consumes. The
 * heavy lifting (per-environment expected vs actual) lives in
 * `diffBindings` so the test suite can drive it with a stubbed
 * source.
 *
 * Why REST and not Wrangler? Wrangler exposes `pages project list /
 * create / delete` but has no `project info` for the deployment
 * configs that carry binding-level data. The dashboard's "Variables
 * and Bindings" tab reads from this same REST endpoint, so the
 * script's view matches what an operator sees in the dashboard.
 *
 * Required environment for the live source:
 *   - CLOUDFLARE_API_TOKEN — a token scoped to "Pages → Read" for
 *     this account. Mint via My Profile → API Tokens → Create
 *     Custom Token. Deliberately read-only — the script only audits.
 *   - CLOUDFLARE_ACCOUNT_ID — the account holding the project.
 *   - CLOUDFLARE_PAGES_PROJECT_NAME — defaults to `terraviz`.
 */

import type {
  BindingType,
  Environment,
  ExpectedBinding,
} from './expected-bindings.ts'

export interface EnvironmentBindings {
  plaintext: Set<string>
  secret: Set<string>
  d1: Set<string>
  kv: Set<string>
  r2: Set<string>
  vectorize: Set<string>
  ai: Set<string>
  analytics_engine: Set<string>
}

export interface ProjectBindings {
  production: EnvironmentBindings
  preview: EnvironmentBindings
}

export interface PagesProjectSource {
  /** Resolves to the project's per-environment binding view. */
  fetchProject(): Promise<ProjectBindings>
}

export type DiffStatus =
  | 'present'
  | 'missing'
  | 'unexpected'
  | 'wrong_type'

export interface DiffEntry {
  name: string
  type: BindingType
  environment: Environment
  status: DiffStatus
  hint?: string
}

function emptyEnv(): EnvironmentBindings {
  return {
    plaintext: new Set(),
    secret: new Set(),
    d1: new Set(),
    kv: new Set(),
    r2: new Set(),
    vectorize: new Set(),
    ai: new Set(),
    analytics_engine: new Set(),
  }
}

interface CfDeploymentConfig {
  env_vars?: Record<string, { value?: string | null; type?: string } | null>
  d1_databases?: Record<string, unknown>
  kv_namespaces?: Record<string, unknown>
  r2_buckets?: Record<string, unknown>
  vectorize_bindings?: Record<string, unknown>
  ai_bindings?: Record<string, unknown>
  analytics_engine_datasets?: Record<string, unknown>
}

interface CfProjectResponse {
  result?: {
    deployment_configs?: {
      production?: CfDeploymentConfig
      preview?: CfDeploymentConfig
    }
  }
  success?: boolean
  errors?: Array<{ message: string }>
}

/**
 * Pull the binding sets out of one environment's deployment_config.
 * Cloudflare's response uses an object map keyed by binding name;
 * we collect the keys into typed sets.
 *
 * env_vars carries both plaintext and secret entries — secrets show
 * up with a `type: "secret_text"` annotation, plaintext as
 * `type: "plain_text"` (or no type field on older entries). When the
 * value is `null`, the API has redacted it (always true for secrets
 * read by a non-edit token); we trust the type annotation.
 */
function shellEnvironment(config: CfDeploymentConfig | undefined): EnvironmentBindings {
  const out = emptyEnv()
  if (!config) return out

  for (const [name, entry] of Object.entries(config.env_vars ?? {})) {
    if (entry && entry.type === 'secret_text') out.secret.add(name)
    else out.plaintext.add(name)
  }
  for (const name of Object.keys(config.d1_databases ?? {})) out.d1.add(name)
  for (const name of Object.keys(config.kv_namespaces ?? {})) out.kv.add(name)
  for (const name of Object.keys(config.r2_buckets ?? {})) out.r2.add(name)
  for (const name of Object.keys(config.vectorize_bindings ?? {})) out.vectorize.add(name)
  for (const name of Object.keys(config.ai_bindings ?? {})) out.ai.add(name)
  for (const name of Object.keys(config.analytics_engine_datasets ?? {})) {
    out.analytics_engine.add(name)
  }
  return out
}

export interface RestApiSourceOptions {
  apiToken: string
  accountId: string
  projectName: string
  /** Test-friendly override for the global fetch. */
  fetchImpl?: typeof fetch
  /** Override for the API base; defaults to api.cloudflare.com. */
  apiBase?: string
}

export class RestApiSource implements PagesProjectSource {
  constructor(private readonly opts: RestApiSourceOptions) {}

  async fetchProject(): Promise<ProjectBindings> {
    const base = this.opts.apiBase ?? 'https://api.cloudflare.com/client/v4'
    const url =
      `${base}/accounts/${this.opts.accountId}/pages/projects/` +
      encodeURIComponent(this.opts.projectName)
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const res = await fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${this.opts.apiToken}`,
        Accept: 'application/json',
      },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `Cloudflare API ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
      )
    }
    let parsed: CfProjectResponse
    try {
      parsed = JSON.parse(text) as CfProjectResponse
    } catch {
      throw new Error(`Cloudflare API returned non-JSON: ${text.slice(0, 200)}`)
    }
    if (!parsed.success || !parsed.result) {
      const detail = parsed.errors?.map(e => e.message).join('; ') ?? 'unknown error'
      throw new Error(`Cloudflare API replied success=false: ${detail}`)
    }
    return {
      production: shellEnvironment(parsed.result.deployment_configs?.production),
      preview: shellEnvironment(parsed.result.deployment_configs?.preview),
    }
  }
}

const ALL_BINDING_TYPES: BindingType[] = [
  'plaintext',
  'secret',
  'd1',
  'kv',
  'r2',
  'vectorize',
  'ai',
  'analytics_engine',
]

/**
 * Pure diff: which expected bindings are missing in which
 * environment, and which actual bindings are present that aren't on
 * the expected list. The output is stable and table-friendly.
 *
 * Three failure modes:
 *
 *   - `missing` — expected binding absent in this environment.
 *   - `wrong_type` — a binding with the expected name exists, but
 *     under a different binding type. Common when an operator
 *     creates a plaintext env var named `CATALOG_VECTORIZE` (or
 *     similar) instead of the actual Vectorize binding. Pre-1f/N
 *     this surfaced as two unrelated rows (`missing` + `unexpected`)
 *     that the operator had to mentally correlate.
 *   - `unexpected` — a binding in this environment that isn't on
 *     the expected list. Not necessarily wrong — operators add
 *     their own (Stream API tokens, R2 access keys) — informational
 *     unless the run is invoked with --strict.
 */
export function diffBindings(
  expected: ExpectedBinding[],
  actual: ProjectBindings,
): DiffEntry[] {
  const out: DiffEntry[] = []
  const envs: Environment[] = ['production', 'preview']

  /** Names "claimed" as wrong_type in each (env, name) tuple, so the
   *  unexpected pass can suppress the corresponding actual entry
   *  (we'd otherwise emit `wrong_type` AND `unexpected` for the same
   *  binding name and confuse the operator further). */
  const claimedAsWrongType = new Set<string>()

  // Per-environment "missing" / "wrong_type" check. For each
  // expected binding we look in the bucket for its declared type
  // first; if present we emit `present`, if not we look across the
  // other buckets and either emit `wrong_type` (found under a
  // different type) or `missing` (genuinely absent).
  for (const exp of expected) {
    for (const env of envs) {
      if (!exp.environments.includes(env)) continue
      const correctBucket = bindingsForType(actual[env], exp.type)
      if (correctBucket.has(exp.name)) {
        out.push({ name: exp.name, type: exp.type, environment: env, status: 'present' })
        continue
      }
      const wrongType = ALL_BINDING_TYPES.find(
        t => t !== exp.type && bindingsForType(actual[env], t).has(exp.name),
      )
      if (wrongType !== undefined) {
        out.push({
          name: exp.name,
          type: exp.type,
          environment: env,
          status: 'wrong_type',
          hint:
            `Found as ${wrongType} but expected ${exp.type}. ` +
            (exp.hint ?? ''),
        })
        claimedAsWrongType.add(`${env}|${wrongType}|${exp.name}`)
        continue
      }
      out.push({
        name: exp.name,
        type: exp.type,
        environment: env,
        status: 'missing',
        hint: exp.hint,
      })
    }
  }

  // "Unexpected" pass — anything in actual that isn't on the
  // expected list AND wasn't already accounted for as wrong_type
  // above.
  const expectedKey = (b: ExpectedBinding, env: Environment) =>
    `${env}|${b.type}|${b.name}`
  const expectedSet = new Set<string>()
  for (const exp of expected) {
    for (const env of envs) {
      if (exp.environments.includes(env)) expectedSet.add(expectedKey(exp, env))
    }
  }
  for (const env of envs) {
    const a = actual[env]
    const allActual: Array<{ type: BindingType; names: Set<string> }> = [
      { type: 'plaintext', names: a.plaintext },
      { type: 'secret', names: a.secret },
      { type: 'd1', names: a.d1 },
      { type: 'kv', names: a.kv },
      { type: 'r2', names: a.r2 },
      { type: 'vectorize', names: a.vectorize },
      { type: 'ai', names: a.ai },
      { type: 'analytics_engine', names: a.analytics_engine },
    ]
    for (const { type, names } of allActual) {
      for (const name of names) {
        const key = `${env}|${type}|${name}`
        if (expectedSet.has(key)) continue
        if (claimedAsWrongType.has(key)) continue
        out.push({ name, type, environment: env, status: 'unexpected' })
      }
    }
  }
  return out
}

function bindingsForType(env: EnvironmentBindings, type: BindingType): Set<string> {
  switch (type) {
    case 'plaintext':
      return env.plaintext
    case 'secret':
      return env.secret
    case 'd1':
      return env.d1
    case 'kv':
      return env.kv
    case 'r2':
      return env.r2
    case 'vectorize':
      return env.vectorize
    case 'ai':
      return env.ai
    case 'analytics_engine':
      return env.analytics_engine
  }
}

/**
 * Format a diff entry list as a left-aligned plain-text table.
 * Operator-friendly output for the script's stdout.
 */
export function formatDiffTable(entries: DiffEntry[]): string {
  const rows = entries.map(e => ({
    env: e.environment,
    type: e.type,
    name: e.name,
    status: statusGlyph(e.status),
    hint: e.status === 'missing' || e.status === 'wrong_type' ? (e.hint ?? '') : '',
  }))
  const widths = {
    env: Math.max(3, ...rows.map(r => r.env.length)),
    type: Math.max(4, ...rows.map(r => r.type.length)),
    name: Math.max(4, ...rows.map(r => r.name.length)),
    status: Math.max(6, ...rows.map(r => r.status.length)),
  }
  const lines: string[] = []
  lines.push(
    pad('Env', widths.env) +
      '  ' +
      pad('Type', widths.type) +
      '  ' +
      pad('Name', widths.name) +
      '  ' +
      pad('Status', widths.status) +
      '  Hint',
  )
  lines.push(
    pad('---', widths.env) +
      '  ' +
      pad('----', widths.type) +
      '  ' +
      pad('----', widths.name) +
      '  ' +
      pad('------', widths.status) +
      '  ----',
  )
  for (const r of rows) {
    lines.push(
      pad(r.env, widths.env) +
        '  ' +
        pad(r.type, widths.type) +
        '  ' +
        pad(r.name, widths.name) +
        '  ' +
        pad(r.status, widths.status) +
        '  ' +
        r.hint,
    )
  }
  return lines.join('\n')
}

function pad(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length))
}

function statusGlyph(s: DiffStatus): string {
  switch (s) {
    case 'present':
      return 'OK'
    case 'missing':
      return 'MISSING'
    case 'unexpected':
      return 'extra'
    case 'wrong_type':
      return 'WRONG'
  }
}
