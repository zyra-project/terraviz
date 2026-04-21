# Orbit Character Design

Companion document to `VR_INVESTIGATION_PLAN.md` — fleshes out the
character design for Phase 4 (Orbit avatar). Supersedes the original
design direction with decisions informed by nine prototype iterations.

**Status:** design committed, prototyped, and ported. The production
implementation lives in `src/services/orbitCharacter/` and renders
at `/orbit`. A self-contained HTML demo (no build step needed) is
kept at `docs/orbit-prototype.html` for design-review sharing.

-----

## Summary

Orbit is a small glowing sphere (~15 cm at chat distance) with a
single inset lens-eye and two tiny companion sub-spheres that orbit
its body. Personality comes from parametric motion systems — pupil
state, head-group orientation, and sub-sphere behavior — running on
procedural geometry. **No rigged glTF, no Mixamo, no
`AnimationMixer`.**

The character is thematically recursive (spheres orbiting a sphere
orbiting Earth), which doubles as the scale lesson Phase 4 calls out
as the point of the avatar at all.

The vocabulary is rich: 14 states across behavior, emotion, and
head-gesture registers; four overlay gesture actions; three scale
presets that demonstrate planetary scale viscerally. Color is used
restrainedly, carrying tonal register where body language can’t.

-----

## Design constraints (from Phase 4)

Rehashed so this doc is self-contained:

1. **The avatar teaches planetary scale.** Readable at arm’s length
   AND as a speck next to a continent. Primary constraint; drives
   silhouette more than style.
1. **Non-humanoid** to dodge uncanny valley, but the specified
   behaviors — eye contact, talking, pointing, waving — are social
   signals. That’s a tension; this doc resolves it.
1. **Quest GPU budget** — under 5K tris, mobile-tier shaders only.
1. **Works in both VR (void) and AR (your kitchen table).**
1. **Both audiences — museum families AND professional visitors**
   (researchers, IHO delegates). No condescension, no saccharine
   proportions.

-----

## Key insight

The social-signal question is not “humanoid or not.” It is *which
abstracted feature carries each signal.*

|Signal                 |Candidate abstractions        |Pick                                       |
|-----------------------|------------------------------|-------------------------------------------|
|Eye contact            |Lens, iris, glowing point     |Single inset lens with animated pupil      |
|Attention / orientation|Body rotation, “head tilt”    |Head-group orientation toward target       |
|Speech                 |Mouth, display, light pulse   |Pupil brightness pulse + sub-sphere tempo  |
|Gesture (point, wave)  |Arms, tentacles, light ribbons|Sub-sphere break-and-fly                   |
|Idle / alive           |Breathing, bobbing            |Constant sub-sphere orbit + slow body sway |
|Emotional register     |Color, expression, posture    |Pupil tint (restrained) + sub-sphere rhythm|

One feature carries each signal. Nothing has to be a humanoid analog.
The gap between minimal form and emotional behavior is what reads as
“charming character” instead of “off-putting thing” — same trick
Wall-E, EVE, BB-8, Luxo Jr., and Baymax all use.

-----

## Design decisions

### Body

Smooth sphere, ~15 cm radius at chat distance. Not featureless:

- **Iridescent shader** — fresnel term + shifting hue gradient over
  a pearl base. Aurora-hued rim. ~30 lines of GLSL, cheap on Quest.
  Prototyped and working.
- **Do NOT mimic Earth’s continents.** Earth is the globe; Orbit is
  Earth’s companion, not a second Earth.

### The eye

A single circular field on the front of the body, ~1/3 the body
diameter. Implementation evolved across prototype iterations:

- **Flat disc with shader-driven lid control**, not inset mesh
  geometry. A circle mesh sits flush with the body surface, and the
  fragment shader computes lid coverage from `uUpperLid` and
  `uLowerLid` uniforms. When a pixel is “covered” by a lid, it
  renders in body color — the effect reads as skin folding over the
  eye, with no visible seam.
- **Three-layer structure** — dark socket (shader), bright pupil
  disc (additive-blended), glow halo around pupil (additive).
- **Pupil position** — tracks user head in CHATTING, target in
  PRESENTING, destination during flight.
- **Pupil size + brightness** — dilated and pulsing = speaking;
  small and dim = sleepy/solemn; jittery = confused or excited.
- **Pupil color** — baseline is palette accent; states can carry
  their own tint (see Color semantics); gestures can flash.

The flat-disc approach is simpler than inset geometry, runs faster
on Quest, and gave us the lid-as-skin-folding behavior for free.

### Head group

Body + eye live in a `THREE.Group` (the “head”). Nod, shake, and
tilt motions rotate the group as a unit; sub-spheres live outside
the group and follow Orbit’s world position but not the head’s
rotation. This lets gestures rotate the head independently without
the sub-spheres tumbling.

### Sub-spheres — the orbiting companions

**Commit: two sub-spheres.** Three adds visual noise at distance
and fights the scale lesson. Two is enough to signal role
specialization (one indicates, one holds) during point/trace modes.

Sub-spheres are ~1 cm, emissive, in palette-accent color. Each has
a per-frame `effSubMode` drawn from a vocabulary:

|Mode       |Usage           |Shape                                                 |
|-----------|----------------|------------------------------------------------------|
|`orbit`    |Idle, Chatting  |Steady circular orbit around body                     |
|`figure8`  |Talking         |Lemniscate paths, subs crossing in opposite directions|
|`point`    |Pointing        |Sub 0 arcs to target and parks; sub 1 tucks close     |
|`trace`    |Presenting      |Sub 0 traces a lumpy oval around target; sub 1 tucks  |
|`cluster`  |Thinking, Solemn|Subs drift below body, slow                           |
|`burst`    |Excited         |Rhythmic pulse outward and back                       |
|`scatter`  |Surprised       |Subs freeze at wide radius                            |
|`listening`|Listening       |Subs tuck behind body, out of the way                 |
|`nod`      |Yes             |Subs bob in sync with head nod                        |
|`shake`    |No              |Subs translate side-to-side with head shake           |
|`confused` |Confused        |Subs run at different paces, drift out of sync        |

During gesture overlays, sub-sphere mode yields to the gesture’s
own positioning (see Gesture overlay system below).

### Trails

Emissive fade-trailing particle streams behind sub-spheres, used in
Pointing, Presenting, Talking, and during flight between chat and
Earth distances.

**Implementation note, learned the hard way:** `THREE.Line` /
`Line2` draw at 1 pixel width on mobile GPUs regardless of requested
line width. Trails use `THREE.Points` with a custom point-sprite
shader — circular fade, distance-scaled point size, additive
blending. Per-trail size attribute gives the tail-taper shape.

### Palette

Four palettes are shipped; **cyan is the baseline.**

- **cyan** — pearl base, aurora-cyan accent. Orbit’s identity.
- **green** — aurora-green variant, for SOS-green contexts.
- **amber** — warm variant, for sunset/dusk lighting tests.
- **violet** — cool variant, experimental.

The palette controls body iridescence, sub-sphere color, pupil
baseline, trail color, and target-marker color. Choosing palette is
a content-level decision (which environment is Orbit in?), not an
emotional one. Emotional register goes through pupil tint instead
(see Color semantics).

### Proportions and tone

Aim for: emotionally legible minimalism, restrained palette, dignity
in proportions.

Cut, if any choice smells “designed for kids”:

- Bobble-head proportions
- Primary colors
- Googly eyes
- Saccharine curves
- Any feature that reads as “mascot” before it reads as “character”

The move for the “works for 5-year-olds AND 50-year-olds” brief is
warm-specific, not cute-generic. Professionals tolerate charm; they
don’t tolerate condescension.

-----

## Scale presets

Phase 4 demands that the avatar *teach planetary scale*. The
prototype validated this with three presets, each repositioning
Earth and the camera to sell a different scale register:

|Preset       |Earth radius|Earth distance|Lesson                                   |
|-------------|------------|--------------|-----------------------------------------|
|`close`      |0.22 m      |~1.1 m        |Companion scale — a tabletop planet      |
|`continental`|1.1 m       |~3.9 m        |Orbit shrinks to state-sized beside Earth|
|`planetary`  |4.0 m       |~13 m         |Orbit shrinks to a speck beside a world  |

Each preset includes an Earth center position, camera position,
field of view, parking spot on Earth’s near side, feature location
for Pointing/Presenting, and flight duration/arc height scaled to
the distance. A `Fly to Earth` button plays a Bézier arc from chat
position to parking spot; return flight reverses.

**The visceral moment** happens in the `planetary` preset: watching
a 15 cm companion shrink to ~0.7° of arc through pure perspective
is what makes “Earth is big” stop being abstract.

In the 2D prototype, camera FOV widens and position pulls back at
far presets to approximate what a VR headset’s native wide FOV
would deliver. In the actual VR port, keep the Earth
positions/sizes but drop the camera moves — the Quest handles
framing.

-----

## Gesture overlay system

States (Behavior/Emotion/head-gesture) describe Orbit’s persistent
mood and posture. **Gestures are transient events that play over
whatever state is active, then yield control back.**

API shape:

```typescript
type GestureContext = {
  direction: THREE.Vector3;     // unit vector from head to active target
  featureIsAtEarth: boolean;
};

type GestureFrame = {
  subSpheres: Array<{ x: number; y: number; z: number }>; // head-relative
  head?: { pitch?: number; yaw?: number; roll?: number };
  pupilColor?: string;          // optional transient tint
  pupilFlash?: number;          // 0..1 — envelope for the flash
};

type Gesture = {
  label: string;
  duration: number;             // seconds
  compute: (t: number, ctx: GestureContext) => GestureFrame;
};

orbit.playGesture(kind);        // single entry point
```

Each gesture’s `compute` takes a normalized `t ∈ [0, 1]` and
returns a frame. Design convention: at `t = 0` and `t = 1`, the
gesture returns roughly-neutral positions so entry and exit don’t
snap. Peak shape lives in the middle.

Shipped gestures:

|Gesture|Duration|Shape                                                         |
|-------|--------|--------------------------------------------------------------|
|Shrug  |1.4 s   |Both subs rise and spread, head chin-up, subtle sway          |
|Wave   |1.8 s   |One sub swings side-to-side raised high, other tucks          |
|Beckon |1.6 s   |Extending sub reaches toward `ctx.direction`; head turns along|
|Affirm |0.9 s   |Small nod + gold pupil flash; “mm-hm” acknowledgment          |

**Head ownership rule:** if a gesture specifies `head`, it owns
head rotation entirely for its duration. State-driven head motion
(Yes’s nod, No’s shake, Confused’s tilt) eases toward zero so when
the gesture ends, state head resumes from rest instead of snapping
to mid-motion. Gestures that don’t specify `head` leave state head
alone — a Wave during Yes continues nodding while the sub waves.

Gestures that read `ctx.direction` (currently Beckon) become
meaningful at any scale: at chat distance the extending sub reaches
toward `CHAT_FEATURE`; at Earth it reaches toward the continent
being discussed.

-----

## Color semantics

Color use is restrained and layered. Three tiers, in priority order:

1. **Palette accent** — baseline for body/subs/pupil/trails. Orbit’s
   identity. Body and sub-spheres ALWAYS stay on palette accent.
1. **State pupil tint** — a state may carry its own pupil color,
   applied as a partial blend (65%) over palette accent. Used
   sparingly: Solemn (`#7db5e8` cool blue), Confused (`#d9a85c`
   muted amber). Emotional register that body language alone
   can’t carry.
1. **Gesture pupil flash** — a gesture may specify a pupil color
   plus a flash envelope (`pupilFlash: 0..1`), transient over the
   gesture’s duration. Used for Affirm’s gold “mm-hm” flash.

Frame-to-frame easing on the pupil color keeps transitions soft.

**What color does NOT do:**

- Does not change body color. Orbit’s identity stays cyan.
- Does not change sub-sphere color. They share body identity.
- Does not map to traffic-light semantics (green=yes, red=no).
  Culturally loaded; accessibility-hostile to red-green colorblind
  viewers; and redundant with head motion that already says yes/no.

The rule: **color carries what body language can’t.** Shrug is
legible from motion alone and needs no color. Solemn is a tonal
register that motion alone muddles — the cool-blue eye sells the
gravitas. Affirm’s flash is a grace-note of warmth on an otherwise
small motion. Build color in where it earns its keep, not as a
default channel.

-----

## State and gesture catalog

Fourteen states across three registers, plus four overlay gestures.

### Behavior states

Who Orbit is being — the baseline interaction posture.

|State     |Sub-mode |Eye/pupil                                |
|----------|---------|-----------------------------------------|
|Idle      |orbit    |Wandering gaze, periodic blinks          |
|Chatting  |orbit    |Tracks user head, pupil dilated          |
|Listening |listening|Subs tucked, pupil attentive, slow blinks|
|Talking   |figure8  |Pupil pulses with speech, gaze on user   |
|Pointing  |point    |Pupil on target, lids slightly narrowed  |
|Presenting|trace    |Pupil on target, trace oval at feature   |
|Thinking  |cluster  |Subs drift below, gaze inward/up         |

### Emotion states

How Orbit feels about what it’s doing.

|State    |Sub-mode|Distinguishing cues                                |
|---------|--------|---------------------------------------------------|
|Curious  |orbit   |Wide pupil, slight jitter, wandering gaze          |
|Happy    |orbit   |Slight squint (lower lid up), frequent blinks      |
|Excited  |burst   |Fast orbit, large jitter, rhythmic sub-sphere burst|
|Surprised|scatter |Subs frozen wide, pupil sharp-small, held-open eye |
|Sleepy   |cluster |Heavy upper lid, dim pupil, very slow rhythm       |
|Solemn   |cluster |Hooded eye, cool-blue pupil tint, slow             |
|Confused |confused|Asymmetric subs, head tilt, amber pupil tint       |

### Head-gesture states

Dwell-able full-body responses.

|State|Head motion   |Sub-mode|
|-----|--------------|--------|
|Yes  |Rhythmic nod  |nod     |
|No   |Rhythmic shake|shake   |

### Overlay gestures

Transient, returnable. See Gesture overlay system above.

- Shrug, Wave, Beckon, Affirm.

-----

## Why this works

- **Scale lesson lands without tricks.** The recursive-scale visual
  does double duty — the tiny thing orbiting the tiny thing orbiting
  the big thing is you. Planetary preset sells it viscerally.
- **No rig, no Mixamo.** All motion is parametric — roughly a dozen
  animated values across the whole character. No glTF skeleton, no
  `AnimationMixer`, no import toolchain.
- **Silhouette survives distance.** Spheres read cleanly at any
  size; sub-spheres degrade gracefully from companions → tracer dots
  → implied motion.
- **Thematically exact.** Spheres orbiting a sphere on a project
  literally called `interactive-sphere`, with a docent character
  named “Orbit” whose name implies orbital motion.
- **Eye contact is both literal and metaphorical.** Pupil tracks the
  user’s head (literal); whole head-group orients toward them
  (metaphorical). Both reinforce.
- **Dodges uncanny valley structurally.** No mouth to desync, no
  hands to miscount, no face to mis-proportion. Minimalist by
  construction.
- **Vocabulary matches content register.** Solemn for hurricane
  content, Curious for exploration, Confused for parse failures,
  Excited for discovery moments.

-----

## Implementation sketch

### Scene graph

```
Scene
├── Head (Group) — body + eye, rotates as unit for gestures
│   ├── Body (IcosahedronGeometry + iridescent ShaderMaterial)
│   └── EyeGroup (rotates for pupil tracking)
│       ├── EyeDisc (CircleGeometry + lid-control ShaderMaterial)
│       ├── PupilGlow (CircleGeometry + additive MeshBasicMaterial)
│       └── Pupil (CircleGeometry + MeshBasicMaterial)
├── SubSphere[0] (IcosahedronGeometry + MeshBasicMaterial)
├── SubSphere[1] (IcosahedronGeometry + MeshBasicMaterial)
├── Trail[0] (THREE.Points + custom point-sprite ShaderMaterial)
├── Trail[1] (THREE.Points + custom point-sprite ShaderMaterial)
└── TargetMarker (Sphere + halo ring, used in Pointing/Presenting)
```

### Motion systems

Five loosely coupled per-frame computations:

1. **State advancement** — read current state config, ease
   smoothing values (orbit speed, sub radius) toward targets.
1. **Flight** — if in flight, evaluate Bézier position at time-`t`,
   otherwise hold chat or parking position.
1. **Eye** — resolve gaze target (user head / active target /
   flight destination / wander), ease eye-group rotation, apply
   blink + lid values, compute pupil color blend.
1. **Head** — resolve head motion source (gesture override / state
   nod/shake/tilt / rest), ease to target.
1. **Sub-spheres** — if gesture active, apply gesture frame;
   otherwise dispatch on `effSubMode` and compute head-relative
   positions. Update trails from sub positions.

### Parameter shape

```typescript
interface OrbitParams {
  // State
  state: StateKey;              // behavior | emotion | head-gesture
  gesture: GestureKind | null;  // transient overlay
  palette: PaletteKey;
  scalePreset: ScaleKey;        // close | continental | planetary

  // Flight
  flightMode: 'rest' | 'out' | 'atEarth' | 'back';

  // Runtime derived (not for external drivers)
  pupilColor: Color;
  headRotation: Euler;
  subSpherePositions: Vector3[];
}
```

External drivers (the docent AI, dialogue system) only set `state`,
trigger `playGesture(kind)`, and call `flyToEarth()` /
`flyHome()`. Everything else is internal.

-----

## State machine integration

Reuses and extends the state machine in `VR_INVESTIGATION_PLAN.md`.
The original plan’s five high-level states map to combinations of
the richer vocabulary:

|Plan state |`OrbitParams` driving                                          |
|-----------|---------------------------------------------------------------|
|ORBITING   |`state=Idle`, distant idle circuit around Earth, slow body sway|
|APPROACHING|Bézier flight; sub-spheres trail; eye eager                    |
|CHATTING   |`state=Chatting` or `Listening`; pupil tracks user             |
|PRESENTING |`state=Presenting`; scalePreset appropriate to content         |
|RETURNING  |Bézier flight back; sub-spheres re-converge                    |

Emotional states (Solemn, Curious, Excited, Confused) layer on top
of the plan’s states — the docent AI selects them based on content
valence and input quality. Overlay gestures fire from dialogue
beats (“Orbit acknowledges” → Affirm; “Orbit invites user to
look” → Beckon with direction to target).

-----

## Phase 4 commit breakdown

Revised from the original plan’s 8 commits to reflect the
procedural-only design plus the richer vocabulary.

|# |Commit                                                                                           |Scope                                                                           |
|--|-------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------|
|1 |`docs: orbit character design (this file)`                                                       |Meta; link from plan                                                            |
|2 |`vrAvatar: procedural body + eye + pupil`                                                        |Icosahedron body, flat-disc eye with lid shader, pupil + glow. No motion yet.   |
|3 |`vrAvatar: head group + sub-sphere orbit system (Idle)`                                          |Two sub-spheres circling, head group for independent rotation.                  |
|4 |`vrAvatar: flight system + scale presets`                                                        |Bézier out/back, three scale presets, parking/feature computation.              |
|5 |`vrAvatar: behavior states + chat gaze (Chatting/Listening/Talking/Pointing/Presenting/Thinking)`|Full behavior vocabulary. Pupil tracks user; sub-mode dispatch.                 |
|6 |`vrAvatar: emotion states + color semantics`                                                     |Curious/Happy/Excited/Surprised/Sleepy/Solemn/Confused. Pupil tint blend system.|
|7 |`vrAvatar: head-gesture states (Yes/No) + tilt mode`                                             |Nod/shake/tilt head motions; corresponding sub-sphere modes.                    |
|8 |`vrAvatar: gesture overlay system + Shrug/Wave/Beckon/Affirm`                                    |`playGesture()` API; head ownership rule; directional gesture context.          |
|9 |`docentService: location hints + state selection`                                                |Emit lat/lng + emotional register from content; avatar consumes.                |
|10|`vrAvatar: polish + tuning`                                                                      |Flight curves, palettes, trail tuning, pupil easing constants.                  |

Roughly 400–500 LOC across the whole phase (up modestly from the
original 300–400 estimate, reflecting the richer vocabulary).
Still well under the original plan’s rigged-glTF pathway.

-----

## Narrative for leadership

> *Orbit is the companion character for GSL’s Interactive Sphere VR
> experience — a small, friendly presence that accompanies visitors
> as they explore NOAA’s science on a virtual Science On a Sphere.
> Designed as a glowing pocket-sized sphere with its own two tiny
> orbital companions, Orbit is both mascot and teacher: it flies up
> to greet a visitor when addressed, looks at what’s being
> discussed, and reacts with the kind of subtle body language that
> reads as understanding without requiring a human face. Ask Orbit
> about a place on Earth — “show me Hurricane Katrina,” “where is
> the Gulf Stream?” — and it journeys across the virtual globe to
> the location. As Orbit recedes from arm’s length to the Earth’s
> surface, visitors viscerally feel planetary scale: the friend in
> their hand becomes a tiny speck beside a continent.*

> *The character was prototyped end-to-end before any production
> code was written. Nine iterations established a rich vocabulary —
> fourteen emotional and behavioral states, four gesture overlays,
> three scale presets — all driven by parametric motion on roughly
> 5000 triangles. No motion-capture, no rigged model, no third-party
> pipeline. Color is used restrainedly: Orbit’s cyan identity stays
> constant; tonal register (solemn for grave content, confused for
> parse errors) comes through the eye alone. The result is a
> character that works for a family learning about weather, a
> researcher asking about model resolution, and an IHO delegate
> reviewing hydrographic data — without condescending to any of
> them. Behind Orbit is the existing docent AI, now embodied: a
> guided visit with a knowledgeable friend, in a medium visitors
> can take home.*

Adapt per audience: GSL leadership, NOAA Generative AI Working
Group, SOS team, IHO delegates, invention disclosure prose.

-----

## Open questions (and decisions made)

Questions from the original doc, now resolved:

- ~**Number of sub-spheres: 2 or 3?**~ Committed to two. Three
  adds noise at distance and fights the scale lesson.
- ~**Trails — always or state-gated?**~ State-gated: only
  Pointing, Presenting, Talking, and during flight. And implemented
  via `THREE.Points`, not `Line2` (mobile-line-width gotcha).
- ~**Color identity.**~ Cyan is baseline; other palettes reserved
  for context switches. Emotional register moves to pupil tint, not
  body.
- ~**Resting state.**~ Keeps orbiting, just slower. Idle state.

Still open:

1. **Audio signature.** A subtle hum + bell-like chime on state
   transitions? Pairs well with Phase 5 spatial audio work. Not
   blocking for Phase 4.
1. **Atmosphere z-fighting.** Verify sub-sphere trails don’t
   z-fight with the globe’s atmosphere rim during tracing.
   Mitigation: `depthWrite: false` and render-order tweak.
1. **2D fallback.** The plan’s “simplified 2D avatar” is deferred.
   This procedural design ports cleanly — the same parametric motion
   runs on a small overlaid WebGL canvas alongside MapLibre. Worth
   keeping in mind for a future Phase 4.5.
1. **Data-reactive color.** Future hook: sub-spheres could briefly
   tint to match the colormap of data Orbit is discussing (SST
   palette when showing ocean temperature, radar palette for
   precipitation). This is a cross-pollination from data-viz
   vocabulary into character design. Not in scope for Phase 4, but
   the color-blend system already shipped supports it.
1. **Gesture chaining / interruption.** Currently one gesture plays
   at a time and new triggers are ignored. Could allow interrupts
   or composition (point-then-beckon). Deferred pending real use
   cases from the docent dialogue layer.
