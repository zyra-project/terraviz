// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Pure helpers for the Phase 3e dataset-overlay rendering path.
 *
 * Both functions are tiny and stateless, but consolidating them
 * here lets `datasetLoader` and `mapRenderer` agree on the same
 * SOS-convention "is this Earth?" check and the same
 * `Dataset → DatasetOverlayOptions` projection without either
 * file having to import the other. The unit tests in
 * `datasetOverlayOptions.test.ts` pin the semantics — covering
 * the case-insensitive Earth alias, the SOS `celestialBody: ""`
 * implicit-Earth convention, and the "all fields default ⇒
 * undefined" fast path that lets legacy datasets short-circuit
 * the renderer's option-aware code.
 */

import type { Dataset, DatasetOverlayOptions } from '../types'
import { RENDER_ENCODING_DATA_LUMA } from '../types/color-scale'
import type { DisplayColorScale } from '../types/unit-scale'

/**
 * Is a `celestialBody` string the SOS convention for "Earth"?
 *
 *   null / undefined         → true (catalog row carries no body;
 *                                    implicit Earth)
 *   ""                       → true (SOS snapshot quirk: some rows
 *                                    ship explicit empty string)
 *   "Earth" / "EARTH" / etc. → true (case-insensitive, trimmed)
 *   anything else            → false (Mars / Moon / Sun / aurora /
 *                                     Trappist-1d / …)
 *
 * "aurora" is observed *from* Earth but the SOS importer persists
 * the string verbatim. The renderer trusts the catalog row — if
 * the import is wrong the operator fixes it on the publisher side
 * rather than the renderer second-guessing.
 */
export function isEarthBody(name: string | null | undefined): boolean {
  if (name == null) return true
  const normalized = name.trim().toLowerCase()
  return normalized === '' || normalized === 'earth'
}

/**
 * Build the per-dataset `DatasetOverlayOptions` bundle from a
 * loaded `Dataset`. Returns `undefined` when every relevant 3d
 * field is at its default — the renderer's option-aware code
 * path is only entered for datasets that actually carry hints,
 * which keeps the common (Earth, global, prime-meridian, no-flip)
 * case on the pre-3e fast path through the dataset-overlay
 * shader.
 *
 * `celestialBody: ""` from the catalog wire collapses to "Earth"
 * by `isEarthBody`, so on its own it does NOT force a bundle —
 * the fast-path `undefined` is returned. If another field
 * (bbox / lonOrigin / flip / non-Earth body) triggers bundle
 * emission, `celestialBody` is propagated verbatim regardless
 * of value so the renderer sees what the catalog actually
 * said.
 *
 * `colorScale` joins the same bundle. It is the single field that
 * carries data-encoded mode to all four render surfaces, and it is
 * only ever set alongside `renderEncoding: 'data-luma'` — a dataset
 * without that pairing is a picture and takes exactly the path it
 * takes today, which is the backwards-compatibility guarantee.
 */
export function overlayOptionsFromDataset(
  dataset: Dataset,
): DatasetOverlayOptions | undefined {
  const hasBbox = Boolean(dataset.boundingBox)
  const hasLonOrigin =
    typeof dataset.lonOrigin === 'number' && Number.isFinite(dataset.lonOrigin)
  const hasFlip = dataset.isFlippedInY === true
  const hasNonEarthBody = !isEarthBody(dataset.celestialBody)
  const colorScale = dataEncodedScale(dataset)
  if (!hasBbox && !hasLonOrigin && !hasFlip && !hasNonEarthBody && !colorScale) {
    return undefined
  }
  return {
    boundingBox: dataset.boundingBox,
    lonOrigin: dataset.lonOrigin,
    isFlippedInY: dataset.isFlippedInY,
    celestialBody: dataset.celestialBody,
    colorScale,
    // Identity travels with the geometry and the scale, so whatever
    // ends up holding these options can say which dataset they
    // describe without consulting app state.
    datasetId: dataset.id,
    datasetTitle: dataset.title,
  }
}

/** The palette, but only for a dataset that actually declares itself
 *  data-encoded. A `colorScale` without `renderEncoding` is inert by
 *  contract, so it must not reach a shader. */
function dataEncodedScale(dataset: Dataset): DisplayColorScale | undefined {
  if (dataset.renderEncoding !== RENDER_ENCODING_DATA_LUMA) return undefined
  return dataset.colorScale
}
