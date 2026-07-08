# Orbit wake-word ("Hey Orbit") — setup, models & training

Status: **draft for review.** Wake-word (Phase 3.5 of
[`ORBIT_VOICE_PLAN.md`](ORBIT_VOICE_PLAN.md)) lets a visitor arm
hands-free listening by speaking a phrase instead of tapping the mic.
It runs **entirely on-device** via [openWakeWord](https://github.com/dscripka/openWakeWord)
ONNX models — audio never leaves the machine until a wake fires and a
real turn begins.

This doc is the operator runbook: which model files to host, how to
point the app at them, and how to replace the built-in `hey jarvis`
phrase with a custom **"Hey Orbit"** model later.

> **⚠️ Validation status.** The browser pipeline
> (`src/services/voiceWakeWordOnnx.ts`) is a faithful port of
> openWakeWord's documented tensor shapes, but it has **not been
> validated against real models or hardware** in CI (there's no mic or
> model in CI). Run the on-device checklist (§4) before any exhibit
> use.

---

## 1. How it works

```
16 kHz mono mic audio  (Web Audio, 80 ms / 1280-sample chunks)
  → melspectrogram.onnx   audio → 32-bin mel frames, normalised x/10 + 2
  → embedding_model.onnx  76 mel frames × 32 → 96-dim embedding (stride 8)
  → <wake>.onnx           16 embeddings → score 0..1
  → WakeWordDetector      threshold + debounce + cooldown → onWake
```

- `voiceWakeWord.ts` — the pure `WakeWordDetector` (score → wake) and
  the `startWakeWord` composition. No ONNX, fully unit-tested.
- `voiceWakeWordOnnx.ts` — the openWakeWord ONNX backend. Selected
  automatically when `modelBaseUrl` is configured.

`onnxruntime-web` is **lazy-imported from a CDN** (default
`jsdelivr`) the first time wake-word starts — there is **no npm
dependency** and nothing in the main bundle. For an offline kiosk,
self-host onnxruntime-web and set `ortUrl` (§3).

---

## 2. Model files to host

Host these three files at one base URL (`modelBaseUrl`) — e.g. an R2
bucket, a CDN, or `public/wakeword/` in this app:

| File | What | Source |
|---|---|---|
| `melspectrogram.onnx` | Shared audio → mel-spectrogram front-end | openWakeWord release (Apache-2.0) |
| `embedding_model.onnx` | Shared Google speech-embedding model | openWakeWord release (Apache-2.0) |
| `hey_jarvis_v0.1.onnx` | The wake phrase classifier | openWakeWord release (**CC BY-NC-SA 4.0**) |

Download them from the
[openWakeWord releases](https://github.com/dscripka/openWakeWord/releases)
(the Python package's `openwakeword.utils.download_models()` fetches
the same files). Total size is a few MB.

> **License caveat.** The shared front-end models are Apache-2.0, but
> the **pretrained wake classifiers (incl. `hey jarvis`) are CC
> BY-NC-SA 4.0 (NonCommercial)** because of their training data.
> Confirm this is acceptable for the NOAA SOS install (a nonprofit /
> educational exhibit very plausibly qualifies, with attribution +
> share-alike) before shipping — or train your own model (§5), which
> also gets you the branded "Hey Orbit" phrase and a license you own.

---

## 3. Pointing the app at the models

### 3.1 Enabling the hands-free mode (operators)

The chat's hands-free picker (Tools → Orbit → Settings → **Hands-free**)
only offers the **"Wake word"** option once a deploy has configured the
model URL. The label is phrase-neutral on purpose: the phrase a visitor
must say is whatever the configured model detects — the built-in default
is **"Hey Jarvis"**, and a branded **"Hey Orbit"** needs a custom model
(§5). Set these **build-time** env vars (they're
`VITE_`-prefixed, so they're baked into the bundle at `npm run build`;
Cloudflare Pages → Settings → Variables → *build* variables):

| Build var | Meaning | Default |
|---|---|---|
| `VITE_VOICE_WAKEWORD_MODEL_URL` | Base URL of the three `.onnx` files. **Set this to enable the mode.** | — (option hidden) |
| `VITE_VOICE_WAKEWORD_MODEL` | Wake-classifier filename under the base URL | `hey_jarvis_v0.1.onnx` |
| `VITE_VOICE_WAKEWORD_ORT_URL` | onnxruntime-web ESM URL (self-host for offline) | pinned jsdelivr URL |

Wake-word is **web-only** (the ONNX/CDN path doesn't run in the Tauri
desktop shell) and stays **hidden** unless the model URL is set — so the
feature is opt-in and safe by default. Once enabled, selecting the mode
makes Orbit stay silent until it hears the wake phrase, then it arms a
single turn (nothing is streamed to STT before the wake). The mic button
mutes/unmutes the wake listener. A wake that hears no speech is dropped
and logged as a **false fire** in the `voice_interaction` telemetry
(trigger `wake-word`, `success:false`) — the §10.4 metric for tuning the
threshold to the hall.

### 3.2 The underlying options

The build vars above feed `startWakeWord`, which takes:

| Option | Meaning | Default |
|---|---|---|
| `modelBaseUrl` | Base URL of the three `.onnx` files | — (wake-word inert until set) |
| `wakeModel` | Wake-classifier filename under `modelBaseUrl` | `hey_jarvis_v0.1.onnx` |
| `ortUrl` | onnxruntime-web ESM URL (CDN; self-host for offline) | pinned jsdelivr URL |
| `threshold` / `triggerFrames` / `cooldownMs` | Detector tuning | `0.5` / `3` / `2000` |

Example (the default hands-free wiring does this for you via the build
vars; call it directly only for a bespoke integration):

```ts
import { startWakeWord } from './services/voiceWakeWord'

const session = startWakeWord(micStream, {
  modelBaseUrl: '/wakeword',          // serves the 3 .onnx files
  // wakeModel: 'hey_orbit.onnx',     // once you've trained one (§5)
  threshold: 0.5,
  onWake: () => armHandsFreeTurn(),
})
// …later: session.stop()
```

When `modelBaseUrl` is omitted, the scorer is inert (no scores, no
wakes) — so the feature is opt-in and safe by default.

---

## 4. On-hardware validation checklist

Wake-word quality is dominated by the room and the mic, so validate on
the **actual exhibit device** before relying on it:

1. **CPU headroom** — confirm the kiosk runs the three models per 80 ms
   frame *and* the WebGL globe without dropping frames.
2. **False-fire rate** — play recorded hall noise / crowd chatter for a
   sustained period with no one addressing Orbit; count spurious wakes.
   Raise `threshold` and/or `triggerFrames` until it's acceptable.
3. **True-accept rate** — have several voices say the phrase from
   typical visitor distances/angles; confirm reliable wakes. Lower
   `threshold` if it misses.
4. **Mic** — a directional / noise-cancelling mic matters far more than
   model tuning in a loud hall (§9.1 of the voice plan).
5. **Cooldown** — confirm one phrase doesn't double-trigger; tune
   `cooldownMs`.

Record the tuned `threshold` / `triggerFrames` / `cooldownMs` for the
install.

---

## 5. Training a custom "Hey Orbit" model (and swapping it in)

The built-in `hey jarvis` is a stand-in. A branded **"Hey Orbit"**
model is the goal — it also lets you own the model's license. openWakeWord
trains custom models from **synthetic speech** (no hand-recorded data):

1. Follow openWakeWord's
   [automatic model training notebook](https://github.com/dscripka/openWakeWord#training-new-models)
   (Colab-friendly). You provide the phrase ("hey orbit"); it generates
   synthetic positive clips (TTS across many voices) + negatives and
   trains a small classifier.
2. Export the trained classifier to **ONNX** (the notebook does this;
   it produces a `hey_orbit.onnx` with the same I/O shape as the
   built-ins — `[1,16,96] → [1,1]`). The shared `melspectrogram.onnx`
   and `embedding_model.onnx` are reused unchanged.
3. Host `hey_orbit.onnx` alongside the shared models at `modelBaseUrl`.
4. Set `wakeModel: 'hey_orbit.onnx'` (and update any UI copy from "Hey
   Jarvis" to "Hey Orbit").
5. Re-run the §4 validation checklist — a custom model's threshold
   characteristics differ from the built-in's.

Nothing in the app code changes to swap the phrase: the pipeline is
phrase-agnostic, so it's purely a model file + the `wakeModel` option.

---

## 6. References

- openWakeWord: <https://github.com/dscripka/openWakeWord>
- Pipeline constants are mirrored (with citations) in
  `src/services/voiceWakeWordOnnx.ts`.
- Cloudflare AI Gateway realtime STT (the separate streaming path):
  `ORBIT_VOICE_PLAN.md` §3.
