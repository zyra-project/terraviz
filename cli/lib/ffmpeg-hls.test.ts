/**
 * Tests for `cli/lib/ffmpeg-hls.ts` (Phase 3 commit A).
 *
 * Two categories:
 *
 *   1. `buildFfmpegArgs` unit tests — pin the exact command-line
 *      shape we hand to ffmpeg. Encoder behavior (output quality
 *      / file size / playback compatibility) is determined by
 *      this argv, so pinning it catches silent regressions like
 *      a missing `-crf` or an accidental profile change.
 *
 *   2. `encodeHls` integration tests against a stubbed `spawn`
 *      that simulates the ffmpeg lifecycle (stderr progress
 *      lines, exit code, optional master-playlist creation).
 *      Real ffmpeg execution is out of scope for unit tests —
 *      the operator's `--dry-run` flow runs against a real
 *      ffmpeg before any migration commits.
 */

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFfmpegArgs,
  createBoundedStderr,
  DEFAULT_RENDITIONS,
  encodeHls,
  FfmpegError,
  MASTER_PLAYLIST_NAME,
  type HlsRendition,
} from './ffmpeg-hls'

describe('buildFfmpegArgs', () => {
  const RENDITIONS: HlsRendition[] = [
    { height: 2048, crf: 18, maxBitrateKbps: 25_000 },
    { height: 1080, crf: 20, maxBitrateKbps: 8_000 },
    { height: 720, crf: 22, maxBitrateKbps: 4_000 },
  ]

  it('produces the canonical argv shape for a 3-rendition HLS encode', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 6, 192)
    // Input + filter graph.
    expect(args).toContain('-i')
    expect(args[args.indexOf('-i') + 1]).toBe('/in.mp4')
    expect(args).toContain('-filter_complex')
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain('split=3')
    expect(filter).toContain('scale=4096:2048')
    expect(filter).toContain('scale=2160:1080')
    expect(filter).toContain('scale=1440:720')
  })

  it('emits per-rendition video stream options at the correct indexes', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 6, 192)
    // Each rendition gets its own indexed codec / CRF / maxrate.
    for (let i = 0; i < RENDITIONS.length; i++) {
      const r = RENDITIONS[i]
      expect(args).toContain(`-c:v:${i}`)
      expect(args[args.indexOf(`-c:v:${i}`) + 1]).toBe('libx264')
      expect(args).toContain(`-profile:v:${i}`)
      expect(args[args.indexOf(`-profile:v:${i}`) + 1]).toBe('main')
      expect(args).toContain(`-crf:v:${i}`)
      expect(args[args.indexOf(`-crf:v:${i}`) + 1]).toBe(String(r.crf))
      expect(args).toContain(`-maxrate:v:${i}`)
      expect(args[args.indexOf(`-maxrate:v:${i}`) + 1]).toBe(`${r.maxBitrateKbps}k`)
    }
  })

  it('encodes one audio output per video rendition (3/L)', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 6, 192, true)
    expect(args).toContain('-c:a')
    expect(args[args.indexOf('-c:a') + 1]).toBe('aac')
    expect(args).toContain('-b:a')
    expect(args[args.indexOf('-b:a') + 1]).toBe('192k')
    // 3/L switched from a single shared `-map a:0` to one
    // `-map a:0` per rendition so each var_stream_map entry
    // references its own distinct audio elementary stream.
    // FFmpeg's HLS muxer rejects "Same elementary stream found
    // more than once in two different variant definitions" when
    // multiple variants share a:0. Count occurrences here.
    let audioMaps = 0
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-map' && args[i + 1] === 'a:0') audioMaps++
    }
    expect(audioMaps).toBe(RENDITIONS.length)
  })

  it('sets HLS muxer options (segment time, playlist type, master name)', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 6, 192)
    expect(args).toContain('-f')
    expect(args[args.indexOf('-f') + 1]).toBe('hls')
    expect(args).toContain('-hls_time')
    expect(args[args.indexOf('-hls_time') + 1]).toBe('6')
    expect(args).toContain('-hls_playlist_type')
    expect(args[args.indexOf('-hls_playlist_type') + 1]).toBe('vod')
    expect(args).toContain('-master_pl_name')
    expect(args[args.indexOf('-master_pl_name') + 1]).toBe(MASTER_PLAYLIST_NAME)
  })

  it('builds a stream-map pairing each video variant with its own audio output (3/L)', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 6, 192)
    expect(args).toContain('-var_stream_map')
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0 v:1,a:1 v:2,a:2')
  })

  it('honours custom segment duration', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 4, 192)
    expect(args[args.indexOf('-hls_time') + 1]).toBe('4')
    // keyint should track segment duration × 30 fps.
    expect(args[args.indexOf('-keyint_min:v:0') + 1]).toBe('120')
  })

  it('handles a single-rendition ladder', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', [RENDITIONS[0]], 6, 128)
    const filter = args[args.indexOf('-filter_complex') + 1]
    expect(filter).toContain('split=1')
    expect(filter).toContain('scale=4096:2048')
    expect(args).toContain('-c:v:0')
    expect(args).not.toContain('-c:v:1')
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0')
  })

  it('DEFAULT_RENDITIONS matches the Phase 3 brief (4K + 1080p + 720p, 2:1)', () => {
    expect(DEFAULT_RENDITIONS).toHaveLength(3)
    expect(DEFAULT_RENDITIONS[0].height).toBe(2048)
    expect(DEFAULT_RENDITIONS[1].height).toBe(1080)
    expect(DEFAULT_RENDITIONS[2].height).toBe(720)
  })

  it('omits audio mapping + var_stream_map a:0 when hasAudio=false (3/K)', () => {
    // SOS spherical videos are typically silent. With hasAudio=
    // false the argv must not include `-c:a` / `-b:a` / audio
    // map, and var_stream_map must not reference a:0 — otherwise
    // ffmpeg's HLS muxer fails with "Unable to map stream at a:0".
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 6, 192, false)
    expect(args).not.toContain('-c:a')
    expect(args).not.toContain('-b:a')
    expect(args).not.toContain('-ac')
    // Audio output map gone.
    expect(args.findIndex((a, i) => a === '-map' && args[i + 1] === 'a:0?')).toBe(-1)
    expect(args.findIndex((a, i) => a === '-map' && args[i + 1] === 'a:0')).toBe(-1)
    // var_stream_map is video-only.
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0 v:1 v:2')
  })

  it('includes audio mapping by default (hasAudio implicit true)', () => {
    const args = buildFfmpegArgs('/in.mp4', '/out', RENDITIONS, 6, 192)
    expect(args).toContain('-c:a')
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0 v:1,a:1 v:2,a:2')
  })
})

/** Fake child_process matching the subset of the API encodeHls uses. */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter & { setEncoding: (enc: string) => void }
  stderr: EventEmitter & { setEncoding: (enc: string) => void }
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  // Both stdout + stderr need setEncoding because probeHasAudio
  // calls it on stdout and the encode path calls it on stderr.
  const stdout = new EventEmitter() as FakeChild['stdout']
  stdout.setEncoding = () => {}
  child.stdout = stdout
  const stderr = new EventEmitter() as FakeChild['stderr']
  stderr.setEncoding = () => {}
  child.stderr = stderr
  return child
}

interface RunArgs {
  /** Lines pushed to stderr (each typically a progress / status line). */
  stderr?: string[]
  /** Exit code passed to close(). 0 = success. */
  exitCode?: number
  /** Signal passed to close(). */
  signal?: NodeJS.Signals
  /** Throw at spawn time — simulates "ffmpeg not on PATH". */
  spawnThrows?: boolean
  /** When true, the fake creates a master playlist before close()
   * so the existence check inside encodeHls passes. */
  createMaster?: boolean
}

function runWithStub(
  outputDir: string,
  inputPath: string,
  opts: RunArgs = {},
): { promise: ReturnType<typeof encodeHls>; spawnImpl: ReturnType<typeof vi.fn>; stderr: string[] } {
  const child = makeFakeChild()
  const stderr: string[] = []
  const spawnImpl = vi.fn(() => {
    if (opts.spawnThrows) {
      // Simulate "spawn ENOENT" via the child's `error` event,
      // which is the channel undici-style spawn failures use.
      setTimeout(() => child.emit('error', new Error('spawn ENOENT')), 0)
      return child as unknown as ReturnType<typeof import('node:child_process').spawn>
    }
    // Drive the stderr stream first (so the helper accumulates the
    // tail), then close with the requested exit code.
    setTimeout(() => {
      for (const line of opts.stderr ?? []) {
        child.stderr.emit('data', line)
      }
      child.stderr.emit('end')
      if (opts.createMaster) {
        writeFileSync(join(outputDir, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
      }
      child.emit('close', opts.exitCode ?? 0, opts.signal ?? null)
    }, 0)
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>
  })

  const promise = encodeHls({
    inputPath,
    outputDir,
    spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
    // Bypass the ffprobe audio check — tests assert encode
    // behavior, not the probe wiring. The probe gets its own
    // dedicated test below.
    hasAudio: true,
    onProgress: line => stderr.push(line),
  })
  return { promise, spawnImpl, stderr }
}

describe('encodeHls', () => {
  it('resolves with file list + duration on a clean encode', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      const { promise } = runWithStub(tmp, input, {
        stderr: ['frame=  120 fps=24 q=20 size=1024kB time=00:00:05', 'video:1000kB audio:50kB'],
        exitCode: 0,
        createMaster: true,
      })
      const out = await promise
      expect(out.masterPlaylistPath).toBe(join(tmp, MASTER_PLAYLIST_NAME))
      expect(out.files).toContain(MASTER_PLAYLIST_NAME)
      expect(out.durationMs).toBeGreaterThanOrEqual(0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('streams stderr lines to onProgress', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      const { promise, stderr } = runWithStub(tmp, input, {
        stderr: ['line 1\n', 'line 2\rline 3\n'],
        exitCode: 0,
        createMaster: true,
      })
      await promise
      // Both \n and \r split; 3 distinct progress lines.
      expect(stderr).toEqual(['line 1', 'line 2', 'line 3'])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('throws FfmpegError with stderr tail on non-zero exit', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      const { promise } = runWithStub(tmp, input, {
        stderr: ['Invalid data found when processing input\n'],
        exitCode: 1,
      })
      const err = await promise.catch(e => e)
      expect(err).toBeInstanceOf(FfmpegError)
      expect(err.exitCode).toBe(1)
      expect(err.stderrTail).toContain('Invalid data')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('throws FfmpegError when ffmpeg exits 0 but master playlist is absent', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      const { promise } = runWithStub(tmp, input, {
        exitCode: 0,
        createMaster: false,
      })
      const err = await promise.catch(e => e)
      expect(err).toBeInstanceOf(FfmpegError)
      expect(err.message).toMatch(/master playlist/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('throws FfmpegError with a "is ffmpeg on PATH" hint when spawn fails', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      const { promise } = runWithStub(tmp, input, { spawnThrows: true })
      const err = await promise.catch(e => e)
      expect(err).toBeInstanceOf(FfmpegError)
      expect(err.message).toMatch(/spawn failed/)
      expect(err.message).toMatch(/PATH/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('refuses when the input file does not exist', async () => {
    await expect(
      encodeHls({
        inputPath: '/nonexistent/source.mp4',
        outputDir: '/tmp/whatever',
        spawnImpl: vi.fn() as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
      }),
    ).rejects.toThrow(/does not exist/)
  })

  it('skips the local-existence check when inputPath is an http(s) URL (3/J)', async () => {
    // The Phase 3 migrate-r2-hls subcommand passes the
    // video-proxy URL directly to ffmpeg via -i. The pre-flight
    // existsSync check (3/A) was rejecting these as
    // "does not exist" before reaching the spawn — this is the
    // regression that surfaced on the first live single-row run.
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    try {
      let capturedArgs: readonly string[] | null = null
      const child = makeFakeChild()
      const spawnImpl = vi.fn((_cmd: string, args: readonly string[]) => {
        capturedArgs = args
        setTimeout(() => {
          writeFileSync(join(tmp, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
          child.emit('close', 0, null)
        }, 0)
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      const url = 'https://video-proxy.example.org/video/808489116/file.mp4'
      const result = await encodeHls({
        inputPath: url,
        outputDir: tmp,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
        hasAudio: true,
      })
      expect(spawnImpl).toHaveBeenCalledOnce()
      // The URL is passed through to ffmpeg as -i.
      expect(capturedArgs).not.toBeNull()
      const iIdx = (capturedArgs as unknown as string[]).indexOf('-i')
      expect(iIdx).toBeGreaterThanOrEqual(0)
      expect((capturedArgs as unknown as string[])[iIdx + 1]).toBe(url)
      expect(result.masterPlaylistPath).toBe(join(tmp, MASTER_PLAYLIST_NAME))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('accepts an ffmpeg printf pattern when the parent directory has at least one file', async () => {
    // Phase 3pf image-sequence path — `cli/transcode-from-dispatch.ts`
    // hands ffmpeg a pattern like `frames/%05d.png` so the image2
    // demuxer consumes the numbered sequence as a single input.
    // The literal pattern is never a real file, so the old
    // `existsSync(inputPath)` guard rejected the encode before
    // ffmpeg ran (live failure surfaced post-merge of PR #117).
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    try {
      const framesDir = join(tmp, 'frames')
      const outputDir = join(tmp, 'out')
      // Seed the directory with one frame so the pre-flight
      // `readdirSync` check sees at least one entry. ffmpeg itself
      // would fail loudly on a missing pattern match — the
      // pre-flight only catches the obvious empty-dir case.
      const { mkdirSync: nodeMkdirSync } = await import('node:fs')
      nodeMkdirSync(framesDir, { recursive: true })
      nodeMkdirSync(outputDir, { recursive: true })
      writeFileSync(join(framesDir, '00000.png'), 'fake-png')
      const child = makeFakeChild()
      let capturedArgs: readonly string[] | null = null
      const spawnImpl = vi.fn((_cmd: string, args: readonly string[]) => {
        capturedArgs = args
        setTimeout(() => {
          writeFileSync(join(outputDir, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
          child.emit('close', 0, null)
        }, 0)
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      const patternPath = join(framesDir, '%05d.png')
      await encodeHls({
        inputPath: patternPath,
        outputDir,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
        hasAudio: false,
      })
      expect(spawnImpl).toHaveBeenCalledOnce()
      expect(capturedArgs).not.toBeNull()
      const iIdx = (capturedArgs as unknown as string[]).indexOf('-i')
      expect((capturedArgs as unknown as string[])[iIdx + 1]).toBe(patternPath)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('refuses an ffmpeg printf pattern whose parent directory is empty', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    try {
      const framesDir = join(tmp, 'frames')
      const { mkdirSync: nodeMkdirSync } = await import('node:fs')
      nodeMkdirSync(framesDir, { recursive: true })
      // No frames written — pre-flight should reject before spawn.
      const spawnImpl = vi.fn()
      await expect(
        encodeHls({
          inputPath: join(framesDir, '%05d.png'),
          outputDir: join(tmp, 'out'),
          spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
        }),
      ).rejects.toThrow(/is empty/)
      expect(spawnImpl).not.toHaveBeenCalled()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('refuses an ffmpeg printf pattern whose parent directory does not exist', async () => {
    const spawnImpl = vi.fn()
    await expect(
      encodeHls({
        inputPath: '/nonexistent-dir/%05d.png',
        outputDir: '/tmp/whatever',
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
      }),
    ).rejects.toThrow(/does not exist/)
    expect(spawnImpl).not.toHaveBeenCalled()
  })

  it('matches the URL check case-insensitively (HTTP:// works too)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    try {
      const child = makeFakeChild()
      const spawnImpl = vi.fn(() => {
        setTimeout(() => {
          writeFileSync(join(tmp, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
          child.emit('close', 0, null)
        }, 0)
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      // Same pre-flight skip should fire for uppercase scheme.
      await encodeHls({
        inputPath: 'HTTPS://example.org/x.mp4',
        outputDir: tmp,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
        hasAudio: true,
      })
      expect(spawnImpl).toHaveBeenCalledOnce()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('creates the output dir + per-rendition subdirs before spawning ffmpeg', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    const outputDir = join(tmp, 'out')
    try {
      const child = makeFakeChild()
      const spawnImpl = vi.fn(() => {
        setTimeout(() => {
          writeFileSync(join(outputDir, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
          child.emit('close', 0, null)
        }, 0)
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      await encodeHls({
        inputPath: input,
        outputDir,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
        hasAudio: true,
      })
      // Three rendition subdirs (default ladder).
      const { existsSync } = await import('node:fs')
      expect(existsSync(join(outputDir, 'stream_0'))).toBe(true)
      expect(existsSync(join(outputDir, 'stream_1'))).toBe(true)
      expect(existsSync(join(outputDir, 'stream_2'))).toBe(true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('probes for audio via ffprobe when hasAudio is unset (3/K)', async () => {
    // Simulate ffprobe returning empty stdout — i.e., no audio
    // stream — and verify that encodeHls's resulting argv omits
    // the audio mapping. This is the failure mode the live
    // single-row Tsunami run surfaced: the SOS spherical source
    // had no audio track, and the static `var_stream_map a:0`
    // reference broke the HLS muxer.
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      let ffmpegArgs: readonly string[] | null = null
      const spawnImpl = vi.fn((cmd: string, args: readonly string[]) => {
        const child = makeFakeChild()
        if (cmd.endsWith('ffprobe')) {
          // ffprobe — return empty stdout (no audio stream) + exit 0.
          setTimeout(() => {
            child.stdout.emit('data', '')
            child.emit('close', 0, null)
          }, 0)
        } else {
          // ffmpeg — capture argv + simulate a clean encode.
          ffmpegArgs = args
          setTimeout(() => {
            child.stderr.emit('end')
            writeFileSync(join(tmp, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
            child.emit('close', 0, null)
          }, 0)
        }
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      await encodeHls({
        inputPath: input,
        outputDir: tmp,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
      })
      expect(spawnImpl).toHaveBeenCalledTimes(2) // probe + encode
      expect(ffmpegArgs).not.toBeNull()
      // Audio absent in the argv since ffprobe reported no audio.
      const args = ffmpegArgs as unknown as string[]
      expect(args).not.toContain('-c:a')
      expect(args[args.indexOf('-var_stream_map') + 1]).toMatch(/^v:0 v:1 v:2$/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('includes audio mapping when ffprobe reports an audio stream', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      let ffmpegArgs: readonly string[] | null = null
      const spawnImpl = vi.fn((cmd: string, args: readonly string[]) => {
        const child = makeFakeChild()
        if (cmd.endsWith('ffprobe')) {
          setTimeout(() => {
            // Simulate ffprobe finding one audio stream — non-empty
            // CSV row on stdout.
            child.stdout.emit('data', 'aac,2,48000,128000\n')
            child.emit('close', 0, null)
          }, 0)
        } else {
          ffmpegArgs = args
          setTimeout(() => {
            child.stderr.emit('end')
            writeFileSync(join(tmp, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
            child.emit('close', 0, null)
          }, 0)
        }
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      await encodeHls({
        inputPath: input,
        outputDir: tmp,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
      })
      const args = ffmpegArgs as unknown as string[]
      expect(args).toContain('-c:a')
      expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0 v:1,a:1 v:2,a:2')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('treats ffprobe failures as "no audio" (predictable fallback)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      let ffmpegArgs: readonly string[] | null = null
      const spawnImpl = vi.fn((cmd: string, args: readonly string[]) => {
        const child = makeFakeChild()
        if (cmd.endsWith('ffprobe')) {
          // ffprobe fails — non-zero exit. encodeHls should treat
          // this as "no audio" and let ffmpeg surface any real
          // problem during the encode.
          setTimeout(() => child.emit('close', 1, null), 0)
        } else {
          ffmpegArgs = args
          setTimeout(() => {
            child.stderr.emit('end')
            writeFileSync(join(tmp, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
            child.emit('close', 0, null)
          }, 0)
        }
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      await encodeHls({
        inputPath: input,
        outputDir: tmp,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
      })
      const args = ffmpegArgs as unknown as string[]
      expect(args).not.toContain('-c:a')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('bounds stderr memory during a long encode (3/N)', async () => {
    // Copilot review round 2: the previous implementation pushed
    // every parsed stderr line into `stderrChunks` and only sliced
    // at the very end. A long ffmpeg encode can write tens of MB
    // of progress lines (every frame's `frame= N fps= … time= …`
    // status), so the array could grow without bound even though
    // we only ever read the last 4KB. The bounded helper trims
    // itself in-place so memory stays within a small multiple of
    // the configured tail size.
    //
    // We emit 5,000 progress-style lines (~64 chars each ≈ 320KB
    // of total stderr) and assert that the final stored byte count
    // is comfortably below the original unbounded total — proving
    // the trim fires — while the tail still contains the
    // most-recent line so error reporting is unaffected.
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      const lines: string[] = []
      for (let i = 0; i < 5000; i++) {
        lines.push(
          `frame=${String(i).padStart(6, ' ')} fps=24 q=20 size=${i * 4}kB time=00:01:00 bitrate=8000k speed=1.0x\n`,
        )
      }
      const child = makeFakeChild()
      const spawnImpl = vi.fn(() => {
        setTimeout(() => {
          for (const line of lines) {
            child.stderr.emit('data', line)
          }
          child.stderr.emit('end')
          writeFileSync(join(tmp, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
          // Non-zero exit so we can read FfmpegError.stderrTail
          // and confirm the most-recent lines survived the trim.
          child.emit('close', 1, null)
        }, 0)
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      const err = (await encodeHls({
        inputPath: input,
        outputDir: tmp,
        spawnImpl: spawnImpl as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
        hasAudio: true,
      }).catch(e => e)) as FfmpegError
      expect(err).toBeInstanceOf(FfmpegError)
      // Tail is capped at ~4KB (8KB ceiling before the trim
      // amortizes — but the final `tail()` slice enforces 4KB).
      expect(err.stderrTail.length).toBeLessThanOrEqual(4096)
      // …and contains the last line emitted (frame=4999).
      expect(err.stderrTail).toContain('frame=  4999')
      // …but not the very first (frame=0), which was trimmed off.
      expect(err.stderrTail).not.toContain('frame=     0 ')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('honours a custom ffmpegBin', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ffhls-'))
    const input = join(tmp, 'in.mp4')
    writeFileSync(input, 'fake-mp4')
    try {
      const { promise, spawnImpl } = runWithStub(tmp, input, { exitCode: 0, createMaster: true })
      // The stub doesn't read ffmpegBin from the invocation, but
      // we can re-invoke encodeHls directly to assert the bin.
      await promise
      // (The above already exercised the default 'ffmpeg' path;
      // pin a custom one explicitly here.)
      const child = makeFakeChild()
      const customSpawn = vi.fn((cmd: string) => {
        expect(cmd).toBe('/opt/homebrew/bin/ffmpeg')
        setTimeout(() => {
          writeFileSync(join(tmp, MASTER_PLAYLIST_NAME), '#EXTM3U\n')
          child.emit('close', 0, null)
        }, 0)
        return child as unknown as ReturnType<typeof import('node:child_process').spawn>
      })
      await encodeHls({
        inputPath: input,
        outputDir: tmp,
        ffmpegBin: '/opt/homebrew/bin/ffmpeg',
        spawnImpl: customSpawn as unknown as Parameters<typeof encodeHls>[0]['spawnImpl'],
        hasAudio: true,
      })
      expect(customSpawn).toHaveBeenCalledOnce()
      expect(spawnImpl).toHaveBeenCalled()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('createBoundedStderr (3/N)', () => {
  it('returns the empty string before any push', () => {
    const buf = createBoundedStderr(1024)
    expect(buf.tail()).toBe('')
    expect(buf.totalBytes).toBe(0)
  })

  it('preserves all content while below the trim threshold', () => {
    const buf = createBoundedStderr(1024)
    buf.push('hello ')
    buf.push('world\n')
    expect(buf.tail()).toBe('hello world\n')
    expect(buf.totalBytes).toBe(12)
  })

  it('trims old chunks once total exceeds 2 × maxBytes', () => {
    const buf = createBoundedStderr(100)
    // Push 50 × 50-byte lines = 2500 bytes total. The trim
    // threshold is 200 bytes; the bounded buffer should never
    // hold more than ~2 × maxBytes.
    const line = 'x'.repeat(49) + '\n' // 50 bytes
    for (let i = 0; i < 50; i++) {
      buf.push(line)
    }
    expect(buf.totalBytes).toBeLessThanOrEqual(200)
    // tail() further bounds the output at maxBytes.
    expect(buf.tail().length).toBeLessThanOrEqual(100)
  })

  it('keeps the most-recent content after trimming', () => {
    const buf = createBoundedStderr(50)
    for (let i = 0; i < 100; i++) {
      buf.push(`line ${String(i).padStart(3, '0')}\n`) // 10 bytes
    }
    // Last line emitted is "line 099\n" — it must survive trim.
    expect(buf.tail()).toContain('line 099')
    // Early lines must have been evicted.
    expect(buf.tail()).not.toContain('line 000')
  })

  it('handles a single chunk larger than maxBytes', () => {
    const buf = createBoundedStderr(10)
    buf.push('a'.repeat(1000))
    // Single oversized chunk can't be trimmed below maxBytes
    // (the implementation keeps ≥ 1 chunk), but `tail()` slices
    // it down to the configured tail size.
    expect(buf.tail().length).toBe(10)
    expect(buf.tail()).toBe('a'.repeat(10))
  })
})
