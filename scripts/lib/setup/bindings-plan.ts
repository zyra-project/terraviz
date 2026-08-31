// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Turn the declared binding manifest into a Cloudflare Pages PATCH
 * body (`SELF_HOSTING.md` Phase 8).
 *
 * ## Why this shares a manifest with the auditor
 *
 * `scripts/lib/expected-bindings.ts` already declares what a correct
 * deploy looks like, and `check-pages-bindings` already diffs live
 * state against it. This module is that same manifest read in the
 * *write* direction. Provisioner and auditor therefore cannot drift:
 * adding a binding to the manifest teaches both tools about it in one
 * edit, and anything this module writes is by construction something
 * the audit expects to find.
 *
 * The alternative — a second hand-maintained list of bindings-to-set
 * — is how you end up with an installer that provisions a deploy its
 * own audit then calls broken.
 *
 * ## The per-environment rule
 *
 * Every manifest entry declares which environments it must cover, and
 * every entry in practice declares both. Wiring Production but not
 * Preview (or the reverse) is the most common cutover failure in this
 * project's history — it produces a deploy that works until someone
 * opens a PR. Because the environments come from the manifest rather
 * than from a flag, that failure mode is not expressible here.
 *
 * ## Secrets
 *
 * Secret *values* never touch this module's inputs unless the caller
 * supplies them, are never logged, and are never persisted. A secret
 * with no supplied value is reported as skipped with a reason, not
 * written as an empty string — an empty `PREVIEW_SIGNING_KEY` would
 * pass the audit's name-presence check while leaving the endpoint
 * signing with nothing.
 */

import {
  EXPECTED_BINDINGS,
  type BindingType,
  type Environment,
  type ExpectedBinding,
} from '../expected-bindings'
import type { SetupState } from './state'

/**
 * Bindings the installer can set that the audit does not require.
 * Kept separate from `EXPECTED_BINDINGS` so the audit's notion of
 * "required" stays untouched — an operator who never sets
 * `TRUSTED_PUBLISHER_DOMAINS` has a correct deploy.
 */
export const OPTIONAL_EXTRAS: ExpectedBinding[] = [
  {
    name: 'TRUSTED_PUBLISHER_DOMAINS',
    type: 'plaintext',
    environments: ['production', 'preview'],
    hint:
      'Comma-separated email domains whose Access logins skip the approval ' +
      'queue. Provisions them as reviewer/active — read-only, NOT admin.',
  },
]

/** Cloudflare's per-binding payload shapes, keyed by binding type. */
export type BindingPayload =
  | { type: 'plain_text'; value: string }
  | { type: 'secret_text'; value: string }
  | { id: string } // d1
  | { namespace_id: string } // kv
  | { name: string } // r2
  | { index_name: string } // vectorize
  | { dataset: string } // analytics engine
  | Record<string, never> // ai

export type ResolutionStatus = 'resolved' | 'skipped'

export interface Resolution {
  name: string
  type: BindingType
  environments: Environment[]
  status: ResolutionStatus
  /** Present when resolved. */
  payload?: BindingPayload
  /** Operator-facing display of the value; `••••••` for secrets. */
  display?: string
  /** Present when skipped — why, and what to do about it. */
  reason?: string
}

/** Secret values, supplied by the caller from env or `.dev.vars`. */
export type SecretSource = Readonly<Record<string, string | undefined>>

const SECRET_MASK = '••••••'

/**
 * Resolve one manifest entry against the current state. Returns a
 * skip (never a throw) when the value isn't available — a partial
 * install is the normal case, and the operator needs the list of
 * what's left rather than a stack trace on the first gap.
 */
function resolve(
  exp: ExpectedBinding,
  state: SetupState,
  secrets: SecretSource,
): Resolution {
  const base = { name: exp.name, type: exp.type, environments: exp.environments }
  const skip = (reason: string): Resolution => ({ ...base, status: 'skipped', reason })
  const ok = (payload: BindingPayload, display: string): Resolution => ({
    ...base,
    status: 'resolved',
    payload,
    display,
  })

  switch (exp.type) {
    case 'd1': {
      // Both D1 bindings address the same physical database; they
      // differ only by migrations directory (Phase 4).
      if (!state.d1.id) return skip('D1 database not created yet — run the provision step')
      return ok({ id: state.d1.id }, `${state.d1.name} (${state.d1.id})`)
    }
    case 'kv': {
      const ref =
        exp.name === 'TELEMETRY_KILL_SWITCH'
          ? state.telemetryKv
          : exp.name === 'CATALOG_KV'
            ? state.catalogKv
            : undefined
      if (!ref) return skip(`no known KV namespace for binding ${exp.name}`)
      if (!ref.id) return skip('KV namespace not created yet — run the provision step')
      return ok({ namespace_id: ref.id }, `${ref.name} (${ref.id})`)
    }
    case 'r2': {
      if (exp.name !== 'CATALOG_R2') {
        return skip(`no known bucket for binding ${exp.name} — set it by hand`)
      }
      return ok({ name: state.r2Bucket.name }, state.r2Bucket.name)
    }
    case 'vectorize':
      return ok({ index_name: state.vectorizeIndex.name }, state.vectorizeIndex.name)
    case 'analytics_engine':
      return ok({ dataset: state.analyticsDataset.name }, state.analyticsDataset.name)
    case 'ai':
      return ok({}, '(Workers AI)')
    case 'secret': {
      const value = secrets[exp.name]
      if (!value) {
        return skip(
          `no value supplied — export ${exp.name}, or put it in .dev.vars ` +
            '(generated secrets come from Phase 7)',
        )
      }
      return ok({ type: 'secret_text', value }, SECRET_MASK)
    }
    case 'plaintext': {
      const value = plaintextValue(exp.name, state)
      if (!value) {
        return skip(`no value known for ${exp.name} — see SELF_HOSTING.md`)
      }
      return ok({ type: 'plain_text', value }, value)
    }
  }
}

function plaintextValue(name: string, state: SetupState): string | undefined {
  switch (name) {
    case 'ACCESS_TEAM_DOMAIN':
      return state.accessTeamDomain
    case 'ACCESS_AUD':
      return state.accessAud
    case 'TRUSTED_PUBLISHER_DOMAINS':
      return state.trustedPublisherDomains
    case 'R2_PUBLIC_BASE':
      return state.r2PublicBase
    case 'GITHUB_OWNER':
      return state.githubOwner
    case 'GITHUB_REPO':
      return state.githubRepo
    default:
      return undefined
  }
}

export interface BindingsPlan {
  resolutions: Resolution[]
  resolved: Resolution[]
  skipped: Resolution[]
}

export function planBindings(
  state: SetupState,
  secrets: SecretSource = {},
  manifest: ExpectedBinding[] = [...EXPECTED_BINDINGS, ...OPTIONAL_EXTRAS],
): BindingsPlan {
  const resolutions = manifest.map(exp => resolve(exp, state, secrets))
  return {
    resolutions,
    resolved: resolutions.filter(r => r.status === 'resolved'),
    skipped: resolutions.filter(r => r.status === 'skipped'),
  }
}

/** The `deployment_configs` half of a Pages project PATCH body. */
export interface DeploymentConfig {
  env_vars?: Record<string, { type: string; value: string }>
  d1_databases?: Record<string, { id: string }>
  kv_namespaces?: Record<string, { namespace_id: string }>
  r2_buckets?: Record<string, { name: string }>
  vectorize_bindings?: Record<string, { index_name: string }>
  ai_bindings?: Record<string, Record<string, never>>
  analytics_engine_datasets?: Record<string, { dataset: string }>
}

export interface PagesPatchBody {
  deployment_configs: {
    production?: DeploymentConfig
    preview?: DeploymentConfig
  }
}

/**
 * Group resolved bindings into the shape Cloudflare's Pages project
 * PATCH expects. The key names mirror exactly what
 * `scripts/lib/cf-pages-api.ts` reads back out of the same object,
 * which is what makes the post-apply audit a genuine round-trip check
 * rather than a restatement of our own assumptions.
 *
 * Only keys we are actually setting appear in the body. The PATCH
 * merges, so untouched bindings — an operator's own Stream token, say
 * — survive.
 */
export function buildPatchBody(plan: BindingsPlan): PagesPatchBody {
  const envs: Environment[] = ['production', 'preview']
  const body: PagesPatchBody = { deployment_configs: {} }

  for (const env of envs) {
    const config: DeploymentConfig = {}
    let touched = false

    for (const r of plan.resolved) {
      if (!r.environments.includes(env) || !r.payload) continue
      touched = true
      switch (r.type) {
        case 'plaintext':
        case 'secret':
          config.env_vars ??= {}
          config.env_vars[r.name] = r.payload as { type: string; value: string }
          break
        case 'd1':
          config.d1_databases ??= {}
          config.d1_databases[r.name] = r.payload as { id: string }
          break
        case 'kv':
          config.kv_namespaces ??= {}
          config.kv_namespaces[r.name] = r.payload as { namespace_id: string }
          break
        case 'r2':
          config.r2_buckets ??= {}
          config.r2_buckets[r.name] = r.payload as { name: string }
          break
        case 'vectorize':
          config.vectorize_bindings ??= {}
          config.vectorize_bindings[r.name] = r.payload as { index_name: string }
          break
        case 'ai':
          config.ai_bindings ??= {}
          config.ai_bindings[r.name] = {}
          break
        case 'analytics_engine':
          config.analytics_engine_datasets ??= {}
          config.analytics_engine_datasets[r.name] = r.payload as { dataset: string }
          break
      }
    }
    if (touched) body.deployment_configs[env] = config
  }
  return body
}

/** Operator-facing table of what will be (or was) written. */
export function formatBindingsPlan(plan: BindingsPlan): string {
  const rows = plan.resolutions.map(r => ({
    status: r.status === 'resolved' ? 'SET' : 'skip',
    type: r.type,
    name: r.name,
    detail: r.status === 'resolved' ? (r.display ?? '') : (r.reason ?? ''),
  }))
  const w = {
    status: Math.max(6, ...rows.map(r => r.status.length)),
    type: Math.max(4, ...rows.map(r => r.type.length)),
    name: Math.max(4, ...rows.map(r => r.name.length)),
  }
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length))
  const lines = [
    `${pad('Action', w.status)}  ${pad('Type', w.type)}  ${pad('Name', w.name)}  Value / reason`,
    `${pad('------', w.status)}  ${pad('----', w.type)}  ${pad('----', w.name)}  --------------`,
  ]
  for (const r of rows) {
    lines.push(
      `${pad(r.status, w.status)}  ${pad(r.type, w.type)}  ${pad(r.name, w.name)}  ${r.detail}`,
    )
  }
  return lines.join('\n')
}
