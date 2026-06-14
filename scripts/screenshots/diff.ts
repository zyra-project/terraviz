/**
 * Visual regression differ (Phase V4).
 *
 * Compares the current report (`report-out/report.json` + PNGs) against
 * a baseline directory of PNGs (the `visual-baseline` artifact from the
 * latest `main` run) and emits, per shot, a pixel diff:
 *
 *   report-out/diff.json         the DiffManifest
 *   report-out/baseline-<file>   the baseline image, copied in for the
 *                                report's triptych
 *   report-out/diff-<file>       the highlighted pixel diff
 *
 * Then it re-renders `index.html` with the baseline / current / diff
 * triptych for changed shots.
 *
 * Non-deterministic regions (globe, MapLibre, graph) are masked at
 * capture time (see `scenes.ts` `masks` + the report capturer), so they
 * are byte-identical between baseline and current and contribute no
 * diff. A missing *baseline image* is a **soft pass** (status `new`): a
 * brand new scene, or the first PR before any `main` baseline exists,
 * must not fail. The diff *result* is advisory — a visual change never
 * fails the build, and the CI step tolerates a non-zero exit. Genuine
 * errors (a missing `--baseline` argument, an unreadable report) still
 * exit non-zero so they surface locally and in the log.
 *
 * Usage:
 *   npm run screenshots:diff -- --baseline <dir>
 *
 * Config (env):
 *   SCREENSHOT_OUT_DIR      default <repo>/report-out (the current run)
 *   VISUAL_DIFF_THRESHOLD   default 0.001 — changed-pixel ratio above
 *                           which a shot is flagged as changed
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import { access, copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

import { REPO_ROOT } from './core/browser'
import { renderReportHtml } from './report/render'
import type {
  DiffComparison,
  DiffManifest,
  DiffStatus,
  ReportManifest,
} from './report/types'

const OUT_DIR = resolve(
  process.env.SCREENSHOT_OUT_DIR ?? resolve(REPO_ROOT, 'report-out'),
)
/**
 * Parse the changed-pixel ratio gate. An unset value defaults; a
 * non-numeric or negative value fails fast rather than silently becoming
 * `NaN` (which would make every shot compare `unchanged`). Exported for
 * tests.
 */
export function parseThreshold(
  raw: string | undefined = process.env.VISUAL_DIFF_THRESHOLD,
): number {
  if (raw === undefined || raw === '') return 0.001
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `VISUAL_DIFF_THRESHOLD must be a finite number ≥ 0, got "${raw}".`,
    )
  }
  return n
}

const THRESHOLD = parseThreshold()
// pixelmatch's per-pixel colour-distance tolerance (0–1); separate from
// our changed-pixel *ratio* gate above.
const PIXEL_THRESHOLD = 0.1

export interface PixelDiffResult {
  status: DiffStatus
  changedPixels: number
  /** changedPixels / totalPixels, 0–1. */
  ratio: number
  /** Highlighted diff PNG; absent when dimensions differ. */
  diff?: Buffer
}

/**
 * Pure pixel comparison of two PNG buffers. Differing dimensions can't
 * be pixel-matched, so they are reported as `size-changed`. Exported for
 * unit testing.
 */
export function diffPngBuffers(
  baseline: Buffer,
  current: Buffer,
  threshold: number = THRESHOLD,
): PixelDiffResult {
  const a = PNG.sync.read(baseline)
  const b = PNG.sync.read(current)
  if (a.width !== b.width || a.height !== b.height) {
    return {
      status: 'size-changed',
      changedPixels: Math.max(a.width * a.height, b.width * b.height),
      ratio: 1,
    }
  }
  const { width, height } = a
  const out = new PNG({ width, height })
  const changedPixels = pixelmatch(a.data, b.data, out.data, width, height, {
    threshold: PIXEL_THRESHOLD,
  })
  const total = width * height
  const ratio = total === 0 ? 0 : changedPixels / total
  const status: DiffStatus = ratio > threshold ? 'changed' : 'unchanged'
  return { status, changedPixels, ratio, diff: PNG.sync.write(out) }
}

function parseBaselineArg(argv: string[]): string | null {
  const i = argv.indexOf('--baseline')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  const eq = argv.find((a) => a.startsWith('--baseline='))
  return eq ? eq.slice('--baseline='.length) : null
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function run(): Promise<void> {
  const baselineDir = parseBaselineArg(process.argv.slice(2))
  if (!baselineDir) {
    // eslint-disable-next-line no-console
    console.error('usage: npm run screenshots:diff -- --baseline <dir>')
    process.exitCode = 1
    return
  }

  const manifest = JSON.parse(
    await readFile(resolve(OUT_DIR, 'report.json'), 'utf-8'),
  ) as ReportManifest

  const comparisons: DiffComparison[] = []
  for (const shot of manifest.shots) {
    const basePath = resolve(baselineDir, shot.file)
    if (!(await fileExists(basePath))) {
      comparisons.push({
        scene: shot.scene,
        viewport: shot.viewport,
        file: shot.file,
        changedPixels: 0,
        ratio: 0,
        status: 'new',
        changed: false,
      })
      continue
    }
    const [baseBuf, curBuf] = await Promise.all([
      readFile(basePath),
      readFile(resolve(OUT_DIR, shot.file)),
    ])
    const res = diffPngBuffers(baseBuf, curBuf, THRESHOLD)
    const changed = res.status === 'changed' || res.status === 'size-changed'

    // Only changed shots get a triptych, so only they need their
    // baseline/diff copied into the report dir — keeps the artifact
    // small as scene count grows.
    let baselineFile: string | undefined
    let diffFile: string | undefined
    if (changed) {
      baselineFile = `baseline-${shot.file}`
      await copyFile(basePath, resolve(OUT_DIR, baselineFile))
      if (res.diff) {
        diffFile = `diff-${shot.file}`
        await writeFile(resolve(OUT_DIR, diffFile), res.diff)
      }
    }

    comparisons.push({
      scene: shot.scene,
      viewport: shot.viewport,
      file: shot.file,
      baselineFile,
      diffFile,
      changedPixels: res.changedPixels,
      ratio: res.ratio,
      status: res.status,
      changed,
    })
  }

  const diffManifest: DiffManifest = {
    generatedAt: new Date().toISOString(),
    baselineDir,
    threshold: THRESHOLD,
    comparisons,
  }
  await writeFile(
    resolve(OUT_DIR, 'diff.json'),
    JSON.stringify(diffManifest, null, 2) + '\n',
  )
  await writeFile(
    resolve(OUT_DIR, 'index.html'),
    renderReportHtml(manifest, { diffs: diffManifest }),
  )

  const changed = comparisons.filter((c) => c.changed).length
  const fresh = comparisons.filter((c) => c.status === 'new').length
  // eslint-disable-next-line no-console
  console.log(
    `Diff vs ${baselineDir}: ${changed} changed, ${fresh} new, ` +
      `${comparisons.length} compared (ratio threshold ${THRESHOLD}).`,
  )
  // Advisory only — a visual change must never fail the build.
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run().catch((err) => {
    if (err instanceof Error) {
      console.error(err.message)
      process.exit(1)
    }
    throw err
  })
}

export { run }
