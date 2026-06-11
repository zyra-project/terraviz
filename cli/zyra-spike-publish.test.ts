import { describe, it, expect } from 'vitest'
import {
  assessSosSpec,
  parseArgs,
  parseFrameRate,
  type ProbeResult,
} from './zyra-spike-publish'

function probe(overrides: {
  width?: number
  height?: number
  fps?: string
  codec?: string
  duration?: string
  noVideo?: boolean
}): ProbeResult {
  if (overrides.noVideo) return { streams: [], format: { duration: '10' } }
  return {
    streams: [
      {
        codec_type: 'video',
        codec_name: overrides.codec ?? 'h264',
        width: overrides.width ?? 4096,
        height: overrides.height ?? 2048,
        r_frame_rate: overrides.fps ?? '30/1',
      },
    ],
    format: { duration: overrides.duration ?? '12.5' },
  }
}

describe('parseFrameRate', () => {
  it('parses fractional rates', () => {
    expect(parseFrameRate('30/1')).toBe(30)
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2)
  })

  it('rejects zero denominators and garbage', () => {
    expect(parseFrameRate('30/0')).toBeNull()
    expect(parseFrameRate('fast')).toBeNull()
    expect(parseFrameRate(undefined)).toBeNull()
  })
})

describe('assessSosSpec', () => {
  it('passes a spec-perfect probe with no warnings', () => {
    const report = assessSosSpec(probe({}))
    expect(report.failures).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it('hard-fails when there is no video stream', () => {
    const report = assessSosSpec(probe({ noVideo: true }))
    expect(report.failures).toHaveLength(1)
  })

  it('warns (not fails) on non-2:1 aspect ratios — regional datasets are legitimate', () => {
    const report = assessSosSpec(probe({ width: 1920, height: 1080 }))
    expect(report.failures).toEqual([])
    expect(report.warnings.some(w => w.includes('2:1'))).toBe(true)
  })

  it('hard-fails non-positive durations', () => {
    const report = assessSosSpec(probe({ duration: '0' }))
    expect(report.failures.some(f => f.includes('duration'))).toBe(true)
  })

  it('warns (not fails) on a 2:1 source below the 4K ladder top', () => {
    const report = assessSosSpec(probe({ width: 2048, height: 1024 }))
    expect(report.failures).toEqual([])
    expect(report.warnings.some(w => w.includes('4096x2048'))).toBe(true)
  })

  it('warns on NTSC-ish frame rates and non-h264 codecs', () => {
    const report = assessSosSpec(probe({ fps: '30000/1001', codec: 'vp9' }))
    expect(report.failures).toEqual([])
    expect(report.warnings.some(w => w.includes('frame rate'))).toBe(true)
    expect(report.warnings.some(w => w.includes('vp9'))).toBe(true)
  })
})

describe('parseArgs', () => {
  it('requires --video', () => {
    expect(parseArgs([])).toHaveProperty('error')
  })

  it('applies defaults', () => {
    const args = parseArgs(['--video=/tmp/out.mp4'])
    expect(args).toMatchObject({
      video: '/tmp/out.mp4',
      datasetId: null,
      publish: false,
      waitSeconds: 900,
      ffprobeBin: 'ffprobe',
    })
  })

  it('rejects malformed dataset ids and wait windows', () => {
    expect(parseArgs(['--video=v.mp4', '--dataset-id=not-a-ulid'])).toHaveProperty('error')
    expect(parseArgs(['--video=v.mp4', '--wait-seconds=-1'])).toHaveProperty('error')
    expect(parseArgs(['--video=v.mp4', '--wait-seconds=999999'])).toHaveProperty('error')
  })

  it('accepts the full flag set', () => {
    const args = parseArgs([
      '--video=v.mp4',
      '--dataset-id=01HX0000000000000000000000',
      '--publish',
      '--wait-seconds=0',
      '--report=/tmp/report.md',
    ])
    expect(args).toMatchObject({
      datasetId: '01HX0000000000000000000000',
      publish: true,
      waitSeconds: 0,
      reportPath: '/tmp/report.md',
    })
  })
})
