// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Tests for the output scene's pure logic, plus a regression guard on
 * the Vite entry list.
 *
 * The Three.js construction itself needs a GL context and is not
 * covered here; what is covered is the framebuffer sizing, the loop's
 * draw decision, and the build-config trap the plan calls out by name.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  FRAMEBUFFER_WIDTHS,
  resolveFramebufferSize,
  frameIntervalMs,
  shouldRenderFrame,
  VIDEO_FRAME_MS,
  STATIC_FRAME_MS,
} from './outputScene'
import { EQUIRECT_ASPECT } from './equirectRtt'

describe('resolveFramebufferSize', () => {
  it('keeps every rung 2:1', () => {
    // An equirectangular frame that is not 2:1 is not equirectangular,
    // and a sphere fed a 16:9 buffer stretches without erroring.
    for (const w of FRAMEBUFFER_WIDTHS) {
      const size = resolveFramebufferSize(w)
      expect(size.width).toBe(w)
      expect(size.width / size.height).toBe(EQUIRECT_ASPECT)
    }
  })

  it('rounds down to the supported rung, never up', () => {
    // A monitor reporting just under a rung gets the smaller buffer:
    // overshooting spends GPU memory on hardware that already said it
    // is smaller, and memory is the thing the decoder budget rations.
    expect(resolveFramebufferSize(4095).width).toBe(2048)
    expect(resolveFramebufferSize(4096).width).toBe(4096)
    expect(resolveFramebufferSize(9000).width).toBe(8192)
  })

  it('clamps below the lowest rung up to it', () => {
    expect(resolveFramebufferSize(1).width).toBe(1024)
    expect(resolveFramebufferSize(0).width).toBe(1024)
    expect(resolveFramebufferSize(-1).width).toBe(1024)
  })
})

describe('frame pacing', () => {
  it('paces video at 30 fps and everything else at 1 Hz', () => {
    expect(frameIntervalMs('video')).toBe(VIDEO_FRAME_MS)
    expect(frameIntervalMs('image')).toBe(STATIC_FRAME_MS)
    expect(frameIntervalMs('idle')).toBe(STATIC_FRAME_MS)
  })

  it('draws immediately when something changed, whatever the pace', () => {
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 0, dirty: true })).toBe(true)
  })

  it('skips an unchanged static frame inside its interval', () => {
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 500, dirty: false })).toBe(false)
  })

  it('still draws a static frame once its interval elapses', () => {
    // Not an optimisation to remove: a static output that never
    // redraws cannot tell a dropped upload or a lost context from a
    // correct frame, so the read-back layer would have nothing to
    // catch. 1 Hz keeps it observable.
    expect(shouldRenderFrame({ kind: 'image', sinceLastFrameMs: 1000, dirty: false })).toBe(true)
  })

  it('draws video roughly every 33 ms', () => {
    expect(shouldRenderFrame({ kind: 'video', sinceLastFrameMs: 20, dirty: false })).toBe(false)
    expect(shouldRenderFrame({ kind: 'video', sinceLastFrameMs: 34, dirty: false })).toBe(true)
  })
})

describe('vite entry list', () => {
  const config = readFileSync(resolve(__dirname, '../../vite.config.ts'), 'utf8')

  it('still declares every entry, including the ones this commit did not add', () => {
    // §7 of the plan names this exact trap: authoring a fresh
    // `rollupOptions.input` instead of adding to the existing object
    // silently drops the other pages, and the build stays green while
    // /orbit 404s in production.
    for (const entry of ['main:', 'orbit:', 'output:']) {
      expect(config).toContain(entry)
    }
  })

  it('points the output entry at a page under src/, as root: ./src requires', () => {
    expect(config).toContain("'src/output/output.html'")
  })
})

describe('the output page', () => {
  const html = readFileSync(resolve(__dirname, 'output.html'), 'utf8')

  it('is not indexable', () => {
    expect(html).toContain('name="robots" content="noindex"')
  })

  it('requests the manifest with credentials, like the other entries', () => {
    // An Access-protected host serves a login redirect instead of the
    // manifest without this.
    expect(html).toContain('crossorigin="use-credentials"')
  })

  it('loads its entry module relative to itself', () => {
    expect(html).toContain('src="./main.ts"')
  })
})
