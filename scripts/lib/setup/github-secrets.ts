// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * GitHub Actions repo secrets — `SELF_HOSTING.md` Phase 13.2 / 13.4.
 *
 * ## Why this emits commands instead of calling the API
 *
 * Writing an Actions secret over the REST API means encrypting the
 * value as a libsodium **sealed box** against the repository's public
 * key. Sealed boxes derive their nonce with BLAKE2b, which `node:crypto`
 * does not implement — so doing this in-process means either adding
 * `libsodium-wrappers` as a dependency or hand-rolling the crypto.
 *
 * Neither is worth it for something an operator does once. `gh secret
 * set` already implements the sealed box correctly, and printing the
 * exact commands is a better deliverable than a dependency: it is
 * inspectable before it runs, it works from the operator's own
 * authenticated `gh` session rather than needing a PAT handed to this
 * tool, and it degrades to "paste these values into the Settings UI"
 * for anyone without `gh`.
 *
 * Values are emitted as `"$VAR"` references, never inlined — so the
 * printed script is safe to copy into a terminal, an issue, or a
 * runbook, and reads its secrets from the shell that already has them
 * exported.
 */

export interface GithubSecretSpec {
  name: string
  /** Shell variable the operator is expected to have exported. */
  from: string
  why: string
  /** Which optional feature needs it; omitted for always-required. */
  feature?: string
}

/**
 * Every repo secret the bundled workflows read. `TERRAVIZ_SERVER` is
 * also a repo *Variable* for `ci.yml`'s deployment URL — the
 * `secrets` context is not allowed in `environment.url`, so both
 * exist and are not interchangeable (Phase 5.3).
 */
export const GITHUB_SECRETS: GithubSecretSpec[] = [
  {
    name: 'CF_ACCESS_CLIENT_ID',
    from: 'CF_ACCESS_CLIENT_ID',
    why: 'Access service token id — transcode callback, analytics export, visual report',
  },
  {
    name: 'CF_ACCESS_CLIENT_SECRET',
    from: 'CF_ACCESS_CLIENT_SECRET',
    why: 'the matching secret; Cloudflare shows it only at creation',
  },
  {
    name: 'TERRAVIZ_SERVER',
    from: 'TERRAVIZ_SERVER',
    why: 'base URL the workflows POST back to',
  },
  {
    name: 'R2_S3_ENDPOINT',
    from: 'R2_S3_ENDPOINT',
    why: 'R2 S3-API endpoint for the transcode runner',
    feature: 'video transcode',
  },
  {
    name: 'R2_ACCESS_KEY_ID',
    from: 'R2_ACCESS_KEY_ID',
    why: 'R2 S3-API key with read+write on the assets bucket',
    feature: 'video transcode',
  },
  {
    name: 'R2_SECRET_ACCESS_KEY',
    from: 'R2_SECRET_ACCESS_KEY',
    why: 'the matching secret',
    feature: 'video transcode',
  },
  {
    name: 'CATALOG_R2_BUCKET',
    from: 'CATALOG_R2_BUCKET',
    why: 'bucket-name override; only if you renamed terraviz-assets',
    feature: 'video transcode',
  },
]

export interface GithubSecretsScriptOptions {
  /** `owner/repo`. Omitted, the commands rely on the cwd's remote. */
  repo?: string
  /** Names the operator has exported; the rest are flagged. */
  available?: Set<string>
}

/**
 * Render the `gh secret set` script, annotated with what each secret
 * is for and which ones the current shell cannot supply.
 */
export function renderGithubSecretsScript(
  opts: GithubSecretsScriptOptions = {},
): string {
  const repoFlag = opts.repo ? ` --repo ${opts.repo}` : ''
  const lines: string[] = [
    '# Phase 13.2 / 13.4 — GitHub Actions repo secrets.',
    '# Run from a shell that has these exported. `gh` performs the',
    '# libsodium sealed-box encryption GitHub requires.',
    '',
  ]
  for (const spec of GITHUB_SECRETS) {
    const known = !opts.available || opts.available.has(spec.from)
    const tag = spec.feature ? ` [${spec.feature}]` : ''
    lines.push(`# ${spec.why}${tag}`)
    if (!known) lines.push(`#   ⚠ $${spec.from} is not set in this shell`)
    lines.push(`gh secret set ${spec.name}${repoFlag} --body "$${spec.from}"`)
    lines.push('')
  }
  lines.push(
    '# TERRAVIZ_SERVER is ALSO needed as a repo Variable (not a secret) for',
    "# ci.yml's deployment URL — the secrets context is not allowed in",
    '# environment.url. Settings → Secrets and variables → Actions → Variables.',
    `gh variable set TERRAVIZ_SERVER${repoFlag} --body "$TERRAVIZ_SERVER"`,
  )
  return lines.join('\n')
}
