/**
 * Single source of truth for ULID minting on the publisher write
 * paths. Crockford-base32, 26 chars, time-prefixed: the first 10
 * characters encode `Date.now()` so ids sort lexicographically by
 * insertion order, the last 16 are crypto-random.
 *
 * Webcrypto-friendly so the helper works on Cloudflare Workers,
 * Node, and Vitest's happy-dom environment without conditional
 * imports.
 *
 * The seed importer in `scripts/seed-catalog.ts` keeps its own
 * deterministic-ULID derivation (SHA-256 of the SOS id) so
 * re-seeds produce stable rows; the runtime helper here is the
 * one publisher mutations should reach for.
 */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newUlid(now: number = Date.now()): string {
  let timeStr = ''
  let t = BigInt(now)
  for (let i = 0; i < 10; i++) {
    timeStr = CROCKFORD_ALPHABET[Number(t & 31n)] + timeStr
    t >>= 5n
  }
  const rand = crypto.getRandomValues(new Uint8Array(10))
  let r = 0n
  for (const b of rand) r = (r << 8n) | BigInt(b)
  let randStr = ''
  for (let i = 0; i < 16; i++) {
    randStr = CROCKFORD_ALPHABET[Number(r & 31n)] + randStr
    r >>= 5n
  }
  return timeStr + randStr
}
