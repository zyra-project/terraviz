// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Access provisioning — `SELF_HOSTING.md` Phase 6.
 *
 * This is the phase the pre-2026 guide never had. It told operators
 * to configure `ACCESS_AUD` without ever creating the application
 * that issues an audience tag, and used `$CF_ACCESS_CLIENT_ID` in
 * three commands without saying where it came from. Both values are
 * *outputs* of this phase, and both are returned directly by the
 * create calls below — which is precisely why automating it removes
 * a whole class of "where do I get this" dead end.
 *
 * ## What this creates
 *
 * One self-hosted Access application covering both the publisher API
 * (`/api/v1/publish`) and the browser portal (`/publish`, `/publish/*`)
 * on both the custom hostname and the `*.pages.dev` host, plus two
 * policies:
 *
 *   - `Staff` — Allow, include "emails ending in <domain>". The
 *     humans who publish.
 *   - `Automation` — Service Auth (`non_identity`), include the
 *     service token. The `terraviz` CLI, the transcode workflow, the
 *     analytics export.
 *
 * A service token that is not attached to a Service Auth policy
 * authenticates but is authorised for nothing, so the token and its
 * policy are provisioned together rather than left as two steps an
 * operator can half-complete.
 *
 * ## Adopt, never re-create
 *
 * Every `ensure*` lists first. This matters more here than for
 * storage resources: creating a second application for the same
 * destinations produces two AUDs, and a JWT minted for one is
 * rejected by a deploy configured with the other — a 401 with no
 * obvious cause.
 *
 * ## The service-token secret is unrecoverable
 *
 * Cloudflare returns `client_secret` exactly once, at creation. When
 * this adopts an existing token it therefore *cannot* return the
 * secret, and says so rather than emitting an empty string that would
 * silently produce a broken `.env`. The operator either already has
 * it saved or rotates the token.
 *
 * ## Verification status
 *
 * The request/response shapes here are modelled from Cloudflare's
 * documented Access API and from what
 * `functions/api/v1/_lib/access-auth.ts` proves about the resulting
 * JWTs (RS256, `aud` contains the application AUD, `iss` is
 * `https://<team>.cloudflareaccess.com`). They have **not** been
 * exercised against a live account. The body builders are pure and
 * unit-tested so the shape is at least pinned and reviewable; a
 * mismatch surfaces as a Cloudflare validation error naming the
 * field, not as a silent misconfiguration.
 */

export interface AccessApiOptions {
  apiToken: string
  accountId: string
  fetchImpl?: typeof fetch
  apiBase?: string
}

export interface AccessApp {
  id: string
  name: string
  /** The audience tag — `ACCESS_AUD`. Returned on create and list. */
  aud: string
  domain?: string
}

export interface AccessPolicy {
  id: string
  name: string
  decision: string
}

export interface ServiceTokenSummary {
  id: string
  name: string
  client_id?: string
}

export interface ServiceTokenSecret extends ServiceTokenSummary {
  /** Present only in the create response. Never retrievable later. */
  client_secret: string
}

interface Envelope<T> {
  success?: boolean
  result?: T
  errors?: Array<{ code?: number; message?: string }>
}

/**
 * Translate the Cloudflare errors an operator is most likely to hit
 * here into the permission they actually need. A bare
 * `10000 Authentication error` sends people to the wrong place.
 */
function explain(errors: Array<{ code?: number; message?: string }>): string {
  const joined = errors.map(e => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`).join('; ')
  if (errors.some(e => e.code === 10000 || /authentication|permission|forbidden/i.test(e.message ?? ''))) {
    return (
      `${joined}\n` +
      '  → The API token needs Account → Access: Apps and Policies → Edit\n' +
      '    and Account → Access: Service Tokens → Edit\n' +
      '    (plus Access: Organizations → Read to discover the team domain).'
    )
  }
  return joined
}

/**
 * Carries the HTTP status alongside the message so callers can branch
 * on *which* failure happened. Without it the only way to tell "no
 * Zero Trust organization" (404) from "your token cannot read
 * organizations" (403) is to pattern-match a human-readable string.
 */
export class AccessApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'AccessApiError'
  }
}

export class AccessApi {
  constructor(private readonly opts: AccessApiOptions) {}

  private get base(): string {
    return this.opts.apiBase ?? 'https://api.cloudflare.com/client/v4'
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch
    const url = `${this.base}/accounts/${this.opts.accountId}${path}`
    const res = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    const text = await res.text()
    let parsed: Envelope<T> | null = null
    try {
      parsed = JSON.parse(text) as Envelope<T>
    } catch {
      /* fall through */
    }
    if (!res.ok || parsed?.success === false) {
      const detail = parsed?.errors?.length ? explain(parsed.errors) : text.slice(0, 300)
      throw new AccessApiError(
        `Cloudflare Access API ${res.status} ${res.statusText}: ${detail}`,
        res.status,
      )
    }
    if (!parsed || parsed.result === undefined) {
      throw new Error(`Cloudflare Access API returned no result for ${path}`)
    }
    return parsed.result
  }

  /**
   * The Zero Trust organization, whose `auth_domain` is the team
   * domain (`ACCESS_TEAM_DOMAIN`). Returns null when Zero Trust has
   * not been onboarded yet — that is a manual prerequisite, and a
   * null here is how the caller detects it.
   *
   * Only a 404 means that. A 403 means the token is missing Access:
   * Organizations → Read; a 5xx or a network failure means neither.
   * Collapsing all three into null would send an operator whose token
   * is under-scoped to the Zero Trust onboarding page, where they will
   * find the onboarding already done and no way forward — so
   * everything except the 404 is rethrown with `explain()`'s hint
   * intact.
   */
  async getTeamDomain(): Promise<string | null> {
    try {
      const org = await this.request<{ auth_domain?: string }>('/access/organizations')
      return org.auth_domain ?? null
    } catch (err) {
      if (err instanceof AccessApiError && err.status === 404) return null
      throw err
    }
  }

  listApps(): Promise<AccessApp[]> {
    return this.request<AccessApp[]>('/access/apps')
  }

  createApp(body: AccessAppBody): Promise<AccessApp> {
    return this.request<AccessApp>('/access/apps', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  listPolicies(appId: string): Promise<AccessPolicy[]> {
    return this.request<AccessPolicy[]>(`/access/apps/${appId}/policies`)
  }

  createPolicy(appId: string, body: PolicyBody): Promise<AccessPolicy> {
    return this.request<AccessPolicy>(`/access/apps/${appId}/policies`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  listServiceTokens(): Promise<ServiceTokenSummary[]> {
    return this.request<ServiceTokenSummary[]>('/access/service_tokens')
  }

  createServiceToken(name: string): Promise<ServiceTokenSecret> {
    return this.request<ServiceTokenSecret>('/access/service_tokens', {
      method: 'POST',
      body: JSON.stringify({ name }),
    })
  }
}

// ── Pure body builders ────────────────────────────────────────────

/** Paths the publisher application must gate on every host. */
export const PUBLISHER_PATHS = ['/api/v1/publish', '/publish', '/publish/*'] as const

/**
 * Build the destination list for the publisher application.
 *
 * Both the API prefix and the portal prefix are covered, on both the
 * custom hostname and the `*.pages.dev` host. Omitting the pages.dev
 * host leaves every preview deployment's portal ungated, which is the
 * state the old guide described as "treat the preview deploy URLs as
 * public".
 *
 * Cloudflare matches a path destination as a prefix, but `/publish`
 * alone does not reliably cover `/publish/datasets/new` across API
 * versions, so the explicit `/*` form is included too. Duplicates are
 * harmless; missing coverage is not.
 */
export function publisherDestinations(hostname: string, pagesHost?: string): string[] {
  const hosts = [hostname, pagesHost].filter((h): h is string => Boolean(h))
  const out: string[] = []
  for (const host of hosts) {
    const bare = host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
    for (const path of PUBLISHER_PATHS) out.push(`${bare}${path}`)
  }
  return out
}

export interface AccessAppBody {
  name: string
  type: 'self_hosted'
  session_duration: string
  /**
   * Primary destination. Superseded by `destinations` on current API
   * versions but still populated: older versions require it, and the
   * two agreeing costs nothing.
   */
  domain: string
  destinations: Array<{ type: 'public'; uri: string }>
  app_launcher_visible: boolean
}

export function buildAppBody(opts: {
  name: string
  destinations: string[]
  sessionDuration?: string
}): AccessAppBody {
  if (opts.destinations.length === 0) {
    throw new Error('buildAppBody: at least one destination is required')
  }
  return {
    name: opts.name,
    type: 'self_hosted',
    // Publishers should not be re-challenged mid-form; a daily
    // re-prompt is the right cadence for an authoring surface.
    session_duration: opts.sessionDuration ?? '24h',
    domain: opts.destinations[0],
    destinations: opts.destinations.map(uri => ({ type: 'public' as const, uri })),
    app_launcher_visible: false,
  }
}

export interface PolicyBody {
  name: string
  decision: 'allow' | 'deny' | 'bypass' | 'non_identity'
  include: Array<Record<string, unknown>>
  precedence?: number
}

export const STAFF_POLICY_NAME = 'Staff'
export const AUTOMATION_POLICY_NAME = 'Automation'

/**
 * Allow policy for the human cohort.
 *
 * `email_domain` is the suffix match. The `email` selector is an
 * exact match against one address, and choosing it by mistake is the
 * single most common Access misconfiguration in this project's
 * support history — so the suffix form is the only one this builder
 * can produce.
 */
export function buildStaffPolicy(emailDomain: string): PolicyBody {
  const domain = emailDomain.replace(/^@/, '').trim().toLowerCase()
  if (!domain || !domain.includes('.')) {
    throw new Error(`buildStaffPolicy: "${emailDomain}" is not a valid email domain`)
  }
  return {
    name: STAFF_POLICY_NAME,
    decision: 'allow',
    include: [{ email_domain: { domain } }],
    precedence: 1,
  }
}

/**
 * Service Auth policy for machine credentials. `non_identity` is the
 * decision Cloudflare uses for service-token access: no SSO round
 * trip, the token itself is the identity.
 */
export function buildServicePolicy(tokenId: string): PolicyBody {
  if (!tokenId) throw new Error('buildServicePolicy: a service token id is required')
  return {
    name: AUTOMATION_POLICY_NAME,
    decision: 'non_identity',
    include: [{ service_token: { token_id: tokenId } }],
    precedence: 2,
  }
}

// ── Orchestration ─────────────────────────────────────────────────

export interface EnsureAppResult {
  app: AccessApp
  created: boolean
}

export async function ensureAccessApplication(
  api: AccessApi,
  opts: { name: string; destinations: string[]; sessionDuration?: string },
): Promise<EnsureAppResult> {
  const existing = (await api.listApps()).find(a => a.name === opts.name)
  if (existing) return { app: existing, created: false }
  const app = await api.createApp(buildAppBody(opts))
  if (!app.aud) {
    throw new Error(
      `Created Access application "${opts.name}" but the response carried no AUD. ` +
        'Read it from the application\'s Overview tab and set ACCESS_AUD by hand.',
    )
  }
  return { app, created: true }
}

export interface EnsureTokenResult {
  id: string
  name: string
  clientId?: string
  /** Only ever present when this run created the token. */
  clientSecret?: string
  created: boolean
}

export async function ensureServiceToken(
  api: AccessApi,
  name: string,
): Promise<EnsureTokenResult> {
  const existing = (await api.listServiceTokens()).find(t => t.name === name)
  if (existing) {
    // Deliberately no secret: Cloudflare only ever returns it at
    // creation. Emitting '' here would produce a plausible-looking
    // but non-functional credential.
    return { id: existing.id, name, clientId: existing.client_id, created: false }
  }
  const token = await api.createServiceToken(name)
  return {
    id: token.id,
    name,
    clientId: token.client_id,
    clientSecret: token.client_secret,
    created: true,
  }
}

export interface EnsurePoliciesResult {
  created: string[]
  existing: string[]
}

export async function ensurePolicies(
  api: AccessApi,
  appId: string,
  opts: { emailDomain?: string; serviceTokenId?: string },
): Promise<EnsurePoliciesResult> {
  const present = new Set((await api.listPolicies(appId)).map(p => p.name))
  const created: string[] = []
  const existing: string[] = []

  const wanted: PolicyBody[] = []
  if (opts.emailDomain) wanted.push(buildStaffPolicy(opts.emailDomain))
  if (opts.serviceTokenId) wanted.push(buildServicePolicy(opts.serviceTokenId))

  for (const body of wanted) {
    if (present.has(body.name)) {
      existing.push(body.name)
      continue
    }
    await api.createPolicy(appId, body)
    created.push(body.name)
  }
  return { created, existing }
}
