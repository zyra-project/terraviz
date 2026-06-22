import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFramesMeta, parseArgs, readPaddedFrameNames } from './zyra-publish-from-dispatch'

const ULID = '01HX0000000000000000000000'

describe('parseArgs', () => {
  it('requires a valid phase and ULID ids', () => {
    expect(parseArgs([])).toHaveProperty('error')
    expect(parseArgs([`--phase=deploy`, `--workflow-id=${ULID}`, `--run-id=${ULID}`])).toHaveProperty('error')
    expect(parseArgs([`--phase=fetch`, `--workflow-id=nope`, `--run-id=${ULID}`])).toHaveProperty('error')
    expect(parseArgs([`--phase=fetch`, `--workflow-id=${ULID}`, `--run-id=${ULID}`])).toMatchObject({
      phase: 'fetch',
      workdir: '_work',
      waitSeconds: 1800,
    })
  })

  it('derives the default video path from the workdir', () => {
    const args = parseArgs([
      `--phase=publish`,
      `--workflow-id=${ULID}`,
      `--run-id=${ULID}`,
      `--workdir=/tmp/zw`,
    ])
    expect(args).toMatchObject({ video: '/tmp/zw/output/dataset.mp4' })
  })

  it('bounds the wait window', () => {
    expect(
      parseArgs([`--phase=publish`, `--workflow-id=${ULID}`, `--run-id=${ULID}`, `--wait-seconds=999999`]),
    ).toHaveProperty('error')
  })

  it('accepts the frame-cache phases', () => {
    for (const phase of ['restore-frames', 'save-frames']) {
      expect(
        parseArgs([`--phase=${phase}`, `--workflow-id=${ULID}`, `--run-id=${ULID}`]),
      ).toMatchObject({ phase, workdir: '_work' })
    }
  })
})

describe('readPaddedFrameNames', () => {
  it('extracts the basenames of pad-missing created_files', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pad-'))
    const reportPath = join(workdir, 'pad-missing-report.json')
    // Shape mirrors a real pad-missing report (absolute paths).
    await writeFile(
      reportPath,
      JSON.stringify({
        status: 'completed',
        fill_mode: 'nearest',
        created_count: 2,
        created_files: [
          '/builds/x/_work/images/clouds/linear_rgb_cyl_20260611_1910.jpg',
          '/builds/x/_work/images/clouds/linear_rgb_cyl_20260611_1920.jpg',
        ],
        dry_run: false,
      }),
    )
    expect(await readPaddedFrameNames(reportPath)).toEqual([
      'linear_rgb_cyl_20260611_1910.jpg',
      'linear_rgb_cyl_20260611_1920.jpg',
    ])
  })

  it('returns [] for a dry run, a missing file, or no created_files', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pad-'))
    expect(await readPaddedFrameNames(join(workdir, 'absent.json'))).toEqual([])

    const dryPath = join(workdir, 'dry.json')
    await writeFile(dryPath, JSON.stringify({ dry_run: true, created_files: ['/x/a.png'] }))
    expect(await readPaddedFrameNames(dryPath)).toEqual([])

    const emptyPath = join(workdir, 'empty.json')
    await writeFile(emptyPath, JSON.stringify({ status: 'completed', missing_count: 0 }))
    expect(await readPaddedFrameNames(emptyPath)).toEqual([])
  })
})

describe('findFramesMeta', () => {
  it('prefers the workdir-root convention, falls back to the zyra-scheduler layout', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-test-'))
    expect(await findFramesMeta(workdir)).toBeNull()

    const nested = join(workdir, 'images', 'drought', 'metadata')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'frames-meta.json'), '{}')
    expect(await findFramesMeta(workdir)).toBe(join(nested, 'frames-meta.json'))

    await writeFile(join(workdir, 'frames-meta.json'), '{}')
    expect(await findFramesMeta(workdir)).toBe(join(workdir, 'frames-meta.json'))
  })
})
