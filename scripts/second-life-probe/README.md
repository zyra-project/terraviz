# TerraViz in Second Life: the globe and the probe kit

[TerraViz](https://terraviz.zyra-project.org) is a free, open-source
globe for environmental data, most of it from NOAA's
[Science On a Sphere](https://sos.noaa.gov/) collection. It runs in a
web browser and as a desktop app, and any museum, lab or school can run
its own copy of the service, called a node.

In Second Life, a sphere can show a web page on its surface, which every
visitor's viewer loads for itself. TerraViz's output page draws the whole
Earth unwrapped into a flat picture for exactly that, and it reads what
to show from its own address. So a script that writes the address
controls the globe for everyone at once. Why it works this way, what was
tested in-world, and what is still open are in
[`docs/SECOND_LIFE_COMPAT.md`](../../docs/SECOND_LIFE_COMPAT.md). Every
setting the address can carry is in
[`docs/EMBED_URL_GRAMMAR.md`](../../docs/EMBED_URL_GRAMMAR.md#the-output-page--a-globes-texture).

This folder holds three LSL scripts:

- **The globe** (`terraviz-globe.lsl`) puts TerraViz datasets on a sphere
  that visitors see, controlled by its owner in chat. It is for smoke
  testing that page in-world. The exhibit version, with a presenter list
  and controls visitors can touch, is in
  [`../second-life-exhibit/`](../second-life-exhibit/README.md).
- **The probe** (`terraviz-probe.lsl`) and **node check**
  (`node-check.lsl`) test what a viewer can do, and report the answers
  in local chat. They produced that doc's §3–§5, and are mostly useful on
  a machine or viewer nobody has tried yet (its §10, question 8).

| File | What it is |
|---|---|
| `terraviz-globe.lsl` | **The globe script.** Paste it into a sphere. Not generated: edit it directly. |
| `terraviz-probe.lsl` | **The probe script.** Serves its own test page onto the prim through shared media and switches it between tests on chat commands. Generated; don't edit it. |
| `node-check.lsl` | **Optional, beside the probe.** Asks the TerraViz node for data and says what that costs a script's memory. |
| `probe.html`, `probe.template.lsl` | What `terraviz-probe.lsl` is generated from. Edit these. |
| `build.ts`, `index.ts`, `harness.ts`, `build.test.ts` | The probe's generator, its command line, a headless-browser check of the page, and the tests that keep the generated script in step. |
| `globe.test.ts` | Holds this globe script and the exhibit's to what the output page reads: each key and value they write, which half of the address each goes in, their rate limits, the dataset ids they accept. |

## The globe

### Before you start

- A region where you can rez objects and run scripts. A sandbox is fine.
- Shared media switched on in your viewer, with auto-play allowed. In
  Firestorm: Preferences → Sound & Media.
- No L$. Nothing here uploads anything.
- **Which node the globe shows.** The script's first setting, `NODE`, is
  `https://terraviz.zyra-project.org`. To test a build before it reaches
  that site, point `NODE` at its preview deploy, with no slash at the
  end: `https://<alias>.terraviz.pages.dev`. The alias is the branch name
  lowercased, with every character that isn't a letter or a digit as `-`,
  cut to 28 characters and with any trailing `-` dropped. The CI run's
  Deploy step prints it as the "Deployment alias URL". A preview reads
  the same catalog, so the script's dataset names work there too. A node
  without the output page's web mode ignores the settings and shows the
  live Earth whatever you ask for.

### Setting it up

1. Rez a sphere. A default prim sphere is fine.
2. In its Content tab, make a **New Script**, replace its text with all
   of `terraviz-globe.lsl`, set `NODE` if you need to, and save.
3. Within a few seconds the sphere stands its poles upright and shows
   the live Earth: today's clouds and the real day/night line. Chat
   shows `[globe] Showing the live Earth from …` and the address it set.
4. Say `/8 help`.

If the sphere stays blank, auto-play is off for media in your viewer.
Open the Nearby Media list (the icon at the top right of the screen) and
press play beside the globe. The media is deliberately not clickable,
for anyone: a visitor who can click it can move it to another page, for
everyone near it.

The globe is on channel 8, not the probe's 7, so one command never
reaches both kinds of object.

### Commands

Said in local chat on channel 8, by the object's owner only. Every
command that changes the globe also says the address it set.

| Command | What it does |
|---|---|
| `/8 show <name or id>` | Asks the node about the dataset, then shows it playing from its start. A mistyped id, or anything that isn't an image or a video (a tour, say), is refused, and the globe is left as it was. |
| `/8 list` | The names `show` knows: `hurricanes`, `sst`, `smoke` (a data-encoded forecast clipped to one region), `quakes` and `lights` (a still image). Any id from the node's catalog works too. |
| `/8 earth` | Back to the live Earth. It also cancels a `show` still waiting on the node. |
| `/8 pause`, `/8 play` | Every visitor stops on, or starts from, the same frame. |
| `/8 jump <s or m:ss>` | Go to that point in the clip, paused or playing. Past the end, the page wraps round the clip. |
| `/8 rate <speed>` | From 0.084 to 12.8; 1 is the clip's own speed. Rounded to three decimal places, as the address carries it. |
| `/8 rotation <degrees>` | The longitude at the centre of the picture, in degrees east. Which way that faces in-world depends on how the sphere is turned. |
| `/8 spin <degrees a second>`, `/8 spin off` | Turns the whole sphere. Each viewer draws the spin for itself, so visitors don't all see the same side at once: leave it off when someone will point at a place. |
| `/8 debug on`, `/8 debug off` | TerraViz's diagnostic readout, drawn on the globe: the dataset's id (`data`), how far the video is from the shared clock (`sync`), the frame rate (`fps`), the graphics card (`gpu`) and the picture's size (`buf`). |
| `/8 width 1024`, `/8 width 2048` | The picture's resolution. It changes size at once, and the video's resolution follows at the next dataset. |
| `/8 telemetry on`, `/8 telemetry off` | Anonymous counts, below. Reloads every visitor's page once. |
| `/8 steer hash`, `/8 steer query` | Where changes go in the address, below. `query` is refused while telemetry is on. |
| `/8 status` | What it's showing, where the clip is, and the address. |
| `/8 upright` | Stands the poles upright again and stops any spin. |

### How it steers every visitor

The address has two halves. Before the `#` is only `fit=fill`, which
never changes and makes the picture fill the face, and `telemetry`,
which the page must have when it loads, since it counts its one minute
from then.
Everything a session changes sits after it: the dataset, the clock (`t`,
`at`, `rate`, `paused`), `width`, `rotation` and `debug`. A browser
applies a change after the `#` without reloading the page.

Whether every Second Life viewer passes a `#`-only change on without
reloading is still being tested (`SECOND_LIFE_COMPAT.md` §10 question 10).
The probe's `/7 hash`, below, answers it for your viewer. If yours
reloads anyway, `/8 steer query` puts every change before the `#`, which
always reloads, and is at least consistent.

**A reload doesn't lose the moment**, because the address says what it
is: a reloaded page lands back on the same frame, or the same point in
the clip. What gives a reload away is the wait. The globe shows the
plain live Earth for a few seconds while the dataset loads again, the
readout's `data` line reads `—` meanwhile, and `fps` starts counting
again.

The clock is a position and the moment it was current, so each copy
works out where the clip should be now from its own computer's clock.
Copies agree as closely as visitors' clocks do, and most are set from
internet time. The moment comes from the region's clock. If that is
off, every copy is off alike while the clip plays, and it shows only at
a pause, a resume or a change of rate: every copy jumps by the clock's
error times the rate, or times the change in rate. That is nothing to see at rate 1, and about a second for every
80 ms of error at 12.8.

### Smoke-testing the output page

A run through what the page does. Turn the readout on first, since most
of the checks read it.

1. **The live Earth.** `/8 debug on`. The readout should say
   `buf 2048×1024`. The day/night line should match the real one:
   the side of the Earth in daylight now should be lit.
2. **A video.** `/8 show hurricanes`. Within a few seconds it should
   play, with `sync` settling to within a few tens of milliseconds and
   `fps` near 30.
3. **Pause and play: does a change reload the page?** `/8 pause`, wait,
   then `/8 play`, watching the globe at each. Without a reload the
   video simply stops and starts. A reload shows the plain live Earth
   for a few seconds first, with `data` reading `—`, before the video
   comes back at the right moment. Note which, and check it with the
   probe's `/7 hash`.
4. **The same frame for everyone.** With a second avatar beside the
   globe, or a friend, `/8 pause`, and compare the two views. They should
   show exactly the same frame. Playing, they should be close.
5. **Jumps and speed.** `/8 jump 1:00`, `/8 rate 4`, `/8 rate 1`.
6. **An image, and a data-encoded forecast.** `/8 show lights` holds a
   still picture. `/8 show smoke` shows a coloured smoke forecast over
   the United States only, with the Earth beneath it everywhere else.
7. **Rotation.** `/8 rotation 90` puts the 90°E meridian, which runs
   down the Bay of Bengal, at the centre of the picture.
8. **Refusals.** `/8 show NOSUCHID` is refused by the node, and the
   tour `/8 show 01KQG656807DATQ88JYYSRGF8Y` by the script. The globe
   shouldn't change for either.
9. **A visitor's touch.** The second avatar right-clicks the globe and
   chooses **Touch**. They should get a chat line saying what it shows,
   with a link to it in the full app. A left-click only focuses the
   media.
10. **Back to the Earth.** `/8 earth`.
11. **Telemetry, optional, and only if step 3 found no reload.** Each
    reload reports again as a new visit, which the privacy policy asks a
    measured globe to avoid. `/8 telemetry on` reloads every page once,
    and the hover text and the object's description then say the globe
    counts anonymous use, as the policy also asks. Each page reports
    which dataset it showed and anything that failed, in its first
    minute only, anonymously. Then `/8 show hurricanes` within that
    minute. The rows appear in Grafana's product-health dashboard, in
    the Globes row, with `environment` set to `preview` for a preview
    node. Nothing has been sent from a real globe yet, so whether a
    viewer's request passes the node's origin check is part of what this
    finds out. `/8 telemetry off` when done.

When you report results, say which viewer and version (Help → About),
which graphics card and which operating system, what step 3 showed, and
what the readout showed for `sync`, `fps` and `gpu`.

### Things that will trip you up

- **The globe shows the live Earth whatever you ask.** The node has no
  web mode yet (check `NODE`), or the dataset wouldn't load: the page
  shows the live Earth rather than nothing, and tries again after 5 s,
  30 s, 2 minutes, then every 5 minutes. Every visitor's copy does the
  same.
- **Each change takes a second.** Second Life pauses a script for a
  second whenever it sets media, so commands in quick succession queue.
- **A left-click on the globe does nothing for the script.** A viewer
  hands a click on a face with media to the media, whatever the media's
  permissions. Right-click and Touch reaches it.
- **Spin off lines the viewers up again** by nudging the sphere's
  rotation and setting it back half a second later, since each viewer
  keeps the angle it had drawn. That is read from the viewer's source
  and hasn't been seen in-world.
- **A long title is cut to 100 characters** in the hover text and in a
  visitor's chat line, which both have a length limit. The telemetry
  notice comes before it, so a cut never loses the notice.
- **A reset puts the globe back on the live Earth**, stops any spin, and
  stands it upright again. Set `UPRIGHT_ON_START` to `FALSE` for a mesh
  globe with its own texture mapping, which keeps its own rotation.

## The probe

### Before you start

- A region where you can rez objects and run scripts. A sandbox is fine.
- Shared media switched on in your viewer, with auto-play allowed. In
  Firestorm: Preferences → Sound & Media.
- No L$. Nothing here uploads anything.
- If your viewer asks whether to allow media from an address ending
  `secondlife.io`, allow it: that's the script's own test page.

### Setting up

1. Rez a sphere. A default prim sphere is fine.
2. In the sphere's Content tab, make a **New Script**, replace its text
   with all of `terraviz-probe.lsl`, and save.
3. Optionally, make a second new script and paste `node-check.lsl` into
   it.

Within a few seconds chat shows `[probe] Starting…`, then
`[probe] Face 0 now shows …`, `[probe] Served the page …`, and `[page]`
lines from the test page itself. If no `[page]` lines come, click the
sphere to start its media. `node-check.lsl` reports `[node]` lines
straight away.

### Commands

Said in local chat on channel 7, by the object's owner only.

| Command | What it shows | What it answers |
|---|---|---|
| `/7 probe` | The test page and a labelled grid (the default) | Browser version, WebGL 1/2, the graphics card, video formats, a 10-second WebGL drawing test, HLS playback |
| `/7 image` | A real TerraViz dataset frame (Nighttime Lights) | Can TerraViz's still images go on a sphere? |
| `/7 video` | A real TerraViz video, if it can play | Can this page play TerraViz's streams? From a script-served page it usually can't — see the table below |
| `/7 app` | The actual TerraViz web app | Does the real app run in-world? |
| `/7 sos` | TerraViz's LED-sphere output page | A live, correctly wrapped Earth on a sphere |
| `/7 soak` | WebGL drawing continuously, reporting every 10 s | Does WebGL stay up? Watch for `Heartbeats stopped`, and for `context lost` rising above 0x |
| `/7 soak2d` | The same animation without WebGL | The comparison for `soak` |
| `/7 globe` | Stands the sphere's poles upright and rotates its texture 90° | Fixes a default sphere's sideways mapping (below) |
| `/7 turn`, `/7 mirror`, `/7 reset` | Rotate the texture a further 90°, flip it, or undo `globe` | For checking orientation against the grid |
| `/7 face N` | Moves the media to face N | Only needed on a box; a sphere has just face 0 |
| `/7 hash` | Changes only the part of the address after `#`, on whatever the face shows | Can a globe be steered live, for every visitor, without each viewer reloading? (The doc's §7, items 4 and 7.) Run it after `/7 video` to see whether a playing video survives it |
| `/7 api` | Asks the node again | Needs `node-check.lsl` in the prim |

Every command that shows a page loads it fresh, so repeating one reruns
it.

### A default sphere is sideways

A default prim sphere has its poles on its own X axis and wraps a texture
pole to pole, so a world map lands rotated 90°. `/7 globe` fixes it.
By hand, in the Build tool:

| Tab | Setting |
|---|---|
| Object | Rotation **X 0, Y 270, Z 0** |
| Texture | Rotation **90°**, repeats 1 and 1, offsets 0 |

Check it against the grid: north pole on top, the red **NW** square
upper-left when you face the yellow and cyan crossing, text reading left
to right. Why it's needed is in the doc's §5.

### The same test with an ordinary texture

To compare shared media with an ordinary texture on a second sphere,
make the grid as an image:

```
npx tsx scripts/second-life-probe --grid grid.png
```

The page's own code draws it, so its lines and colours match the probe
sphere exactly; only the label font may differ. On the second sphere,
apply the recipe above, then in the texture picker choose **Local**
rather than Upload, **Add** `grid.png`, and select it. Only you see a
local texture, and it costs nothing.

### Reading the results

| You see | It means |
|---|---|
| `[node] events: HTTP 200 … llJsonGetValue read 1 event(s)` | Second Life's servers reached TerraViz and LSL read its JSON |
| `[node] catalog: … cut off at 16384 bytes, so not parsed. Script memory in use: …` | The reply cap, and what holding a full reply costs a lean script |
| `[node] … HTTP 403` or `503`, or `Not JSON`, with a reply starting `<!DOCTYPE` | Bot protection turned the request away, or the node answered with a web page |
| `[probe] Served the page. Peak script memory while building it: …` | How close the probe itself comes to its 64 KB. Worth reporting |
| `[page] webgl frames: 600 in 10s, context lost 0x, readback ok` | WebGL works; about 600 frames is 60 fps |
| `[probe] No WebGL frame report within 45 seconds` | The page started, then stopped or was unloaded during the WebGL test. Worth checking whether the viewer's media process crashed: on Windows, Event Viewer → Application, an *Application Error* naming `SLPlugin.exe` |
| `[probe] The page never reported starting` | Usually media auto-play is off. Click the face |
| `[probe] The page started again without a command` | The viewer reloaded the page on its own. It has done this at a different size, which is worth noting |
| `[probe] Heartbeats stopped. Last one: soak webgl: …` | How long the soak lasted before the page went quiet — unless a `Heartbeats resumed` line follows, in which case it was a gap (a dropped report, region lag) and the soak is still being watched |
| `[probe] The soak sent no heartbeat within 25 seconds of starting` | It went quiet in its first seconds — the failure bug #5189 describes |
| `[page] soak webgl: no WebGL 2 context` | This viewer's browser has no WebGL 2, so the soak can't run. An answer in itself; TerraViz needs WebGL 2 |
| `[probe] Soak ended by a new command` | You switched away; nothing went wrong |
| `[probe] The page took the change without reloading, at most … ms after the script made it. The video kept playing.` followed by `[page] hash: #h=N, video t=…, playing, readyState 4` | **The answer the clock plan hopes for.** A change after `#` reached the page with no reload, and the video was still playing when it did. The time includes the report's trip back, so the page saw it sooner. Anything up to about 1,000 ms just means "within the second the script itself pauses after changing media" |
| The same, but `But the video wasn't playing normally`, with `paused` or a low `readyState` in the `[page]` line | No reload, but the change stalled the video. That still costs every visitor a pause, so it isn't the clean answer |
| `[probe] The viewer then reloaded the page anyway, … ms after the # change` | It took the change, then reloaded within the half minute. Count it as costing a reload |
| `[probe] The viewer reloaded the page to apply the change, … ms after the # change`, then `[page] mode: … #h=N` | The change arrived, but by reloading the page, so the video starts over. Steering a globe this way costs every viewer a reload |
| `[probe] The viewer reloaded the page … but the reload lost the # part` | It reloaded, and the change didn't arrive at all |
| No answer about the change within half a minute of `/7 hash` (other `[page]` lines may still arrive) | The viewer didn't pass the change on. After the half minute a report is no longer counted as an answer: the face's address still carries the `#`, so every later reload carries it too |
| `[page] TerraViz stream via hls.js: failed, networkError / manifestLoadError` | Expected. TerraViz's video host only lets pages from TerraViz's own site load its streams through hls.js, so the page falls back to a public test stream to check that video plays at all. (The page tries the browser's own HLS player first, which isn't held to that rule; Second Life's browser had none in October 2026, so that path didn't run) |

When you report results, say which viewer and version (Help → About),
which graphics card, and which operating system. Every result so far
comes from one machine.

### Things that will trip you up

- **Only you see the test page.** Second Life renders a script-served page
  as a web page only for the object's owner, in their own viewer, in the
  same region. `/7 app` and `/7 sos` come from TerraViz's site and have
  no such limit.
- **The Media Settings dialog can lose the size.** If a page shows black
  bands, or the poles go black, check Media Settings → Size. It should be
  2048 × 1024. 0 × 0 makes the viewer use a square page.
- **Shared media tops out at 2048 a side.** The dialog clamps a bigger
  number; a script asking for one gets a bounds error and no change.
- **The output page's address is `/output/output`.** `/output.html` is
  answered by the main app.
- **For `/7 hash`, your own viewer speaks for every viewer of its
  kind.** A script's change reaches every viewer the same way, yours
  included: as an update to the object. So the test page answers for
  everyone running the same viewer.
  - **To test a different viewer** (the official one, or the phone
    app), its user runs their own copy of the probe. The test page
    only renders for its owner.
  - **A second avatar watching `/7 app` or `/7 sos` can confirm a
    reload, nothing more.** Those pages can't report, and nothing on
    them changes visibly with the `#`. So a restart means "costs a
    reload", while no restart could mean the change arrived quietly or
    never arrived.
- **Don't click inside `/7 app` before `/7 hash`.** A click can move the
  app to another address. `/7 hash` reads the face's own address
  rather than the one it set, which copes, but there is no point
  testing a navigation you didn't mean.
- **`/7 hash` before the page has started tells you nothing.** If the
  page hasn't reported starting (media auto-play off, say), the script
  says so. Click the face and try again.

## Changing the kit

**The globe** is edited directly. `globe.test.ts` holds it to the output
page:
- every key the script writes, and every value it writes as written,
  must be one the page acts on;
- only `fit` and `telemetry` may go before the `#`, every key lands in
  one half, and something always follows the `#`;
- its rate limits must survive being written to three decimal places;
- it must accept exactly the dataset ids the page does, presets
  included;
- every media setting, the permissions included, goes with every call.

A key added to the script fails that test until it is added there too,
with a sample the page acts on. A change in what a value *means* isn't
caught there. The script also reads the dataset record's first fields
from a cut-off reply, and `functions/api/v1/_lib/dataset-serializer.test.ts`
holds the node's field order to that.

```
npx vitest run scripts/second-life-probe
```

**The probe**: edit `probe.html` or `probe.template.lsl`, never
`terraviz-probe.lsl`. Then:

```
npx tsx scripts/second-life-probe              # regenerate terraviz-probe.lsl
npx tsx scripts/second-life-probe --test-page  # run the page through every mode
```

The page is embedded in the script verbatim, so it can't contain a double
quote or a backslash; the generator refuses it if it does. Use
`String.fromCharCode(34)` and `String.fromCharCode(10)` for a quote or a
newline. The tests fail if the generated script falls out of step with
its sources, or if the page grows past what the script can safely build.

`--test-page` serves the page as the script would and drives it in
headless Chromium until each mode reports its last line, so it shows the
page itself is sound. It says nothing about Second Life's own browser.
Set `PLAYWRIGHT_CHROMIUM_PATH` to use a particular Chromium; the image and
video modes need the network.

LSL compiles only in-world, so to catch syntax errors first, run
[`lslint`](https://github.com/Makopo/lslint) over all three scripts. It
builds with `make` on Linux. On the globe it reports three conditions
that are always true or false, which are its constant settings, and
nothing else.

`NODE` at the top of each script names the TerraViz node. Point it at
your own to test a self-hosted node; video from it plays in the app only
if that node's video host allows its own site. The probe's `/7 video` is
served from Second Life's own address, which no video host allows. The
globe's page comes from the node itself, so it plays wherever the app
does.
