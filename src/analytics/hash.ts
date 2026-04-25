/**
 * Privacy-friendly hashing for free-text analytics signals.
 *
 * `browse_search` and any future Tier B event that wants to count
 * unique searches without ever transmitting the search string itself
 * uses this helper. Truncating the SHA-256 to 12 hex characters
 * (48 bits) keeps the value small enough that it can't be used as a
 * persistent identifier while still being collision-resistant for
 * realistic search-volume cardinalities (~10^7 distinct queries
 * before birthday-collision risk hits ~1%).
 *
 * The string is normalised before hashing so casing and surrounding
 * whitespace don't fracture the bucket — "Hurricane" and "hurricane "
 * collapse to the same hash.
 */

const HASH_LENGTH_HEX = 12

const PLACEHOLDER = '0'.repeat(HASH_LENGTH_HEX)

/**
 * Hash a free-text string for analytics. Returns 12 hex characters
 * of the lowercase-trimmed SHA-256.
 *
 * Returns the zero placeholder (`'000000000000'`) for any failure
 * mode — `crypto.subtle` missing (insecure context, ancient browser),
 * the digest call rejecting (restricted contexts, browser quirks),
 * or `TextEncoder` throwing. Callers commonly chain
 * `.then(emit)` without a `.catch`, so the contract is "always
 * resolves, never rejects" — we'd rather emit "unknown" than crash
 * the call site or surface an unhandled-rejection warning.
 */
export async function hashQuery(input: string): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return PLACEHOLDER
  }
  try {
    const normalized = input.trim().toLowerCase()
    const bytes = new TextEncoder().encode(normalized)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    return hex.slice(0, HASH_LENGTH_HEX)
  } catch {
    return PLACEHOLDER
  }
}
