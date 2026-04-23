# Privacy Policy — Interactive Sphere

**Draft for review.** This document is the canonical source for the
privacy policy that ships at [`/privacy`](https://interactive-sphere.pages.dev/privacy)
(rendered from `public/privacy.html`). Needs legal review before
release. See [`ANALYTICS_IMPLEMENTATION_PLAN.md`](ANALYTICS_IMPLEMENTATION_PLAN.md)
for the technical design this policy describes.

Last updated: **draft**

---

## Summary — in plain language

Interactive Sphere is a NOAA Science On a Sphere viewer. We want to
make it better without spying on you. This page explains exactly what
the app records, what it never records, and how you turn everything
off.

- We **do not** use cookies for tracking.
- We **do not** use third-party analytics services.
- We **do not** know who you are — there is no account, no login, no
  persistent identifier.
- We **do** report a small set of anonymous events so we can tell
  whether a build is healthy and which data layers people actually
  use. You can turn this off.
- A richer "research" mode is available, **opt-in only**, that helps
  us understand how people explore Earth data and improves the Orbit
  AI docent.

All data we collect stays on Cloudflare infrastructure. Nothing is
sold, shared with advertisers, or used for profiling.

---

## 1. Who runs this

Interactive Sphere is developed by [Zyra Project](https://github.com/zyra-project).
Source code: <https://github.com/zyra-project/interactive-sphere>.

Contact for privacy questions: *[TBD — populate before release]*.

---

## 2. What we collect, in detail

The app has three telemetry modes. You can see which mode is active —
and change it — under **Tools → Privacy**.

### Mode 1 — Essential (on by default)

Small, anonymous events about the health of the app:

- That the app started — with the app version, platform (web or
  desktop), screen-size bucket, and your browser's language setting
- That a data layer was loaded — which layer, whether it came from the
  network or a local cache, how long it took
- That a data layer was unloaded — which layer, how long you viewed it
- Where on the globe the camera settled — the map's center latitude,
  longitude, zoom, and bearing after you stop panning. Coordinates are
  rounded to roughly 100 metres
- When you click on the map — latitude and longitude of the click (also
  rounded), and whether you clicked a marker, a region, or the surface
- When you change layouts, open the tools menu, or change a setting —
  the name of the setting only, never its content
- When you start, skip, or complete a tour — which tour, which task,
  how long each task held attention
- When you enter or exit VR / AR mode — duration and exit reason,
  approximate frame rate
- When something goes wrong — a classification of the error (tile
  fetch, video stream, AI model, uncaught exception, browser-console
  message, or native crash on desktop), a short sanitized summary of
  the error class (with URLs, emails, numeric tokens and file paths
  stripped out before it leaves your device), and a count of
  repeats. **No raw stack traces, no URLs, no full error messages,
  no line numbers** at this level
- When you submit feedback — that you did, and which category (bug,
  feature, other, thumbs-up, thumbs-down). The *content* of your
  feedback is stored separately — see section 4

Every event is tagged with a **session ID** — a random identifier
generated when you open the app and discarded when you close it. It is
never written to disk, never linked to anything about you, and
regenerates fresh on every launch.

### Mode 2 — Research (opt-in only)

If you turn Research mode on, we additionally record:

- How long you spend on each panel (chat, info, tools, browse, each
  dataset)
- How you interact with the Orbit AI docent — that you sent a message,
  how long the response took, how many tokens were involved, which
  tools (like "load dataset" or "fly to") the model invoked and in
  what order, and whether you followed the model's suggestion
- Whether an Orbit answer seemed to be wrong — detected from thumbs-
  down ratings, from rephrasing the same question, or from abandoning
  a turn
- When you search in the browse panel — a one-way cryptographic hash of
  your query (so we can see common typos and missing datasets without
  ever storing what you actually typed) plus the length and result
  count
- In VR / AR: gesture types (drag, pinch, zoom, flick) and magnitudes
- When something goes wrong: a sanitized stack frame list — function
  names from our own code and from libraries we ship (MapLibre,
  HLS.js, Three.js), with all URLs, file paths, line numbers, and
  messages stripped. Enough for us to find and fix the bug, not
  enough to reconstruct what you were doing. Errors from browser
  extensions or other sites you visit are dropped entirely

Research mode exists to make the Orbit docent better and to
contribute to open research on how people explore Earth-observation
data. It is **off by default**. You can switch back to Essential or
Off at any time.

### Mode 3 — Off

No telemetry events are sent. The app runs normally.

Separately, a build of the app may be produced with telemetry code
*removed entirely at compile time*. Those builds emit nothing
regardless of any setting — verifiable by network inspection.

---

## 3. What we never collect

These are design requirements, not aspirations:

- **Your identity.** No login, no account, no email address collected
  automatically. If you voluntarily include an email in a feedback
  submission it's stored with that submission only — see section 4
- **The text of your Orbit conversations.** We record that a message
  was sent, how long the response took, which tools were used. We do
  not record what you asked or what the model answered
- **The text of browse searches.** We hash your query client-side
  before it leaves your device
- **Your precise location.** We do not request geolocation permission.
  The map coordinates we record are the camera's view on the globe —
  which is wherever you navigated to, not where you are
- **Tracking cookies, advertising identifiers, or fingerprinting
  signals.** The app does not use cookies for analytics. A single
  cookie-free session ID lives in memory for the duration of the app
- **Page URLs from outside the app, referrer chains, or anything about
  other sites you visit**
- **Your IP address in the event stream.** Our server sees your IP
  briefly to rate-limit abuse, then discards it — it is never written
  into analytics storage

---

### Crash reports (separate, per-crash consent)

If Interactive Sphere crashes in a way you notice — the globe goes
blank, the app freezes, or a failure dialog appears — we may ask
you if you want to send a crash report for *that specific crash*.
This is a one-time prompt, per crash. Nothing is sent unless you
tap *Send*.

If you do send a crash report, it includes:

- The classified error information described above
- A sanitized stack from the crash
- A buffer of recent error and warning messages from your current
  session, with the same sanitization applied
- Any text you optionally type into the "what were you doing?" box
- A screenshot, only if you opt to attach one

Crash reports go to a separate database from general telemetry and
are used only for debugging.

---

## 4. Feedback submissions

When you submit feedback through **Help → Feedback** (a bug report,
feature request, or rating of an Orbit response), we store the
feedback itself in a separate database so we can read and respond to
it.

That record contains:

- The text of your feedback, as you wrote it
- The category you chose (bug / feature / other / thumbs-up /
  thumbs-down)
- The URL of the page and your browser's user agent
- Any screenshot you explicitly opted to attach
- Any contact email or handle you voluntarily provided
- The app version and currently loaded dataset ID

We retain feedback submissions indefinitely so we can fix the issues
you report. If you want a feedback submission deleted, contact us
(section 1) with the approximate submit date and enough text to
identify it.

---

## 5. Where the data goes

Everything runs on **Cloudflare**:

- Analytics events: Cloudflare Workers Analytics Engine (90-day hot
  retention) and Cloudflare R2 object storage (long-term, Iceberg
  format) for research analysis
- Feedback submissions: Cloudflare D1 (a managed SQLite database)
- Served by Cloudflare Pages

We do not use Google Analytics, PostHog, Segment, Amplitude,
Mixpanel, Meta Pixel, or any other third-party analytics service.

Nothing is sold, shared with advertisers, or used for cross-site
profiling.

---

## 6. How we use the data

- **Essential events**: to know whether a release is healthy (do
  layers load, do errors spike), to prioritize which datasets and
  features to invest in, to tell whether the app is usable on
  different hardware
- **Research events (opt-in)**: to improve the Orbit AI docent, to
  study how people explore Earth-observation data, and to contribute
  anonymized structured event data to open research including AI
  training corpora. Any data used for training is stripped of session
  identifiers and released only in aggregated or otherwise-anonymized
  form
- **Feedback submissions**: to triage bugs, answer feature requests,
  and improve the app

We do not use any of this data to target advertising, build user
profiles, or sell to third parties.

---

## 7. Your choices

- **Change telemetry mode** at any time: **Tools → Privacy**. Changes
  take effect immediately — no restart required
- **Disable telemetry entirely**: pick "Off" in the same panel
- **Run a telemetry-free build**: the source code is public; you or
  someone you trust can build the app with the compile-time
  telemetry flag disabled. Those builds emit nothing
- **Request feedback deletion**: contact us (section 1)
- **Use the app completely offline**: the desktop build supports
  offline dataset caching. With offline-only use, no events leave your
  machine

You do not need to accept any analytics to use the app. Turning
everything off does not disable any feature.

---

## 8. Children's privacy

Interactive Sphere is an educational tool and is used in classrooms.
We collect no personal information from any user, regardless of age.
Essential-mode analytics contain no information that could identify a
child (or anyone else) individually. Research mode and feedback
submissions are opt-in actions requiring explicit user input, and
school administrators deploying the app should consider whether their
policies permit them.

---

## 9. International users

This app is developed in the United States. Cloudflare's global
network means events are handled close to you, but ultimately land in
Cloudflare's storage which may be located outside your country.

Rights that may apply to you depending on your jurisdiction (GDPR,
CCPA, UK DPA, and others) — including the right to access, correct,
or delete personal data — are available on request. Because the
telemetry we collect is anonymous and carries no identifier linked
to you, "access" and "deletion" mostly apply to feedback
submissions (section 4).

*[To be refined by legal review before release — this section
intentionally hand-wavy in the draft.]*

---

## 10. Changes to this policy

Material changes will be announced in the app's changelog and in the
GitHub repository. The "Last updated" date at the top of this page
reflects the most recent change.

---

## 11. Contact

*[TBD — populate before release. Expected: a project email, a GitHub
issue link, and a postal contact if any federal or jurisdictional
requirement applies.]*
