// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output's media half: a `MirroredDataset` in, something the scene
 * can upload as a texture out (`docs/MULTI_MONITOR_PLAN.md` §3).
 *
 * `outputLink` decides *what* the output should be showing;
 * `outputSync` decides *when* within a clip; this owns the element in
 * between, and the three decisions that go with owning it.
 *
 * ## Reload only when the pixels would differ
 *
 * A `dataset` diff does not mean "reload". The bundle carries an
 * overlay — `lonOrigin`, `boundingBox`, `isFlippedInY`, `colorScale` —
 * every field of which the *shader* consumes, not the decoder. An
 * operator changing a palette produces a `dataset` change whose `url`
 * is identical, and rebuilding an HLS instance for it would stutter a
 * sphere in front of an audience for no picture change at all. So the
 * reload test is `url` and `kind`, and nothing else.
 *
 * ## Load first, swap second
 *
 * The previous source is disposed *after* the new one is ready, never
 * before. Disposing first is simpler and gives a black flash between
 * datasets on every switch — on a projector in a gallery that reads as
 * a fault. Showing the outgoing dataset for the extra few hundred
 * milliseconds is the better wrong answer, and it is also what makes
 * the failure path sane: a load that rejects leaves the last good
 * picture up rather than blanking the sphere.
 *
 * ## A slow load must not win
 *
 * Two dataset changes in quick succession race: the first load can
 * resolve after the second. Every `apply` takes a generation, and a
 * result whose generation is stale is disposed on arrival instead of
 * installed — otherwise an operator clicking through the catalog lands
 * on whichever dataset happened to be slowest.
 *
 * ## Seams
 *
 * `MediaLoader` is the whole DOM/network surface, so the ownership
 * rules above are testable with no `HTMLVideoElement`, no hls.js and no
 * network. The default loader imports `HLSService` **dynamically**, so
 * an output showing only image datasets never pays for hls.js.
 */

import { createPlayheadSync, type SyncInputs, type SyncOutcome, type SyncTarget } from './outputSync'
import type { MirroredDataset } from '../services/multiOutput/protocol'
import { logger } from '../utils/logger'
import { waitForDecodableFrame } from '../utils/mediaReadiness'

/** One loaded dataset's media, and how to let go of it. */
export interface MediaSource {
  readonly kind: 'image' | 'video'
  /** What the scene uploads. A `VideoTexture` for the video case, a
   *  plain texture for the image one. */
  readonly element: HTMLImageElement | HTMLVideoElement
  /** The steerable half — `null` for a still image, which has no
   *  playhead to correct. */
  readonly video: SyncTarget | null
  dispose(): void
}

export interface MediaLoader {
  load(dataset: MirroredDataset): Promise<MediaSource>
}

export interface DatasetMirror {
  /** The media currently installed, or `null` for the idle Earth. */
  current(): MediaSource | null
  /** The dataset that media came from, for the debug overlay and for
   *  the read-back check a later rung adds. */
  currentDataset(): MirroredDataset | null
  /**
   * Show this dataset, or nothing.
   *
   * Resolves when the swap has happened (or been declined as stale).
   * Never rejects: a failed load leaves the previous picture up and is
   * logged, because an output has no other way to say so.
   */
  apply(dataset: MirroredDataset | null): Promise<void>
  /** Steer the playhead. A no-op for images and for the idle state. */
  sync(state: SyncInputs): SyncOutcome
  dispose(): void
}

/** Whether a new dataset needs a new decoder, or only new uniforms. */
export function needsReload(
  current: MirroredDataset | null,
  next: MirroredDataset | null,
): boolean {
  if (!next) return current !== null
  if (!current) return true
  return current.url !== next.url || current.kind !== next.kind
}

export function createDatasetMirror(
  deps: {
    loader?: MediaLoader
    nowMs?: () => number
    /** A video that would not load, while it was still the dataset
     *  asked for. A load a newer `apply` superseded is not reported: an
     *  operator clicking through the catalog leaves loads behind, and
     *  their failures (contention, a timeout on a dataset already left)
     *  say nothing about the output. */
    onLoadFailed?: (dataset: MirroredDataset) => void
  } = {},
): DatasetMirror {
  const loader = deps.loader ?? createDefaultMediaLoader()
  // Holds the one thing the pure sync layer cannot: when it last
  // seeked, so a seek that is still settling does not earn another.
  const playhead = createPlayheadSync(deps.nowMs)
  let source: MediaSource | null = null
  let dataset: MirroredDataset | null = null
  let generation = 0
  let disposed = false

  const release = (media: MediaSource | null): void => {
    if (!media) return
    try {
      media.dispose()
    } catch (err) {
      // A decoder that will not let go must not strand the swap; the
      // new source is already installed by the time we get here.
      logger.warn('[output] disposing media failed:', err)
    }
  }

  return {
    current: () => source,
    currentDataset: () => dataset,

    async apply(next) {
      if (disposed) return

      // Every apply is the newest, including one that needs no load:
      // going back to the dataset on screen, or to nothing from idle,
      // must supersede a load still in flight. Bumped after the early
      // return, that load installed anyway and released the picture
      // the caller had just gone back to (found in review).
      const mine = ++generation

      if (!needsReload(dataset, next)) {
        // Same pixels, new metadata — keep the decoder, take the
        // overlay. The scene re-reads `currentDataset()` for its
        // uniforms, so a palette change costs an upload, not a reload.
        dataset = next
        return
      }

      if (!next) {
        dataset = null
        const outgoing = source
        source = null
        release(outgoing)
        return
      }

      let loaded: MediaSource
      try {
        loaded = await loader.load(next)
      } catch (err) {
        // The previous picture stays up. Rung 13 turns this into a
        // health badge and one stream rebuild; for now the honest
        // behaviour is to keep showing the last thing that worked.
        logger.error(`[output] could not load ${next.id}:`, err)
        if (mine === generation && !disposed && next.kind === 'video') deps.onLoadFailed?.(next)
        return
      }

      if (mine !== generation || disposed) {
        // A newer apply already won, or we were torn down mid-load.
        // Installing this would put an operator on whichever dataset
        // happened to load slowest.
        release(loaded)
        return
      }

      const outgoing = source
      source = loaded
      dataset = next
      release(outgoing)
    },

    sync(state) {
      return playhead.sync(source?.video ?? null, state)
    },

    dispose() {
      if (disposed) return
      disposed = true
      // Bumping the generation makes any in-flight load release itself
      // on arrival rather than installing into a torn-down mirror.
      generation++
      const outgoing = source
      source = null
      dataset = null
      release(outgoing)
    },
  }
}

/** HLS manifests go through hls.js; anything else is a direct file. */
export function isHlsManifest(url: string): boolean {
  // Query and fragment stripped first: a signed CDN URL routinely ends
  // `…m3u8?token=…`, and an extension test that missed it would send
  // every signed manifest down the progressive path.
  const path = url.split('#')[0].split('?')[0]
  return path.toLowerCase().endsWith('.m3u8')
}

/**
 * The real loader.
 *
 * `HLSService` arrives through a dynamic import so an output showing
 * image datasets never pays for hls.js — the same lazy-seam discipline
 * `outputScene` uses for Three and `photorealEarth`.
 *
 * `maxVideoWidth`, when given, is read at each load and caps the HLS
 * renditions at the narrowest one that still fills that width. The web
 * output passes its framebuffer width, because every visitor streams
 * their own copy; a desktop output passes nothing and is unchanged.
 *
 * Stream errors go where the window says, never to the default
 * reporter. `HLSService` left at its default posts a Tier A `error` from
 * whatever page it runs in, and a desktop output emits nothing of its own
 * (`outputTelemetry.ts`). So `reportStreamError` is handed every fatal
 * error the stream reports, recovered or not, and is silent unless given;
 * the web output gives it the page's own telemetry. `onStreamFailed` is
 * called once per loaded stream that dies, when it has spent its retry
 * budget (`HLSService.onFatalError`). A stream that would not load at
 * all is the mirror's to report (`onLoadFailed`), because only the
 * mirror knows whether that load was still wanted. A desktop output
 * gives both to the link, and the control window reports them.
 */
export interface DefaultMediaLoaderOptions {
  maxVideoWidth?: () => number | undefined
  reportStreamError?: (err: Error) => void
  onStreamFailed?: (ds: MirroredDataset) => void
}

export function createDefaultMediaLoader(opts: DefaultMediaLoaderOptions = {}): MediaLoader {
  return {
    async load(ds) {
      if (ds.kind === 'image') return loadImageSource(ds.url)

      const { HLSService } = await import('../services/hlsService')
      // The window's hooks never throw into the stream: this one runs
      // inside hls.js's error handler, ahead of its recovery.
      const hls = new HLSService({
        reportError: err => {
          try {
            opts.reportStreamError?.(err)
          } catch {
            // A report that failed must not cost the recovery.
          }
        },
      })
      const video = hls.createVideo()
      // Once per stream, and never after it was let go: a disposed stream
      // was replaced, which is not a failure.
      let done = false
      const failed = (): void => {
        if (done) return
        done = true
        try {
          opts.onStreamFailed?.(ds)
        } catch {
          // The report is the caller's; the stream is still this loader's.
        }
      }
      try {
        await (isHlsManifest(ds.url)
          ? hls.loadStream(ds.url, video, false, opts.maxVideoWidth?.())
          : hls.loadDirect(ds.url, video))
        // A loaded stream is not a decodable one, and on WebKitGTK it
        // is not even on its way to being one: that engine does not
        // preroll a pipeline until something plays it. Nothing here
        // would have. `outputSync` calls `play()` only on the branch
        // where the control window is *playing and in range* — so an
        // output whose operator loads a dataset with the transport
        // paused, the ordinary way a show is set up before an
        // audience, sat at `HAVE_METADATA` and uploaded a blank
        // texture to the sphere for the life of the window. The
        // element then goes back to being `outputSync`'s to steer,
        // which is what `pauseWhenReady` is for.
        await waitForDecodableFrame(video, { pauseWhenReady: true })
      } catch (err) {
        // The mirror reports a failed load, if it still wanted it.
        done = true
        hls.destroy()
        throw err
      }
      // A fatal error hls.js held while the stream loaded replays the
      // moment a handler is registered, before the mirror has decided
      // whether it still wants this stream. That is a failed load, so it
      // rejects like one, and the mirror reports it only if it is current.
      let loading = true
      let diedLoading = false
      hls.onFatalError(() => {
        if (loading) diedLoading = true
        else failed()
      })
      loading = false
      if (diedLoading) {
        done = true
        hls.destroy()
        throw new Error('the stream died while it loaded')
      }
      return {
        kind: 'video',
        element: video,
        video,
        dispose: () => {
          done = true
          hls.destroy()
        },
      }
    },
  }
}

function loadImageSource(url: string): Promise<MediaSource> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Same-origin-tainted canvases cannot be uploaded as textures, and
    // the failure is a silently black sphere rather than an error.
    img.crossOrigin = 'anonymous'
    img.onload = () =>
      resolve({
        kind: 'image',
        element: img,
        video: null,
        // Dropping the handlers is what lets the decoded bitmap go;
        // there is no explicit release for an `Image`.
        dispose: () => {
          img.onload = null
          img.onerror = null
          img.src = ''
        },
      })
    img.onerror = () => reject(new Error(`image failed to load: ${url}`))
    img.src = url
  })
}
