# Acquiring a YouTube Data API key

Status: operator guide — needed only for the agency-YouTube
media-suggestion source.

The media suggestion engine
(`src/ui/publisher/components/events/media-suggest.ts`) offers curators
event media from keyless, public-domain sources — NASA Worldview
snapshots, Wikimedia Commons photos, USGS ShakeMaps, NHC forecast
cones. The one source that **does** need a credential is agency
**YouTube** video (NOAA, NASA, USGS channels): searching YouTube
programmatically goes through the **YouTube Data API v3**, which
requires an API key. This guide walks through getting one, locking it
down, and wiring it into a TerraViz deployment.

> **Which channels count as reputable?** The search proxy keeps a
> result only when its channel is on the effective allowlist: the
> built-in curated set (the NASA family incl. Goddard & JPL, the NOAA /
> NWS family, USGS, and international science agencies — ESA, Copernicus,
> ECMWF, NSIDC, NCAR/UCAR) in
> [`functions/api/v1/_lib/youtube-channels.ts`](../functions/api/v1/_lib/youtube-channels.ts),
> **plus** the node's own custom channels. Publishers add those at
> runtime — no redeploy — in the **Feeds console** ("Trusted video
> channels" card): paste a channel URL and it's resolved to the
> canonical id and stored (`youtube_channels` table). Editing the
> hardcoded file changes the built-in defaults for a fork; the
> per-node additions live in the console.

The key is free. No billing account is required for the default quota,
and the quota comfortably covers this feature's usage pattern (see
[Quota math](#quota-math)).

---

## Step 1 — Sign in to Google Cloud Console

Go to <https://console.cloud.google.com> and sign in with any Google
account. A personal account works; for a team deployment prefer an
organizational account so the key doesn't live in one person's
personal project.

## Step 2 — Create (or pick) a project

API keys belong to a *project*.

1. Open the **project picker** in the top bar (it shows the current
   project name, or "Select a project").
2. Click **New project**.
3. Name it something recognizable — e.g. `terraviz-media` — and click
   **Create**.
4. Wait for the notification, then make sure the new project is the
   one selected in the picker.

## Step 3 — Enable the YouTube Data API v3

1. In the left navigation, go to **APIs & Services → Library**.
2. Search for **"YouTube Data API v3"**.
3. Open it and click **Enable**.

Nothing else in the YouTube API family is needed — not the Analytics
API, not the Live Streaming API.

## Step 4 — Create the API key

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create credentials → API key**.
3. The key appears immediately. Copy it somewhere safe — you'll store
   it as a Cloudflare secret in Step 6.

## Step 5 — Restrict the key (do not skip)

An unrestricted key that leaks can be used against *any* Google API
enabled on your project, billed to you. Restrict it immediately:

1. On the **Credentials** page, click the key's name to edit it.
2. Under **API restrictions**, choose **Restrict key** and tick only
   **YouTube Data API v3**.
3. Under **Application restrictions**, choose **None**.

   This looks wrong but is correct for this deployment: TerraViz calls
   the API **server-side** (from a Cloudflare Pages Function), and the
   two restriction types that would apply don't fit —
   *HTTP referrer* restrictions only work for browser-originated
   calls, and *IP address* restrictions can't be used because
   Cloudflare Workers egress from a large, changing IP pool. The API
   restriction from the previous step is the meaningful lock.
4. Click **Save**. (Restrictions can take a few minutes to propagate.)

## Step 6 — Store the key as a Cloudflare secret

The key must never ship in the client bundle or be committed to the
repository. Store it as a Pages secret, following the same pattern as
the other server-side credentials in
[`docs/SELF_HOSTING.md`](SELF_HOSTING.md):

```bash
# From the repo root, authenticated to your Cloudflare account:
npx wrangler pages secret put YOUTUBE_API_KEY --project-name <your-pages-project>
# Paste the key when prompted.
```

Or via the dashboard: **Workers & Pages → your project → Settings →
Environment variables → Add variable**, type **Secret**, name
`YOUTUBE_API_KEY`. Add it to the **Production** environment (and
**Preview** too if you want to exercise the feature on preview
deploys).

The YouTube suggestion source reads `context.env.YOUTUBE_API_KEY` in a
publish-scoped Pages Function (`youtube-search.ts`, mirroring the NHC
storms proxy `nhc-storms.ts`) and degrades to "no suggestion" when the
secret is absent, like every other source. No key, no error: the
feature simply stays off.

## Step 7 — Sanity-check the key

```bash
curl -s "https://www.googleapis.com/youtube/v3/search?part=snippet&q=hurricane&type=video&maxResults=1&key=YOUR_KEY" | head -30
```

A JSON payload with an `items` array means the key works. A 403 with
`API_KEY_SERVICE_BLOCKED` usually means the API restriction hasn't
propagated yet or the wrong API was ticked in Step 5.

---

## Quota math

Every project gets **10,000 units per day** free. Costs that matter
here:

| Operation | Endpoint | Cost |
|---|---|---|
| Search for videos | `search.list` | 100 units |
| Look up video details | `videos.list` | 1 unit |
| Look up channel details | `channels.list` | 1 unit |

The suggestion engine runs **once per event at curation time** — not
per visitor — and only for events a curator actually opens in the
review queue. Each such run issues **one `search.list` per allowlisted
channel** it searches: a global search filtered *down* to a handful of
agency channels almost never surfaces one (YouTube's relevance ranking
fills the top of a broad query with news orgs and random uploaders), so
the proxy instead searches *within* each vetted channel by `channelId`
and merges the hits. That trades quota for reliability — cost is
`100 × channels-searched` units per event, not a flat 100.

The proxy caps the fan-out at **20 channels** per request (custom
channels first, then the built-in agency defaults in priority order),
which comfortably covers the built-in set of ~18 vetted channels plus a
couple of a node's own. So a single event with the full default set
costs ~1,800 units (18 × 100).

Two things bound the real spend:

- **The KV cache** (1 hour, keyed by query) makes re-opening the *same*
  event free — but note the cache does **not** help across *distinct*
  events, since each event's title is a different query.
- **Only opened events** trigger a search, and only while an event
  still lacks a video.

The practical implication: on the free 10,000-unit daily quota a node
can review roughly **5 distinct events per day** with the full default
allowlist before hitting the cap. That's fine for a small node, but a
busy newsroom will exhaust it. If that's you, you have three levers:

1. **Request a quota increase** — the YouTube Data API grants these for
   free through the Google Cloud console; this is the intended path for
   higher volume.
2. **Disable channels you don't need** — in the **Feeds console →
   "Trusted video channels"** card, each built-in channel has a
   **Disable** toggle. A disabled channel is dropped from the search
   fan-out (and its quota) for your node, with no source edit or
   redeploy, and can be re-enabled anytime. This is the per-node way to
   trim the list to your subject area.
3. **Trim the built-in defaults** for a whole fork by editing
   [`youtube-channels.ts`](../functions/api/v1/_lib/youtube-channels.ts).
4. **Lower the cap** (`MAX_CHANNELS_SEARCHED` in `youtube-search.ts`) so
   each event searches only the highest-priority channels.

If the quota is ever exhausted the API returns 403 `quotaExceeded`,
which the source treats like any other failure: no card, no error
surfaced to visitors.

## Terms-of-service note: embeds, not images

Unlike the public-domain sources, YouTube results **cannot** be
stored as an event's `image_url` — hotlinking thumbnails as your own
content is off-limits under the YouTube API Terms of Service, and the
stored image field carries no attribution. The planned source instead
feeds the **tour media rail's embed path** (`youtube-nocookie.com`
iframes, already supported by the tour engine's `showPopupHtml`), so
the video plays as an embedded player with YouTube's own branding and
attribution intact.

## Key rotation / revocation

If the key leaks: **Credentials → the key → Regenerate key** (or
delete it and create a fresh one), then update the Cloudflare secret
with the new value. Because the key only ever lives server-side,
rotation is a one-place change.
