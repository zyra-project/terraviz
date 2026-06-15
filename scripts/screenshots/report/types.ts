/**
 * Manifest types for the general visual report.
 *
 * `report.json` is what the report capturer emits and the renderer (and
 * later the differ) consume. Kept free of any Playwright import so the
 * renderer and its tests stay browser-free.
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { SceneSignals } from '../core/signals'

/** One scene captured at one viewport. */
export interface ReportShot {
  /** Scene id (from `scenes.ts`). */
  scene: string
  /** Scene description (reviewer note). */
  description: string
  /** Viewport label, e.g. `desktop` / `mobile`. */
  viewport: string
  width: number
  height: number
  /** PNG filename within the report output directory. */
  file: string
  sha256: string
  /**
   * Element-crop PNG filename (`<scene>-<viewport>-crop.png`), present
   * only when the scene declares a `crop` selector. A tightly-cropped
   * companion to `file` focused on one component.
   */
  cropFile?: string
  /** Problems observed while the scene was on screen. */
  signals: SceneSignals
}

export interface ReportManifest {
  /** ISO timestamp of the capture run. */
  generatedAt: string
  /** Base URL the run was captured against (local dev or a deploy). */
  baseUrl: string
  /** Viewport labels captured, in pass order. */
  viewports: string[]
  shots: ReportShot[]
}

/** Outcome of comparing one current shot against its baseline. */
export type DiffStatus =
  /** No baseline image existed (new scene / first run) — soft pass. */
  | 'new'
  /** Below the change threshold. */
  | 'unchanged'
  /** Above the change threshold. */
  | 'changed'
  /** Dimensions differ — cannot pixel-diff; always treated as changed. */
  | 'size-changed'

export interface DiffComparison {
  scene: string
  viewport: string
  /** Current shot filename — the join key against `ReportShot.file`. */
  file: string
  /** Baseline image copied into the report dir (`baseline-<file>`). */
  baselineFile?: string
  /** Diff image written into the report dir (`diff-<file>`). */
  diffFile?: string
  changedPixels: number
  /** changedPixels / totalPixels, 0–1. */
  ratio: number
  status: DiffStatus
  /** True for `changed` / `size-changed` (advisory, never gates CI). */
  changed: boolean
}

export interface DiffManifest {
  generatedAt: string
  /** The baseline directory the current run was compared against. */
  baselineDir: string
  /** Per-pixel ratio above which a shot counts as changed. */
  threshold: number
  comparisons: DiffComparison[]
}
