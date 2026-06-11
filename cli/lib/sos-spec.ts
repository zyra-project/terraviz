/**
 * SOS-spec preflight for runner-produced MP4s — graduated from the
 * Z0 spike into shared form for the Phase Z1 runner
 * (`docs/ZYRA_INTEGRATION_PLAN.md` §Runner, the Verify-stage
 * stand-in).
 *
 * Hard failures (don't upload): no video stream, non-positive
 * duration. Soft warnings (the transcode ladder normalises these,
 * and regional/non-global datasets are legitimately non-2:1):
 * non-2:1 aspect, sub-4K resolution, off-spec fps, non-h264 codec.
 */

import { spawn } from 'node:child_process'

/** The catalog-wide spherical-video invariants the preflight
 *  asserts. Width/height are the 4K ladder's top rung (what
 *  `encodeHls` emits); fps is the tour engine's `frameRate`
 *  assumption. */
export const SOS_SPEC = {
  width: 4096,
  height: 2048,
  fps: 30,
  codec: 'h264',
  /** 2:1 equirectangular, with a 1% tolerance for odd encoder
   *  roundings. Deviation is a WARNING, not a failure: global
   *  (sphere) datasets should be 2:1, but other nodes in the
   *  network carry regional content with arbitrary aspect ratios.
   *  A per-workflow projection hint could restore strictness for
   *  declared-global pipelines later. */
  aspectTolerance: 0.01,
} as const

/** The subset of `ffprobe -print_format json` the assertion reads. */
export interface ProbeResult {
  streams?: Array<{
    codec_type?: string
    codec_name?: string
    width?: number
    height?: number
    r_frame_rate?: string
  }>
  format?: { duration?: string }
}

export interface SpecReport {
  /** Hard violations — do not upload. */
  failures: string[]
  /** Soft deviations — reported, not blocking. */
  warnings: string[]
  /** Human-readable probe summary for run reports. */
  summary: string
}

/** Parse ffprobe's fractional rate strings ("30/1", "30000/1001"). */
export function parseFrameRate(raw: string | undefined): number | null {
  if (!raw) return null
  const match = /^(\d+)\/(\d+)$/.exec(raw)
  if (!match) {
    const plain = Number(raw)
    return Number.isFinite(plain) && plain > 0 ? plain : null
  }
  const num = Number(match[1])
  const den = Number(match[2])
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null
  return num / den
}

export function assessSosSpec(probe: ProbeResult): SpecReport {
  const failures: string[] = []
  const warnings: string[] = []

  const video = probe.streams?.find(s => s.codec_type === 'video')
  if (!video) {
    return {
      failures: ['no video stream found'],
      warnings,
      summary: 'no video stream',
    }
  }

  const width = video.width ?? 0
  const height = video.height ?? 0
  const fps = parseFrameRate(video.r_frame_rate)
  const codec = video.codec_name ?? 'unknown'
  const duration = Number(probe.format?.duration ?? '0')

  if (width <= 0 || height <= 0) {
    failures.push(`unreadable dimensions (${width}x${height})`)
  } else {
    const aspect = width / height
    if (Math.abs(aspect - 2) > 2 * SOS_SPEC.aspectTolerance) {
      warnings.push(
        `aspect ratio ${aspect.toFixed(3)} is not 2:1 equirectangular (${width}x${height}) — expected for regional datasets; global sphere content should be 2:1`,
      )
    }
    if (width !== SOS_SPEC.width || height !== SOS_SPEC.height) {
      warnings.push(
        `resolution ${width}x${height} differs from the ${SOS_SPEC.width}x${SOS_SPEC.height} ladder top — the transcode upscales/downscales, check source quality`,
      )
    }
  }

  if (!(duration > 0)) {
    failures.push(`duration ${probe.format?.duration ?? '(missing)'} is not positive`)
  }

  if (fps === null) {
    warnings.push('frame rate unreadable from ffprobe output')
  } else if (Math.abs(fps - SOS_SPEC.fps) > 0.01) {
    warnings.push(
      `frame rate ${fps.toFixed(3)} ≠ ${SOS_SPEC.fps} fps — the transcode forces -r ${SOS_SPEC.fps}, playback speed will differ from the source cadence`,
    )
  }

  if (codec !== SOS_SPEC.codec) {
    warnings.push(`codec ${codec} ≠ ${SOS_SPEC.codec} (fine as transcode input)`)
  }

  const summary = `${width}x${height} ${codec} ${fps === null ? '?' : fps.toFixed(2)}fps ${duration.toFixed(1)}s`
  return { failures, warnings, summary }
}

/** Run ffprobe and parse its JSON output. */
export function runFfprobe(bin: string, videoPath: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', videoPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${err.slice(0, 300)}`))
        return
      }
      try {
        resolve(JSON.parse(out) as ProbeResult)
      } catch (e) {
        reject(new Error(`ffprobe output is not JSON: ${e instanceof Error ? e.message : e}`))
      }
    })
  })
}
