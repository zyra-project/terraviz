// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output's media ownership.
 *
 * Every case here is a way a sphere in a gallery misbehaves: a stutter
 * on a palette change, a black flash between datasets, the wrong
 * dataset winning a race, or a decoder left running after teardown.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  createDatasetMirror,
  datasetShowing,
  isHlsManifest,
  needsReload,
  type MediaLoader,
  type MediaSource,
} from './datasetMirror'
import { until } from '../test-utils'
import type { MirroredDataset } from '../services/multiOutput/protocol'

function dataset(over: Partial<MirroredDataset> = {}): MirroredDataset {
  return {
    id: 'SST',
    url: 'https://cdn.example/sst.m3u8',
    kind: 'video',
    overlay: { datasetId: 'SST' },
    startTime: null,
    endTime: null,
    ...over,
  }
}

/** A loader whose every load is resolved by hand, so the race is real. */
function deferredLoader() {
  const pending: { url: string; resolve: (s: MediaSource) => void; reject: (e: Error) => void }[] = []
  const disposed: string[] = []
  const loader: MediaLoader = {
    load: ds =>
      new Promise<MediaSource>((resolve, reject) => {
        pending.push({ url: ds.url, resolve, reject })
      }),
  }
  const source = (tag: string): MediaSource => ({
    kind: 'video',
    element: { tag } as unknown as HTMLVideoElement,
    video: null,
    dispose: () => disposed.push(tag),
  })
  return { loader, pending, disposed, source }
}

/** A loader that resolves immediately, tagged by URL. */
function instantLoader() {
  const disposed: string[] = []
  const loads: string[] = []
  const loader: MediaLoader = {
    load: async ds => {
      loads.push(ds.url)
      return {
        kind: ds.kind,
        element: {} as HTMLVideoElement,
        video: null,
        dispose: () => disposed.push(ds.url),
      }
    },
  }
  return { loader, disposed, loads }
}

describe('needsReload', () => {
  it('is false when only the overlay changed', () => {
    // The palette lives in `overlay.colorScale`, which the shader reads
    // and the decoder does not. Reloading for it stutters the sphere.
    const a = dataset()
    const b = dataset({ overlay: { datasetId: 'SST', datasetTitle: 'Renamed' } })
    expect(needsReload(a, b)).toBe(false)
  })

  it('is true when the url or kind changed', () => {
    expect(needsReload(dataset(), dataset({ url: 'https://cdn.example/other.m3u8' }))).toBe(true)
    expect(needsReload(dataset(), dataset({ kind: 'image' }))).toBe(true)
  })

  it('handles the empty transitions', () => {
    expect(needsReload(null, dataset())).toBe(true)
    expect(needsReload(dataset(), null)).toBe(true)
    expect(needsReload(null, null)).toBe(false)
  })
})

describe('datasetShowing', () => {
  // A stream outlives a dataset that changes only metadata, so the one
  // it loaded under may no longer be what the control window published,
  // and a stall named for it was dropped (found in review).
  it('names the dataset now showing when it kept the stream', () => {
    const loadedAs = dataset({ id: 'X' })
    const renamed = dataset({ id: 'Y' })
    expect(datasetShowing(loadedAs, renamed)).toBe(renamed)
  })

  it('names the one the stream loaded under when the mirror moved off it', () => {
    const loadedAs = dataset({ id: 'X' })
    expect(datasetShowing(loadedAs, dataset({ id: 'Y', url: 'https://cdn.example/other.m3u8' }))).toBe(loadedAs)
    expect(datasetShowing(loadedAs, null)).toBe(loadedAs)
  })
})

describe('reloading', () => {
  it('does not reload for a metadata-only change, but takes the metadata', async () => {
    const { loader, loads } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    await mirror.apply(dataset({ overlay: { datasetId: 'SST', datasetTitle: 'Renamed' } }))

    expect(loads).toHaveLength(1)
    expect(mirror.currentDataset()?.overlay.datasetTitle).toBe('Renamed')
  })

  it('reloads when the URL changes', async () => {
    const { loader, loads } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    await mirror.apply(dataset({ id: 'CHL', url: 'https://cdn.example/chl.m3u8' }))

    expect(loads).toEqual(['https://cdn.example/sst.m3u8', 'https://cdn.example/chl.m3u8'])
    expect(mirror.currentDataset()?.id).toBe('CHL')
  })
})

describe('swapping', () => {
  it('keeps the old picture up until the new one is ready', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const first = mirror.apply(dataset())
    pending[0].resolve(source('first'))
    await first

    const second = mirror.apply(dataset({ url: 'https://cdn.example/chl.m3u8' }))
    await until(() => pending.length === 2, 'the second load to start')

    // Mid-load: the outgoing source is still installed and undisposed.
    // Disposing here is what gives a black flash on a projector.
    expect(mirror.current()?.element).toEqual({ tag: 'first' })
    expect(disposed).toEqual([])

    pending[1].resolve(source('second'))
    await second

    expect(mirror.current()?.element).toEqual({ tag: 'second' })
    expect(disposed).toEqual(['first'])
  })

  it('keeps the last good picture when a load fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const first = mirror.apply(dataset())
    pending[0].resolve(source('first'))
    await first

    const second = mirror.apply(dataset({ url: 'https://cdn.example/gone.m3u8' }))
    await until(() => pending.length === 2, 'the second load to start')
    pending[1].reject(new Error('404'))

    // Resolves rather than rejecting: an output has no caller to report
    // to, so a failure must not escape into the render loop.
    await expect(second).resolves.toBeUndefined()
    expect(mirror.current()?.element).toEqual({ tag: 'first' })
    expect(mirror.currentDataset()?.id).toBe('SST')
    expect(disposed).toEqual([])
  })

  it('clears on a null dataset', async () => {
    const { loader, disposed } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    await mirror.apply(null)

    expect(mirror.current()).toBeNull()
    expect(mirror.currentDataset()).toBeNull()
    expect(disposed).toEqual(['https://cdn.example/sst.m3u8'])
  })
})

describe('a load that fails', () => {
  // From the desktop review: an operator clicking through the catalog
  // leaves loads behind, and their failures say nothing about the output.
  it('is reported only while it is still the dataset asked for', async () => {
    const { loader, pending } = deferredLoader()
    const failed: string[] = []
    const mirror = createDatasetMirror({ loader, onLoadFailed: ds => failed.push(ds.id) })

    const a = mirror.apply(dataset({ id: 'A', url: 'https://cdn.example/a.m3u8' }))
    await until(() => pending.length === 1, 'A to start loading')
    const b = mirror.apply(dataset({ id: 'B', url: 'https://cdn.example/b.m3u8' }))
    await until(() => pending.length === 2, 'B to start loading')
    pending[0].reject(new Error('A timed out'))
    pending[1].reject(new Error('B timed out'))
    await Promise.all([a, b])

    expect(failed).toEqual(['B'])
  })

  it('is not reported for an image, which is not a stream', async () => {
    const { loader, pending } = deferredLoader()
    const failed: string[] = []
    const mirror = createDatasetMirror({ loader, onLoadFailed: ds => failed.push(ds.id) })
    const done = mirror.apply(dataset({ id: 'I', url: 'https://cdn.example/i.jpg', kind: 'image' }))
    await until(() => pending.length === 1, 'the image to start loading')
    pending[0].reject(new Error('404'))
    await done
    expect(failed).toEqual([])
  })
})

describe('racing loads', () => {
  it('lets the newest apply win, whatever order they resolve in', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })

    const a = mirror.apply(dataset({ id: 'A', url: 'https://cdn.example/a.m3u8' }))
    await until(() => pending.length === 1, 'the first load to start')
    const b = mirror.apply(dataset({ id: 'B', url: 'https://cdn.example/b.m3u8' }))
    await until(() => pending.length === 2, 'the second load to start')

    // B resolves first, then the slower A. Without a generation the
    // late A would install and the operator would be left on whichever
    // dataset happened to be slowest.
    pending[1].resolve(source('B'))
    pending[0].resolve(source('A'))
    await Promise.all([a, b])

    expect(mirror.currentDataset()?.id).toBe('B')
    expect(mirror.current()?.element).toEqual({ tag: 'B' })
    // The loser is released rather than leaked — it holds a decoder.
    expect(disposed).toEqual(['A'])
  })

  // Found in review. Asking for the dataset already on screen needs no
  // load, and that early return used to skip the generation, so a load
  // still in flight was not superseded. It then installed and released
  // the picture the operator had gone back to.
  it('lets a return to the dataset on screen supersede a load in flight', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const x = dataset({ id: 'X', url: 'https://cdn.example/x.m3u8' })
    const xLoad = mirror.apply(x)
    await until(() => pending.length === 1, 'X to start loading')
    pending[0].resolve(source('X'))
    await xLoad

    const aLoad = mirror.apply(dataset({ id: 'A', url: 'https://cdn.example/a.m3u8' }))
    await until(() => pending.length === 2, 'A to start loading')
    await mirror.apply(x)
    pending[1].resolve(source('A'))
    await aLoad

    expect(mirror.currentDataset()?.id).toBe('X')
    expect(mirror.current()?.element).toEqual({ tag: 'X' })
    expect(disposed).toEqual(['A'])
  })

  it('lets an apply of nothing supersede a load in flight, from idle', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const aLoad = mirror.apply(dataset({ id: 'A', url: 'https://cdn.example/a.m3u8' }))
    await until(() => pending.length === 1, 'A to start loading')
    await mirror.apply(null)
    pending[0].resolve(source('A'))
    await aLoad

    expect(mirror.current()).toBeNull()
    expect(mirror.currentDataset()).toBeNull()
    expect(disposed).toEqual(['A'])
  })
})

describe('dispose', () => {
  it('releases the current source', async () => {
    const { loader, disposed } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    mirror.dispose()

    expect(mirror.current()).toBeNull()
    expect(disposed).toEqual(['https://cdn.example/sst.m3u8'])
  })

  it('releases a load that lands after teardown', async () => {
    const { loader, pending, disposed, source } = deferredLoader()
    const mirror = createDatasetMirror({ loader })
    const inFlight = mirror.apply(dataset())
    await until(() => pending.length === 1, 'the load to start')

    mirror.dispose()
    pending[0].resolve(source('late'))
    await inFlight

    // The window may be gone, but the decoder it built is real.
    expect(disposed).toEqual(['late'])
    expect(mirror.current()).toBeNull()
  })

  it('ignores an apply after teardown', async () => {
    const { loader, loads } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    mirror.dispose()

    await mirror.apply(dataset())

    expect(loads).toEqual([])
  })

  it('is idempotent', async () => {
    const { loader, disposed } = instantLoader()
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    mirror.dispose()
    mirror.dispose()

    expect(disposed).toHaveLength(1)
  })

  it('survives a dispose that throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loader: MediaLoader = {
      load: async () => ({
        kind: 'video',
        element: {} as HTMLVideoElement,
        video: null,
        dispose: () => {
          throw new Error('decoder stuck')
        },
      }),
    }
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset())

    expect(() => mirror.dispose()).not.toThrow()
    expect(mirror.current()).toBeNull()
  })
})

describe('sync', () => {
  it('is inert for an image, which has no playhead', async () => {
    const loader: MediaLoader = {
      load: async () => ({
        kind: 'image',
        element: {} as HTMLImageElement,
        video: null,
        dispose: () => {},
      }),
    }
    const mirror = createDatasetMirror({ loader })
    await mirror.apply(dataset({ kind: 'image', url: 'https://cdn.example/x.jpg' }))

    const out = mirror.sync({
      dataset: mirror.currentDataset(),
      primary: { duration: 10, rangeMs: 1000 },
      playback: { date: '2026-01-01T00:00:00.000Z', positionRatio: 0.5, paused: false, playbackRate: 1 },
    })

    expect(out.kind).toBe('not-ready')
  })

  it('is inert with nothing loaded', () => {
    const mirror = createDatasetMirror({ loader: instantLoader().loader })
    expect(mirror.sync({ dataset: null, primary: null, playback: null }).kind).toBe('not-ready')
  })
})

describe('isHlsManifest', () => {
  it('recognises a manifest', () => {
    expect(isHlsManifest('https://cdn.example/a.m3u8')).toBe(true)
    expect(isHlsManifest('https://cdn.example/A.M3U8')).toBe(true)
  })

  it('looks past a query string, as a signed CDN URL has', () => {
    // `…m3u8?token=…` is the normal shape from a signing CDN. A bare
    // `endsWith('.m3u8')` sends every one of them down the progressive
    // path, where hls.js never sees the manifest.
    expect(isHlsManifest('https://cdn.example/a.m3u8?token=abc&exp=1')).toBe(true)
    expect(isHlsManifest('https://cdn.example/a.m3u8#t=10')).toBe(true)
  })

  it('rejects a progressive file', () => {
    expect(isHlsManifest('https://cdn.example/a.mp4')).toBe(false)
    expect(isHlsManifest('https://cdn.example/m3u8.mp4')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createDefaultMediaLoader
// ---------------------------------------------------------------------------

/**
 * The real loader is where the output meets an engine. On WebKitGTK a
 * loaded stream is not a decodable one and never becomes one unless
 * something plays it — and nothing on this path would have, because
 * `outputSync` plays only while the control window is playing and in
 * range. An operator setting up a show with the transport paused got a
 * blank sphere with no error anywhere.
 */
describe('createDefaultMediaLoader', () => {
  function mockHls(opts: { loadRejects?: boolean; heldFatal?: boolean } = {}): {
    played: () => number
    paused: () => number
    constructedWith: unknown[]
    /** Fire the stream's terminal error, as hls.js does once its retry
     *  budget is spent after loading. */
    die: () => void
  } {
    let played = 0
    let paused = 0
    const constructedWith: unknown[] = []
    let fatal: ((e: { type: string; details: string }) => void) | null = null
    vi.resetModules()
    vi.doMock('../services/hlsService', () => ({
      HLSService: class {
        constructor(opts?: unknown) {
          constructedWith.push(opts)
        }
        createVideo(): HTMLVideoElement {
          const el = document.createElement('video')
          // A passive engine: `canplay` only ever arrives in response
          // to being played. Chrome and Firefox would have fired it
          // unprompted, which is why this went unseen on three engines.
          Object.defineProperty(el, 'readyState', { value: 0, writable: true })
          el.play = () => {
            played++
            queueMicrotask(() => el.dispatchEvent(new Event('canplay')))
            return Promise.resolve()
          }
          el.pause = () => {
            paused++
          }
          return el
        }
        loadStream(): Promise<void> {
          return opts.loadRejects ? Promise.reject(new Error('networkError: manifestLoadError')) : Promise.resolve()
        }
        loadDirect(): Promise<void> {
          return Promise.resolve()
        }
        onFatalError(handler: typeof fatal): void {
          fatal = handler
          // As `HLSService` does: an error held while nobody listened is
          // handed over the moment someone does.
          if (opts.heldFatal) handler?.({ type: 'networkError', details: 'fragLoadError' })
        }
        playlistDurationS(): number | null {
          return 12.1
        }
        destroy(): void {}
      },
    }))
    return {
      played: () => played,
      paused: () => paused,
      constructedWith,
      die: () => fatal?.({ type: 'networkError', details: 'fragLoadError' }),
    }
  }

  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('../services/hlsService')
  })

  it('prerolls the element rather than handing back one that never decodes', async () => {
    const counts = mockHls()
    const { createDefaultMediaLoader } = await import('./datasetMirror')

    await createDefaultMediaLoader().load({
      kind: 'video',
      url: 'https://cdn.example/a.m3u8',
      overlay: { datasetId: 'd', datasetTitle: 'D' },
    } as never)

    expect(counts.played()).toBe(1)
  })

  it('hands on the length the stream\'s playlist states, which a web output loops on', async () => {
    mockHls()
    const { createDefaultMediaLoader } = await import('./datasetMirror')
    const source = await createDefaultMediaLoader().load({
      kind: 'video',
      url: 'https://cdn.example/a.m3u8',
      overlay: { datasetId: 'd', datasetTitle: 'D' },
    } as never)
    expect(source.loopS?.()).toBe(12.1)
  })

  // The playhead belongs to `outputSync`, which decides play/pause from
  // the control window's transport. A loader that left the element
  // running would have the output playing ahead of a paused operator
  // until the next steer caught it.
  it('leaves the element paused for outputSync to steer', async () => {
    const counts = mockHls()
    const { createDefaultMediaLoader } = await import('./datasetMirror')

    await createDefaultMediaLoader().load({
      kind: 'video',
      url: 'https://cdn.example/a.m3u8',
      overlay: { datasetId: 'd', datasetTitle: 'D' },
    } as never)

    expect(counts.paused()).toBe(1)
  })

  // A web output streams one copy per visitor, so it caps the rendition
  // at its framebuffer. A desktop output passes nothing and is unchanged.
  it('hands the frame width to the stream, read at load time', async () => {
    mockHls()
    const calls: unknown[][] = []
    const { HLSService } = await import('../services/hlsService')
    HLSService.prototype.loadStream = function (...args: unknown[]) {
      calls.push(args)
      return Promise.resolve()
    } as never
    const { createDefaultMediaLoader } = await import('./datasetMirror')
    let width: number | undefined = 2048
    const loader = createDefaultMediaLoader({ maxVideoWidth: () => width })
    const ds = { kind: 'video', url: 'https://cdn.example/a.m3u8', overlay: {} } as never

    await loader.load(ds)
    width = 4096
    await loader.load(ds)
    await createDefaultMediaLoader().load(ds)

    expect(calls.map(args => args[3])).toEqual([2048, 4096, undefined])
  })

  // An output emits no telemetry (`outputTelemetry.ts`). The stream's
  // own fatal-error report is the one path that would have, from every
  // desktop output and every Second Life visitor's copy.
  it('builds a stream that reports its errors to nobody', async () => {
    const counts = mockHls()
    // Any route to telemetry the reporter might take. A reporter that
    // only *returns* nothing would pass without these (found in review).
    const analytics = { reportError: vi.fn(), emit: vi.fn() }
    vi.doMock('../analytics', () => analytics)
    try {
      const { createDefaultMediaLoader } = await import('./datasetMirror')
      await createDefaultMediaLoader().load({ kind: 'video', url: 'https://cdn.example/a.m3u8', overlay: {} } as never)

      const opts = counts.constructedWith[0] as { reportError?: (err: Error) => void } | undefined
      expect(opts?.reportError).toBeTypeOf('function')
      opts?.reportError?.(new Error('networkError: fragLoadError'))
      // The anchor for "not called": a reporter that went through the
      // lazy import `hlsService` uses would have registered its callback
      // before this import, so it has run by the time this resolves.
      const reached = await import('../analytics')
      expect(reached.reportError).toBe(analytics.reportError)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(analytics.reportError).not.toHaveBeenCalled()
      expect(analytics.emit).not.toHaveBeenCalled()
    } finally {
      vi.doUnmock('../analytics')
    }
  })

  // Where they go instead is the window's choice: the web output's own
  // telemetry takes every fatal error, a desktop output's link takes a
  // stream that died.
  it("hands every fatal error to the window's reporter", async () => {
    const counts = mockHls()
    const { createDefaultMediaLoader } = await import('./datasetMirror')
    const errors: Error[] = []
    await createDefaultMediaLoader({ reportStreamError: err => errors.push(err) }).load({
      kind: 'video',
      url: 'https://cdn.example/a.m3u8',
      overlay: {},
    } as never)

    const opts = counts.constructedWith[0] as { reportError?: (err: Error) => void }
    opts.reportError?.(new Error('mediaError: bufferStalledError'))
    expect(errors.map(e => e.message)).toEqual(['mediaError: bufferStalledError'])
  })

  it('leaves a stream that would not load to the mirror to report', async () => {
    // Only the mirror knows whether that load was still wanted. Reported
    // here as well, a superseded load's failure would count twice, or at
    // all.
    const counts = mockHls({ loadRejects: true })
    const { createDefaultMediaLoader } = await import('./datasetMirror')
    const failed: string[] = []
    const ds = { id: 'd-1', kind: 'video', url: 'https://cdn.example/a.m3u8', overlay: {} } as never

    await expect(createDefaultMediaLoader({ onStreamFailed: d => failed.push(d.id) }).load(ds)).rejects.toThrow()
    // A fatal error the destroyed stream replays afterwards is not one.
    counts.die()
    expect(failed).toEqual([])
  })

  it('rejects a stream that died while it loaded, leaving it to the mirror', async () => {
    // hls.js held the error until a handler was registered, which is
    // before the mirror knows whether it still wants this stream. As a
    // failed load, it is the mirror's to report or not.
    mockHls({ heldFatal: true })
    const { createDefaultMediaLoader } = await import('./datasetMirror')
    const failed: string[] = []
    const ds = { id: 'd-1', kind: 'video', url: 'https://cdn.example/a.m3u8', overlay: {} } as never

    await expect(createDefaultMediaLoader({ onStreamFailed: d => failed.push(d.id) }).load(ds)).rejects.toThrow(
      /died while it loaded/,
    )
    expect(failed).toEqual([])
  })

  it("keeps a throwing reporter out of the stream's recovery", async () => {
    const counts = mockHls()
    const { createDefaultMediaLoader } = await import('./datasetMirror')
    const loader = createDefaultMediaLoader({
      reportStreamError: () => {
        throw new Error('reporter broke')
      },
      onStreamFailed: () => {
        throw new Error('reporter broke')
      },
    })
    await loader.load({ id: 'd-1', kind: 'video', url: 'https://cdn.example/a.m3u8', overlay: {} } as never)
    const opts = counts.constructedWith[0] as { reportError: (err: Error) => void }
    expect(() => opts.reportError(new Error('networkError: fragLoadError'))).not.toThrow()
    expect(() => counts.die()).not.toThrow()
  })

  it('says once that a loaded stream died, and nothing once it was let go', async () => {
    const counts = mockHls()
    const { createDefaultMediaLoader } = await import('./datasetMirror')
    const failed: string[] = []
    const loader = createDefaultMediaLoader({ onStreamFailed: d => failed.push(d.id) })
    const ds = { id: 'd-1', kind: 'video', url: 'https://cdn.example/a.m3u8', overlay: {} } as never

    await loader.load(ds)
    counts.die()
    counts.die()
    expect(failed).toEqual(['d-1'])

    // A stream disposed because the dataset changed was replaced, which
    // is not a failure.
    const second = await loader.load({ ...(ds as object), id: 'd-2' } as never)
    second.dispose()
    counts.die()
    expect(failed).toEqual(['d-1'])
  })
})
