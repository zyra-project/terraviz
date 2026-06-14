/**
 * Shared types for the screenshot capture core.
 *
 * The core (`./browser.ts`, `./signals.ts`, …) is consumer-agnostic:
 * the Weblate capturer (`../capture.ts`), the general visual report
 * (`../report.ts`), the regression differ (`../diff.ts`), and the smoke
 * runner (`../smoke.ts`) all build on it. Types that more than one
 * consumer needs live here so there is a single definition to evolve.
 *
 * See `docs/VISUAL_REPORT_PLAN.md`.
 */

import type { Page } from 'playwright'

/** Pixel viewport dimensions for a capture pass. */
export interface Viewport {
  width: number
  height: number
}

/** A rectangle in viewport (CSS px) coordinates. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The base shape of one captured image in any consumer's manifest.
 *
 * The Weblate capturer specializes this (it adds the rendered i18n
 * `keys` and a `scene | crop` kind); the general report adds the
 * `viewport` it was shot at plus collected problem `signals`. Keeping a
 * shared base means a future shared renderer can treat every manifest
 * entry uniformly.
 */
export interface CapturedShot {
  /** Stable id — also the screenshot filename stem. */
  name: string
  /** Human-readable note for a reviewer. */
  description: string
  /** PNG filename within the output directory. */
  file: string
  /** Content hash — makes re-runs idempotent / diffs cheap. */
  sha256: string
}

/** A scene's setup driver — drives the app to the state to capture. */
export type SceneSetup = (page: Page) => Promise<void>
