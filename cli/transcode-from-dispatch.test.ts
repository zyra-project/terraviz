/**
 * Unit tests for `cli/transcode-from-dispatch.ts`.
 *
 * The script itself drives the full transcode pipeline against a
 * real ffmpeg + R2 + publisher API — that's an end-to-end test
 * that lives on the GHA workflow runner, not in vitest. These
 * tests pin the two parts that are pure logic: the argv parser
 * and the env loader. Everything else is a wrapper around the
 * already-tested helpers in `cli/lib/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isCloudflareChallenge,
  loadServerEnv,
  parseArgs,
  postTranscodeComplete,
} from './transcode-from-dispatch'

const GOOD_DS = '01HXAAAAAAAAAAAAAAAAAAAAAA'
const GOOD_UP = '01HYAAAAAAAAAAAAAAAAAAAAAA'
// Source key embeds BOTH ids (PR #112 Copilot 3pd-followup —
// the prior one-level layout would let a workflow encode the
// wrong upload's bytes for a given dataset, since the key
// didn't carry the upload id).
const GOOD_KEY = `uploads/${GOOD_DS}/${GOOD_UP}/source.mp4`
const GOOD_DIGEST = 'sha256:' + 'a'.repeat(64)

describe('parseArgs', () => {
  it('parses a well-formed argv', () => {
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=${GOOD_KEY}`,
      `--source-digest=${GOOD_DIGEST}`,
    ])
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect(r.datasetId).toBe(GOOD_DS)
    expect(r.uploadId).toBe(GOOD_UP)
    expect(r.sourceKey).toBe(GOOD_KEY)
    expect(r.sourceDigest).toBe(GOOD_DIGEST)
    expect(r.workdir).toBe(`/tmp/terraviz-transcode/${GOOD_DS}-${GOOD_UP}`)
    expect(r.cleanupOnFailure).toBe(false)
  })

  it('rejects a malformed dataset id', () => {
    const r = parseArgs([
      `--dataset-id=not-a-ulid`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=${GOOD_KEY}`,
      `--source-digest=${GOOD_DIGEST}`,
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toMatch(/dataset-id/)
    }
  })

  it('rejects a malformed upload id', () => {
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=not-a-ulid`,
      `--source-key=${GOOD_KEY}`,
      `--source-digest=${GOOD_DIGEST}`,
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toMatch(/upload-id/)
    }
  })

  it('rejects a source key outside the uploads/ namespace', () => {
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=datasets/${GOOD_DS}/by-digest/sha256/abc/asset.mp4`,
      `--source-digest=${GOOD_DIGEST}`,
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toMatch(/source-key/)
    }
  })

  it('rejects a source key in the obsolete one-level layout', () => {
    // Pre-3pd-review3/A wrote `uploads/{dataset}/source.mp4` —
    // accepting that here would let a re-upload race against
    // itself (no per-upload prefix). The shape changed but a
    // misconfigured workflow could still try to call the runner
    // with the old layout. PR #112 Copilot 3pd-followup.
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=uploads/${GOOD_DS}/source.mp4`,
      `--source-digest=${GOOD_DIGEST}`,
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toMatch(/source-key/)
    }
  })

  it('rejects a source key whose dataset id segment doesn’t match --dataset-id', () => {
    // A misrouted dispatch could carry a key that's well-formed
    // but for a different dataset; without this check the runner
    // would happily encode the wrong bytes.
    const otherDs = '01HZAAAAAAAAAAAAAAAAAAAAAA'
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=uploads/${otherDs}/${GOOD_UP}/source.mp4`,
      `--source-digest=${GOOD_DIGEST}`,
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toContain(GOOD_DS)
    }
  })

  it('rejects a source key whose upload id segment doesn’t match --upload-id', () => {
    const otherUp = '01HZAAAAAAAAAAAAAAAAAAAAAA'
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=uploads/${GOOD_DS}/${otherUp}/source.mp4`,
      `--source-digest=${GOOD_DIGEST}`,
    ])
    expect('error' in r).toBe(true)
    if ('error' in r) {
      expect(r.error).toContain(GOOD_UP)
    }
  })

  it('rejects a malformed digest', () => {
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=${GOOD_KEY}`,
      `--source-digest=md5:abcdef`,
    ])
    expect('error' in r).toBe(true)
  })

  it('respects --workdir and --cleanup-on-failure', () => {
    const r = parseArgs([
      `--dataset-id=${GOOD_DS}`,
      `--upload-id=${GOOD_UP}`,
      `--source-key=${GOOD_KEY}`,
      `--source-digest=${GOOD_DIGEST}`,
      `--workdir=/var/transcode`,
      '--cleanup-on-failure',
    ])
    if ('error' in r) throw new Error(r.error)
    expect(r.workdir).toBe('/var/transcode')
    expect(r.cleanupOnFailure).toBe(true)
  })
})

describe('loadServerEnv', () => {
  const FULL_ENV = {
    TERRAVIZ_SERVER: 'https://terraviz.example.com/',
    CF_ACCESS_CLIENT_ID: 'id.access',
    CF_ACCESS_CLIENT_SECRET: 'secret',
  }

  it('strips the trailing slash from TERRAVIZ_SERVER', () => {
    const r = loadServerEnv(FULL_ENV)
    if ('error' in r) throw new Error(r.error)
    expect(r.server).toBe('https://terraviz.example.com')
  })

  it('errors when any env var is missing', () => {
    for (const key of Object.keys(FULL_ENV) as Array<keyof typeof FULL_ENV>) {
      const { [key]: _missing, ...rest } = FULL_ENV
      const r = loadServerEnv(rest)
      expect('error' in r).toBe(true)
      if ('error' in r) {
        expect(r.error).toContain(key)
      }
    }
  })
})

describe('isCloudflareChallenge', () => {
  // Trimmed-but-recognisable shape of the managed-challenge HTML
  // Cloudflare actually served when the WAF intercepted a real
  // GHA run (PR #112). Keeps both markers so either-marker
  // detection round-trips.
  const CHALLENGE_BODY = `<!DOCTYPE html><html><head><title>Just a moment...</title></head>` +
    `<body><script>window._cf_chl_opt = {cType: 'managed', cZone: 'terraviz.example.com'};` +
    `var a = document.createElement('script');a.src = '/cdn-cgi/challenge-platform/h/b/orchestrate/...';` +
    `</script></body></html>`

  it('detects the managed-challenge body', () => {
    expect(isCloudflareChallenge('text/html; charset=UTF-8', CHALLENGE_BODY)).toBe(true)
  })

  it('detects on the _cf_chl_opt marker alone', () => {
    const body = '<html>window._cf_chl_opt = {};</html>'
    expect(isCloudflareChallenge('text/html', body)).toBe(true)
  })

  it('detects on the challenge-platform marker alone', () => {
    const body = '<html>a.src = "/cdn-cgi/challenge-platform/...";</html>'
    expect(isCloudflareChallenge('text/html', body)).toBe(true)
  })

  it('returns false for JSON error envelopes from the publisher API', () => {
    const body = JSON.stringify({ error: 'not_transcoding', message: 'Row is not transcoding.' })
    expect(isCloudflareChallenge('application/json; charset=utf-8', body)).toBe(false)
  })

  it('returns false when content-type is missing', () => {
    expect(isCloudflareChallenge(null, CHALLENGE_BODY)).toBe(false)
  })

  it('returns false for plain HTML without challenge markers', () => {
    expect(isCloudflareChallenge('text/html', '<html><body>Hello</body></html>')).toBe(false)
  })
})

describe('postTranscodeComplete — response validation', () => {
  // PR #112 followup: a smoke-test run on a half-deployed
  // environment (PR's preview Worker doing the upload, but the
  // workflow's TERRAVIZ_SERVER still pointing at production
  // which was on a pre-3pd main) returned a 200 with the SPA's
  // index.html for /api/v1/publish/.../transcode-complete. The
  // CLI's `res.ok` check trusted the 2xx and logged "row
  // updated, transcoding cleared" — but the route handler had
  // never run, so the dataset row stayed `transcoding=1` and
  // the publisher portal was stuck. These tests pin the new
  // content-type + body-shape checks so the same class of
  // deploy-mismatch failure surfaces as a loud error in the
  // GHA log rather than a quiet lie.
  const ENV = {
    server: 'https://terraviz.example.org',
    accessClientId: 'cf-client-id',
    accessClientSecret: 'cf-client-secret',
  }
  const DATASET = '01KRPHXAAAAAAAAAAAAAAAAAAA'
  const UPLOAD = '01KRVJHSZBQKS9CS5GFWKPEHH0'
  const DIGEST = 'sha256:' + 'a'.repeat(64)

  let fetchSpy: ReturnType<typeof vi.fn>
  beforeEach(() => {
    fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function htmlResponse(body: string, status = 200): Response {
    return new Response(body, {
      status,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    })
  }
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  it('resolves cleanly on a 200 with the expected { dataset: ... } shape', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        dataset: { id: DATASET, transcoding: null, data_ref: 'r2:videos/...' },
        idempotent: false,
      }),
    )
    await expect(postTranscodeComplete(ENV, DATASET, UPLOAD, DIGEST)).resolves.toBeUndefined()
  })

  it('resolves on the idempotent retry shape ({ dataset, idempotent: true })', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse({
        dataset: { id: DATASET, transcoding: null },
        idempotent: true,
      }),
    )
    await expect(postTranscodeComplete(ENV, DATASET, UPLOAD, DIGEST)).resolves.toBeUndefined()
  })

  it('throws when a 200 response carries text/html (deploy missing the route)', async () => {
    // The exact failure that bit a real smoke-test: Pages
    // served the SPA's index.html as a 200 fallback for the
    // unmatched API path. The old code logged success here.
    fetchSpy.mockResolvedValue(
      htmlResponse(
        '<!DOCTYPE html><html><head><title>Terraviz</title></head><body>...</body></html>',
      ),
    )
    await expect(postTranscodeComplete(ENV, DATASET, UPLOAD, DIGEST)).rejects.toThrow(
      /non-JSON content-type "text\/html/,
    )
  })

  it('throws when the 200 response body is not parseable JSON despite the header', async () => {
    fetchSpy.mockResolvedValue(
      new Response('not actually json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(postTranscodeComplete(ENV, DATASET, UPLOAD, DIGEST)).rejects.toThrow(
      /not parseable JSON/,
    )
  })

  it('throws when the 200 JSON body is missing the dataset field', async () => {
    // A response from a wrong route handler that happens to
    // return JSON. Could be any number of misconfig scenarios
    // (a different route claimed this path, a stale build, etc.).
    fetchSpy.mockResolvedValue(jsonResponse({ unrelated: 'shape' }))
    await expect(postTranscodeComplete(ENV, DATASET, UPLOAD, DIGEST)).rejects.toThrow(
      /body shape doesn't match/,
    )
  })

  it("throws when the 200 JSON's dataset field isn't an object", async () => {
    // A 200 with `dataset: null` could come from a misbehaving
    // wrapper. Still a contract violation; should fail loud.
    fetchSpy.mockResolvedValue(jsonResponse({ dataset: null }))
    await expect(postTranscodeComplete(ENV, DATASET, UPLOAD, DIGEST)).rejects.toThrow(
      /body shape doesn't match/,
    )
  })
})
