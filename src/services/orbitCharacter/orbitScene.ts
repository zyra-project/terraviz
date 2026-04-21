/**
 * Three.js scene + per-frame update for the Orbit character.
 *
 * Owns the scene graph (head group with body + eye rigs, sub-spheres,
 * trails, target marker) and the monolithic `updateCharacter` per-frame
 * update — order matters, earlier computations feed later ones (e.g.
 * pupil visibility depends on current blink amount).
 *
 * Scene graph (matches ORBIT_CHARACTER_DESIGN.md §Implementation sketch):
 *   Scene
 *   ├── Head (Group) — body + eye
 *   │   ├── Body (Icosahedron, iridescent shader)
 *   │   └── EyeGroup
 *   │       ├── EyeDisc (flat disc, lid-coverage shader)
 *   │       ├── PupilGlow (additive)
 *   │       └── Pupil (additive)
 *   ├── SubSphere[0..1]
 *   └── TargetMarker (hidden until Pointing/Presenting)
 */

import * as THREE from 'three'
import {
  createBodyMaterial,
  createEyeFieldMaterial,
  createPupilMaterials,
  createCatchlightMaterial,
  createStarGeometry,
  createSubSphereMaterial,
  createBacklightMaterial,
  createBezelMaterial,
  createLidGeometry,
  createLidMaterial,
  createSocketMaskMaterial,
  type BodyMaterialBundle,
  type EyeFieldMaterialBundle,
  type PupilMaterials,
  type BacklightMaterialBundle,
} from './orbitMaterials'
import { createPhotorealEarth, type PhotorealEarthHandle } from '../photorealEarth'
import { PALETTES, type EyeMode, type PaletteKey, type ScaleKey, type StateKey } from './orbitTypes'
import { STATES, expressionFor } from './orbitStates'
import {
  buildTrails, updateTrails,
  type TrailHandle,
} from './orbitTrails'
import { GESTURES, type GestureKind, type GestureFrame } from './orbitGestures'
import {
  SCALE_PRESETS, CHAT_FEATURE, featureOf, parkingOf, updateFlight,
  type FlightState, type ScalePreset,
} from './orbitFlight'

const BODY_RADIUS = 0.075
const SUB_RADIUS = 0.009
const SUB_ORBIT_RADIUS = 0.11

/**
 * Minimum orbit radius for tight-sub modes (`point` / `trace`).
 * A sub orbiting at a radius smaller than `BODY_RADIUS` passes
 * through the body's interior volume, where the body surface
 * (and the bezel torus sitting just outside it) render in front
 * of the sub — the sub looks "swallowed" by the character at
 * parts of its orbit. Clamping the tight-orbit radius above the
 * body surface + a small margin keeps the sub consistently on
 * the outside of the body, so depth testing renders it correctly
 * over the face when it passes in front of the eyes.
 *
 * The sub's own radius (`SUB_RADIUS = 0.009`) is also accounted
 * for — the sub's silhouette clears the body by a visible margin.
 */
const SUB_TIGHT_ORBIT_RADIUS = BODY_RADIUS + SUB_RADIUS + 0.008  // = 0.092

/**
 * Scale presets were tuned for a moderately wide landscape (≈3:2).
 * Wider viewports get the preset's vertical FOV as-is — extra
 * horizontal margin is fine. Narrower viewports preserve horizontal
 * coverage by scaling vertical FOV up, capped at FOV_MAX_DEGREES to
 * avoid fish-eye distortion on the globe and character body.
 */
const FOV_REFERENCE_ASPECT = 1.5

/**
 * Hard cap on computed vertical FOV. Past ~85° a perspective camera
 * introduces noticeable barrel distortion on foreground spheres. On
 * extreme-portrait viewports at the planetary preset, this cap is
 * tight — Earth can still clip at the margins. A portrait-reflow
 * mode (Orbit stacked above Earth instead of beside it) is the
 * proper fix for that case; tracked as a follow-up.
 */
const FOV_MAX_DEGREES = 85

/**
 * Compute the vertical FOV the camera should use given the current
 * viewport aspect ratio.
 *
 * At `aspect >= FOV_REFERENCE_ASPECT`, return the preset's base
 * vertical FOV unchanged (the preset was tuned for that aspect).
 * At narrower aspects, scale vertical FOV up so the horizontal FOV
 * stays at what the preset produced at the reference aspect — so
 * content that was in-frame on landscape stays in-frame on portrait.
 */
export function computeEffectiveFov(baseVerticalFovDegrees: number, aspect: number): number {
  if (aspect >= FOV_REFERENCE_ASPECT) return baseVerticalFovDegrees
  const baseVFovRad = baseVerticalFovDegrees * Math.PI / 180
  // Horizontal FOV the preset produces at the reference aspect.
  const targetHFovRad = 2 * Math.atan(FOV_REFERENCE_ASPECT * Math.tan(baseVFovRad / 2))
  // Vertical FOV needed to produce that horizontal FOV at current aspect.
  const vFovRad = 2 * Math.atan(Math.tan(targetHFovRad / 2) / aspect)
  return Math.min(vFovRad * 180 / Math.PI, FOV_MAX_DEGREES)
}

/**
 * Two-eye rig geometry — vinyl redesign tuning.
 *
 * Eyes sit **lower and wider** on the sphere's face to trigger the
 * neotenous "cute" proportions that the concept art reads as. Both
 * discs, glows, and pupils are scaled up from the original spectral
 * paired-eye rig. See `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §Face.
 *
 * `EYE_PAIR_JITTER_SCALE` is the ratio of paired-disc radius to the
 * legacy single-disc radius (0.018 / 0.030 = 0.60). Pupil excursion +
 * jitter multiply by this so the pupil stays inside the smaller disc
 * at any gaze angle while the un-scaled state-driven yaw / pitch
 * values keep working unchanged.
 */
const EYE_PAIR_OFFSET_X = 0.028
// Eyes sit very slightly above the face's vertical center. A
// negative Y reads as "drooping" once the lid stack fills in; the
// small positive offset keeps the eyes up-and-alert without drifting
// into a forehead-high arrangement.
const EYE_PAIR_OFFSET_Y = 0.003
const EYE_PAIR_DISC_RADIUS = 0.018

/**
 * Iris + pupil-field sizing — thin teal ring, dominant navy pupil.
 * Ring thickness (iris − pupil-field) works out to ~0.0016 (~15% of
 * iris diameter), matching the reference concept art. Bumping
 * pupilField too close to iris starts to eat the ring; tuned to
 * leave a clean 1.6 mm band.
 */
const EYE_PAIR_IRIS_RADIUS = 0.0112
const EYE_PAIR_IRIS_GLOW_RADIUS = 0.0132
const EYE_PAIR_PUPIL_FIELD_RADIUS = 0.0096
const EYE_PAIR_PUPIL_DOT_RADIUS = 0.0025
const EYE_PAIR_JITTER_SCALE = 0.60

/**
 * Z-depth layering for the recessed socket. The socket disc sits
 * INSIDE the body surface (negative offset from BODY_RADIUS), so the
 * bezel torus — sitting at BODY_RADIUS — frames a real recess rather
 * than stamping a ring onto a flat plane. The iris / pupil / stars /
 * catchlights step progressively back out toward the body surface,
 * stacking correctly in depth without any Z-fight tolerance tricks.
 *
 * Every Z below is relative to head-space; BODY_RADIUS defines the
 * body surface at the eye's center.
 */
const SOCKET_Z_DISC        = BODY_RADIUS - 0.0020   // deepest — socket floor
const SOCKET_Z_IRIS_GLOW   = BODY_RADIUS - 0.0014
const SOCKET_Z_IRIS        = BODY_RADIUS - 0.0010
const SOCKET_Z_PUPIL_FIELD = BODY_RADIUS - 0.0008
const SOCKET_Z_STARS       = BODY_RADIUS - 0.0005
const SOCKET_Z_PUPIL_DOT   = BODY_RADIUS - 0.0004
const SOCKET_Z_CATCHLIGHT  = BODY_RADIUS - 0.0002
const SOCKET_Z_BEZEL       = BODY_RADIUS + 0.0003   // flush, slightly proud

/**
 * Bezel torus — matte charcoal ring framing each socket. The major
 * radius is pushed slightly outside the socket disc so the ring
 * silhouette hugs the outside of the rim; tube radius is thick
 * enough to catch the key light meaningfully without visually
 * overpowering the iris.
 */
const BEZEL_MAJOR_RADIUS = EYE_PAIR_DISC_RADIUS + 0.0010
const BEZEL_TUBE_RADIUS  = 0.0018

/**
 * Eyelid geometry + pivot placement.
 *
 * The lid dome is now **oversized** (`1.20 × DISC_RADIUS`) so that at
 * any closed rotation the dome footprint fully covers the iris
 * width. Overflow beyond the socket rim is clipped by a stencil
 * mask (see `createSocketMaskMaterial` + `createLidMaterial`) — the
 * GPU discards any lid fragment that falls outside the socket
 * silhouette, so a bigger dome gets us full iris coverage when
 * closed without the lid ever "escaping" the bezel.
 *
 * Stencil IDs: left eye = 1, right eye = 2. Per-eye IDs mean the
 * left lid can't bleed through the right socket's mask or vice
 * versa.
 */
const LEFT_EYE_STENCIL_REF = 1
const RIGHT_EYE_STENCIL_REF = 2
const LID_RADIUS = EYE_PAIR_DISC_RADIUS * 1.20        // oversized; stencil clips overflow
const LID_MESH_Y_OFFSET = -LID_RADIUS * 0.35           // dome center near pivot axis
const UPPER_LID_PIVOT_Y = +EYE_PAIR_DISC_RADIUS * 0.55 // inside socket, not at the rim
const LOWER_LID_PIVOT_Y = -EYE_PAIR_DISC_RADIUS * 0.55
const LID_PIVOT_Z = SOCKET_Z_DISC                      // sits in the socket plane
const UPPER_LID_PARKED_ROT = -Math.PI * 0.50           // tucked well back, clipped by stencil
const LOWER_LID_PARKED_ROT = +Math.PI * 0.50
const UPPER_LID_CLOSED_ROT = +Math.PI * 0.40           // covers socket; stencil clips overflow
const LOWER_LID_CLOSED_ROT = -Math.PI * 0.40

/**
 * Catchlight placement within the pupil group. Two per eye — a
 * larger primary highlight in the upper-outer quadrant, a smaller
 * secondary in the lower-outer. Both catchlights are **mirrored
 * per-eye** so they always sit on the OUTER side of each eye
 * (away from the face's vertical center); without the mirror, the
 * two eyes shared the same pupil-local offsets and one eye's
 * primary would land on the inner side, producing a false
 * "nose-bridge" cluster of brights between the eyes.
 *
 * Reference values below are for the RIGHT eye (offsetX > 0, where
 * outer = positive local X). `buildPairedEye` derives a per-eye
 * sign from `offsetX` and flips the X components for the left eye.
 *
 * Catchlights are parented to the gaze-tracking pupil group (with
 * the iris + pupil), so they track the eye's look direction — anime-
 * style rigs handle highlights that way.
 */
const CATCHLIGHT_PRIMARY_OFFSET_X = 0.0028
const CATCHLIGHT_PRIMARY_OFFSET_Y = 0.0030
const CATCHLIGHT_PRIMARY_RADIUS = 0.0025
const CATCHLIGHT_PRIMARY_OPACITY = 0.75
const CATCHLIGHT_PRIMARY_SEGMENTS = 32
const CATCHLIGHT_SECONDARY_OFFSET_X = 0.0024
const CATCHLIGHT_SECONDARY_OFFSET_Y = -0.0020
const CATCHLIGHT_SECONDARY_RADIUS = 0.0012
const CATCHLIGHT_SECONDARY_OPACITY = 0.55
const CATCHLIGHT_SECONDARY_SEGMENTS = 24

/**
 * Number of tiny white five-point stars scattered inside each eye's
 * pupil field. Position is sampled once at build time (stable per
 * lifetime of the rig) so they stay in the same relative spot —
 * otherwise they'd shimmer around and break the "star chart in the
 * eye" read.
 */
const EYE_STARS_PER_EYE = 3
const EYE_STAR_RADIUS = 0.00085

/**
 * Eye shape — slightly taller than wide, matching the reference
 * concept art (eyes read as anime-style vertical ovals, not
 * circles). Applied as a Y-scale on the whole eye group at build
 * time, so disc, bezel, iris, pupil, stars, catchlights, and the
 * stencil mask all stretch together and stay aligned.
 *
 * This is a static build-time scale for now; a natural extension is
 * per-state animation via `EXPRESSIONS` (e.g. SURPRISED widens the
 * scale, SLEEPY flattens it). Keeping the scale on the group makes
 * that a one-line hook when we're ready.
 */
const EYE_SHAPE_Y_SCALE = 1.18

/**
 * One eye in the paired rig. The single-lens configuration is
 * retired as part of the vinyl redesign (see
 * `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §Face). Per-frame pupil
 * writes iterate every rig so adding rigs later (e.g. a third
 * expressive cue) stays one-liner-simple.
 *
 * Hierarchy (outer to inner):
 *   group (at face offset — static, anchors the eye on the body)
 *   ├── bezel         — 3-D torus ring framing the socket
 *   ├── disc          — socket-interior shader, recessed into body
 *   ├── pupilGroup    (moves for gaze tracking)
 *   │   ├── irisGlow
 *   │   ├── iris       — accent color ring (takes state tint)
 *   │   ├── pupilField — soft-edge navy, covers iris center
 *   │   ├── stars[]    — tiny white sparkles inside pupil field
 *   │   ├── pupilDot   — near-black center, scales with pupilSize
 *   │   └── catchlights (primary + secondary)
 *   ├── upperLidPivot (hinge above socket, rotates X)
 *   │   └── upperLid  — shared spherical-cap body material
 *   └── lowerLidPivot (hinge below socket, rotates X)
 *       └── lowerLid
 */
export interface EyeRig {
  group: THREE.Group
  bezel: THREE.Mesh
  pupilGroup: THREE.Group
  iris: THREE.Mesh
  irisGlow: THREE.Mesh
  pupilField: THREE.Mesh
  pupilDot: THREE.Mesh
  stars: THREE.Mesh[]
  /**
   * Primary + secondary catchlights. Held on the rig so the
   * per-frame update can subtly shimmer their scale during
   * expressive states (TALKING / EXCITED / SURPRISED) for the
   * "wet, alive" read without the highlight going static.
   */
  catchPrimary: THREE.Mesh
  catchSecondary: THREE.Mesh
  upperLidPivot: THREE.Object3D
  upperLid: THREE.Mesh
  lowerLidPivot: THREE.Object3D
  lowerLid: THREE.Mesh
  jitterScale: number
}

export interface OrbitSceneHandles {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  head: THREE.Group
  body: THREE.Mesh
  bodyBundle: BodyMaterialBundle
  /**
   * Soft warm radial halo behind the body. Parented to the head so
   * it follows Orbit through flight and sway; renders additively
   * against the space background so the character reads as "lit
   * from within" without needing emissive on the matte body.
   */
  backlight: THREE.Mesh
  backlightBundle: BacklightMaterialBundle
  eyeBundle: EyeFieldMaterialBundle
  pupilMaterials: PupilMaterials
  /**
   * Left + right eye rigs. Materials are shared across rigs
   * (`eyeBundle` for the disc, `pupilMaterials` for pupil + glow),
   * so palette / lid / opacity writes propagate everywhere
   * automatically. Per-frame position+scale writes iterate this
   * list.
   */
  eyeRigs: EyeRig[]
  subSpheres: THREE.Mesh[]
  /**
   * Per-sub material bundle — same gradient uniforms as the body.
   * Index aligns with `subSpheres`. Palette-propagate writes walk
   * both in step.
   */
  subBundles: BodyMaterialBundle[]
  /**
   * Lid material bundles — one per eye, each with its own stencil
   * ref. Shares the vinyl gradient pipeline with the body + subs;
   * palette propagation updates all three in lockstep.
   */
  lidBundles: BodyMaterialBundle[]
  /**
   * Scene key light. Cast shadows from sub-spheres onto the body
   * (eclipse cue). Held on the handle so the controller can tweak
   * intensity or reparent it without touching scene traversal.
   */
  keyLight: THREE.DirectionalLight
  /**
   * Rolling sparkle trails — one per sub. Buffer is long enough that
   * during steady idle orbit the trail wraps into a visible sparkle
   * ring behind the sub; during expressive sub-modes (point / trace /
   * burst) the same buffer reads as a comet wake following the sub.
   * Intensity is state-driven via `ExpressionConfig.trailIntensity`.
   */
  trails: TrailHandle[]
  /**
   * Photoreal Earth stack — diffuse + night lights + atmosphere +
   * clouds + sun, shared with the VR view. Rebuilt on scale-preset
   * change (new radius + position) via {@link applyPreset}.
   */
  earth: PhotorealEarthHandle
  targetMarker: THREE.Mesh
  targetHalo: THREE.Mesh
  targetMat: THREE.MeshBasicMaterial
  targetHaloMat: THREE.MeshBasicMaterial
  appliedPreset: ScaleKey
}

export interface BuildSceneOptions {
  palette?: PaletteKey
  pixelRatio?: number
  scalePreset?: ScaleKey
}

export function buildScene(options: BuildSceneOptions = {}): OrbitSceneHandles {
  const palette = options.palette ?? 'cyan'
  const pixelRatio = options.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1)
  const initialPreset = options.scalePreset ?? 'close'
  const initial = SCALE_PRESETS[initialPreset]
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x060810)

  // Camera framed per preset — close keeps the intimate tabletop feel;
  // far presets pull back so both Orbit and Earth fit on a 2D screen.
  // In VR these camera moves drop (Quest handles framing natively).
  const camera = new THREE.PerspectiveCamera(initial.fov, 1, 0.05, 40)
  camera.position.fromArray(initial.cameraPos)
  camera.lookAt(new THREE.Vector3().fromArray(initial.cameraTarget))

  // Vinyl redesign: the body + sub-spheres use MeshStandardMaterial
  // which needs scene lighting. We add an ambient (so the shaded
  // side of Orbit still carries the gradient) and a directional key
  // that casts shadows. The photoreal Earth ships its own internal
  // ambient + sun for its own materials; those don't reach Orbit's
  // meshes because they're parented under the Earth handle's group.
  // Ambient dialed down + key light bumped up so the body's warm→
  // cool gradient actually shows. The earlier pass had ambient at
  // 0.55 which washed the MeshStandardMaterial diffuse out to a
  // neutral grey; the gradient couldn't fight that much fill. At
  // 0.35 ambient + 1.6 key light the pink/cool anchors read as
  // intended and the key light carries the body's form + the bezel
  // torus rim highlight.
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.35)
  scene.add(ambientLight)
  const keyLight = new THREE.DirectionalLight(0xfff6e8, 1.6)
  keyLight.position.set(0.18, 0.30, 0.45)
  keyLight.castShadow = true
  keyLight.shadow.mapSize.set(512, 512)
  // Tight frustum around the character — ignores Earth, keeps shadow
  // resolution high where it matters (sub shadows on the face).
  const shadowCam = keyLight.shadow.camera
  shadowCam.left = -0.28; shadowCam.right = 0.28
  shadowCam.top = 0.28; shadowCam.bottom = -0.28
  shadowCam.near = 0.10; shadowCam.far = 1.20
  shadowCam.updateProjectionMatrix()
  scene.add(keyLight)

  const head = new THREE.Group()
  scene.add(head)

  // Backlight halo — parented to head, behind the body, facing +Z.
  // The camera sits at +Z looking toward origin for every preset, so
  // a disc with no billboard logic reads correctly. Size is 3x the
  // body radius; fade is radial in the shader.
  const backlightBundle = createBacklightMaterial()
  const backlight = new THREE.Mesh(
    new THREE.CircleGeometry(BODY_RADIUS * 3.2, 48),
    backlightBundle.material,
  )
  backlight.position.z = -BODY_RADIUS * 0.8
  head.add(backlight)

  const bodyBundle = createBodyMaterial(palette)
  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(BODY_RADIUS, 4),
    bodyBundle.material,
  )
  body.castShadow = true
  body.receiveShadow = true
  head.add(body)

  const eyeBundle = createEyeFieldMaterial(palette)
  const pupilMaterials = createPupilMaterials(palette)
  // Bezel material + lid geometry are shared across both eyes — one
  // allocation, two instances. Held on the handles so dispose walks
  // them once via the scene traversal.
  const bezelMaterial = createBezelMaterial()
  const lidGeometry = createLidGeometry(LID_RADIUS)

  // Each eye has its own lid material bundle — same vinyl gradient as
  // the body, plus stencil flags keyed to that eye's stencilRef. Held
  // on the handles so palette propagation updates both along with the
  // body + subs.
  const lidBundleLeft = createLidMaterial(palette, LEFT_EYE_STENCIL_REF)
  const lidBundleRight = createLidMaterial(palette, RIGHT_EYE_STENCIL_REF)

  // Paired eyes — the vinyl redesign's permanent face configuration.
  // Placed lower (Y offset) and wider (X offset) than the original
  // rig so the character reads as neotenous and approachable. See
  // `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §Face.
  const eyeLeft = buildPairedEye(
    head, eyeBundle, pupilMaterials, lidBundleLeft.material, bezelMaterial, lidGeometry,
    -EYE_PAIR_OFFSET_X, EYE_PAIR_OFFSET_Y, EYE_STAR_POSITIONS_LEFT, LEFT_EYE_STENCIL_REF,
  )
  const eyeRight = buildPairedEye(
    head, eyeBundle, pupilMaterials, lidBundleRight.material, bezelMaterial, lidGeometry,
    +EYE_PAIR_OFFSET_X, EYE_PAIR_OFFSET_Y, EYE_STAR_POSITIONS_RIGHT, RIGHT_EYE_STENCIL_REF,
  )

  const eyeRigs: EyeRig[] = [eyeLeft, eyeRight]

  const subSpheres: THREE.Mesh[] = []
  const subBundles: BodyMaterialBundle[] = []
  for (let i = 0; i < 2; i++) {
    const bundle = createSubSphereMaterial(palette)
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(SUB_RADIUS, 2),
      bundle.material,
    )
    mesh.castShadow = true
    mesh.receiveShadow = false
    mesh.userData.phaseOffset = (i / 2) * Math.PI * 2
    // Per-sub orbital basis — two distinct crossing ellipses. Stored
    // once so the per-frame path is a pair of basis * cos/sin adds
    // with no trig of its own. Tilts diverge (one positive, one
    // negative) so the orbits read as crossing when viewed head-on.
    mesh.userData.orbitBasis = i === 0
      ? makeOrbitBasis(+0.62, 0.0)
      : makeOrbitBasis(-0.87, Math.PI / 2.3)
    scene.add(mesh)
    subSpheres.push(mesh)
    subBundles.push(bundle)
  }

  const trails = buildTrails(scene, subSpheres, palette, pixelRatio)

  // Earth — photoreal stack (diffuse + night lights + atmosphere +
  // clouds + sun), shared with the VR view. Radius + position come
  // from the preset; ground shadow omitted (multiple presets at
  // different positions, a single shadow plane doesn't help).
  // Rebuilt on preset change (see applyPreset).
  const earth = buildEarth(initial)
  earth.addTo(scene)

  // Target marker + halo (visible during POINTING / PRESENTING).
  const targetMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTES[palette].accent),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
  })
  const targetMarker = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 16, 12), targetMat)
  scene.add(targetMarker)
  const targetHaloMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PALETTES[palette].accent),
    transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
  })
  const targetHalo = new THREE.Mesh(new THREE.CircleGeometry(0.012, 32), targetHaloMat)
  scene.add(targetHalo)

  return {
    scene, camera, head, body, bodyBundle,
    backlight, backlightBundle,
    eyeBundle, pupilMaterials,
    eyeRigs,
    subSpheres, subBundles, lidBundles: [lidBundleLeft, lidBundleRight],
    keyLight, trails,
    earth,
    targetMarker, targetHalo, targetMat, targetHaloMat,
    appliedPreset: initialPreset,
  }
}

/**
 * Build an orthonormal basis for a sub-sphere's idle-orbit plane.
 * `tilt` rotates the plane around the Z axis (so different subs
 * trace visibly different ellipses); `twist` rotates within that
 * plane so the two subs aren't phase-synced at t=0.
 */
function makeOrbitBasis(tilt: number, twist: number): { u: THREE.Vector3; v: THREE.Vector3 } {
  // Base basis: X-Z plane. Tilt rotates it around Z. Twist spins
  // around the plane's normal so t=0 positions differ per sub.
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt)
  const cosW = Math.cos(twist), sinW = Math.sin(twist)
  const u = new THREE.Vector3(cosT * cosW, sinT * cosW, sinW)
  const v = new THREE.Vector3(-cosT * sinW, -sinT * sinW, cosW)
  return { u, v }
}

/**
 * Shared star geometry — a single five-point-star BufferGeometry used
 * for every sparkle sprite on both eyes. Cloning the mesh shares the
 * geometry, so adding/removing stars is cheap and memory stays flat.
 * Disposed with the scene traversal in `OrbitController.dispose`.
 */
const _starGeometry = createStarGeometry(EYE_STAR_RADIUS)

/**
 * Deterministic per-star placement so the stars don't shift between
 * left and right eye (would look like misaligned parallax) but each
 * eye has a distinct chart (so they don't read as "the same scene
 * twice"). Positions are in iris-local space, clamped inside the
 * pupil field minus a safety margin.
 */
const EYE_STAR_POSITIONS_LEFT: Array<[number, number]> = [
  [-0.0028, 0.0012],
  [ 0.0016, -0.0022],
  [ 0.0020, 0.0028],
]
const EYE_STAR_POSITIONS_RIGHT: Array<[number, number]> = [
  [ 0.0028, 0.0014],
  [-0.0018, -0.0020],
  [-0.0024, 0.0030],
]

/**
 * Build one half of the paired-eye configuration.
 *
 * The eye is a stacked rig with depth:
 *   • Socket disc is **recessed** into the body surface (Z < BODY_RADIUS).
 *   • Iris + pupil + stars + catchlights sit in the socket, progressively
 *     stepping back toward the body surface.
 *   • A **3-D bezel torus** sits flush with the body surface, framing
 *     the recess so the key light rims the upper arc.
 *   • **3-D spherical-cap lids** (upper + lower) on their own pivots
 *     rotate to cover the socket — they share the body's vinyl
 *     material so their color + shading match Orbit's skin exactly,
 *     and cast proper shadows into the socket.
 *
 * The gaze-tracking `pupilGroup` carries iris, pupil field, stars,
 * pupil dot, and catchlights; moving that one group for gaze keeps
 * everything anatomically aligned.
 */
function buildPairedEye(
  head: THREE.Group,
  eyeBundle: EyeFieldMaterialBundle,
  pupilMaterials: PupilMaterials,
  lidMaterial: THREE.Material,
  bezelMaterial: THREE.Material,
  lidGeometry: THREE.BufferGeometry,
  offsetX: number,
  offsetY: number,
  starPositions: Array<[number, number]>,
  stencilRef: number,
): EyeRig {
  const group = new THREE.Group()
  group.position.set(offsetX, offsetY, 0)
  head.add(group)

  // Socket stencil mask — invisible disc the size of the socket, drawn
  // BEFORE the lids to write `stencilRef` to the stencil buffer
  // everywhere the socket covers. Lids then test for this ID and only
  // render where it matches, so any dome geometry that swings outside
  // the socket rim gets clipped by the GPU. `renderOrder = -2` forces
  // this pass to run ahead of the lid passes within the same frame.
  const socketMask = new THREE.Mesh(
    new THREE.CircleGeometry(EYE_PAIR_DISC_RADIUS, 48),
    createSocketMaskMaterial(stencilRef),
  )
  socketMask.position.z = SOCKET_Z_DISC
  socketMask.renderOrder = -2
  group.add(socketMask)

  // Bezel torus — sits flush with the body surface, framing the
  // recessed socket. Matte charcoal `MeshStandardMaterial` so the
  // scene key light rims it.
  const bezel = new THREE.Mesh(
    new THREE.TorusGeometry(BEZEL_MAJOR_RADIUS, BEZEL_TUBE_RADIUS, 12, 32),
    bezelMaterial,
  )
  bezel.position.z = SOCKET_Z_BEZEL
  bezel.castShadow = false
  bezel.receiveShadow = true
  group.add(bezel)

  // Socket disc — static, recessed into the body. The eye-field
  // shader now does the socket interior only (no lid logic); 3-D lid
  // meshes handle coverage below.
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(EYE_PAIR_DISC_RADIUS, 48),
    eyeBundle.material,
  )
  disc.position.z = SOCKET_Z_DISC
  disc.receiveShadow = true
  group.add(disc)

  // Gaze-tracking pupil group — everything below moves together.
  const pupilGroup = new THREE.Group()
  group.add(pupilGroup)

  // Iris glow — large soft additive wash behind the iris, tinted by
  // state. Subtle; reads as the halo around the iris in emotive states.
  const irisGlow = new THREE.Mesh(
    new THREE.CircleGeometry(EYE_PAIR_IRIS_GLOW_RADIUS, 32),
    pupilMaterials.irisGlowMat,
  )
  irisGlow.position.z = SOCKET_Z_IRIS_GLOW
  pupilGroup.add(irisGlow)

  // Iris disc — accent-colored. Thin teal ring once the pupil field
  // covers the center.
  const iris = new THREE.Mesh(
    new THREE.CircleGeometry(EYE_PAIR_IRIS_RADIUS, 48),
    pupilMaterials.irisMat,
  )
  iris.position.z = SOCKET_Z_IRIS
  pupilGroup.add(iris)

  // Pupil field — soft-edge navy that feathers into the iris layer
  // underneath. The soft alpha edge is what sells the "liquid eye"
  // read vs. two stacked donut stickers.
  const pupilField = new THREE.Mesh(
    new THREE.CircleGeometry(EYE_PAIR_PUPIL_FIELD_RADIUS, 40),
    pupilMaterials.pupilFieldMat,
  )
  pupilField.position.z = SOCKET_Z_PUPIL_FIELD
  pupilGroup.add(pupilField)

  // Sparkle stars — tiny white five-point lights inside the pupil
  // field. Position is per-eye so the two eyes aren't identical.
  const stars: THREE.Mesh[] = []
  for (let i = 0; i < Math.min(EYE_STARS_PER_EYE, starPositions.length); i++) {
    const [sx, sy] = starPositions[i]
    const star = new THREE.Mesh(_starGeometry, pupilMaterials.starMat)
    star.position.set(sx, sy, SOCKET_Z_STARS)
    // Tiny per-star rotation variance so they read as "different stars"
    // rather than a rubber-stamped pattern.
    star.rotation.z = (i * 0.37) % (Math.PI * 2)
    pupilGroup.add(star)
    stars.push(star)
  }

  // Pupil dot — tiny near-black center. The anatomical pupil.
  const pupilDot = new THREE.Mesh(
    new THREE.CircleGeometry(EYE_PAIR_PUPIL_DOT_RADIUS, 24),
    pupilMaterials.pupilDotMat,
  )
  pupilDot.position.z = SOCKET_Z_PUPIL_DOT
  pupilGroup.add(pupilDot)

  // Primary + secondary catchlights. Soft radial falloff via custom
  // shader; scaling is animated per-frame for expressive states so
  // the highlight shimmers subtly instead of sitting static like a
  // decal.
  //
  // `catchXSign` mirrors the X component of each catchlight offset
  // per eye so the primary always lands on the OUTER side of the
  // face (and the secondary on the lower-outer). Without the mirror,
  // the two eyes share the same pupil-local offsets and produce a
  // bright asymmetric "nose-bridge" cluster between the eyes.
  const catchXSign = offsetX < 0 ? -1 : 1
  const catchPrimary = new THREE.Mesh(
    new THREE.CircleGeometry(CATCHLIGHT_PRIMARY_RADIUS, CATCHLIGHT_PRIMARY_SEGMENTS),
    createCatchlightMaterial(CATCHLIGHT_PRIMARY_OPACITY),
  )
  catchPrimary.position.set(
    CATCHLIGHT_PRIMARY_OFFSET_X * catchXSign,
    CATCHLIGHT_PRIMARY_OFFSET_Y,
    SOCKET_Z_CATCHLIGHT,
  )
  pupilGroup.add(catchPrimary)
  const catchSecondary = new THREE.Mesh(
    new THREE.CircleGeometry(CATCHLIGHT_SECONDARY_RADIUS, CATCHLIGHT_SECONDARY_SEGMENTS),
    createCatchlightMaterial(CATCHLIGHT_SECONDARY_OPACITY),
  )
  catchSecondary.position.set(
    CATCHLIGHT_SECONDARY_OFFSET_X * catchXSign,
    CATCHLIGHT_SECONDARY_OFFSET_Y,
    SOCKET_Z_CATCHLIGHT + 0.00005,
  )
  pupilGroup.add(catchSecondary)

  // Upper + lower lids — shared spherical-cap geometry, shared body
  // vinyl material. Each lid is parented to a pivot Object3D at the
  // socket-plane Z depth so the rotation axis hinges around the
  // socket rim, not proud of the body surface.
  //
  // `castShadow` is OFF on lids: the earlier pass had it on, and
  // parked lids sitting just in front of the body dropped shadows
  // onto the lower face exactly where a mouth would be — the
  // "creepy smudge" bug. The lid's own pigment + the body's key
  // light already carry the closed-eye read; a cast shadow from
  // the lid onto the iris is not worth the false-mouth artifact.
  // Lid meshes use `lidMaterial` (a lid-specific clone of the body
  // bundle with stencil-EQUAL test enabled). The material is shared
  // across both lids of one eye. Render order +1 ensures the stencil
  // mask has already run.
  const upperLidPivot = new THREE.Object3D()
  upperLidPivot.position.set(0, UPPER_LID_PIVOT_Y, LID_PIVOT_Z)
  upperLidPivot.rotation.x = UPPER_LID_PARKED_ROT
  group.add(upperLidPivot)
  const upperLid = new THREE.Mesh(lidGeometry, lidMaterial)
  upperLid.position.set(0, LID_MESH_Y_OFFSET, 0)
  upperLid.castShadow = false
  upperLid.receiveShadow = true
  upperLid.renderOrder = 1
  upperLidPivot.add(upperLid)

  const lowerLidPivot = new THREE.Object3D()
  lowerLidPivot.position.set(0, LOWER_LID_PIVOT_Y, LID_PIVOT_Z)
  lowerLidPivot.rotation.x = LOWER_LID_PARKED_ROT
  group.add(lowerLidPivot)
  const lowerLid = new THREE.Mesh(lidGeometry, lidMaterial)
  // Lower lid mirrors the upper: same geometry, rotated 180° around X
  // so it opens upward. Offset NEGATED vs. the upper lid —
  // Three.js applies mesh.rotation first, then mesh.position, so
  // using the same -Y offset as the upper lid would drive the lower
  // dome's cap FURTHER from its pivot (position and rotated-cap
  // direction both pointing -Y, so they add instead of cancel). The
  // sign flip on the offset restores the mirror: upper cap at
  // +0.65·r above pivot, lower cap at -0.65·r below pivot.
  lowerLid.rotation.x = Math.PI
  lowerLid.position.set(0, -LID_MESH_Y_OFFSET, 0)
  lowerLid.castShadow = false
  lowerLid.receiveShadow = true
  lowerLid.renderOrder = 1
  lowerLidPivot.add(lowerLid)

  // Stretch the whole eye group vertically into the slight ellipse
  // the concept art shows. Disc, bezel torus, iris, pupil field,
  // stars, catchlights, lid pivots + lid meshes, and the stencil
  // mask all inherit this scale together — they all stretch in
  // lockstep so iris/mask alignment holds at any closed rotation.
  group.scale.set(1, EYE_SHAPE_Y_SCALE, 1)

  return {
    group, bezel, pupilGroup,
    iris, irisGlow, pupilField, pupilDot, stars,
    catchPrimary, catchSecondary,
    upperLidPivot, upperLid, lowerLidPivot, lowerLid,
    jitterScale: EYE_PAIR_JITTER_SCALE,
  }
}

/**
 * Build a fresh photoreal Earth handle for the given preset. Used by
 * both initial `buildScene` and by `applyPreset` on scale changes —
 * photoreal Earth's atmosphere/cloud geometries are sized at
 * construction so a preset swap tears down and rebuilds the whole
 * stack rather than mutating geometries in place.
 */
function buildEarth(preset: ScalePreset): PhotorealEarthHandle {
  return createPhotorealEarth(THREE, {
    radius: preset.earthRadius,
    position: {
      x: preset.earthCenter[0],
      y: preset.earthCenter[1],
      z: preset.earthCenter[2],
    },
    includeShadow: false,
  })
}

/**
 * Apply a scale-preset change to an already-built scene. Tears down
 * and rebuilds the photoreal Earth (its atmosphere / cloud / shadow
 * geometries are sized at construction so in-place resize would
 * require rebuilding each of them anyway), re-points the camera, and
 * records the applied preset on the handles so the controller can
 * detect changes.
 */
export function applyPreset(handles: OrbitSceneHandles, preset: ScaleKey): void {
  const pp = SCALE_PRESETS[preset]
  handles.earth.removeFrom(handles.scene)
  handles.earth.dispose()
  handles.earth = buildEarth(pp)
  handles.earth.addTo(handles.scene)
  handles.camera.position.fromArray(pp.cameraPos)
  handles.camera.lookAt(new THREE.Vector3().fromArray(pp.cameraTarget))
  handles.camera.fov = computeEffectiveFov(pp.fov, handles.camera.aspect)
  handles.camera.updateProjectionMatrix()
  handles.appliedPreset = preset
}

// -----------------------------------------------------------------------
// Per-frame animation state — the "current" object from the prototype.
// Holds eased values that ramp toward the active state's targets each
// frame so state transitions feel smooth, not snappy.
// -----------------------------------------------------------------------

export interface AnimationState {
  orbitSpeed: number
  subRadius: number
  orbitPhaseAccum: number

  eyeYaw: number
  eyePitch: number

  headPitch: number
  headYaw: number
  headRoll: number

  jitterX: number
  jitterY: number
  jitterTargetX: number
  jitterTargetY: number
  jitterNextTime: number

  blinkStartTime: number
  nextBlinkTime: number

  wanderTargetX: number
  wanderTargetY: number
  wanderTimer: number

  currentPupilColor: THREE.Color

  // Active gesture overlay (null when none playing). startTime is in
  // the controller's `time` clock, not wall-clock.
  activeGesture: { kind: GestureKind; startTime: number } | null

  // ── Squash & stretch state ──────────────────────────────────────
  /**
   * Last frame's head position in world space. Used to compute
   * velocity for the flight smear — we don't want to reach into
   * `FlightState` because the sway offset is applied on top of the
   * flight-rest position and we want the full motion vector.
   */
  prevHeadPos: THREE.Vector3
  /** -1 when inactive. `time` when the SURPRISED gasp spring started. */
  surpriseStart: number
  /** -1 when inactive. `time` when the arrival squash pulse started. */
  arrivalSquashStart: number
  /**
   * Last frame's `input.state` — used to detect state entry so
   * `surpriseGasp` fires on the transition INTO SURPRISED, not on
   * every frame SURPRISED is active.
   */
  lastStateKey: StateKey
  /** Eased body scale — lerps toward the procedural target each frame. */
  bodyScaleX: number
  bodyScaleY: number
  bodyScaleZ: number

  // ── User-presence awareness ──────────────────────────────────────
  /**
   * Eased cursor-activity scalar in `[0, 1]`. Ramps up when the
   * pointer is moving, decays with ~2 s of stillness. Drives ambient
   * gaze blending — when the user is actively moving the mouse,
   * Orbit's eyes blend toward cursor tracking regardless of state;
   * during idle, state-native gaze (wandering, etc.) takes over.
   */
  gazeBias: number
  /**
   * Eased user-proximity scalar in `[0, 1]`. 0 when the cursor is
   * far from Orbit's projected screen position, 1 when it's at or
   * past the body silhouette. Modulates pupil dilation, lid
   * softening, and recoil. Shares the scalar with VR controller
   * proximity (same value, driven from a different input source).
   */
  userProximity: number
  /**
   * Recoil head-position offset in head-local world units, eased
   * back to zero each frame. Applied on top of flight + sway so
   * Orbit physically pulls back when the cursor gets very close or
   * clicks. Kept small (a few mm) — it's ticklishness, not flight.
   */
  recoilZ: number
}

export function createAnimationState(palette: PaletteKey = 'cyan'): AnimationState {
  return {
    orbitSpeed: 0.5,
    subRadius: SUB_ORBIT_RADIUS,
    orbitPhaseAccum: 0,
    eyeYaw: 0,
    eyePitch: 0,
    headPitch: 0,
    headYaw: 0,
    headRoll: 0,
    jitterX: 0,
    jitterY: 0,
    jitterTargetX: 0,
    jitterTargetY: 0,
    jitterNextTime: 0,
    blinkStartTime: -1,
    nextBlinkTime: 1.0 + Math.random() * 2.0,
    wanderTargetX: 0,
    wanderTargetY: 0,
    wanderTimer: 0,
    currentPupilColor: new THREE.Color(PALETTES[palette].accent),
    activeGesture: null,
    prevHeadPos: new THREE.Vector3(),
    surpriseStart: -1,
    arrivalSquashStart: -1,
    lastStateKey: 'IDLE',
    bodyScaleX: 1,
    bodyScaleY: 1,
    bodyScaleZ: 1,
    gazeBias: 0,
    userProximity: 0,
    recoilZ: 0,
  }
}

/**
 * Begin a gesture. Returns `false` if one is already playing (no
 * interruption in Phase 3 — design doc §Open questions defers
 * gesture chaining pending real use cases from the docent layer).
 */
export function startGesture(
  anim: AnimationState,
  kind: GestureKind,
  time: number,
): boolean {
  if (anim.activeGesture) return false
  anim.activeGesture = { kind, startTime: time }
  return true
}

export function isGesturePlaying(anim: AnimationState): boolean {
  return anim.activeGesture !== null
}

export interface UpdateInput {
  state: StateKey
  palette: PaletteKey
  scalePreset: ScaleKey
  /**
   * Eye configuration — retained in the input shape for API stability
   * but narrowed to a single literal (`'two'`) by the vinyl redesign.
   * The field is effectively informational; there is no longer a
   * per-frame visibility flip.
   */
  eyeMode: EyeMode
  flight: FlightState
  time: number
  dt: number
  mouseX: number // [-1, 1] — normalized pointer x, used by CHATTING/TALKING gaze
  mouseY: number // [-1, 1]
  /**
   * When true, honor the user's OS `prefers-reduced-motion` setting:
   * cap sub-sphere orbit speed, suppress pupil pulse / jitter, drop
   * gesture pupil flashes. Flight is handled at the controller level
   * (start* functions take the same flag and zero the duration).
   * The character stays expressive — head nods, gaze tracking, blinks,
   * and state transitions all continue — but the motion-heavy effects
   * that motion-sensitive viewers actually flag as uncomfortable get
   * dialed back. Driven by `OrbitController.setReducedMotion()`.
   */
  reducedMotion: boolean
  /**
   * Seconds since the pointer last moved. Used to decay the
   * `gazeBias` scalar — when the cursor is active (≤ 0.5 s), ambient
   * gaze tracks the cursor; after ~2 s of stillness, gaze falls back
   * to the state's native behavior (wandering, etc.). Driven by
   * `OrbitController` tracking `pointermove` timestamps.
   */
  cursorActivityTime: number
}

/**
 * Sub-sphere orbit-speed ceiling under reduced motion. 0.5 matches
 * IDLE/CHATTING; states that normally run faster (TALKING 1.2,
 * EXCITED 2.5) get clamped here so the orbit never races. Slower
 * states (THINKING 0.2, SLEEPY 0.15) are left alone.
 */
const REDUCED_MOTION_ORBIT_SPEED_CAP = 0.5

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const sat = (x: number): number => Math.max(0, Math.min(1, x))

const _tmpTargetColor = new THREE.Color()
const _tmpStateColor = new THREE.Color()
const _tmpGestureColor = new THREE.Color()
const _tmpGazeDir = new THREE.Vector3()
const _tmpGestureDir = new THREE.Vector3()
const _tmpActiveTarget = new THREE.Vector3()
const _tmpEarthFeature = new THREE.Vector3()
const _tmpRestPos = new THREE.Vector3()
const _tmpHeadNdc = new THREE.Vector3()

// User-presence tuning constants. Proximity NDC thresholds are in
// camera-normalized coords; `PROXIMITY_FAR` is the outer edge of
// the "nearby" zone (beyond = no effect) and `PROXIMITY_BODY` is
// the cursor-on-body threshold (inside = maxed out proximity).
const PROXIMITY_FAR = 0.55
const PROXIMITY_BODY = 0.10
// Cursor activity decay: full effect up to `ACTIVITY_FULL` seconds
// after the last move, linearly decaying to 0 over the next
// `ACTIVITY_FADE` seconds.
const ACTIVITY_FULL = 0.5
const ACTIVITY_FADE = 2.0
// Recoil — only kicks in past this proximity threshold, scales up
// to a small max offset so the lean-back reads as ticklish flinch,
// not flight. Max = −2.5 cm in head-local Z (away from camera).
const RECOIL_TRIGGER = 0.92
const RECOIL_MAX_Z = -0.025
// Maximum ambient-gaze blend weight — caps how far cursor tracking
// can pull a state's native gaze before the state loses its read.
const AMBIENT_GAZE_MAX_BLEND = 0.65
// States whose native gaze already tracks the cursor — ambient
// blend is skipped for these so we don't double-apply.
const MOUSE_TRACKING_STATES = new Set<StateKey>([
  'CHATTING', 'TALKING', 'LISTENING',
])

/**
 * Per-frame update.
 *
 * Runs every sub-system in the order the prototype runs them — easing
 * first, then gesture detection (stub in Phase 2), sub-sphere position,
 * blink, pupil color, gaze, head rotation, jitter. Kept monolithic
 * because the order matters: earlier computations are inputs to later
 * ones (e.g. pupil visibility depends on current blink amount).
 */
export function updateCharacter(
  handles: OrbitSceneHandles,
  anim: AnimationState,
  input: UpdateInput,
): void {
  const { state, palette, scalePreset, flight, time, dt, mouseX, mouseY, reducedMotion } = input
  const s = STATES[state]
  const expr = expressionFor(state)

  const p = PALETTES[palette]
  const preset = SCALE_PRESETS[scalePreset]

  // ── Preset change detection ───────────────────────────────────────
  if (handles.appliedPreset !== scalePreset) {
    applyPreset(handles, scalePreset)
    // Snap Orbit back to chat — the preset swap is a world mutation,
    // not a flight. The controller also resets flight.mode to 'rest'.
  }

  // ── Flight — compute Orbit's rest position in world space ─────────
  const mode = updateFlight(flight, preset, time, _tmpRestPos)
  const inFlight = (mode === 'out' || mode === 'back')

  // Body sway on top of rest position
  const sway = Math.sin(time * 0.7) * 0.004
  handles.head.position.set(_tmpRestPos.x, _tmpRestPos.y + sway, _tmpRestPos.z)

  // ── User presence: cursor proximity + gaze bias + recoil ────────
  // Project Orbit's head position to normalized device coordinates
  // (x/y in [-1, 1]) and compare to the cursor NDC. Proximity is
  // 1 when the cursor is at/inside the body silhouette, 0 beyond
  // PROXIMITY_FAR. Everything here respects reducedMotion — the
  // tracking stays on (non-vestibular), but startle / recoil are
  // suppressed.
  _tmpHeadNdc.copy(handles.head.position).project(handles.camera)
  const ndcDx = _tmpHeadNdc.x - mouseX
  const ndcDy = _tmpHeadNdc.y - mouseY
  const ndcDist = Math.sqrt(ndcDx * ndcDx + ndcDy * ndcDy)
  const rawProximity = sat(
    1 - (ndcDist - PROXIMITY_BODY) / (PROXIMITY_FAR - PROXIMITY_BODY)
  )
  anim.userProximity = lerp(anim.userProximity, rawProximity, 0.10)

  // Gaze bias — full strength for the first ACTIVITY_FULL seconds
  // after a cursor move, decaying to 0 over the next ACTIVITY_FADE.
  const rawBias = sat(1 - (input.cursorActivityTime - ACTIVITY_FULL) / ACTIVITY_FADE)
  anim.gazeBias = lerp(anim.gazeBias, rawBias, 0.10)

  // Recoil — very close proximity pulls Orbit slightly back from
  // camera. Suppressed under reducedMotion. Eased back to zero each
  // frame so a pass-by doesn't leave Orbit stuck backed up.
  const recoilTarget = (!reducedMotion && anim.userProximity > RECOIL_TRIGGER)
    ? ((anim.userProximity - RECOIL_TRIGGER) / (1 - RECOIL_TRIGGER)) * RECOIL_MAX_Z
    : 0
  anim.recoilZ = lerp(anim.recoilZ, recoilTarget, 0.20)
  handles.head.position.z += anim.recoilZ

  // ── Active feature target (what POINTING / PRESENTING / BECKON trace) ──
  // At Earth → earth feature on Earth's surface (scales with preset).
  // At chat → the CHAT_FEATURE vector in front of Orbit.
  //
  // Close preset is a tabletop composition: Earth already sits right
  // beside Orbit at chat distance, so "chat-distance feature" and
  // "Earth feature" refer to the same visible thing. Route gestures
  // to the Earth surface at close scale regardless of flight mode —
  // otherwise PRESENTING would trace empty air to Orbit's right
  // rather than the globe the user is looking at.
  const featureIsAtEarth = (mode === 'atEarth' || mode === 'out' || scalePreset === 'close')
  if (featureIsAtEarth) {
    featureOf(preset, _tmpEarthFeature)
    _tmpActiveTarget.copy(_tmpEarthFeature)
  } else {
    _tmpActiveTarget.copy(CHAT_FEATURE)
  }
  // featureScale: at Earth, trace radii scale with Earth size so the
  // oval is proportional to the planet being traced.
  const featureScale = featureIsAtEarth ? (preset.earthRadius / 0.22) : 1.0
  handles.targetMarker.position.copy(_tmpActiveTarget)
  handles.targetHalo.position.copy(_tmpActiveTarget)
  handles.targetHalo.position.z += 0.0005

  // ── Gesture: advance time + compute frame (or end gesture) ────────
  // Done first so later sections (head, pupil, sub-spheres) can read
  // the gesture frame instead of the state-driven values.
  let gestureFrame: GestureFrame | null = null
  if (anim.activeGesture) {
    const g = GESTURES[anim.activeGesture.kind]
    const gT = (time - anim.activeGesture.startTime) / g.duration
    if (gT >= 1) {
      anim.activeGesture = null
    } else {
      // Beckon reads the direction to the active target: CHAT_FEATURE
      // at chat distance, the Earth-surface feature when at Earth.
      _tmpGestureDir.subVectors(_tmpActiveTarget, handles.head.position).normalize()
      gestureFrame = g.compute(gT, {
        direction: _tmpGestureDir,
        featureIsAtEarth,
        reducedMotion,
      })
    }
  }

  // ── Palette propagation (vinyl gradient + eye-field lid color) ───
  // Body + subs share the MeshStandardMaterial gradient pipeline, so
  // a palette swap just writes the warm/cool anchor pair onto each
  // bundle's uniforms. The eye-field's `uBodyColor` mirrors `warm`
  // so lids close to the top-of-face hue without a seam.
  handles.bodyBundle.uniforms.uWarm.value.set(p.warm)
  handles.bodyBundle.uniforms.uCool.value.set(p.cool)
  handles.bodyBundle.uniforms.uBaseColor.value.set(p.base)
  handles.bodyBundle.uniforms.uAccentColor.value.set(p.accent)
  handles.bodyBundle.uniforms.uGlowColor.value.set(p.glow)
  // Eye-field uniforms carry only socket interior colors now (no
  // palette-tinted lid blend), so palette propagation doesn't touch
  // them — they're set once at build and stay constant.
  for (const bundle of handles.subBundles) {
    bundle.uniforms.uWarm.value.set(p.warm)
    bundle.uniforms.uCool.value.set(p.cool)
  }
  // Lid materials mirror the body gradient so their skin color matches
  // whatever body region sits behind the socket, palette and all.
  for (const bundle of handles.lidBundles) {
    bundle.uniforms.uWarm.value.set(p.warm)
    bundle.uniforms.uCool.value.set(p.cool)
  }
  handles.bodyBundle.uniforms.uTime.value = time

  // Photoreal Earth drives its own sun direction + atmosphere/
  // shadow follow each frame. It's cheap (no per-frame allocations
  // after the initial setup) and the day/night terminator needs
  // frame-accurate world-space sun direction to stay aligned.
  handles.earth.update()

  // ── Eased "current" values ────────────────────────────────────────
  // Reduced motion clamps the orbit speed (only down — slow states
  // already below the cap stay where they are). Easing keeps the
  // toggle smooth instead of snapping mid-animation.
  const targetOrbitSpeed = reducedMotion
    ? Math.min(s.orbitSpeed, REDUCED_MOTION_ORBIT_SPEED_CAP)
    : s.orbitSpeed
  anim.orbitSpeed = lerp(anim.orbitSpeed, targetOrbitSpeed, 0.04)
  const targetRadius = SUB_ORBIT_RADIUS * s.orbitRadiusScale
  anim.subRadius = lerp(anim.subRadius, targetRadius, 0.05)

  // ── Body subtle rotation (sway Y now lives in head position) ─────
  handles.body.rotation.x = Math.sin(time * 0.5) * 0.05
  handles.body.rotation.z = Math.sin(time * 0.7) * 0.03

  // ── Pupil pulse (TALKING) + iris/pupil size ──────────────────────
  // The iris is the color carrier and stays at unit scale — big eyes
  // are a cuteness signal. `pupilSize` now drives the black pupil
  // DOT and the additive iris glow (both scale together), which is
  // anatomically correct: pupil dilates/constricts, iris ring
  // width stays roughly constant. Reduced motion drops the pulse.
  const pulseMul = (s.pupilPulse && !reducedMotion) ? (Math.sin(time * 9.0) * 0.25 + 1.0) : 1.0
  const finalPupilBright = s.pupilBrightness * pulseMul
  // Proximity dilates the pupil slightly — alert/attentive read when
  // the user is close. Max +15 % at full proximity.
  const proximityDilation = 1 + anim.userProximity * 0.15
  const targetDotScale = s.pupilSize * proximityDilation
  for (const rig of handles.eyeRigs) {
    rig.pupilDot.scale.setScalar(lerp(rig.pupilDot.scale.x, targetDotScale, 0.15))
    rig.irisGlow.scale.setScalar(rig.pupilDot.scale.x * 1.10)
  }

  // ── Catchlight shimmer (TALKING / EXCITED / SURPRISED) ───────────
  // A small scale oscillation reinforces "wet, alive" during
  // expressive states without pulling attention. Suppressed under
  // reducedMotion per the accessibility pattern. Other states get
  // a lerp back to scale 1 so leaving a shimmer state doesn't leave
  // the catchlight stuck off-size.
  const wantsShimmer = (state === 'TALKING' || state === 'EXCITED' || state === 'SURPRISED')
    && !reducedMotion
  if (wantsShimmer) {
    // ~4 Hz with small amplitude; primary and secondary slightly
    // out of phase so the two highlights don't pulse in lockstep.
    const shimmerPrimary = 1 + Math.sin(time * 4.0 * Math.PI * 2) * 0.05
    const shimmerSecondary = 1 + Math.sin(time * 4.0 * Math.PI * 2 + 1.5) * 0.05
    for (const rig of handles.eyeRigs) {
      rig.catchPrimary.scale.setScalar(shimmerPrimary)
      rig.catchSecondary.scale.setScalar(shimmerSecondary)
    }
  } else {
    for (const rig of handles.eyeRigs) {
      rig.catchPrimary.scale.setScalar(lerp(rig.catchPrimary.scale.x, 1, 0.18))
      rig.catchSecondary.scale.setScalar(lerp(rig.catchSecondary.scale.x, 1, 0.18))
    }
  }

  // ── Blink scheduler ───────────────────────────────────────────────
  if (s.blinkInterval > 0 && anim.blinkStartTime < 0 && time >= anim.nextBlinkTime) {
    anim.blinkStartTime = time
    anim.nextBlinkTime = time + s.blinkInterval * (0.65 + Math.random() * 0.7)
  }
  let blinkAmount = 0
  if (anim.blinkStartTime >= 0) {
    const blinkDur = s.blinkDuration > 0 ? s.blinkDuration : 0.14
    const t = (time - anim.blinkStartTime) / blinkDur
    if (t >= 1) anim.blinkStartTime = -1
    else {
      const tri = t < 0.5 ? t * 2 : (1 - t) * 2
      blinkAmount = Math.sin(tri * Math.PI * 0.5)
    }
  }
  // Lid twitch — state-specific irregular micro-oscillation added on
  // top of the state's base lid position. Driven by two out-of-sync
  // sines so the motion reads as uneven nervous-system twitch rather
  // than a smooth sine wobble. Used by CONFUSED (half-closed + twitch
  // is the reference concept art's read for the state). Reduced
  // motion zeroes the twitch entirely.
  let twitchUpper = 0, twitchLower = 0
  if (state === 'CONFUSED' && !reducedMotion) {
    twitchUpper = Math.sin(time * 12.0) * 0.030 + Math.sin(time * 19.3 + 1.1) * 0.020
    twitchLower = Math.sin(time * 10.5 + 1.7) * 0.030 + Math.sin(time * 17.1 + 0.5) * 0.020
  }
  // Proximity lid soften — cursor close to Orbit opens the lids a
  // touch (alert attention). Small absolute magnitude so a low-lid
  // state like IDLE (0.18 baseline) keeps a clearly visible rim
  // even at full proximity. The cap at half of baseline is also
  // kept as a belt-and-braces safeguard for unusual state values.
  const proximitySoften = anim.userProximity * 0.03
  const upperSoften = Math.min(proximitySoften, s.upperLid * 0.5)
  const lowerSoften = Math.min(proximitySoften, s.lowerLid * 0.5)
  const upperBase = Math.max(0, s.upperLid - upperSoften) + twitchUpper
  const lowerBase = Math.max(0, s.lowerLid - lowerSoften) + twitchLower
  const effectiveUpper = Math.max(upperBase, blinkAmount)
  const effectiveLower = Math.max(lowerBase, blinkAmount * 0.35)
  // 3-D lid meshes: interpolate pivot rotation between "parked" (out
  // of frame) and "closed" (covering the socket).
  //
  // Bias is non-linear (sqrt) so small effectiveLid values produce
  // meaningful rotation early — a linear lerp maps e.g. lid=0.18 to
  // only 18 % of the rotation range (still nearly parked, no visible
  // rim). sqrt(0.18) ≈ 0.42 lands the dome visibly across the top of
  // the iris at that amount. lid=0 still parks fully (sqrt(0) = 0),
  // so wide-eyed states like SURPRISED / EXCITED remain lidless.
  const lidCurve = (x: number): number => Math.sqrt(Math.max(0, x))
  const upperLidRot = lerp(UPPER_LID_PARKED_ROT, UPPER_LID_CLOSED_ROT, lidCurve(effectiveUpper))
  const lowerLidRot = lerp(LOWER_LID_PARKED_ROT, LOWER_LID_CLOSED_ROT, lidCurve(effectiveLower))
  for (const rig of handles.eyeRigs) {
    rig.upperLidPivot.rotation.x = lerp(rig.upperLidPivot.rotation.x, upperLidRot, 0.25)
    rig.lowerLidPivot.rotation.x = lerp(rig.lowerLidPivot.rotation.x, lowerLidRot, 0.25)
  }
  // Keep iris/pupil opacity tracking lid closure: when a lid is
  // mostly down the iris behind it should fade (so the crescent of
  // exposed iris reads as a genuine sliver rather than bleeding
  // through the lid edge at partial closure).
  const coverByUpper = sat((effectiveUpper - 0.35) / 0.25)
  const coverByLower = sat((effectiveLower - 0.35) / 0.25)
  const pupilVis = 1 - Math.max(coverByUpper, coverByLower)

  // ── Pupil color blend ─────────────────────────────────────────────
  // Three tiers (design doc §Color semantics): palette accent is
  // baseline; state pupilColor blends in at 65% (SOLEMN, CONFUSED);
  // gesture pupilFlash blends in by its envelope (Affirm's gold
  // "mm-hm"). Frame-to-frame easing keeps transitions soft.
  _tmpTargetColor.set(p.accent)
  if (s.pupilColor) {
    _tmpStateColor.set(s.pupilColor)
    _tmpTargetColor.lerp(_tmpStateColor, 0.65)
  }
  // Gesture pupil flashes (e.g. Affirm's gold "mm-hm") are skipped
  // under reduced motion — the rapid color spike reads as a flash.
  if (gestureFrame && gestureFrame.pupilColor && gestureFrame.pupilFlash && !reducedMotion) {
    _tmpGestureColor.set(gestureFrame.pupilColor)
    _tmpTargetColor.lerp(_tmpGestureColor, gestureFrame.pupilFlash)
  }
  anim.currentPupilColor.lerp(_tmpTargetColor, 0.12)
  // Iris ring carries the palette accent + state-tint color. The
  // iris stays at constant brightness while open (eyes don't dim
  // just because you're CHATTING vs POINTING), so opacity just
  // tracks pupilVis — SOLEMN/CONFUSED/gesture tints still blend in
  // via `currentPupilColor`.
  handles.pupilMaterials.irisMat.color.copy(anim.currentPupilColor)
  handles.pupilMaterials.irisGlowMat.color.copy(anim.currentPupilColor)
  handles.pupilMaterials.irisMat.opacity = sat(pupilVis)
  handles.pupilMaterials.irisGlowMat.opacity = sat(0.4 * finalPupilBright * pupilVis)
  // Pupil field + dot + stars fade with the same lid coverage so a
  // closing eye hides everything cleanly. The pupil field is a
  // custom ShaderMaterial (soft radial edge), so its fade is on a
  // uOpacity uniform rather than the top-level `.opacity` property.
  handles.pupilMaterials.pupilFieldUniforms.uOpacity.value = sat(pupilVis)
  handles.pupilMaterials.pupilDotMat.opacity = sat(pupilVis)
  handles.pupilMaterials.starMat.opacity = sat(0.85 * pupilVis)

  // ── Eye gaze (flight-aware, then state-specific) ─────────────────
  let tYaw = 0, tPitch = 0
  if (inFlight) {
    // Look toward destination so Orbit reads as "heading there."
    _tmpGazeDir.subVectors(flight.endPos, handles.head.position).normalize()
    tYaw = Math.atan2(_tmpGazeDir.x, _tmpGazeDir.z)
    const horiz = Math.sqrt(_tmpGazeDir.x * _tmpGazeDir.x + _tmpGazeDir.z * _tmpGazeDir.z)
    tPitch = -Math.atan2(_tmpGazeDir.y, horiz)
  } else switch (state) {
    case 'CHATTING':
    case 'TALKING':
      tYaw = mouseX * 0.55
      tPitch = -mouseY * 0.35
      break
    case 'LISTENING':
      tYaw = mouseX * 0.2
      tPitch = -mouseY * 0.15 + 0.05
      break
    case 'POINTING':
    case 'PRESENTING': {
      _tmpGazeDir.subVectors(_tmpActiveTarget, handles.head.position).normalize()
      tYaw = Math.atan2(_tmpGazeDir.x, _tmpGazeDir.z)
      const horiz = Math.sqrt(_tmpGazeDir.x * _tmpGazeDir.x + _tmpGazeDir.z * _tmpGazeDir.z)
      tPitch = -Math.atan2(_tmpGazeDir.y, horiz)
      if (state === 'PRESENTING') tYaw += Math.sin(time * 0.9) * 0.06
      break
    }
    case 'THINKING':
      tYaw = -0.35
      tPitch = 0.3
      break
    case 'EXCITED':
      tYaw = Math.sin(time * 3.0) * 0.4
      tPitch = Math.cos(time * 2.3) * 0.25
      break
    case 'SURPRISED':
      tYaw = 0
      tPitch = 0
      break
    case 'SLEEPY':
      tYaw = Math.sin(time * 0.3) * 0.12
      tPitch = 0.18 + Math.cos(time * 0.25) * 0.05
      break
    case 'HAPPY':
      tYaw = Math.sin(time * 0.5) * 0.18
      tPitch = Math.cos(time * 0.7) * 0.08
      break
    case 'CURIOUS':
      tYaw = Math.sin(time * 0.6) * 0.25
      tPitch = Math.cos(time * 0.4) * 0.15 - 0.05
      break
    case 'YES':
    case 'NO':
      tYaw = 0
      tPitch = 0
      break
    default: {
      // IDLE + anything unhandled: wandering gaze.
      anim.wanderTimer -= dt
      if (anim.wanderTimer <= 0) {
        anim.wanderTargetX = (Math.random() - 0.5) * 0.7
        anim.wanderTargetY = (Math.random() - 0.5) * 0.4
        anim.wanderTimer = 2 + Math.random() * 2.5
      }
      tYaw = anim.wanderTargetX
      tPitch = anim.wanderTargetY
    }
  }
  // Ambient gaze blend — when the cursor is active and the state
  // doesn't already track the mouse, blend the state's native gaze
  // toward a cursor-tracking target by `gazeBias`. Blend is capped
  // at AMBIENT_GAZE_MAX_BLEND so the state's native gaze still has
  // influence (e.g. THINKING's up-and-left still reads as thought
  // even while the user is moving the cursor). Flight and gestures
  // override entirely — no ambient blending during those.
  if (!inFlight && !gestureFrame && !MOUSE_TRACKING_STATES.has(state)) {
    const ambientYaw = mouseX * 0.40
    const ambientPitch = -mouseY * 0.30
    const blend = anim.gazeBias * AMBIENT_GAZE_MAX_BLEND
    tYaw = lerp(tYaw, ambientYaw, blend)
    tPitch = lerp(tPitch, ambientPitch, blend)
  }

  anim.eyeYaw = lerp(anim.eyeYaw, tYaw, 0.14)
  anim.eyePitch = lerp(anim.eyePitch, tPitch, 0.14)

  // ── Head motion (nod / shake / tilt per state, or gesture override) ──
  // Head-ownership rule (design doc §Gesture overlay system): when a
  // gesture specifies `head`, it owns head rotation exclusively for
  // its duration. State head eases toward 0 so when the gesture ends,
  // state head resumes from rest instead of snapping mid-motion.
  // Gestures without a `head` (Wave) leave state head alone — a Wave
  // during YES continues nodding while the sub waves.
  if (gestureFrame && gestureFrame.head) {
    anim.headPitch = lerp(anim.headPitch, 0, 0.22)
    anim.headYaw = lerp(anim.headYaw, 0, 0.22)
    anim.headRoll = lerp(anim.headRoll, 0, 0.22)
    handles.head.rotation.x = gestureFrame.head.pitch ?? 0
    handles.head.rotation.y = gestureFrame.head.yaw ?? 0
    handles.head.rotation.z = gestureFrame.head.roll ?? 0
  } else {
    // State head motion is disabled during flight — would look
    // weird mid-arc. Eases to zero so arrival is smooth.
    const headPitchTarget = (!inFlight && s.head === 'nod') ? Math.sin(time * 5.5) * 0.22 : 0
    const headYawTarget = (!inFlight && s.head === 'shake') ? Math.sin(time * 6.0) * 0.28 : 0
    const headRollTarget = (!inFlight && s.head === 'tilt') ? Math.sin(time * 1.6) * 0.17 : 0
    anim.headPitch = lerp(anim.headPitch, headPitchTarget, 0.18)
    anim.headYaw = lerp(anim.headYaw, headYawTarget, 0.18)
    anim.headRoll = lerp(anim.headRoll, headRollTarget, 0.10)
    handles.head.rotation.x = anim.headPitch
    handles.head.rotation.y = anim.headYaw
    handles.head.rotation.z = anim.headRoll
  }

  // ── Pupil jitter ──────────────────────────────────────────────────
  // Reduced motion zeroes jitter even for high-jitter states
  // (CONFUSED, EXCITED, SURPRISED) — the rapid micro-shake reads as
  // an exact analogue to the kind of motion that triggers vestibular
  // discomfort in static UI text. The state still reads via lid
  // angle, sub-mode, head motion, and pupil color/size.
  const jitterAmt = reducedMotion ? 0 : s.pupilJitter
  if (jitterAmt > 0.01) {
    if (time >= anim.jitterNextTime) {
      const interval = 0.18 - jitterAmt * 0.13
      anim.jitterNextTime = time + interval * (0.6 + Math.random() * 0.8)
      const range = 0.006 * jitterAmt
      anim.jitterTargetX = (Math.random() - 0.5) * 2 * range
      anim.jitterTargetY = (Math.random() - 0.5) * 2 * range
    }
    anim.jitterX = lerp(anim.jitterX, anim.jitterTargetX, 0.35)
    anim.jitterY = lerp(anim.jitterY, anim.jitterTargetY, 0.35)
  } else {
    anim.jitterX = lerp(anim.jitterX, 0, 0.2)
    anim.jitterY = lerp(anim.jitterY, 0, 0.2)
  }
  // Gaze slides the whole pupil group (iris + pupil field + stars +
  // pupil dot + catchlights) within the static socket disc. Big
  // anime-style rigs track catchlights with the iris; small realistic
  // eyes would keep the catchlight on the cornea. Ours are anime,
  // so everything below the socket moves together. jitterScale
  // keeps the excursion inside the socket at any gaze angle.
  // Max pupil excursion within the socket. Safe ceiling is
  // (pupilFieldRadius − pupilDotRadius) = 0.0071. At sin(yaw) ≈ 1
  // and jitterScale 0.60, `gx = gazeRangeX * 0.60`, so the
  // practical cap on gazeRangeX is ~0.012. We leave a little slack
  // so jitter adds on top without the pupil escaping the navy field.
  const gazeRangeX = 0.018
  const gazeRangeY = 0.013
  const baseGazeX = Math.sin(anim.eyeYaw) * gazeRangeX
  const baseGazeY = -Math.sin(anim.eyePitch) * gazeRangeY
  for (const rig of handles.eyeRigs) {
    const gx = (baseGazeX + anim.jitterX) * rig.jitterScale
    const gy = (baseGazeY + anim.jitterY) * rig.jitterScale
    rig.pupilGroup.position.x = gx
    rig.pupilGroup.position.y = gy
  }

  // ── Sub-sphere positions (gesture overlay or sub-mode dispatch) ──
  // During flight, force sub-mode to 'orbit' — point/trace/cluster
  // look chaotic mid-arc.
  anim.orbitPhaseAccum += anim.orbitSpeed * dt
  const effSubMode = inFlight ? 'orbit' : s.subMode
  handles.subSpheres.forEach((sub, i) => {
    const r = anim.subRadius
    const pOff = sub.userData.phaseOffset as number
    const op = handles.head.position

    // Gesture overlay owns sub-sphere positions entirely when active.
    // Gesture positions are head-relative; they translate by Orbit's
    // world position so they follow the head through any motion.
    if (gestureFrame) {
      const gp = gestureFrame.subSpheres[i]
      sub.position.set(op.x + gp.x, op.y + gp.y, op.z + gp.z)
      return
    }

    let relX = 0, relY = 0, relZ = 0

    if (effSubMode === 'point') {
      if (i === 0) {
        // Sub 0 arcs from Orbit toward the active target and parks.
        const cycle = (time * 0.35) % 1
        let t = 0
        if (cycle < 0.25) t = cycle / 0.25
        else if (cycle < 0.65) t = 1.0
        else if (cycle < 0.90) t = 1.0 - (cycle - 0.65) / 0.25
        sub.position.copy(op).lerp(_tmpActiveTarget, t)
        return
      } else {
        // Sub 1 circles Orbit tightly while sub 0 does the pointing
        // reach. Radius is clamped to SUB_TIGHT_ORBIT_RADIUS so the
        // tight orbit stays OUTSIDE the body surface — earlier value
        // (0.06) put the sub inside the body volume for part of its
        // orbit, which got it occluded by the body / eye bezel when
        // it passed in front of the face.
        const phase = anim.orbitPhaseAccum * 1.8 + pOff
        const tight = SUB_TIGHT_ORBIT_RADIUS
        relX = Math.cos(phase) * tight
        relY = Math.sin(phase * 0.7) * tight * 0.3
        relZ = Math.sin(phase) * tight
      }
    } else if (effSubMode === 'trace') {
      if (i === 0) {
        // Lumpy oval around active target; scales with featureScale
        // so a continent on planetary-preset Earth gets a proportionally
        // larger trace than one on the tabletop.
        const tp = time * 0.85
        const lobe = 1.0 + Math.sin(tp * 3) * 0.35
        const rx = 0.055 * featureScale * lobe
        const ry = 0.030 * featureScale * (2.0 - lobe) * 0.6
        sub.position.set(
          _tmpActiveTarget.x + Math.cos(tp) * rx,
          _tmpActiveTarget.y + Math.sin(tp) * ry,
          _tmpActiveTarget.z + Math.sin(tp * 0.5) * 0.005 * featureScale,
        )
        return
      } else {
        // Sub 1 supports the trace with a tight companion orbit.
        // Same body-radius clamp as `point` submode — see comment
        // above.
        const phase = anim.orbitPhaseAccum * 1.0 + pOff
        const tight = SUB_TIGHT_ORBIT_RADIUS
        relX = Math.cos(phase) * tight
        relY = Math.sin(phase * 0.7) * tight * 0.3
        relZ = Math.sin(phase) * tight
      }
    } else if (effSubMode === 'figure8') {
      const dir = i === 0 ? 1 : -1
      const phase = anim.orbitPhaseAccum * 2.2 * dir + pOff
      const ct = Math.cos(phase), st = Math.sin(phase)
      const denom = 1 + st * st
      relX = r * 1.2 * ct / denom
      relY = Math.sin(phase * 2) * 0.004
      relZ = r * 1.8 * st * ct / denom
    } else if (effSubMode === 'burst') {
      const burst = (time * 1.3) % 1
      const pulse = burst < 0.3 ? burst / 0.3 : 1.0 - (burst - 0.3) / 0.7
      const pulsedR = r * (1.0 + pulse * 0.7)
      const phase = anim.orbitPhaseAccum * 1.4 + pOff
      relX = Math.cos(phase) * pulsedR
      relY = Math.sin(phase * 0.7) * pulsedR * 0.3
      relZ = Math.sin(phase) * pulsedR
    } else if (effSubMode === 'scatter') {
      const phase = anim.orbitPhaseAccum * 1.2 + pOff
      relX = Math.cos(phase) * r
      relY = Math.sin(phase * 0.7) * r * 0.3
      relZ = Math.sin(phase) * r
    } else if (effSubMode === 'listening') {
      const phase = anim.orbitPhaseAccum * 1.5 + pOff
      const baseX = (i === 0 ? -1 : 1) * 0.018
      relX = baseX + Math.sin(phase * 1.3) * 0.004
      relY = -0.010 + Math.cos(phase) * 0.003
      relZ = -0.080 + Math.sin(phase * 0.7) * 0.004
    } else if (effSubMode === 'cluster') {
      const phase = anim.orbitPhaseAccum + pOff
      const radius = r * 0.55
      relX = Math.cos(phase) * radius * 0.5
      relY = -Math.abs(Math.sin(phase * 0.5)) * radius * 0.8 - 0.025
      relZ = -Math.abs(Math.sin(phase)) * radius
    } else if (effSubMode === 'confused') {
      const pace = i === 0 ? 1.35 : 0.72
      const phase = anim.orbitPhaseAccum * pace + pOff
      const driftA = Math.sin(time * (i === 0 ? 0.4 : 0.55)) * 0.25
      const driftB = Math.cos(time * (i === 0 ? 0.28 : 0.47)) * 0.18
      relX = Math.cos(phase) * r * (1.0 + driftA)
      relY = Math.sin(phase * 1.3) * r * 0.35 + driftB * 0.025
      relZ = Math.sin(phase * 0.8) * r * 0.9
    } else if (effSubMode === 'nod') {
      const baseX = (i === 0 ? -1 : 1) * 0.055
      const phase = anim.orbitPhaseAccum * 0.3 + pOff
      relX = baseX + Math.sin(phase) * 0.003
      relY = Math.sin(time * 5.5) * 0.015
      relZ = Math.cos(phase) * 0.01
    } else if (effSubMode === 'shake') {
      const phaseY = (i === 0 ? -1 : 1) * 0.014
      relX = Math.sin(time * 6.0) * 0.050
      relY = phaseY
      relZ = 0.02
    } else {
      // orbit (default — vinyl redesign: two distinct crossing
      // ellipses via each sub's precomputed orbital basis). Tight,
      // steady orbits that read as "satellites" rather than swarm.
      // Orbit radius (SUB_ORBIT_RADIUS = 0.11) sits safely outside
      // BODY_RADIUS (0.075), so depth testing renders subs over the
      // face when they pass in front of the eyes without clipping
      // through the body.
      const basis = sub.userData.orbitBasis as { u: THREE.Vector3; v: THREE.Vector3 }
      const phase = anim.orbitPhaseAccum * 2 + pOff
      const cp = Math.cos(phase) * r
      const sp = Math.sin(phase) * r
      relX = basis.u.x * cp + basis.v.x * sp
      relY = basis.u.y * cp + basis.v.y * sp
      relZ = basis.u.z * cp + basis.v.z * sp
    }

    sub.position.set(op.x + relX, op.y + relY, op.z + relZ)
  })

  // ── Trails ────────────────────────────────────────────────────────
  // Must run after sub-sphere positions finalize so the rolling
  // buffer writes the actual current position, not last frame's.
  // Flight adds a 0.6 boost so the journey leaves a visible arc.
  // The long trail buffer naturally wraps into a sparkle ring during
  // steady idle orbit; breakaway sub-modes (point/trace/burst) show
  // the same buffer as a comet wake following the sub.
  updateTrails(
    handles.trails, handles.subSpheres,
    state, anim.activeGesture?.kind ?? null,
    palette, time, inFlight ? 0.6 : 0,
  )

  // ── Target marker (POINTING / PRESENTING) ────────────────────────
  const wantMarker = (state === 'POINTING' || state === 'PRESENTING') && !inFlight ? 1 : 0
  const markerBase = 0.55 + Math.sin(time * 3.0) * 0.15
  const haloBase = 0.35 + Math.sin(time * 2.0) * 0.20
  handles.targetMat.opacity = lerp(handles.targetMat.opacity, wantMarker * markerBase, 0.12)
  handles.targetHaloMat.opacity = lerp(handles.targetHaloMat.opacity, wantMarker * haloBase, 0.12)
  handles.targetMat.color.set(p.accent)
  handles.targetHaloMat.color.set(p.accent)
  // Halo scales gently for a "pulse" feel, and feature-scales at Earth.
  const haloScale = featureScale * (1.0 + Math.sin(time * 2.5) * 0.15)
  handles.targetHalo.scale.setScalar(haloScale)
  handles.targetMarker.scale.setScalar(featureScale)

  // ── Squash & stretch (body + satellite anthropomorphism) ─────────
  // Runs LAST so nothing overwrites the per-frame scale. Each term
  // is an orthogonal modifier — breathing is always on; the others
  // (melt, hop, smear, gasp, arrival, affirm) add to the base. Read
  // from `expressionFor(state)` so new states auto-inherit sane
  // defaults (see `docs/ORBIT_CHARACTER_VINYL_REDESIGN.md` §5).

  // Velocity vs. last frame — used by flight smear. Computed before
  // prevHeadPos is updated.
  const dx = handles.head.position.x - anim.prevHeadPos.x
  const dy = handles.head.position.y - anim.prevHeadPos.y
  const dz = handles.head.position.z - anim.prevHeadPos.z
  const speed = Math.sqrt(dx * dx + dy * dy + dz * dz) / Math.max(dt, 1e-4)
  anim.prevHeadPos.copy(handles.head.position)

  // State-entry detection for one-shot gasp. Reset inactive timers
  // when state changes away from their owners so re-entry re-fires.
  if (state !== anim.lastStateKey) {
    if (expr.surpriseGasp && state === 'SURPRISED') {
      anim.surpriseStart = time
    }
    anim.lastStateKey = state
  }
  // Arrival pulse: flight just ended this frame. 'rest'/'atEarth'
  // are the landing modes; we check whether the PREVIOUS frame was
  // mid-flight by observing `inFlight` above and the current `mode`.
  // Simpler: when `flight.mode` changes into a landed state AND we
  // had velocity last frame, trigger the pulse. Done below with
  // `mode` from updateFlight already computed above.
  if ((mode === 'rest' || mode === 'atEarth') && anim.arrivalSquashStart < 0 && speed > 0.8) {
    anim.arrivalSquashStart = time
  }

  // Breathing — the always-on base.
  const breathPhase = time * expr.breathRate * Math.PI * 2
  const yAmp = expr.breathAmp * Math.sin(breathPhase)
  const hopPhase = breathPhase * 2
  const hop = expr.hopAmp * Math.max(0, Math.sin(hopPhase))
  let targetSx = 1 + expr.meltXZ - yAmp * 0.3
  let targetSy = 1 + yAmp + hop
  let targetSz = 1 + expr.meltXZ - yAmp * 0.3

  // Flight smear — stretch along Z (approximate motion axis),
  // squash X/Y. Reduced motion dials it down to keep the frame
  // honest for vestibular-sensitive viewers.
  if (inFlight && !reducedMotion) {
    const k = Math.min(speed * 0.08, 0.28)
    targetSz *= 1 + k
    targetSx *= 1 - k * 0.5
    targetSy *= 1 - k * 0.5
  }

  // Arrival squash — brief flat pulse after landing.
  if (anim.arrivalSquashStart >= 0) {
    const tau = time - anim.arrivalSquashStart
    if (tau > 0.35) {
      anim.arrivalSquashStart = -1
    } else {
      const env = Math.exp(-10 * tau) * Math.sin(18 * tau)
      targetSy *= 1 - 0.08 * Math.max(0, env)
      targetSx *= 1 + 0.05 * Math.max(0, env)
      targetSz *= 1 + 0.05 * Math.max(0, env)
    }
  }

  // Surprise gasp — sharp stretch + damped spring back.
  if (anim.surpriseStart >= 0) {
    const tau = time - anim.surpriseStart
    if (tau > 1.2) {
      anim.surpriseStart = -1
    } else if (!reducedMotion) {
      const env = Math.exp(-5 * tau) * Math.cos(14 * tau)
      targetSy *= 1 + 0.12 * env
      targetSx *= 1 - 0.06 * env
      targetSz *= 1 - 0.06 * env
    }
  }

  // Affirm-nod weight — brief squash at the nod's low point.
  if (anim.activeGesture?.kind === 'affirm') {
    const gT = (time - anim.activeGesture.startTime) / GESTURES.affirm.duration
    if (gT > 0.45 && gT < 0.55) {
      targetSy *= 0.96
    }
  }

  anim.bodyScaleX = lerp(anim.bodyScaleX, targetSx, 0.25)
  anim.bodyScaleY = lerp(anim.bodyScaleY, targetSy, 0.25)
  anim.bodyScaleZ = lerp(anim.bodyScaleZ, targetSz, 0.25)
  handles.body.scale.set(anim.bodyScaleX, anim.bodyScaleY, anim.bodyScaleZ)

  // Satellite anthropomorphism — subs pulse with the TALKING voice.
  if (expr.talkPulse && !reducedMotion) {
    const subPulse = 1 + 0.15 * Math.sin(time * 9.0)
    for (const sub of handles.subSpheres) sub.scale.setScalar(subPulse)
  } else {
    for (const sub of handles.subSpheres) {
      sub.scale.setScalar(lerp(sub.scale.x, 1, 0.18))
    }
  }
}
