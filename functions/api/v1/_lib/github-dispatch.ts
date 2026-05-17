/**
 * GitHub repository_dispatch helper — Phase 3pd.
 *
 * Fires a `repository_dispatch` event against
 * `https://api.github.com/repos/{owner}/{repo}/dispatches` so a
 * GitHub Actions workflow with `on: repository_dispatch: types:
 * [transcode-hls]` runs in response. This is the trigger half of
 * the video-upload pipeline — the upload itself lands in R2 via the
 * presigned PUT in `/asset`, the /complete handler verifies the
 * digest, and *this* helper kicks off the async transcode workflow
 * by handing the dataset id off to GitHub Actions.
 *
 * The repo is never modified — `repository_dispatch` is a pure
 * event API, not a push or PR. `git log` stays untouched. The PAT
 * stored in `GITHUB_DISPATCH_TOKEN` needs `repo` scope (so it can
 * read the workflow file) and write access to actions/workflows.
 *
 * Local dev sets `MOCK_GITHUB_DISPATCH=true` so the contributor
 * walkthrough works without a PAT. In mock mode, the helper
 * resolves successfully without contacting api.github.com — the
 * publisher gets the "Transcoding…" badge from the dataset row's
 * `transcoding=1` flag, but no workflow actually runs.
 * `mock_github_dispatch_unsafe` 500 refusal on non-loopback
 * hostnames keeps a production misconfig from accepting fake
 * dispatches.
 *
 * Errors map to the same typed classes the rest of the storage
 * helpers use — `ConfigurationError` for missing env, `UpstreamError`
 * for non-2xx from GitHub. The /complete route handler maps both
 * to 503 / 502 respectively, parallel to how `r2-store` /
 * `stream-store` errors land.
 */

import { ConfigurationError, UpstreamError } from './errors'

export interface GitHubDispatchEnv {
  GITHUB_OWNER?: string
  GITHUB_REPO?: string
  GITHUB_DISPATCH_TOKEN?: string
  MOCK_GITHUB_DISPATCH?: string
}

export interface TranscodeDispatchPayload {
  /** Dataset id the workflow will encode for. */
  dataset_id: string
  /** Upload id (asset_uploads row ULID). The workflow uses this
   *  to scope the output bundle to a versioned R2 prefix
   *  (`videos/{dataset_id}/{upload_id}/...`) and to POST back to
   *  `/transcode-complete` — the route handler reconstructs
   *  `data_ref` from the route id + this upload id so a misrouted
   *  workflow can't point the row at the wrong bundle. */
  upload_id: string
  /** R2 key of the source MP4
   *  (`uploads/{dataset_id}/{upload_id}/source.mp4`; built by
   *  `buildVideoSourceKey` in `r2-store.ts`). The runner pins
   *  it against `--dataset-id` / `--upload-id` before fetching. */
  source_key: string
  /** SHA-256 of the source bytes — workflow re-verifies before encoding. */
  source_digest: string
}

/** GitHub's `repository_dispatch` event_type. Must match the
 *  workflow's `on: repository_dispatch: types:` entry. */
export const TRANSCODE_HLS_EVENT_TYPE = 'transcode-hls'

/**
 * Send the dispatch. Returns `{ ok: true }` on success, throws
 * `ConfigurationError` if the env isn't wired, `UpstreamError` if
 * GitHub returns non-2xx.
 *
 * Mock mode: resolves immediately, doesn't touch the network.
 * The /complete handler still stamps `transcoding=1` so the portal
 * UX can be exercised end-to-end against a deploy without the GHA
 * workflow being wired.
 */
export async function dispatchTranscode(
  env: GitHubDispatchEnv,
  payload: TranscodeDispatchPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; mocked: boolean }> {
  if (env.MOCK_GITHUB_DISPATCH === 'true') {
    return { ok: true, mocked: true }
  }
  if (!env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_DISPATCH_TOKEN) {
    throw new ConfigurationError(
      'GitHub dispatch is not configured. Set GITHUB_OWNER, GITHUB_REPO, ' +
        'and GITHUB_DISPATCH_TOKEN (or MOCK_GITHUB_DISPATCH=true for local dev).',
    )
  }
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`
  const body = JSON.stringify({
    event_type: TRANSCODE_HLS_EVENT_TYPE,
    client_payload: payload,
  })
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'terraviz-publisher-api',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new UpstreamError(`GitHub dispatch fetch failed: ${message}`)
  }
  // The dispatch endpoint returns 204 No Content on success.
  if (res.status === 204) {
    return { ok: true, mocked: false }
  }
  // Surface a readable error. Body is typically `{"message": "...",
  // "documentation_url": "..."}`.
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    /* ignore — we'll fall back to the status code */
  }
  throw new UpstreamError(
    `GitHub dispatch returned ${res.status}: ${detail || 'no body'}`,
    res.status,
  )
}
