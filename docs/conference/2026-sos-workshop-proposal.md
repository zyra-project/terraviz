# 2026 Virtual SOS Workshop — Presentation Proposal

> **Status:** draft for review · **Submission deadline:** June 5, 2026
> **Workshop:** 2026 SOS Users Collaborative Network Virtual Workshop
> (Mon–Wed, Aug 24–26, 2026, 2:00–5:00 PM Eastern)
> **Theme:** *Spheres of Impact: Technology, Education, and Community for Common Ground*
> **Proposed format:** 25-minute Breakout session / small-group discussion
> (≈18 min demo + ≈7 min hands-on discussion)
> **Submitting account:** eric.j.hackathorn@noaa.gov

This document holds the answers to paste into the Google Form, followed
by the supporting session plan. Each form field is reproduced verbatim
with its constraints so the answer can be copied directly.

---

## Form answers (copy-paste ready)

### Presentation title *

> **TerraViz: Put the SOS Catalog on Every Screen — and Publish Your Own Data to It**

_Alternates if a different emphasis is preferred:_

- *Same Data, No Museum Required. Same Publishers, No Platform Required.*
- *Beyond the Sphere Room: A Federated, AI-Guided Home for SOS Datasets*

### Presentation description *

> _Please write a brief description of your presentation and the audience
> it targets. If selected, this description will appear in the workshop
> program. (1600 character limit, ~200 words.)_

Science On a Sphere lives in museums. TerraViz puts it on every screen —
and lets any SOS site publish to every screen. It's a free, open-source
3D globe, live at terraviz.zyra-project.org and installable on Windows,
macOS, and Linux, that streams the SOS catalog to any phone, laptop, or
AR/VR headset. SOS-format tours import unchanged and the catalog seeds
from the SOS dataset library, so your existing work carries over.

This hands-on breakout focuses on what that means for the SOS community.
At /publish you fill out a metadata form, upload image stacks or video,
record a guided tour by flying the camera, and build playlists — then
run your own node so your datasets surface across a federated network of
peers, with your data staying on your hardware. We'll also demo Orbit, an
AI docent that loads datasets by conversation (and can run offline on a
local model), side-by-side multi-globe comparison, and a live look at the
globe floating in the room through a Quest AR headset. Our first peer node
is already coming online at NOAA-GSL.

Open the app on your own phone and follow along. We'll close with a group
discussion: what would you publish to a globe of your own, and where does
AI belong in SOS exhibits? Aimed at SOS site operators, educators,
planetariums, and museums looking to extend their reach beyond the
sphere room.

### What format do you plan to use for this talk?

> _(i.e. PowerPoint, live SOS theater, or pre-recorded video, etc.)_

Live, screen-shared demo of the TerraViz web app (terraviz.zyra-project.org),
with attendees invited to open it on their own devices and follow along.
It includes a ~2-minute live AR demo on a Meta Quest headset — the
photoreal globe anchored and floating in my office — with the headset
view cast into the session so everyone sees it. A short pre-recorded
backup clip (Orbit, a multi-globe tour, and the headset AR view) is on
hand in case of connectivity issues. No slides required, though a
one-slide title/links card will be shown at the start and end. The
session closes with a live, poll-prompted group discussion.

### Is there anything else you would like to tell us about your presentation?

TerraViz is open source (Apache 2.0) and already live and in public use,
so this is a working tool rather than a concept. It speaks directly to
several workshop goals: extending SOS reach beyond the sphere room
(versatility), a shipping AI example with the Orbit docent
(AI-in-the-catalog), and a federation model that lets SOS sites publish
and keep their own data — a concrete path to the community/belonging
objective and a candidate direction for future NOAA support of SOS.

To be transparent about maturity: everything I'll demo is live today, not
a mockup — streaming the SOS catalog, SOS-format tour import, multi-globe,
Orbit, immersive AR/VR, and the full publishing stack at /publish
(metadata form, image-stack and video upload, tour recorder, playlist
editor) plus a companion authoring CLI. Self-hosting a node is documented
(SELF_HOSTING.md), and the first peer node — NOAA-GSL
(github.com/NOAA-GSL/terraviz), stood up in June 2026 — means cross-node
federation is now in early real-world testing rather than theory. I'll
present the wider peer network honestly as early but real.

The core demo is browser-only and needs nothing more than screen share
with audio and a stable connection. The live AR segment adds no burden on
your end — I bring and cast my own Quest headset; if the platform can't
show a cast feed, the pre-recorded headset capture covers it.

### Do you have co-presenters? *

> _Select Yes if you have already confirmed a list of co-presenters._

**No** — _(change to **Yes** and list collaborators if any are confirmed
before submission; one proposal per presentation)._

---

## Supporting material (not submitted — for our own prep)

### Run of show (~25 min)

| Time | Segment | What happens |
|---|---|---|
| 0:00–1:30 | Hook | Open terraviz.zyra-project.org live; invite attendees to open it too. "SOS lives in museums — TerraViz puts it on every screen, and lets any site publish to every screen." |
| 1:30–4:30 | Your SOS work carries over | Stream a familiar SOS dataset; show an SOS-format tour importing unchanged; the catalog seeds from the SOS library. |
| 4:30–9:30 | Publish your own data (live) | Walk the live /publish portal — metadata form, image-stack/video upload, tour recorder, playlist editor — then run your own node so peers surface your rows; data stays on your hardware. Point to the first peer node, NOAA-GSL, stood up June 2026 — federation in early real-world testing. "NOAA's data is the seed, not the ceiling." |
| 9:30–13:30 | Orbit, the AI docent | Ask Orbit a question; it explains the science and loads the dataset by conversation. Note the offline/local-LLM option. (Workshop's AI-in-the-catalog goal.) |
| 13:30–15:30 | Versatility showcase | Multi-globe comparison (SSP1 vs. SSP5) and one TypeScript codebase across web, desktop, and mobile. |
| 15:30–17:30 | Live AR demo (Quest) | Put on the headset and anchor the photoreal globe in my office — floating in the room, walkable — via WebXR "Enter AR" on a Quest, cast live into the session. Pre-recorded headset capture as backup. |
| 17:30–25:00 | Polls + group discussion | See interactivity plan below. |

### Interactivity plan (required by the form)

- **Hands-on, live:** attendees open the URL on their own phones/laptops,
  load a dataset, then ask Orbit a question and watch it load data by
  conversation.
- **Polls (1–2 quick questions):** e.g. *"Do you have visualizations
  you'd publish if reach didn't require a museum or platform partner?"*
  and *"Would an AI guide help or worry you in your exhibits?"* — used to
  steer the discussion.
- **Group discussion (final ~8 min):** *What would you publish to a globe
  of your own, and what would hold you back? Where does AI belong in SOS
  exhibits — and where doesn't it?*

### How the session maps to the workshop goals

| Workshop goal | How the session delivers |
|---|---|
| Showcase the versatility of SOS technology | Same SOS datasets on web, desktop, mobile, and AR/VR — beyond the sphere room |
| **Share ways of creating SOS datasets (spherical & non-spherical media)** | Publishing workflow + tour authoring; SOS-format tours import unchanged; equirectangular sphere thumbnails |
| Tools & resources for understanding SOS data | Orbit explains datasets conversationally; multi-globe enables side-by-side comparison |
| **AI in catalog / interactive exhibit / education** | Orbit (hybrid local + LLM docent) is a live, production example |
| Educational & technical training | Walkthrough plus a documented path to self-host a node (SELF_HOSTING.md) |
| **Sense of belonging / community** | Federation = a peer network of SOS sites; open source; community translations; self-host to publish and keep your own data |
| **Inform future NOAA direction** | The federated-catalog model itself is a candidate direction for supporting SOS — first peer node (NOAA-GSL) online June 2026 |

### A/V & tech needs

- Screen share **with audio** (for an HLS video dataset).
- Stable internet connection (pre-recorded backup clip mitigates risk).
- **Meta Quest headset** (mine) for the ~2-min live AR demo, with its
  view **cast** to a PC that is then screen-shared into the session.
  - Launch gotcha: open the live app as a **top-level page** in the Quest
    browser — WebXR "Enter AR" won't fire from inside an embedded iframe.
  - Rehearse the Quest → PC casting path on the actual workshop platform
    beforehand; keep the pre-recorded headset capture queued as fallback.

### Reference links

| Resource | URL |
|---|---|
| Live web app | https://terraviz.zyra-project.org |
| Interactive poster | https://poster.terraviz.zyra-project.org |
| Source code | https://github.com/zyra-project/terraviz |
| First peer node (NOAA-GSL) | https://github.com/NOAA-GSL/terraviz |
| DOI (citation) | https://doi.org/10.5281/zenodo.20043181 |

---

## Follow-up idea: a separate poster-style capture of this session

After the workshop we may turn this presentation — plus any feedback,
polls, and discussion captured during the breakout — into its own
**separate** poster-style page. This would be a distinct presentation,
*not* added to the existing interactive poster (`poster/`). It would
borrow the same build approach as a reference — the existing poster is
built by `poster/scripts/build_poster.py` from section fragments under
`poster/sections/` (see [`docs/POSTER_PLAN.md`](POSTER_PLAN.md)) — but
live in its own directory with its own sections and assets.

Sketch of what that separate capture page could include:

- The proposal abstract and run-of-show above.
- A short results section: poll outcomes, notable questions, and themes
  from the group discussion.
- Embedded screenshots / the WebXR `.glb` model already used by the poster.
- Links back to the live app and the recorded session, if one exists.

This is a **future**, **standalone** deliverable, scoped here only so the
intent isn't lost. Build it after Aug 26, 2026, once feedback exists to
capture — as its own poster/presentation, separate from `poster/`.
