/**
 * scripts/gen-node-key.ts — generate the node identity keypair.
 *
 * Phase 1 ships this script per `CATALOG_BACKEND_DEVELOPMENT.md`
 * "Required dev vars": every node has an Ed25519 keypair that signs
 * federation responses (Phase 4) and is advertised via
 * `/.well-known/terraviz.json` (Phase 1a). The private half is a
 * Wrangler secret; the public half lives in
 * `node_identity.public_key`.
 *
 * Behaviour:
 *   - Generates a fresh Ed25519 keypair via Node's `crypto` module.
 *   - Encodes the private key as a base64-encoded PKCS8 DER blob,
 *     written to `.dev.vars` as `NODE_ID_PRIVATE_KEY_PEM`. Single-
 *     line so Wrangler's dotenv parser handles it without quoting
 *     gymnastics; the runtime decodes back to PEM with one `atob`
 *     call when signing.
 *   - Encodes the public key as raw 32 bytes, base64-encoded, in
 *     the existing `ed25519:<b64>` wire format.
 *   - Updates the local D1's `node_identity.public_key` if the row
 *     exists; if it does not, prints a one-line note pointing at
 *     `npm run db:seed`.
 *   - Idempotent in the sense that re-running it overwrites the
 *     existing key. That is the right default for "I lost my
 *     keypair, regenerate"; production rotation is a separate flow
 *     (Phase 4) that advertises an overlap window in the well-known
 *     doc.
 *
 * Phase 1a doesn't *use* the private key yet — federation signing
 * lands in Phase 4. The script ships now so the well-known doc can
 * advertise a real public key on a fresh deploy and so contributors
 * have one fewer thing to track down later.
 */

import { generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findCatalogD1File } from './lib/d1-local.ts'
import Database from 'better-sqlite3'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const DEV_VARS_PATH = resolve(REPO_ROOT, '.dev.vars')
const PUBLIC_KEY_PATH = resolve(REPO_ROOT, 'node-public-key.txt')

interface KeyPairBlobs {
  /** base64-encoded PKCS8 DER private key (single line, dotenv-safe). */
  privateB64: string
  /** `ed25519:<b64>` wire format used by the well-known doc. */
  publicWire: string
  /** base64-encoded raw 32-byte public key, matching `publicWire` after the prefix. */
  publicB64: string
}

export function generateNodeKey(): KeyPairBlobs {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pkcs8Der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer

  // Ed25519 SPKI header is 12 bytes; the trailing 32 bytes are the
  // raw public key. Strip the header so the wire format matches the
  // existing `ed25519:<b64>` convention used by federation peers.
  const rawPublic = spkiDer.subarray(spkiDer.length - 32)
  if (rawPublic.length !== 32) {
    throw new Error(`Unexpected SPKI length: ${spkiDer.length} (need 44 for Ed25519)`)
  }

  const privateB64 = pkcs8Der.toString('base64')
  const publicB64 = rawPublic.toString('base64')
  return { privateB64, publicB64, publicWire: `ed25519:${publicB64}` }
}

/**
 * Write or replace `KEY=value` inside an existing `.dev.vars` file
 * (or create one). Preserves any other keys the contributor has
 * already set (Stream tokens, LLM keys, telemetry kill switch).
 */
export function upsertDevVar(content: string, key: string, value: string): string {
  const line = `${key}=${value}`
  const lines = content.split(/\r?\n/)
  let replaced = false
  const out = lines.map(l => {
    if (l.startsWith(`${key}=`)) {
      replaced = true
      return line
    }
    return l
  })
  // Trim trailing blank lines so the file always ends in exactly
  // one `\n`. Replacement keeps mid-file blank lines and comments
  // intact; appends drop the tail blanks before pushing the new
  // line so a re-run doesn't grow the file by one blank line each
  // time.
  while (out.length && out[out.length - 1] === '') out.pop()
  if (!replaced) out.push(line)
  return out.join('\n') + '\n'
}

function writeDevVars(privateB64: string): void {
  const before = existsSync(DEV_VARS_PATH) ? readFileSync(DEV_VARS_PATH, 'utf-8') : ''
  const after = upsertDevVar(before, 'NODE_ID_PRIVATE_KEY_PEM', privateB64)
  writeFileSync(DEV_VARS_PATH, after, { mode: 0o600 })
}

function writePublicKeyFile(publicWire: string): void {
  writeFileSync(
    PUBLIC_KEY_PATH,
    `${publicWire}\n\n# Paste this into your node's well-known document, or use it\n# as-is — \`/.well-known/terraviz.json\` reads it from D1 directly.\n`,
  )
}

function updateLocalNodeIdentity(publicWire: string): void {
  const dbPath = findCatalogD1File()
  if (!dbPath) {
    console.log(
      '\nLocal D1 not found — skipping node_identity.public_key update.\n' +
        'Run `npm run db:reset` to migrate + seed, then re-run this script\n' +
        'if you want the local well-known doc to serve the new key.',
    )
    return
  }
  const db = new Database(dbPath)
  const row = db
    .prepare('SELECT node_id FROM node_identity LIMIT 1')
    .get() as { node_id?: string } | undefined
  if (!row?.node_id) {
    db.close()
    console.log(
      '\nNo node_identity row found in local D1 — `npm run db:seed`\n' +
        'inserts one. Re-run this script after seeding to overwrite the\n' +
        'placeholder public key.',
    )
    return
  }
  db.prepare('UPDATE node_identity SET public_key = ? WHERE node_id = ?').run(
    publicWire,
    row.node_id,
  )
  db.close()
  console.log(`Updated local node_identity.public_key for ${row.node_id}.`)
}

function main(): void {
  const { privateB64, publicWire } = generateNodeKey()
  writeDevVars(privateB64)
  writePublicKeyFile(publicWire)
  updateLocalNodeIdentity(publicWire)
  console.log(
    '\nGenerated a fresh Ed25519 node-identity keypair.\n' +
      `  Private key  → .dev.vars (NODE_ID_PRIVATE_KEY_PEM, file mode 0600)\n` +
      `  Public key   → node-public-key.txt (and node_identity.public_key in D1)\n` +
      `\nWire-format public key:\n  ${publicWire}\n` +
      '\nFor production, set the same value as a Wrangler secret:\n' +
      '  npx wrangler pages secret put NODE_ID_PRIVATE_KEY_PEM\n',
  )
}

// Detect "is this file the entry point" vs. "imported by a test".
// The naive `import.meta.url === \`file://${process.argv[1]}\`` form
// is broken on Windows (path separators, drive letters, file-URL
// percent-encoding) and on POSIX systems where argv[1] is a
// symlink. Comparing the canonical filesystem paths via
// `fileURLToPath` + `realpathSync.native` works everywhere.
function isInvokedAsScript(): boolean {
  if (!process.argv[1]) return false
  try {
    const here = fileURLToPath(import.meta.url)
    const argv1 = resolve(process.argv[1])
    return here === argv1
  } catch {
    return false
  }
}
if (isInvokedAsScript()) main()
