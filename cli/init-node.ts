/**
 * `terraviz init-node` — provision (or update) this node's identity.
 *
 * A fresh remote deploy has an empty `node_identity` table: the
 * migrations create it but never seed it, and `npm run db:seed` /
 * `npm run gen:node-key` only write the local dev D1. Until the row
 * exists, `/.well-known/terraviz.json` 503s and every publish /
 * `import-snapshot` fails (dataset inserts stamp `origin_node` from
 * this row, and the column is NOT NULL).
 *
 * This command writes the row through the publisher API
 * (`PUT /api/v1/publish/node-identity`), so it needs only the same
 * Cloudflare Access service token the operator already uses for
 * `import-snapshot` — no `wrangler` / direct D1 access. Run it once,
 * before importing or publishing.
 *
 * Usage:
 *   terraviz init-node --display-name="Terraviz — My Org" \
 *     --base-url=https://terraviz.my-org.org \
 *     [--contact=ops@my-org.org] [--description="..."] \
 *     [--public-key=ed25519:... | --public-key-file=node-public-key.txt]
 *
 * The public key defaults to `node-public-key.txt` (written by
 * `npm run gen:node-key`) when present. It is required the first time
 * a node is provisioned; on a later update it can be omitted to keep
 * the existing key.
 */

import { readFileSync } from 'node:fs'
import type { CommandContext } from './commands'
import { getString } from './lib/args'

const DEFAULT_PUBLIC_KEY_FILE = 'node-public-key.txt'

interface IdentityEnvelope {
  identity: {
    node_id: string
    display_name: string
    base_url: string
    contact_email: string | null
    public_key: string
  } | null
}

/** Pull the `ed25519:<b64>` wire key out of a node-public-key.txt
 *  file (first non-comment, non-blank line). Returns null if the
 *  file has no recognisable key line. */
function parsePublicKeyFile(contents: string): string | null {
  for (const raw of contents.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    return line
  }
  return null
}

export async function runInitNode(ctx: CommandContext): Promise<number> {
  const displayName = getString(ctx.args.options, 'display-name')
  const baseUrl = getString(ctx.args.options, 'base-url')
  const contact = getString(ctx.args.options, 'contact')
  const description = getString(ctx.args.options, 'description')
  const publicKeyFlag = getString(ctx.args.options, 'public-key')
  const publicKeyFileFlag = getString(ctx.args.options, 'public-key-file')

  if (!displayName || !baseUrl) {
    ctx.stderr.write(
      'Usage: terraviz init-node --display-name=<name> --base-url=<url> ' +
        '[--contact=<email>] [--description=<text>] ' +
        '[--public-key=<ed25519:...> | --public-key-file=<path>]\n',
    )
    return 2
  }

  // Resolve the public key: explicit flag wins; otherwise read the
  // file (an explicitly-named file that's missing is an error; the
  // default file being absent is fine — it just means "update, keep
  // the existing key", which the server validates).
  const reader = ctx.readFile ?? ((p: string) => readFileSync(p, 'utf-8'))
  let publicKey: string | undefined = publicKeyFlag
  if (!publicKey) {
    const path = publicKeyFileFlag ?? DEFAULT_PUBLIC_KEY_FILE
    try {
      const parsed = parsePublicKeyFile(reader(path))
      if (parsed) {
        publicKey = parsed
      } else if (publicKeyFileFlag) {
        ctx.stderr.write(`No ed25519 key line found in ${path}.\n`)
        return 2
      }
    } catch (e) {
      // Only fatal if the operator named the file explicitly.
      if (publicKeyFileFlag) {
        ctx.stderr.write(
          `Could not read ${path}: ${e instanceof Error ? e.message : String(e)}\n`,
        )
        return 2
      }
    }
  }

  const result = await ctx.client.setNodeIdentity<IdentityEnvelope>({
    display_name: displayName,
    base_url: baseUrl,
    description: description ?? null,
    contact_email: contact ?? null,
    public_key: publicKey,
  })

  if (!result.ok) {
    ctx.stderr.write(
      `Error (${result.status}): ${result.error}${result.message ? ` — ${result.message}` : ''}\n`,
    )
    if (result.errors?.length) {
      for (const e of result.errors) {
        ctx.stderr.write(`  ${e.field}: ${e.code} — ${e.message}\n`)
      }
    }
    if (result.status === 400 && result.errors?.some(e => e.field === 'public_key')) {
      ctx.stderr.write(
        '\nThis node has no identity yet, so a public key is required.\n' +
          'Run `npm run gen:node-key` first, then re-run with the generated\n' +
          'node-public-key.txt in the working directory (or pass --public-key).\n',
      )
    }
    return 1
  }

  if (ctx.args.options.json === true) {
    ctx.stdout.write(JSON.stringify(result.body, null, 2) + '\n')
  } else {
    const id = result.body.identity
    ctx.stdout.write(
      'Node identity provisioned.\n' +
        (id
          ? `  node_id:      ${id.node_id}\n` +
            `  display_name: ${id.display_name}\n` +
            `  base_url:     ${id.base_url}\n` +
            `  contact:      ${id.contact_email ?? '(none)'}\n`
          : ''),
    )
  }
  return 0
}
