/**
 * HLS streaming service - fetches manifests from video proxy and manages HLS playback
 */

import Hls from 'hls.js'
import { logger } from '../utils/logger'
import { reportError } from '../analytics'
import { VIDEO_PROXY_BASE } from '../config/endpoints'

export interface VideoProxyFile {
  quality: string
  width?: number
  height?: number
  size: number
  type: string
  link: string
}

/**
 * A fatal stream error that arrived *after* the stream had loaded.
 *
 * `type` is hls.js's error type (`networkError`, `mediaError`) on the
 * MSE path, or `native` where the browser's own HLS/progressive
 * pipeline reported it and no finer classification exists.
 */
export interface HlsFatalError {
  type: string
  /** hls.js error details (e.g. `fragLoadError`), or a short tag. */
  details: string
}

export interface VideoProxyResponse {
  id: string
  title: string
  duration: number
  hls: string
  dash: string
  files: VideoProxyFile[]
}

// --- HLS buffer constants ---
const MOBILE_BUFFER_LENGTH = 30
const DESKTOP_BUFFER_LENGTH = 600
const MAX_ERROR_RETRIES = 3

// --- Rendition selection for short looping assets ---

/**
 * Above this duration an asset has enough fragments for hls.js's own
 * ABR to converge, so we leave it alone. Catalog assets are 2-3 s
 * loops; the threshold is deliberately far above them.
 */
const SHORT_ASSET_MAX_DURATION = 60

/**
 * A rung has to fit inside this fraction of measured throughput before
 * we will pick it. hls.js uses 0.7 for its own up-switches; we can
 * afford to be slightly less conservative because the whole asset is
 * fetched once and then replayed from buffer, so a rung that is merely
 * *close* to the limit still never rebuffers.
 */
const RENDITION_BANDWIDTH_MARGIN = 0.8

/**
 * Floor on the measurement window, in milliseconds.
 *
 * A fragment served from cache can land inside one `performance.now()`
 * tick, which would divide by zero. Clamped rather than discarded
 * because a cache hit still has to produce *some* figure — but see
 * `measuredBandwidthBps` for why that figure is not trustworthy on its
 * own. This is much smaller than hls.js's own 50 ms floor, which is the
 * bug we are working around rather than a value to copy.
 */
const MIN_PROBE_WINDOW_MS = 0.5

/** The subset of hls.js's `LoadStats` this module measures against. */
export interface FragmentLoadTiming {
  loaded: number
  loading: { start: number; first: number; end: number }
}

/**
 * Throughput implied by one fragment load, in bits per second.
 *
 * Measured from first byte to last rather than from request start, so
 * the figure is transfer rate and not latency-plus-transfer.
 *
 * This exists because hls.js's own estimate cannot be trusted for
 * these assets. Its bandwidth sampler clamps every measurement window
 * to a 50 ms minimum, so a fragment that really took 4 ms is recorded
 * as having taken 50. For a catalog asset whose leading fragment is
 * 0.2 s the arithmetic ceiling that imposes is
 * `fragmentBytes * 8 / 0.05` — about 7.9 Mbps for a 49 KB fragment,
 * no matter how fast the connection actually is. Every rung above that
 * then looks unaffordable forever. Measured on a gigabit link with the
 * asset cached: hls.js recorded 7.9 Mbps where the transfer ran at
 * roughly 394 Mbps.
 *
 * A caveat the caller has to handle: this measures *transfer*, not
 * network. A fragment served from the browser cache reports cache
 * speed, and a cache hit on one rung says nothing about the link or
 * about whether any other rung is cached. The case that matters is
 * concrete — before this fix every visitor was pinned to the floor, so
 * a returning viewer has the floor rung cached and nothing else. The
 * probe hits that cache, reports hundreds of Mbps, and the top rung
 * gets chosen over whatever the connection actually is. Measured: a
 * cached 49 KB probe read 656 Mbps on a link running at 3 Mbps.
 *
 * There is no reliable way to tell a cache hit from a fast link here —
 * the assets are cross-origin, so Resource Timing reports
 * `transferSize: 0` either way — so the caller verifies against the
 * first real transfer instead of trying to detect it.
 *
 * Returns null when the stats cannot support a measurement at all.
 */
export function measuredBandwidthBps(stats: FragmentLoadTiming): number | null {
  const bytes = stats?.loaded
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  // `first` is 0 until the first byte arrives; fall back to the request
  // start so a stat block that never recorded it still yields a figure.
  const from = stats.loading.first || stats.loading.start
  const end = stats.loading.end
  if (!Number.isFinite(from) || !Number.isFinite(end)) return null
  const elapsedMs = Math.max(end - from, MIN_PROBE_WINDOW_MS)
  return (bytes * 8) / (elapsedMs / 1000)
}

/**
 * Highest rung whose bitrate fits inside the measured throughput,
 * bounded by `capIndex` (hls.js's `autoLevelCapping`, -1 for none).
 *
 * Falls back to the cheapest rung when nothing is affordable: playing
 * the catalog's floor is better than playing nothing, and hls.js will
 * still buffer the whole asset before it loops.
 *
 * Selection is by bitrate rather than by index so it does not depend on
 * the level array being sorted.
 */
export function selectRendition(
  bitrates: number[],
  measuredBps: number,
  capIndex: number
): number {
  if (bitrates.length === 0) return -1
  const upper = capIndex >= 0 ? Math.min(capIndex, bitrates.length - 1) : bitrates.length - 1
  const budget = measuredBps * RENDITION_BANDWIDTH_MARGIN
  let best = -1
  for (let i = 0; i <= upper; i++) {
    const bitrate = bitrates[i]
    if (bitrate > budget) continue
    if (best === -1 || bitrate > bitrates[best]) best = i
  }
  if (best !== -1) return best
  // Nothing affordable — take the cheapest rung within the cap.
  let cheapest = 0
  for (let i = 1; i <= upper; i++) {
    if (bitrates[i] < bitrates[cheapest]) cheapest = i
  }
  return cheapest
}

export class HLSService {
  private hls: Hls | null = null
  video: HTMLVideoElement | null = null
  private fatalErrorHandler: ((error: HlsFatalError) => void) | null = null
  private pendingFatalError: HlsFatalError | null = null

  /**
   * Register a handler for fatal errors that arrive after the stream
   * has already loaded.
   *
   * `loadStream` resolves on `MANIFEST_PARSED`, which fires long before
   * playback. Every fatal error after that point was calling `reject`
   * on a promise that had already settled — a no-op — so a stream that
   * died mid-playback spent its retry budget and then went quiet. hls.js
   * stops loading at that point, and because a seek reports its
   * *target* through `currentTime` the moment it is written, the panel
   * is left showing a frame that will never advance behind a clock that
   * reads correct. Nothing downstream could see it.
   *
   * Errors *before* the promise settles keep rejecting, so the
   * progressive-MP4 fallback in `datasetLoader` is untouched.
   */
  onFatalError(handler: ((error: HlsFatalError) => void) | null): void {
    this.fatalErrorHandler = handler
    const pending = this.pendingFatalError
    if (handler && pending) {
      this.pendingFatalError = null
      handler(pending)
    }
  }

  /**
   * Deliver a terminal failure, or hold it until someone is listening.
   *
   * The handler cannot be registered until `loadVideoDataset` returns,
   * and that is well after this promise settles: the loader still waits
   * for `canplay` first. A stream that dies on its first fragment dies
   * squarely inside that window — and because `canplay` then never
   * fires, the load also surfaces as a generic timeout rather than the
   * failure that caused it. Dropping the error there would reproduce
   * the exact bug this seam exists to close, just in a smaller window.
   *
   * The first terminal error is the one held: later ones are usually
   * cascades of it, and the first is what a reader needs.
   */
  private reportFatal(error: HlsFatalError): void {
    if (this.fatalErrorHandler) {
      this.fatalErrorHandler(error)
      return
    }
    this.pendingFatalError ??= error
  }

  /**
   * Fetch HLS manifest and metadata from the video proxy
   */
  async fetchManifest(vimeoId: string): Promise<VideoProxyResponse> {
    const response = await fetch(`${VIDEO_PROXY_BASE}/${vimeoId}`)
    if (!response.ok) {
      throw new Error(`Failed to fetch video manifest: ${response.status}`)
    }
    return response.json()
  }

  /**
   * Create a hidden video element for frame extraction
   */
  createVideo(): HTMLVideoElement {
    if (this.video) return this.video

    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.playsInline = true
    video.muted = true // Required for autoplay policies
    // Off-screen rather than display:none — mobile browsers skip frame
    // decoding for hidden elements, which breaks VideoTexture uploads.
    video.style.position = 'fixed'
    video.style.top = '-1px'
    video.style.left = '-1px'
    video.style.width = '1px'
    video.style.height = '1px'
    video.style.opacity = '0'
    video.style.pointerEvents = 'none'
    document.body.appendChild(video)
    this.video = video
    return video
  }

  /**
   * Load an HLS stream into the video element
   */
  loadStream(hlsUrl: string, video: HTMLVideoElement, mobile = false): Promise<void> {
    return new Promise((resolve, reject) => {
      // This promise settles on `MANIFEST_PARSED`, so anything that
      // fails later has no caller left to reject to. Route every
      // outcome through these: before the promise settles they behave
      // exactly as the bare `resolve`/`reject` did; after, a failure
      // reaches the handler instead of disappearing.
      let settled = false
      let loaded = false
      const succeed = (): void => {
        if (settled) return
        settled = true
        loaded = true
        resolve()
      }
      const fail = (type: string, details: string, error: Error): void => {
        if (settled) {
          // Only a stream that actually loaded can fail *later*. If this
          // promise rejected, the caller owns that failure and is
          // already handling it — `datasetLoader` falls back to the
          // progressive MP4 through this very service and video, and
          // `loadDirect` does not tear the hls.js instance down, so the
          // abandoned stream goes on emitting into here. Reporting those
          // would mark a healthy fallback as terminally failed.
          if (loaded) this.reportFatal({ type, details })
          return
        }
        settled = true
        reject(error)
      }

      // Clean up previous HLS instance
      if (this.hls) {
        this.hls.destroy()
        this.hls = null
      }

      if (Hls.isSupported()) {
        // Mobile browsers have strict MSE memory quotas. Buffering 600 s of
        // HD video overflows them, causing fatal MEDIA_ERRORs on most phones.
        // 30 s is enough for smooth looped playback on mobile.
        const bufferLength = mobile ? MOBILE_BUFFER_LENGTH : DESKTOP_BUFFER_LENGTH
        this.hls = new Hls({
          maxBufferLength: bufferLength,
          maxMaxBufferLength: bufferLength,
          backBufferLength: mobile ? MOBILE_BUFFER_LENGTH : Infinity,
          // Let ABR choose the best level on all devices (-1 = auto).
          // Previously mobile was pinned to level 0 (lowest quality).
          startLevel: -1,
        })

        this.hls.loadSource(hlsUrl)
        this.hls.attachMedia(video)

        this.hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          const levels = this.hls!.levels.map(l => `${l.width}x${l.height}`)
          logger.info(`[HLS] Manifest parsed, ${data.levels.length} quality levels:`, levels)

          // Cap the max ABR level to the device's screen resolution.
          // Decoding 4K video on a 720p phone wastes memory and can crash
          // mobile MSE implementations. The video element is 1x1px (for
          // first-frame decode), so capLevelToPlayerSize won't work here.
          if (mobile) {
            const maxScreenDim = Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1)
            const cap = this.hls!.levels.reduce((best, level, i) => {
              return level.height <= maxScreenDim ? i : best
            }, 0)
            this.hls!.autoLevelCapping = cap
            logger.info(`[HLS] Mobile ABR capped at level ${cap} (${this.hls!.levels[cap].width}x${this.hls!.levels[cap].height}) for screen ${maxScreenDim}px`)
          }

          succeed()
        })

        this.hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          const level = this.hls!.levels[data.level]
          logger.info(`[HLS] Quality switched to level ${data.level}: ${level.width}x${level.height} (${level.bitrate} bps)`)
        })

        // Choose the rendition once, from the first fragment's own
        // transfer rate, and hold it.
        //
        // hls.js's ABR is built for a stream long enough to converge
        // during. These assets are 2-3 s loops of one or two fragments,
        // and two of its mechanisms combine to pin them at the floor:
        //
        //  - Its bandwidth sampler clamps every measurement window to
        //    50 ms, so the short leading fragment can never *measure*
        //    more than a few Mbps however fast the link is.
        //  - Its fetch-duration test compares a level's average
        //    fragment duration against how much is currently buffered.
        //    With a 0.2 s leading fragment that budget is 0.2 s while
        //    the average fragment is 1.2 s, so every rung fails and ABR
        //    steps down one rung each time a level's playlist loads —
        //    all the way to the bottom.
        //
        // Once the whole asset is buffered no further fragments are
        // requested, so nothing ever re-evaluates and the floor sticks
        // for the lifetime of the instance. Measured on desktop Chrome
        // over gigabit with the asset cached, a 4096x2048 source played
        // at 1440x720 and never moved.
        //
        // `startLevel: -1` above still has hls.js load a throwaway
        // probe fragment at the lowest rung; it is never buffered, so
        // reading the rate off it costs nothing and lets the first
        // fragment the viewer actually sees arrive at the chosen rung.
        // That keeps the whole asset at one resolution instead of
        // switching mid-loop.
        //
        // The probe is trusted once and then checked. It can be served
        // from cache — and because every visitor was pinned to the floor
        // before this fix, a returning viewer has exactly the probe's
        // rung cached and nothing above it. A cache hit reads as
        // hundreds of Mbps whatever the link is doing, so taking it at
        // face value would fetch the top rung over a slow connection and
        // stall. Measured: a cached probe read 656 Mbps on a 3 Mbps
        // link, and playback stalled.
        //
        // So the first real fragment — larger, and at the held rung
        // rather than the probe's — gets measured too, and the hold is
        // corrected down if that transfer cannot carry it. Only
        // downward: an upward correction would risk a second flip, and
        // the cost of guessing low is quality rather than a stall. One
        // correction, then the decision is final.
        let renditionSettled = false
        // -1 until the handler below holds a rung.
        let heldLevel = -1
        this.hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
          if (renditionSettled || !this.hls) return
          const frag = data.frag
          // Long assets have the fragments ABR needs; leave them to it.
          const totalDuration = this.hls.levels[frag.level]?.details?.totalduration ?? 0
          if (!(totalDuration > 0 && totalDuration <= SHORT_ASSET_MAX_DURATION)) return

          const measured = measuredBandwidthBps(frag.stats)
          if (measured === null) return

          const bitrates = this.hls.levels.map(l => l.bitrate)
          const level = selectRendition(bitrates, measured, this.hls.autoLevelCapping)
          if (level < 0) return

          const describe = (i: number): string => {
            const l = this.hls!.levels[i]
            return `level ${i} (${l.width}x${l.height}, ${l.bitrate} bps)`
          }
          const kbps = Math.round(measured / 1000)

          if (heldLevel === -1) {
            heldLevel = level
            // Assigning `nextLevel` also turns hls.js's auto mode off,
            // which is the point: there is nothing left for it to adapt
            // to once the asset is buffered.
            this.hls.nextLevel = level
            logger.info(`[HLS] Probe ${kbps} kbps over ${frag.stats.loaded} B; holding ${describe(level)}`)
            return
          }

          // The confirming transfer. Whatever it says, stop here.
          renditionSettled = true
          if (bitrates[level] < bitrates[heldLevel]) {
            logger.info(
              `[HLS] Confirming transfer ${kbps} kbps over ${frag.stats.loaded} B ` +
              `cannot carry ${describe(heldLevel)}; dropping to ${describe(level)}`
            )
            heldLevel = level
            this.hls.nextLevel = level
          } else {
            logger.info(`[HLS] Confirming transfer ${kbps} kbps; keeping ${describe(heldLevel)}`)
          }
        })

        let networkRecoveries = 0
        let mediaRecoveries = 0
        const MAX_RECOVERIES = MAX_ERROR_RETRIES

        this.hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            logger.warn('[HLS] Fatal error:', data.type, data.details)
            reportError('hls', new Error(`${data.type}: ${data.details}`))
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              if (networkRecoveries < MAX_RECOVERIES) {
                networkRecoveries++
                this.hls?.startLoad()
              } else {
                fail(data.type, data.details,
                  new Error(`HLS network error after ${MAX_RECOVERIES} retries: ${data.details}`))
              }
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              if (mediaRecoveries < MAX_RECOVERIES) {
                mediaRecoveries++
                // If the device can't handle the current level, drop one
                // rung to prevent repeatedly hitting the same wall.
                //
                // Which lever does that depends on whether a rendition
                // has been held: holding one turns auto mode off, and
                // `autoLevelCapping` only constrains auto mode, so
                // capping there would silently do nothing and the
                // instance would keep failing to decode the same level.
                if (this.hls && heldLevel > 0) {
                  heldLevel -= 1
                  // A decode failure outranks the bandwidth measurement,
                  // so this drop is final — no later confirming transfer
                  // gets to reconsider it.
                  renditionSettled = true
                  logger.warn(`[HLS] Media error at held level ${heldLevel + 1}, dropping to ${heldLevel}`)
                  this.hls.nextLevel = heldLevel
                } else if (this.hls && this.hls.currentLevel > 0) {
                  // One-way, and deliberately so: nothing lifts this cap
                  // again for the life of the instance. A device that
                  // failed to decode a rung once will usually fail on it
                  // again, and re-raising the ceiling on a clean recovery
                  // would walk straight back into the same wall — each
                  // round costing another decode failure and another
                  // recoverMediaError, against a retry budget of
                  // MAX_ERROR_RETRIES before the stream is given up as
                  // dead. Ratcheting down is the cheaper mistake.
                  const safeLevel = this.hls.currentLevel - 1
                  logger.warn(`[HLS] Media error at level ${this.hls.currentLevel}, capping to ${safeLevel}`)
                  this.hls.autoLevelCapping = safeLevel
                }
                this.hls?.recoverMediaError()
              } else {
                fail(data.type, data.details,
                  new Error(`HLS media error after ${MAX_RECOVERIES} retries: ${data.details}`))
              }
            } else {
              fail(data.type, data.details, new Error(`HLS fatal error: ${data.details}`))
            }
          }
        })
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS support
        video.src = hlsUrl
        video.addEventListener('loadedmetadata', () => succeed(), { once: true })
        // Deliberately not `once`: on this path the same listener is the
        // only report of a stream that dies during playback, which is
        // the case this whole seam exists for. `destroy()` drops the
        // handler, and the element goes with it.
        video.addEventListener('error', () => fail('native', 'nativeHlsError',
          new Error('Native HLS load failed')))
      } else {
        fail('unsupported', 'hlsUnsupported', new Error('HLS is not supported in this browser'))
      }
    })
  }

  /**
   * Load a direct MP4 file (fallback when HLS fails)
   */
  loadDirect(mp4Url: string, video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
      // Same settle-once shape as `loadStream`, for the same reason:
      // this is the path a failed HLS stream falls back *to*, so it
      // dying quietly after load leaves a panel with nothing left.
      let settled = false
      video.src = mp4Url
      video.addEventListener('loadedmetadata', () => {
        logger.info('[HLS] Direct MP4 loaded, duration:', video.duration)
        if (settled) return
        settled = true
        resolve()
      }, { once: true })
      video.addEventListener('error', () => {
        if (settled) {
          logger.warn('[HLS] Direct MP4 failed after load')
          reportError('hls', new Error('progressive: mp4ErrorAfterLoad'))
          this.reportFatal({ type: 'native', details: 'mp4ErrorAfterLoad' })
          return
        }
        settled = true
        reject(new Error('Failed to load MP4 directly'))
      })
    })
  }

  /** Return the underlying video element, or null if not yet created. */
  getVideo(): HTMLVideoElement | null {
    return this.video
  }

  /** Video duration in seconds. */
  get duration(): number {
    return this.video?.duration ?? 0
  }

  /** Current playback position in seconds. */
  get currentTime(): number {
    return this.video?.currentTime ?? 0
  }

  /** Seek to a specific time in seconds. */
  set currentTime(time: number) {
    if (this.video) this.video.currentTime = time
  }

  /** Whether the video is currently paused. */
  get paused(): boolean {
    return this.video?.paused ?? true
  }

  /** Start or resume playback. */
  play(): Promise<void> | undefined {
    return this.video?.play()
  }

  /** Pause playback. */
  pause(): void {
    this.video?.pause()
  }

  /** Set the playback speed multiplier. */
  set playbackRate(rate: number) {
    if (this.video) this.video.playbackRate = rate
  }

  /** Current playback speed multiplier (1 = normal). */
  get playbackRate(): number {
    return this.video?.playbackRate ?? 1
  }

  /**
   * Returns true if the loaded stream has at least one audio track.
   * Works for both HLS.js and native HLS/direct MP4 paths.
   */
  get hasAudio(): boolean {
    if (this.hls && this.hls.audioTracks.length > 0) return true
    const v = this.video as HTMLVideoElement & {
      audioTracks?: { length: number }
      webkitAudioDecodedByteCount?: number
      mozHasAudio?: boolean
    }
    if (!v) return false
    // Safari / Firefox
    if (v.audioTracks && v.audioTracks.length > 0) return true
    if (v.mozHasAudio) return true
    // Chromium: if any audio bytes have been decoded, there's an audio track
    if (typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount > 0) return true
    return false
  }

  /** Tear down the HLS instance, stop playback, and remove the video element from the DOM. */
  destroy(): void {
    // Before anything else: `video.load()` below can fire `error`, and
    // the native paths keep their listener armed on purpose. A panel
    // being disposed must not be told its stream failed.
    this.fatalErrorHandler = null
    this.pendingFatalError = null
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    if (this.video) {
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load()
      this.video.remove()
      this.video = null
    }
  }
}
