/**
 * HLS streaming service - fetches manifests from video proxy and manages HLS playback
 */

import Hls from 'hls.js'

export interface VideoProxyFile {
  quality: string
  width?: number
  height?: number
  size: number
  type: string
  link: string
}

export interface VideoProxyResponse {
  id: string
  title: string
  duration: number
  hls: string
  dash: string
  files: VideoProxyFile[]
}

const VIDEO_PROXY_BASE = 'https://video-proxy.zyra-project.org/video'

export class HLSService {
  private hls: Hls | null = null
  private video: HTMLVideoElement | null = null

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
    video.style.display = 'none'
    document.body.appendChild(video)
    this.video = video
    return video
  }

  /**
   * Load an HLS stream into the video element
   */
  loadStream(hlsUrl: string, video: HTMLVideoElement, mobile = false): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up previous HLS instance
      if (this.hls) {
        this.hls.destroy()
        this.hls = null
      }

      if (Hls.isSupported()) {
        this.hls = new Hls(mobile ? {
          // Mobile: minimal buffer to keep memory usage low
          maxBufferLength: 8,
          maxMaxBufferLength: 15,
          startLevel: 0,           // Start at lowest quality level
          capLevelToPlayerSize: true,
        } : {
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          startLevel: -1,          // Auto-detect on first load
          capLevelToPlayerSize: false,
        })

        this.hls.loadSource(hlsUrl)
        this.hls.attachMedia(video)

        this.hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
          const levels = this.hls!.levels.map(l => `${l.width}x${l.height}`)
          console.log(`[HLS] Manifest parsed, ${data.levels.length} quality levels:`, levels)
          resolve()
        })

        this.hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          const level = this.hls!.levels[data.level]
          console.log(`[HLS] Quality switched to level ${data.level}: ${level.width}x${level.height} (${level.bitrate} bps)`)
        })

        this.hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            console.error('[HLS] Fatal error:', data.type, data.details)
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              // Try to recover from network errors
              this.hls?.startLoad()
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              this.hls?.recoverMediaError()
            } else {
              reject(new Error(`HLS fatal error: ${data.details}`))
            }
          }
        })
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari native HLS support
        video.src = hlsUrl
        video.addEventListener('loadedmetadata', () => resolve(), { once: true })
        video.addEventListener('error', () => reject(new Error('Native HLS load failed')), { once: true })
      } else {
        reject(new Error('HLS is not supported in this browser'))
      }
    })
  }

  /**
   * Load a direct MP4 file (fallback when HLS fails)
   */
  loadDirect(mp4Url: string, video: HTMLVideoElement): Promise<void> {
    return new Promise((resolve, reject) => {
      video.src = mp4Url
      video.addEventListener('loadedmetadata', () => {
        console.log('[HLS] Direct MP4 loaded, duration:', video.duration)
        resolve()
      }, { once: true })
      video.addEventListener('error', () => {
        reject(new Error('Failed to load MP4 directly'))
      }, { once: true })
    })
  }

  getVideo(): HTMLVideoElement | null {
    return this.video
  }

  get duration(): number {
    return this.video?.duration ?? 0
  }

  get currentTime(): number {
    return this.video?.currentTime ?? 0
  }

  set currentTime(time: number) {
    if (this.video) this.video.currentTime = time
  }

  get paused(): boolean {
    return this.video?.paused ?? true
  }

  play(): Promise<void> | undefined {
    return this.video?.play()
  }

  pause(): void {
    this.video?.pause()
  }

  set playbackRate(rate: number) {
    if (this.video) this.video.playbackRate = rate
  }

  get playbackRate(): number {
    return this.video?.playbackRate ?? 1
  }

  destroy(): void {
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }
    if (this.video) {
      this.video.pause()
      this.video.src = ''
      this.video.remove()
      this.video = null
    }
  }
}
