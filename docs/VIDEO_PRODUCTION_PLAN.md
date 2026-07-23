# TerraViz Publisher Video — Production Plan

**Status: draft for review.** A "why + how" hybrid for onboarding new
publishers: a ~4–5 min **hero film** that both makes the case for publishing on
TerraViz and tours the portal's capabilities, plus a set of **60–120 s task
chapters** that double as reference training.

The narrative spine is the project's own thesis in [`MISSION.md`](../MISSION.md):
**two walls** → **reach without surrender**. The film dramatizes that, shows the
public payoff, then reveals the publisher portal as the machine that produces it.

This doc holds the treatment, the shot-by-shot script, and the **capture
runbook**. On-screen portal footage is produced deterministically by
`npm run screenshots:demo` (see [`scripts/screenshots/demo.ts`](../scripts/screenshots/demo.ts));
the globe/tour/Orbit "payoff" b-roll comes from a seeded live app.

**Non-goals.** Voiceover recording, music licensing, and final edit/assembly are
the producer's. This plan assumes **screencast + VO + captions**, not
motion-graphics/animation production.

---

## 1. Audience & positioning

- **Primary viewer:** a curator/comms person at an institution (university lab,
  planetarium, museum, agency, community group) who is *both* evaluating whether
  to publish on TerraViz *and* about to operate the portal.
- **The promise (say it plainly, early):** *"Take your data from raw files all
  the way to a public, navigable globe — and keep it on your own hardware, under
  your own name, on your own domain."* (`MISSION.md`, "Reach Without Surrender").
- **Tone:** curious, plain-spoken, unhyped. Mirror the node-profile default tone
  ("curious, educational"). Let the globe and the one-click moments carry the wow.

---

## 2. The hero film — "Reach Without Surrender" (~4:30)

Four acts. Timecodes are targets; keep it tight over complete.

### Act 1 — The two walls (0:00–0:50)
- **Message:** public-interest data is trapped, and the usual way out costs you
  your independence.
- **VO (from `MISSION.md`):** *"Some of the most important data about our world
  sits in archives and on servers, behind tools built for specialists. To reach
  a real audience, institutions have had to hand their work to someone else's
  platform — and give up their data, their branding, and their control with it.
  Two walls. One between the data and the public, one between the publisher and
  the audience. TerraViz exists to take down both."*
- **Visuals:** cold, static stock/metaphor for "trapped data" (a file listing, a
  spinning loader, a paywall), then hard cut to the globe blooming to life.

### Act 2 — What your work becomes (0:50–2:10)
- **Message:** show, don't tell — the end-user experience your data powers.
- **VO:** *"On TerraViz, your data becomes something anyone can explore — a free,
  no-account viewer that streams it onto a navigable 3D globe, on any device from
  a phone to a headset."*
- **Beats (b-roll — the `globe` + `orbit` demo flows, plus seeded-live for the
  rest; see §5):**
  1. Spin the globe (`globe.webm` — `?embed=1&rotate=on`); then load a dataset
     onto it + scrub time (seeded-live). (`src/main.ts`)
  2. Open a published **blog post** → click **"Play tour"** → the camera flies,
     datasets load, captions narrate (seeded-live). *"The post is the read; the
     tour is the show."* (`src/ui/blog/index.ts`, `src/services/tourEngine.ts`)
  3. **Orbit** flies to Earth (`orbit.webm` — `/orbit?preset=planetary&fly=1`);
     for "ask a question → drops a dataset on the globe," use seeded-live.
     (`src/services/docentService.ts`)
  4. Two-globe compare; then the same globe embedded on a third-party page.
     (`docs/EMBED_URL_GRAMMAR.md`)

### Act 3 — How you make it (2:10–3:50)
- **Message:** all of that comes out of one portal, and it's mostly no-code.
- **VO:** *"And you make all of it from one place — the publisher portal."*
- **Beats (deterministic portal footage — `screenshots:demo` clips):**

  | Beat | Clip / still | Line |
  |---|---|---|
  | Command center | `overview.webm` | "Sign in and you land on a command center — what needs you, at a glance." |
  | Your voice | `node-profile.webm` | "Set your node's mission and tone once — it's the voice every AI draft speaks in." |
  | A dataset | `dataset.webm` | "Add a dataset through a guided form — or bulk-import a whole catalog from a CSV." |
  | Bulk import | `import.webm` | "Every row is validated up front before anything is created." |
  | **Signature** | `events.webm` | "Feeds surface the headlines; the queue **auto-pairs** each event to matching datasets — approve everything above 90% in one click." |
  | **Signature** | `blog.webm` | "Cite your sources, pull in suggested imagery, and **generate a full post and a playable tour** — grounded in your voice." |
  | Impact | `analytics.webm` | "And see exactly how people engaged — down to a heatmap of where they looked." |

### Act 4 — Reach without surrender (3:50–4:30)
- **Message:** you keep control; there's no toll at the door; a human is always
  in the loop.
- **VO (from `MISSION.md`):** *"You don't need your own servers to start. The
  lightest path keeps your name on your data from the first day — and running
  your own node is a step you can take later, not a toll at the door. It's built
  as an open protocol, not a single service: a network meant to outlast any one
  institution. Automated matching proposes; a human always approves."*
- **CTA:** where to start — self-host guide (`docs/SELF_HOSTING.md`) / contact /
  "publish with us."

---

## 3. Task chapters (60–120 s each; reference training)

Each maps to a `screenshots:demo` flow. Priority order — the first three are the
signature/most-differentiating; 6–7 are optional.

1. **Set up your node profile** — why first: it's the voice AI drafts use.
   `node-profile.webm`. (`src/ui/publisher/pages/node-profile.ts`)
2. **Turn a headline into a story** *(signature)* — feeds → triage queue →
   auto-pair (≥90%) → suggested media. `events.webm`.
   (`pages/{feeds,events}.ts`, `components/events/{events-model,media-suggest}.ts`)
3. **Write an AI-drafted post + tour** *(signature)* — Content → Sources → Media →
   AI draft. `blog.webm`. (`pages/blog-edit.ts`, `POST /publish/blog/generate`)
4. **Publish your first dataset** — guided form, asset upload, publish lifecycle.
   `dataset.webm`. (`components/{dataset-form,asset-uploader}.ts`, `pages/dataset-detail.ts`)
5. **Bulk-import a catalog** — CSV manifest with per-row validation. `import.webm`.
6. **Automate refresh with Zyra workflows** — author + schedule a pipeline.
   `workflows.webm`. (`pages/workflows.ts`)
7. **Read the room: analytics & feedback** — engagement + Orbit/bug feedback.
   `analytics.webm`, `feedback.webm`. (`pages/{analytics,feedback}.ts`)

---

## 4. Ship-check (do before recording each beat)

Only script surfaces that are **live**. Confirmed shipped and used above: Events
triage + media-suggest, blog AI-draft + Media tab, workflows, analytics, node
profile, bulk-import preview, the public blog + companion tour.

**Verify before filming:** the public **"Right now" / current-events** end-user
hero (`docs/CURRENT_EVENTS_PLAN.md` is partly plan-stage) and any **semantic
search** beat (search lives in the main SPA/search service, not the portal). If a
surface isn't live in the build you're filming, cut or soften the line — don't
show vaporware.

---

## 5. Capture runbook

Two tracks. **Portal footage** (Act 3 + all chapters) is deterministic and
fixture-driven. **Payoff b-roll** (Act 2 — globe + Orbit) is captured live by two
extra flows in the same command, but it renders real WebGL so it's a clip, not a
byte-reproducible still (and the globe needs network access to the Earth
imagery — see the note below).

### Track A — the `screenshots:demo` capturer (recommended default)

Reuses the visual-report fixture/scene stack: the portal flows render **fully
populated with realistic multi-org data against a plain `vite` dev server, no
backend**, and are reproducible run to run. The `globe` and `orbit` flows record
the live Act-2 b-roll from the same run.

```bash
# shell 1 — dev server
npm run dev -- --host 127.0.0.1 --port 4173

# shell 2 — capture all flows (per-flow .webm clip + numbered stills → demo-out/)
SCREENSHOT_BASE_URL=http://127.0.0.1:4173 npm run screenshots:demo

# narrow to specific flows, and slow the pacing for a calmer clip:
SCREENSHOT_BASE_URL=http://127.0.0.1:4173 DEMO_HOLD_MS=2200 \
  npm run screenshots:demo -- --flow events,blog
```

Output lands in `demo-out/` (gitignored): `<flow>.webm` per flow,
`<flow>-NN-<beat>.png` per beat, `manifest.json` (flow → narration cue → beat
files), and **`storyboard.html`** — a self-reviewing page pairing every clip +
still with its narration cue (open it to scan the whole shot flow, or hand it to
an editor). Flows: `overview, node-profile, dataset, import, events, blog,
workflows, feedback, analytics` (portal) + `globe, orbit` (Act-2 b-roll). Env
knobs: `DEMO_HOLD_MS` (per-beat linger, default 1600), `SCREENSHOT_VIEWPORT`
(default `1440x900`), `DEMO_FLOW` / `--flow` (filter), and
`PLAYWRIGHT_CHROMIUM_PATH` (point at a pre-installed Chromium if the pinned
Playwright build isn't downloaded).

**Globe/Orbit b-roll needs network.** The `globe` and `orbit` flows pull the real
Earth imagery (NASA GIBS) — with network access they render the lit globe and
Orbit's fly-to-Earth; in a restricted sandbox the textures don't load (the globe
shows its branded loading state and Orbit's Earth is blank, though the character
still renders). Run these where the imagery hosts are reachable. For a **dataset
loaded onto the globe** or a **tour playing**, use Track B — those pull dataset
tiles/video that only the seeded live app serves.

The `blog` flow cites a fixture event on the Sources tab and stubs the Worldview
host with a real Earth frame, so the Media tab renders a populated **"Satellite
view"** suggestion card (plus the "not shown for this event" notes) rather than an
empty state. For a fuller Media grid (Commons photos, agency video), record that
beat from Track B against a seeded event with imagery.

### Track B — seeded live app (Act 2 payoff b-roll, or hand-recording)

A fully populated, clickable, authenticated portal + globe **with no Cloudflare
account**, via the real Functions backend against local D1 in mock mode.

```bash
# .dev.vars (loopback only; the middleware refuses non-loopback bypass)
DEV_BYPASS_ACCESS=true
DEV_PUBLISHER_EMAIL=dev@localhost
MOCK_STREAM=true
MOCK_R2=true
MOCK_AI=true
MOCK_VECTORIZE=true
MOCK_GITHUB_DISPATCH=true

npm run db:reset          # migrate + seed (~20 datasets; db:seed -- --full ≈ 200)
npm run dev:functions     # wrangler pages dev → real API on :8788
```

Then hand-record (or lightly script) the globe, a blog post's **Play tour**,
Orbit (`/orbit?preset=planetary&fly=1`), and multi-globe. These are live WebGL so
they're not byte-deterministic — record with generous holds. See
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md) and `.dev.vars.example` for the mock
flags; auth bypass is in `functions/api/v1/publish/_middleware.ts`.

### Assembly guidance

- **Format:** 1080p (portal captured at 1440×900; upscale/letterbox as needed) or
  bump `SCREENSHOT_VIEWPORT=1920x1080` for native.
- **Convert clips:** `demo-out/*.webm` → MP4 for editors that prefer it
  (`ffmpeg -i events.webm events.mp4`).
- **Pacing:** the stills are your storyboard; the `.webm` is the moving take. Cut
  on the VO beats in the Act 3 table.
- **Captions:** burn-in captions for accessibility; keep on-screen text short.
- **Music:** low, neutral bed; duck under VO. License cleared by the producer.
- **VO voice:** match the node-profile tone — curious and clear, not salesy.

---

## 6. Regeneration & maintenance

- Re-run `npm run screenshots:demo` after any portal UI change to refresh footage;
  it's deterministic, so re-captures are drop-in replacements.
- The demo flows live in `scripts/screenshots/demo.ts` and reuse the same
  `fixtures/{publisher,admin}.ts` as the visual report — when those fixtures gain
  richer data, the demo footage improves for free.
- This is dev-only tooling: not in the product bundle, not a CI gate.
