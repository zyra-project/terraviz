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

## 3. What telemetry never captures

These are design requirements for the *telemetry stream* (the
automatic events described above), not for the separate opt-in flows
covered in sections 4 and 5:

- **Your identity.** No login, no account, no email address collected
  automatically
- **The text of your Orbit conversations** — not in telemetry.
  (Conversations *do* leave your device — they are sent to an AI
  provider to generate responses, and rating a response explicitly
  submits that conversation for feedback. See sections 4 and 5 for
  the full picture)
- **The text of browse searches.** We hash your query client-side
  before it leaves your device, so telemetry sees typing patterns
  and repeat frequencies but never the words
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

## 4. Orbit — chatting with the AI docent

Orbit is the in-app AI chat assistant. When you send it a message,
the app sends your message (and, if Vision Mode is on, a screenshot
of the current globe view) to an AI language model to generate a
reply. There is no way to get an AI reply without that message
leaving your device, by the nature of how AI models work.

### Where your messages go

- **By default**, messages go to a Cloudflare Workers AI model, via
  a small proxy service we run on Cloudflare. Workers AI is
  Cloudflare's own hosted-models offering; messages are processed
  only to generate the reply and are not used to train Cloudflare's
  models. Cloudflare's published policy applies in addition to this
  one
- **If you configure a different provider** under Orbit settings
  (for example, OpenAI, Ollama running on your own computer, or a
  self-hosted endpoint), messages go directly to that provider. Our
  proxy is not involved, and their privacy policy governs what
  happens to those messages. Interactive Sphere has no visibility
  into the contents
- **We do not keep a copy** of your Orbit messages on our servers.
  Our proxy forwards the request, streams back the response, and
  holds nothing
- **Your chat history stays on your device**, in your browser's
  localStorage (or in the desktop app's local storage). Clearing the
  chat clears the history

### Vision Mode

When you turn on Vision Mode in Orbit settings, the app attaches a
screenshot of your current globe view to each message so the AI can
describe what you are looking at. The screenshot goes to whichever
AI provider is configured (see above). We do not store screenshots
on our servers.

### If you rate an Orbit reply (thumbs up / thumbs down)

Rating a reply is a feedback action, **not** telemetry. See section
5 — it explains exactly what a rating submits.

---

## 5. Feedback submissions

Interactive Sphere has two feedback surfaces, and both store the
content you submit so we can read, triage, and act on it. Storing
your feedback text is the whole point of feedback — this section
exists so you know exactly what each surface captures.

### General feedback (Help → Feedback)

When you submit a bug report, feature request, or other feedback
through the Help panel, we store:

- The text of your feedback, as you wrote it
- The category you chose (bug / feature / other)
- The URL of the page and your browser's user agent
- Any screenshot you explicitly opted to attach
- Any contact email or handle you voluntarily provided
- The app version and currently loaded dataset ID

### Rating an Orbit reply (thumbs up / thumbs down)

When you click thumbs-up or thumbs-down on an Orbit message, the
rating acts as consent to submit **that conversation** for review.
We use these to identify answers that are wrong or unhelpful and
improve the AI docent. Specifically, a rating submits:

- The rating itself (thumbs-up or thumbs-down)
- The assistant reply you rated (truncated to ~50,000 characters)
- Your most recent message (truncated to ~10,000 characters)
- Recent conversation context (up to the last 100 messages or
  ~500 KB, whichever is smaller), trimmed to role + text +
  timestamp — no personal metadata beyond that
- The system prompt that was in effect for that reply (this
  describes how we configured the model — not anything about you)
- Basic model configuration — the model name, reading level, and
  whether Vision Mode was on
- The dataset that was loaded when you rated, and the turn number
  in the conversation
- Any free-text comment you optionally add, and any tags you select
- A message ID so that if you change your rating later, we update
  the existing record instead of creating a duplicate

We do this because a thumbs-down without context is unactionable —
we can't fix a bad answer we cannot see. If you would rather rate
without submitting the conversation, simply don't use the
thumbs-up / thumbs-down buttons; nothing is sent unless you click
one.

### Retention and deletion

We retain feedback submissions indefinitely so we can fix the
issues you report. If you want a feedback submission or rating
deleted, contact us (section 1) with the approximate submit date
and enough text to identify it.

---

## 6. Where the data goes

Everything we store runs on **Cloudflare**:

- **Analytics events**: Cloudflare Workers Analytics Engine (90-day
  hot retention) and Cloudflare R2 object storage (long-term, Iceberg
  format) for research analysis
- **Feedback submissions and Orbit ratings**: Cloudflare D1 (a
  managed SQLite database)
- **Crash reports**: Cloudflare D1, in a separate table from feedback
- **Orbit chat proxy**: our Cloudflare Workers endpoint forwards your
  message to the AI model that generates the reply and streams the
  reply back. The proxy does not log or store message contents. If
  you configure a different AI provider in Orbit settings, messages
  bypass our proxy entirely and go directly to that provider
- Served by **Cloudflare Pages**

We do not use Google Analytics, PostHog, Segment, Amplitude,
Mixpanel, Meta Pixel, or any other third-party analytics service.

When Orbit is using the default AI provider, Cloudflare Workers AI
processes the message on your behalf; its own policies apply in
addition to this one. When Orbit is pointed at a different provider,
that provider's policies apply to the messages you send it.

Nothing is sold, shared with advertisers, or used for cross-site
profiling.

### What stays only on your device

- Your chat history with Orbit (in browser localStorage or the
  desktop app's local data folder)
- Your Orbit settings — API URL, model, reading level, Vision Mode
  preference
- On desktop, any AI provider API key you enter (stored in the
  operating system keychain, not in plaintext)
- On desktop, any offline datasets you download (kept in the app's
  local data folder until you delete them)
- Your telemetry mode preference

---

## 7. How we use the data

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
- **Orbit ratings and rated conversations**: to identify answers
  that were wrong or unhelpful and improve the docent. May be used
  in aggregate, anonymized form for AI model evaluation and training
- **Crash reports**: to fix crashes; retained only as long as needed
  for debugging

We do not use any of this data to target advertising, build user
profiles, or sell to third parties.

---

## 8. Your choices

- **Change telemetry mode** at any time: **Tools → Privacy**. Changes
  take effect immediately — no restart required
- **Disable telemetry entirely**: pick "Off" in the same panel
- **Run a telemetry-free build**: the source code is public; you or
  someone you trust can build the app with the compile-time
  telemetry flag disabled. Those builds emit nothing
- **Use Orbit with a self-hosted AI** (for example, Ollama on your
  own computer) so chat messages never leave your network. Configure
  this under Orbit settings
- **Avoid rating Orbit replies** if you do not want the conversation
  stored for feedback. Ratings are opt-in — nothing is sent unless
  you click thumbs-up or thumbs-down
- **Decline crash reports** when prompted — the app works the same
  either way
- **Request feedback, rating, or crash-report deletion**: contact us
  (section 1)
- **Use the app completely offline**: the desktop build supports
  offline dataset caching. With offline-only use and a self-hosted
  or disabled Orbit, no data leaves your machine

You do not need to accept any analytics, any Orbit rating, or any
crash report to use the app. Turning everything off does not disable
any feature.

---

## 9. Children's privacy

Interactive Sphere is an educational tool and is used in classrooms.
We collect no personal information from any user, regardless of age.
Essential-mode analytics contain no information that could identify a
child (or anyone else) individually. Research mode, Orbit ratings,
and feedback submissions are opt-in actions requiring explicit user
input, and school administrators deploying the app should consider
whether their policies permit them. The Orbit AI docent sends
messages to a third-party AI provider to generate replies; school
administrators should evaluate that too.

---

## 10. International users

This app is developed in the United States. Cloudflare's global
network means events are handled close to you, but ultimately land in
Cloudflare's storage which may be located outside your country.

Rights that may apply to you depending on your jurisdiction (GDPR,
CCPA, UK DPA, and others) — including the right to access, correct,
or delete personal data — are available on request. Because the
telemetry we collect is anonymous and carries no identifier linked
to you, "access" and "deletion" mostly apply to feedback submissions,
Orbit ratings, and crash reports (section 5 and the Crash reports
subsection in section 2).

*[To be refined by legal review before release — this section
intentionally hand-wavy in the draft.]*

---

## 11. Changes to this policy

Material changes will be announced in the app's changelog and in the
GitHub repository. The "Last updated" date at the top of this page
reflects the most recent change.

---

## 12. Contact

*[TBD — populate before release. Expected: a project email, a GitHub
issue link, and a postal contact if any federal or jurisdictional
requirement applies.]*
