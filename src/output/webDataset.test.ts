// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, expect, it, vi } from 'vitest'
import { WebDatasetError, fetchWebDataset, imageCandidates, overlayFromRecord, pickVariant } from './webDataset'
import { parseColorScale } from '../types/color-scale'
import { toDisplayUnits } from '../types/unit-scale'

const ID = '01KQG611HF8YXJNRBEHT0757KT'

/** Production's record and manifest for this dataset, trimmed. */
const VIDEO_RECORD = {
  id: ID,
  slug: 'hurricane-season-2024',
  title: 'Hurricane Season - 2024',
  format: 'video/mp4',
  dataLink: `/api/v1/datasets/${ID}/manifest`,
  startTime: '2024-06-01T12:00:00Z',
  endTime: '2024-11-30T12:00:00Z',
}
const VIDEO_MANIFEST = {
  kind: 'video',
  id: ID,
  title: '',
  duration: 0,
  hls: `https://video.zyra-project.org/videos/${ID}/master.m3u8`,
  files: [],
}

const COLOR_SCALE = {
  stops: [
    { t: 0, rgba: [0, 0, 0, 0] },
    { t: 1, rgba: [255, 0, 0, 255] },
  ],
  vmin: 0,
  vmax: 50,
  units: 'mg m-2',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A node that answers the two paths this module asks for. */
function node(record: unknown, manifest: unknown, status = { record: 200, manifest: 200 }) {
  return vi.fn(async (url: string) =>
    url.endsWith('/manifest') ? json(manifest, status.manifest) : json(record, status.record),
  )
}

describe('fetchWebDataset', () => {
  it('builds the MirroredDataset a desktop output would be handed', async () => {
    const fetchFn = node(VIDEO_RECORD, VIDEO_MANIFEST)
    const { dataset: ds, alternateUrls } = await fetchWebDataset(ID, { frameWidth: 2048, fetchFn })
    expect(fetchFn).toHaveBeenCalledWith(`/api/v1/datasets/${ID}`, expect.anything())
    expect(fetchFn).toHaveBeenCalledWith(`/api/v1/datasets/${ID}/manifest`, expect.anything())
    expect(alternateUrls).toEqual([])
    expect(ds).toEqual({
      id: ID,
      url: VIDEO_MANIFEST.hls,
      kind: 'video',
      overlay: {
        boundingBox: { n: 90, s: -90, w: -180, e: 180 },
        lonOrigin: undefined,
        isFlippedInY: undefined,
        celestialBody: undefined,
        colorScale: undefined,
        datasetId: ID,
        datasetTitle: 'Hurricane Season - 2024',
      },
      startTime: '2024-06-01T12:00:00Z',
      endTime: '2024-11-30T12:00:00Z',
    })
  })

  it('takes a node on another origin when given one', async () => {
    const fetchFn = node(VIDEO_RECORD, VIDEO_MANIFEST)
    await fetchWebDataset(ID, { frameWidth: 2048, fetchFn, apiBase: 'https://node.example' })
    expect(fetchFn).toHaveBeenCalledWith(`https://node.example/api/v1/datasets/${ID}`, expect.anything())
  })

  it('plays a single file when the manifest has no HLS stream', async () => {
    const manifest = {
      ...VIDEO_MANIFEST,
      hls: '',
      files: [
        { quality: '720p', width: 1280, link: 'https://v.example/720.mp4' },
        { quality: '1080p', width: 1920, link: 'https://v.example/1080.mp4' },
      ],
    }
    const { dataset: ds } = await fetchWebDataset(ID, { frameWidth: 2048, fetchFn: node(VIDEO_RECORD, manifest) })
    expect(ds.url).toBe('https://v.example/1080.mp4')
  })

  it('falls back from the stream to the single file, as the main app does', async () => {
    const manifest = { ...VIDEO_MANIFEST, files: [{ quality: '1080p', width: 1920, link: 'https://v.example/1080.mp4' }] }
    const { dataset: ds, alternateUrls } = await fetchWebDataset(ID, { frameWidth: 2048, fetchFn: node(VIDEO_RECORD, manifest) })
    expect(ds.url).toBe(VIDEO_MANIFEST.hls)
    expect(alternateUrls).toEqual(['https://v.example/1080.mp4'])
  })

  it('picks the image variant the frame can use', async () => {
    const record = { ...VIDEO_RECORD, format: 'image/jpg', startTime: undefined, endTime: undefined }
    const manifest = {
      kind: 'image',
      variants: [
        { width: 4096, url: 'https://i.example/4096.jpg' },
        { width: 1024, url: 'https://i.example/1024.jpg' },
        { width: 2048, url: 'https://i.example/2048.jpg' },
      ],
      fallback: 'https://i.example/original.jpg',
    }
    const at = (w: number) => fetchWebDataset(ID, { frameWidth: w, fetchFn: node(record, manifest) })
    expect((await at(2048)).dataset.url).toBe('https://i.example/2048.jpg')
    expect((await at(1500)).dataset.url).toBe('https://i.example/2048.jpg')
    expect((await at(8192)).dataset.url).toBe('https://i.example/4096.jpg')
    const { dataset: ds, alternateUrls } = await at(2048)
    expect(ds.kind).toBe('image')
    expect(ds.startTime).toBeNull()
    // The rest, for when the picked one is not there.
    expect(alternateUrls).toEqual([
      'https://i.example/4096.jpg',
      'https://i.example/1024.jpg',
      'https://i.example/original.jpg',
    ])
  })

  it('falls back to the original image when there are no variants', async () => {
    const record = { ...VIDEO_RECORD, format: 'image/png' }
    const manifest = { kind: 'image', variants: [], fallback: 'https://i.example/original.png' }
    expect((await fetchWebDataset(ID, { frameWidth: 2048, fetchFn: node(record, manifest) })).dataset.url).toBe(
      'https://i.example/original.png',
    )
  })

  it('refuses a tour, which has nothing to put on a sphere', async () => {
    const fetchFn = node({ ...VIDEO_RECORD, format: 'tour/json' }, {})
    await expect(fetchWebDataset(ID, { frameWidth: 2048, fetchFn })).rejects.toMatchObject({ failure: 'not_playable' })
    // Refused before the manifest is asked for.
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('says not_found for a dataset the node does not have', async () => {
    const fetchFn = node({ error: 'not_found' }, {}, { record: 404, manifest: 200 })
    const err = await fetchWebDataset(ID, { frameWidth: 2048, fetchFn }).catch(e => e)
    expect(err).toBeInstanceOf(WebDatasetError)
    expect(err.failure).toBe('not_found')
  })

  it('says http for any other failure', async () => {
    const fetchFn = node(VIDEO_RECORD, {}, { record: 200, manifest: 503 })
    await expect(fetchWebDataset(ID, { frameWidth: 2048, fetchFn })).rejects.toMatchObject({ failure: 'http' })
  })

  it('refuses a manifest that disagrees with the record about what it is', async () => {
    const fetchFn = node(VIDEO_RECORD, { kind: 'image', variants: [] })
    await expect(fetchWebDataset(ID, { frameWidth: 2048, fetchFn })).rejects.toMatchObject({ failure: 'bad_response' })
  })

  it('refuses a manifest that names nothing to play', async () => {
    const fetchFn = node(VIDEO_RECORD, { ...VIDEO_MANIFEST, hls: '', files: [] })
    await expect(fetchWebDataset(ID, { frameWidth: 2048, fetchFn })).rejects.toMatchObject({ failure: 'not_playable' })
  })

  it('refuses a body that is not JSON', async () => {
    const fetchFn = vi.fn(async () => new Response('<!DOCTYPE html>', { status: 200 }))
    await expect(fetchWebDataset(ID, { frameWidth: 2048, fetchFn })).rejects.toMatchObject({ failure: 'bad_response' })
  })

  it('says network for a request that got no answer', async () => {
    // Said where it is known. A `TypeError` from a bug elsewhere must not
    // be reported as the network failing.
    const fetchFn = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(fetchWebDataset(ID, { frameWidth: 2048, fetchFn })).rejects.toMatchObject({ failure: 'network' })
  })

  it("refuses a record with no id rather than taking the address's", async () => {
    // The id is what the page reports as shown (`webTelemetry`), and it
    // must be one the node gave, never the text of the address.
    const fetchFn = node({ ...VIDEO_RECORD, id: undefined }, VIDEO_MANIFEST)
    await expect(fetchWebDataset(ID, { frameWidth: 2048, fetchFn })).rejects.toMatchObject({ failure: 'bad_response' })
  })

  it('escapes the id into the path', async () => {
    const fetchFn = node(VIDEO_RECORD, VIDEO_MANIFEST)
    await fetchWebDataset('a b', { frameWidth: 2048, fetchFn })
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/datasets/a%20b', expect.anything())
  })
})

describe('overlayFromRecord', () => {
  it('carries the geometry the record states', () => {
    const overlay = overlayFromRecord({
      id: 'X',
      title: 'T',
      boundingBox: { n: 50, s: 20, w: -130, e: -60 },
      lonOrigin: 180,
      isFlippedInY: true,
      celestialBody: 'Mars',
    })
    expect(overlay).toMatchObject({
      boundingBox: { n: 50, s: 20, w: -130, e: -60 },
      lonOrigin: 180,
      isFlippedInY: true,
      celestialBody: 'Mars',
    })
  })

  it('carries a palette only for a record that declares itself data-encoded', () => {
    // The same rule as the control side: a colorScale without
    // renderEncoding is inert, and must not reach a shader.
    expect(overlayFromRecord({ colorScale: COLOR_SCALE }).colorScale).toBeUndefined()
    const scale = parseColorScale(COLOR_SCALE)!
    expect(overlayFromRecord({ renderEncoding: 'data-luma', colorScale: COLOR_SCALE }).colorScale).toEqual(
      toDisplayUnits(scale),
    )
  })

  it('drops a palette that does not parse rather than drawing it', () => {
    expect(overlayFromRecord({ renderEncoding: 'data-luma', colorScale: { stops: 'red' } }).colorScale).toBeUndefined()
  })

  it('falls back to worldwide for a box that is not one', () => {
    expect(overlayFromRecord({ boundingBox: { n: 'north' } }).boundingBox).toEqual({ n: 90, s: -90, w: -180, e: 180 })
  })

  it('ignores a longitude origin that is not a number', () => {
    expect(overlayFromRecord({ lonOrigin: '180' }).lonOrigin).toBeUndefined()
  })
})

describe('imageCandidates', () => {
  const v = (width: number) => ({ width, url: `w${width}` })

  it('tries the pick, then wider narrowest first, then narrower widest first, then the original', () => {
    expect(imageCandidates([v(1024), v(8192), v(2048), v(4096)], 'orig', 2048)).toEqual([
      'w2048',
      'w4096',
      'w8192',
      'w1024',
      'orig',
    ])
  })

  it('falls back to the original alone, and drops a repeat of it', () => {
    expect(imageCandidates([], 'orig', 2048)).toEqual(['orig'])
    expect(imageCandidates([{ width: 2048, url: 'orig' }], 'orig', 2048)).toEqual(['orig'])
    expect(imageCandidates([], undefined, 2048)).toEqual([])
  })
})

describe('pickVariant', () => {
  it('is undefined with nothing to pick', () => {
    expect(pickVariant([], 2048)).toBeUndefined()
  })
})
