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
| Body material | `ShaderMaterial`, fresnel + iridescent hue shift | `MeshStandardMaterial`, matte vinyl (rough 0.5, metal 0.0), warm-top → cool-bottom gradient (15° diagonal) via `onBeforeCompile` |
| Face | Single inset lens-eye (EVE / BB-8 lineage) | Two paired eyes only — larger, lower, wider; mammalian neoteny proportions |
| Eye structure | Flat accent-colored disc | Socket stack with a 3-D bezel torus, iris ring → navy pupil field (soft-edge) → 3-star sparkle cluster (5-pt centre + two 4-pt flanking) → black pupil dot → one "planet" catchlight (all gaze-tracked), plus a thin glass dome capping the whole eye |
| Eye socket | Near-black (`#060810`) flat disc | Disc proud of body surface (Z > BODY_RADIUS), deeper interior color, framed by a matte-charcoal `TorusGeometry` bezel that catches the key light |
| Eyelids | Shader smoothstep on a flat disc | **3-D spherical-cap meshes** on pivots, sharing the body's vinyl material; counter-rotated against head pitch so projection stays stable during YES-nod gestures |
| Catchlight | None | One solid "planet" highlight per eye in the upper-right of the iris, parented to the gaze-tracking pupil group. Depth-tests against opaque lid geometry so lid closure naturally clips it, with an opacity fade on `pupilVis` for full-close cleanup |
| Sub-sphere material | `MeshBasicMaterial` (flat accent color) | `MeshStandardMaterial` with the vinyl gradient |
| Idle orbits | Single shared orbit phase | Two distinct crossing ellipses, tighter radius |
| Shadows | None | Sub-spheres cast eclipse shadows onto body (educational cue: planetary eclipses) |
| Trails | 42-point taper, always follows sub | 160-point buffer with downsampled writes + flat alpha body; wraps into a sparkle ring during steady idle orbit, reads as comet wake in breakaway sub-modes — one buffer, two natural visual reads (§4.1) |
| Backlight | None | Soft warm radial halo behind body — sells "luminous vinyl toy" without emissive on the matte material |
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
pipeline is modified via `onBeforeCompile`. The gradient axis is
**not** horizontal — the concept art shows a soft "warm top / cool
bottom" wash with a slight diagonal lean, mimicking natural lighting
from above. We project the object-space position onto a tilted unit
axis and mix:

```glsl
// uAxis ≈ (0.259, -0.966, 0.0) — 15° off vertical, warm side up
float g = clamp(dot(vObjSpacePos, uAxis) / uSpan * 0.5 + 0.5, 0.0, 1.0);
vec3 gradient = mix(uCool, uWarm, g);
diffuseColor.rgb = gradient;
```

`uAxis` is exposed on the bundle so future state-driven tweaks
(e.g. rotating the axis for a CONFUSED spiral) don't need a shader
recompile. `roughness: 0.5` and `metalness: 0.0` give the tactile
silicone catch-the-light feel. No textures — everything derives from
the two anchor uniforms.

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
| Eye group `.position.y` | `0` | `-0.012` (lower) |

### Recessed socket with 3-D bezel

The first-pass flat-disc eye read as "a sticker on a sphere." The
concept art's eye is a **real socket** — the character has a hole
in its face that the iris sits inside, framed by a 3-D bezel ring
that catches the key light. We match that structurally rather than
faking it with a shader.

```
eyeGroup (static, at face offset)
├── bezel         TorusGeometry at Z = BODY_RADIUS + 0.0003 (flush, slightly proud)
├── disc          socket-interior shader at Z = BODY_RADIUS - 0.0020 (RECESSED)
├── pupilGroup    (moves for gaze)
│   ├── irisGlow    Z = BODY_RADIUS - 0.0014   (additive accent halo)
│   ├── iris        Z = BODY_RADIUS - 0.0010   (accent ring, r=0.0112)
│   ├── pupilField  Z = BODY_RADIUS - 0.0008   (soft-edge navy, r=0.0096)
│   ├── stars[3]    Z = BODY_RADIUS - 0.0005   (white 5-point sparkles)
│   ├── pupilDot    Z = BODY_RADIUS - 0.0004   (near-black, r=0.0025)
│   └── catchlight  Z = BODY_RADIUS + 0.0048   (single "planet")
├── upperLidPivot  rotates X; carries upper lid cap
└── lowerLidPivot  rotates X; carries lower lid cap
```

**Bezel.** `TorusGeometry(EYE_PAIR_DISC_RADIUS + 0.001, 0.0018, 12, 32)`
with `MeshStandardMaterial({ color: 0x1a1620, roughness: 0.45 })`.
Sits flush with the body surface, framing the recess. The scene
key light rims the upper arc of the torus and drops the lower arc
into shadow; that top-vs-bottom contrast is what sells the 3-D
read. `receiveShadow = true` so it integrates with the rest of the
shadow cast by lids and subs. One material, two meshes.

**Recessed interior.** The socket disc sits at `BODY_RADIUS - 0.0020`
(inward of the body surface). The eye-field shader renders only the
socket interior — a dark-center, slightly-lifted-rim gradient — with
all lid logic removed. Iris, pupil, stars, and catchlights sit at
progressively deeper-then-shallower Z inside the socket, stacking
correctly in depth without any Z-fight tolerance tricks.

**Thinner iris ring, dominant pupil field.**

| Constant | First pass | Refined |
|---|---|---|
| `EYE_PAIR_IRIS_RADIUS` | `0.0108` | `0.0112` |
| `EYE_PAIR_PUPIL_FIELD_RADIUS` | `0.0080` | `0.0096` |
| Ring thickness | `0.0028` (~26 % of iris diameter) | `0.0016` (~14 %) |

Matches the concept art: a clean teal band around a dominant navy
pupil, not two stacked donut rings.

**Soft-edge pupil field.** The pupil field was a hard-edged
`MeshBasicMaterial` disc — a visible seam where it met the iris.
Now a small `ShaderMaterial` with a radial soft alpha:

```glsl
float a = uOpacity * (1.0 - smoothstep(0.82, 1.0, d));
```

The last 18 % of radius feathers into the iris color underneath;
reads as "liquid eye" rather than two stickers stacked.

**Iris color carrier.** The iris — not the pupil dot — carries the
palette accent and state-driven pupil color (SOLEMN blue, CONFUSED
amber, gesture flashes). The pupil dot stays near-black and scales
with `s.pupilSize` (SURPRISED still constricts the pupil to 0.55×
while the iris stays full).

### 3-D eyelid meshes (replaces shader lid)

The first pass drew lids with a shader `smoothstep` band on the
flat disc. That created two problems: (1) the lid couldn't escape
the disc's circular silhouette, so the lid had no "puff" — real
lids bulge outward from the body; (2) the crease-blend pulled the
palette accent into the lid zone, reading as saturated pink
eyeshadow. Both are gone now.

Lids are **3-D spherical caps** per eye, on their own pivots:

```ts
const lidGeometry = new THREE.SphereGeometry(
  LID_RADIUS,              // 1.10 × disc radius — slightly larger
  24, 8,                   // widthSegs, heightSegs
  0, Math.PI * 2,          // full azimuth
  0, Math.PI * 0.42,       // top 40% of a sphere = shallow dome
)
```

One geometry, shared across all four lid meshes (2 lids × 2 eyes).
Each lid's material is **the body's gradient `MeshStandardMaterial`
bundle** — the lid picks up the same warm→cool pigment, same matte
roughness, same specular, same shadow interaction as Orbit's skin.
Lid color therefore matches whatever body tone happens to sit
behind the eye. No more coordinating a separate `uBodyColor`
uniform with the palette.

Each lid lives under an `Object3D` pivot, positioned at the hinge:
upper pivot at `y = +0.88 × DISC_RADIUS`, lower at `-0.88 ×
DISC_RADIUS`, both at `z = BODY_RADIUS`. The dome sits at pivot
origin; rotating the pivot around X swings it through the eye's
plane like a real lid.

**Rotation angles (eased):**

| | Parked (lid = 0) | Closed (lid = 1) |
|---|---|---|
| Upper lid pivot | `-0.58 π` (rotated up, above brow) | `-0.12 π` (covers socket from above) |
| Lower lid pivot | `+0.58 π` (rotated down, below chin) | `+0.12 π` (covers socket from below) |

`updateCharacter` lerps each pivot's rotation toward the target
each frame (factor `0.25`) from `effectiveUpper` / `effectiveLower`
— which already combines `s.upperLid` + `blinkAmount`. No new state
plumbing.

**Shadows.** Each lid has `castShadow = true, receiveShadow = true`.
At partial closure, the key light drops a soft crescent shadow onto
the iris — the exact cue that sold the 3-D lid read in the concept
art reference.

**Cost.** `SphereGeometry(24, 8, 0, 2π, 0, 0.42π)` = ~130 tris × 4
lid meshes = **~520 extra triangles**, all sharing one geometry
buffer and the body's material bundle. Well inside Quest budget.

### Sparkle stars

Three tiny white five-point stars per eye, built from a shared
`BufferGeometry` (one triangle fan, 11 vertices). Positions are a
fixed per-eye table so the two eyes read as distinct "star charts"
but never shimmer between frames. Additive white, shared material
across both eyes.

### Catchlight ("planet")

A single soft-white disc per eye, parented to the gaze-tracking
`pupilGroup` (not the static eye group). Big anime-style rigs
track catchlights with the iris; a floating static highlight reads
as misaligned parallax under wide gaze. Normal blending (not
additive) so the disc reads as a solid "planet" gleam rather than
a luminance add that can wash out against a cream-vinyl lid at
head-rotation extremes.

| Offset (x, y) | Radius | Opacity |
|---|---|---|
| `+0.0034, +0.0034` | `0.00285` | `1.0` (gated per-frame by `pupilVis`) |

Both eyes share identical local offsets (no per-eye mirror) so the
highlight lands in the same screen-direction on both, consistent
with a single off-screen light source. The earlier mirror treatment
inverted the highlight across the face and read as "the two eyes
don't match." An earlier design also paired this with a secondary
sparkle in the lower-outer quadrant; that was retired in favor of
a tighter 3-star sparkle cluster in the lower-inner quadrant (one
5-pt centre + two smaller 4-pt flanking) — same "planet + stars"
composition the reference art carries, cleaner to read.

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

### 4.1 Trails wrap into rings during steady orbit

The concept-art reference shows bright sparkle rings wrapping Orbit
during idle. We deliberately **don't** render rings as separate
geometry — a separate ring wouldn't follow the satellite's actual
position when the sub breaks away for POINTING/TRACE/BURST, and
would misrepresent what's happening. Instead, the **same** trail
that comet-tails behind the sub during expressive modes is tuned
long enough that during steady idle orbit the rolling buffer wraps
all the way around the orbital path — reading as a closed sparkle
ring while still strictly following the sub's current position.

Tuning numbers:

| Parameter | Value | Rationale |
|---|---|---|
| `TRAIL_LENGTH` | `160` points | Was `42`. Long enough to cover most of an IDLE orbit period. |
| `TRAIL_WRITE_EVERY_N_FRAMES` | `2` | Downsamples the rolling-buffer shift. At 60 fps that's 30 writes/sec; 160 / 30 ≈ 5.3 s of coverage, close to the ~6.3 s IDLE orbit period. |
| Alpha profile | Head spike + flat body + soft tail fade | Was a linear `1 → 0` taper. A linear taper reads as a dimming spiral when it wraps; a flat profile with a gentle tail fade reads as a closed ring. Head spike keeps the sub's current position legible. |

When the sub is in idle-orbit sub-mode, the trail grows into a nearly
complete ring over ~5 seconds with a subtle bright spot marking the
current sub position. When the sub breaks into POINTING/TRACE/BURST,
the buffer still follows its current motion — now as a comet wake.
No state switching, no hidden geometry: one buffer, two natural
visual reads.

**Intensity** reads `expressionFor(state).trailIntensity` (part of
the shared EXPRESSIONS table in §5.1). New states inherit the
default (`0.80`, clearly visible) without edits. Per-state overrides:

| State | trailIntensity | Notes |
|---|---|---|
| _default_ | `0.80` | All unlisted states inherit this |
| `SLEEPY` | `0.25` | Barely-there wake, matches low-energy read |
| `SOLEMN` | `0.35` | Dim, reverent |
| `THINKING` | `0.30` | Subs cluster near body; little motion to trail |
| `CURIOUS`, `HAPPY` | `0.90-0.95` | Warm sparkle ring |
| `TALKING` | `0.95` | figure-8 sub-mode leaves a lemniscate wake |
| `POINTING`, `PRESENTING` | `1.10` | Trail IS the communication in these modes |
| `EXCITED` | `1.15` | burst sub-mode + bright trail |
| `SURPRISED` | `0.90` | Scatter wake |

**Color** still comes from `trailColorFor(state, palette)` — warm
off-white for idle / quiet register, palette accent for expressive.

Cost: 2 trails × 160 points = 320 points. Same sparkle shader as
before, same uniform writes per frame. Well inside Quest budget.

### 4.2 Backlight halo

A single additive disc parented to the head group, behind the body
(`z = -BODY_RADIUS * 0.8`), 3.2× body radius. Radial-gradient
shader fades from warm-white center to transparent rim. Sells
"luminous vinyl toy" without pumping emissive on the matte body
material (which would fight the vinyl look).

The color is **constant warm** across palettes — a palette-tinted
halo makes cool palettes read as sickly. Warm ambient light from
behind flatters every palette equally.

Cost: one `CircleGeometry(BODY_RADIUS * 3.2, 48)` + one
`ShaderMaterial`. No per-frame work; the disc faces +Z and all scale
presets put the camera at +Z, so no billboard math is needed.

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
  breathRate:     number   // cycles per second
  breathAmp:      number   // peak Y-scale offset (X/Z move inversely)
  meltXZ:         number   // extra XZ widening (sleepy/solemn)
  hopAmp:         number   // rhythmic Y hop (excited)
  surpriseGasp:   boolean  // one-shot spring on state entry
  talkPulse:      boolean  // subs pulse with pupil pulse
  trailIntensity: number   // sparkle trail brightness (§4.1)
}

export const EXPRESSION_DEFAULT: ExpressionConfig = {
  breathRate: 0.8, breathAmp: 0.012, meltXZ: 0, hopAmp: 0,
  surpriseGasp: false, talkPulse: false, trailIntensity: 0.80,
}

export const EXPRESSIONS: Partial<Record<StateKey, Partial<ExpressionConfig>>> = {
  SLEEPY:     { breathRate: 0.35, breathAmp: 0.018, meltXZ: 0.025, trailIntensity: 0.25 },
  SOLEMN:     { breathRate: 0.40, breathAmp: 0.015, meltXZ: 0.018, trailIntensity: 0.35 },
  EXCITED:    { breathRate: 2.4,  breathAmp: 0.006, hopAmp: 0.010, trailIntensity: 1.15 },
  SURPRISED:  { breathRate: 0.8,  breathAmp: 0.004, surpriseGasp: true, trailIntensity: 0.90 },
  THINKING:   { breathRate: 0.55, breathAmp: 0.014, trailIntensity: 0.30 },
  TALKING:    { talkPulse: true, trailIntensity: 0.95 },
  HAPPY:      { trailIntensity: 0.95 },
  CURIOUS:    { trailIntensity: 0.90 },
  POINTING:   { trailIntensity: 1.10 },
  PRESENTING: { trailIntensity: 1.10 },
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
