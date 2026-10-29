// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The web mode's composition, driven through the real `datasetMirror`
 * with loads resolved by hand, so the races are the real ones.
 */

import { describe, expect, it, vi } from 'vitest'
import { RETRY_DELAYS_MS, createWebOutput, followAddress, framebufferFor, isRetryable } from './webOutput'
import { createDatasetMirror, type MediaLoader, type MediaSource } from './datasetMirror'
import { WebDatasetError, type WebDataset } from './webDataset'
import { readWebSettings } from './webMode'
import { viewParams } from './webCamera'
import type { SyncTarget } from './outputSync'
import type { MirroredDataset } from '../services/multiOutput/protocol'
import { until } from '../test-utils'

const T0 = 1_761_288_000_000

function dataset(id: string, url = `https://cdn.example/${id}.m3u8`): MirroredDataset {
  return { id, url, kind: 'video', overlay: { datasetId: id }, startTime: null, endTime: null }
}

function videoTarget(over: Partial<SyncTarget> = {}): SyncTarget {
  return {
    readyState: 4,
    duration: 1000,
    paused: false,
    seeking: false,
    currentTime: 0,
    playbackRate: 1,
    play: vi.fn(),
    pause: vi.fn(),
    ...over,
  }
}

/** A loader resolved by hand, tagged by URL. */
function deferredLoader() {
  const pending: { url: string; resolve: () => void; reject: (e: Error) => void }[] = []
  const disposed: string[] = []
  const elements = new Map<string, { tag: string }>()
  const videos = new Map<string, SyncTarget>()
  /** The period each stream states, as `HLSService.playlistDurationS` would. */
  const periods = new Map<string, number>()
  const loader: MediaLoader = {
    load: ds =>
      new Promise<MediaSource>((resolve, reject) => {
        const element = { tag: ds.url }
        const video = videoTarget()
        elements.set(ds.url, element)
        videos.set(ds.url, video)
        pending.push({
          url: ds.url,
          resolve: () =>
            resolve({
              kind: 'video',
              element: element as never,
              video,
              loopS: () => periods.get(ds.url) ?? null,
              dispose: () => disposed.push(ds.url),
            }),
          reject,
        })
      }),
  }
  const resolve = (url: string) => pending.find(p => p.url === url)!.resolve()
  const reject = (url: string) => pending.find(p => p.url === url)!.reject(new Error('404'))
  return { loader, pending, disposed, elements, videos, periods, resolve, reject }
}

function harness(
  opts: { fetchDataset?: (id: string) => Promise<WebDataset>; motion?: { reduced: boolean } } = {},
) {
  const media = deferredLoader()
  const mirror = createDatasetMirror({ loader: media.loader })
  const layers: unknown[][] = []
  const params: unknown[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  let now = T0
  let mono = 0
  const telemetry = { datasetShown: vi.fn(), datasetFailed: vi.fn(), streamError: vi.fn() }
  const loadTelemetry = vi.fn(async () => telemetry)
  /** The old names, read by the tests below. */
  const report = { shown: telemetry.datasetShown, failed: telemetry.datasetFailed }
  const markDirty = vi.fn()
  const fetchDataset = vi.fn(
    opts.fetchDataset ?? (async (id: string): Promise<WebDataset> => ({ dataset: dataset(id), alternateUrls: [] })),
  )
  const out = createWebOutput({
    mirror,
    scene: {
      size: { width: 2048, height: 1024 },
      setLayers: l => layers.push([...l]),
      setFramebufferWidth: vi.fn(),
      setParams: p => params.push(p),
    },
    setDebug: vi.fn(),
    setFill: vi.fn(),
    displaySizePx: () => ({ width: 2048, height: 1024 }),
    markDirty,
    fetchDataset,
    loadTelemetry,
    nowMs: () => now,
    monotonicMs: () => mono,
    reducedMotion: () => opts.motion?.reduced ?? false,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false })
      return timers.length
    },
    clearTimer: handle => {
      timers[(handle as number) - 1].cleared = true
    },
  })
  const show = (hash: string) => out.apply(readWebSettings('', hash))
  /** The element the scene was last handed, or null for the live Earth. */
  const onScreen = () => {
    const last = layers[layers.length - 1] as { element: { tag: string } }[] | undefined
    return last && last.length ? last[0].element.tag : null
  }
  return {
    out,
    mirror,
    media,
    layers,
    params,
    timers,
    markDirty,
    fetchDataset,
    report,
    telemetry,
    loadTelemetry,
    show,
    onScreen,
    advance(ms: number) {
      now += ms
      mono += ms
    },
  }
}

const url = (id: string) => `https://cdn.example/${id}.m3u8`

describe('the races review found', () => {
  it('ends on the dataset gone back to, not on the video a late load released', async () => {
    const h = harness()
    h.show('#dataset=X')
    await until(() => h.media.pending.length === 1, 'X to start loading')
    h.media.resolve(url('X'))
    await until(() => h.onScreen() === url('X'), 'X on screen')

    h.show('#dataset=A')
    await until(() => h.media.pending.length === 2, 'A to start loading')
    const applies = vi.spyOn(h.mirror, 'apply')
    h.show('#dataset=X')
    await until(() => applies.mock.calls.some(([d]) => d?.id === 'X'), 'the mirror to be given X again')
    h.media.resolve(url('A'))
    await until(() => h.media.disposed.includes(url('A')), 'A released')

    expect(h.onScreen()).toBe(url('X'))
    expect(h.media.disposed).not.toContain(url('X'))
  })

  it('leaves the live Earth up when told to show nothing during a load', async () => {
    const h = harness()
    h.show('#dataset=A')
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.show('')
    h.media.resolve(url('A'))
    await until(() => h.media.disposed.includes(url('A')), 'A released')
    expect(h.onScreen()).toBeNull()
    expect(h.mirror.current()).toBeNull()
  })
})

describe('guards that review found no test held', () => {
  it('redraws a load that lands after the address moved on', async () => {
    // A's load is the newest the mirror was given, so it installs and
    // releases X, though the address has moved on to B, whose fetch has
    // not answered. Redrawn only for the newest request, the scene kept
    // sampling X's released video.
    let releaseB: (() => void) | undefined
    const h = harness({
      fetchDataset: async id => {
        if (id === 'B') await new Promise<void>(resolve => (releaseB = resolve))
        return { dataset: dataset(id), alternateUrls: [] }
      },
    })
    h.show('#dataset=X')
    await until(() => h.media.pending.length === 1, 'X to start loading')
    h.media.resolve(url('X'))
    await until(() => h.onScreen() === url('X'), 'X on screen')
    h.show('#dataset=A')
    await until(() => h.media.pending.length === 2, 'A to start loading')
    h.show('#dataset=B')
    await until(() => releaseB !== undefined, "B's fetch to be held")
    h.media.resolve(url('A'))
    await until(() => h.media.disposed.includes(url('X')), 'X released')
    expect(h.onScreen()).toBe(url('A'))
  })

  it("stops trying an image's sizes once the address has moved on", async () => {
    const image = (u: string): MirroredDataset => ({ ...dataset('I', u), kind: 'image' })
    const h = harness({
      fetchDataset: async id =>
        id === 'I'
          ? { dataset: image('https://i.example/2048.jpg'), alternateUrls: ['https://i.example/orig.jpg'] }
          : { dataset: dataset(id), alternateUrls: [] },
    })
    h.show('#dataset=I')
    await until(() => h.media.pending.length === 1, 'the picked size to start loading')
    h.show('#dataset=B')
    await until(() => h.media.pending.length === 2, 'B to start loading')
    h.media.reject('https://i.example/2048.jpg')
    h.media.resolve(url('B'))
    // B either installs, or is released because a later load superseded
    // it: the end of the chain either way, so a wrong walk fails on the
    // assertions below rather than by timing out.
    await until(
      () => h.onScreen() === url('B') || h.media.disposed.includes(url('B')),
      "B's load to settle",
    )
    expect(h.media.pending.map(p => p.url)).not.toContain('https://i.example/orig.jpg')
    expect(h.onScreen()).toBe(url('B'))
  })

  it('goes to the live Earth when the dataset is found but will not load, and retries', async () => {
    // The fetch answers; the media itself fails. That is the case the
    // convergence rule is for, and the earlier tests failed only the fetch.
    const h = harness()
    h.show('#dataset=X')
    await until(() => h.media.pending.length === 1, 'X to start loading')
    h.media.resolve(url('X'))
    await until(() => h.onScreen() === url('X'), 'X on screen')

    h.show('#dataset=A')
    await until(() => h.media.pending.length === 2, 'A to start loading')
    h.media.reject(url('A'))
    await until(() => h.timers.length === 1, 'a retry to be scheduled')
    expect(h.onScreen()).toBeNull()
    expect(h.mirror.current()).toBeNull()

    h.timers[0].fn()
    await until(() => h.media.pending.length === 3, 'A to load again')
    h.media.pending[2].resolve()
    await until(() => h.onScreen() === url('A'), 'A on screen')
  })
})

describe('converging on what every copy can show', () => {
  it('goes to the live Earth when the new dataset does not exist, and does not retry', async () => {
    const h = harness({
      fetchDataset: async id => {
        if (id === 'B') throw new WebDatasetError('not_found', 'no B')
        return { dataset: dataset(id), alternateUrls: [] }
      },
    })
    h.show('#dataset=A')
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.media.resolve(url('A'))
    await until(() => h.onScreen() === url('A'), 'A on screen')

    h.show('#dataset=B')
    await until(() => h.mirror.current() === null, 'the live Earth')
    expect(h.onScreen()).toBeNull()
    expect(h.timers).toEqual([])
  })

  it('retries a failure that may pass, and shows the dataset when it does', async () => {
    let fails = 1
    const h = harness({
      fetchDataset: async id => {
        if (fails-- > 0) throw new WebDatasetError('http', 'HTTP 503')
        return { dataset: dataset(id), alternateUrls: [] }
      },
    })
    h.show('#dataset=A')
    await until(() => h.timers.length === 1, 'a retry to be scheduled')
    expect(h.timers[0].ms).toBe(RETRY_DELAYS_MS[0])
    h.timers[0].fn()
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.media.resolve(url('A'))
    await until(() => h.onScreen() === url('A'), 'A on screen')
  })

  it('backs off, and keeps trying at the last interval', async () => {
    const h = harness({ fetchDataset: async () => Promise.reject(new TypeError('Failed to fetch')) })
    h.show('#dataset=A')
    for (let i = 0; i < RETRY_DELAYS_MS.length + 1; i++) {
      await until(() => h.timers.length === i + 1, `retry ${i + 1}`)
      h.timers[i].fn()
    }
    await until(() => h.timers.length === RETRY_DELAYS_MS.length + 2, 'the next retry')
    const last = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]
    expect(h.timers.map(t => t.ms)).toEqual([...RETRY_DELAYS_MS, last, last])
  })

  it('stops retrying once the address has moved on', async () => {
    const h = harness({
      fetchDataset: async id => {
        if (id === 'A') throw new WebDatasetError('http', 'HTTP 503')
        return { dataset: dataset(id), alternateUrls: [] }
      },
    })
    h.show('#dataset=A')
    await until(() => h.timers.length === 1, 'a retry to be scheduled')
    h.show('#dataset=B')
    expect(h.timers[0].cleared).toBe(true)
  })

  it("tries an image's other sizes before giving up", async () => {
    const image = (u: string): MirroredDataset => ({ ...dataset('I', u), kind: 'image' })
    const h = harness({
      fetchDataset: async () => ({ dataset: image('https://i.example/2048.jpg'), alternateUrls: ['https://i.example/orig.jpg'] }),
    })
    h.show('#dataset=I')
    await until(() => h.media.pending.length === 1, 'the picked size to start loading')
    h.media.reject('https://i.example/2048.jpg')
    await until(() => h.media.pending.length === 2, 'the original to start loading')
    h.media.resolve('https://i.example/orig.jpg')
    await until(() => h.onScreen() === 'https://i.example/orig.jpg', 'the original on screen')
    expect(h.timers).toEqual([])
  })

  it('retries anything but a dataset the node does not have or cannot show', () => {
    expect(isRetryable(new Error('Failed to load image'))).toBe(true)
    expect(isRetryable(new WebDatasetError('http', 'HTTP 502'))).toBe(true)
    expect(isRetryable(new WebDatasetError('not_found', 'no'))).toBe(false)
    expect(isRetryable(new WebDatasetError('not_playable', 'a tour'))).toBe(false)
    // A body cut short, or a proxy's error page served as 200.
    expect(isRetryable(new WebDatasetError('bad_response', 'not JSON'))).toBe(true)
  })
})

describe('applying the address', () => {
  it('sizes the frame by the address, else by the picture as shown', () => {
    expect(framebufferFor(readWebSettings('?width=4096', ''), { width: 1024, height: 512 })).toBe(4096)
    expect(framebufferFor(readWebSettings('', ''), { width: 1024, height: 512 })).toBe(1024)
    // Letterboxed, a page wider than 2:1 shows a picture twice its height
    // wide; stretched, it shows one the page's width.
    expect(framebufferFor(readWebSettings('', ''), { width: 4096, height: 1024 })).toBe(2048)
    expect(framebufferFor(readWebSettings('?fit=fill', ''), { width: 4096, height: 1024 })).toBe(4096)
    // Stretched onto a square face, the frame has to cover its height.
    expect(framebufferFor(readWebSettings('?fit=fill', ''), { width: 1024, height: 1024 })).toBe(2048)
    expect(framebufferFor(readWebSettings('', ''), { width: 1024, height: 1024 })).toBe(1024)
  })

  it('shows the first reading of the address at once', () => {
    // A copy opening mid-session shows what the others show, not a fly-in.
    const h = harness()
    h.show('#rotation=90&lat=-60&zoom=2')
    expect(h.params).toEqual([viewParams({ latDeg: -60, lonDeg: 90, zoom: 2 })])
  })
})

describe('moving the camera', () => {
  /** Steer `ms` of 60 Hz frames. */
  function frames(h: ReturnType<typeof harness>, ms: number) {
    for (let t = 0; t < ms; t += 16) {
      h.advance(16)
      h.out.steer()
    }
  }

  it('moves to a later view at the moving-content pace, then stops asking for frames', () => {
    const h = harness()
    h.show('#rotation=0')
    h.show('#rotation=30&lat=-30')
    // Nothing jumps on the change itself.
    expect(h.params).toHaveLength(1)
    expect(h.out.cameraMoving()).toBe(true)
    // On its way, the view moves every frame and the loop paces the
    // drawing like a playing video, so no frame is demanded on top.
    h.markDirty.mockClear()
    h.advance(16)
    h.out.steer()
    const first = h.params.at(-1)
    expect(first).not.toEqual(viewParams({ latDeg: -30, lonDeg: 30, zoom: 0 }))
    expect(first).not.toEqual(viewParams({ latDeg: 0, lonDeg: 0, zoom: 0 }))
    frames(h, 1000)
    expect(h.markDirty).not.toHaveBeenCalled()
    frames(h, 10_000)
    // Arrived: the resting view is asked for at once, then a still
    // picture goes back to the 1 Hz floor.
    expect(h.params.at(-1)).toEqual(viewParams({ latDeg: -30, lonDeg: 30, zoom: 0 }))
    expect(h.out.cameraMoving()).toBe(false)
    expect(h.markDirty).toHaveBeenCalledTimes(1)
    const count = h.params.length
    h.markDirty.mockClear()
    frames(h, 500)
    expect(h.params).toHaveLength(count)
    expect(h.markDirty).not.toHaveBeenCalled()
  })

  it('sets the view at once for a viewer who asked for reduced motion', () => {
    const h = harness({ motion: { reduced: true } })
    h.show('#rotation=0')
    h.show('#lat=-90')
    expect(h.params.at(-1)).toEqual(viewParams({ latDeg: -90, lonDeg: 0, zoom: 0 }))
    h.markDirty.mockClear()
    frames(h, 100)
    expect(h.markDirty).not.toHaveBeenCalled()
  })

  it('leaves the camera alone when a # change moved something else', () => {
    // Mid-motion, with reduced motion turned on since: aiming again at the
    // same view would set it at once and show here (found in review: the
    // first version of this test passed without the check it names).
    const motion = { reduced: false }
    const h = harness({ motion })
    h.show('#rotation=0')
    h.show('#rotation=30')
    frames(h, 200)
    const count = h.params.length
    motion.reduced = true
    h.show('#rotation=30&t=12&debug=1')
    expect(h.params).toHaveLength(count)
    expect(h.params.at(-1)).not.toEqual(viewParams({ latDeg: 0, lonDeg: 30, zoom: 0 }))
  })
})

describe('reporting what reached the glass (webTelemetry)', () => {
  // Telemetry is off unless the address turns it on, so every address
  // here that expects a report says `telemetry=1`.
  it('reports nothing, and loads no telemetry, unless the address turns it on', async () => {
    const h = harness()
    h.show('#dataset=A')
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.media.resolve(url('A'))
    await until(() => h.onScreen() === url('A'), 'A on screen')
    h.out.reportStreamError(new Error('networkError: fragLoadError'))
    await new Promise(r => setTimeout(r, 0))

    expect(h.loadTelemetry).not.toHaveBeenCalled()
    expect(h.telemetry.datasetShown).not.toHaveBeenCalled()
    expect(h.telemetry.streamError).not.toHaveBeenCalled()
  })

  it('reports a dataset once it is on screen, with how long it took', async () => {
    const h = harness()
    h.show('#dataset=A&telemetry=1')
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.advance(750)
    h.media.resolve(url('A'))
    await until(() => h.report.shown.mock.calls.length === 1, 'the report')

    // The record the node returned, not the address's text.
    expect(h.report.shown.mock.calls[0][0]).toMatchObject({ id: 'A' })
    expect(h.report.shown.mock.calls[0][1]).toBe(750)
    expect(h.report.failed).not.toHaveBeenCalled()
    expect(h.loadTelemetry).toHaveBeenCalledTimes(1)
  })

  it('stops reporting as soon as a # change turns it off', async () => {
    const h = harness()
    h.show('#dataset=A&telemetry=1')
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.media.resolve(url('A'))
    await until(() => h.report.shown.mock.calls.length === 1, "A's report")

    h.show('#dataset=B&telemetry=0')
    await until(() => h.media.pending.length === 2, 'B to start loading')
    h.media.resolve(url('B'))
    await until(() => h.onScreen() === url('B'), 'B on screen')
    h.out.reportStreamError(new Error('networkError: fragLoadError'))
    await new Promise(r => setTimeout(r, 0))

    expect(h.report.shown.mock.calls.map(([d]) => d.id)).toEqual(['A'])
    expect(h.telemetry.streamError).not.toHaveBeenCalled()
  })

  // Two checks, and each covers a race the other cannot.
  it('drops a report made while on if the address turned it off before telemetry arrived', async () => {
    const h = harness()
    let arrive!: () => void
    h.loadTelemetry.mockImplementation(() => new Promise(r => (arrive = () => r(h.telemetry))))
    h.show('#telemetry=1')
    h.out.reportStreamError(new Error('made while on'))
    h.show('#telemetry=0')
    arrive()
    // The anchor: a report made now, with it on again, does arrive, so
    // the one before it had every chance to.
    await new Promise(r => setTimeout(r, 0))
    h.show('#telemetry=1')
    h.out.reportStreamError(new Error('made and delivered while on'))
    await until(() => h.telemetry.streamError.mock.calls.length >= 1, 'the later report')

    expect(h.telemetry.streamError.mock.calls.map(([e]) => (e as Error).message)).toEqual([
      'made and delivered while on',
    ])
  })

  it('drops a report made while off even if the address turns it on before delivery', async () => {
    const h = harness()
    h.show('#telemetry=1')
    await until(() => h.loadTelemetry.mock.calls.length === 1, 'telemetry to load')
    h.show('#telemetry=0')
    h.out.reportStreamError(new Error('made while off'))
    h.show('#telemetry=1')
    h.out.reportStreamError(new Error('made while on'))
    await until(() => h.telemetry.streamError.mock.calls.length >= 1, 'the report made while on')
    await new Promise(r => setTimeout(r, 0))

    expect(h.telemetry.streamError.mock.calls.map(([e]) => (e as Error).message)).toEqual(['made while on'])
  })

  it('sends nothing once disposed, even a report made before', async () => {
    const h = harness()
    let arrive!: () => void
    h.loadTelemetry.mockImplementation(() => new Promise(r => (arrive = () => r(h.telemetry))))
    h.show('#telemetry=1')
    h.out.reportStreamError(new Error('made before dispose'))
    h.out.dispose()
    arrive()
    await new Promise(r => setTimeout(r, 0))
    expect(h.telemetry.streamError).not.toHaveBeenCalled()
  })

  it('counts a load time from when the address asked, across retries', async () => {
    let fail = true
    const h = harness({
      fetchDataset: async id => {
        if (fail) throw new WebDatasetError('network', 'no answer')
        return { dataset: dataset(id), alternateUrls: [] }
      },
    })
    h.show('#dataset=A&telemetry=1')
    await until(() => h.timers.length === 1, 'the retry to be scheduled')
    h.advance(5_000)
    fail = false
    h.timers[0].fn()
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.advance(250)
    h.media.resolve(url('A'))
    await until(() => h.report.shown.mock.calls.length === 1, 'the report')
    expect(h.report.shown.mock.calls[0][1]).toBe(5_250)
  })

  it('survives a telemetry module that will not load', async () => {
    const h = harness()
    h.loadTelemetry.mockImplementation(() => Promise.reject(new Error('chunk failed')))
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      h.show('#dataset=A&telemetry=1')
      h.out.reportStreamError(new Error('networkError: fragLoadError'))
      await until(() => h.media.pending.length === 1, 'A to start loading')
      h.media.resolve(url('A'))
      await until(() => h.onScreen() === url('A'), 'A on screen')
      await new Promise(r => setTimeout(r, 0))
      expect(unhandled).not.toHaveBeenCalled()
      expect(h.telemetry.datasetShown).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it("reports a stream's fatal errors while it is on", async () => {
    const h = harness()
    h.show('#telemetry=1')
    const err = new Error('mediaError: bufferStalledError')
    h.out.reportStreamError(err)
    await until(() => h.telemetry.streamError.mock.calls.length === 1, 'the report')
    expect(h.telemetry.streamError).toHaveBeenCalledWith(err)
  })

  it('does not report a dataset the address had moved on from when it landed', async () => {
    // B's record is still being fetched when A's media lands: A is on
    // the glass for a moment, but it is no longer what was asked for.
    let releaseB!: () => void
    const h = harness({
      fetchDataset: async id => {
        if (id === 'B') await new Promise<void>(r => (releaseB = r))
        return { dataset: dataset(id), alternateUrls: [] }
      },
    })
    h.show('#dataset=A&telemetry=1')
    await until(() => h.media.pending.length === 1, 'A to start loading')
    h.show('#dataset=B&telemetry=1')
    await until(() => h.fetchDataset.mock.calls.length === 2, 'B to be fetched')
    h.media.resolve(url('A'))
    await until(() => h.onScreen() === url('A'), 'A on screen')
    releaseB()
    await until(() => h.media.pending.length === 2, 'B to start loading')
    h.media.resolve(url('B'))
    await until(() => h.report.shown.mock.calls.length === 1, 'the report')

    expect(h.report.shown.mock.calls.map(([d]) => d.id)).toEqual(['B'])
  })

  it('reports the first failure of each attempt, not its retries', async () => {
    const h = harness({
      fetchDataset: async () => {
        throw new WebDatasetError('network', 'no answer')
      },
    })
    h.show('#dataset=A&telemetry=1')
    await until(() => h.timers.length === 1, 'the first retry to be scheduled')
    await until(() => h.report.failed.mock.calls.length === 1, 'the first report')
    expect(h.report.failed.mock.calls[0][0]).toMatchObject({ failure: 'network' })

    h.timers[0].fn()
    await until(() => h.timers.length === 2, 'the second retry to be scheduled')
    await new Promise(r => setTimeout(r, 0))
    expect(h.report.failed).toHaveBeenCalledTimes(1)

    // A new address is a new attempt.
    h.show('#dataset=B&telemetry=1')
    await until(() => h.timers.length === 3, "B's retry to be scheduled")
    await until(() => h.report.failed.mock.calls.length === 2, "B's report")
    expect(h.report.shown).not.toHaveBeenCalled()
  })
})

describe('following the address', () => {
  /** A page whose address can change, and whose `hashchange` is fired
   *  by hand. */
  function page(search: string, hash: string) {
    const listeners = new Set<() => void>()
    return {
      location: { search, hash },
      addEventListener: (_type: 'hashchange', fn: () => void) => void listeners.add(fn),
      removeEventListener: (_type: 'hashchange', fn: () => void) => void listeners.delete(fn),
      navigate(next: string) {
        this.location.hash = next
        for (const fn of listeners) fn()
      },
      listeners,
    }
  }

  it('applies the address as it is when it starts, not as the page first read it', () => {
    // The page reads its address to size the first frame, then awaits
    // the scene. A `#` change in that wait has already fired, unheard.
    const p = page('?dataset=A', '#t=10&paused=1')
    const earlier = readWebSettings(p.location.search, p.location.hash)
    p.location.hash = '#t=40&paused=1'
    const applied: ReturnType<typeof readWebSettings>[] = []
    followAddress(p, s => applied.push(s))
    expect(earlier.clock.positionS).toBe(10)
    expect(applied).toHaveLength(1)
    expect(applied[0].clock.positionS).toBe(40)
    expect(applied[0].datasetId).toBe('A')
  })

  it('applies every # change after that, and stops when told', () => {
    const p = page('?dataset=A', '')
    const applied: ReturnType<typeof readWebSettings>[] = []
    const stop = followAddress(p, s => applied.push(s))
    p.navigate('#dataset=B')
    expect(applied.map(s => s.datasetId)).toEqual(['A', 'B'])
    stop()
    expect(p.listeners.size).toBe(0)
    p.navigate('#dataset=C')
    expect(applied).toHaveLength(2)
  })
})

describe('steering', () => {
  async function playing(h: ReturnType<typeof harness>, hash: string) {
    h.show(hash)
    await until(() => h.media.pending.length === 1, 'the dataset to start loading')
    h.media.resolve(url('A'))
    await until(() => h.onScreen() === url('A'), 'the dataset on screen')
    return h.media.videos.get(url('A'))!
  }

  it('reports not-ready with nothing loaded, so the HUD drops an old reading', () => {
    expect(harness().out.steer()).toEqual({ kind: 'not-ready', driftS: null, seeked: false })
  })

  it('keeps a clock with no anchor running through a # change that left it alone', async () => {
    const h = harness()
    const v = await playing(h, '#dataset=A&t=40')
    h.advance(600_000)
    h.show('#dataset=A&t=40&debug=1')
    v.currentTime = 640
    expect(h.out.steer().driftS).toBeCloseTo(0, 6)
  })

  it('re-anchors a clock with no anchor when the address changes it', async () => {
    // `#t=50` sent ten minutes in means 50 s now.
    const h = harness()
    const v = await playing(h, '#dataset=A&t=40')
    h.advance(600_000)
    h.show('#dataset=A&t=50')
    v.currentTime = 50
    expect(h.out.steer().driftS).toBeCloseTo(0, 6)
  })

  it('loops on the period the stream states, not the element\'s own length', async () => {
    const h = harness()
    const v = await playing(h, '#dataset=A&t=15.99')
    // Buffered to its end with an AAC track: the element runs past the
    // playlist's 16 s, and every copy must still wrap on 16.
    ;(v as { duration: number }).duration = 16.04
    h.media.periods.set(url('A'), 16)
    h.advance(20)
    v.currentTime = 0.01
    expect(h.out.steer().driftS).toBeCloseTo(0, 6)
    // Wrapped on the element's 16.04, the same copy reads 40 ms out.
    h.media.periods.delete(url('A'))
    expect(h.out.steer().driftS).toBeCloseTo(0.04, 6)
  })

  it('asks for a frame when a paused seek lands, not only when it is made', async () => {
    const h = harness()
    const v = await playing(h, '#dataset=A&t=30&paused=1')
    h.out.steer()
    expect(v.currentTime).toBe(30)
    ;(v as { seeking: boolean }).seeking = true
    h.out.steer()
    h.markDirty.mockClear()
    ;(v as { seeking: boolean }).seeking = false
    h.out.steer()
    expect(h.markDirty).toHaveBeenCalled()
  })
})

describe('sound', () => {
  const notAllowed = () => Object.assign(new Error('no sound without a click'), { name: 'NotAllowedError' })

  /** One video already on screen, as the mirror would hold it after a
   *  load: an element loaded muted, and its steerable half, whose play()
   *  the browser refuses while unmuted when `refuse` says so. With
   *  `browser`, the element behaves as Chromium, Firefox and WebKit do
   *  under a policy that wants a click: unmuted while it plays, it pauses
   *  and says nothing, and the next play() is refused. */
  function soundHarness(
    refuse: (element: { muted: boolean }) => Error | null,
    opts: { playing?: boolean; browser?: boolean } = {},
  ) {
    let muted = true
    let paused = !opts.playing
    const element = {
      get muted() {
        return muted
      },
      set muted(value: boolean) {
        if (opts.browser && muted && !value && !paused) paused = true
        muted = value
      },
    }
    const video: SyncTarget = {
      readyState: 4,
      duration: 1000,
      seeking: false,
      currentTime: 0,
      playbackRate: 1,
      get paused() {
        return paused
      },
      play: vi.fn(() => {
        const err = refuse(element)
        if (err) return Promise.reject(err)
        paused = false
        return Promise.resolve()
      }),
      pause: vi.fn(() => {
        paused = true
      }),
    }
    const media: MediaSource = { kind: 'video', element: element as never, video, dispose: () => {} }
    const out = createWebOutput({
      mirror: { apply: async () => {}, current: () => media, currentDataset: () => dataset('X') },
      scene: { size: { width: 2048, height: 1024 }, setLayers: vi.fn(), setFramebufferWidth: vi.fn(), setParams: vi.fn() },
      setDebug: vi.fn(),
      setFill: vi.fn(),
      displaySizePx: () => ({ width: 2048, height: 1024 }),
      markDirty: vi.fn(),
      nowMs: () => T0,
      monotonicMs: () => 0,
      reducedMotion: () => false,
    })
    return { out, element, video, show: (hash: string) => out.apply(readWebSettings('', hash)) }
  }

  it('takes a # change to the sound at once, with no frame drawn', () => {
    // A browser stops drawing a hidden page while its sound plays on, so
    // a mute that waited for a frame waited until the page was seen again.
    const h = soundHarness(() => null)
    h.show('#t=0&sound=1')
    expect(h.element.muted).toBe(false)
    h.show('#t=0&sound=0')
    expect(h.element.muted).toBe(true)
  })

  it('plays muted unless the address asks for sound, and follows a # change', () => {
    const h = soundHarness(() => null)
    h.show('#t=0')
    h.out.steer()
    expect(h.element.muted).toBe(true)
    h.show('#t=0&sound=1')
    h.out.steer()
    expect(h.element.muted).toBe(false)
    h.show('#t=0&sound=0')
    h.out.steer()
    expect(h.element.muted).toBe(true)
  })

  it('plays muted for the rest of the page once the browser refuses to play aloud', async () => {
    const h = soundHarness(element => (element.muted ? null : notAllowed()))
    h.show('#t=0&sound=1')
    h.out.steer()
    expect(h.element.muted).toBe(false)
    expect(h.video.play).toHaveBeenCalledTimes(1)
    // Refused: the next frames mute it and play it, rather than holding a
    // still frame.
    await until(() => {
      h.out.steer()
      return !h.video.paused
    }, 'the video playing again, muted')
    expect(h.element.muted).toBe(true)
    // And it stays muted, whatever the address says next: the same
    // browser would refuse again.
    h.show('#t=0&sound=1&rate=2')
    h.out.steer()
    expect(h.element.muted).toBe(true)
  })

  it('recovers as a browser does it: the unmute pauses in silence, and the next play() is refused', async () => {
    // Playing muted, as every element starts. Unmuting it pauses it with
    // no error at all; only the clock's next play() is refused. Were that
    // play() not asked for, the page would hold a still frame unmuted.
    const h = soundHarness(element => (element.muted ? null : notAllowed()), { playing: true, browser: true })
    h.show('#t=0')
    h.out.steer()
    expect(h.video.paused).toBe(false)
    h.show('#t=0&sound=1')
    await until(() => {
      h.out.steer()
      return h.element.muted && !h.video.paused
    }, 'playing again, muted')
    expect(h.video.play).toHaveBeenCalled()
  })

  it('takes a refusal while muted for no verdict on sound', async () => {
    // A browser that blocks all autoplay refuses a muted play() too. That
    // says nothing about sound, so a later #sound=1 still unmutes.
    const h = soundHarness(() => notAllowed())
    h.show('#t=0')
    h.out.steer()
    const play = h.video.play as ReturnType<typeof vi.fn>
    expect(play).toHaveBeenCalledTimes(1)
    // The refusal lands (the page's handler runs) before sound is asked for.
    await play.mock.results[0].value.catch(() => {})
    await new Promise(r => setTimeout(r, 0))
    h.show('#t=0&sound=1')
    h.out.steer()
    expect(h.element.muted).toBe(false)
  })

  it('takes a play() something interrupted for nothing more than that', async () => {
    let first = true
    const h = soundHarness(() => {
      if (!first) return null
      first = false
      return Object.assign(new Error('interrupted by a pause'), { name: 'AbortError' })
    })
    h.show('#t=0&sound=1')
    await until(() => {
      h.out.steer()
      return !h.video.paused
    }, 'the video playing after the interruption')
    expect(h.element.muted).toBe(false)
  })
})
