// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Node secret material — `SELF_HOSTING.md` Phase 7.
 *
 * Two secrets are the operator's to create, and neither exists until
 * someone makes it. The old guide listed both in its bindings table
 * several steps before introducing the command that generates one and
 * without ever mentioning the other.
 *
 * ## Division of labour
 *
 * `NODE_ID_PRIVATE_KEY_PEM` already has an owner: `npm run
 * gen:node-key` generates the Ed25519 keypair, writes the private
 * half to `.dev.vars` at mode 0600, writes `node-public-key.txt`
 * (which `terraviz init-node` reads in Phase 9), and stamps the public
 * half onto the local D1 `node_identity` row. Re-implementing any of
 * that here would create a second owner of the node's identity, so
 * this module only *detects* whether the key is present and names the
 * command when it isn't.
 *
 * `PREVIEW_SIGNING_KEY` has no owner — the guide just said "any
 * high-entropy string" — so this generates it.
 *
 * ## Why `.dev.vars` is the destination
 *
 * It is gitignored, it is already where `gen:node-key` puts the node
 * key, and the bindings step (Phase 8) already reads secrets from it.
 * Writing here means one `npm run setup -- --apply` run can generate
 * the preview key and push it to Pages without the value ever being
 * printed or passed through a shell.
 *
 * This module refuses to create `.dev.vars` itself. If it is absent,
 * the node key is absent too, so the operator has to run
 * `gen:node-key` regardless — and that command creates the file with
 * restrictive permissions. Creating it here with default perms would
 * quietly widen them.
 */

import { randomBytes } from 'node:crypto'

export const NODE_KEY_VAR = 'NODE_ID_PRIVATE_KEY_PEM'
export const PREVIEW_KEY_VAR = 'PREVIEW_SIGNING_KEY'

/** 256 bits, base64. HMAC-SHA-256 keys gain nothing beyond this. */
export function generateSigningKey(): string {
  return randomBytes(32).toString('base64')
}

/**
 * Is `name` assigned a non-empty value in this dotenv text?
 *
 * Commented-out lines don't count — `.dev.vars.example` ships
 * `# PREVIEW_SIGNING_KEY=` and treating that as "present" would leave
 * the preview endpoints failing closed with nothing to show for it.
 */
export function hasVar(text: string, name: string): boolean {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+)$`)
  for (const raw of text.split('\n')) {
    if (/^\s*#/.test(raw)) continue
    const m = re.exec(raw)
    if (m && m[1].trim().length > 0) return true
  }
  return false
}

export interface AppendResult {
  text: string
  /** True when this call added the assignment. */
  added: boolean
}

/**
 * Append `name=value` to dotenv text, leaving an existing assignment
 * untouched. Never rewrites in place: a key already set is a key
 * something may already be signing with, and silently rotating it
 * would invalidate every outstanding preview token.
 */
export function appendVar(text: string, name: string, value: string): AppendResult {
  if (hasVar(text, name)) return { text, added: false }
  const body = text.endsWith('\n') || text.length === 0 ? text : `${text}\n`
  return {
    text:
      `${body}\n# Added by \`npm run setup\` (SELF_HOSTING.md Phase 7).\n` +
      `${name}=${value}\n`,
    added: true,
  }
}

export type SecretStatus = 'present' | 'generated' | 'manual'

export interface SecretOutcome {
  name: string
  status: SecretStatus
  /** Operator-facing next step when `status` is `manual`. */
  action?: string
}

export interface EnsureSecretsResult {
  /** Updated dotenv text, or null when nothing changed. */
  text: string | null
  outcomes: SecretOutcome[]
}

/**
 * Resolve both Phase 7 secrets against the current `.dev.vars`.
 *
 * Pure: takes the file's text, returns what it should become. The
 * caller decides whether to write it, which is what keeps plan mode
 * genuinely side-effect free.
 */
export function ensureSecrets(
  devVars: string | null,
  generate: () => string = generateSigningKey,
): EnsureSecretsResult {
  const outcomes: SecretOutcome[] = []

  if (devVars === null) {
    return {
      text: null,
      outcomes: [
        {
          name: NODE_KEY_VAR,
          status: 'manual',
          action: 'run `npm run gen:node-key` — it creates .dev.vars at mode 0600',
        },
        {
          name: PREVIEW_KEY_VAR,
          status: 'manual',
          action: 'run `npm run gen:node-key` first, then re-run setup',
        },
      ],
    }
  }

  if (hasVar(devVars, NODE_KEY_VAR)) {
    outcomes.push({ name: NODE_KEY_VAR, status: 'present' })
  } else {
    outcomes.push({
      name: NODE_KEY_VAR,
      status: 'manual',
      action:
        'run `npm run gen:node-key` — it also writes node-public-key.txt, ' +
        'which `terraviz init-node` needs in Phase 9',
    })
  }

  if (hasVar(devVars, PREVIEW_KEY_VAR)) {
    outcomes.push({ name: PREVIEW_KEY_VAR, status: 'present' })
    return { text: null, outcomes }
  }

  const { text, added } = appendVar(devVars, PREVIEW_KEY_VAR, generate())
  outcomes.push({ name: PREVIEW_KEY_VAR, status: added ? 'generated' : 'present' })
  return { text: added ? text : null, outcomes }
}
