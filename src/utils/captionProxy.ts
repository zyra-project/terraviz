/**
 * Caption-URL proxying helper.
 *
 * Caption (`.srt`) URLs served from `sos.noaa.gov` lack CORS headers
 * for browser/Tauri-webview consumers, so we route them through the
 * project's video-proxy worker. The proxy is opt-in by host: any
 * URL whose hostname is `sos.noaa.gov` (or a subdomain) goes through;
 * everything else is fetched directly.
 *
 * Centralised here so the host check is consistent across the SPA's
 * playback controller and the desktop downloader. Previously each
 * site used `url.includes('sos.noaa.gov')`, which CodeQL flagged as
 * "Incomplete URL substring sanitization" — an attacker-controlled
 * URL like `https://attacker.example/sos.noaa.gov/foo.srt` would
 * have been routed through the proxy too, even though it's not a
 * NOAA URL. Parsing via `URL` and matching on hostname closes that.
 *
 * The proxy base is `VITE_CAPTION_PROXY_BASE`-overridable (see
 * `src/config/endpoints.ts`) so a fork can run its own caption proxy.
 */

import { CAPTION_PROXY_BASE } from '../config/endpoints'

/** True when `url` is a well-formed http(s) URL whose hostname is
 * `sos.noaa.gov` or a subdomain. Returns false for any parse error
 * or non-http(s) scheme — callers should treat that as "fetch
 * directly" (which will then fail on its own merits if the URL is
 * truly broken). */
export function isSosNoaaCaptionUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'sos.noaa.gov' || host.endsWith('.sos.noaa.gov')
}

/** Wrap a caption URL through the video-proxy iff it's a NOAA URL.
 * Non-NOAA URLs are returned unchanged. */
export function proxyCaptionUrl(url: string): string {
  return isSosNoaaCaptionUrl(url)
    ? `${CAPTION_PROXY_BASE}?url=${encodeURIComponent(url)}`
    : url
}
