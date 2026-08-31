// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Cloudflare Pages project write client — the one thing wrangler
 * cannot do (`SELF_HOSTING.md` Phase 8).
 *
 * `scripts/lib/cf-pages-api.ts` reads `GET /accounts/{id}/pages/
 * projects/{name}` for the bindings audit. This writes the same
 * object with `PATCH`. Because both halves address one resource, the
 * audit is a genuine round-trip check on what we wrote rather than a
 * restatement of our own assumptions — apply, then re-read with the
 * existing `RestApiSource` + `diffBindings`, and any drift between
 * what we intended and what Cloudflare stored shows up immediately.
 *
 * ## The PATCH merges
 *
 * Only the keys present in the body are touched; bindings an operator
 * added by hand (a Stream API token, say) survive. That is why
 * `buildPatchBody` emits only resolved entries and never a full
 * environment replacement — a replace would silently delete
 * everything the manifest doesn't know about.
 *
 * ## Token scope
 *
 * The read path needs **Account → Cloudflare Pages → Read**. This
 * needs **Edit**. That is a real escalation over the audit's token,
 * so it is a deliberate, separate decision for the operator rather
 * than something inherited by running a "check" command.
 */

import type { PagesPatchBody } from './bindings-plan'

export interface PagesWriteOptions {
  apiToken: string
  accountId: string
  projectName: string
  fetchImpl?: typeof fetch
  apiBase?: string
}

interface CfEnvelope {
  success?: boolean
  errors?: Array<{ code?: number; message?: string }>
}

/**
 * Cloudflare error codes worth translating. A raw `10000` tells an
 * operator nothing; "your token lacks Pages:Edit" tells them exactly
 * which checkbox to tick.
 */
function explain(errors: Array<{ code?: number; message?: string }>): string {
  const parts = errors.map(e => `${e.code ?? '?'}: ${e.message ?? 'unknown'}`)
  const joined = parts.join('; ')
  if (errors.some(e => e.code === 10000 || /authentication|permission/i.test(e.message ?? ''))) {
    return (
      `${joined}\n` +
      '  → The API token needs Account → Cloudflare Pages → Edit ' +
      '(the audit only needs Read, so a read-only token gets this far and then fails here).'
    )
  }
  if (errors.some(e => /not found/i.test(e.message ?? ''))) {
    return (
      `${joined}\n` +
      '  → Check CLOUDFLARE_PAGES_PROJECT_NAME matches the project, and that ' +
      'CLOUDFLARE_ACCOUNT_ID is the account that owns it.'
    )
  }
  return joined
}

export class PagesProjectWriter {
  constructor(private readonly opts: PagesWriteOptions) {}

  async patchBindings(body: PagesPatchBody): Promise<void> {
    const base = this.opts.apiBase ?? 'https://api.cloudflare.com/client/v4'
    const url =
      `${base}/accounts/${this.opts.accountId}/pages/projects/` +
      encodeURIComponent(this.opts.projectName)
    const fetchImpl = this.opts.fetchImpl ?? fetch

    const res = await fetchImpl(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.opts.apiToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      let parsed: CfEnvelope | null = null
      try {
        parsed = JSON.parse(text) as CfEnvelope
      } catch {
        /* fall through to the raw body */
      }
      const detail = parsed?.errors?.length
        ? explain(parsed.errors)
        : text.slice(0, 300)
      throw new Error(`Cloudflare API ${res.status} ${res.statusText}: ${detail}`)
    }
    let parsed: CfEnvelope
    try {
      parsed = JSON.parse(text) as CfEnvelope
    } catch {
      throw new Error(`Cloudflare API returned non-JSON: ${text.slice(0, 200)}`)
    }
    if (!parsed.success) {
      throw new Error(
        `Cloudflare API replied success=false: ${explain(parsed.errors ?? [])}`,
      )
    }
  }
}
