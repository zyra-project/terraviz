# Orbit Character — Integration Plan

Companion to [`ORBIT_CHARACTER_DESIGN.md`](ORBIT_CHARACTER_DESIGN.md) and
[`VR_INVESTIGATION_PLAN.md`](VR_INVESTIGATION_PLAN.md). The design doc and
the nine-iteration React prototype at `docs/prototypes/orbit-prototype.jsx`
(plus the self-contained demo at `docs/orbit-prototype.html`) established
the character. This plan covers getting that work into a deployable
artifact inside this repo — a standalone page viewable on our Cloudflare
Pages and Tauri builds, with a clean controller API so the docent AI can
eventually drive animation states.

**Branch:** `claude/orbit-character-integration-plan-p83Jc`

**Status:** plan only — no code changes yet.

---

## 1. Goals

1. Ship a **standalone `/orbit` page** on our existing deployments (web +
   desktop) that renders the Orbit character against the same glass-surface
   chrome as the main app.
2. Port the prototype's parametric motion to first-class TypeScript
   modules that live alongside other services, so they can be reused
   later by the VR scene (`vrScene.ts`) and potentially by a 2D corner
   avatar inside the main app.
3. Expose a small, stable **`OrbitController`** API (`setState`,
   `playGesture`, `setPalette`, `flyTo*`) so downstream code — starting
   with the standalone page's debug panel, eventually `docentService` —
   can drive animation state without knowing about Three.js.
4. Keep the main-app bundle size unchanged. The orbit page is its own
   Vite entry; non-visitors to `/orbit` never pay for Three.js or the
   character code.

Non-goals for this plan:

- The VR port. The intent is to write modules the VR phase can reuse,
  but `vrScene.ts` does not change here.
- Audio signature, data-reactive color, gesture chaining — all deferred
  in the design doc, still deferred.
- Replacing the existing chat UI. The standalone page is a viewer +
  debug surface, not a new chat surface.

---

## 2. Why a standalone page (not an overlay on the main app)

Three forcing functions:

- **Isolation for debugging.** Directors, designers, and the VR team
  want to look at the character without the globe, the chat panel, and
  the playback transport fighting for attention. A bare page at `/orbit`
  makes that trivial and shareable via URL.
- **No bundle cost for non-users.** Three.js and the character modules
  add ~200 KB gzipped. The main entry should not carry that weight for
  users who never touch Orbit. A separate Vite entry keeps them split.
- **Eventual embed, not eventual integration.** The long-term story is
  that Orbit lives *inside* the VR scene (per the design doc). The 2D
  web page is a stepping stone to prove out the controller API and let
  stakeholders see the character before the VR work lands. Building it
  as a standalone page first lets us refactor the internals freely;
  once the API stabilizes we can embed the same modules in the main
  app or in the VR scene without a second rewrite.

---

## 3. Architecture

### 3.1 File layout

```
src/
  orbit.html                           ← new Vite entry (second rollup input)
  orbitMain.ts                         ← page bootstrap
  styles/
    orbit.css                          ← page-scoped chrome (reuses tokens)
  services/
    orbitCharacter/
      index.ts                         ← public OrbitController API
      orbitScene.ts                    ← Three.js scene graph
      orbitStates.ts                   ← STATES table (port from .jsx)
      orbitGestures.ts                 ← GESTURES table (port from .jsx)
      orbitMaterials.ts                ← iridescent + pupil + trail shaders
      orbitFlight.ts                   ← Bézier flight + scale presets
      orbitTypes.ts                    ← StateKey, GestureKind, PaletteKey…
  ui/
    orbitDebugPanel.ts                 ← state/gesture/palette picker
docs/
  ORBIT_CHARACTER_INTEGRATION_PLAN.md  ← this file
```

`src/services/orbitCharacter/` is a directory, not a flat file, because
the module is large enough (the prototype is ~1400 LOC) that a single
file would be painful to review. It exports a single `OrbitController`
class from `index.ts`; everything else is internal.

### 3.2 Vite multi-page setup

Vite supports multiple HTML entries with `build.rollupOptions.input`.
Minimal change to `vite.config.ts`:

```ts
build: {
  rollupOptions: {
    input: {
      main: path.resolve(__dirname, 'src/index.html'),
      orbit: path.resolve(__dirname, 'src/orbit.html'),
    },
  },
  outDir: '../dist',
  // …existing
},
```

Output: `dist/index.html` (unchanged) and `dist/orbit.html` (new).
Three.js and orbit modules chunk separately; `index.html` does not
reference them.

### 3.3 Deployment

- **Cloudflare Pages (web):** `dist/orbit.html` ships with the rest.
  Add a line to `public/_redirects` so `/orbit` → `/orbit.html` (pretty
  URL). No Functions changes.
- **Tauri (desktop):** Tauri serves `dist/` over the app protocol.
  `orbit.html` is reachable at the same relative path. Add a small
  entry in the Tools menu — "Meet Orbit" — that opens the page in a
  new webview, or just a link; decision deferred.
- **Headers:** none special. The page uses the same origin as the main
  app, so the existing CSP and `_headers` rules apply.

### 3.4 Public `OrbitController` API

The controller is the only surface external callers see:

```ts
export interface OrbitController {
  // Persistent state — who Orbit is being.
  setState(state: StateKey): void              // Idle | Chatting | … | Confused
  getState(): StateKey

  // Transient overlay — fires once, returns to state.
  playGesture(kind: GestureKind): void         // Shrug | Wave | Beckon | Affirm
  isGesturePlaying(): boolean

  // Identity + scale.
  setPalette(palette: PaletteKey): void        // cyan | green | amber | violet
  setScalePreset(preset: ScaleKey): void       // close | continental | planetary

  // Flight.
  flyToEarth(featureLatLng?: LatLng): Promise<void>
  flyHome(): Promise<void>

  // Eye targeting — for Chatting/Talking/Pointing.
  setGazeTarget(worldPos: THREE.Vector3 | null): void

  // Lifecycle.
  dispose(): void
}
```

Two design rules carried from the design doc:

- **State-vs-gesture split is load-bearing.** `setState` replaces the
  current mood; `playGesture` plays on top and yields back. Callers
  never mix them.
- **External drivers set state + trigger gestures. They do not set
  pupil color, sub-sphere positions, or head rotation.** Those are
  derived.

### 3.5 Gesture overlay mechanics (preserved from design doc)

Each gesture's `compute(t, ctx)` returns a `GestureFrame` for
`t ∈ [0, 1]`. `t=0` and `t=1` return neutral positions so entry and
exit don't snap. Head ownership rule: if the gesture specifies
`head`, it owns head rotation for its duration; otherwise state head
motion continues. Ported verbatim from the prototype.

---

## 4. Page design (matches STYLE_GUIDE)

Layout — three regions, all glass surfaces:

```
┌──────────────────────────────────────────────┐
│  [⌂ back]              ORBIT                 │  ← top bar
│                                              │
│                                              │
│             [character canvas]               │  ← full-viewport canvas
│                                              │
│                                              │
│  ┌─ Debug ─────────────────────┐             │  ← collapsible debug panel
│  │ State:   [Idle ▾]           │               (bottom-left, like info panel)
│  │ Gesture: [Shrug] [Wave] ... │
│  │ Palette: ● cyan ○ green ... │
│  │ Scale:   [close|cont|planet]│
│  └─────────────────────────────┘
└──────────────────────────────────────────────┘
```

Token reuse from `STYLE_GUIDE.md`:

- Background: `#0a0a14` (already the prototype's; matches the loading
  screen's deep space tone).
- Panels: `rgba(13, 13, 18, 0.88)` + `blur(12px)` + 1 px border at
  `rgba(255, 255, 255, 0.08)`, radius 6–8 px.
- Typography: same `-apple-system` stack; titles at `font-weight: 300`,
  `letter-spacing: 0.15em`, uppercase.
- Active chip / segmented-control: `color: #4da6ff`,
  `border-color: #4da6ff`.
- Focus: the project-wide `:focus-visible` rule from the style guide.

Accessibility:

- The canvas gets `role="img"` and an `aria-label` that the controller
  updates when state changes (e.g., *"Orbit character, Chatting"*).
- State transitions also post to `#a11y-announcer` (same hidden live
  region used by the main app) so screen readers get the change.
- Keyboard navigation: each control in the debug panel is a real
  `<button>` or `<select>`; no divs-as-buttons.
- Respect `prefers-reduced-motion`: when set, the controller caps
  sub-sphere orbit speed, skips flashes, and disables flight
  animations (jumps straight to the destination).

Mobile (≤ 768 px): debug panel collapses to a single "Debug ▸" chip
in the top-right; tap to open a full-width drawer. Same pattern as
`chatUI`.

---

## 5. Porting the prototype → first-class modules

The prototype JSX is ~1400 lines; the standalone HTML demo is ~400
lines. The JSX copy in `docs/prototypes/` has Unicode fancy quotes
(`‘ ’`) rather than plain ASCII quotes because it was pasted from a
design tool — it will not compile as-is. Porting does a full rewrite
rather than a mechanical conversion:

**Phase 0 — wiring (no visual change).** Set up the Vite entry,
`orbit.html`, an empty `OrbitController` that spins a placeholder
sphere, and the CSS shell. Goal: ship at `/orbit` on a preview
deployment so reviewers see *something* before the animation work
lands.

**Phase 1 — body + eye + pupil + subs (Idle state only).** Port the
iridescent shader, flat-disc eye with lid-control shader, pupil +
glow, two sub-spheres orbiting. No state switching, no gestures.
Matches design doc commits 2–3.

**Phase 2 — state vocabulary.** Port the `STATES` table and the
per-state dispatch in the animation loop — sub-modes (orbit, figure8,
point, trace, cluster, burst, scatter, listening, nod, shake,
confused), lid control, pupil brightness / jitter / pulse, blink
scheduling. Debug panel gains the State select. Matches commits 5–7.

**Phase 3 — gestures.** Port the `GESTURES` table (Shrug, Wave,
Beckon, Affirm), the `playGesture()` entry point, the head-ownership
rule, the pupil-flash envelope. Debug panel gains gesture buttons.
Matches commit 8.

**Phase 4 — flight + scale presets.** Port the Bézier flight, the
three scale presets (close / continental / planetary), the parking
spot + feature location math. Add a dim wireframe Earth for context
(the HTML demo already has one). Debug panel gains the scale
segmented control and a *Fly to Earth* button. Matches commit 4.

**Phase 5 — palette + pupil tint.** Port the four palettes and the
state-pupil-tint blend system. Debug panel gains the palette
radio-group. Matches part of commit 6.

Each phase is a separate PR. Phase 0 is the one that unblocks
previewing; phases 1–5 are incremental and can be reviewed without
stepping on each other.

### Mobile-line-width gotcha (from design doc)

Trails use `THREE.Points` with a custom point-sprite shader, **not**
`THREE.Line` / `Line2`. The HTML demo currently uses `THREE.Line`
because the demo is desktop-only; when we port, we switch to Points.
This is explicitly called out so the porter doesn't propagate the
demo's shortcut.

---

## 6. Eventual AI integration (Phase 6, out of scope here)

The current `docentService` already streams chunks with typed
discriminators (`delta`, `action`, `auto-load`, `done`). The natural
bridge is a new subscriber on the stream that maps chunk → state /
gesture:

| Stream event                     | Orbit reaction                       |
|----------------------------------|--------------------------------------|
| User submits message             | `setState('LISTENING')`              |
| First `delta` chunk arrives      | `setState('TALKING')`                |
| `action` chunk (dataset load)    | `playGesture('beckon')`              |
| `auto-load` chunk                | `playGesture('affirm')`              |
| `done` with fallback             | `setState('CONFUSED')` briefly       |
| `done` normal                    | `setState('CHATTING')`               |
| Long latency before first delta  | `setState('THINKING')`               |

Emotional register (`Solemn`, `Curious`, `Excited`) is harder — it
needs content valence, which the LLM would have to emit. One cheap
option: a new `<<MOOD:SOLEMN>>` inline marker the way we already
handle `<<LOAD:...>>` markers. `docentContext.ts` prompt gains a
short line explaining the vocabulary; `docentService.extractActions
FromText()` parses the marker into a new `mood` stream chunk.

That work is Phase 6 and gets its own plan doc when we pick it up.
The point of this plan is to get the controller API right so Phase 6
is small.

A second near-term integration path: the **controller exposes a
`postMessage` bridge** on `window`. When Orbit is iframed into
another page or addressed from the Electron/Tauri parent, callers
post `{ type: 'orbit:setState', state: 'TALKING' }` and the
controller responds. This unblocks the team from wiring the AI
before the main-app embed lands.

A URL-param driver — `/orbit?state=TALKING&gesture=affirm&palette=amber`
— goes in alongside for smoke testing and for capturing screenshots
of specific states.

---

## 7. Risks & mitigations

- **Three.js version drift.** The main app already depends on
  `three@^0.183.2` for VR. The orbit modules use the same version;
  they chunk separately but resolve to one library. No dual-version
  hazard.
- **Shader portability.** The iridescent body shader is GLSL ES 3.0
  and runs on Quest; desktop WebGL2 is a superset. Tested in the
  HTML demo on Chrome and Safari — both fine. iOS Safari has a
  history of `precision highp float` issues in fragment shaders —
  add explicit precision qualifiers when porting.
- **Performance on low-end mobile.** The prototype targets Quest
  (roughly a 2018-era mobile GPU). Phones in the same class will
  struggle at `devicePixelRatio > 2`. Cap `renderer.setPixelRatio()`
  at 1.5 on mobile detection; acceptable visual hit.
- **`prefers-reduced-motion`.** The design relies on motion for most
  of its legibility. When reduced motion is requested, we keep the
  character visible but lock into Idle-at-half-speed and suppress
  gesture + flight. Document this as an explicit trade-off.
- **Prototype code quality.** The JSX has fancy quotes, nested
  ternaries, and single-file everything. Direct translation would
  make reviewers miserable. We port by rewriting into the module
  layout in §3.1 — the design doc and the prototype are the specs;
  the prototype source is reference-only.

---

## 8. Phase commit breakdown

| #  | Commit                                                                  | Surfaces                                            |
|----|-------------------------------------------------------------------------|-----------------------------------------------------|
| 0  | `docs: orbit character integration plan (this file)`                   | Plan — no code                                      |
| 1  | `orbit: vite entry + empty OrbitController at /orbit`                   | Vite config, `orbit.html`, shell page + CSS         |
| 2  | `orbit: body + eye + pupil + sub-spheres (Idle)`                       | `orbitScene`, `orbitMaterials`, basic render loop   |
| 3  | `orbit: state vocabulary + sub-modes + blink scheduling`                | `orbitStates`, state dispatch, debug State select   |
| 4  | `orbit: gesture overlay system + Shrug/Wave/Beckon/Affirm`             | `orbitGestures`, `playGesture`, gesture buttons     |
| 5  | `orbit: flight + scale presets + wireframe Earth context`              | `orbitFlight`, Fly button, scale control            |
| 6  | `orbit: palettes + pupil tint blend`                                    | Palette radio group, tint easing                    |
| 7  | `orbit: a11y polish — reduced motion, aria-label, announcer`            | `prefers-reduced-motion`, live region wiring        |
| 8  | `orbit: postMessage bridge + URL-param driver`                          | `window` bridge, URL parser for smoke tests         |
| 9  | `orbit: Tools-menu entry + _redirects for /orbit pretty URL`            | Link into the main app, CF redirect                 |

Roughly 600–800 LOC across phases 1–8, heavily dominated by the
state + gesture tables ported from the design doc. Phase 9 is
trivial.

Phase 6 (AI-driven state) lands separately with its own plan once
this shell is in place.

---

## 9. Open questions

1. **Does the desktop app get a Tools entry for Orbit, or is it
   web-only for now?** Leaning web-only for the first cut — the
   desktop story is VR-embedded Orbit, not a separate viewer page.
2. **Should the page be indexable by search engines?** Probably no —
   add `<meta name="robots" content="noindex">` until the feature
   is announced. Easy to remove later.
3. **Where does `/orbit` link from in the main app?** Options: a
   small entry in the Help panel's Guide tab; a footer link; or
   nowhere until the AI wiring lands. Leaning *nowhere* — this is
   an internal/preview surface first.
4. **Do we need server-side state persistence?** No. The page is
   stateless; URL params are the only durable driver.
