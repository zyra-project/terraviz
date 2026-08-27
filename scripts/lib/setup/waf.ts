// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * WAF skip rules — `SELF_HOSTING.md` Phase 13.2 and 13.3.
 *
 * Two endpoints have to be reachable by clients that cannot solve a
 * JS challenge:
 *
 *   - `/api/v1/publish/**\/transcode-complete`, POSTed by the GitHub
 *     Actions transcode runner with an Access **service token**.
 *     Service tokens bypass Access but not Bot Fight Mode, the
 *     Managed Ruleset, or custom WAF rules. Challenged, the runner
 *     exits non-zero at stage 5 with the interstitial HTML in the
 *     body — ffmpeg has already finished and the HLS bundle is
 *     already in R2, so the dataset row is left stuck on
 *     `transcoding=1` and only an operator can clear it.
 *   - `POST /api/feedback`, from the standalone widget, which runs
 *     without cookies and whose fallback is a `mailto:` draft. A
 *     challenge here silently drops every submission.
 *
 * ## The dangerous part, and how it is contained
 *
 * The rulesets API has no "append a rule" call. You read the zone's
 * custom-rules entrypoint, and you PUT the whole rule list back. A
 * naive implementation that PUTs only its own two rules **deletes
 * every WAF rule the operator has** — silently, and in the direction
 * of less security.
 *
 * So the merge is a pure function (`mergeRules`) that is tested for
 * exactly that property, the read happens first and a failed read
 * aborts rather than falling back to an empty list, and this whole
 * step is **opt-in** (`--only=waf`) rather than part of a default
 * run. Touching a zone's security configuration should be something
 * you asked for.
 *
 * ## Why these skips are safe
 *
 * The transcode rule matches only requests already carrying a
 * `cf-access-client-id` header; Access still validates the token
 * afterwards, so a forged header without the matching secret cannot
 * authenticate, and the route handler independently enforces
 * `role='service'`. The feedback rule leaves the endpoint's own abuse
 * controls (JSON-only, ~12 MB body cap, 10/hour per IP) untouched.
 *
 * Neither covers plain Bot Fight Mode on Free/Pro plans, which runs
 * zone-wide at a different layer with no per-path override. Phase
 * 13.2 Step 2 covers the options.
 */

import { CfApi, isAuthError, type CfError } from './cf-request'

export function explainWafPermissions(errors: CfError[]): string | null {
  if (!isAuthError(errors)) return null
  return 'The API token needs Zone → Zone WAF → Edit (and Zone → Zone → Read).'
}

/** Marks a rule as ours, and is the idempotency key. */
export const RULE_PREFIX = 'terraviz:'

export const TRANSCODE_RULE_DESCRIPTION = `${RULE_PREFIX} transcode-complete service token skip`
export const FEEDBACK_RULE_DESCRIPTION = `${RULE_PREFIX} standalone feedback endpoint skip`

export interface WafRule {
  action: string
  action_parameters?: Record<string, unknown>
  expression: string
  description?: string
  enabled?: boolean
}

export interface Ruleset {
  id?: string
  rules?: WafRule[]
}

/**
 * The Skip action parameters matching the guide's checklist:
 * remaining custom rules, all managed rules, all Super Bot Fight Mode
 * rules, Browser Integrity Check, and Security Level.
 */
function skipEverything(): Record<string, unknown> {
  return {
    ruleset: 'current',
    phases: ['http_request_firewall_managed', 'http_request_sbfm'],
    products: ['bic', 'securityLevel'],
  }
}

export function buildTranscodeRule(): WafRule {
  return {
    action: 'skip',
    action_parameters: skipEverything(),
    // Gated on the service-token header so the exemption can only
    // ever apply to traffic that is at least claiming to be the
    // runner — Access does the actual authentication.
    expression:
      '(starts_with(http.request.uri.path, "/api/v1/publish/") ' +
      'and ends_with(http.request.uri.path, "/transcode-complete") ' +
      'and len(http.request.headers["cf-access-client-id"][0]) > 0)',
    description: TRANSCODE_RULE_DESCRIPTION,
    enabled: true,
  }
}

export function buildFeedbackRule(): WafRule {
  return {
    action: 'skip',
    action_parameters: skipEverything(),
    expression:
      '(http.request.uri.path eq "/api/feedback" and http.request.method eq "POST")',
    description: FEEDBACK_RULE_DESCRIPTION,
    enabled: true,
  }
}

export interface MergeResult {
  rules: WafRule[]
  added: string[]
  kept: number
}

/**
 * Append our rules to the zone's existing list, preserving every
 * existing rule and its order.
 *
 * This is the function that must not be wrong. The rulesets API
 * replaces the whole list on PUT, so anything dropped here is
 * deleted from the operator's zone. Rules are matched by description
 * so a second run is a no-op; an operator who edited our rule's
 * expression keeps their edit (we never overwrite a rule we find).
 *
 * New rules go **last**: an existing rule that already blocks or
 * challenges something should keep its precedence, and our skip is
 * additive to whatever the operator has already decided.
 */
export function mergeRules(existing: WafRule[], wanted: WafRule[]): MergeResult {
  const present = new Set(
    existing.map(r => r.description).filter((d): d is string => Boolean(d)),
  )
  const added: string[] = []
  const rules = [...existing]
  for (const rule of wanted) {
    if (rule.description && present.has(rule.description)) continue
    rules.push(rule)
    if (rule.description) added.push(rule.description)
  }
  return { rules, added, kept: existing.length }
}

const ENTRYPOINT = 'rulesets/phases/http_request_firewall_custom/entrypoint'

export class WafApi {
  private readonly api: CfApi

  constructor(
    private readonly zoneId: string,
    opts: { apiToken: string; fetchImpl?: typeof fetch; apiBase?: string },
  ) {
    this.api = new CfApi({ ...opts, explain: explainWafPermissions })
  }

  /**
   * The zone's custom-rules entrypoint. Null when the zone has never
   * had a custom rule — a legitimate state, distinct from a failed
   * read, which throws.
   */
  getEntrypoint(): Promise<Ruleset | null> {
    return this.api.request<Ruleset>(`/zones/${this.zoneId}/${ENTRYPOINT}`, {
      allowMissing: true,
    })
  }

  async putRules(rules: WafRule[]): Promise<void> {
    await this.api.put(`/zones/${this.zoneId}/${ENTRYPOINT}`, { rules })
  }
}

export interface EnsureWafResult {
  added: string[]
  existing: number
  /** True when a PUT was actually issued. */
  changed: boolean
}

export async function ensureWafRules(
  api: WafApi,
  wanted: WafRule[],
  apply: boolean,
): Promise<EnsureWafResult> {
  // A read failure throws out of here rather than being treated as
  // "no rules" — writing an empty-based list on top of a zone whose
  // rules we merely failed to read would delete all of them.
  const entrypoint = await api.getEntrypoint()
  const existing = entrypoint?.rules ?? []
  const merged = mergeRules(existing, wanted)

  if (merged.added.length === 0) {
    return { added: [], existing: existing.length, changed: false }
  }
  if (apply) await api.putRules(merged.rules)
  return { added: merged.added, existing: existing.length, changed: apply }
}
