// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Gesture tests for the browse panel's touch drag-scroll. These run
 * the real `createVrInteraction` against the real `createVrBrowse`,
 * with stub controllers aimed at points on the panel, so the
 * tap-vs-drag decision is exercised through the same raycasts,
 * UV math and hit-tests the headset uses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import type { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js'
import { createVrInteraction, type VrInteractionContext, type VrInteractionHandle } from './vrInteraction'
import { createVrBrowse, type VrBrowseAction, type VrBrowseHandle } from './vrBrowse'
import type { VrDatasetEntry } from './vrSession'
import type { VrHudHandle } from './vrHud'
import type { VrTourControlsHandle } from './vrTourControls'
import type { VrTourOverlayHandle } from './vrTourOverlay'

/** Panel geometry, mirrored from vrBrowse.ts (0.8 × 0.6 m, 800 × 600 canvas). */
const PANEL_W = 0.8
const PANEL_H = 0.6
const CANVAS_W = 800
const CANVAS_H = 600
/** Panel centre is 1 m straight ahead of the controller, so 1 canvas px ≈ 1 mm. */
const PANEL_DISTANCE = 1
/** Card rows: list starts at canvas y 120, cards are 72 px tall with a 4 px gap. */
const LIST_TOP = 120
const CARD_STRIDE = 76
/** Horizontal middle of a card; the scrollbar strip sits at x ≈ 780–788. */
const CARD_X = 400
const SCROLLBAR_X = 784
const FRAME = 1 / 72

/** Canvas y at the vertical middle of card `i` when the list is not scrolled. */
function cardCenterY(i: number): number {
  return LIST_TOP + i * CARD_STRIDE + 36
}

function datasets(n: number): VrDatasetEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `ds${i}`,
    title: `Dataset ${i}`,
    categories: [],
    thumbnailUrl: null,
  }))
}

/**
 * The shared test-setup canvas stub has no strokeRect / rect / clip,
 * which the browse panel's draw path calls. This one answers every
 * method with a no-op and remembers assigned properties.
 */
function permissive2dContext(): CanvasRenderingContext2D {
  const props: Record<PropertyKey, unknown> = {}
  return new Proxy(props, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'measureText') return () => ({ width: 40 })
      return () => {}
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D
}

class StubControllerModelFactory {
  createControllerModel(): THREE.Object3D {
    return new THREE.Group()
  }
}

interface Harness {
  interaction: VrInteractionHandle
  browse: VrBrowseHandle
  controller: THREE.Group
  actions: VrBrowseAction[]
  /** Point the controller at canvas (x, y), plus an optional upward pitch in degrees. */
  aim(canvasX: number, canvasY: number, pitchDeg?: number): void
  press(): void
  release(): void
  frame(): void
  /** Dataset id of the card under canvas (x, y) at the current scroll, or null. */
  cardAt(canvasX: number, canvasY: number): string | null
}

function createHarness(
  targetRayMode: XRTargetRayMode,
  datasetCount: number,
): Harness {
  const controllers = [new THREE.Group(), new THREE.Group()]
  const renderer = {
    xr: {
      getController: (i: number) => controllers[i],
      getControllerGrip: () => new THREE.Group(),
      getSession: () => null,
    },
  } as unknown as THREE.WebGLRenderer

  const browse = createVrBrowse(THREE)
  browse.mesh.position.set(0, 0, -PANEL_DISTANCE)
  browse.mesh.updateMatrixWorld()
  browse.setDatasets(datasets(datasetCount))
  browse.setVisible(true)

  // Everything else the context needs is out of the ray's way: a
  // tiny HUD far above, no tour surfaces, no globes, no placement.
  const hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.01, 0.01))
  hudMesh.position.set(0, 50, 0)
  hudMesh.updateMatrixWorld()
  const hiddenCaption = new THREE.Mesh()
  hiddenCaption.visible = false
  const actions: VrBrowseAction[] = []
  const ctx: VrInteractionContext = {
    scene: new THREE.Scene(),
    globe: new THREE.Mesh(),
    getAllGlobes: () => [],
    hud: { mesh: hudMesh, captionMesh: hiddenCaption, hitTest: () => null } as unknown as VrHudHandle,
    browse,
    tourControls: { isVisible: () => false, mesh: new THREE.Mesh() } as unknown as VrTourControlsHandle,
    tourOverlay: {
      getInteractiveMeshes: () => [],
      getDraggableMeshes: () => [],
    } as unknown as VrTourOverlayHandle,
    placement: null,
    renderer,
    onHudAction: () => {},
    onBrowseAction: (action) => { actions.push(action) },
    onTourAction: () => {},
    onPlaceButton: () => {},
    onPlaceConfirm: () => {},
    onExit: () => {},
  }
  const interaction = createVrInteraction(
    THREE,
    StubControllerModelFactory as unknown as typeof XRControllerModelFactory,
    ctx,
  )

  const controller = controllers[0]
  controller.dispatchEvent({
    type: 'connected',
    data: { targetRayMode } as XRInputSource,
  } as never)

  const forward = new THREE.Vector3(0, 0, -1)
  const target = new THREE.Vector3()
  const pitch = new THREE.Quaternion()
  const xAxis = new THREE.Vector3(1, 0, 0)

  return {
    interaction,
    browse,
    controller,
    actions,
    aim(canvasX, canvasY, pitchDeg = 0) {
      target.set(
        (canvasX / CANVAS_W) * PANEL_W - PANEL_W / 2,
        PANEL_H / 2 - (canvasY / CANVAS_H) * PANEL_H,
        -PANEL_DISTANCE,
      ).normalize()
      controller.quaternion.setFromUnitVectors(forward, target)
      // World-space pitch: positive tilts the ray up the panel.
      pitch.setFromAxisAngle(xAxis, THREE.MathUtils.degToRad(pitchDeg))
      controller.quaternion.premultiply(pitch)
      controller.updateMatrixWorld()
    },
    press() {
      controller.dispatchEvent({ type: 'selectstart' } as never)
    },
    release() {
      controller.dispatchEvent({ type: 'selectend' } as never)
    },
    frame() {
      interaction.update(FRAME)
    },
    cardAt(canvasX, canvasY) {
      const action = browse.hitTest({ x: canvasX / CANVAS_W, y: 1 - canvasY / CANVAS_H })
      return action?.kind === 'select' ? action.datasetId : null
    },
  }
}

const selected = (h: Harness) =>
  h.actions.filter((a): a is Extract<VrBrowseAction, { kind: 'select' }> => a.kind === 'select')
    .map((a) => a.datasetId)

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => permissive2dContext() as never,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('browse panel — controller input', () => {
  it.each([1, 2])(
    'selects the card when the controller pitch wobbles %s° during the trigger pull',
    (wobbleDeg) => {
      const h = createHarness('tracked-pointer', 40)
      const y = cardCenterY(2)
      h.aim(CARD_X, y)
      h.press()
      h.frame()
      h.aim(CARD_X, y, wobbleDeg)
      h.frame()
      h.frame()
      h.aim(CARD_X, y)
      h.frame()
      h.release()
      expect(selected(h)).toEqual(['ds2'])
    },
  )

  it('does not drag-scroll the list (controllers scroll with the thumbstick)', () => {
    const h = createHarness('tracked-pointer', 40)
    const before = h.cardAt(CARD_X, 300)
    h.aim(CARD_X, cardCenterY(4))
    h.press()
    for (let dy = 20; dy <= 200; dy += 20) {
      h.aim(CARD_X, cardCenterY(4) - dy)
      h.frame()
    }
    h.release()
    expect(h.cardAt(CARD_X, 300)).toBe(before)
  })
})

describe('browse panel — touch input', () => {
  it.each(['screen', 'transient-pointer'] as const)(
    'a slow %s drag past the threshold scrolls and selects nothing',
    (mode) => {
      const h = createHarness(mode, 40)
      const startY = cardCenterY(3)
      h.aim(CARD_X, startY)
      h.press()
      h.frame()
      // 200 px up in 20 px steps. The first step promotes the press
      // (baseline there), the other nine scroll 180 px.
      for (let dy = 20; dy <= 200; dy += 20) {
        h.aim(CARD_X, startY - dy)
        h.frame()
      }
      h.release()
      expect(selected(h)).toEqual([])
      // Content followed the finger up: the card at y=130 is now the
      // one 180 px further down the list.
      expect(h.cardAt(CARD_X, 130)).toBe('ds2')
    },
  )

  it('a movement under the threshold still selects', () => {
    const h = createHarness('screen', 40)
    const y = cardCenterY(3)
    h.aim(CARD_X, y)
    h.press()
    h.frame()
    h.aim(CARD_X, y - 6) // 0.01 UV, half the threshold
    h.frame()
    h.release()
    expect(selected(h)).toEqual(['ds3'])
    expect(h.cardAt(CARD_X, 130)).toBe('ds0')
  })

  it('a quick flick between frames scrolls on release and selects nothing', () => {
    const h = createHarness('screen', 40)
    // Press low on card 3, one frame with no movement, then the
    // finger lifts 50 px higher (still on card 3, ~4× the threshold)
    // before the next frame runs.
    h.aim(CARD_X, 405)
    h.press()
    h.frame()
    h.aim(CARD_X, 355)
    h.release()
    expect(selected(h)).toEqual([])
    // The whole 50 px was applied: canvas y 400 moved from card 3 to card 4.
    expect(h.cardAt(CARD_X, 400)).toBe('ds4')
  })

  it('on a list too short to scroll, a press that moves past the threshold still selects', () => {
    const h = createHarness('screen', 4)
    // Card 1 spans canvas y 196–268; move 25 px within it.
    h.aim(CARD_X, 210)
    h.press()
    h.frame()
    h.aim(CARD_X, 235)
    h.frame()
    h.release()
    expect(selected(h)).toEqual(['ds1'])
  })

  it('a drag on the scrollbar strip does not scroll the content', () => {
    const h = createHarness('screen', 40)
    h.browse.scroll(300)
    const before = h.cardAt(CARD_X, 300)
    h.aim(SCROLLBAR_X, 250)
    h.press()
    h.frame()
    for (let dy = 20; dy <= 200; dy += 20) {
      h.aim(SCROLLBAR_X, 250 + dy)
      h.frame()
    }
    h.release()
    expect(h.cardAt(CARD_X, 300)).toBe(before)
    expect(h.actions).toEqual([])
  })
})
