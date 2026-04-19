import { useEffect, useRef, useState } from ‘react’
import * as THREE from ‘three’

const STATES = {
IDLE:       { label: ‘Idle’,       orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 1.00, pupilBrightness: 1.00, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: ‘orbit’,     trail: 0.00, head: ‘none’,  blinkInterval: 4.0, blinkDuration: 0.14 },
CHATTING:   { label: ‘Chatting’,   orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 1.20, pupilBrightness: 1.00, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: ‘orbit’,     trail: 0.00, head: ‘none’,  blinkInterval: 3.5, blinkDuration: 0.14 },
LISTENING:  { label: ‘Listening’,  orbitSpeed: 0.3,  orbitRadiusScale: 1.00, pupilSize: 1.15, pupilBrightness: 0.95, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: ‘listening’, trail: 0.00, head: ‘none’,  blinkInterval: 5.0, blinkDuration: 0.14 },
TALKING:    { label: ‘Talking’,    orbitSpeed: 1.2,  orbitRadiusScale: 1.00, pupilSize: 1.20, pupilBrightness: 1.00, pupilPulse: true,  pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.00, subMode: ‘figure8’,   trail: 0.55, head: ‘none’,  blinkInterval: 3.0, blinkDuration: 0.14 },
POINTING:   { label: ‘Pointing’,   orbitSpeed: 0.5,  orbitRadiusScale: 1.00, pupilSize: 0.90, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.22, lowerLid: 0.10, subMode: ‘point’,     trail: 1.00, head: ‘none’,  blinkInterval: 5.0, blinkDuration: 0.14 },
PRESENTING: { label: ‘Presenting’, orbitSpeed: 0.4,  orbitRadiusScale: 1.00, pupilSize: 0.95, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.15, lowerLid: 0.05, subMode: ‘trace’,     trail: 1.00, head: ‘none’,  blinkInterval: 4.0, blinkDuration: 0.14 },
THINKING:   { label: ‘Thinking’,   orbitSpeed: 0.2,  orbitRadiusScale: 0.70, pupilSize: 0.80, pupilBrightness: 0.80, pupilPulse: false, pupilJitter: 0.03, upperLid: 0.20, lowerLid: 0.05, subMode: ‘cluster’,   trail: 0.00, head: ‘none’,  blinkInterval: 3.0, blinkDuration: 0.16 },

CURIOUS:    { label: ‘Curious’,    orbitSpeed: 0.6,  orbitRadiusScale: 1.00, pupilSize: 1.35, pupilBrightness: 1.05, pupilPulse: false, pupilJitter: 0.05, upperLid: 0.00, lowerLid: 0.00, subMode: ‘orbit’,     trail: 0.30, head: ‘none’,  blinkInterval: 3.0, blinkDuration: 0.14 },
HAPPY:      { label: ‘Happy’,      orbitSpeed: 0.9,  orbitRadiusScale: 1.05, pupilSize: 1.10, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.06, lowerLid: 0.48, subMode: ‘orbit’,     trail: 0.35, head: ‘none’,  blinkInterval: 2.5, blinkDuration: 0.14 },
EXCITED:    { label: ‘Excited’,    orbitSpeed: 2.5,  orbitRadiusScale: 1.30, pupilSize: 1.30, pupilBrightness: 1.20, pupilPulse: false, pupilJitter: 0.35, upperLid: 0.00, lowerLid: 0.00, subMode: ‘burst’,     trail: 0.70, head: ‘none’,  blinkInterval: 4.0, blinkDuration: 0.11 },
SURPRISED:  { label: ‘Surprised’,  orbitSpeed: 0.2,  orbitRadiusScale: 1.30, pupilSize: 0.55, pupilBrightness: 1.30, pupilPulse: false, pupilJitter: 0.55, upperLid: 0.00, lowerLid: 0.00, subMode: ‘scatter’,   trail: 0.00, head: ‘none’,  blinkInterval: 0,   blinkDuration: 0 },
SLEEPY:     { label: ‘Sleepy’,     orbitSpeed: 0.15, orbitRadiusScale: 0.80, pupilSize: 0.70, pupilBrightness: 0.45, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.56, lowerLid: 0.18, subMode: ‘cluster’,   trail: 0.00, head: ‘none’,  blinkInterval: 1.5, blinkDuration: 0.38 },
SOLEMN:     { label: ‘Solemn’,     orbitSpeed: 0.22, orbitRadiusScale: 0.82, pupilSize: 0.85, pupilBrightness: 0.60, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.24, lowerLid: 0.08, subMode: ‘cluster’,   trail: 0.00, head: ‘none’,  blinkInterval: 4.5, blinkDuration: 0.22, pupilColor: ‘#7db5e8’ },
CONFUSED:   { label: ‘Confused’,   orbitSpeed: 0.35, orbitRadiusScale: 1.10, pupilSize: 0.95, pupilBrightness: 0.90, pupilPulse: false, pupilJitter: 0.40, upperLid: 0.08, lowerLid: 0.12, subMode: ‘confused’,  trail: 0.00, head: ‘tilt’,  blinkInterval: 3.2, blinkDuration: 0.18, pupilColor: ‘#d9a85c’ },

YES:        { label: ‘Yes’,        orbitSpeed: 0.5,  orbitRadiusScale: 0.75, pupilSize: 1.10, pupilBrightness: 1.10, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.00, lowerLid: 0.22, subMode: ‘nod’,       trail: 0.00, head: ‘nod’,   blinkInterval: 3.0, blinkDuration: 0.14 },
NO:         { label: ‘No’,         orbitSpeed: 0.5,  orbitRadiusScale: 0.75, pupilSize: 0.90, pupilBrightness: 0.95, pupilPulse: false, pupilJitter: 0.00, upperLid: 0.15, lowerLid: 0.00, subMode: ‘shake’,     trail: 0.00, head: ‘shake’, blinkInterval: 3.0, blinkDuration: 0.14 },
}

const BEHAVIOR_STATES = [‘IDLE’, ‘CHATTING’, ‘LISTENING’, ‘TALKING’, ‘POINTING’, ‘PRESENTING’, ‘THINKING’]
const EMOTION_STATES  = [‘CURIOUS’, ‘HAPPY’, ‘EXCITED’, ‘SURPRISED’, ‘SLEEPY’, ‘SOLEMN’, ‘CONFUSED’]
const GESTURE_STATES  = [‘YES’, ‘NO’]

const PALETTES = {
cyan:   { base: ‘#faf5e8’, accent: ‘#5cefd7’, glow: ‘#a8f5e5’ },
green:  { base: ‘#faf5e8’, accent: ‘#7eef5c’, glow: ‘#b5f5a0’ },
amber:  { base: ‘#fff5e0’, accent: ‘#efb75c’, glow: ‘#f5d8a0’ },
violet: { base: ‘#f5f0fa’, accent: ‘#b87cef’, glow: ‘#d4b0f5’ },
}

const TRAIL_LENGTH = 42

// –– Gesture overlays ——————————————————
// Gestures are transient animations that play OVER whatever state is active,
// then yield control back. Each gesture is defined by a compute function that
// returns sub-sphere positions (head-relative) and optional head rotation for
// a normalized t in [0, 1]. Shape of t over duration:
//   [0, 0.25]  entry — sub-spheres move from neutral to gesture pose
//   [0.25, 0.75]  held — peak gesture shape, may include sub-motion (wave/beckon)
//   [0.75, 1.0]  exit — return to neutral, state resumes
// Designed so t=0 and t=1 roughly match the neutral orbit position, minimizing
// snap when state control resumes.
const smoothstep01 = (x) => { const c = Math.max(0, Math.min(1, x)); return c * c * (3 - 2 * c) }
const GESTURES = {
shrug: {
label: ‘Shrug’,
duration: 1.4,
compute: (t, _ctx) => {
// “I don’t know” — both sub-spheres rise and spread wide, head tilts
// back slightly, subtle side-to-side sway during the held phase.
const r = 0.14
let spread, lift
if (t < 0.25) {
const e = smoothstep01(t / 0.25)
spread = r * (1.0 + 0.7 * e); lift = 0.07 * e
} else if (t < 0.75) {
spread = r * 1.7; lift = 0.07
} else {
const e = smoothstep01((1.0 - t) / 0.25)
spread = r * (1.0 + 0.7 * e); lift = 0.07 * e
}
// peak envelope for head motion (gentle rise then fall)
const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
const headPitch = -0.14 * peak               // chin up (uncertain look)
const headYaw   = Math.sin(t * Math.PI * 1.8) * 0.08 * peak // slight sway
return {
subSpheres: [
{ x:  spread, y: lift, z: 0 },
{ x: -spread, y: lift, z: 0 },
],
head: { pitch: headPitch, yaw: headYaw },
}
},
},
wave: {
label: ‘Wave’,
duration: 1.8,
compute: (t, _ctx) => {
// One sub-sphere swings side-to-side (waving hand); other tucks close.
const r = 0.14
const peak = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
const swing = Math.sin(t * Math.PI * 4) // two full cycles
const waveY = r * 0.55 + 0.02 * peak         // raised up
const waveX = r * 0.7 + swing * 0.08 * peak  // horizontal swing
return {
subSpheres: [
{ x:  waveX, y: waveY, z: 0.02 * peak }, // waving
{ x: -r * 0.5, y: -r * 0.2, z: -0.01 },  // tucked lower-left
],
}
},
},
beckon: {
label: ‘Beckon’,
duration: 1.6,
// Directional: extending sub-sphere reaches toward whatever activeTarget
// is current (CHAT_FEATURE at chat, EARTH_FEATURE at Earth). Orbit’s head
// turns slightly toward the target. Pairs with Pointing/Presenting:
// Point shows WHERE; Beckon says “come toward THERE.”
compute: (t, ctx) => {
const r = 0.14
const peak  = Math.sin(smoothstep01((t - 0.05) / 0.9) * Math.PI)
const cycle = Math.sin(t * Math.PI * 2) // one in-out arc
const dir   = ctx.direction             // unit vector head → target (world)
// Extending sub — reaches in the target direction, rhythmically retracts
const extBase  = 0.09
const extPulse = (0.5 + 0.5 * cycle) * 0.10
const extDist  = (extBase + extPulse) * peak
// Reference sub — tucks on the opposite side as a visual counterweight
const refDist = r * 0.55
return {
subSpheres: [
{ x: -dir.x * refDist,           y: -dir.y * refDist + 0.01,         z: -dir.z * refDist },
{ x:  dir.x * extDist,           y:  dir.y * extDist + 0.02 * peak,  z:  dir.z * extDist },
],
head: {
// Subtle turn toward target (≤ ~12°)
pitch: -dir.y * 0.10 * peak,
yaw:   Math.atan2(dir.x, -dir.z) * 0.22 * peak,
},
}
},
},
affirm: {
label: ‘Affirm’,
duration: 0.9,
compute: (t, _ctx) => {
// Quiet “mm-hm” — a single small nod paired with a gold pupil flash.
// Smaller motion than YES state; meant as transient acknowledgment
// during Listening or Chatting, not a committed yes.
const r = 0.14
const nod = Math.sin(t * Math.PI) * 0.14  // 0 → peak → 0 over duration
// Flash envelope: fast rise, held, faster decay
const flash = t < 0.35 ? smoothstep01(t / 0.35)
: t < 0.65 ? 1.0
: smoothstep01((1.0 - t) / 0.35)
return {
subSpheres: [
{ x:  r * 0.92, y: -nod * 0.05, z: 0 },
{ x: -r * 0.92, y: -nod * 0.05, z: 0 },
],
head: { pitch: nod },                         // gentle downward nod
pupilColor: ‘#efc85c’,                        // warm gold
pupilFlash: flash,
}
},
},
}
const GESTURE_KEYS = [‘shrug’, ‘wave’, ‘beckon’, ‘affirm’]

// –– Scale presets ———————————————————
// Close: v4 preserved. Earth 22cm radius. Tabletop scale.
// Continental: Earth 5x bigger, camera pulls back. Orbit arrives ~country-sized.
// Planetary: Earth 18x bigger, camera further back. Orbit arrives ~0.7° of arc —
// a speck on a world. That’s the visceral “lastly smaller” lesson.
// Camera pulls back at far presets because a 2D screen can’t replicate a VR
// headset’s wide FOV; pulling back approximates the VR-room feel.
const SCALE_PRESETS = {
close: {
label: ‘Close’,
tag: ‘a tabletop planet beside a companion’,
earthRadius: 0.22,
earthCenter: [0.38, -0.01, -0.60],
cameraPos: [0, 0.02, 0.45],
cameraTarget: [0.14, -0.02, -0.28],
fov: 38,
flightOut: 4.2, flightBack: 3.4, arcHeight: 0.09,
},
continental: {
label: ‘Continental’,
tag: ‘Orbit shrinks to a state beside a continent’,
earthRadius: 1.1,
earthCenter: [1.9, -0.08, -3.0],
cameraPos: [0, 0.03, 1.2],
cameraTarget: [0.9, -0.05, -1.7],
fov: 42,
flightOut: 6.5, flightBack: 5.0, arcHeight: 0.55,
},
planetary: {
label: ‘Planetary’,
tag: ‘Orbit shrinks to a speck beside a world’,
earthRadius: 4.0,
earthCenter: [5.0, -0.30, -10.0],
cameraPos: [0, 0.04, 2.5],
cameraTarget: [2.3, -0.15, -4.8],
fov: 45,
flightOut: 10.5, flightBack: 7.8, arcHeight: 1.6,
},
}
const PRESET_KEYS = [‘close’, ‘continental’, ‘planetary’]

// Orbit’s chat rest position (at user’s arm-length) — same across presets
const CHAT_POS     = new THREE.Vector3(0, 0, 0)
// Chat-distance feature (indicable when Orbit is at chat distance)
const CHAT_FEATURE = new THREE.Vector3(0.32, -0.03, 0.02)

// Parking + feature directions from Earth center (fixed relative to Earth
// so the hit-point lands in the same relative spot at every scale)
const PARKING_DIR = new THREE.Vector3(-0.55, -0.18, 0.82).normalize()
const FEATURE_DIR = new THREE.Vector3(-0.12, 0.10, 0.99).normalize()

const arr3 = (v) => new THREE.Vector3(v[0], v[1], v[2])
const parkingOf = (p) => {
const off = Math.max(0.09, 0.02 * p.earthRadius)
return arr3(p.earthCenter).add(PARKING_DIR.clone().multiplyScalar(p.earthRadius + off))
}
const featureOf = (p) => {
const off = Math.max(0.005, 0.003 * p.earthRadius)
return arr3(p.earthCenter).add(FEATURE_DIR.clone().multiplyScalar(p.earthRadius + off))
}

export default function OrbitPrototype() {
const mountRef = useRef(null)

const [stateKey, setStateKey] = useState(‘IDLE’)
const [paletteKey, setPaletteKey] = useState(‘cyan’)
const [presetKey, setPresetKey] = useState(‘close’)
const [eyeMode, setEyeMode] = useState(‘one’) // ‘one’ | ‘two’ — A/B design test
const [bodyRadius, setBodyRadius] = useState(0.075)
const [orbitRadius, setOrbitRadius] = useState(0.14)
const [flightMode, setFlightMode] = useState(‘rest’) // rest | out | atEarth | back

const [upperLid, setUpperLid]                 = useState(STATES.IDLE.upperLid)
const [lowerLid, setLowerLid]                 = useState(STATES.IDLE.lowerLid)
const [pupilSize, setPupilSize]               = useState(STATES.IDLE.pupilSize)
const [pupilBrightness, setPupilBrightness]   = useState(STATES.IDLE.pupilBrightness)
const [jitter, setJitter]                     = useState(STATES.IDLE.pupilJitter)
const [trailStrength, setTrailStrength]       = useState(STATES.IDLE.trail)
const [blinkTriggerCount, setBlinkTriggerCount] = useState(0)

const stateRef           = useRef(stateKey)
const paletteRef         = useRef(paletteKey)
const presetKeyRef       = useRef(presetKey)
const eyeModeRef         = useRef(eyeMode)
const bodyRadiusRef      = useRef(bodyRadius)
const orbitRadiusRef     = useRef(orbitRadius)
const upperLidRef        = useRef(upperLid)
const lowerLidRef        = useRef(lowerLid)
const pupilSizeRef       = useRef(pupilSize)
const pupilBrightnessRef = useRef(pupilBrightness)
const jitterRef          = useRef(jitter)
const trailStrengthRef   = useRef(trailStrength)
const blinkTriggerRef    = useRef(blinkTriggerCount)
const mouseRef           = useRef(new THREE.Vector2(0, 0))

// Flight refs (updated by button handlers, read by animation loop)
const flightModeRef      = useRef(‘rest’)
const flightStartTimeRef = useRef(0)
const flightDurationRef  = useRef(4.2)
const flightArcHeightRef = useRef(0.09)
const flightStartPosRef  = useRef(new THREE.Vector3().copy(CHAT_POS))
const flightEndPosRef    = useRef(parkingOf(SCALE_PRESETS.close))
const orbitRestPosRef    = useRef(new THREE.Vector3().copy(CHAT_POS)) // where Orbit is when not flying
const timeRef            = useRef(0)

// Active gesture overlay (null when none playing)
const activeGestureRef   = useRef(null) // { kind, startTime, duration } | null
const [gestureVersion, setGestureVersion] = useState(0) // for UI disabling

useEffect(() => { stateRef.current = stateKey },                      [stateKey])
useEffect(() => { paletteRef.current = paletteKey },                  [paletteKey])
useEffect(() => { presetKeyRef.current = presetKey },                 [presetKey])
useEffect(() => { eyeModeRef.current = eyeMode },                     [eyeMode])
useEffect(() => { bodyRadiusRef.current = bodyRadius },               [bodyRadius])
useEffect(() => { orbitRadiusRef.current = orbitRadius },             [orbitRadius])
useEffect(() => { upperLidRef.current = upperLid },                   [upperLid])
useEffect(() => { lowerLidRef.current = lowerLid },                   [lowerLid])
useEffect(() => { pupilSizeRef.current = pupilSize },                 [pupilSize])
useEffect(() => { pupilBrightnessRef.current = pupilBrightness },     [pupilBrightness])
useEffect(() => { jitterRef.current = jitter },                       [jitter])
useEffect(() => { trailStrengthRef.current = trailStrength },         [trailStrength])
useEffect(() => { blinkTriggerRef.current = blinkTriggerCount },      [blinkTriggerCount])
useEffect(() => { flightModeRef.current = flightMode },               [flightMode])

useEffect(() => {
const s = STATES[stateKey]
setUpperLid(s.upperLid)
setLowerLid(s.lowerLid)
setPupilSize(s.pupilSize)
setPupilBrightness(s.pupilBrightness)
setJitter(s.pupilJitter)
setTrailStrength(s.trail)
}, [stateKey])

// –– Flight handlers —————————————————
const flyToEarth = () => {
if (flightMode === ‘out’ || flightMode === ‘back’) return
const p = SCALE_PRESETS[presetKey]
flightStartPosRef.current.copy(orbitRestPosRef.current)
flightEndPosRef.current.copy(parkingOf(p))
flightDurationRef.current  = p.flightOut
flightArcHeightRef.current = p.arcHeight
flightStartTimeRef.current = timeRef.current
setFlightMode(‘out’)
}
const flyHome = () => {
if (flightMode === ‘out’ || flightMode === ‘back’) return
const p = SCALE_PRESETS[presetKey]
flightStartPosRef.current.copy(orbitRestPosRef.current)
flightEndPosRef.current.copy(CHAT_POS)
flightDurationRef.current  = p.flightBack
flightArcHeightRef.current = p.arcHeight
flightStartTimeRef.current = timeRef.current
setFlightMode(‘back’)
}
const changePreset = (k) => {
if (flightMode === ‘out’ || flightMode === ‘back’) return
setFlightMode(‘rest’) // also cancels atEarth — Orbit must reset on scale change
setPresetKey(k)
}
const playGesture = (kind) => {
if (flightMode === ‘out’ || flightMode === ‘back’) return
if (activeGestureRef.current) return // one at a time
activeGestureRef.current = {
kind,
startTime: timeRef.current,
duration: GESTURES[kind].duration,
}
setGestureVersion((v) => v + 1) // trigger UI re-render for button disable
}

useEffect(() => {
const mount = mountRef.current
if (!mount) return

```
let width = mount.clientWidth
let height = mount.clientHeight

const initial = SCALE_PRESETS.close

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x060810)

// Camera framed per preset. Close keeps v4's intimate framing; far presets
// pull back so both Orbit and Earth fit on a 2D screen.
const camera = new THREE.PerspectiveCamera(initial.fov, width / height, 0.05, 40)
camera.position.fromArray(initial.cameraPos)
camera.lookAt(arr3(initial.cameraTarget))

const renderer = new THREE.WebGLRenderer({ antialias: true })
const pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
renderer.setSize(width, height)
renderer.setPixelRatio(pixelRatio)
mount.appendChild(renderer.domElement)

scene.add(new THREE.AmbientLight(0xffffff, 0.35))
const keyLight = new THREE.DirectionalLight(0xffffff, 0.75)
keyLight.position.set(0.6, 0.8, 0.5)
scene.add(keyLight)
const fillLight = new THREE.DirectionalLight(0x88aaff, 0.15)
fillLight.position.set(-0.6, 0.3, 0.4)
scene.add(fillLight)

// ---- Earth ------------------------------------------------------------
// Procedural continent shader (no textures — keeps the artifact
// self-contained). fBm-ish noise via layered sin/cos gives readable
// continent-like blobs. Not Earth-accurate, but "this is a planet".
const earthMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime: { value: 0 },
    uLightDir: { value: new THREE.Vector3(0.6, 0.8, 0.5).normalize() },
  },
  vertexShader: `
    varying vec3 vNormalW;
    varying vec3 vPosW;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vPosW = worldPos.xyz;
      vNormalW = normalize(mat3(modelMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }
  `,
  fragmentShader: `
    varying vec3 vNormalW;
    varying vec3 vPosW;
    uniform float uTime;
    uniform vec3 uLightDir;

    float pseudo3(vec3 p) {
      // Layered sin-based pseudo-noise; cheap and readable on Quest
      float a = sin(p.x * 5.3 + 1.2) * cos(p.y * 4.1 - 0.7) * sin(p.z * 3.7 + 0.4);
      float b = sin(p.x * 9.7 + 2.4) * cos(p.y * 8.3 + 1.3) * sin(p.z * 7.5 - 0.9) * 0.55;
      float c = sin(p.x * 17.1 + 4.5) * cos(p.y * 15.2 + 2.1) * sin(p.z * 13.4 + 1.6) * 0.30;
      float d = sin(p.x * 31.3 + 0.2) * cos(p.y * 27.9 + 3.2) * 0.15;
      return a + b + c + d;
    }

    void main() {
      vec3 n = normalize(vNormalW);

      float land = pseudo3(n * 1.6);
      float isLand = smoothstep(0.05, 0.22, land);

      // Colors
      vec3 deepOcean   = vec3(0.03, 0.06, 0.13);
      vec3 shallowSea  = vec3(0.06, 0.14, 0.22);
      vec3 coast       = vec3(0.14, 0.22, 0.18);
      vec3 forest      = vec3(0.13, 0.22, 0.10);
      vec3 savanna     = vec3(0.32, 0.28, 0.14);
      vec3 desert      = vec3(0.42, 0.35, 0.20);

      // Ocean variation (shallower near land)
      float shallow = smoothstep(-0.1, 0.1, land);
      vec3 oceanCol = mix(deepOcean, shallowSea, shallow);

      // Land variation
      float variation = pseudo3(n * 4.5) * 0.5 + 0.5;
      vec3 landCol = mix(forest, savanna, variation);
      landCol = mix(landCol, desert, smoothstep(0.6, 0.9, variation) * 0.55);

      // Coastline blend
      float coastBlend = smoothstep(0.04, 0.18, land) * (1.0 - smoothstep(0.18, 0.28, land));
      landCol = mix(landCol, coast, coastBlend * 0.4);

      vec3 color = mix(oceanCol, landCol, isLand);

      // Polar ice
      float iceBlend = smoothstep(0.78, 0.90, abs(n.y));
      color = mix(color, vec3(0.82, 0.88, 0.92), iceBlend);

      // Lambert lighting
      float diff = max(0.18, dot(n, normalize(uLightDir)));
      color *= diff;

      // Atmosphere rim — fresnel from view direction
      vec3 viewDir = normalize(cameraPosition - vPosW);
      float fres = pow(1.0 - max(0.0, dot(n, viewDir)), 3.0);
      color += vec3(0.25, 0.45, 0.70) * fres * 0.35;

      gl_FragColor = vec4(color, 1.0);
    }
  `,
})
const earth = new THREE.Mesh(
  new THREE.IcosahedronGeometry(initial.earthRadius, 5),
  earthMat,
)
earth.position.fromArray(initial.earthCenter)
scene.add(earth)

// Preset state captured in the scene closure. Animation loop detects
// changes to presetKeyRef and calls applyPreset to mutate the scene.
let appliedPreset = 'close'
let parkingSpot   = parkingOf(initial)
let earthFeature  = featureOf(initial)
let currentPreset = initial

const applyPreset = (key) => {
  const pp = SCALE_PRESETS[key]
  earth.geometry.dispose()
  earth.geometry = new THREE.IcosahedronGeometry(pp.earthRadius, 5)
  earth.position.fromArray(pp.earthCenter)
  camera.position.fromArray(pp.cameraPos)
  camera.lookAt(arr3(pp.cameraTarget))
  camera.fov = pp.fov
  camera.updateProjectionMatrix()
  parkingSpot   = parkingOf(pp)
  earthFeature  = featureOf(pp)
  currentPreset = pp
  flightModeRef.current = 'rest'
  orbitRestPosRef.current.copy(CHAT_POS)
}

// ---- Head group (body + eye) -----------------------------------------
const head = new THREE.Group()
scene.add(head)

const bodyUniforms = {
  uTime: { value: 0 },
  uBaseColor: { value: new THREE.Color(PALETTES.cyan.base) },
  uAccentColor: { value: new THREE.Color(PALETTES.cyan.accent) },
  uGlowColor: { value: new THREE.Color(PALETTES.cyan.glow) },
}
const bodyMaterial = new THREE.ShaderMaterial({
  uniforms: bodyUniforms,
  vertexShader: `
    varying vec3 vNormal; varying vec3 vViewDir;
    void main() {
      vec4 worldPos = modelMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vViewDir = normalize(cameraPosition - worldPos.xyz);
      gl_Position = projectionMatrix * viewMatrix * worldPos;
    }`,
  fragmentShader: `
    uniform vec3 uBaseColor; uniform vec3 uAccentColor; uniform vec3 uGlowColor;
    uniform float uTime;
    varying vec3 vNormal; varying vec3 vViewDir;
    void main() {
      float ndotv = max(0.0, dot(normalize(vNormal), normalize(vViewDir)));
      float fresnel = pow(1.0 - ndotv, 2.5);
      vec3 color = mix(uBaseColor, uAccentColor, fresnel);
      float halo = pow(fresnel, 6.0);
      color += uGlowColor * halo * 0.6;
      float shift = sin(fresnel * 8.0 + uTime * 0.4) * 0.04;
      color += vec3(shift, shift * 0.3, -shift * 0.5);
      gl_FragColor = vec4(color, 1.0);
    }`,
})
const body = new THREE.Mesh(new THREE.IcosahedronGeometry(bodyRadius, 4), bodyMaterial)
head.add(body)

const eyeGroup = new THREE.Group()
head.add(eyeGroup)

const eyeFieldUniforms = {
  uUpperLid: { value: 0 }, uLowerLid: { value: 0 },
  uBodyColor:  { value: new THREE.Color(PALETTES.cyan.base) },
  uBodyAccent: { value: new THREE.Color(PALETTES.cyan.accent) },
  uEyeColor:   { value: new THREE.Color(0x060810) },
  uRimColor:   { value: new THREE.Color(0x1a1c25) },
}
const eyeFieldMaterial = new THREE.ShaderMaterial({
  uniforms: eyeFieldUniforms,
  transparent: true,
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    varying vec2 vUv;
    uniform float uUpperLid; uniform float uLowerLid;
    uniform vec3 uBodyColor; uniform vec3 uBodyAccent;
    uniform vec3 uEyeColor; uniform vec3 uRimColor;
    void main() {
      vec2 c = vUv - vec2(0.5);
      float dist = length(c);
      float eyeMask = 1.0 - smoothstep(0.48, 0.50, dist);
      if (eyeMask < 0.01) discard;
      float rimFactor = smoothstep(0.36, 0.48, dist);
      float y = c.y + 0.5;
      float upperCov = smoothstep(1.0 - uUpperLid - 0.04, 1.0 - uUpperLid + 0.04, y);
      float lowerCov = 1.0 - smoothstep(uLowerLid - 0.04, uLowerLid + 0.04, y);
      float covered = max(upperCov, lowerCov);
      float crease = 1.0 - abs(y - (1.0 - uUpperLid)) * 6.0;
      crease = max(crease, 1.0 - abs(y - uLowerLid) * 6.0);
      crease = clamp(crease, 0.0, 1.0) * covered;
      vec3 lidColor = mix(uBodyColor, uBodyAccent, crease * 0.25);
      vec3 baseColor = mix(uEyeColor, uRimColor, rimFactor);
      vec3 color = mix(baseColor, lidColor, covered);
      gl_FragColor = vec4(color, eyeMask);
    }`,
})
const eyeDisc = new THREE.Mesh(new THREE.CircleGeometry(0.030, 64), eyeFieldMaterial)
eyeDisc.position.z = bodyRadius + 0.0003
eyeGroup.add(eyeDisc)

const pupilGlowMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(PALETTES.cyan.accent),
  transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending,
})
const pupilGlow = new THREE.Mesh(new THREE.CircleGeometry(0.014, 48), pupilGlowMat)
pupilGlow.position.z = bodyRadius + 0.0005
eyeGroup.add(pupilGlow)

const pupilMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(PALETTES.cyan.accent),
  transparent: true,
})
const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.008, 48), pupilMat)
pupil.position.z = bodyRadius + 0.0006
eyeGroup.add(pupil)

// ---- Two-eye configuration (pair, ~28mm each) ----------------------
// More mammalian, enables vergence. Each eye has its own Group offset
// horizontally from head center so gaze rotation happens around each
// eye's own pivot (not around head center like the single eye).
// Sizing: disc radius 14mm, centers 22mm off-axis. Keeps 16mm gap
// between inner edges so they don't fight for pixels.
const TWO_EYE_OFFSET = 0.022
const makeSubEye = (xOffset) => {
  const g = new THREE.Group()
  g.position.set(xOffset, 0, 0)
  head.add(g)
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.014, 48), eyeFieldMaterial)
  disc.position.z = bodyRadius + 0.0003
  g.add(disc)
  const glow = new THREE.Mesh(new THREE.CircleGeometry(0.0065, 32), pupilGlowMat)
  glow.position.z = bodyRadius + 0.0005
  g.add(glow)
  const pp = new THREE.Mesh(new THREE.CircleGeometry(0.0040, 32), pupilMat)
  pp.position.z = bodyRadius + 0.0006
  g.add(pp)
  return { group: g, disc, glow, pupil: pp }
}
const eyeLeft  = makeSubEye(-TWO_EYE_OFFSET)
const eyeRight = makeSubEye( TWO_EYE_OFFSET)

// Array of all eye components for unified per-frame updates.
// jitterScale compensates for the smaller pair — same pupilJitter input
// looks right on both configurations.
const allEyes = [
  { group: eyeGroup,       disc: eyeDisc,       glow: pupilGlow,     pupil,                 jitterScale: 1.0  },
  { group: eyeLeft.group,  disc: eyeLeft.disc,  glow: eyeLeft.glow,  pupil: eyeLeft.pupil,  jitterScale: 0.47 },
  { group: eyeRight.group, disc: eyeRight.disc, glow: eyeRight.glow, pupil: eyeRight.pupil, jitterScale: 0.47 },
]

// Initial visibility (re-set every frame from eyeModeRef)
eyeGroup.visible = (eyeMode === 'one')
eyeLeft.group.visible  = (eyeMode === 'two')
eyeRight.group.visible = (eyeMode === 'two')

// ---- Sub-spheres ------------------------------------------------------
const subMats = []
const subSpheres = []
for (let i = 0; i < 2; i++) {
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTES.cyan.accent) })
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.009, 2), mat)
  mesh.userData.phaseOffset = (i / 2) * Math.PI * 2
  subMats.push(mat)
  subSpheres.push(mesh)
  scene.add(mesh)
}

// ---- Trails -----------------------------------------------------------
const trails = subSpheres.map((sub) => {
  const positions = new Float32Array(TRAIL_LENGTH * 3)
  const sizes     = new Float32Array(TRAIL_LENGTH)
  const alphas    = new Float32Array(TRAIL_LENGTH)
  for (let j = 0; j < TRAIL_LENGTH; j++) {
    positions[j * 3] = sub.position.x
    positions[j * 3 + 1] = sub.position.y
    positions[j * 3 + 2] = sub.position.z
    const t = 1 - j / TRAIL_LENGTH
    alphas[j] = t
    sizes[j]  = 4 + t * 16
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('size',     new THREE.BufferAttribute(sizes, 1))
  geom.setAttribute('alpha',    new THREE.BufferAttribute(alphas, 1))
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(PALETTES.cyan.accent) },
      uIntensity: { value: 0 },
      uPixelRatio: { value: pixelRatio },
    },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size; attribute float alpha;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * uPixelRatio * (0.35 / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; uniform float uIntensity;
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = length(c);
        if (d > 0.5) discard;
        float fade = 1.0 - smoothstep(0.0, 0.5, d);
        fade = pow(fade, 1.5);
        float a = vAlpha * uIntensity * fade;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
  })
  const points = new THREE.Points(geom, mat)
  scene.add(points)
  return { positions, geom, mat, points, currentIntensity: 0 }
})

// ---- Target marker (pulses at active trace/point target) -------------
const targetMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(PALETTES.cyan.accent),
  transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
})
const targetMarker = new THREE.Mesh(new THREE.SphereGeometry(0.0035, 16, 12), targetMat)
scene.add(targetMarker)

const targetHaloMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(PALETTES.cyan.accent),
  transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
})
const targetHalo = new THREE.Mesh(new THREE.CircleGeometry(0.012, 32), targetHaloMat)
scene.add(targetHalo)

const onPointerMove = (e) => {
  const rect = renderer.domElement.getBoundingClientRect()
  mouseRef.current.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  mouseRef.current.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
}
renderer.domElement.addEventListener('pointermove', onPointerMove)

// ---- Animation state -------------------------------------------------
const clock = new THREE.Clock()
let time = 0
timeRef.current = 0
const current = {
  orbitSpeed: 0.5, subRadius: 0.14,
  eyeYaw: 0, eyePitch: 0,
  headPitch: 0, headYaw: 0, headRoll: 0,
  jitterX: 0, jitterY: 0,
  jitterTargetX: 0, jitterTargetY: 0, jitterNextTime: 0,
  orbitPhaseAccum: 0,
}
let wanderTarget = { x: 0, y: 0 }
let wanderTimer = 0
let blinkStartTime = -1
let nextAutoBlinkTime = 1.0 + Math.random() * 2.0
let lastBlinkTrigger = 0

// Pupil color state — persists frame-to-frame so the eye tint eases in/out
// instead of snapping when state or gesture changes the target color.
const currentPupilColor = new THREE.Color(PALETTES.cyan.accent)
const targetPupilColor  = new THREE.Color()
const statePupilColor   = new THREE.Color()
const gesturePupilColor = new THREE.Color()

const lerp = (a, b, t) => a + (b - a) * t
const sat  = (x) => Math.max(0, Math.min(1, x))

// Cubic Bézier with computed control points (arc upward, arrive tangentially)
const cubicBezier = (p0, p1, p2, p3, t, out) => {
  const u = 1 - t
  const u2 = u * u, u3 = u2 * u, t2 = t * t, t3 = t2 * t
  out.x = u3 * p0.x + 3 * u2 * t * p1.x + 3 * u * t2 * p2.x + t3 * p3.x
  out.y = u3 * p0.y + 3 * u2 * t * p1.y + 3 * u * t2 * p2.y + t3 * p3.y
  out.z = u3 * p0.z + 3 * u2 * t * p1.z + 3 * u * t2 * p2.z + t3 * p3.z
  return out
}

const tmpP1 = new THREE.Vector3()
const tmpP2 = new THREE.Vector3()
const tmpMid = new THREE.Vector3()
const tmpGazeDir = new THREE.Vector3()
const tmpGestureDir = new THREE.Vector3()

let rafId = 0
const animate = () => {
  rafId = requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 0.05)
  time += dt
  timeRef.current = time

  // Detect preset change — mutate scene (Earth geometry/position, camera)
  if (appliedPreset !== presetKeyRef.current) {
    applyPreset(presetKeyRef.current)
    appliedPreset = presetKeyRef.current
  }

  const s = STATES[stateRef.current]
  const p = PALETTES[paletteRef.current]
  const sk = stateRef.current
  const fm = flightModeRef.current

  // Palette swap (body/eye-field/sub/trails/markers). Pupil+glow colors
  // are computed later because they depend on state + gesture overrides.
  bodyUniforms.uBaseColor.value.set(p.base)
  bodyUniforms.uAccentColor.value.set(p.accent)
  bodyUniforms.uGlowColor.value.set(p.glow)
  eyeFieldUniforms.uBodyColor.value.set(p.base)
  eyeFieldUniforms.uBodyAccent.value.set(p.accent)
  subMats.forEach((m) => m.color.set(p.accent))
  trails.forEach((t) => t.mat.uniforms.uColor.value.set(p.accent))
  targetMat.color.set(p.accent)
  targetHaloMat.color.set(p.accent)

  if (Math.abs(body.geometry.parameters.radius - bodyRadiusRef.current) > 1e-4) {
    body.geometry.dispose()
    body.geometry = new THREE.IcosahedronGeometry(bodyRadiusRef.current, 4)
    const br = bodyRadiusRef.current
    allEyes.forEach((e) => {
      e.disc.position.z  = br + 0.0003
      e.glow.position.z  = br + 0.0005
      e.pupil.position.z = br + 0.0006
    })
  }
  bodyUniforms.uTime.value = time
  earthMat.uniforms.uTime.value = time

  current.orbitSpeed = lerp(current.orbitSpeed, s.orbitSpeed, 0.04)
  const targetRadius = orbitRadiusRef.current * s.orbitRadiusScale
  current.subRadius = lerp(current.subRadius, targetRadius, 0.05)

  // ---- Gesture state check (end detection) ---------------------------
  // Compute data is deferred until activeTarget is known, since Beckon
  // needs a direction vector from head to target.
  let activeG = activeGestureRef.current
  let gestureT = -1
  if (activeG) {
    gestureT = (time - activeG.startTime) / activeG.duration
    if (gestureT >= 1) {
      activeGestureRef.current = null
      setGestureVersion((v) => v + 1)
      activeG = null
      gestureT = -1
    }
  }
  let gestureData = null // populated below once we know activeTarget

  // ---- Flight: compute Orbit's world rest position -------------------
  // orbitRestPos is where the head would be absent sway.
  const orbitRest = orbitRestPosRef.current
  if (fm === 'out' || fm === 'back') {
    const p0 = flightStartPosRef.current
    const p3 = flightEndPosRef.current
    const elapsed = time - flightStartTimeRef.current
    const rawT = Math.min(1, Math.max(0, elapsed / flightDurationRef.current))
    // Smooth-in/out easing
    const tE = rawT * rawT * (3 - 2 * rawT)

    // Control points: arc upward at midpoint; lift/approach slightly
    tmpMid.copy(p0).lerp(p3, 0.5)
    tmpMid.y += flightArcHeightRef.current
    tmpP1.copy(p0).lerp(tmpMid, 0.55)
    tmpP2.copy(p3).lerp(tmpMid, 0.55)
    cubicBezier(p0, tmpP1, tmpP2, p3, tE, orbitRest)

    if (rawT >= 1) {
      orbitRest.copy(p3)
      if (fm === 'out') setFlightMode('atEarth')
      else setFlightMode('rest')
    }
  } else if (fm === 'atEarth') {
    orbitRest.copy(parkingSpot)
  } else {
    orbitRest.copy(CHAT_POS)
  }

  // Body sway on top of rest position
  const sway = Math.sin(time * 0.7) * 0.004
  head.position.set(orbitRest.x, orbitRest.y + sway, orbitRest.z)

  // ---- Active feature target (what PRESENTING / POINTING trace) -----
  const featureIsAtEarth = (fm === 'atEarth' || fm === 'out')
  const activeTarget = featureIsAtEarth ? earthFeature : CHAT_FEATURE
  // At-Earth features scale with Earth size — a continent on a planetary-
  // scale Earth is much bigger than a continent on a tabletop Earth.
  const featureScale = featureIsAtEarth ? (currentPreset.earthRadius / 0.22) : 1.0
  targetMarker.position.copy(activeTarget)
  targetHalo.position.copy(activeTarget)
  // Halo faces camera roughly by pointing +Z, slightly offset in z for draw order
  targetHalo.position.z += 0.0005

  // ---- Gesture data (now that direction-to-target is known) ----------
  if (activeG) {
    tmpGestureDir.subVectors(activeTarget, head.position).normalize()
    gestureData = GESTURES[activeG.kind].compute(gestureT, {
      direction: tmpGestureDir,
      featureIsAtEarth,
    })
  }
  const gestureActive = gestureData !== null

  // ---- Pupil pulse (TALKING) + size ---------------------------------
  const pulseMul = s.pupilPulse ? (Math.sin(time * 9.0) * 0.25 + 1.0) : 1.0
  const finalPupilBright = pupilBrightnessRef.current * pulseMul
  allEyes.forEach((e) => {
    e.pupil.scale.setScalar(lerp(e.pupil.scale.x, pupilSizeRef.current, 0.15))
    e.glow.scale.setScalar(e.pupil.scale.x * 1.12)
  })

  // ---- Blinks -------------------------------------------------------
  if (blinkTriggerRef.current !== lastBlinkTrigger) {
    lastBlinkTrigger = blinkTriggerRef.current
    blinkStartTime = time
  }
  if (s.blinkInterval > 0 && blinkStartTime < 0 && time >= nextAutoBlinkTime) {
    blinkStartTime = time
    nextAutoBlinkTime = time + s.blinkInterval * (0.65 + Math.random() * 0.7)
  }
  let blinkAmount = 0
  if (blinkStartTime >= 0) {
    const blinkDur = s.blinkDuration > 0 ? s.blinkDuration : 0.14
    const t = (time - blinkStartTime) / blinkDur
    if (t >= 1) blinkStartTime = -1
    else {
      const tri = t < 0.5 ? t * 2 : (1 - t) * 2
      blinkAmount = Math.sin(tri * Math.PI * 0.5)
    }
  }
  const effectiveUpper = Math.max(upperLidRef.current, blinkAmount)
  const effectiveLower = Math.max(lowerLidRef.current, blinkAmount * 0.35)
  eyeFieldUniforms.uUpperLid.value = effectiveUpper
  eyeFieldUniforms.uLowerLid.value = effectiveLower
  const coverByUpper = sat((effectiveUpper - 0.35) / 0.25)
  const coverByLower = sat((effectiveLower - 0.35) / 0.25)
  const pupilVis = 1 - Math.max(coverByUpper, coverByLower)

  // ---- Pupil color blend ---------------------------------------------
  // Start from palette accent; lerp toward state's pupilColor (partial —
  // state tints the eye without overtaking it); then lerp toward gesture
  // flash color by its envelope amount. currentPupilColor eases in each
  // frame so transitions feel soft, not abrupt.
  targetPupilColor.set(p.accent)
  if (s.pupilColor) {
    statePupilColor.set(s.pupilColor)
    targetPupilColor.lerp(statePupilColor, 0.65)
  }
  if (gestureActive && gestureData.pupilColor && gestureData.pupilFlash) {
    gesturePupilColor.set(gestureData.pupilColor)
    targetPupilColor.lerp(gesturePupilColor, gestureData.pupilFlash)
  }
  currentPupilColor.lerp(targetPupilColor, 0.12)
  pupilMat.color.copy(currentPupilColor)
  pupilGlowMat.color.copy(currentPupilColor)

  pupilMat.opacity = sat(finalPupilBright * pupilVis)
  pupilGlowMat.opacity = sat(0.4 * finalPupilBright * pupilVis)

  // ---- Eye gaze -----------------------------------------------------
  // During flight, gaze follows flight direction (look ahead / look home).
  // Otherwise use state-specific gaze logic.
  let tYaw = 0, tPitch = 0
  if (fm === 'out' || fm === 'back') {
    // Look toward destination (or where we're heading)
    const dest = flightEndPosRef.current
    tmpGazeDir.subVectors(dest, head.position).normalize()
    tYaw = Math.atan2(tmpGazeDir.x, tmpGazeDir.z)
    const horiz = Math.sqrt(tmpGazeDir.x * tmpGazeDir.x + tmpGazeDir.z * tmpGazeDir.z)
    tPitch = -Math.atan2(tmpGazeDir.y, horiz)
  } else if (sk === 'CHATTING' || sk === 'TALKING') {
    tYaw = mouseRef.current.x * 0.55
    // Fix: positive mouse.y (top of canvas) should look UP = negative pitch
    tPitch = -mouseRef.current.y * 0.35
  } else if (sk === 'LISTENING') {
    tYaw = mouseRef.current.x * 0.2
    tPitch = -mouseRef.current.y * 0.15 + 0.05
  } else if (sk === 'POINTING' || sk === 'PRESENTING') {
    // Look at the active target
    tmpGazeDir.subVectors(activeTarget, head.position).normalize()
    tYaw = Math.atan2(tmpGazeDir.x, tmpGazeDir.z)
    const horiz = Math.sqrt(tmpGazeDir.x * tmpGazeDir.x + tmpGazeDir.z * tmpGazeDir.z)
    tPitch = -Math.atan2(tmpGazeDir.y, horiz)
    if (sk === 'PRESENTING') tYaw += Math.sin(time * 0.9) * 0.06
  } else if (sk === 'THINKING') {
    tYaw = -0.35; tPitch = 0.3
  } else if (sk === 'EXCITED') {
    tYaw = Math.sin(time * 3.0) * 0.4
    tPitch = Math.cos(time * 2.3) * 0.25
  } else if (sk === 'SURPRISED') {
    tYaw = 0; tPitch = 0
  } else if (sk === 'SLEEPY') {
    tYaw = Math.sin(time * 0.3) * 0.12
    tPitch = 0.18 + Math.cos(time * 0.25) * 0.05
  } else if (sk === 'HAPPY') {
    tYaw = Math.sin(time * 0.5) * 0.18
    tPitch = Math.cos(time * 0.7) * 0.08
  } else if (sk === 'CURIOUS') {
    tYaw = Math.sin(time * 0.6) * 0.25
    tPitch = Math.cos(time * 0.4) * 0.15 - 0.05
  } else if (sk === 'YES' || sk === 'NO') {
    tYaw = 0; tPitch = 0
  } else {
    wanderTimer -= dt
    if (wanderTimer <= 0) {
      wanderTarget = {
        x: (Math.random() - 0.5) * 0.7,
        y: (Math.random() - 0.5) * 0.4,
      }
      wanderTimer = 2 + Math.random() * 2.5
    }
    tYaw = wanderTarget.x; tPitch = wanderTarget.y
  }
  current.eyeYaw = lerp(current.eyeYaw, tYaw, 0.08)
  current.eyePitch = lerp(current.eyePitch, tPitch, 0.08)
  // Gaze is expressed by MOVING THE PUPIL within its disc, not by
  // rotating the eye group. Real eyes work this way: the eyeball stays
  // in its socket; the iris slides across the visible front. For Orbit
  // this also means the two-eye pair doesn't clip into each other at
  // extreme gaze angles, and the lid shader's horizontal orientation
  // stays stable regardless of where Orbit is looking.
  //
  // Max pupil excursion is ~47% of each disc's radius so the pupil
  // stays fully within the eye field.

  // Visibility driven by live ref
  const twoEyes = eyeModeRef.current === 'two'
  eyeGroup.visible       = !twoEyes
  eyeLeft.group.visible  =  twoEyes
  eyeRight.group.visible =  twoEyes

  // Head nod / shake / tilt (disabled during flight AND during gesture head ownership)
  const inFlight = (fm === 'out' || fm === 'back')
  const gHead = gestureActive && gestureData.head ? gestureData.head : null
  if (gHead) {
    // Gesture owns head exclusively. State head eases toward 0 so when
    // gesture ends, state can resume from rest rather than snapping to
    // mid-motion. This is what prevents muddled Shrug+No, Beckon+Yes, etc.
    current.headPitch = lerp(current.headPitch, 0, 0.22)
    current.headYaw   = lerp(current.headYaw,   0, 0.22)
    current.headRoll  = lerp(current.headRoll,  0, 0.22)
    head.rotation.x = gHead.pitch || 0
    head.rotation.y = gHead.yaw   || 0
    head.rotation.z = gHead.roll  || 0
  } else {
    const headPitchTarget = (!inFlight && s.head === 'nod')   ? Math.sin(time * 5.5) * 0.22 : 0
    const headYawTarget   = (!inFlight && s.head === 'shake') ? Math.sin(time * 6.0) * 0.28 : 0
    // Tilt: slow side-to-side rock (Confused's "huh?" cant). Roughly 4s period.
    const headRollTarget  = (!inFlight && s.head === 'tilt')  ? Math.sin(time * 1.6) * 0.17 : 0
    current.headPitch = lerp(current.headPitch, headPitchTarget, 0.18)
    current.headYaw   = lerp(current.headYaw,   headYawTarget,   0.18)
    current.headRoll  = lerp(current.headRoll,  headRollTarget,  0.10)
    head.rotation.x = current.headPitch
    head.rotation.y = current.headYaw
    head.rotation.z = current.headRoll
  }

  // Pupil jitter
  const jitterAmt = jitterRef.current
  if (jitterAmt > 0.01) {
    if (time >= current.jitterNextTime) {
      const interval = 0.18 - jitterAmt * 0.13
      current.jitterNextTime = time + interval * (0.6 + Math.random() * 0.8)
      const range = 0.006 * jitterAmt
      current.jitterTargetX = (Math.random() - 0.5) * 2 * range
      current.jitterTargetY = (Math.random() - 0.5) * 2 * range
    }
    current.jitterX = lerp(current.jitterX, current.jitterTargetX, 0.35)
    current.jitterY = lerp(current.jitterY, current.jitterTargetY, 0.35)
  } else {
    current.jitterX = lerp(current.jitterX, 0, 0.2)
    current.jitterY = lerp(current.jitterY, 0, 0.2)
  }
  // Pupil position: gaze offset + jitter. Both eyes get identical values
  // so they track together. Vergence (eye convergence on close targets)
  // was tried and removed — it made pupils asymmetric when gaze was
  // off-center, which read as "creepy" rather than "focused." The rule
  // going forward: eye settings replicate across both eyes unless a
  // specific state intentionally breaks that (e.g. future Confused
  // variants could desync if needed).
  const gazeRangeX = 0.014
  const gazeRangeY = 0.010
  const baseGazeX = Math.sin(current.eyeYaw) * gazeRangeX
  const baseGazeY = -Math.sin(current.eyePitch) * gazeRangeY

  allEyes.forEach((e) => {
    const gx = baseGazeX * e.jitterScale + current.jitterX * e.jitterScale
    const gy = baseGazeY * e.jitterScale + current.jitterY * e.jitterScale
    e.pupil.position.x = gx
    e.pupil.position.y = gy
    e.glow.position.x  = gx
    e.glow.position.y  = gy
  })

  // ---- Sub-sphere positions (relative to Orbit's current world pos) -
  // During flight, force subMode to 'orbit' to keep them behaving sensibly
  const effSubMode = inFlight ? 'orbit' : s.subMode
  current.orbitPhaseAccum += current.orbitSpeed * dt

  subSpheres.forEach((sub, i) => {
    const r = current.subRadius
    const pOff = sub.userData.phaseOffset
    const op = head.position

    // Gesture overlay owns sub-sphere positions entirely when active.
    // Gesture positions are head-relative; they follow Orbit through flight.
    if (gestureActive) {
      const gp = gestureData.subSpheres[i]
      sub.position.set(op.x + gp.x, op.y + gp.y, op.z + gp.z)
      return
    }

    let relX = 0, relY = 0, relZ = 0

    if (effSubMode === 'point') {
      if (i === 0) {
        const cycle = (time * 0.35) % 1
        let t = 0
        if (cycle < 0.25)      t = cycle / 0.25
        else if (cycle < 0.65) t = 1.0
        else if (cycle < 0.90) t = 1.0 - (cycle - 0.65) / 0.25
        // Position is a lerp from Orbit toward activeTarget (so it works
        // at chat or at Earth without hardcoding)
        sub.position.copy(op).lerp(activeTarget, t)
        return
      } else {
        const phase = current.orbitPhaseAccum * 1.8 + pOff
        const tight = 0.06
        relX = Math.cos(phase) * tight
        relY = Math.sin(phase * 0.7) * tight * 0.3
        relZ = Math.sin(phase) * tight
      }
    } else if (effSubMode === 'trace') {
      if (i === 0) {
        // Lumpy oval around the active target (world space). Scales with
        // featureScale so the trace is proportional to Earth's size.
        const tp = time * 0.85
        const lobe = 1.0 + Math.sin(tp * 3) * 0.35
        const rx = 0.055 * featureScale * lobe
        const ry = 0.030 * featureScale * (2.0 - lobe) * 0.6
        sub.position.set(
          activeTarget.x + Math.cos(tp) * rx,
          activeTarget.y + Math.sin(tp) * ry,
          activeTarget.z + Math.sin(tp * 0.5) * 0.005 * featureScale,
        )
        return
      } else {
        const phase = current.orbitPhaseAccum * 1.0 + pOff
        const tight = 0.07
        relX = Math.cos(phase) * tight
        relY = Math.sin(phase * 0.7) * tight * 0.3
        relZ = Math.sin(phase) * tight
      }
    } else if (effSubMode === 'figure8') {
      const dir = i === 0 ? 1 : -1
      const phase = current.orbitPhaseAccum * 2.2 * dir + pOff
      const ct = Math.cos(phase), st = Math.sin(phase)
      const denom = 1 + st * st
      relX = r * 1.2 * ct / denom
      relY = Math.sin(phase * 2) * 0.004
      relZ = r * 1.8 * st * ct / denom
    } else if (effSubMode === 'burst') {
      const burst = (time * 1.3) % 1
      const pulse = burst < 0.3 ? burst / 0.3 : 1.0 - (burst - 0.3) / 0.7
      const pulsedR = r * (1.0 + pulse * 0.7)
      const phase = current.orbitPhaseAccum * 1.4 + pOff
      relX = Math.cos(phase) * pulsedR
      relY = Math.sin(phase * 0.7) * pulsedR * 0.3
      relZ = Math.sin(phase) * pulsedR
    } else if (effSubMode === 'scatter') {
      const phase = current.orbitPhaseAccum * 1.2 + pOff
      relX = Math.cos(phase) * r
      relY = Math.sin(phase * 0.7) * r * 0.3
      relZ = Math.sin(phase) * r
    } else if (effSubMode === 'listening') {
      const phase = current.orbitPhaseAccum * 1.5 + pOff
      const baseX = (i === 0 ? -1 : 1) * 0.018
      relX = baseX + Math.sin(phase * 1.3) * 0.004
      relY = -0.010 + Math.cos(phase) * 0.003
      relZ = -0.080 + Math.sin(phase * 0.7) * 0.004
    } else if (effSubMode === 'cluster') {
      const phase = current.orbitPhaseAccum + pOff
      const radius = r * 0.55
      relX = Math.cos(phase) * radius * 0.5
      relY = -Math.abs(Math.sin(phase * 0.5)) * radius * 0.8 - 0.025
      relZ = -Math.abs(Math.sin(phase)) * radius
    } else if (effSubMode === 'confused') {
      // Asymmetric, out-of-sync — each sub runs its own pace and drift,
      // so they never quite align. Reinforces "this doesn't parse" feel.
      const pace    = i === 0 ? 1.35 : 0.72
      const phase   = current.orbitPhaseAccum * pace + pOff
      const driftA  = Math.sin(time * (i === 0 ? 0.4 : 0.55)) * 0.25
      const driftB  = Math.cos(time * (i === 0 ? 0.28 : 0.47)) * 0.18
      relX = Math.cos(phase) * r * (1.0 + driftA)
      relY = Math.sin(phase * 1.3) * r * 0.35 + driftB * 0.025
      relZ = Math.sin(phase * 0.8) * r * 0.9
    } else if (effSubMode === 'nod') {
      const baseX = (i === 0 ? -1 : 1) * 0.055
      const phase = current.orbitPhaseAccum * 0.3 + pOff
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
      const phase = current.orbitPhaseAccum * 2 + pOff
      relX = Math.cos(phase) * r
      relY = Math.sin(phase * 0.7) * r * 0.3
      relZ = Math.sin(phase) * r
    }

    sub.position.set(op.x + relX, op.y + relY, op.z + relZ)
  })

  // ---- Trails -------------------------------------------------------
  // Boost during flight so the journey leaves a visible arc
  const flightBoost = inFlight ? 0.6 : 0
  trails.forEach((trail, i) => {
    let targetIntensity = Math.max(flightBoost, trailStrengthRef.current)
    const effMode = inFlight ? 'orbit' : s.subMode
    if ((effMode === 'point' || effMode === 'trace') && i !== 0) targetIntensity = 0
    trail.currentIntensity = lerp(trail.currentIntensity, targetIntensity, 0.10)
    trail.mat.uniforms.uIntensity.value = trail.currentIntensity

    const sub = subSpheres[i]
    const pos = trail.positions
    for (let j = TRAIL_LENGTH - 1; j > 0; j--) {
      pos[j * 3]     = pos[(j - 1) * 3]
      pos[j * 3 + 1] = pos[(j - 1) * 3 + 1]
      pos[j * 3 + 2] = pos[(j - 1) * 3 + 2]
    }
    pos[0] = sub.position.x
    pos[1] = sub.position.y
    pos[2] = sub.position.z
    trail.geom.attributes.position.needsUpdate = true
  })

  // Target marker visibility + scale (scales with Earth at arrival)
  const wantMarker = (sk === 'POINTING' || sk === 'PRESENTING') ? 1 : 0
  targetMat.opacity      = lerp(targetMat.opacity,     wantMarker * (0.5 + Math.sin(time * 2.5) * 0.15), 0.12)
  targetHaloMat.opacity  = lerp(targetHaloMat.opacity, wantMarker * 0.25, 0.12)
  targetMarker.scale.setScalar(featureScale)
  targetHalo.scale.setScalar((1 + Math.sin(time * 1.8) * 0.25) * featureScale)

  renderer.render(scene, camera)
}
animate()

const onResize = () => {
  width = mount.clientWidth
  height = mount.clientHeight
  camera.aspect = width / height
  camera.updateProjectionMatrix()
  renderer.setSize(width, height)
}
const ro = new ResizeObserver(onResize)
ro.observe(mount)

return () => {
  cancelAnimationFrame(rafId)
  ro.disconnect()
  renderer.domElement.removeEventListener('pointermove', onPointerMove)
  if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement)
  body.geometry.dispose(); bodyMaterial.dispose()
  eyeDisc.geometry.dispose(); eyeFieldMaterial.dispose()
  pupilGlow.geometry.dispose(); pupilGlowMat.dispose()
  pupil.geometry.dispose(); pupilMat.dispose()
  // Two-eye geometries (materials shared with single-eye, already disposed above)
  eyeLeft.disc.geometry.dispose()
  eyeLeft.glow.geometry.dispose()
  eyeLeft.pupil.geometry.dispose()
  eyeRight.disc.geometry.dispose()
  eyeRight.glow.geometry.dispose()
  eyeRight.pupil.geometry.dispose()
  subSpheres.forEach((s) => { s.geometry.dispose(); s.material.dispose() })
  trails.forEach((t) => { t.geom.dispose(); t.mat.dispose() })
  targetMarker.geometry.dispose(); targetMat.dispose()
  targetHalo.geometry.dispose(); targetHaloMat.dispose()
  earth.geometry.dispose(); earthMat.dispose()
  renderer.dispose()
}
```

}, [])

// –– UI ––––––––––––––––––––––––––––––––
const palette = PALETTES[paletteKey]
const btn = (active) => ({
padding: ‘6px 11px’,
background: active ? palette.accent : ‘#1a1a24’,
color: active ? ‘#0a0a12’ : ‘#d8d8e8’,
border: `1px solid ${active ? palette.accent : '#2a2a38'}`,
borderRadius: ‘6px’,
cursor: ‘pointer’,
fontSize: ‘12px’,
fontWeight: active ? 600 : 400,
fontFamily: ‘system-ui, sans-serif’,
transition: ‘all 0.12s’,
})
const Slider = ({ label, value, min, max, step, onChange, display }) => (
<label style={{ display: ‘flex’, alignItems: ‘center’, gap: ‘8px’, minWidth: 0 }}>
<span style={{ minWidth: ‘86px’, opacity: 0.7, fontSize: ‘11px’, letterSpacing: ‘0.03em’ }}>{label}</span>
<input type=“range” min={min} max={max} step={step} value={value}
onChange={(e) => onChange(parseFloat(e.target.value))}
style={{ accentColor: palette.accent, flex: 1, minWidth: 0 }} />
<span style={{ fontVariantNumeric: ‘tabular-nums’, opacity: 0.55, fontSize: ‘11px’, minWidth: ‘42px’, textAlign: ‘right’ }}>
{display !== undefined ? display : value.toFixed(2)}
</span>
</label>
)
const labelStyle = { fontSize: ‘10px’, opacity: 0.45, letterSpacing: ‘0.08em’, textTransform: ‘uppercase’, alignSelf: ‘center’, marginRight: ‘4px’ }
const row = (title, keys) => (
<div style={{ display: ‘flex’, flexWrap: ‘wrap’, gap: ‘5px’, alignItems: ‘center’ }}>
<span style={{ …labelStyle, minWidth: ‘60px’ }}>{title}</span>
{keys.map((k) => (
<button key={k} onClick={() => setStateKey(k)} style={btn(stateKey === k)}>{STATES[k].label}</button>
))}
</div>
)

const atEarth = flightMode === ‘atEarth’
const inFlight = flightMode === ‘out’ || flightMode === ‘back’
const flightLabel =
flightMode === ‘out’     ? ‘✦ Flying to Earth…’ :
flightMode === ‘back’    ? ‘✦ Returning…’        :
flightMode === ‘atEarth’ ? ‘At Earth’            :
‘At chat distance’

return (
<div style={{ width: ‘100%’, height: ‘100vh’, background: ‘#060810’, color: ‘#e0e0ec’, display: ‘flex’, flexDirection: ‘column’, fontFamily: ‘system-ui, sans-serif’ }}>
<div ref={mountRef} style={{
flex: 1, minHeight: 0,
cursor: (stateKey === ‘CHATTING’ || stateKey === ‘TALKING’ || stateKey === ‘LISTENING’) ? ‘crosshair’ : ‘default’,
}} />
<div style={{ padding: ‘10px 12px’, borderTop: ‘1px solid #22222e’, display: ‘flex’, flexDirection: ‘column’, gap: ‘7px’, maxHeight: ‘62vh’, overflowY: ‘auto’ }}>

```
    {/* Scale preset row */}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', padding: '5px 6px', background: '#10121a', borderRadius: '6px', border: `1px solid ${palette.accent}33` }}>
      <span style={{ ...labelStyle, minWidth: '60px', marginRight: '6px' }}>Scale</span>
      {PRESET_KEYS.map((k) => (
        <button key={k} onClick={() => changePreset(k)} disabled={inFlight} style={{
          ...btn(presetKey === k),
          padding: '7px 12px',
          opacity: inFlight ? 0.4 : 1,
          cursor: inFlight ? 'default' : 'pointer',
        }}>{SCALE_PRESETS[k].label}</button>
      ))}
      <span style={{ fontSize: '11px', opacity: 0.55, marginLeft: '4px', fontStyle: 'italic' }}>
        {SCALE_PRESETS[presetKey].tag}
      </span>
    </div>

    {/* Flight row */}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center', padding: '4px 6px', background: '#10121a', borderRadius: '6px', border: '1px solid #24283a' }}>
      <span style={{ ...labelStyle, minWidth: '60px', marginRight: '6px' }}>Orbit</span>
      <button disabled={inFlight || atEarth} onClick={flyToEarth} style={{
        ...btn(false),
        padding: '7px 14px',
        opacity: (inFlight || atEarth) ? 0.4 : 1,
        cursor: (inFlight || atEarth) ? 'default' : 'pointer',
        border: `1px solid ${palette.accent}`,
        color: (inFlight || atEarth) ? '#888' : palette.accent,
      }}>Fly to Earth →</button>
      <button disabled={inFlight || !atEarth} onClick={flyHome} style={{
        ...btn(false),
        padding: '7px 14px',
        opacity: (inFlight || !atEarth) ? 0.4 : 1,
        cursor: (inFlight || !atEarth) ? 'default' : 'pointer',
      }}>← Return</button>
      <span style={{ fontSize: '11px', opacity: 0.55, marginLeft: '4px' }}>{flightLabel}</span>
    </div>

    {row('Behavior', BEHAVIOR_STATES)}
    {row('Emotion', EMOTION_STATES)}
    {row('Gesture', GESTURE_STATES)}

    {/* Action overlays — play over current state and return */}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center' }}>
      <span style={{ ...labelStyle, minWidth: '60px' }}>Action</span>
      {GESTURE_KEYS.map((k) => {
        const gesturePlaying = activeGestureRef.current !== null
        const disabled = inFlight || gesturePlaying
        return (
          <button key={k} onClick={() => playGesture(k)} disabled={disabled} style={{
            ...btn(false),
            opacity: disabled ? 0.4 : 1,
            cursor: disabled ? 'default' : 'pointer',
            border: `1px solid ${palette.accent}66`,
          }}>{GESTURES[k].label}</button>
        )
      })}
      <span style={{ fontSize: '11px', opacity: 0.4, marginLeft: '4px', fontStyle: 'italic' }}>
        overlays on any state
      </span>
    </div>

    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center' }}>
      <span style={{ ...labelStyle, minWidth: '60px' }}>Palette</span>
      {Object.keys(PALETTES).map((k) => (
        <button key={k} onClick={() => setPaletteKey(k)} style={{
          ...btn(paletteKey === k),
          textTransform: 'capitalize',
          background: paletteKey === k ? PALETTES[k].accent : '#1a1a24',
          border: `1px solid ${paletteKey === k ? PALETTES[k].accent : '#2a2a38'}`,
        }}>{k}</button>
      ))}
    </div>

    {/* Eyes A/B — design-validation toggle */}
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', alignItems: 'center' }}>
      <span style={{ ...labelStyle, minWidth: '60px' }}>Eyes</span>
      <button onClick={() => setEyeMode('one')} style={btn(eyeMode === 'one')}>One</button>
      <button onClick={() => setEyeMode('two')} style={btn(eyeMode === 'two')}>Two</button>
      <span style={{ fontSize: '11px', opacity: 0.45, marginLeft: '4px', fontStyle: 'italic' }}>
        {eyeMode === 'one' ? 'EVE / BB-8 lineage — iconic, minimalist' : 'mammalian pair — warmer, enables vergence'}
      </span>
    </div>

    <div style={{ height: '1px', background: '#22222e', margin: '2px 0' }} />

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '5px 14px' }}>
      <Slider label="Upper lid"    value={upperLid}        min={0}    max={1}    step={0.02} onChange={setUpperLid} />
      <Slider label="Lower lid"    value={lowerLid}        min={0}    max={1}    step={0.02} onChange={setLowerLid} />
      <Slider label="Pupil size"   value={pupilSize}       min={0.3}  max={1.8}  step={0.05} onChange={setPupilSize} />
      <Slider label="Pupil bright" value={pupilBrightness} min={0}    max={1.5}  step={0.05} onChange={setPupilBrightness} />
      <Slider label="Pupil jitter" value={jitter}          min={0}    max={1}    step={0.02} onChange={setJitter} />
      <Slider label="Trail"        value={trailStrength}   min={0}    max={1.5}  step={0.02} onChange={setTrailStrength} />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button onClick={() => setBlinkTriggerCount((c) => c + 1)} style={{ ...btn(false), fontSize: '12px', padding: '6px 14px' }}>Blink ✦</button>
        <span style={{ fontSize: '11px', opacity: 0.45 }}>auto every {STATES[stateKey].blinkInterval > 0 ? `~${STATES[stateKey].blinkInterval.toFixed(1)}s` : '—'}</span>
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '5px 14px' }}>
      <Slider label="Body size"    value={bodyRadius}  min={0.04} max={0.12} step={0.005} onChange={setBodyRadius}   display={`${(bodyRadius * 1000).toFixed(0)} mm`} />
      <Slider label="Orbit radius" value={orbitRadius} min={0.09} max={0.22} step={0.005} onChange={setOrbitRadius}  display={`${(orbitRadius * 1000).toFixed(0)} mm`} />
    </div>

    <div style={{ fontSize: '10px', opacity: 0.4, lineHeight: 1.55 }}>
      <b style={{ opacity: 0.7 }}>The scale story:</b> watch Orbit at chat distance (companion-sized),
      tap <b style={{ opacity: 0.7 }}>Fly to Earth</b>, see it shrink through real perspective, arrive smaller than a continent.
      At Earth: try <b style={{ opacity: 0.7 }}>Presenting</b> to trace a feature, or <b style={{ opacity: 0.7 }}>Pointing</b> to indicate it.
    </div>
  </div>
</div>
```

)
}
