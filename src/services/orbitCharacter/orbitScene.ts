/**
 * Three.js scene + per-frame update for the Orbit character.
 *
 * Lifted from `docs/prototypes/orbit-prototype.jsx` after smart-quote
 * normalization. Preserves the nine-iteration tuning of orbit math,
 * pupil gaze, blink scheduling, and sub-mode dispatch. Phase 2 ships
 * the full STATES vocabulary; gestures (Phase 3), flight (Phase 4),
 * and palette system (Phase 5) come in subsequent commits.
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
  type BodyMaterialBundle,
  type EyeFieldMaterialBundle,
  type PupilMaterials,
} from './orbitMaterials'
import { PALETTES, type PaletteKey, type StateKey } from './orbitTypes'
import { STATES } from './orbitStates'
import { buildTrails, updateTrails, type TrailHandle } from './orbitTrails'

const BODY_RADIUS = 0.075
const SUB_RADIUS = 0.009
const SUB_ORBIT_RADIUS = 0.14
// Placeholder "feature" the camera/Orbit will eventually point + trace
// toward (in front of and slightly right of head). Phase 4 replaces
// this with a real Earth-surface target when flight lands.
const CHAT_FEATURE = new THREE.Vector3(0.32, -0.03, 0.02)

export interface OrbitSceneHandles {
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  head: THREE.Group
  body: THREE.Mesh
  bodyBundle: BodyMaterialBundle
  eyeGroup: THREE.Group
  eyeBundle: EyeFieldMaterialBundle
  pupil: THREE.Mesh
  pupilGlow: THREE.Mesh
  pupilMaterials: PupilMaterials
  subSpheres: THREE.Mesh[]
  trails: TrailHandle[]
}

export interface BuildSceneOptions {
  palette?: PaletteKey
  pixelRatio?: number
}

export function buildScene(options: BuildSceneOptions = {}): OrbitSceneHandles {
  const palette = options.palette ?? 'cyan'
  const pixelRatio = options.pixelRatio ?? (typeof window !== 'undefined' ? window.devicePixelRatio : 1)
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x060810)

  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 40)
  camera.position.set(0, 0, 1.1)
  camera.lookAt(0, 0, 0)

  scene.add(new THREE.AmbientLight(0xffffff, 0.35))
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.75)
  keyLight.position.set(0.6, 0.8, 0.5)
  scene.add(keyLight)
  const fillLight = new THREE.DirectionalLight(0x88aaff, 0.15)
  fillLight.position.set(-0.6, 0.3, 0.4)
  scene.add(fillLight)

  const head = new THREE.Group()
  scene.add(head)

  const bodyBundle = createBodyMaterial(palette)
  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(BODY_RADIUS, 4),
    bodyBundle.material,
  )
  head.add(body)

  const eyeGroup = new THREE.Group()
  head.add(eyeGroup)

  const eyeBundle = createEyeFieldMaterial(palette)
  const eyeDisc = new THREE.Mesh(
    new THREE.CircleGeometry(0.030, 64),
    eyeBundle.material,
  )
  eyeDisc.position.z = BODY_RADIUS + 0.0003
  eyeGroup.add(eyeDisc)

  const pupilMaterials = createPupilMaterials(palette)
  const pupilGlow = new THREE.Mesh(
    new THREE.CircleGeometry(0.014, 48),
    pupilMaterials.glowMat,
  )
  pupilGlow.position.z = BODY_RADIUS + 0.0005
  eyeGroup.add(pupilGlow)

  const pupil = new THREE.Mesh(
    new THREE.CircleGeometry(0.008, 48),
    pupilMaterials.pupilMat,
  )
  pupil.position.z = BODY_RADIUS + 0.0006
  eyeGroup.add(pupil)

  const subSpheres: THREE.Mesh[] = []
  for (let i = 0; i < 2; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTES[palette].accent),
    })
    const mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(SUB_RADIUS, 2),
      mat,
    )
    mesh.userData.phaseOffset = (i / 2) * Math.PI * 2
    scene.add(mesh)
    subSpheres.push(mesh)
  }

  const trails = buildTrails(scene, subSpheres, palette, pixelRatio)

  return {
    scene, camera, head, body, bodyBundle,
    eyeGroup, eyeBundle, pupil, pupilGlow, pupilMaterials,
    subSpheres, trails,
  }
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
  }
}

export interface UpdateInput {
  state: StateKey
  palette: PaletteKey
  time: number
  dt: number
  mouseX: number // [-1, 1] — normalized pointer x, used by CHATTING/TALKING gaze
  mouseY: number // [-1, 1]
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const sat = (x: number): number => Math.max(0, Math.min(1, x))

const _tmpTargetColor = new THREE.Color()
const _tmpStateColor = new THREE.Color()
const _tmpGazeDir = new THREE.Vector3()

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
  const { state, palette, time, dt, mouseX, mouseY } = input
  const s = STATES[state]
  const p = PALETTES[palette]

  // ── Palette propagation (body + eye-field + sub-spheres) ──────────
  handles.bodyBundle.uniforms.uBaseColor.value.set(p.base)
  handles.bodyBundle.uniforms.uAccentColor.value.set(p.accent)
  handles.bodyBundle.uniforms.uGlowColor.value.set(p.glow)
  handles.eyeBundle.uniforms.uBodyColor.value.set(p.base)
  handles.eyeBundle.uniforms.uBodyAccent.value.set(p.accent)
  handles.subSpheres.forEach((sub) => {
    const mat = sub.material as THREE.MeshBasicMaterial
    mat.color.set(p.accent)
  })
  handles.bodyBundle.uniforms.uTime.value = time

  // ── Eased "current" values ────────────────────────────────────────
  anim.orbitSpeed = lerp(anim.orbitSpeed, s.orbitSpeed, 0.04)
  const targetRadius = SUB_ORBIT_RADIUS * s.orbitRadiusScale
  anim.subRadius = lerp(anim.subRadius, targetRadius, 0.05)

  // ── Body sway (head position within head group) ───────────────────
  const sway = Math.sin(time * 0.7) * 0.004
  handles.body.position.y = sway
  handles.body.rotation.x = Math.sin(time * 0.5) * 0.05
  handles.body.rotation.z = Math.sin(time * 0.7) * 0.03

  // ── Pupil pulse (TALKING) + size ──────────────────────────────────
  const pulseMul = s.pupilPulse ? (Math.sin(time * 9.0) * 0.25 + 1.0) : 1.0
  const finalPupilBright = s.pupilBrightness * pulseMul
  const targetScale = s.pupilSize
  handles.pupil.scale.setScalar(lerp(handles.pupil.scale.x, targetScale, 0.15))
  handles.pupilGlow.scale.setScalar(handles.pupil.scale.x * 1.12)

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
  const effectiveUpper = Math.max(s.upperLid, blinkAmount)
  const effectiveLower = Math.max(s.lowerLid, blinkAmount * 0.35)
  handles.eyeBundle.uniforms.uUpperLid.value = effectiveUpper
  handles.eyeBundle.uniforms.uLowerLid.value = effectiveLower
  const coverByUpper = sat((effectiveUpper - 0.35) / 0.25)
  const coverByLower = sat((effectiveLower - 0.35) / 0.25)
  const pupilVis = 1 - Math.max(coverByUpper, coverByLower)

  // ── Pupil color blend ─────────────────────────────────────────────
  // Start from palette accent; blend 65% toward any state pupilColor
  // (SOLEMN, CONFUSED). Frame-to-frame easing keeps transitions soft.
  _tmpTargetColor.set(p.accent)
  if (s.pupilColor) {
    _tmpStateColor.set(s.pupilColor)
    _tmpTargetColor.lerp(_tmpStateColor, 0.65)
  }
  anim.currentPupilColor.lerp(_tmpTargetColor, 0.12)
  handles.pupilMaterials.pupilMat.color.copy(anim.currentPupilColor)
  handles.pupilMaterials.glowMat.color.copy(anim.currentPupilColor)
  handles.pupilMaterials.pupilMat.opacity = sat(finalPupilBright * pupilVis)
  handles.pupilMaterials.glowMat.opacity = sat(0.4 * finalPupilBright * pupilVis)

  // ── Eye gaze (state-specific) ─────────────────────────────────────
  let tYaw = 0, tPitch = 0
  switch (state) {
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
      _tmpGazeDir.subVectors(CHAT_FEATURE, handles.head.position).normalize()
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
  anim.eyeYaw = lerp(anim.eyeYaw, tYaw, 0.08)
  anim.eyePitch = lerp(anim.eyePitch, tPitch, 0.08)

  // ── Head motion (nod / shake / tilt per state) ────────────────────
  const headPitchTarget = s.head === 'nod' ? Math.sin(time * 5.5) * 0.22 : 0
  const headYawTarget = s.head === 'shake' ? Math.sin(time * 6.0) * 0.28 : 0
  const headRollTarget = s.head === 'tilt' ? Math.sin(time * 1.6) * 0.17 : 0
  anim.headPitch = lerp(anim.headPitch, headPitchTarget, 0.18)
  anim.headYaw = lerp(anim.headYaw, headYawTarget, 0.18)
  anim.headRoll = lerp(anim.headRoll, headRollTarget, 0.10)
  handles.head.rotation.x = anim.headPitch
  handles.head.rotation.y = anim.headYaw
  handles.head.rotation.z = anim.headRoll

  // ── Pupil jitter ──────────────────────────────────────────────────
  const jitterAmt = s.pupilJitter
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
  // Pupil slides within its disc — we move the pupil itself, not the
  // eye group. See prototype comment at lines 967-975.
  const gazeRangeX = 0.014
  const gazeRangeY = 0.010
  const baseGazeX = Math.sin(anim.eyeYaw) * gazeRangeX
  const baseGazeY = -Math.sin(anim.eyePitch) * gazeRangeY
  handles.pupil.position.x = baseGazeX + anim.jitterX
  handles.pupil.position.y = baseGazeY + anim.jitterY
  handles.pupilGlow.position.x = handles.pupil.position.x
  handles.pupilGlow.position.y = handles.pupil.position.y

  // ── Sub-sphere positions (sub-mode dispatch) ──────────────────────
  anim.orbitPhaseAccum += anim.orbitSpeed * dt
  const effSubMode = s.subMode
  handles.subSpheres.forEach((sub, i) => {
    const r = anim.subRadius
    const pOff = sub.userData.phaseOffset as number
    const op = handles.head.position

    let relX = 0, relY = 0, relZ = 0

    if (effSubMode === 'point') {
      if (i === 0) {
        // Sub 0 arcs from Orbit toward the active target and parks.
        const cycle = (time * 0.35) % 1
        let t = 0
        if (cycle < 0.25) t = cycle / 0.25
        else if (cycle < 0.65) t = 1.0
        else if (cycle < 0.90) t = 1.0 - (cycle - 0.65) / 0.25
        sub.position.copy(op).lerp(CHAT_FEATURE, t)
        return
      } else {
        const phase = anim.orbitPhaseAccum * 1.8 + pOff
        const tight = 0.06
        relX = Math.cos(phase) * tight
        relY = Math.sin(phase * 0.7) * tight * 0.3
        relZ = Math.sin(phase) * tight
      }
    } else if (effSubMode === 'trace') {
      if (i === 0) {
        const tp = time * 0.85
        const lobe = 1.0 + Math.sin(tp * 3) * 0.35
        const rx = 0.055 * lobe
        const ry = 0.030 * (2.0 - lobe) * 0.6
        sub.position.set(
          CHAT_FEATURE.x + Math.cos(tp) * rx,
          CHAT_FEATURE.y + Math.sin(tp) * ry,
          CHAT_FEATURE.z + Math.sin(tp * 0.5) * 0.005,
        )
        return
      } else {
        const phase = anim.orbitPhaseAccum * 1.0 + pOff
        const tight = 0.07
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
      // orbit (default)
      const phase = anim.orbitPhaseAccum * 2 + pOff
      relX = Math.cos(phase) * r
      relY = Math.sin(phase * 0.7) * r * 0.3
      relZ = Math.sin(phase) * r
    }

    sub.position.set(op.x + relX, op.y + relY, op.z + relZ)
  })

  // ── Trails ────────────────────────────────────────────────────────
  // Must run after sub-sphere positions finalize so the rolling
  // buffer writes the actual current position, not last frame's.
  updateTrails(handles.trails, handles.subSpheres, state, palette)
}
