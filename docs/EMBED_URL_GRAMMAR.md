# Embed URL Grammar — v1

**Status: stable (grammar v1).** This is the public contract for
deep-linking and embedding the TerraViz web app by URL. It is the
surface external hosts compose against — the companion poster, kiosk
displays, and (the reason it is written down) the WordPress plugin's
Gutenberg blocks and shortcodes
([`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md) §3).

Because independent consumers now depend on these parameters, they
are treated as a versioned contract, not incidental query handling:
additive changes are safe; renaming or removing a parameter, or
changing an accepted value's meaning, is a breaking change that bumps
the grammar version and is called out in the Changelog below. This
mirrors the "publish the contract, don't share the source" discipline
in [`architecture/federation-scoping.md`](architecture/federation-scoping.md)
§7 Directive 2 — a host composing these URLs should never have to
read `src/main.ts` to know what is safe to rely on.

The parameters are read at boot by `src/main.ts` and the helpers in
`src/utils/{catalogMode,embedMode,posterDeepLinks}.ts` /
`src/services/deepLinkService.ts`. Behaviour is deliberately
conservative: an unknown parameter value is a silent no-op, and the
URL is not rewritten after boot, so a refresh preserves the linked
state. The output page's parameters (below) are read by
`src/output/webMode.ts`, at load and on every change to the part after
`#`, under the same rules, and applied by `src/output/webOutput.ts`,
`webDataset.ts` and `webClock.ts`.

---

## Base URL

An embed targets a full TerraViz **origin** — the app runs inside the
iframe against its own `/api`, so the host page's own domain is
irrelevant to data loading:

```
https://<terraviz-node>/?<params>
```

`<terraviz-node>` is the canonical deployment
(`terraviz.zyra-project.org`) or a partner-operated node. It is never
the WordPress site's own origin.

---

## Selector parameters — what to show

Exactly one selector is normally used per embed. If more than one is
present, the precedence is `dataset` > `tour` > `catalog` (`?dataset=`
wins, and `?tour=` is skipped when `?dataset=` is also set —
`src/utils/posterDeepLinks.ts:174-188`).

| Parameter | Value | Effect | Source |
|---|---|---|---|
| `dataset` | catalog ID (e.g. `INTERNAL_SOS_123`) | Boot straight into that dataset on the globe. | `src/main.ts` initial-load path |
| *(path form)* `/dataset/<id>` | catalog ID | Equivalent to `?dataset=<id>`; canonicalized to the query form at boot. | `src/services/deepLinkService.ts:72-77` |
| `tour` | tour slug, catalog ID, or legacy ID | Boot straight into a tour. Resolves **only** to rows whose `format === 'tour/json'`; a non-tour match is a no-op by design. | `src/utils/posterDeepLinks.ts:111-137` |
| `catalog` | `true` (or any value except `false`/`0`) | Catalog mode — the dataset browser is the primary surface; the globe stays hidden until selection. | `src/utils/catalogMode.ts:21-28` |
| `preview` | opaque token (with `&dataset=<id>`) | Load a token-gated **draft** dataset. For authoring previews, not public embeds. | `src/main.ts` preview deep-link path |

---

## Embed parameters — how much chrome

| Parameter | Value | Effect |
|---|---|---|
| `embed` | `1` (or any value except `false`/`0`) | **Minimal-chrome mode.** Hides the tools menu, help trigger, home button, and Orbit chat trigger; outside catalog mode also hides the browse overlay and the catalog↔sphere tab control. Keeps the globe and the playback transport. Applied before first paint so no chrome flashes in. |
| `chat` | `1` | Only meaningful with `embed=1`. Keeps the **Orbit chat trigger** for a "dataset + ask Orbit" embed. Omit for a fully minimal embed. |

`embed` and `chat` parse with the same truthy convention as
`catalog` (`false`/`0` are the only opt-outs, case-insensitive —
`src/utils/embedMode.ts`). In catalog mode (`?catalog=true&embed=1`)
the browse grid and the tab control are **kept**, since the catalog
grid is the point of that embed.

---

## View modifiers — optional, composable

These layer on top of any selector. Each is independent.

| Parameter | Accepted values | Effect | Notes |
|---|---|---|---|
| `terrain` | `on` | Enable 3D terrain. | Only `on` acts; any other value is a no-op. |
| `labels` | `on` | Show place labels. | " |
| `borders` | `on` | Show country/coastline borders. | " |
| `rotate` | `on` | Start auto-rotation. | " |
| `layout` | `1`, `2`, `4` | Multi-globe grid (`2` = side-by-side). | `src/utils/posterDeepLinks.ts:74-94` |
| `setview` | `1`, `2h`, `2v`, `4` | Legacy/advanced layout form (accepts vertical `2v`). | Prefer `layout`; `setview` is the older dev alias. |
| `orbit` | `open` | Open the Orbit chat panel on load. | Optionally seed the input with `&prompt=tour`. |
| `prompt` | `tour` | Seed text for the Orbit input when `orbit=open`. | Unknown values open the panel without a seed. |

The view toggles (`terrain`/`labels`/`borders`/`rotate`) are applied
by clicking the real Tools-menu buttons, so analytics, accessibility
announcements, and button state stay in sync even when the chrome is
hidden by `embed=1`.

---

## The output page — a globe's texture

The renderer built for physical spheres
([`MULTI_MONITOR_PLAN.md`](MULTI_MONITOR_PLAN.md)) also runs in an
ordinary browser, at a base URL of its own:

```
https://<terraviz-node>/output/output?<params>#<params>
```

The path is exactly `/output/output`. Any path the site doesn't
recognise, `/output.html` included, serves the main app instead.

It draws the globe unwrapped into a 2:1 equirectangular picture with
no chrome at all. That is the texture a sphere, a dome or a Second Life
prim is wrapped in
([`SECOND_LIFE_COMPAT.md`](SECOND_LIFE_COMPAT.md) §7). So none of the
main app's parameters apply here, and these apply nowhere else. A bare
address is the live Earth: today's clouds and the real day/night line.

**The query and the fragment are one parameter set.** A key after `#`
replaces the same key before it. A browser applies a change to the
part after `#` without reloading the page, and the page re-reads its
address on every such change. So a fixed setup can sit in the query,
and anything a controller changes during a session belongs after `#`.
Keep a `#` in the address for the whole session: a change from an
address with a fragment to one without is an ordinary navigation, and
reloads every copy.
Whether Second Life passes a fragment-only change on to every visitor
is [`SECOND_LIFE_COMPAT.md`](SECOND_LIFE_COMPAT.md) §10 question 10.

| Parameter | Accepted values | Effect | Default |
|---|---|---|---|
| `dataset` | the node's own dataset id, the one `GET /api/v1/datasets/:id` takes | Show that dataset. A video plays and an image holds. | the live Earth |
| `fit` | `fill` | Stretch the picture to the page instead of letterboxing it. For a page used as a texture, whose shape the host may not keep at 2:1. | letterbox (`contain`) |
| `width` | `1024`, `2048`, `4096`, `8192` | The picture's width in pixels; its height is half. A video stream is capped at the narrowest rendition at least this wide, and an image takes its narrowest size at least this wide. | the narrowest of these at least as wide as the picture is shown on the page, up to `4096` |
| `rotation` | degrees | The longitude at the centre of the picture once it comes to rest (below), in degrees east: `rotation=90` puts 90°E at the centre. Wrapped round the turn. With `lat` at a pole, where every longitude meets, the meridian the centre sits on: it runs up the picture from the South Pole and down it from the North Pole, so `lat=90&rotation=180` puts 0°E up. | `0` |
| `lat` | degrees, −90 to 90 | The latitude at the centre of the picture once it comes to rest, in degrees north. The picture turns to bring it there with north up, so `lat=-90` puts the South Pole at the centre of an upright sphere. | `0` |
| `zoom` | 0 or more | How far the centre of the picture is magnified once it comes to rest, in the main app's zoom levels. The far side shrinks rather than being cut off, so the whole Earth is still on the sphere. A zoom past about `5.67`, the most the picture can magnify, reads as that most. | `0` |
| `debug` | present | The output's debug readout, drawn on the picture. | off |
| `t` | seconds into the clip, 0 or more | Where the clip is. A `t` past the clip's end wraps round it, paused or playing. The clip's length is its stream's playlist total, the `#EXTINF`s summed, from the first rendition the copy loads. Copies agree on it wherever the renditions do, as they do on the node's own bundles and on the Vimeo streams the node has checked. For those two, the node's exhibit card sends the same sum. A copy with no playlist to read a length from wraps on the video's own length: a single file, or a browser that plays HLS itself rather than through hls.js. | `0` |
| `at` | Unix time in seconds, decimals allowed | When `t` was current. A playing copy shows `t + (now − at) × rate`, wrapped round the clip. | when this copy read the address: at load, or at the `#` change that last changed the clock |
| `rate` | 0.0834 to 12.8 | Playback speed; `1` is the clip's own. The player's own limits are 0.0625 to 16, and a copy needs room above and below the rate to catch up or fall back, so values outside this narrower range read as `1`. | `1` |
| `paused` | present | Hold `t` exactly. Every copy shows the same frame. | playing |
| `telemetry` | `1` or `true` (case-insensitive, untrimmed) to turn it on | Whether the page reports its own anonymous Essential telemetry: which dataset it showed and anything that would not play (below). Followed live, like every other setting. | off |

- **`dataset` is narrower than the main app's.** The app also resolves
  legacy catalog ids (`INTERNAL_SOS_123`) and slugs; this page asks the
  node for exactly the id it is given.
- **A dataset that will not show leaves the live Earth up**, on every
  copy, whatever it was showing before. So copies at one globe converge
  on the same picture rather than staying on different ones. They can
  still differ while a dataset loads, and for up to one retry interval
  after the node recovers, since each copy retries on its own schedule.
  A failure that may pass (the node unreachable, an HTTP error, a
  response cut short or not JSON, a picture or stream that will not
  load) is retried after 5 s, 30 s and 2 minutes, then every 5 minutes,
  for as long as the address names the dataset. A dataset the node does
  not have, or cannot put on a sphere (a tour), is not retried. A
  stream that fails after it has started playing is not recovered, and
  keeps its last frame; with telemetry on, its errors are reported.
- **Every value fails closed, one at a time.** A malformed or
  out-of-range value is ignored and that setting keeps its default; the
  page is never refused for it. That includes the clock: each of `t`,
  `at`, `rate` and `paused` has its own default, so `paused` alone
  pauses at the start.
- **Numbers are plain decimals**: digits, an optional point, and an
  optional leading minus. `0x1000`, `4e3` and padded values are not
  numbers here.
- **`debug` and `paused`** follow the
  [truthy convention](#stability-guarantees) exactly as `embed` does.
- **Paused is exact; playing is close.** Paused copies seek to `t`
  itself. Playing copies steer their video toward the target with the
  desktop outputs' control law, the short way round the loop. They stay
  within a fraction of a second of the clip once settled, but not on the
  same frame. Each pass round the clip restarts the video, which holds
  the picture for about 50 to 250 ms and leaves a copy up to that times
  `rate` behind in the clip until it catches up. So how close copies
  stay depends on the clip's length and the rate. On a short clip at a
  high rate they don't settle at all: a 4.3 s clip at rate 12.8 restarts
  three times a second.
- **A shared clock needs `at`.** Without it each copy times `t` from
  when it read the address, so copies that loaded at different moments
  differ. With it they agree as far as their computers' clocks do, so
  the shared clock assumes visitors' clocks are set from internet time.
- **Whoever controls the globe writes a new `t` and `at` on every
  pause, resume and jump.** Resuming at 40 s and resuming at 70 s are
  then different addresses.
- **`rotation`, `lat` and `zoom` name the view the picture comes to
  rest on, and the picture moves there like a heavy globe.** A change
  to any of them after the `#` sets the picture moving at once. It is
  at full speed after about a quarter of a second, then coasts to a stop
  on the new view, slowing like a spun globe on its bearing: a 30° turn
  is 95% done in about two seconds. A new view that arrives while it
  still moves pushes it on rather than stopping it, so a controller that
  can change the address only once a second still looks like one
  movement. Every copy that applied the same last address turns the
  same way round: the shorter way from that address to the new one, and
  for half a turn, the way that has the centre's longitude counting up.
- **Write the view to rest on, at most once a second.** The picture is
  not a display of the latest value: a composer that animated these
  keys by writing them faster would see the picture trail by most of a
  second, and a back-and-forth swing made every two seconds shrink to
  about 40% of its size.
- **Some views are set at once.** The first reading of an address is
  shown at once, so a copy that opens mid-session matches the others.
  So is every view for a viewer whose browser reports that they asked
  for reduced motion; whether Second Life's browser reports it is not
  known.
- **The camera is the desktop output's.** `lat`, `rotation` and `zoom`
  turn and magnify the picture the way a desktop output that follows
  its control globe does, with north up. Before `lat` and `zoom`
  existed, `rotation` turned the picture about the poles, and it still
  draws the same picture.
- **A `width` change during a session** resizes the picture at once.
  The video cap and the image size follow at the next dataset load.
  With no `width`, the picture's size is read when the address is
  applied, at load and on each `#` change, and not when the page is
  resized.
- **The video cap is for streams.** A dataset with no stream plays its
  single file whatever the width, and a stream with no rendition that
  wide is not capped.
- **Composers must not send `mode`.** It belongs to the desktop
  outputs, is read only from the query, and is outside this contract. A
  `mode` this build does not know draws nothing at all, and one naming
  another geometry reads none of the above.
- **The page reports nothing unless `telemetry=1` turns it on.** It
  loads for everyone in range of a globe, shows no banner and has no
  Privacy panel, and anyone can point a globe at a public node, so only
  a globe whose owner chose to measure it reports. An owner who turns it
  on should say so where the globe is.
  - **What it sends**, only in the first minute after the page loads
    and with nothing sent after about 66 s, even on a retry: which
    dataset reached the picture and how long that took, and a one-word
    reason when a dataset or its stream ran into trouble
    ([`ANALYTICS.md`](ANALYTICS.md), [`PRIVACY.md`](PRIVACY.md)). A
    `telemetry=1` that arrives after that minute reports nothing.
  - **Steer a measured globe after the `#`.** A change before it reloads
    the page in every viewer, and each reload reports again as a new
    visit, which links the visitors present and bounds how long they
    stay.
  - **What it never sends:** a session event (so no operating system,
    language or screen), anything after that first minute, the
    address's text, the globe's location, or anything about who is
    looking. A browser that sends Global Privacy Control gets nothing
    reported whatever the address says.
  - **`telemetry` fails toward off**, the one flag that does: only `1`
    or `true` (case-insensitive, untrimmed) turns it on, so
    `telemetry=off`, `=no`, a bare `telemetry` and an empty value all
    leave it off. It is followed live: a later `#telemetry=0` stops
    further reports, though events the page already queued may still
    be sent.
  - A desktop output window sends nothing itself. Its control window
    reports a stream that died there.

```text
# The live Earth on a 2048×1024 media face
https://terraviz.zyra-project.org/output/output?fit=fill&width=2048

# A dataset, paused on one frame for everyone
https://terraviz.zyra-project.org/output/output?dataset=<id>&fit=fill&width=2048#t=61.2&paused=1

# The same dataset playing from 100 s, as of 17:00 UTC on 24 October 2026
https://terraviz.zyra-project.org/output/output?dataset=<id>&fit=fill&width=2048#t=100&at=1792861200

# The South Pole brought to the centre, magnified, with 0°E running up from it
https://terraviz.zyra-project.org/output/output?dataset=<id>&fit=fill&width=2048#lat=-90&rotation=0&zoom=1
```

---

## Composition examples

These are the exact shapes the WordPress blocks (and the poster)
compose:

```text
# Single dataset, minimal chrome
https://terraviz.zyra-project.org/?dataset=INTERNAL_SOS_123&embed=1

# Single dataset with terrain + auto-rotate, and Orbit available
https://terraviz.zyra-project.org/?dataset=INTERNAL_SOS_123&embed=1&chat=1&terrain=on&rotate=on

# A tour, minimal chrome
https://terraviz.zyra-project.org/?tour=climate-futures&embed=1

# The full catalog browser, embedded (grid + tab control kept)
https://terraviz.zyra-project.org/?catalog=true&embed=1

# Four-globe layout, embedded
https://terraviz.zyra-project.org/?dataset=INTERNAL_SOS_123&embed=1&layout=4
```

---

## Stability guarantees

- **Additive by default.** New parameters and new accepted values may
  appear without a version bump. A host that ignores unknown
  parameters keeps working.
- **Truthy convention is fixed.** `catalog`, `embed`, and `chat`, and
  the output page's `debug` and `paused`, all treat presence as on and
  only `false`/`0` (case-insensitive, untrimmed) as off. New boolean
  flags should follow the same convention. The one exception is the
  output page's `telemetry`, a privacy switch: only `1`/`true`
  (case-insensitive, untrimmed) is on, and anything else, presence
  alone included, is off, because the
  usual reading would turn it on for `telemetry=off`.
- **Breaking changes bump the version.** Renaming or removing a
  parameter, or changing what an existing value does, is a v2 change
  and appears in the Changelog with a migration note.
- **`embed=1` is presentational only.** It never changes what data
  loads or which API is called — only which chrome is visible. A
  host can add or drop `embed=1` on any otherwise-valid URL.

---

## Changelog

| Grammar version | Date | Change |
|---|---|---|
| v1 | 2026-07-04 | Initial written contract. Documents the pre-existing `dataset` / `/dataset/:id` / `tour` / `catalog` / `preview` selectors and the `terrain` / `labels` / `borders` / `rotate` / `layout` / `setview` / `orbit` / `prompt` modifiers, and introduces the new `embed` minimal-chrome flag and its `chat` sub-flag. |
| v1 | 2026-10-24 | Additive. The output page (`/output/output`) gains its parameters: `dataset`, `fit`, `width`, `rotation` (the longitude at the picture's centre), `debug`, and the clock `t` / `at` / `rate` / `paused`, each with its own default, read from the query and the fragment alike. No main-app parameter changes. A bare output-page address draws the live Earth it always did, now sized to the page as displayed and with clouds that refresh. Later the same day, also additive: `telemetry=1`, which turns on the page's own Essential telemetry, off by default. It fails toward off rather than following the truthy convention. |
| v1 | 2026-10-25 | Additive, with one behavior change. The output page gains `lat`, the latitude at the picture's centre, and `zoom`, which magnifies it, through the desktop output's follow turn; a zoom past what the picture can magnify (about 5.67) reads as that most. `rotation` keeps its meaning and draws the same picture at rest as before; at a pole it names the meridian the centre sits on. The behavior change: the three keys name the view the picture comes to rest on, and a change to any of them after the `#` now sets the picture moving, coasting to a stop on the new view like a spun globe on its bearing, instead of jumping there. The first reading of an address, and every view for a viewer whose browser reports reduced motion, still jump. Kept in v1 by the maintainer's decision of 25 October 2026, recorded in #501: the section was a day old, and every known composer writes at most once a second, the Second Life limit. **Migration:** a composer that animated `rotation` by writing it faster than once a second now sees the picture trail by about 0.8 s, and its swings shrink to about 40% at 0.5 Hz; write the view the picture should come to rest on, at most once a second. No main-app parameter changes. |
| v1 | 2026-10-26 | One behavior change. The output page's clock (`t`, `at`, `rate`, `paused`) wraps on the clip's playlist total, the `#EXTINF`s summed from the first rendition a copy loads, rather than on the video element's `duration`. That `duration` was the same number until a stream had buffered to its end and then the latest end of every track: measured in Chromium, 21 to 40 ms longer on the node's bundles with a sound track. So a copy changed its period partway through, copies on different engines looped on different periods, and the gap grew with every loop since `at`. A copy with no playlist to read a length from (a single file, or a browser playing HLS itself) still wraps on the video's own length. No key, type or range changes. Kept in v1 by the maintainer's decision of 26 October 2026, recorded in #502: the section was two days old, and the old period was never stable even on one copy. **Migration:** nothing for a composer, which writes the same keys. A copy opened before the change keeps the old period until it reloads, so on a bundle with a sound track it can show a different point of the loop from a new copy; any change before the `#` reloads every copy. No main-app parameter changes. The same day, "Paused is exact; playing is close" was reworded to state its limit, which was already so: each pass round the clip restarts the video, so how close playing copies stay depends on the clip's length and the rate, and on a short clip at a high rate they don't settle. No behavior changes with that. |

---

## See also

- [`WORDPRESS_INTEGRATION_PLAN.md`](WORDPRESS_INTEGRATION_PLAN.md) §3 — the Gutenberg blocks that consume this grammar
- `src/utils/embedMode.ts` — the `embed` / `chat` reader + body-class application
- `src/utils/catalogMode.ts` — the `catalog` reader
- `src/utils/posterDeepLinks.ts` — `tour` / view-toggle / `orbit` dispatch
- `src/services/deepLinkService.ts` — `/dataset/:id` path form and native `zyra://` links
- `src/styles/embed.css` — the chrome-hiding rules `embed=1` switches on
- `src/output/webMode.ts` — the output page's reader; `webOutput.ts` — how it is applied; `webDataset.ts` — the dataset fetch; `webClock.ts` — the shared clock; `webCamera.ts` — the camera and its glide
- `scripts/second-life-probe/terraviz-globe.lsl` — an in-world composer of output-page addresses, and of a main-app `/?dataset=` link for visitors. Its `globe.test.ts` fails if a key it writes is renamed or removed, or stops accepting a value the script writes; a change in what a value does is not caught there
- `scripts/second-life-exhibit/terraviz-exhibit.lsl` — the exhibit's globe script, composing the same output-page addresses with a copy of the smoke-test script's code, held to the page by the same `globe.test.ts`, which likewise doesn't catch a change in what a value does. Its `terraviz-exhibit-info.lsl` gives visitors a main-app `/dataset/<slug>` link, or `/dataset/<id>` for a slug `src/utils/datasetUrl.ts` wouldn't emit
- [`SECOND_LIFE_COMPAT.md`](SECOND_LIFE_COMPAT.md) §7 — why the output page takes these parameters
