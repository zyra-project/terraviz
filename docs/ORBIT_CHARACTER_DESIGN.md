# Orbit Character Design

Companion document to `VR_INVESTIGATION_PLAN.md` — fleshes out the
character design for Phase 4 (Orbit avatar). The investigation plan
sketches the avatar's behavior state machine and model sourcing
options; this doc makes the actual design call and revises the Phase
4 commit breakdown accordingly.

Status: **design direction agreed; no code landed yet.**

-----

## Summary

Orbit is a small glowing sphere (~15 cm at chat distance) with a
single inset lens-eye and two tiny companion sub-spheres that orbit
its body. Personality comes from three parametric motion systems —
pupil state, body orientation, and sub-sphere behavior — running on
procedural geometry. **No rigged glTF, no Mixamo, no
`AnimationMixer`.** The character is thematically recursive (spheres
orbiting a sphere orbiting Earth), which doubles as the scale lesson
Phase 4 calls out as the entire point.

-----

## Design constraints (from Phase 4)

Rehashed so this doc is self-contained:

1. **The avatar teaches planetary scale.** Readable at arm's length
   AND as a speck next to a continent. Primary constraint; drives
   silhouette more than style.
1. **Non-humanoid** to dodge uncanny valley, but the specified
   behaviors — eye contact, talking, pointing, waving — are social
   signals. That's a tension; this doc resolves it.
1. **Quest GPU budget** — under 5K tris, mobile-tier shaders only.
1. **Works in both VR (void) and AR (your kitchen table).**
1. **Both audiences — museum families AND professional visitors**
   (researchers, IHO delegates). No condescension, no saccharine
   proportions.

-----

## Key insight

The social-signal question is not "humanoid or not." It is *which
abstracted feature carries each signal.*

|Signal                 |Candidate abstractions        |Pick                                      |
|-----------------------|------------------------------|------------------------------------------|
|Eye contact            |Lens, iris, glowing point     |Single inset lens with animated pupil     |
|Attention / orientation|Body rotation, "head tilt"    |Whole-body orientation toward target      |
|Speech                 |Mouth, display, light pulse   |Pupil brightness pulse + sub-sphere tempo |
|Gesture (point, wave)  |Arms, tentacles, light ribbons|Sub-sphere break-and-fly                  |
|Idle / alive           |Breathing, bobbing            |Constant sub-sphere orbit + slow body sway|

One feature carries each signal. Nothing has to be a humanoid analog.
The gap between minimal form and emotional behavior is what reads as
"charming character" instead of "off-putting thing" — same trick
Wall-E, EVE, BB-8, Luxo Jr., and Baymax all use.

-----

## Design decisions

### Body

Smooth sphere, ~15 cm radius at chat distance. Not featureless:

- **Iridescent shader** — fresnel term + shifting hue gradient.
  Pearlescent warm off-white base with aurora-hued rim. ~30 lines of
  GLSL, cheap on Quest.
- **Optional upgrade** — slow animated bioluminescent patterns under
  the surface (more magical, more expensive, commits harder to "this
  is alive"). Ship iridescent first; upgrade if it feels static.
- **Do NOT mimic Earth's continents.** Earth is the globe; Orbit is
  Earth's companion, not a second Earth.

### The eye

A single circular lens inset into the sphere, ~1/3 the body
diameter:

- Dark field, bright glowing pupil floating inside.
- **Pupil position** = where Orbit is looking (tracks user head in
  CHATTING, tracks target in PRESENTING).
- **Pupil size** — dilated = curious, contracted = focused.
- **Pupil brightness** — pulsing = speaking, dim = listening.
- **Pupil jitter** — steady = attentive, subtle jitter = excited.

Inset geometry (real concavity in the mesh) gives depth a flat decal
can't match, and the dark circle stays readable as orientation cue at
any distance.

### Body language — the orbiting companions

The character-design move: **Orbit has two tiny companion spheres
(~1 cm) that orbit it** the way it orbits Earth.

Recursive scale — spheres orbiting a sphere orbiting a sphere.

Idle: sub-spheres circle peacefully; that ambient motion does the
same job Luxo Jr.'s subtle bob does — tells you this character is
alive without a face twitching.

Gesture behaviors:

|Intent           |Sub-sphere motion                                                                                                                             |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------------|
|Pointing         |One sub-sphere breaks orbit, flies toward target with a trailing light ribbon, parks briefly at target, returns. Body tilts eye-toward-target.|
|Talking          |Sub-spheres speed up or trace figure-8s; pupil brightness pulses with speech rhythm.                                                          |
|Arrived / excited|Sub-spheres scatter outward, then re-converge.                                                                                                |
|Presenting at POI|Orbit parks above location; one sub-sphere descends to trace the POI outline as a glowing contour.                                            |
|Thinking         |Sub-spheres slow and cluster on one side.                                                                                                     |
|Listening        |Sub-spheres drift into a single tight pair behind the body, out of the way.                                                                   |

**Silhouette collapses cleanly with distance:**

- Arm's length → body + eye + orbiting pair visible
- Mid-distance → body + eye + tracer dots
- Globe surface → a glowing presence moving with purpose; eye
  unresolved but intent still readable via motion + trails

The scale contrast lands without tricks.

### Palette

- **Body:** warm off-white / pearl.
- **Accent:** aurora-cyan or aurora-green (sub-spheres, pupil
  highlight, motion trails).
- **Avoid:** red, navy, pure primaries, NOAA-logo blue.

Aurora-palette reads distinctly earth-science without being literal.
Pick between cyan and green on-device; mock both.

### Proportions and tone

Aim for: emotionally legible minimalism, restrained palette, dignity
in proportions.

Cut, if any choice smells "designed for kids":

- Bobble-head proportions
- Primary colors
- Googly eyes
- Saccharine curves
- Any feature that reads as "mascot" before it reads as "character"

The move for the "works for 5-year-olds AND 50-year-olds" brief is
warm-specific, not cute-generic. Professionals tolerate charm; they
don't tolerate condescension.

-----

## Why this works

- **Scale lesson lands without tricks.** The recursive-scale visual
  does double duty — the tiny thing orbiting the tiny thing orbiting
  the big thing is you.
- **No rig, no Mixamo.** All motion is parametric — maybe ten
  animated values total across the whole character. No glTF
  skeleton, no `AnimationMixer`, no import toolchain.
- **Silhouette survives distance.** Spheres read cleanly at any
  size; sub-spheres degrade gracefully from companions → tracer dots
  → implied motion.
- **Thematically exact.** Spheres orbiting a sphere on a project
  literally called `interactive-sphere`, with a docent character
  named "Orbit" whose name implies orbital motion.
- **Eye contact is both literal and metaphorical.** Pupil tracks the
  user's head (literal); body orients toward them (metaphorical).
  Both reinforce.
- **Dodges uncanny valley structurally.** No mouth to desync, no
  hands to miscount, no face to mis-proportion. Minimalist by
  construction.

-----

## Implementation sketch

### Geometry

```typescript
// Body — ~7.5 cm visible radius, low-poly
const body = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.075, 3),
  iridescentMaterial,
)

// Eye — half-sphere cavity inset into the front face
const eyeDepression = new THREE.Mesh(
  new THREE.SphereGeometry(0.025, 32, 16, 0, Math.PI),
  eyeMaterial,
)
eyeDepression.rotation.y = Math.PI  // face inward (concave)
eyeDepression.position.z = 0.055    // sit inside the body surface

// Pupil — floats in front of the eye depression
const pupil = new THREE.Mesh(
  new THREE.CircleGeometry(0.010, 32),
  pupilMaterial,
)
pupil.position.z = 0.070

// Sub-spheres — small, emissive, parented to a rotating pivot
const subSpheres = [0, 1].map(i => {
  const s = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.010, 2),
    subSphereMaterial,
  )
  return s
})
```

### Materials

- **Body** — custom `ShaderMaterial` with fresnel-driven iridescence.
- **Eye** — dark unlit material.
- **Pupil** — additive-blended unlit material with uniforms
  `uBrightness`, `uSize`, `uJitter`.
- **Sub-spheres** — `MeshBasicMaterial` with emissive tint.
- **Trails** — `MeshLine` or `Line2` with fade-over-time, rendered
  only in PRESENTING and POINTING states.

### Motion system

Pure parametric — no keyframes, no mixer:

```typescript
interface OrbitState {
  bodyPosition: THREE.Vector3
  bodyOrientation: THREE.Quaternion
  pupilUV: THREE.Vector2         // where the pupil sits in the eye disc
  pupilSize: number              // 0..1
  pupilBrightness: number        // 0..1
  subSphereOrbitRadius: number
  subSphereOrbitSpeed: number
  subSpherePhases: number[]      // one per sub-sphere
  subSphereMode:
    | 'orbit'
    | 'scatter'
    | 'point'
    | 'trace'
    | 'cluster'
  subSphereTarget?: THREE.Vector3  // for 'point' and 'trace'
}
```

Tween between states with simple easings (cubic in/out). Per-frame
update is ~30 lines.

### State machine integration

Reuses the state machine in `VR_INVESTIGATION_PLAN.md` unchanged —
transitions just drive parameter targets on `OrbitState` instead of
animation clip names.

|Plan state |`OrbitState` changes                                                          |
|-----------|------------------------------------------------------------------------------|
|ORBITING   |`subSphereMode=orbit`, distant idle circuit around Earth, slow body sway      |
|APPROACHING|Bézier flight path to user; sub-spheres trail behind, pupil eager             |
|CHATTING   |Pupil tracks user head; sub-spheres at normal orbit; pupil pulses on TTS audio|
|PRESENTING |Flight to lat/lng; one sub-sphere detaches to trace POI outline               |
|RETURNING  |Flight back; sub-spheres re-converge                                          |

-----

## Revised Phase 4 commit breakdown

The plan's Phase 4 table assumes a rigged glTF character (commits 2
- 3 are glTF loader + `AnimationMixer`). This design makes those
unnecessary. Revised:

|#|Commit                                                                    |Scope                                                                                       |
|-|--------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
|1|Plan doc: Phase 4 breakdown (this file + plan cross-reference)            |Meta                                                                                        |
|2|`vrAvatar: procedural body + eye + pupil`                                 |Icosahedron body, inset eye, animated pupil. No motion yet.                                 |
|3|`vrAvatar: sub-sphere orbit system + idle (ORBITING)`                     |Two sub-spheres circling the body. Distant idle circuit around Earth.                       |
|4|`vrAvatar: approach + return + chat gaze (APPROACHING/CHATTING/RETURNING)`|Bézier flight to and from user, pupil tracks head, sub-spheres speed up during talk.        |
|5|`vrAvatar: presenting flight + POI trace (PRESENTING)`                    |Fly to lat/lng, one sub-sphere detaches and traces POI outline. Globe auto-rotate to follow.|
|6|`docentService: location hints`                                           |Emit lat/lng from enriched metadata; avatar consumes in PRESENTING.                         |
|7|`vrAvatar: polish + tuning`                                               |Flight curves, orbit radius, approach distance, pupil easing, material tuning.              |

Savings vs. the original plan: commits 2–3 merge into one procedural
commit; no glTF loader, no `AnimationMixer`, no Mixamo pipeline.
Roughly 300–400 LOC across the whole phase instead of ~700.

-----

## Two-paragraph narrative for leadership

> *Orbit is the companion character for GSL's Interactive Sphere VR
> experience — a small, friendly presence that accompanies visitors
> as they explore NOAA's science on a virtual Science On a Sphere.
> Designed as a glowing pocket-sized sphere with its own tiny
> orbital companions, Orbit is both mascot and teacher: it flies up
> to greet a visitor when addressed, and when asked about a place
> on Earth — "show me Hurricane Katrina," "where is the Gulf
> Stream?" — Orbit journeys across the virtual globe to the
> location. As Orbit recedes from arm's length to the Earth's
> surface, visitors viscerally feel planetary scale: the friend in
> their hand becomes a tiny speck next to a continent.*

> *Orbit gives NOAA's scientific knowledge an approachable face.
> Behind its animated presence is the existing docent AI, which can
> speak to any of NOAA's datasets — weather, oceans, climate, ice,
> solar activity. By giving that AI a body and a spatial identity,
> Orbit transforms the VR experience from "a dataset viewer" into
> "a guided visit with a knowledgeable friend," extending Science
> On a Sphere's public-engagement mission into a medium visitors
> can take home.*

Adapt per audience (GSL leadership, NOAA Generative AI Working
Group, SOS team, IHO delegates, invention disclosure prose).

-----

## Open questions

1. **Number of sub-spheres: 2 or 3?** Two is cleaner and easier to
   read; three allows role specialization (one points, one traces,
   one ambient). Start with two; experiment with three on-device.
1. **Trails on sub-spheres — always, or state-gated?** Trails add
   motion legibility at distance but cost fill-rate on Quest.
   Recommend trails only in PRESENTING + pointing gestures.
1. **Audio signature.** A subtle hum + bell-like chime on state
   transitions? Pairs well with Phase 5 spatial audio work. Not
   blocking for Phase 4.
1. **Color identity.** Aurora-cyan vs. aurora-green vs. something
   else. Mock both and pick by vibe on device.
1. **Resting state.** When the VR session ends or chat is idle for a
   long time, does Orbit dock to a fixed orbital altitude and dim?
   Fine either way; defaulting to "keeps orbiting, just slower" is
   simpler.
1. **Atmosphere z-fighting.** The globe already has an atmosphere
   rim shader at radius 1.012. Verify sub-sphere trails don't
   z-fight when they dip through it during tracing. Mitigation:
   render trails with `depthWrite: false` and a render-order tweak.
1. **2D fallback.** The plan's "simplified 2D avatar" is deferred.
   This procedural design ports cleanly — the same parametric
   motion runs on a small overlaid WebGL canvas alongside
   MapLibre. Worth keeping in mind for a future Phase 4.5.
