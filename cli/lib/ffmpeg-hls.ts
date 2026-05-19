/**
 * FFmpeg HLS encoder wrapper — multi-rendition equirectangular.
 *
 * Phase 3 commit A. Drives an `ffmpeg` child process that takes a
 * source MP4 (typically the highest-quality download from the
 * Vimeo proxy, e.g. 4096x2048 equirectangular spherical) and
 * produces an adaptive-bitrate HLS bundle with three renditions
 * at 2:1 aspect ratio:
 *
 *   - 4K spherical (4096x2048) — matches NOAA's SOS source
 *     dimensions; preserves full source resolution.
 *   - 1080p stretched to 2:1 (2160x1080) — the typical desktop
 *     viewing tier. Stream's standard plan capped at this; on
 *     R2 we own the rendition policy so we keep it as one tier
 *     of an ABR ladder rather than the ceiling.
 *   - 720p stretched to 2:1 (1440x720) — mobile / slow-connection
 *     fallback.
 *
 * 6-second segments (VOD-style — fewer files than the 2-4 second
 * range Apple recommends for live, plenty precise for VOD seek).
 * H.264 main profile + AAC 192kbps audio. Master playlist named
 * `master.m3u8`; variant playlists at `stream_<n>/playlist.m3u8`
 * with segments alongside.
 *
 * Output directory layout after a successful encode:
 *
 *   outputDir/
 *     master.m3u8                      (master playlist; 3 variants)
 *     stream_0/                        (4K rendition)
 *       playlist.m3u8
 *       segment_000.ts
 *       segment_001.ts
 *       ...
 *     stream_1/                        (1080p rendition)
 *       playlist.m3u8
 *       segment_*.ts
 *     stream_2/                        (720p rendition)
 *       playlist.m3u8
 *       segment_*.ts
 *
 * The bundle is self-contained — uploading the whole directory
 * to R2 under one key prefix gives a working HLS asset; the
 * master playlist's variant URIs are relative paths that resolve
 * against the master's location.
 *
 * Caller is responsible for cleaning up `outputDir`. The helper
 * does not delete on failure — operator can inspect the partial
 * output for debugging via `--keep-workdir` on the migrate
 * subcommand.
 *
 * `child_process.spawn` is dependency-injected for tests. The
 * production caller passes nothing and gets `spawn` from
 * `node:child_process`.
 */

import { spawn as nodeSpawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Readable, Writable } from 'node:stream'

/** Type-narrowed spawn that returns a process with streamable
 * stdio. We don't pipe stdin; the source comes from `-i <path>`. */
type SpawnFn = (
  command: string,
  args: readonly string[],
  options?: { stdio?: ('pipe' | 'ignore' | 'inherit')[] },
) => ChildProcessByStdio<Writable | null, Readable, Readable>

export interface HlsRendition {
  /** Output height in pixels. Width = 2 × height (2:1 aspect). */
  height: number
  /** x264 CRF (lower = higher quality, bigger files). 18-23 is
   * the typical visually-transparent range for VOD. */
  crf: number
  /** Suggested max bitrate in kbps. Caps the encoder's rate
   * decisions for ABR ladder predictability. */
  maxBitrateKbps: number
}

/**
 * Default rendition ladder. Operator-facing decision per the
 * Phase 3 brief: 4K + 1080p + 720p at 2:1 spherical. The CRF
 * values are graded — 4K gets the lowest CRF (highest quality)
 * because aliasing artifacts in the source resolution are the
 * most visible after sphere-projection magnification.
 */
export const DEFAULT_RENDITIONS: readonly HlsRendition[] = [
  { height: 2048, crf: 18, maxBitrateKbps: 25_000 }, // 4K spherical (4096x2048)
  { height: 1080, crf: 20, maxBitrateKbps: 8_000 },  //   1080p (2160x1080)
  { height: 720,  crf: 22, maxBitrateKbps: 4_000 },  //   720p  (1440x720)
] as const

export const DEFAULT_SEGMENT_SECONDS = 6
export const DEFAULT_AUDIO_BITRATE_KBPS = 192
export const MASTER_PLAYLIST_NAME = 'master.m3u8'

/**
 * Catalog-wide output frame rate. The tour engine's `frameRate`
 * task in `src/services/tourEngine.ts:execDatasetAnimation`
 * hard-codes 30 fps as the assumed source rate when computing
 * playback rate as `requestedFps / 30`; encoding everything at
 * 30 fps keeps that math correct by construction for any source
 * (MP4 OR image-sequence). The image-sequence path also passes
 * `-framerate 30` on the input side via the runner's
 * `inputArgs`. Both halves use this constant so a future change
 * (e.g. raising to 60 fps to match a future tour-engine update)
 * is a one-line edit.
 */
export const OUTPUT_FRAME_RATE = 30

/** Bytes of FFmpeg stderr to retain for error reporting. The
 * accumulator below trims itself once total bytes exceeds 2 ×
 * this value so memory is bounded regardless of encode duration. */
const STDERR_TAIL_BYTES = 4096

export interface EncodeHlsOptions {
  /** Source MP4 — either a local file path (must exist) or an
   * http(s) URL that ffmpeg fetches itself. The Phase 3 migration
   * passes the video-proxy URL directly so the bytes never touch
   * the operator's disk on the input side. */
  inputPath: string
  /** Output directory. Created (recursively) if missing. */
  outputDir: string
  /** Override the default rendition ladder. */
  renditions?: readonly HlsRendition[]
  /** Segment length in seconds. Defaults to 6. */
  segmentSeconds?: number
  /** Audio bitrate in kbps. Defaults to 192. */
  audioBitrateKbps?: number
  /** Override the ffmpeg binary path. Defaults to `ffmpeg` on PATH. */
  ffmpegBin?: string
  /** Override the ffprobe binary path. Defaults to `ffprobe` on
   * PATH (typically ships alongside ffmpeg). */
  ffprobeBin?: string
  /** Test injection — defaults to `node:child_process`'s `spawn`. */
  spawnImpl?: SpawnFn
  /** Called for each line FFmpeg writes to stderr. FFmpeg uses
   * stderr for both progress and errors; the operator CLI prints
   * each line for visibility. */
  onProgress?: (line: string) => void
  /** Override the audio-presence detection. When unset, encodeHls
   * runs `ffprobe` against `inputPath` to determine whether to
   * include audio mapping in the argv. SOS spherical videos are
   * typically silent — calling them out explicitly is faster than
   * the probe, but the probe is the safe default. */
  hasAudio?: boolean
  /** Pre-`-i` flags to insert into the ffmpeg argv. The
   *  image-sequence path (Phase 3pf) uses `['-framerate', '30']`
   *  to tell ffmpeg's image-sequence demuxer how to read the
   *  numbered frames at `inputPath` (which itself takes a
   *  printf-style pattern like `frames/%05d.png`). MP4 callers
   *  leave this empty — ffmpeg reads the source's encoded fps
   *  directly and the `-r 30` on each output rendition then
   *  normalises the encode. */
  inputArgs?: readonly string[]
}

export interface EncodedHls {
  /** Absolute path to the master playlist. */
  masterPlaylistPath: string
  /** All produced files relative to `outputDir`, including the
   * master playlist, variant playlists, and `.ts` segments. */
  files: string[]
  /** Wall-clock encoding duration in ms. */
  durationMs: number
  /** Sum of all output files' bytes. */
  outputBytes: number
}

export class FfmpegError extends Error {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  /** Last ~4KB of stderr captured before the process exited.
   * Surfaced verbatim so the operator can read the actual ffmpeg
   * error message rather than just an exit code. */
  readonly stderrTail: string

  constructor(
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderrTail: string,
    message: string,
  ) {
    super(message)
    this.name = 'FfmpegError'
    this.exitCode = exitCode
    this.signal = signal
    this.stderrTail = stderrTail
  }
}

/**
 * Build the FFmpeg argv for the multi-rendition HLS encode.
 * Exported so tests can assert on the exact command shape — the
 * encoder's output quality is determined by this argv, so pinning
 * it explicitly catches regressions like a missing `-crf` or a
 * silent profile change.
 *
 * The `-filter_complex` pipeline splits the input video into N
 * branches, scales each branch to a different height (width
 * derived as 2 × height to preserve 2:1 aspect), and labels them
 * `[v0]`..`[vN-1]` for `-map` to pick up. Audio is shared across
 * all renditions — one AAC encode, referenced from each variant
 * playlist via `-var_stream_map`.
 */
export function buildFfmpegArgs(
  inputPath: string,
  outputDir: string,
  renditions: readonly HlsRendition[],
  segmentSeconds: number,
  audioBitrateKbps: number,
  hasAudio: boolean = true,
  inputArgs: readonly string[] = [],
): string[] {
  const splits = renditions.length
  const filterParts: string[] = [`[0:v]split=${splits}` + renditions.map((_, i) => `[s${i}]`).join('')]
  for (let i = 0; i < renditions.length; i++) {
    const r = renditions[i]
    const width = r.height * 2
    filterParts.push(`[s${i}]scale=${width}:${r.height}[v${i}]`)
  }
  const filterComplex = filterParts.join(';')

  // `inputArgs` lets the caller insert pre-`-i` flags. The
  // image-sequence path uses `['-framerate', '30']` to declare
  // the input frame rate — ffmpeg's image-sequence demuxer
  // defaults to 25 fps otherwise. The MP4 path passes an empty
  // array; ffmpeg reads the source's encoded fps directly. The
  // `-r 30` we add to each *output* below then normalises both
  // paths to 30 fps regardless of source.
  const args: string[] = [
    '-y',
    ...inputArgs,
    '-i',
    inputPath,
    '-filter_complex',
    filterComplex,
  ]

  // Per-rendition video output streams. -map "[vN]" picks up the
  // labelled output from the filter graph; -c:v:N / -crf:v:N /
  // -maxrate:v:N target the Nth video output specifically.
  for (let i = 0; i < renditions.length; i++) {
    const r = renditions[i]
    args.push('-map', `[v${i}]`)
    args.push(`-c:v:${i}`, 'libx264')
    args.push(`-profile:v:${i}`, 'main')
    args.push(`-preset:v:${i}`, 'slow')
    args.push(`-crf:v:${i}`, String(r.crf))
    args.push(`-maxrate:v:${i}`, `${r.maxBitrateKbps}k`)
    // bufsize ~ 2x maxrate is the standard CBR-ish recommendation.
    args.push(`-bufsize:v:${i}`, `${r.maxBitrateKbps * 2}k`)
    // Force 30 fps output across every rendition. The tour
    // engine's `frameRate` task in `src/services/tourEngine.ts`
    // hard-codes 30 as the assumed source rate when computing
    // playback rate, so a non-30-fps encode breaks tour playback
    // speed. Normalising here makes the invariant true for both
    // the MP4-source path (which used to pass source fps
    // through) and the image-sequence path (3pf/C) — fixes the
    // pre-3pf latent bug where a 60 fps MP4 source published
    // pre-3pf produced a video that ran at 2× whatever the tour
    // requested. With `-r 30` on the output side, the
    // `-keyint_min` / `-g` math (segmentSeconds × 30) below is
    // now correct by construction rather than by assumption.
    args.push(`-r:v:${i}`, String(OUTPUT_FRAME_RATE))
    args.push(`-keyint_min:v:${i}`, String(segmentSeconds * OUTPUT_FRAME_RATE))
    args.push(`-g:v:${i}`, String(segmentSeconds * OUTPUT_FRAME_RATE))
    args.push(`-sc_threshold:v:${i}`, '0')
  }

  // Audio mapping (only when the source has an audio stream).
  //
  // FFmpeg's HLS muxer rejects var_stream_map definitions where
  // the same elementary audio stream is referenced from multiple
  // variants (error: "Same elementary stream found more than
  // once in two different variant definitions"). Two ways to
  // share audio across variants:
  //   (a) Audio groups via `agroup:` in var_stream_map — one
  //       audio rendition declared separately, referenced by
  //       each video variant. Smaller output but more complex
  //       argv.
  //   (b) Emit one audio output per video rendition. Each
  //       `-map a:0` creates a new audio output stream; the
  //       global `-c:a aac -b:a Xk` applies to all of them.
  //       Each variant references its own a:N. Trivially
  //       simpler argv, ~192 kbps × N video tiers of extra
  //       output bytes per row.
  //
  // We use (b). For ~136 rows × probably <40 with audio × ~3
  // minutes × 192 kbps × 2 extra tiers ≈ ~70 MB of audio
  // duplication across the whole catalog. Lost in the noise
  // next to the multi-GB total. Worth the argv simplicity.
  if (hasAudio) {
    for (let i = 0; i < renditions.length; i++) {
      args.push('-map', 'a:0')
    }
    args.push('-c:a', 'aac')
    args.push('-b:a', `${audioBitrateKbps}k`)
    args.push('-ac', '2')
  }

  // HLS muxer config.
  args.push('-f', 'hls')
  args.push('-hls_time', String(segmentSeconds))
  args.push('-hls_playlist_type', 'vod')
  args.push('-hls_segment_filename', join(outputDir, 'stream_%v', 'segment_%03d.ts'))
  args.push('-master_pl_name', MASTER_PLAYLIST_NAME)

  // `-var_stream_map` tells the HLS muxer which input streams go
  // in which variant. Each variant gets one video output (v:i),
  // plus its own audio output (a:i) when audio is present —
  // see the audio-mapping comment above for why we don't share
  // a single audio stream across variants.
  const streamMap = renditions
    .map((_, i) => (hasAudio ? `v:${i},a:${i}` : `v:${i}`))
    .join(' ')
  args.push('-var_stream_map', streamMap)

  // Variant playlist filename pattern — `%v` is replaced by the
  // variant index. With our stream-map this yields stream_0,
  // stream_1, stream_2 directories alongside the master playlist.
  args.push(join(outputDir, 'stream_%v', 'playlist.m3u8'))

  return args
}

/**
 * Encode a source MP4 to a multi-rendition HLS bundle. Resolves
 * when ffmpeg exits cleanly + the master playlist exists; rejects
 * with `FfmpegError` on a non-zero exit or a missing master
 * playlist.
 */
export async function encodeHls(options: EncodeHlsOptions): Promise<EncodedHls> {
  // `inputPath` accepts either a local file path or an http(s)
  // URL — ffmpeg reads both. The pre-flight existence check only
  // applies to local paths; URLs are validated by ffmpeg at fetch
  // time (a 4xx/5xx upstream surfaces as a non-zero exit + stderr
  // tail, which already produces a clean FfmpegError).
  //
  // The Phase 3 migrate-r2-hls subcommand passes the video-proxy's
  // MP4 URL directly here so ffmpeg streams it without an
  // intermediate disk write.
  if (!isHttpUrl(options.inputPath) && !existsSync(options.inputPath)) {
    throw new Error(`encodeHls: input ${options.inputPath} does not exist`)
  }
  mkdirSync(options.outputDir, { recursive: true })

  const renditions = options.renditions ?? DEFAULT_RENDITIONS
  if (renditions.length === 0) {
    throw new Error('encodeHls: renditions must be non-empty')
  }
  const segmentSeconds = options.segmentSeconds ?? DEFAULT_SEGMENT_SECONDS
  const audioBitrateKbps = options.audioBitrateKbps ?? DEFAULT_AUDIO_BITRATE_KBPS
  const ffmpegBin = options.ffmpegBin ?? 'ffmpeg'
  const ffprobeBin = options.ffprobeBin ?? 'ffprobe'
  const spawnImpl = (options.spawnImpl ?? (nodeSpawn as unknown as SpawnFn))

  // Detect audio presence. SOS spherical videos are typically
  // silent, but the narrated educational pieces have audio
  // tracks — we can't assume one shape. ffprobe is the canonical
  // metadata-only probe; it's a separate binary but ships
  // alongside ffmpeg in every standard distribution.
  const hasAudio =
    options.hasAudio !== undefined
      ? options.hasAudio
      : await probeHasAudio(options.inputPath, ffprobeBin, spawnImpl)

  // `mkdir -p stream_<n>` for each variant up front — FFmpeg's
  // `-hls_segment_filename` and variant-playlist patterns expect
  // the directories to exist before the muxer starts writing.
  for (let i = 0; i < renditions.length; i++) {
    mkdirSync(join(options.outputDir, `stream_${i}`), { recursive: true })
  }

  const args = buildFfmpegArgs(
    options.inputPath,
    options.outputDir,
    renditions,
    segmentSeconds,
    audioBitrateKbps,
    hasAudio,
    options.inputArgs ?? [],
  )

  const start = Date.now()
  // Bounded stderr accumulator. FFmpeg can write tens of MB of
  // progress lines over a multi-minute encode; we only need the
  // last ~4KB for error reporting. The buffer trims itself when
  // the total exceeds 2 × the tail size — that gives a single
  // amortized shift per ~4KB of stderr instead of one per line,
  // while ensuring memory stays within ~8KB regardless of run
  // length.
  const stderr = createBoundedStderr(STDERR_TAIL_BYTES)

  return await new Promise<EncodedHls>((resolve, reject) => {
    const child = spawnImpl(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })

    // FFmpeg writes nothing useful to stdout for our config; we
    // still pipe it to consume the buffer so the process doesn't
    // block on a full pipe.
    if (child.stdout) {
      child.stdout.on('data', () => {})
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf-8')
      let partial = ''
      child.stderr.on('data', (chunk: string) => {
        // FFmpeg uses '\r' for in-line progress updates AND '\n'
        // for new log lines. Split on either so onProgress sees
        // each update separately.
        partial += chunk
        const lines = partial.split(/[\r\n]/)
        partial = lines.pop() ?? ''
        for (const line of lines) {
          if (line.length === 0) continue
          stderr.push(line + '\n')
          options.onProgress?.(line)
        }
      })
      child.stderr.on('end', () => {
        if (partial.length > 0) {
          stderr.push(partial)
          options.onProgress?.(partial)
        }
      })
    }

    child.on('error', err => {
      reject(
        new FfmpegError(
          null,
          null,
          stderr.tail(),
          `ffmpeg spawn failed: ${err.message}. Is '${ffmpegBin}' on PATH?`,
        ),
      )
    })

    child.on('close', (code, signal) => {
      const tail = stderr.tail()
      if (code !== 0) {
        reject(
          new FfmpegError(
            code,
            signal,
            tail,
            `ffmpeg exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
          ),
        )
        return
      }

      const masterPlaylistPath = join(options.outputDir, MASTER_PLAYLIST_NAME)
      if (!existsSync(masterPlaylistPath)) {
        reject(
          new FfmpegError(
            code,
            signal,
            tail,
            `ffmpeg exited 0 but master playlist ${MASTER_PLAYLIST_NAME} was not produced`,
          ),
        )
        return
      }

      const files: string[] = []
      let outputBytes = 0
      collectFiles(options.outputDir, options.outputDir, files, size => {
        outputBytes += size
      })

      resolve({
        masterPlaylistPath,
        files,
        durationMs: Date.now() - start,
        outputBytes,
      })
    })
  })
}

/** True when `inputPath` is an http(s) URL ffmpeg will fetch
 * over the network rather than read from disk. */
function isHttpUrl(inputPath: string): boolean {
  return /^https?:\/\//i.test(inputPath)
}

/**
 * Run `ffprobe` against the input and return true iff the source
 * has at least one audio stream. Used by `encodeHls` to decide
 * whether to include the `-c:a aac` / audio-map / var_stream_map
 * `a:0` references in the argv.
 *
 * Failure semantics: on any ffprobe error (binary missing, network
 * probe of a URL fails, unreadable input), assume no audio and
 * let ffmpeg surface the real failure during the encode. This
 * keeps the helper's failure mode predictable — the *encode*
 * stage is where the operator already expects errors; an
 * unrecoverable probe shouldn't introduce a different stage they
 * have to learn about.
 */
async function probeHasAudio(
  inputPath: string,
  ffprobeBin: string,
  spawnImpl: SpawnFn,
): Promise<boolean> {
  // `-select_streams a` filters to audio streams. `-show_streams`
  // produces one entry per match. `-of csv=p=0` gives the simplest
  // possible parseable output (one row per stream). Non-empty
  // stdout → audio exists.
  const args = [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_streams',
    '-of',
    'csv=p=0',
    inputPath,
  ]
  return await new Promise<boolean>(resolve => {
    let child
    try {
      child = spawnImpl(ffprobeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(false)
      return
    }
    let stdout = ''
    if (child.stdout) {
      child.stdout.setEncoding('utf-8')
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
    }
    if (child.stderr) {
      // Consume stderr to keep the pipe drained.
      child.stderr.on('data', () => {})
    }
    child.on('error', () => resolve(false))
    child.on('close', code => {
      if (code !== 0) {
        resolve(false)
        return
      }
      resolve(stdout.trim().length > 0)
    })
  })
}

/**
 * Bounded stderr accumulator — appends lines while keeping the
 * total retained bytes within a small constant multiple of
 * `maxBytes`. FFmpeg encodes can emit tens of MB of progress
 * lines over a multi-minute run; without bounding, the array
 * would grow without limit even though we only ever read the
 * tail at the end.
 *
 * Strategy: maintain a running `totalBytes` and shift chunks off
 * the front once it exceeds `2 × maxBytes`, until it drops back
 * below `maxBytes`. That keeps memory at ≤ ~2 × maxBytes while
 * amortizing the shift cost to one per ~maxBytes of stderr.
 *
 * `tail()` is destructive-free — callers can read it multiple
 * times (e.g. from both the 'error' and 'close' event handlers
 * if a spawn failure races with a close).
 */
export interface BoundedStderr {
  push(chunk: string): void
  tail(): string
  /** Test-only: current retained byte count. */
  readonly totalBytes: number
}

export function createBoundedStderr(maxBytes: number): BoundedStderr {
  const trimThreshold = maxBytes * 2
  const chunks: string[] = []
  let totalBytes = 0
  return {
    push(chunk: string): void {
      chunks.push(chunk)
      totalBytes += chunk.length
      if (totalBytes <= trimThreshold) return
      // Shift off old chunks until we're back below maxBytes —
      // this keeps the most-recent maxBytes worth of stderr
      // intact (potentially with a small overshoot from the
      // chunk that crossed the boundary).
      while (chunks.length > 1 && totalBytes - chunks[0].length >= maxBytes) {
        totalBytes -= chunks.shift()!.length
      }
    },
    tail(): string {
      if (chunks.length === 0) return ''
      const all = chunks.length === 1 ? chunks[0] : chunks.join('')
      return all.length <= maxBytes ? all : all.slice(-maxBytes)
    },
    get totalBytes(): number {
      return totalBytes
    },
  }
}

/** Recursive directory walk producing relative paths. Stays
 * shallow on the common case (master + 3 dirs × ~30 segments)
 * so a synchronous walk is fine. */
function collectFiles(
  root: string,
  cur: string,
  out: string[],
  onSize: (n: number) => void,
): void {
  for (const entry of readdirSync(cur, { withFileTypes: true })) {
    const full = join(cur, entry.name)
    if (entry.isDirectory()) {
      collectFiles(root, full, out, onSize)
      continue
    }
    if (!entry.isFile()) continue
    out.push(relative(root, full))
    onSize(statSync(full).size)
  }
}
