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
