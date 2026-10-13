// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The HUD's caption strip against the tour-control strip below it.
 * These run the real `createVrHud`, `createVrTourControls` and
 * `createVrInteraction`, with the panels placed the way `vrSession`
 * places them every frame (globe + offset, turned to face the
 * viewer), so the layout and the tap routing are the headset's.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import type { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js'
import { createVrInteraction, type VrInteractionContext } from './vrInteraction'
import { createVrHud, type VrHudAction, type VrHudHandle, type VrHudState } from './vrHud'
import { createVrTourControls, type VrTourControlsAction, type VrTourControlsHandle } from './vrTourControls'
import { VR_HUD_OFFSET, placeTourControlsUnderHud } from './vrSession'
import type { VrBrowseHandle } from './vrBrowse'
import type { VrTourOverlayHandle } from './vrTourOverlay'

/** Default globe position, mirrored from vrScene.ts. */
const GLOBE = new THREE.Vector3(0, 1.3, -1.5)
/** Eye heights on the local floor: standing, and seated. */
const EYE_HEIGHTS = [1.6, 1.2]
/**
 * Where the strip sat before the caption existed: a world offset from
 * the globe and its own turn toward the viewer — right behind the
 * caption. Kept here to put a button behind it on purpose.
 */
const OFFSET_BEHIND_CAPTION = { x: 0, y: -0.8, z: 0.15 }

/** Middle of each tour button's band, mirrored from vrTourControls.ts. */
const TOUR_BUTTONS: Array<[VrTourControlsAction, number]> = [
  ['tour-prev', 0.09],
  ['tour-play-pause', 0.27],
  ['tour-next', 0.45],
  ['tour-stop', 0.9],
]
const ALL_TOUR_ACTIONS = TOUR_BUTTONS.map(([action]) => action)

const HUD_STATE: VrHudState = {
  datasetTitle: 'Sea Surface Temperature',
  isPlaying: false,
  hasVideo: true,
  isMuted: true,
  panelCount: 1,
  primaryIndex: 0,
  browseOpen: false,
}

/**
 * The shared test-setup canvas stub has no strokeRect, which both
 * panels' draw paths call. This one answers every method with a no-op
 * and remembers assigned properties.
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

/** Corners of a plane mesh in world space. */
function worldCorners(mesh: THREE.Mesh): THREE.Vector3[] {
  const { width, height } = (mesh.geometry as THREE.PlaneGeometry).parameters
  return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) =>
    mesh.localToWorld(new THREE.Vector3((sx * width) / 2, (sy * height) / 2, 0)),
  )
}

interface Harness {
  hud: VrHudHandle
  tour: VrTourControlsHandle
  eye: THREE.Vector3
  hudActions: VrHudAction[]
  tourActions: VrTourControlsAction[]
  showCaption(on: boolean): void
  /** Press and release with the ray through the middle of a tour button. */
  tapTourButton(u: number): void
  /** Height of a world point in the viewer's image, -1 (bottom) to 1 (top). */
  screenY(point: THREE.Vector3): number
}

function createHarness(eyeHeight: number, tourPlacement: 'as-vrSession' | 'behind-caption'): Harness {
  const eye = new THREE.Vector3(0, eyeHeight, 0)
  const billboard = (mesh: THREE.Mesh, offset: { x: number; y: number; z: number }): void => {
    mesh.position.copy(GLOBE).add(new THREE.Vector3(offset.x, offset.y, offset.z))
    mesh.lookAt(eye)
  }

  const hud = createVrHud(THREE)
  billboard(hud.mesh, VR_HUD_OFFSET)
  hud.mesh.updateMatrixWorld(true)
  const tour = createVrTourControls(THREE)
  tour.setState({ active: true, isPlaying: true, step: 1, totalSteps: 5 })
  if (tourPlacement === 'as-vrSession') placeTourControlsUnderHud(tour.mesh, hud.mesh)
  else billboard(tour.mesh, OFFSET_BEHIND_CAPTION)
  tour.mesh.updateMatrixWorld(true)

  const controllers = [new THREE.Group(), new THREE.Group()]
  const renderer = {
    xr: {
      getController: (i: number) => controllers[i],
      getControllerGrip: () => new THREE.Group(),
      getSession: () => null,
    },
  } as unknown as THREE.WebGLRenderer
  const hudActions: VrHudAction[] = []
  const tourActions: VrTourControlsAction[] = []
  const ctx: VrInteractionContext = {
    scene: new THREE.Scene(),
    globe: new THREE.Mesh(),
    getAllGlobes: () => [],
    hud,
    browse: { isVisible: () => false, mesh: new THREE.Mesh() } as unknown as VrBrowseHandle,
    tourControls: tour,
    tourOverlay: {
      getInteractiveMeshes: () => [],
      getDraggableMeshes: () => [],
    } as unknown as VrTourOverlayHandle,
    placement: null,
    renderer,
    onHudAction: (action) => { hudActions.push(action) },
    onBrowseAction: () => {},
    onTourAction: (action) => { tourActions.push(action) },
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
    data: { targetRayMode: 'tracked-pointer' } as XRInputSource,
  } as never)
  controller.position.copy(eye)
  const forward = new THREE.Vector3(0, 0, -1)

  // The viewer, looking at the HUD. Both strips' edges are level, so
  // each projects to a single height in this image.
  const view = new THREE.PerspectiveCamera(90, 1, 0.1, 10)
  view.position.copy(eye)
  view.lookAt(hud.mesh.position)
  view.updateMatrixWorld()

  return {
    hud,
    tour,
    eye,
    hudActions,
    tourActions,
    showCaption(on) {
      hud.setState({
        ...HUD_STATE,
        voice: on ? { phase: 'speaking', caption: 'Over Antarctica.' } : { phase: 'idle', caption: '' },
      })
    },
    tapTourButton(u) {
      const { width } = (tour.mesh.geometry as THREE.PlaneGeometry).parameters
      const target = tour.mesh.localToWorld(new THREE.Vector3((u - 0.5) * width, 0, 0))
      controller.quaternion.setFromUnitVectors(forward, target.sub(eye).normalize())
      controller.updateMatrixWorld()
      controller.dispatchEvent({ type: 'selectstart' } as never)
      interaction.update(1 / 72)
      controller.dispatchEvent({ type: 'selectend' } as never)
    },
    screenY(point) {
      return point.clone().project(view).y
    },
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => permissive2dContext() as never,
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('caption strip and tour controls — where vrSession places them', () => {
  it.each(EYE_HEIGHTS)('the tour strip sits clear below the caption, seen from %s m', (eyeHeight) => {
    const h = createHarness(eyeHeight, 'as-vrSession')
    h.showCaption(true)
    expect(h.hud.captionMesh.visible).toBe(true)
    const captionBottom = Math.min(...worldCorners(h.hud.captionMesh).map(h.screenY))
    const tourTop = Math.max(...worldCorners(h.tour.mesh).map(h.screenY))
    expect(tourTop).toBeLessThan(captionBottom)
  })

  it.each(EYE_HEIGHTS)('every tour button takes its tap while a caption shows, seen from %s m', (eyeHeight) => {
    const h = createHarness(eyeHeight, 'as-vrSession')
    h.showCaption(true)
    for (const [, u] of TOUR_BUTTONS) h.tapTourButton(u)
    expect(h.tourActions).toEqual(ALL_TOUR_ACTIONS)
  })
})

describe('caption strip — a tap on it stops there', () => {
  it.each(EYE_HEIGHTS)('does not press the tour button behind a visible caption, seen from %s m', (eyeHeight) => {
    const h = createHarness(eyeHeight, 'behind-caption')
    h.showCaption(true)
    for (const [, u] of TOUR_BUTTONS) h.tapTourButton(u)
    expect(h.tourActions).toEqual([])
    // Nor is the caption's UV read as a button on the bar.
    expect(h.hudActions).toEqual([])

    // The same rays do reach the buttons once the caption is gone.
    h.showCaption(false)
    expect(h.hud.captionMesh.visible).toBe(false)
    for (const [, u] of TOUR_BUTTONS) h.tapTourButton(u)
    expect(h.tourActions).toEqual(ALL_TOUR_ACTIONS)
  })

  it('lets the tap through while the HUD is hidden with the loading scene', () => {
    const h = createHarness(1.6, 'behind-caption')
    h.showCaption(true)
    h.hud.mesh.visible = false
    for (const [, u] of TOUR_BUTTONS) h.tapTourButton(u)
    expect(h.tourActions).toEqual(ALL_TOUR_ACTIONS)
  })
})
