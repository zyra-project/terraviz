# Orbit Voice Plan — Speech In, Speech Out

Design and phasing for giving **Orbit** (the AI digital docent)
a voice: speech-to-text (STT) so a visitor can *talk* to Orbit,
and text-to-speech (TTS) so Orbit can *talk back*. The existing
typed chat experience is untouched; voice is a feature-gated,
additive layer over the hybrid LLM + local-engine pipeline.

Status: **draft for review — Phase 1 shipped (on this branch).**
This document scopes the approach, the UI, the Cloudflare and
client-side options, and a phase plan that lands a usable web MVP
first and defers the expensive bits (realtime streaming, on-device
models) behind it. Landed in this branch: the voice-service
foundation (capability detection, provider resolver, per-locale
matrix, spoken-form projection), the browser Web Speech engines,
the **mic (STT) input** (push-to-talk → interim transcript →
auto-send), **TTS auto-speak** + the per-message **🔊 Speak**
button (Orbit reads its reply sentence-by-sentence via
`speechSynthesis`, with a Stop control and a default-off settings
toggle), the **voice / rate picker** (novelty voices filtered), and
the **`voice_interaction`** Tier B telemetry event. **Phase 2** has
also landed: the **Cloudflare-edge STT/TTS** Pages Functions
(`/api/voice/transcribe` Whisper, `/api/voice/synthesize`
MeloTTS/Aura) behind `KILL_VOICE`, the opt-in **cloud** client
engines, and a **Voice-engine** picker (Auto / Browser / Cloud).
**Phase 3** (realtime / hands-free) has now largely landed too: the
**recognition-language override**, the **streaming-STT abstraction**
(registry/resolver + fake), the **local VAD gate** (`EnergyVad`), the
**`RealtimeVoiceSession`** controller driving **both `open-mic` and
`push-to-talk`**, concrete streaming engines for **browser** (continuous
Web Speech) and **Cloudflare** (Whisper, VAD-segmented), the
**hands-free chat wiring** (partials→input, turn→send, self-trigger
suspend, mute, listening indicator), **barge-in + dataset-audio
ducking**, and **streaming-turn telemetry** (§10.4 — hands-free turns
tagged `open-mic`/`push-to-talk`, plus barge-in frequency, the numbers
that decide the exhibit interaction model). Remaining Phase 3+ work: a
true **WebSocket** streaming path (Deepgram Nova-3/Flux on Workers AI)
for live partials, Phase 3.5 **wake-word**, and Phase 4 (on-device).

> Cross-references:
> [`docs/DOCENT_UX_IMPROVEMENT_PLAN.md`](DOCENT_UX_IMPROVEMENT_PLAN.md)
> (chat UX), [`docs/DOCENT_OPTIMIZATION_PLAN.md`](DOCENT_OPTIMIZATION_PLAN.md)
> (latency/token budgets), the Orbit character plans
> ([`ORBIT_CHARACTER_INTEGRATION_PLAN.md`](ORBIT_CHARACTER_INTEGRATION_PLAN.md)),
> and **§5 (voice docent)** of
> [`docs/VR_INVESTIGATION_PLAN.md`](VR_INVESTIGATION_PLAN.md) — the
> VR plan already reserves "voice docent" as a Phase 5 item; this
> plan is its 2D/web home and the VR surface consumes the same
> service layer.

---

## Goal

A visitor taps a mic button (or says a wake phrase, later),
speaks a question — *"show me sea surface temperature in the
Pacific"* — and Orbit transcribes it, runs it through the exact
same `processMessage()` pipeline that typed input uses (so dataset
loading, tool calls, and the local-engine fallback all still
work), then optionally **speaks** the answer aloud while the text
streams into the bubble. Hands-free, eyes-on-the-globe operation —
which is the whole point of a planetarium/kiosk/exhibit context,
and a strong accessibility win.

## Non-goals

- **Not** a full real-time conversational voice agent in v1 (no
  always-on listening, no barge-in interruption). That is Phase 3
  — now a **committed** phase (the exhibit requires hands-free; see
  §8 decision 5), but still sequenced *after* the turn-based
  push-to-talk MVP it builds on.
- **Not** voice for any surface other than Orbit. The catalog
  browse search, tour narration, and publisher portal are out of
  scope (tour *narration* via TTS is noted as a future stretch).
- **Not** a custom-trained wake-word or speaker-identification
  system. Wake-word, if pursued, uses an off-the-shelf small model.
- **Not** storing any audio. Captured audio is transcribed and
  discarded in-memory; nothing is persisted or logged (see
  §Privacy).

---

## 1. Where this plugs into the existing architecture

The hybrid Orbit pipeline (see `CLAUDE.md` → *Orbit — Digital
Docent*) is already well-shaped for this. Voice is **two
transducers bolted onto the ends of an unchanged core**:

```
  mic ──► [STT] ──► text ──► docentService.processMessage() ──► DocentStreamChunk* ──► chatUI bubble
                                                                          │
                                                            (delta text accumulates)
                                                                          ▼
                                                                   [TTS] ──► speaker
```

Concretely, the integration points (file/line references from the
current tree):

| Concern | Hook | Notes |
|---|---|---|
| Capture user speech | `src/ui/chatUI.ts` input area (`#chat-input`, send wiring ~`:413`) | New mic button writes the transcript into the same `handleSend()` path. The LLM/local engine never knows the input came from voice. |
| Config | `DocentConfig` in `src/types/index.ts`; defaults in `docentService.ts` `DEFAULT_CONFIG` (~`:225`); persisted under `sos-docent-config` | Add `voice*` fields to the existing blob — no new storage key. Sensitive provider keys (if any) follow the `apiKey` → OS-keychain pattern. |
| Speak the answer | `chatUI.ts` streaming receive loop (`handleSend()`, ~`:665`) consuming `DocentStreamChunk` `delta`s | TTS reads completed sentences as they stream (sentence-chunked), not the whole message at once — cuts perceived latency. |
| New backend (cloud path) | `functions/api/voice/transcribe.ts` + `…/synthesize.ts` | Mirror the `functions/api/chat/completions.ts` + `models.ts` shape: `onRequestPost`, the `AI` binding, the existing CORS helper. |
| Desktop CORS-free fetch | `corsFetch()` lazy-Tauri pattern in `llmProvider.ts` (~`:30`) | Reuse verbatim for audio upload/synthesis fetches. |
| Telemetry | `emit()` Tier B `orbit_*` events (`chatUI.ts` ~`:691`) | New `voice_interaction` event (Tier B), no transcript text stored. |

**Clean slate confirmed:** there is currently no
`SpeechRecognition`, `speechSynthesis`, `MediaRecorder`,
`getUserMedia`, or `AudioContext` usage anywhere in `src/`. No
conflicts to untangle.

A new service module `src/services/voiceService.ts` (mirroring
`llmProvider.ts`'s structure and lazy-import discipline) owns all
of this: capability detection, the STT/TTS provider abstraction,
and the audio plumbing. `chatUI.ts` only ever sees "give me a
transcript" and "speak this sentence."

### 1.1 A spoken answer is not a written answer

This is the single most important correctness point, and it makes
"two transducers on an unchanged core" an over-simplification.
Orbit's current output is tuned for **reading**: markdown, bullet
lists, dataset titles, URLs, and inline `<<LOAD:DATASET_ID>>`
markers. Feed that raw to TTS and it speaks "asterisk asterisk,"
reads dataset IDs and URLs aloud, and enumerates bullets
robotically. Two things follow:

1. **TTS never reads the raw stream.** It reads a **spoken-form
   projection** — markers stripped, markdown flattened, links and
   IDs removed, abbreviations/units expanded ("SST" → "sea surface
   temperature"). This is a sibling of the existing
   `renderChatText()` marker-stripping in `chatUI.ts` (~`:1026`),
   but for the *ear*, not the DOM. It is the source-of-truth for
   sentence-chunking, **not** the visible text.
2. **The model should be asked to talk differently when voice is
   on.** A **voice-aware system-prompt variant** in
   `docentContext.ts` requests shorter, link-free, list-free prose
   and at most one dataset recommendation per turn (you can't scan
   five options by ear). This is a genuine pipeline change, not a
   post-filter — gated on voice being active (e.g. `voiceAutoSpeak`
   / a voice-initiated turn) so typed chat is unaffected.

### 1.2 Acting on a recommendation, hands-free

Today a recommended dataset loads via a **click** on the inline
button rendered from the `action` / `auto-load` chunk
(`renderChatText()`). With no keyboard or mouse in the exhibit,
that affordance is dead. Voice needs its own path:

- **Auto-load with spoken confirmation** — Orbit says "loading sea
  surface temperature now" and fires the load (reuse the existing
  `auto-load` chunk, which already carries the chosen action +
  alternatives), or
- a small **confirmation grammar** ("say *show me* to load it").

Either way the `DocentStreamChunk` contract is unchanged; the
voice layer interprets `action` / `auto-load` chunks as *spoken*
offers instead of *clickable* buttons. This must be designed, not
assumed — it's the difference between voice being usable and being
a demo.

---

## 2. Best practices (what "good" looks like)

These are the non-obvious things that separate a voice feature
that feels magical from one that feels broken:

1. **Push-to-talk before always-listening.** Start with an
   explicit mic tap (or press-and-hold). Always-on VAD (voice
   activity detection) is a privacy, battery, and false-trigger
   minefield — earn it in Phase 3, don't open with it.
2. **Show listening state unmistakably.** A pulsing mic / live
   audio-level meter while capturing, a distinct "thinking" state
   while the LLM streams, and a "speaking" state while TTS plays.
   Silence with no feedback reads as "broken."
3. **Stream partial transcripts** when the provider supports it
   (Web Speech `interimResults`, Deepgram WebSocket). Seeing words
   appear as you speak is the single biggest perceived-quality
   lever.
4. **Sentence-chunk the TTS.** Don't wait for the full LLM
   response. Speak sentence 1 while sentences 2–3 are still
   generating. Buffer on sentence boundaries (`. ! ?` + newline).
5. **Barge-in / interruptibility (Phase 3).** If the user starts
   talking while Orbit is speaking, duck/stop TTS immediately.
   Until then, at minimum give a visible **Stop speaking** control.
6. **Match the language to the active i18n locale.** The app is
   localized; STT/TTS language and voice selection should default
   to the current locale (`src/i18n/`), not hard-code `en-US`.
   Nova-3 and Aura-2 both have multi-language coverage; Web Speech
   honors a `lang` tag.
7. **Permissions are a first-class UX moment.** Request mic
   permission on first *intentional* tap, never on load. Handle
   denial gracefully (fall back to typing, explain why).
8. **Latency budget.** Turn-based target: transcript visible
   <1.5 s after speech ends; first spoken word of the answer
   <2 s after that. Edge STT/TTS (§3) is what makes this
   feasible. Track it via telemetry and the perf sampler.
9. **Degrade, never block.** No mic? No WebGPU? Provider down?
   Offline on localhost? Voice silently disables and typed chat is
   exactly as it was. This mirrors the existing local-engine
   fallback philosophy.
10. **Accessibility cuts both ways.** Voice output helps low-vision
    users; voice input helps motor-impaired users — but TTS must
    be *optional and interruptible*, captions (the streamed text)
    must always remain, and nothing should auto-play audio without
    consent (a deliberate toggle, remembered).

---

## 3. Does Cloudflare offer the services? — Yes, and it's a strong fit

Workers AI (the same `AI` binding already powering Orbit's chat in
`functions/api/chat/completions.ts`) now hosts first-party and
partner **speech** models. This means **no new vendor account, no
client-side API key, no new secret** — the audio terminates at the
same Cloudflare edge the app already deploys to, behind the same
`/api` proxy convention.

**Speech-to-text (STT):**

| Model | ID | Why / when |
|---|---|---|
| Whisper large v3 turbo | `@cf/openai/whisper-large-v3-turbo` | Out of beta, priced, accurate, simple **request/response** (POST audio → JSON transcript). Best **MVP cloud** choice — no WebSocket complexity. |
| Deepgram Nova-3 | `@cf/deepgram/nova-3` | Fast, high-accuracy, **10 languages** with regional variants, **WebSocket streaming** for live partial transcripts. The Phase 3 realtime choice. |
| Deepgram Flux | `@cf/deepgram/flux` | Conversational STT with **built-in turn detection** — the right primitive for barge-in / always-listening without rolling our own VAD. |

**Language coverage is a matrix, not a flag.** The app localizes
well beyond the languages these models support — Nova-3 covers
~10 languages with regional variants, Aura-2 ships `en` + `es`,
MeloTTS is multilingual but bounded, and locales like **Kabyle
(`kab`)** almost certainly have **no** STT/TTS at all. So voice is
available for a *subset* of the UI's locales. `voiceService` must
own an explicit **per-locale capability matrix** (`{ locale →
{ stt: provider|null, tts: provider|null } }`) and the UI must
**degrade gracefully**: when the active locale has no voice
support, the mic/speaker controls hide (or show "voice isn't
available in this language yet") and typed chat is exactly as
before. Locale-matching is *not* a safe default to assume.

**Text-to-speech (TTS):**

| Model | ID | Why / when |
|---|---|---|
| Deepgram Aura-1 / Aura-2 | `@cf/deepgram/aura-1`, `@cf/deepgram/aura-2-en`, `…-es` | Context-aware, natural pacing/expressiveness, **WebSocket** capable. Best default quality. |
| MeloTTS (MyShell) | `@cf/myshell-ai/melotts` | Multilingual, **very cheap** (~$0.0002/audio-min). Good cost-optimized / high-volume kiosk default. |

**Realtime path (Phase 3+):** Workers AI added **WebSocket
support** to the Deepgram audio models (Nova-3, Flux, Aura), and
Cloudflare positions STT + LLM + TTS + turn-detection as a
**voice-agent stack** colocated at one edge data center
(advertised voice-to-voice round trips in the ~350–500 ms range,
TTFB <200 ms). Pairing with **Cloudflare Realtime** (WebRTC/SFU)
is the path to a true conversational agent — but that's well
beyond MVP and is called out as a deliberate later phase.

**Implication for us:** the cloud path is genuinely low-friction.
Two small Pages Functions (`transcribe`, `synthesize`) that wrap
the `AI` binding, modeled exactly on the existing
`chat/completions.ts`, cover Phases 2–3. The MVP (Phase 1) can
skip even that by using the browser's built-in speech APIs.

Sources:
[Aura-1](https://developers.cloudflare.com/workers-ai/models/aura-1/),
[Aura-2](https://developers.cloudflare.com/workers-ai/models/aura-2-en/),
[Nova-3](https://developers.cloudflare.com/workers-ai/models/nova-3/),
[Whisper](https://developers.cloudflare.com/workers-ai/models/whisper/),
[MeloTTS](https://developers.cloudflare.com/workers-ai/models/melotts/),
[Deepgram Flux changelog](https://developers.cloudflare.com/changelog/post/2025-10-02-deepgram-flux/),
[Partner-models blog](https://blog.cloudflare.com/workers-ai-partner-models/),
[Workers AI changelog](https://developers.cloudflare.com/workers-ai/changelog/).

---

## 4. Client-side computing & local models

There are three distinct "client-side" levers, with different
cost/quality/privacy profiles. We should use a **layered fallback**
that picks the best available at runtime — same spirit as the
hybrid LLM/local-engine design.

### 4.1 Browser-native Web Speech API — the free MVP

- **STT:** `SpeechRecognition` / `webkitSpeechRecognition`.
  Zero infra, supports interim results, free. **Caveat:** in
  Chrome it ships audio to Google's servers (so it's "client API,
  cloud backend" — a privacy nuance to disclose), Firefox support
  is weak, and it is **unreliable inside the Tauri/WKWebView
  desktop shell**. So: great for the web MVP, *not* a desktop
  answer.
- **TTS:** `speechSynthesis` + `SpeechSynthesisUtterance`. Fully
  on-device, free, voice quality varies by OS. Perfectly adequate
  as a default and as the universal fallback.

This is why **Phase 1 is web-only browser APIs**: it ships a real
feature with zero backend work and zero cost, and validates the UX
before we spend on edge inference.

### 4.2 On-device neural models (WebGPU) — privacy/offline path

`transformers.js` can run **Whisper tiny/base** in-browser via
WebGPU for fully-local, offline-capable STT (no audio leaves the
device — a genuine privacy story, and works on the desktop app and
on localhost where the `/api` proxy is absent). Kokoro / Piper-class
TTS can likewise run client-side. Tradeoffs: model download weight
(tens to ~150 MB), WebGPU availability (`src/utils/deviceCapability.ts`
+ existing VR WebGPU detection give us the gating), and lower
accuracy than Nova-3/Aura. **Lazy-loaded exactly like the Three.js
VR chunk** — non-voice users never pay for it. This is a Phase 4
opt-in ("on-device / private mode"), not a default.

### 4.3 Apple platform speech (macOS desktop)

We already have a precedent for OS-native AI on Apple:
`src/services/appleIntelligenceProvider.ts` uses Foundation Models
for on-device LLM. The Apple **Speech framework** (STT) and
**AVSpeechSynthesizer** (TTS) are the natural on-device voice
equivalents for the Tauri macOS build, reachable via a small Rust
command in `src-tauri/`. High quality, fully local, no cost. Phase
4, alongside 4.2, behind the same `voiceProvider: 'auto'` resolver.

### 4.4 Provider-selection resolver

`voiceService.ts` resolves an engine at runtime from the registered
set. **As shipped, `auto` is `on-device → browser`** and Cloudflare
is **opt-in** (reachable only by pinning `voiceProvider: 'cloud'`):

```
auto:   on-device (Phase 4, if capable) → browser (Web Speech)   [free, no per-use cost]
cloud:  Cloudflare edge — Whisper STT, MeloTTS/Aura TTS           [pinned; metered]
browser / local: pin the specific engine
```

> **Why cloud is opt-in, not auto** (decision, 2026-06-22):
> auto-preferring the edge would make every auto-speak / 🔊 / mic
> turn a metered Workers AI call, and cloud STT changes the UX
> (record→upload, no live interim). So `auto` stays on the free
> browser path; users / kiosk operators **pin** `cloud` via the
> Voice-engine setting when they want the better, browser-consistent,
> non-Apple/Google path. This supersedes the original
> `on-device → cloud → browser` auto order above; revisit if the
> kiosk wants cloud as its default (it would pin `cloud` anyway).

Config surfaces this as `voiceProvider: 'auto' | 'cloud' | 'local' | 'browser'`
so power users / kiosk operators can pin a path. Default `'auto'`.
Cloud engines are **web-only** (the `/api` proxy is absent in the
desktop shell) and honour the `KILL_VOICE` session cooldown.

---

## 5. New UI

The guiding principle: **voice is an affordance on the existing
chat surface, not a new surface.** Nothing moves; we add controls.

### 5.1 In the chat input row (`chatUI.ts`)

- **Mic button** next to send (`#chat-mic`). States: idle → press
  to talk; **listening** (pulsing + live input-level meter, partial
  transcript filling `#chat-input` as you speak); **transcribing**;
  back to idle. Long-press = hold-to-talk; tap = toggle. On a final
  transcript it auto-sends (configurable).
- **Live caption / interim transcript** rendered into the existing
  textarea so the user sees what's being heard and can edit before
  send.
- **Permission + error inline state**: denied-mic and
  unsupported-browser show a one-line explainer, never a dead
  button.

### 5.2 On Orbit's reply

- **Speaker toggle** on each assistant bubble (and a global "auto-
  speak replies" setting). While speaking: a **Stop speaking**
  control and a subtle per-word/sentence highlight tracking the
  audio.
- The streamed **text stays the canonical output** (captions are
  never replaced by audio) — accessibility + i18n requirement.

### 5.3 Settings panel additions (`#chat-settings`)

Mirror the existing `visionEnabled` toggle pattern (~`chatUI.ts:432`):

- `Voice input` on/off, `Auto-speak replies` on/off
- `Voice` picker (enumerate `speechSynthesis.getVoices()` and/or
  Aura/MeloTTS voices), `Speaking rate`
- `Voice provider`: Auto / Cloud (Cloudflare) / On-device / Browser
- `Recognition language`: defaults to active i18n locale, override
  available
- Push-to-talk vs tap-to-toggle; auto-send-on-final on/off

### 5.4 Orbit character & VR tie-ins (later phases)

- The **Orbit character** (`src/services/orbitCharacter/`) has a
  gesture/state vocabulary — a **"speaking" animation / pseudo-
  lip-sync** driven by TTS audio amplitude is a high-delight,
  low-risk add once audio playback exists (Phase 5).
- The **VR docent** (`VR_INVESTIGATION_PLAN.md` §5) consumes the
  same `voiceService` — voice is *more* compelling in immersive
  mode (hands occupied, no keyboard). Spatial audio for Orbit's
  voice is a VR-specific stretch.

### 5.5 i18n & a11y

Every new label/ARIA string goes through `t()` (the
`check:i18n-strings` gate covers `src/ui/`). Mic/speaker buttons
need proper `aria-label`s and `aria-pressed`/`aria-live` regions
for the listening/speaking state. New scenes for
`scripts/screenshots/scenes.ts` (mic idle/listening, settings with
voice rows) per the visual-testing convention.

**The double-speak trap.** If auto-speak (TTS) is on *and* a
screen reader is reading the live `aria-live` caption, the user
hears every reply **twice**, overlapping. The two must be
coordinated: when TTS is active, the streamed caption should not
also be announced via an assertive live region (use `aria-live`
politely / suppress, or gate one on the other). The mic must be
**keyboard-operable** (not tap-only), and the listening-state
audio meter must honor `prefers-reduced-motion`.

---

## 6. Privacy & analytics

Voice is sensitive; this slots into the existing privacy-first
analytics model (`docs/ANALYTICS.md`, `docs/PRIVACY.md`).

- **No audio persisted, ever.** Captured audio is streamed/posted
  for transcription and dropped. Transcripts live only in the
  in-memory chat history already used for typed chat.
- **New Tier B event `voice_interaction`** (research-tier, opt-in
  — add to `TIER_B_EVENT_TYPES` in `src/types/index.ts`):
  `{ mode: 'stt' | 'tts', provider: 'cloud'|'local'|'browser',
  duration_ms, lang, success }`. **No transcript text, no hashes
  of speech.** Follow the `docs/ANALYTICS_CONTRIBUTING.md`
  checklist + add a test.
- **Disclosure:** the first mic activation shows a one-time
  explainer of where audio goes for the selected provider (esp.
  the Web Speech "Chrome→Google" nuance and the Cloudflare-edge
  path). On-device mode advertises "audio never leaves this
  device."
- **Privacy-policy update** (`docs/PRIVACY.md` →
  `public/privacy.html` via `npm run build:privacy-page`, guarded
  by `check:privacy-page`) describing the voice data flow per
  provider.

### 6.1 The exhibit changes the privacy calculus

A public, always-on kiosk that records the public (including
**minors**) is a different privacy posture from a hobbyist on the
open web, and it creates a contradiction we have to resolve
explicitly:

- **Browser Web Speech STT is wrong for the exhibit.** In Chrome
  it ships captured audio to **Google's** servers. That's an
  acceptable trade for the zero-cost Phase 1 *web* MVP, but it is
  **not** acceptable for a NOAA kiosk silently recording visitors.
  **The exhibit (hands-free, Phase 3) must use the Cloudflare-edge
  or on-device path, never Web Speech.** Decision #2 (browser-API
  MVP) and decision #5 (hands-free exhibit) therefore target
  *different deployments*, not one escalating build.
- **Wake-word must be on-device.** "Hey Orbit" requires
  continuously processing mic audio. That detection runs **locally**
  (Porcupine / openWakeWord class) and **never streams raw audio to
  the cloud** just to spot the trigger — a privacy *and* cost
  requirement, not an optimization.
- **Physical recording notice.** Always-on audio capture in a
  public space typically needs **on-site signage** disclosing
  recording — something the in-app banner cannot satisfy. Flag for
  the install/operations checklist, and confirm the legal posture
  for the install jurisdiction(s).
- **Public input is adversarial.** Spoken input from strangers
  will include profanity and probing; it flows into the LLM as
  text and reuses Orbit's existing moderation/guardrails, but the
  exhibit raises the stakes — worth an explicit content-safety
  note at Phase 3.

---

## 7. Phase plan

Each phase is independently shippable and adds no regression risk
to typed chat. Ordering front-loads value; ordering reflects the
§8 decisions (auto-speak off, browser-API MVP, MeloTTS default,
cost guards with Phase 2, and **hands-free as a committed
requirement** that pulls realtime ahead of on-device).

| Phase | Scope | Surface | Backend | Cost |
|---|---|---|---|---|
| **0 — Spike** | `voiceService.ts` skeleton + capability detection; throwaway prototype wiring Web Speech STT into `handleSend()` and `speechSynthesis` onto a reply. Validate UX, latency, the sentence-chunking. | branch only | none | none |
| **1 — Web MVP** | Mic button + listening UI + interim transcript; auto-speak toggle (**default off**); settings rows; i18n + a11y + scenes + Tier B telemetry. **Browser APIs only.** | web | none | none |
| **2 — Cloud STT/TTS + guards** | `functions/api/voice/{transcribe,synthesize}.ts` over the `AI` binding (Whisper turbo STT; **MeloTTS default**, Aura-2 opt-in); `voiceProvider` resolver; desktop via `corsFetch`. **`KILL_VOICE` env + per-session usage caps + client cooldown land here.** | web + desktop | 2 Pages Functions | edge inference |
| **3 — Realtime / hands-free** *(committed — exhibit req.; **largely shipped**)* | **Shipped:** local VAD gating before any audio streams, listening indicator + mute, **barge-in** ("Stop speaking" → "interrupt"), dataset-audio ducking, both **open-mic** and **push-to-talk**, browser (continuous Web Speech) + **Cloudflare Whisper (VAD-segmented)** streaming engines, and the **recognition-language override** (`voiceLang`). **Remaining:** the true **WebSocket** path (Deepgram **Flux** turn detection + **Nova-3/Flux** streaming partials) for live interim transcripts, and streaming-turn telemetry. | web + desktop | WS proxy / Realtime | edge inference |
| **3.5 — Wake-word** *(committed)* | "Hey Orbit" off-the-shelf small wake model to arm listening hands-free in the exhibit. | web + desktop | local / WS | edge inference |
| **4 — On-device / private** | WebGPU Whisper + local TTS (`transformers.js`); Apple Speech/AVSpeechSynthesizer on macOS Tauri; "private mode." | web (WebGPU) + desktop | none (local) | none |
| **5 — Character & VR** | Orbit-character speaking animation / amplitude lip-sync; wire `voiceService` into the VR docent (`VR_INVESTIGATION_PLAN.md` §5); optional spatial audio. | web + VR | reuse | reuse |

**Stretch / explicitly deferred:** tour **narration** via TTS,
voice-driven catalog search (noted as a Phase 3 stretch in the VR
plan), speaker diarization for multi-visitor kiosks. *(Wake-word
moved into the committed roadmap as Phase 3.5 per §8 decision 5.)*

> **Recognition-language override — folded into Phase 3.** The
> `voiceLang` field (BCP-47, default = active UI locale) is already
> threaded through every STT/TTS resolution site; what's missing is
> a settings control to set it. It rides with Phase 3 rather than
> shipping standalone because the hostile-audio exhibit work is what
> makes a *spoken* language distinct from the *read* UI locale matter
> (bilingual floor, regional STT accuracy like `en-GB`/`es-MX`,
> operator pinning). UI-only slice: a "Voice language" `<select>`
> ("Same as app" default + supported BCP-47 tags from the capability
> matrix), save-handler wiring, i18n + `index.html` fallback, a
> round-trip test, and the settings Scene update — no new service
> code, no migration.

---

## 8. Resolved decisions

These five were locked in review (2026-06-22). They supersede the
recommendations elsewhere in this doc where they differ.

1. **Auto-speak is OFF by default.** Voice output is opt-in via a
   toggle, with a prominent first-run nudge. Captions (the streamed
   text) always remain regardless. Rationale: shared/quiet exhibit
   spaces; no surprise audio. (§5.2)
2. **Phase 1 ships browser APIs only** (Web Speech STT +
   `speechSynthesis` TTS). Web-only, zero cost, fast to validate
   UX — accepting the known cross-browser inconsistency and desktop
   gap, which the Phase 2 Cloudflare path then closes. (§7)
3. **Cloud TTS default is MeloTTS**, with Deepgram **Aura-2 as an
   opt-in "higher-quality voice."** Rationale: MeloTTS is ~10×
   cheaper — the right default for high-volume kiosk use. (§3, §7)
4. **Cost guardrails are in scope.** Add a server **`KILL_VOICE`**
   env (modeled on `KILL_TELEMETRY` → 410 + client cooldown) plus
   **per-session usage caps**. These land **with Phase 2** (the
   first phase that incurs edge inference cost), not later.
   (§6, §10.6 cost model)
5. **Hands-free is a committed exhibit requirement** — *not* a
   deferred stretch. The NOAA SOS install needs always-listening
   operation. This **promotes the realtime work (Phase 3) and a
   wake-word into the committed roadmap** and reorders priority:
   Phase 3 now lands **before** the on-device/private work (former
   Phase 4), since the exhibit value depends on it. Deepgram
   **Flux** (built-in turn detection) is the primitive; wake-word
   ("Hey Orbit") becomes **Phase 3.5** rather than a stretch item.
   Privacy handling for an always-on mic (local VAD gating before
   any audio is streamed, clear "listening" indicator, mute
   control, disclosure) is elevated to a Phase 3 acceptance
   criterion. (§7, §6)

> **Phasing impact of #5:** the table in §7 is renumbered so the
> realtime/hands-free phase precedes on-device. Phases 1–2 are
> unchanged building blocks (push-to-talk MVP, then the cloud
> proxy + `voiceProvider` resolver that Phase 3 streams over).

> **Open implementation tension within #5:** "hands-free" is the
> requirement; **always-open-mic is one implementation, a physical
> press-to-talk button is another.** In a noisy, multi-visitor hall
> a single hardware button is often *more* robust than an open mic
> (no echo loop, no crowd false-fires, clear turn-taking). This is
> a Phase 3 design decision, not a settled one — see §9.1.

---

## 9. Designing for the exhibit — hostile audio & conversation design

The plan above optimizes for "voice on the open web." The
*exhibit* — a noisy, public, multi-visitor museum hall — is a
harder problem, and it's the deployment decision #5 commits us to.
These are the things that decide whether hands-free actually works
there.

### 9.1 The room is a hostile audio environment

- **Echo / self-trigger loop.** An always-open mic next to a
  speaker playing Orbit's voice **hears Orbit** and re-triggers
  itself. Mitigation: acoustic echo cancellation (AEC), **duck or
  gate the mic while TTS is playing**, and/or directional mic
  hardware. Untreated, always-on + TTS is a feedback loop.
- **Dataset-audio collision.** Datasets are HLS video that can
  carry an audio track; the mic hears it and TTS competes with it.
  **Duck dataset audio during a voice turn**, and treat dataset
  audio as a known echo source for AEC.
- **Crowd noise, crosstalk, wake-word false-fires.** A busy lobby
  is the worst case for STT accuracy and for "Hey Orbit"
  mis-triggering on passing conversation. Tune endpointing and
  wake-word sensitivity against *recorded hall noise*, and track
  the false-fire rate as a first-class metric (§10.4).
- **Hands-free ≠ open-mic (the §8 #5 tension).** A **physical
  press-to-talk button** at the kiosk delivers "hands-free of a
  keyboard" while sidestepping echo, crowd false-fires, and
  turn-taking ambiguity. Recommendation: prototype **both** an
  open-mic+wake-word path and a button path early in Phase 3 and
  let a real install pick — don't assume open-mic.

### 9.2 Conversation design

- **One recommendation per turn.** You can scan five dataset
  options on screen; you cannot by ear. The voice-aware prompt
  (§1.1) caps recommendations and the voice layer reads `action` /
  `auto-load` chunks as *spoken* offers (§1.2).
- **Endpointing.** When does a turn end? Too-short silence cuts
  people off mid-sentence; too-long feels laggy. This is exactly
  why **Deepgram Flux's turn detection** is the Phase 3 STT choice
  rather than a hand-rolled silence timer.
- **Conversational repair.** Mis-transcription needs an out — a
  visible/editable transcript before send (push-to-talk), and a
  re-ask path. Tie corrections to the existing `orbit_correction`
  telemetry so we can measure STT-driven misunderstanding.
- **Silence / no-input timeouts** and a graceful "I didn't catch
  that" rather than a dead state.

---

## 10. Engineering specifics the MVP must not hand-wave

### 10.1 Audio capture & encoding

`MediaRecorder` output differs by browser (Chrome → `webm/opus`,
Safari → `mp4/aac`), and the STT endpoint expects specific
formats/sample rates. `voiceService` normalizes capture (codec,
sample rate, mono) per provider, and the Cloudflare `transcribe`
function documents exactly what it accepts. Don't assume one format
works everywhere.

### 10.2 TTS playback & streaming

TTS returns **encoded audio**, not text — it must be decoded and
played (`HTMLAudioElement` or Web Audio), and for low latency the
audio should be **streamed/queued per sentence** rather than played
as one blob. Sentence-chunked synthesis (§2, practice 4) only pays off if the
playback layer can enqueue chunk N+1 while chunk N plays.

**Two browser gotchas the playback layer must handle** (both hit in
Phase 1's `speechSynthesis` path): **(1) iOS Safari** only produces
audio if synthesis was first invoked from inside a *user gesture* —
auto-speak fires later from an async chain, so it must be **primed
once from an early tap** (a silent blank utterance) to unlock the
session. **(2) Chrome** garbage-collects an utterance that isn't
referenced from JS while mid-flight, so it never plays and never
fires `onend`; retain a reference until it settles, and keep a
safety timeout so the queue can't wedge.

### 10.3 Testing nondeterministic audio

Real STT/TTS can't run in CI. The provider abstraction therefore
ships a **fake provider** behind the resolver: scripted transcripts
in, silent/stub audio out, so the pipeline, the spoken-form
projection (§1.1), sentence-chunking, and the UI state machine are
**deterministically testable**. Screenshot scenes cover the
listening/thinking/speaking states; a smoke assertion drives the
fake STT → `handleSend()` → spoken-offer path.

### 10.4 Telemetry beyond the basic event

The `voice_interaction` event (§6) should also let us tune the
exhibit: STT/TTS **latency**, provider, language, success, and —
for hands-free — **wake-word trigger and false-positive rate** and
**barge-in frequency**. (Still no transcript text, no audio.) These
are the numbers that decide open-mic vs button (§9.1).

### 10.5 Desktop / Tauri & localhost

- **Tauri mic permissions aren't free:** macOS needs
  `NSMicrophoneUsageDescription` in the bundle, the capability
  allowlist must permit mic + the voice endpoints, and
  `getUserMedia` in WKWebView has caveats. Phase 2 desktop voice
  carries this plumbing cost.
- **Localhost has no `/api` proxy** (same constraint as the LLM
  path). The cloud STT/TTS endpoints are unreachable in local dev,
  so dev relies on the Web Speech / fake-provider fallback — or a
  `wrangler`/miniflare shim. Note this so Phase 2 dev isn't blocked.

### 10.6 Cost model

Turn the abstract "MeloTTS ≈ $0.0002/audio-min" into a real
projection before setting the §8 #4 caps: estimate an
8-hour/day kiosk's STT + TTS + LLM minutes, derive a per-session
cap and a monthly ceiling, and size `KILL_VOICE` / cooldown
thresholds against it. On-device (Phase 4) is the structural answer
to recurring per-use cost at exhibit scale.

---

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Web Speech API inconsistency / desktop gaps | Phase 1 is explicitly "best-effort web"; Phase 2 cloud path is the consistency backstop; resolver degrades silently. |
| Edge inference latency/cost at exhibit scale | MeloTTS cheap default; sentence-chunked TTS hides latency; `KILL_VOICE` + per-session caps; on-device Phase 4 removes per-use cost. |
| Mic permission friction / denial | Request only on intentional tap; graceful typed-chat fallback; clear inline explainer. |
| Privacy perception (audio leaving device) | Per-provider disclosure; on-device "private mode"; no audio stored; Tier B opt-in telemetry with no transcript content. |
| Bundle bloat | All voice code lazy-loaded behind capability + config gates (Three.js-chunk precedent); WebGPU models only fetched in on-device mode. |
| i18n/RTL/a11y regressions | All strings via `t()`; logical CSS properties; new screenshot scenes + smoke assertion per the repo conventions. |
| Scope creep into a full voice agent | Hard phase boundaries; realtime/barge-in gated behind a proven turn-based MVP; non-goals enumerated above. |
| Echo / self-trigger loop (always-on mic + TTS) | AEC; duck/gate mic during TTS; duck dataset audio; directional-mic hardware; prototype a press-to-talk-button path as the robust alternative (§9.1). |
| Voice unavailable in many UI locales | Explicit per-locale capability matrix in `voiceService`; controls hide / "not available in this language" rather than failing (§3). |
| Robotic TTS reading markdown/IDs/URLs | Spoken-form projection + voice-aware system prompt (§1.1); TTS never reads the raw stream. |
| Double-speak (TTS + screen-reader caption) | Coordinate live-region announcement with TTS state (§5.5). |
| Recording the public in a kiosk (incl. minors) | Exhibit uses Cloudflare/on-device STT, never Web Speech; on-device wake-word; physical recording signage + jurisdiction check (§6.1). |

---

## 12. First implementation slice (when approved)

To keep changes "one logical change per turn" (per `CLAUDE.md`):

1. Add `voiceService.ts` skeleton + capability detection + the
   provider resolver, **including the per-locale capability matrix
   and a fake provider for tests** (§3, §10.3). Module-map row in
   `CLAUDE.md` in the same commit (doc-coverage gate).
2. Extend `DocentConfig` with `voice*` fields + defaults
   (auto-speak **off** by default).
3. **Spoken-form projection** (marker/markdown/URL stripping for
   the ear) + a voice-aware prompt variant gated on voice being
   active (§1.1).
4. Mic button + listening UI + interim transcript (Web Speech STT)
   → `handleSend()`; spoken-offer handling for `action` /
   `auto-load` chunks (§1.2). New scene + i18n keys.
5. `speechSynthesis` auto-speak with sentence-chunked, queued
   playback + Stop control + settings toggle; coordinate with the
   `aria-live` caption to avoid double-speak (§5.5).
6. Tier B `voice_interaction` event (+ latency fields) + test +
   `ANALYTICS.md` row.

Each is a self-contained, signed-off (`git commit -s`) commit.
