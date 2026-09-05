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

/**
 * What a panel's `(dataset, mediaDatasetId)` pair says about whether it
 * can be mirrored.
 *
 * - `empty` — nothing loaded; an output should show the idle Earth.
 * - `ready` — the row and the pixels agree, so the frame can be described.
 * - `unsettled` — they disagree. The panel's `dataset` is assigned before
 *   a load is attempted and stays set when one fails, while one is in
 *   flight, and for a `tour/json` row that paints nothing — in each case
 *   the panel still holds the *previous* dataset's pixels. Mirroring
 *   from the row alone would put one dataset's texture under another's
 *   bbox, `lonOrigin`, flip and palette, labelled with the wrong title.
 *
 * Split out of `main.ts` because it is the one piece of that wiring with
 * a wrong answer available, and `main.ts` has no exports to test through.
 */
export type PanelMirrorState = 'empty' | 'ready' | 'unsettled'

export function panelMirrorState(
  datasetId: string | null | undefined,
  mediaDatasetId: string | null,
): PanelMirrorState {
  if (!datasetId) return mediaDatasetId === null ? 'empty' : 'unsettled'
  return mediaDatasetId === datasetId ? 'ready' : 'unsettled'
}
