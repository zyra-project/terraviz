// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Pure projections from the control window's app types into the
 * protocol's mirrored shapes (`docs/MULTI_MONITOR_PLAN.md` §3 "Globe
 * state — what gets mirrored").
 *
 * This is the translation layer `main.ts` would otherwise carry inline.
 * It lives here because the derivations have correctness content worth
 * testing — which URL an output is told to fetch, what an absent
 * overlay bundle becomes — and `main.ts` is four thousand lines with no
 * unit test to put them in.
 *
 * Pure: no DOM, no Tauri, no fetch. Takes plain values rather than a
 * `PanelState`, so a test does not have to build an `HTMLImageElement`
 * or an `HLSService` to exercise the mapping.
 */

import type { Dataset, DatasetOverlayOptions } from '../../types'
import { overlayOptionsFromDataset } from '../datasetOverlayOptions'
import type { MirroredDataset } from './protocol'

/**
 * The overlay bundle to mirror for `dataset`.
 *
 * `overlayOptionsFromDataset` returns `undefined` for the common case —
 * a global, prime-meridian, unflipped Earth picture — because the
 * renderer's option-aware path is an opt-in and the fast path is worth
 * keeping. The wire format has no such fast path: `MirroredDataset
 * .overlay` is required, and the reason it is required is the identity
 * pair. `datasetId` / `datasetTitle` travel with the geometry so a
 * frame can say what it is without asking app state and hoping the two
 * agree, and that argument does not weaken for a dataset whose geometry
 * happens to be the default.
 *
 * So the fallback is the identity-only bundle: every geometric field
 * left `undefined`, which is what the fast path means, plus the two
 * fields that say which dataset this is.
 */
export function overlayForMirror(dataset: Dataset): DatasetOverlayOptions {
  return (
    overlayOptionsFromDataset(dataset) ?? {
      datasetId: dataset.id,
      datasetTitle: dataset.title,
    }
  )
}

/**
 * Build the `MirroredDataset` for a loaded dataset, or `null` when it
 * cannot be mirrored yet.
 *
 * `url` is the URL the **control** window resolved — after offline-cache
 * lookup and variant probing — because the protocol makes that the
 * control window's job and an output never resolves one itself. A null
 * or empty `url` therefore yields `null` rather than a `MirroredDataset`
 * carrying an empty string: an output handed `''` would fetch the
 * output page's own document URL and decode it as a texture, which
 * fails somewhere far away from here. `null` is the value the schema
 * already defines as "nothing loaded", and the idle photoreal Earth is
 * a better wrong answer than a broken one.
 */
export function toMirroredDataset(
  dataset: Dataset,
  kind: 'image' | 'video',
  url: string | null | undefined,
): MirroredDataset | null {
  if (!url) return null
  return {
    id: dataset.id,
    url,
    kind,
    overlay: overlayForMirror(dataset),
  }
}
