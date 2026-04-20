# Orbit Character — Vinyl Toy Redesign

Companion to `ORBIT_CHARACTER_DESIGN.md`. Records the pivot from the
original spectral single-eyed orb to a **"Cute, Tactile Vinyl Toy"**
with two eyes, designed to read as approachable rather than ominous.

**Status:** design committed. Implementation lives in
`src/services/orbitCharacter/`; the state machine, gesture system,
flight system, and Quest-tier performance constraints from the
original design are all retained.

-----

## Why we're changing it

User feedback on the original spectral single-eyed glowing orb: **too
creepy, a bit ominous.** The fresnel-lit iridescent body + single
inset lens read as alien, not approachable — exactly opposite of
what a museum docent for families needs.

The visual pivot: opaque matte "vinyl toy" body, paired neotenous
eyes with wet catchlights, warm off-white sparkle trails, and tight
dual orbiting satellites that cast soft eclipse shadows. Personality
still lives in parametric motion (pupils, head group, sub-sphere
behavior), not in any rigged mesh. The entire state machine, gesture
overlays, flight system, and reduced-motion hygiene carry forward
unchanged.

-----

## Design summary

| Aspect | Before | After |
|---|---|---|
| Body material | `ShaderMaterial`, fresnel + iridescent hue shift | `MeshStandardMaterial`, matte vinyl (rough 0.5, metal 0.0), horizontal two-color gradient via `onBeforeCompile` |
| Face | Single inset lens-eye (EVE / BB-8 lineage) | Two paired eyes only — larger, lower, wider; mammalian neoteny proportions |
| Eye socket | Near-black (`#060810`) | Warm dark charcoal (`#1f1a24`) |
| Catchlights | None | Two per eye (primary upper-right, secondary lower-left) — static, additive white |
| Sub-sphere material | `MeshBasicMaterial` (flat accent color) | `MeshStandardMaterial` with the vinyl gradient |
| Idle orbits | Single shared orbit phase | Two distinct crossing ellipses, tighter radius |
| Shadows | None | Sub-spheres cast eclipse shadows onto body (educational cue: planetary eclipses) |
| Trails | Palette-accent color, steady tapering | Warm off-white by default, per-vertex sparkle, palette-colored for expressive states only |
| Body dynamics | Subtle wobble | Procedural squash/stretch — breathing, velocity smear, surprise gasp, satellite anthropomorphism |

-----

## 1. Palette system

We **extend** the existing palettes rather than replacing them. Every
palette now carries a `warm` + `cool` anchor pair that drives the
body's horizontal gradient. The default palette (`cyan`) uses the
pink→blue gradient from the concept art; the other three palettes
offer alternatives that all read as "soft vinyl toy."

```ts
interface Palette {
  base:   string   // light surface wash (legacy, used by eye lid shader)
  accent: string   // pupil + trail color for expressive states
  glow:   string   // halo color (legacy)
  warm:   string   // left side of body gradient
  cool:   string   // right side of body gradient
}
```

| Key | Warm | Cool | Feel |
|---|---|---|---|
| `cyan`   | `#f7c9d6` (blush pink)     | `#c9e6e5` (seafoam)     | Reference — matches concept art |
| `green`  | `#d6f0c9` (mint)           | `#c9d6f0` (periwinkle)  | Spring, library-tone |
| `amber`  | `#f7d9b8` (peach)          | `#f2e9cf` (cream)       | Warm & plush |
| `violet` | `#e4cdf7` (lavender)       | `#f7cde0` (rose)        | Plum candy |

`accent` is left as-is so the pupil + expressive trails still read
against the vinyl body. `base`/`glow` stay so the eye-field lid
shader can blend lids against the body's dominant tone without
knowing about the gradient.

### Gradient injection (matte vinyl material)

`createBodyMaterial` returns a `MeshStandardMaterial` whose fragment
pipeline is modified via `onBeforeCompile`. We add a single uniform
for each anchor and mix by object-space X position:

```glsl
// inserted before diffuseColor usage
float g = clamp(vObjSpacePos.x / uSpan + 0.5, 0.0, 1.0);
vec3 gradient = mix(uWarm, uCool, g);
diffuseColor.rgb = gradient;
```

`roughness: 0.5` and `metalness: 0.0` give the tactile silicone
catch-the-light feel. No textures — everything derives from two
uniforms.

-----

## 2. Face geometry

**Paired eyes only.** `EyeMode = 'two'` is narrowed to a single
literal; the legacy `'one'` code path and the central eye rig are
deleted. Callers (`orbitMain.ts`, `orbitDebugPanel.ts`,
`orbitPostMessageBridge.ts`) are simplified accordingly.

**Neoteny placement** — the concept art reads "approachable" because
the eyes sit low-and-wide on the face, large relative to the head.
We match:

| Constant | Before | After |
|---|---|---|
| `EYE_PAIR_OFFSET_X` | `0.022` | `0.028` (wider) |
| `EYE_PAIR_DISC_RADIUS` | `0.014` | `0.018` (bigger) |
| `EYE_PAIR_GLOW_RADIUS` | `0.0065` | `0.0090` |
| `EYE_PAIR_PUPIL_RADIUS` | `0.0040` | `0.0055` |
| Eye group `.position.y` | `0` | `-0.012` (lower) |

### Warmer sockets

`uEyeColor: 0x060810 → 0x1f1a24` (warm dark charcoal) and
`uRimColor: 0x1a1c25 → 0x2a2230`. Lid shader now mixes against the
body's warm anchor instead of the legacy fresnel base so lids close
to opaque vinyl skin rather than a metallic rim.

### Catchlights (both sizes)

Each eye gets **two** additive white discs, parented to the eye
group (not the pupil) so they stay fixed while the pupil moves.
Primary at upper-right (`+0.0020, +0.0018`, radius `0.0010`, opacity
`0.95`). Secondary at lower-left (`-0.0010, -0.0008`, radius
`0.0005`, opacity `0.55`). The two-highlight convention is what
Pixar / Dreamworks rigs use to sell "wet, alive" eyes — shipping
both.

-----

## 3. Sub-spheres + shadows

**Material:** swap `MeshBasicMaterial` → `MeshStandardMaterial` with
the same matte-vinyl gradient injection. They read as "smaller
siblings of Orbit," not "flat dots."

**Idle orbit geometry (`effSubMode === 'orbit'`):** two distinct
crossing ellipses. Each sub carries `userData.orbitBasis` — a
precomputed orthonormal basis representing the plane of its
ellipse, tilted at different angles so the orbits cross visibly
when viewed head-on:

```ts
// computed once in buildScene
sub[0].userData.orbitBasis = tiltedBasis( +0.62)  // ~35° tilt
sub[1].userData.orbitBasis = tiltedBasis(-0.87)   // ~-50° tilt
```

The per-frame math becomes `pos = basis.u * cos(phase) * r + basis.v * sin(phase) * r` — one add per axis, cheap.

Radius tightens: `SUB_ORBIT_RADIUS 0.14 → 0.11`. Other sub-modes
(point, trace, figure8, burst, scatter, listening, cluster,
confused, nod, shake) keep their current logic — only the idle
path changes so the expressive breakaways still read as "breaking
away."

**Shadows (educational cue: planetary eclipses):**

- `WebGLRenderer.shadowMap.enabled = true`, `type = PCFSoftShadowMap`.
- Body: `castShadow = true, receiveShadow = true`.
- Subs: `castShadow = true, receiveShadow = false`.
- Key light (new): directional, tight shadow frustum (~0.5 units
  each side), `mapSize = 512`. Cheap on Quest.
- Earth stack is not a shadow participant — its materials remain
  untouched.

-----

## 4. Trail sparkle

`orbitTrails.ts` keeps the `THREE.Points` point-sprite pipeline
(`THREE.Line` widths break on mobile GPUs — that hazard hasn't
changed). Two tweaks:

1. **Color decision** moves into `updateTrails`:
   - For idle / low-excitement states (`IDLE`, `CHATTING`,
     `LISTENING`, `THINKING`, `SOLEMN`, `SLEEPY`, `YES`, `NO`) →
     warm off-white (`#fff0d8`).
   - For expressive states (`TALKING`, `POINTING`, `PRESENTING`,
     `EXCITED`, `HAPPY`, `CURIOUS`, `SURPRISED`, `CONFUSED`) →
     palette accent.
   - A single helper `trailColorFor(state, palette)` owns the
     decision; new states fall into the idle bucket by default.
2. **Sparkle shader:**
   - Per-vertex `seed` attribute (random `[0, 1)` at build time).
   - Fragment `fade = pow(fade, 2.2)` (sharper, more spark-like
     than the current `1.5`).
   - Per-vertex twinkle: `alpha *= 0.6 + 0.4 * sin(uTime * 6 + seed * 6.28)`.
   - New `uTime` uniform written by `updateTrails`.

Trails still strictly follow sub-sphere positions via the existing
rolling-buffer write.

-----

## 5. Squash & stretch dynamics

Procedural scale deformation applied at the end of `updateCharacter`
— a new section *after* sub-sphere positions and *before* trails —
so any state or gesture can re-run next frame without interference.
No new animation clips; all math.

### 5.1 Architecture for extensibility

This is the core correctness requirement from the pivot: **adding a
new state in the future must not require editing five files.**

We introduce one additive table, in `orbitStates.ts`, colocated with
`STATES` but kept separate so the locked `STATES` tuning is not
touched:

```ts
export interface ExpressionConfig {
  breathRate:  number   // cycles per second
  breathAmp:   number   // peak Y-scale offset (X/Z move inversely)
  meltXZ:      number   // extra XZ widening (sleepy/solemn)
  hopAmp:      number   // rhythmic Y hop (excited)
  surpriseGasp: boolean // one-shot spring on state entry
  talkPulse:   boolean  // subs pulse with pupil pulse
}

export const EXPRESSION_DEFAULT: ExpressionConfig = {
  breathRate: 0.8, breathAmp: 0.012, meltXZ: 0, hopAmp: 0,
  surpriseGasp: false, talkPulse: false,
}

export const EXPRESSIONS: Partial<Record<StateKey, Partial<ExpressionConfig>>> = {
  SLEEPY:    { breathRate: 0.35, breathAmp: 0.018, meltXZ: 0.025 },
  SOLEMN:    { breathRate: 0.4,  breathAmp: 0.015, meltXZ: 0.018 },
  EXCITED:   { breathRate: 2.4,  breathAmp: 0.006, hopAmp: 0.010 },
  SURPRISED: { breathRate: 0.8,  breathAmp: 0.004, surpriseGasp: true },
  TALKING:   { talkPulse: true },
  // states omitted from this table get EXPRESSION_DEFAULT
}

export function expressionFor(state: StateKey): ExpressionConfig {
  return { ...EXPRESSION_DEFAULT, ...(EXPRESSIONS[state] ?? {}) }
}
```

**Why this shape:**
- `STATES` stays locked — its tuning is the output of nine prototype
  iterations and comes with a design-doc update rule. Breathing
  parameters are orthogonal to `STATES` (motion vs. shape), so they
  get their own table.
- `EXPRESSION_DEFAULT` + `Partial` means new states automatically
  get sensible breathing without touching the table at all.
- Every new state **must** have a `StateKey` entry; the compiler
  catches typos. Adding new fields to `ExpressionConfig` defaults
  to the sensible value through the spread — old entries don't
  need edits.
- `expressionFor(state)` is the only lookup site in
  `updateCharacter`; all math reads from the merged config.

Same pattern can be extended later for any per-state shape
parameter (e.g., cheek flush color, antenna bob amplitude) without
editing `STATES`.

### 5.2 Math

Per frame, after sub-sphere positions are written:

1. **Breathing** (always on):
   ```
   yAmp = cfg.breathAmp * sin(time * cfg.breathRate * 2π)
   hop  = cfg.hopAmp    * max(0, sin(time * cfg.breathRate * 2π * 2))
   sx = 1 + cfg.meltXZ - yAmp * 0.3
   sy = 1 + yAmp + hop
   sz = sx
   ```

2. **Velocity smear** (during flight):
   Track `prevHeadPos` on `AnimationState`. `speed = dist/dt`.
   Stretch along gaze-forward (approximated as world-Z): `sz *= 1 +
   0.4 * speed`, `sx *= 1 - 0.2 * speed`. On mode transition
   out of flight, record `arrivalTime` and apply a brief
   squash pulse (`sy *= 0.92` for 0.12 s then ease back).

3. **Affirm nod accent:**
   Inside `gestureFrame` branch, if `activeGesture.kind === 'affirm'`
   and `t ∈ [0.45, 0.55]`, `sy *= 0.96`. Reads as the "weight" of
   the nod's low point.

4. **Surprise gasp:**
   If `cfg.surpriseGasp` and we just entered this state, record
   `surpriseStart = time`. Spring: `sy *= 1 + 0.12 * exp(-5τ) *
   cos(14τ)` where `τ = time - surpriseStart`, until `τ > 1.2`.

5. **Satellite anthropomorphism:**
   If `cfg.talkPulse`, every sub's scale gets `1 + 0.15 * sin(time *
   9)` — same frequency as the existing pupil pulse. Reads as the
   subs "breathing with the voice."

All writes go through `lerp` for framerate hygiene. Apply to
`handles.body.scale` and `sub.scale[i]` directly (no intermediate
objects, keeps GC quiet).

### 5.3 AnimationState additions

```ts
interface AnimationState {
  // … existing fields
  prevHeadPos:     THREE.Vector3
  surpriseStart:   number         // -1 when not active
  arrivalSquashStart: number      // -1 when not active
  lastStateKey:    StateKey       // for gasp on-entry detection
}
```

-----

## 6. Dispose hygiene

`OrbitController.dispose()` already traverses the scene and calls
`dispose()` on any `.geometry` / `.material` it finds. The new
catchlight meshes, the key light, and every new `MeshStandardMaterial`
are reached by the traversal. Lights dispose their shadow cameras
when garbage-collected. Gradient uniforms are plain JS objects with
no GPU resources beyond the material they're attached to — no
change needed.

-----

## 7. Files touched

| File | Change |
|---|---|
| `orbitTypes.ts` | `EyeMode = 'two'`; `warm`/`cool` fields on `Palette`; populate anchors |
| `orbitStates.ts` | Add `ExpressionConfig`, `EXPRESSION_DEFAULT`, `EXPRESSIONS`, `expressionFor` |
| `orbitMaterials.ts` | Rewrite `createBodyMaterial` to vinyl `MeshStandardMaterial` + gradient injection; warmer eye socket; lid reads body gradient |
| `orbitScene.ts` | Remove single-eye rig; reposition pair; catchlights; lights + shadow config; vinyl sub-spheres; dual-ellipse idle orbits; squash/stretch in `updateCharacter` |
| `orbitTrails.ts` | Warm-white idle default; per-vertex sparkle; `trailColorFor` helper |
| `index.ts` | `renderer.shadowMap` config; simplify `eyeMode` handling |
| `src/orbitMain.ts` | Drop `'one'` from URL-param validation |
| `src/ui/orbitDebugPanel.ts` | Drop "One" option |
| `src/ui/orbitPostMessageBridge.ts` | Narrow eye-mode validation |

-----

## 8. Non-goals

- **Rigged animation.** Squash/stretch stays procedural. No
  `AnimationMixer`, no imported glTF.
- **Re-tuning `STATES`.** Motion parameters (orbit speed, pupil
  size, lid angles) are locked; only the orthogonal `EXPRESSIONS`
  shape table is new.
- **Re-tuning `GESTURES`.** The four gesture compute functions are
  locked; the `affirm` squash accent is a per-frame overlay, not
  a `GestureFrame` field change.
- **Mobile line-width workaround.** Trails stay `THREE.Points`.
- **Desktop-only features.** Everything ships on Quest and web.

-----

## 9. Verification

- `npm run type-check` — green.
- `npm run test` — green (no orbit unit tests today; expression
  defaults get a small spot-check if time permits).
- Manual: cycle every `StateKey` at `/orbit` and confirm body reads
  as vinyl (not iridescent), eyes track, catchlights stay put
  during pupil sweep, subs cast moving shadows, trails go
  warm-white at IDLE and accent-colored at TALKING, breathing is
  visible at SLEEPY, gasp triggers on SURPRISED entry.
- Performance: frame budget on Quest 2 should stay under the
  existing baseline — `MeshStandardMaterial` is more expensive per
  pixel than the hand-rolled fresnel shader but the tri count is
  unchanged and shadow map is small.
