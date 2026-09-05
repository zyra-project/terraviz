// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Output window entry point.
 *
 * Deliberately thin — the same shape `orbitMain.ts` has over
 * `orbitCharacter/`, so everything worth testing lives in
 * `outputScene.ts` and can be imported without running a page.
 *
 * No IPC and no dataset yet: this commit gets the bundle building and
 * the page rendering. `datasetMirror` and the manager link arrive with
 * the commits that exercise them.
 */

import './output.css'
import { createOutputScene, shouldRenderFrame, type OutputContentKind } from './outputScene'
import { logger } from '../utils/logger'

async function boot(): Promise<void> {
  const canvas = document.getElementById('output-canvas')
  if (!(canvas instanceof HTMLCanvasElement)) {
    logger.error('[Output] no #output-canvas in the page')
    return
  }

  const scene = await createOutputScene({ canvas })

  const kind: OutputContentKind = 'idle'
  let lastFrame = 0
  // First tick always draws: nothing has been shown yet, and a black
  // canvas is indistinguishable from a failed boot on a projector.
  let dirty = true

  const tick = (now: number): void => {
    // The scene reports its own changes — today, the CDN texture
    // upgrading 2K → 4K → 8K after first paint. Without this the
    // upgrade waits out the 1 Hz static floor and pops on a projector.
    dirty = scene.consumeDirty() || dirty
    if (shouldRenderFrame({ kind, sinceLastFrameMs: now - lastFrame, dirty })) {
      scene.render()
      lastFrame = now
      dirty = false
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

void boot()
