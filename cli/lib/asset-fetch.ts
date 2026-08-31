// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * HTTP fetch helper for the Phase 3b asset migration. Pulls the
 * bytes of a thumbnail / legend / caption / color-table image from
 * the upstream NOAA-hosted URL so the migrate-r2-assets pump can
 * PUT them into R2 under `datasets/{id}/...`.
 *
 * Scope:
 *   - One URL → one HTTP GET → one `Uint8Array` of bytes.
 *   - Size-capped (default 50 MiB) so a runaway upstream doesn't
 *     OOM the migration. The SOS auxiliary assets are typically
 *     <500 KB each (thumbnails) and up to a few MB (legend
 *     panels); 50 MiB is comfortably above the realistic ceiling
 *     and well under Node's typical heap.
 *   - Records the canonical content-type (stripped of charset
 *     parameters) the server reports, with a sane fallback when
 *     the header is missing or generic — most NOAA CloudFront
 *     responses are well-typed but the SRT captions occasionally
 *     come back as `application/octet-stream`.
 *   - Records the extension derived from the URL path. The R2
 *     destination key uses this extension verbatim
 *     (`datasets/{id}/thumbnail.{ext}`), so we want the operator's
 *     intent (the file the URL points at) to win over a possibly-
 *     misconfigured server header.
 *
 * Failure modes (all surface as `AssetFetchError`):
 *   - Network throw → wrapped with the URL.
 *   - Non-2xx response → status preserved.
 *   - Response Content-Length exceeds `maxBytes` (pre-flight reject
 *     without reading the body).
 *   - Body exceeds `maxBytes` while streaming (we stop reading and
 *     reject).
 *
 * Dependency-injected `fetch` for tests. The production caller
 * passes nothing and gets the global `fetch` (Node 22 ships it
 * unflagged; the CLI runs under tsx with the same global).
 */

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024 // 50 MiB

/**
 * Mime-type → preferred file extension lookup for the asset
 * classes this migration cares about. The map is intentionally
 * small; the URL-extension path covers the long tail. The keys
 * are the canonical mime forms (no charset, no parameters).
 */
const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/vtt': 'vtt',
  'text/plain': 'txt',
  'application/x-subrip': 'srt',
}

/** Extension → mime lookup, used when the server's Content-Type
 * is missing or `application/octet-stream` and we need to pick
 * a sane mime for the R2 PUT. Inverse of `MIME_EXTENSION` plus
 * SRT (which gets a per-NOAA-server fallback). */
const EXTENSION_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
}

export class AssetFetchError extends Error {
  readonly status: number | null
  readonly url: string
  constructor(message: string, url: string, status: number | null = null) {
    super(message)
    this.name = 'AssetFetchError'
    this.url = url
    this.status = status
  }
}

export interface FetchedAsset {
  /** Raw response body. Callers that need a string decode via
   * `new TextDecoder('utf-8').decode(bytes)`. */
  bytes: Uint8Array
  /** Best-effort canonical content-type. Strips charset and any
   * other parameters. Falls back to a mime derived from the URL
   * extension when the server header is missing or generic. */
  contentType: string
  /** Number of bytes actually read (= bytes.length). */
  sizeBytes: number
  /** File extension derived from the URL path — lowercase, no
   * leading dot. Empty string when the URL has no recognizable
   * extension. The R2 destination key uses this verbatim. */
  extension: string
  /** Echoed back so callers piping through don't have to thread
   * the URL alongside the result. */
  sourceUrl: string
}

export interface FetchAssetOptions {
  url: string
  /** Bound the response body. Defaults to 50 MiB. */
  maxBytes?: number
  /** Test injection. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/**
 * Fetch a single asset URL with size + status guards.
 *
 * Resolves with the bytes, the server-canonical content-type
 * (or a URL-derived fallback), the URL-derived extension, and a
 * size tally. Rejects with `AssetFetchError` on any failure
 * mode listed in the header.
 */
export async function fetchAsset(options: FetchAssetOptions): Promise<FetchedAsset> {
  const { url } = options
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const fetchImpl = options.fetchImpl ?? fetch

  const extension = extensionFromUrl(url)

  let response: Response
  try {
    response = await fetchImpl(url, { method: 'GET' })
  } catch (e) {
    throw new AssetFetchError(
      `fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      url,
    )
  }

  if (!response.ok) {
    throw new AssetFetchError(
      `unexpected status ${response.status} ${response.statusText}`,
      url,
      response.status,
    )
  }

  const advertisedLen = response.headers.get('content-length')
  if (advertisedLen) {
    const n = Number(advertisedLen)
    if (Number.isFinite(n) && n > maxBytes) {
      throw new AssetFetchError(
        `Content-Length ${n} exceeds maxBytes ${maxBytes}`,
        url,
        response.status,
      )
    }
  }

  const bytes = await readBoundedBody(response, maxBytes, url)

  const contentType = resolveContentType(response.headers.get('content-type'), extension)

  return {
    bytes,
    contentType,
    sizeBytes: bytes.length,
    extension,
    sourceUrl: url,
  }
}

/**
 * Stream-read the response body until either EOF or the byte
 * counter exceeds `maxBytes`. Once over the cap, we throw — the
 * partial read is discarded, the operator sees a clear error,
 * and the operator can re-run with a larger `--max-bytes` (a
 * future flag on the migrate CLI; not exposed in 3b/D itself).
 */
async function readBoundedBody(
  response: Response,
  maxBytes: number,
  url: string,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) {
    // No streaming body (e.g. an empty response) — buffer the
    // whole thing via the standard helper. Sizes are bounded by
    // the content-length pre-check above in the common case.
    const buf = new Uint8Array(await response.arrayBuffer())
    if (buf.length > maxBytes) {
      throw new AssetFetchError(
        `response body ${buf.length} exceeds maxBytes ${maxBytes}`,
        url,
        response.status,
      )
    }
    return buf
  }

  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        total += value.length
        if (total > maxBytes) {
          // Free the reader cleanly so the underlying connection
          // can be reclaimed by the runtime.
          try {
            await reader.cancel()
          } catch {
            // Best-effort.
          }
          throw new AssetFetchError(
            `response body exceeded maxBytes ${maxBytes} while streaming`,
            url,
            response.status,
          )
        }
        chunks.push(value)
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released or cancelled — ignore.
    }
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Pick a canonical content-type from the server's header,
 * falling back to a URL-extension lookup when the header is
 * missing or `application/octet-stream` (common on NOAA
 * CloudFront for SRT files).
 *
 * Strips charset and any other media-type parameters; downstream
 * R2 PUTs use the canonical form on the `Content-Type` header.
 */
export function resolveContentType(header: string | null, extension: string): string {
  const canonical = canonicalContentType(header)
  if (canonical && canonical !== 'application/octet-stream') return canonical
  // Server didn't tell us, or told us "bytes" — derive from URL.
  const fromExt = extension && EXTENSION_MIME[extension]
  if (fromExt) return fromExt
  // Last resort. Honor any specific header we had even if it was
  // octet-stream; otherwise an empty string would force the caller
  // to default upstream.
  return canonical || 'application/octet-stream'
}

/** Strip parameters (`; charset=utf-8`) from a Content-Type
 * header and lowercase. Returns empty string for null/undefined. */
function canonicalContentType(header: string | null | undefined): string {
  if (!header) return ''
  const semi = header.indexOf(';')
  const base = semi >= 0 ? header.slice(0, semi) : header
  return base.trim().toLowerCase()
}

/**
 * Extract the file extension from a URL's path (no query, no
 * fragment). Lowercase, no leading dot. Returns empty string
 * when the URL has no recognizable extension (e.g. a path that
 * ends in a slash).
 *
 * Exported so the migrate-r2-assets pump can use the same shape
 * when constructing R2 keys before any fetch has run (e.g. for
 * the `--dry-run` plan summary).
 */
export function extensionFromUrl(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return ''
  }
  const lastSlash = pathname.lastIndexOf('/')
  const base = lastSlash >= 0 ? pathname.slice(lastSlash + 1) : pathname
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

/**
 * Pick the canonical mime for a known asset extension. Used by
 * downstream code that's stripping/replacing the extension on
 * the R2 key (e.g. when 3b/E's SRT→VTT conversion rewrites `.srt`
 * to `.vtt`). Returns `application/octet-stream` for anything
 * not in the explicit allow-list.
 */
export function mimeForExtension(extension: string): string {
  return EXTENSION_MIME[extension.toLowerCase()] ?? 'application/octet-stream'
}

/** Test export — the `MIME_EXTENSION` map (unused at runtime; kept
 * so a future caller that wants extension-from-mime can read it). */
export const __internal = { MIME_EXTENSION }
