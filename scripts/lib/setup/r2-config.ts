// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * R2 public domain + CORS policy — `SELF_HOSTING.md` Phase 13.1.
 *
 * ## Why the CORS policy is worth generating rather than pasting
 *
 * R2's CORS implementation is stricter than the Fetch spec, in two
 * ways that produce confusing failures rather than obvious ones:
 *
 *   - **`HEAD` must be listed explicitly.** Fetch treats it as a
 *     simple method; R2 treats HEAD and GET as distinct. Omit it and
 *     the web zip-download dialog's size probe is blocked outright.
 *   - **`Content-Range` must be in `ExposeHeaders`.** It is not
 *     CORS-safelisted, so the dialog's `Range: bytes=0-0` fallback
 *     cannot read it. The symptom is "size unknown" *with no console
 *     error*, which looks like a bug in the app.
 *
 * Both are in the guide, and both are exactly the sort of detail that
 * gets dropped when a human retypes a JSON blob. Building it from the
 * origins removes the opportunity.
 *
 * ## Two encodings of the same policy
 *
 * The REST API takes `rules[].allowed.{origins,methods,headers}`; the
 * dashboard's JSON editor takes the S3-style
 * `AllowedOrigins`/`AllowedMethods`. This module emits both — the
 * first to apply, the second to print if the call fails, so an
 * operator is never left translating between them by hand.
 *
 * ## What this deliberately does not do
 *
 * **Mint the R2 S3 API token.** Creating API tokens programmatically
 * requires a bootstrap token that can create tokens, which is a
 * strictly larger credential than everything else here needs — one
 * that could mint itself more authority. That is a security boundary
 * worth keeping manual: it is two clicks in the R2 dashboard, once.
 */

import { CfApi, isAuthError, matchZone, type CfError } from './cf-request'

export function explainR2Permissions(errors: CfError[]): string | null {
  if (!isAuthError(errors)) return null
  return (
    'The API token needs Account → Workers R2 Storage → Edit, ' +
    'plus Zone → Zone → Read to resolve the zone for a custom domain.'
  )
}

// ── CORS ──────────────────────────────────────────────────────────

export interface CorsOrigins {
  /** Your node's public origin, e.g. `https://terraviz.your-org.org`. */
  site: string
  /** Add `http://localhost:5173` so the dev server can upload + zip. */
  includeLocalhost?: boolean
  /** Add the three Tauri webview origins to the read rule. */
  includeTauri?: boolean
}

/** macOS / Windows / Linux Tauri webview origins, in that order. */
export const TAURI_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const

export const DEV_ORIGIN = 'http://localhost:5173'

/** Cloudflare REST shape. */
export interface R2CorsRule {
  allowed: { origins: string[]; methods: string[]; headers: string[] }
  exposeHeaders: string[]
  maxAgeSeconds: number
}

/** Dashboard JSON-editor shape (S3 style). */
export interface R2CorsRuleS3 {
  AllowedOrigins: string[]
  AllowedMethods: string[]
  AllowedHeaders: string[]
  ExposeHeaders: string[]
  MaxAgeSeconds: number
}

function normaliseOrigin(origin: string): string {
  return origin.replace(/\/+$/, '')
}

export function buildCorsRules(opts: CorsOrigins): R2CorsRule[] {
  const site = normaliseOrigin(
    opts.site.startsWith('http') ? opts.site : `https://${opts.site}`,
  )
  const readOrigins = [site]
  const writeOrigins = [site]
  if (opts.includeLocalhost) {
    readOrigins.push(DEV_ORIGIN)
    writeOrigins.push(DEV_ORIGIN)
  }
  // Desktop builds only ever read from R2 — uploads go through the
  // publisher portal on the web origin — so the Tauri origins belong
  // on the read rule alone.
  if (opts.includeTauri) readOrigins.push(...TAURI_ORIGINS)

  return [
    {
      allowed: { origins: readOrigins, methods: ['GET', 'HEAD'], headers: ['*'] },
      // Content-Length is CORS-safelisted; listing it is defensive
      // against a spec change, and costs nothing.
      exposeHeaders: ['Content-Length', 'Content-Range'],
      maxAgeSeconds: 3600,
    },
    {
      allowed: { origins: writeOrigins, methods: ['PUT', 'POST'], headers: ['Content-Type'] },
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 3600,
    },
  ]
}

/** The same policy in the form the dashboard's JSON editor accepts. */
export function toDashboardJson(rules: R2CorsRule[]): R2CorsRuleS3[] {
  return rules.map(r => ({
    AllowedOrigins: r.allowed.origins,
    AllowedMethods: r.allowed.methods,
    AllowedHeaders: r.allowed.headers,
    ExposeHeaders: r.exposeHeaders,
    MaxAgeSeconds: r.maxAgeSeconds,
  }))
}

// ── API ───────────────────────────────────────────────────────────

export interface R2CustomDomain {
  domain: string
  enabled?: boolean
  status?: { ownership?: string; ssl?: string }
}

interface Zone {
  id: string
  name?: string
}

export class R2ConfigApi {
  private readonly api: CfApi

  constructor(
    private readonly accountId: string,
    opts: { apiToken: string; fetchImpl?: typeof fetch; apiBase?: string },
  ) {
    this.api = new CfApi({ ...opts, explain: explainR2Permissions })
  }

  async putCors(bucket: string, rules: R2CorsRule[]): Promise<void> {
    await this.api.put(
      `/accounts/${this.accountId}/r2/buckets/${encodeURIComponent(bucket)}/cors`,
      { rules },
    )
  }

  /** Longest-suffix match, so `eu.example.org` beats `example.org`. */
  async findZone(hostname: string): Promise<Zone | null> {
    const zones = await this.api.requireResult<Zone[]>('/zones?per_page=200')
    return matchZone(zones, hostname)
  }

  listCustomDomains(bucket: string): Promise<R2CustomDomain[] | null> {
    return this.api.request<R2CustomDomain[]>(
      `/accounts/${this.accountId}/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`,
      { allowMissing: true },
    )
  }

  addCustomDomain(bucket: string, domain: string, zoneId: string): Promise<unknown> {
    return this.api.post(
      `/accounts/${this.accountId}/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`,
      { domain, zoneId, enabled: true },
    )
  }
}

export interface EnsureR2DomainResult {
  domain: string
  created: boolean
  zoneId?: string
}

/**
 * Attach a public custom domain to the bucket. The resulting origin
 * is what `R2_PUBLIC_BASE` must be set to — without it the manifest
 * endpoint returns 503 `r2_unconfigured` for HLS refs, and no
 * R2-hosted asset resolves.
 */
export async function ensureR2CustomDomain(
  api: R2ConfigApi,
  bucket: string,
  domain: string,
): Promise<EnsureR2DomainResult> {
  const bare = domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const existing = (await api.listCustomDomains(bucket)) ?? []
  if (existing.some(d => d.domain === bare)) return { domain: bare, created: false }

  const zone = await api.findZone(bare)
  if (!zone) {
    throw new Error(
      `No Cloudflare zone on this account matches "${bare}". ` +
        'The domain has to be on Cloudflare DNS before R2 can serve it.',
    )
  }
  await api.addCustomDomain(bucket, bare, zone.id)
  return { domain: bare, created: true, zoneId: zone.id }
}
