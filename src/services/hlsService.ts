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
      const succeed = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      const fail = (type: string, details: string, error: Error): void => {
        if (settled) {
          this.reportFatal({ type, details })
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
                // If the device can't handle the current level, cap ABR
                // one level below to prevent repeatedly hitting the same wall.
                if (this.hls && this.hls.currentLevel > 0) {
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
