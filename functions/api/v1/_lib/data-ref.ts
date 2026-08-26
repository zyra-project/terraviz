// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Shared `data_ref` parser.
 *
 * Both the manifest endpoint (which resolves `vimeo:` / `url:` /
 * `stream:` / `r2:` refs to playable URLs for the frontend's
 * video/image loaders) and the catalog read path (which surfaces
 * `tourJsonUrl` for tour rows) need to split a row's `data_ref`
 * into its scheme + value components. Lifting the splitter into
 * its own zero-dep module keeps either side of that pair from
 * pulling in the other's transitive imports — important on
 * Cloudflare Workers, where bundle size is bundle cost.
 */

export interface ParsedDataRef {
  scheme: string
  value: string
}

/**
 * Split `vimeo:123` / `url:https://...` / `r2:tours/foo.json` into
 * `{ scheme, value }`. Returns null on a malformed `data_ref` so
 * callers can produce a typed error instead of throwing.
 *
 * Splits on the *first* colon. Anything after that is opaque to
 * this function: a `url:` value that itself contains colons (port
 * numbers, IPv6, fragments) is preserved verbatim.
 */
export function parseDataRef(ref: string): ParsedDataRef | null {
  const idx = ref.indexOf(':')
  if (idx < 1) return null
  return { scheme: ref.slice(0, idx), value: ref.slice(idx + 1) }
}
