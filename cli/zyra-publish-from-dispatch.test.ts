// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveColorScalePath,
  deriveFrameParams,
  expectedOutputKind,
  findFramesMeta,
  materializeInlinePalettes,
  parseArgs,
  readColorScaleFields,
  readPaddedFrameNames,
} from './zyra-publish-from-dispatch'

const ULID = '01HX0000000000000000000000'

describe('parseArgs', () => {

  it('defaults report-failure to failed and honors --status=canceled', () => {
    // A cancelled or timed-out GHA job must post `canceled`, not
    // `failed`, so the run row still reaches a terminal state and the
    // workflow is not wedged by the active-run guard.
    const base = [`--phase=report-failure`, `--workflow-id=${ULID}`, `--run-id=${ULID}`]
    expect(parseArgs(base)).toMatchObject({ terminalStatus: 'failed' })
    expect(parseArgs([...base, '--status=canceled'])).toMatchObject({ terminalStatus: 'canceled' })
    expect(parseArgs([...base, '--status=nonsense'])).toMatchObject({ terminalStatus: 'failed' })
  })

  it('defaults the summary to match the status it is stored against', () => {
    // The workflow always passes --error-summary, so this is the
    // hand-run path — but a row reading `canceled` with "Workflow run
    // failed" contradicts itself wherever it surfaces.
    const base = [`--phase=report-failure`, `--workflow-id=${ULID}`, `--run-id=${ULID}`]
    expect(parseArgs(base)).toMatchObject({
      errorSummary: expect.stringContaining('failed'),
    })
    expect(parseArgs([...base, '--status=canceled'])).toMatchObject({
      errorSummary: expect.stringContaining('cancelled'),
    })
    expect(parseArgs([...base, '--status=canceled'])).toMatchObject({
      errorSummary: expect.not.stringContaining('failed'),
    })
    // An explicit summary still wins over both defaults.
    expect(
      parseArgs([...base, '--status=canceled', '--error-summary=out of disk']),
    ).toMatchObject({ errorSummary: 'out of disk' })
  })
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

  it('accepts the acquire-softpass phase with a default staleness threshold', () => {
    expect(
      parseArgs([
        `--phase=acquire-softpass`,
        `--workflow-id=${ULID}`,
        `--run-id=${ULID}`,
        `--zyra-log=_work/zyra-run.log`,
      ]),
    ).toMatchObject({ phase: 'acquire-softpass', zyraLog: '_work/zyra-run.log', staleAfterSeconds: 172_800 })
  })

  it('bounds --stale-after-seconds', () => {
    expect(
      parseArgs([`--phase=acquire-softpass`, `--workflow-id=${ULID}`, `--run-id=${ULID}`, `--stale-after-seconds=99999999`]),
    ).toHaveProperty('error')
    expect(
      parseArgs([`--phase=acquire-softpass`, `--workflow-id=${ULID}`, `--run-id=${ULID}`, `--stale-after-seconds=3600`]),
    ).toMatchObject({ staleAfterSeconds: 3600 })
  })
})

describe('expectedOutputKind', () => {
  it('detects a video pipeline by its WORKFLOW_OUTPUT_PATH arg', () => {
    const video = JSON.stringify({
      stages: [
        {
          stage: 'visualize',
          command: 'compose-video',
          args: { frames: '/work/images/frames', output: '/work/output/dataset.mp4' },
        },
      ],
    })
    expect(expectedOutputKind(video)).toBe('video')
  })

  it('treats a frames-output pipeline (no MP4 path) as frames', () => {
    const frames = JSON.stringify({
      stages: [
        {
          stage: 'process',
          command: 'scan-frames',
          args: { 'frames-dir': '/work/images/frames', output: '/work/frames-meta.json' },
        },
      ],
    })
    expect(expectedOutputKind(frames)).toBe('frames')
  })

  it('falls back to frames on unparseable pipeline JSON', () => {
    expect(expectedOutputKind('not json')).toBe('frames')
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

describe('deriveFrameParams', () => {
  /** A pipeline that regenerates every frame from source URLs — no
   *  acquire stage, so nothing incremental to cache. */
  const fromScratch = JSON.stringify({
    stages: [
      {
        stage: 'visualize',
        command: 'heatmap',
        args: { 'output-dir': '/work/images/frames', basemap: 'fv3-chem-basemap.jpg' },
      },
      {
        stage: 'process',
        command: 'scan-frames',
        args: { 'frames-dir': '/work/images/frames', 'period-seconds': 10800 },
      },
      {
        stage: 'visualize',
        command: 'compose-video',
        args: { frames: '/work/images/frames', glob: '*.png' },
      },
    ],
  })

  it('opts a pipeline into the cache only via `acquire --sync-dir`', () => {
    // Regression: cacheDir used to default to <workdir>/images/frames,
    // which restored another era's frames into a from-scratch
    // pipeline's output dir. compose-video globs *.png, so those
    // leftovers ended up in the published video.
    expect(deriveFrameParams(fromScratch, '/tmp/zw').cacheDir).toBeNull()
  })

  it('still resolves a frames dir to publish from without a sync-dir', () => {
    // framesDir is a different question from cacheDir: the
    // image-sequence publish path reads the frames the run produced,
    // and the runner's convention is where they land. Gating the
    // cache must not take that path's directory away.
    expect(deriveFrameParams(fromScratch, '/tmp/zw').framesDir).toBe(
      join('/tmp/zw', 'images', 'frames'),
    )
  })

  it('maps the sync-dir to its host path when the pipeline has one', () => {
    const cached = JSON.stringify({
      stages: [
        {
          stage: 'acquire',
          args: { 'sync-dir': '/work/images/frames', 'since-period': 'PT6H' },
        },
        {
          stage: 'process',
          command: 'scan-frames',
          args: { 'frames-dir': '/work/images/frames', 'period-seconds': 3600 },
        },
      ],
    })
    expect(deriveFrameParams(cached, '/tmp/zw')).toMatchObject({
      framesDir: join('/tmp/zw', 'images', 'frames'),
      cacheDir: join('/tmp/zw', 'images', 'frames'),
      // 6 h at an hourly cadence, inclusive of both endpoints.
      keepFrames: 7,
    })
  })

  it('does not opt in on a sync-dir outside the mounted workdir', () => {
    // The runner can only see paths under /work; a sync-dir elsewhere
    // is not a directory we could restore into.
    const elsewhere = JSON.stringify({
      stages: [{ stage: 'acquire', args: { 'sync-dir': '/scratch/frames' } }],
    })
    expect(deriveFrameParams(elsewhere, '/tmp/zw').cacheDir).toBeNull()
  })

  it('does not opt in on an unparseable pipeline', () => {
    expect(deriveFrameParams('not json', '/tmp/zw').cacheDir).toBeNull()
  })
})

describe('deriveColorScalePath', () => {
  const pipeline = (heatmapArgs: Record<string, unknown>): string =>
    JSON.stringify({
      stages: [
        { stage: 'acquire', command: 'http', args: { url: 'https://example.org/x.grib2' } },
        { stage: 'visualize', command: 'heatmap', args: heatmapArgs },
      ],
    })

  it('returns the sidecar path when the pipeline opts in', () => {
    const json = pipeline({
      'data-encoded': true,
      'color-scale-file': '/work/scale.json',
      vmin: 0,
      vmax: 50,
    })
    expect(deriveColorScalePath(json, '/tmp/zw')).toBe('/tmp/zw/scale.json')
  })

  it.each([[true], ['true'], ['']])('treats %j as the flag being present', flag => {
    // Flag-style args survive round-trips as a boolean or as an empty
    // string depending on how the pipeline was authored.
    const json = pipeline({ 'data-encoded': flag, 'color-scale-file': '/work/s.json' })
    expect(deriveColorScalePath(json, '/tmp/zw')).not.toBeNull()
  })

  // The backwards-compatibility guarantee at the publish boundary:
  // every pipeline published so far omits both args and must stay a
  // picture.
  it('returns null for an ordinary colourised pipeline', () => {
    expect(deriveColorScalePath(pipeline({ basemap: 'fv3-chem-basemap.jpg' }), '/tmp/zw')).toBeNull()
  })

  it('returns null when the flag is set without a sidecar', () => {
    // Half-configured would publish frames whose luma is a measurement
    // with nothing saying what it measures — raw grayscale on the
    // globe. Better to publish it as the picture it will look like.
    expect(deriveColorScalePath(pipeline({ 'data-encoded': true }), '/tmp/zw')).toBeNull()
  })

  // zyra's pipeline_runner builds the flag with
  // `"--" + k.replace("_", "-")`, so both spellings are legitimate in a
  // stored pipeline and nothing normalises the JSON on the way in. The
  // published RRFS workflow is snake_case throughout — cmap_file,
  // period_seconds, output_names — so a kebab-only scraper misses a
  // real, in-production pipeline and publishes a picture with no
  // warning, because the warning only fires once the flag is seen.
  it('reads the snake_case spelling the real workflows are written in', () => {
    const json = JSON.stringify({
      stages: [
        {
          stage: 'visualize',
          command: 'heatmap',
          args: {
            data_encoded: true,
            color_scale_file: '/work/color-scale.json',
            cmap_file: 'https://example.test/smoke.json',
            vmin: 0,
            vmax: 0.0005,
          },
        },
      ],
    })
    expect(deriveColorScalePath(json, '/tmp/zw')).toBe('/tmp/zw/color-scale.json')
  })

  it('still warns on snake_case data_encoded with no sidecar', () => {
    const json = JSON.stringify({
      stages: [{ stage: 'visualize', command: 'heatmap', args: { data_encoded: true } }],
    })
    // Recognised, so it can warn — the kebab-only version returned null
    // silently, which reads identically to "not a data-encoded pipeline".
    expect(deriveColorScalePath(json, '/tmp/zw')).toBeNull()
  })

  it('prefers the kebab spelling when a pipeline somehow carries both', () => {
    const json = JSON.stringify({
      stages: [
        {
          stage: 'visualize',
          command: 'heatmap',
          args: {
            'data-encoded': true,
            'color-scale-file': '/work/kebab.json',
            color_scale_file: '/work/snake.json',
          },
        },
      ],
    })
    expect(deriveColorScalePath(json, '/tmp/zw')).toBe('/tmp/zw/kebab.json')
  })

  it('ignores the args on a non-heatmap stage', () => {
    const json = JSON.stringify({
      stages: [
        { stage: 'visualize', command: 'contour', args: { 'data-encoded': true, 'color-scale-file': '/work/s.json' } },
      ],
    })
    expect(deriveColorScalePath(json, '/tmp/zw')).toBeNull()
  })

  it('survives an unparseable pipeline', () => {
    expect(deriveColorScalePath('not json', '/tmp/zw')).toBeNull()
  })
})

describe('readColorScaleFields', () => {
  const VALID = JSON.stringify({
    stops: [
      { t: 0, rgba: [0, 0, 0, 0] },
      { t: 1, rgba: [255, 0, 0, 255] },
    ],
    vmin: 0,
    vmax: 50,
    units: 'mg m-2',
  })

  async function withSidecar(body: string): Promise<Record<string, string>> {
    const dir = await mkdtemp(join(tmpdir(), 'tv-scale-'))
    const path = join(dir, 'scale.json')
    await writeFile(path, body, 'utf-8')
    return readColorScaleFields(path)
  }

  it('returns the row fields for a valid sidecar', async () => {
    const fields = await withSidecar(VALID)
    expect(fields.render_encoding).toBe('data-luma')
    expect(JSON.parse(fields.color_scale)).toMatchObject({ vmin: 0, vmax: 50, units: 'mg m-2' })
  })

  it('returns nothing when there is no sidecar to read', async () => {
    expect(await readColorScaleFields(null)).toEqual({})
    expect(await readColorScaleFields('/nonexistent/scale.json')).toEqual({})
  })

  it.each([
    ['unparseable JSON', '{nope'],
    ['a single stop', JSON.stringify({ stops: [{ t: 0, rgba: [0, 0, 0, 0] }], vmin: 0, vmax: 1 })],
    ['a zero-width range', JSON.stringify({ stops: [{ t: 0, rgba: [0, 0, 0, 0] }, { t: 1, rgba: [1, 1, 1, 1] }], vmin: 7, vmax: 7 })],
  ])('publishes as a picture rather than failing the run on %s', async (_label, body) => {
    // A bad palette must not sink a run that produced good frames.
    expect(await withSidecar(body)).toEqual({})
  })

  it('rejects a sidecar past the column cap', async () => {
    const huge = JSON.stringify({
      stops: [
        { t: 0, rgba: [0, 0, 0, 0] },
        { t: 1, rgba: [255, 255, 255, 255] },
      ],
      vmin: 0,
      vmax: 1,
      units: 'x'.repeat(20_000),
    })
    expect(await withSidecar(huge)).toEqual({})
  })
})

describe('materializeInlinePalettes', () => {
  const heatmap = (args: Record<string, unknown>) =>
    JSON.stringify({
      stages: [
        { stage: 'process', command: 'convert-format', args: { format: 'geotiff' } },
        { stage: 'visualize', command: 'heatmap', args },
        { stage: 'visualize', command: 'compose-video', args: { output: '/work/output/dataset.mp4' } },
      ],
    })

  it('writes cmap_inline to /work/cmap-<i>.json and repoints cmap_file', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pal-'))
    const palette = '{"type":"continuous","base":"Oranges","transparent_range":12}'
    const out = await materializeInlinePalettes(
      heatmap({ data_encoded: true, cmap_inline: palette, vmax: 0.0003 }),
      workdir,
    )
    const stage = JSON.parse(out).stages[1].args
    // cmap_file now points at the container path; cmap_inline is gone.
    expect(stage.cmap_file).toBe('/work/cmap-1.json')
    expect(stage.cmap_inline).toBeUndefined()
    // the bytes on disk are the palette verbatim.
    expect(await readFile(join(workdir, 'cmap-1.json'), 'utf8')).toBe(palette)
  })

  it('accepts the kebab spelling (cmap-inline)', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pal-'))
    const out = await materializeInlinePalettes(
      heatmap({ 'cmap-inline': '{"type":"continuous","base":"YlOrBr"}' }),
      workdir,
    )
    const stage = JSON.parse(out).stages[1].args
    expect(stage.cmap_file).toBe('/work/cmap-1.json')
    expect(stage['cmap-inline']).toBeUndefined()
  })

  it('throws on a cmap_inline that is not valid JSON — before any container run', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pal-'))
    await expect(
      materializeInlinePalettes(heatmap({ cmap_inline: '{not json' }), workdir),
    ).rejects.toThrow(/cmap_inline is not valid JSON/)
  })

  it('refuses cmap_inline on a non-heatmap stage', async () => {
    // Rewriting it into cmap_file on, say, compose-video would hand zyra an
    // arg that command does not accept ("unrecognized arguments"), pointing
    // the author at the wrong stage. Silently skipping is worse: the heatmap
    // would render grayscale with no hint why.
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pal-'))
    const pipeline = JSON.stringify({
      stages: [
        {
          stage: 'visualize',
          command: 'compose-video',
          args: { output: '/work/output/dataset.mp4', cmap_inline: '{"type":"continuous"}' },
        },
      ],
    })
    await expect(materializeInlinePalettes(pipeline, workdir)).rejects.toThrow(
      /only supported on a "heatmap" stage.*compose-video/s,
    )
  })

  it('leaves a pipeline without cmap_inline untouched', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'zyra-pal-'))
    const input = heatmap({ data_encoded: true, cmap_file: 'https://host/p.json' })
    const out = await materializeInlinePalettes(input, workdir)
    expect(JSON.parse(out)).toEqual(JSON.parse(input))
  })
})
