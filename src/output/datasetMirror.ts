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
  deps: { loader?: MediaLoader; nowMs?: () => number } = {},
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

      if (!needsReload(dataset, next)) {
        // Same pixels, new metadata — keep the decoder, take the
        // overlay. The scene re-reads `currentDataset()` for its
        // uniforms, so a palette change costs an upload, not a reload.
        dataset = next
        return
      }

      const mine = ++generation

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
 */
export function createDefaultMediaLoader(): MediaLoader {
  return {
    async load(ds) {
      if (ds.kind === 'image') return loadImageSource(ds.url)

      const { HLSService } = await import('../services/hlsService')
      const hls = new HLSService()
      const video = hls.createVideo()
      try {
        await (isHlsManifest(ds.url)
          ? hls.loadStream(ds.url, video)
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
        hls.destroy()
        throw err
      }
      return {
        kind: 'video',
        element: video,
        video,
        dispose: () => hls.destroy(),
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
