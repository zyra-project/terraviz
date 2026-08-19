/**
 * How a dataset's video is attached to the thumbnail scrub element.
 *
 * The bug this covers: `defaultLoadVideoScrub` called `loadStream`
 * unconditionally, which is an HLS URL's contract and not every
 * dataset's. A data-encoded video published *as uploaded* has no HLS
 * ladder — its manifest carries `hls: ""` and one progressive file — so
 * "Generate from this dataset's data" handed hls.js a JSON manifest to
 * parse as an m3u8. It failed for exactly the datasets that most need a
 * generated thumbnail.
 *
 * It went unnoticed because every existing scrub test injects
 * `loadVideoScrub`, so none of them ever reached the real loader. These
 * exercise the routing itself.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { attachScrubSource } from './asset-uploader'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../services/catalogSource', async (orig) => ({
  ...(await orig<typeof import('../../../services/catalogSource')>()),
  apiFetch,
}))

function fakeSvc() {
  return {
    loadStream: vi.fn(async () => {}),
    loadDirect: vi.fn(async () => {}),
  }
}
const manifestUrl = '/api/v1/datasets/01ABC/manifest'
const video = () => ({}) as HTMLVideoElement

function manifestResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body } as Response
}

describe('attachScrubSource', () => {
  beforeEach(() => apiFetch.mockReset())

  it('loads a progressive file when the manifest declares no HLS', async () => {
    // The as-uploaded data-encoded case, and the whole point.
    apiFetch.mockResolvedValue(manifestResponse({
      hls: '',
      files: [{ quality: 'source', link: 'https://cdn.example/asset.mp4' }],
    }))
    const svc = fakeSvc()
    await attachScrubSource(svc as never, manifestUrl, video())
    expect(svc.loadDirect).toHaveBeenCalledWith('https://cdn.example/asset.mp4', expect.anything())
    expect(svc.loadStream).not.toHaveBeenCalled()
  })

  it('loads the ladder when the manifest declares one', async () => {
    apiFetch.mockResolvedValue(manifestResponse({
      hls: 'https://cdn.example/master.m3u8',
      files: [{ quality: 'source', link: 'https://cdn.example/asset.mp4' }],
    }))
    const svc = fakeSvc()
    await attachScrubSource(svc as never, manifestUrl, video())
    expect(svc.loadStream).toHaveBeenCalledWith('https://cdn.example/master.m3u8', expect.anything())
    expect(svc.loadDirect).not.toHaveBeenCalled()
  })

  it('says so when a manifest offers neither a ladder nor a file', async () => {
    // Better than handing hls.js an empty string, which it treats as a
    // fatal network error and retries before rejecting.
    apiFetch.mockResolvedValue(manifestResponse({ hls: '', files: [] }))
    const svc = fakeSvc()
    await expect(attachScrubSource(svc as never, manifestUrl, video()))
      .rejects.toThrow(/no HLS stream and no playable file/)
  })

  it('routes a direct URL by its extension, without fetching a manifest', async () => {
    const ladder = fakeSvc()
    await attachScrubSource(ladder as never, 'https://cdn.example/master.m3u8', video())
    expect(ladder.loadStream).toHaveBeenCalled()

    const progressive = fakeSvc()
    await attachScrubSource(progressive as never, 'https://cdn.example/asset.mp4', video())
    expect(progressive.loadDirect).toHaveBeenCalled()

    expect(apiFetch).not.toHaveBeenCalled()
  })
})
