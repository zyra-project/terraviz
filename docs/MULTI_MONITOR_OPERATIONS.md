# Multi-monitor output — operator runbook

Status: first edition, written from two Windows hardware passes and
one Linux (WSL) sitting.
Last reviewed: 2026-09-19

This is the deployment half of
[`MULTI_MONITOR_PLAN.md`](MULTI_MONITOR_PLAN.md) — rung 15 of its
delivery ladder. The plan says how the feature is built; this says
how to stand one up and what to check before an audience is in the
room.

It is written for whoever provisions the machine driving a Science
On a Sphere installation, a dome or a projector array. It assumes
no knowledge of the codebase.

**The organising idea:** almost everything that has gone wrong on
real hardware was *invisible* — a correct-looking picture at a
fraction of the provisioned capacity, a control that renders as an
empty box, a monitor silently negotiating half its refresh rate.
None of it threw an error. So this document is mostly a list of
things to **look at** rather than things to do, and the order
matters: the checks in §1 will change what you conclude from
everything after them.

---

## 1. Before anything else: three hardware checks

Do these before adding a single output. Each one has silently cost
a hardware session.

### 1.1 Which GPU is actually rendering?

**This is the check that matters most, and the app cannot make it
for you.** A hybrid-graphics machine can put the webview on the
integrated GPU while a discrete card sits idle. The picture is
correct. Nothing is logged. The installation runs at a fraction of
what it was specified for.

The app's own `powerPreference` hint is inert — neither the
webview layer nor Tauri reads an override — so the only defence is
to look.

| Platform | How to check |
|---|---|
| Windows, macOS | Turn on the debug overlay (Outputs panel → Debug overlay) and read the **gpu** field on the output itself |
| **Linux** | `glxinfo -B \| grep -iE "renderer\|device"` — **the in-app field does not work here** |

That Linux exception is not a nicety. WebKitGTK sanitises the
WebGL renderer string, so the **gpu** field reads `Apple GPU` on
every Linux machine regardless of hardware. The one in-app
mitigation for this risk is blind on the platform SOS
installations most often run. Measured on a laptop with an RTX
4090: the HUD said `Apple GPU`, and `glxinfo` said
`D3D12 (Intel(R) UHD Graphics)`.

If it names the wrong adapter, the fix is per-OS and outside the
app:

- **Windows** — Settings → System → Display → Graphics, add the
  executable, set *High performance*. Vendor control panels
  (NVIDIA Control Panel → Manage 3D settings → Program Settings)
  do the same thing and one may stick where the other does not.
- **Linux, PRIME offload** — launch with
  `__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia`,
  or `DRI_PRIME=1` on a Mesa-only stack.
- **macOS** — generally automatic, with no user-facing override
  for a webview.

**Confirm the override took before drawing any conclusion from
it.** Re-run the check above with the same environment the app
will launch in. An override that silently did not apply looks
exactly like one that did.

### 1.2 What refresh rate is the output monitor running?

The output's render loop rides the compositor's frame clock, so
the display's refresh rate is a hard ceiling on its frame rate.
A 4K panel that negotiates 30 Hz caps that output at 30 fps and
leaves it **no headroom at all**.

This happens silently, and the usual cause is the cable path
rather than the panel: 4K over HDMI 1.4, or a shared DisplayPort
budget on a dock renegotiating modes when another monitor is
plugged in.

**Give each output monitor a direct cable from the discrete GPU.
Not a dock.** A dock also forces a cross-adapter copy every frame
— one machine rendered on a 4090 while an Intel iGPU scanned out,
with the copy sitting in a region no in-app measurement can see.

Check it in the OS display settings, and re-check after plugging
in the *last* monitor rather than the first.

### 1.3 Screen savers and display sleep

Installations run for hours with no input. Tauri has no
cross-platform wake-lock API, so this is not something the app can
prevent — **disable screen savers and display sleep in the OS
settings**, per monitor where the OS allows it. On Linux also
check the desktop environment's own idle settings, which are
frequently separate from the power settings.

---

## 2. Linux prerequisites

Two package sets. Neither is installed by default on Ubuntu, and
**both fail silently in ways that do not look like missing
packages.**

### 2.1 Media codecs — without these, no video plays at all

```bash
sudo apt install gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
                 gstreamer1.0-plugins-ugly gstreamer1.0-libav
```

WebKitGTK answers "can you play this?" through GStreamer. Without
the H.264 plugin sets, every HLS dataset — which is most of the
catalog — fails to load. The error the user sees names their
connection.

### 2.2 Fonts — without these, the controls are empty boxes

```bash
sudo apt install fonts-noto-core fonts-noto-color-emoji \
                 fonts-dejavu-core fonts-symbola
```

The app ships no font and no icon set; every control is a Unicode
symbol resolved from the system's fonts. On a minimal install the
entire transport bar renders as tofu — play, pause, step, browse,
all of it — with no error.

**The fourth package is the one people miss.** The icons split
into two classes with different requirements:

| Class | Needs |
|---|---|
| BMP symbols (play, step, gear, close) | DejaVu / Noto Sans Symbols 2 — ordinary font packages |
| Astral-plane emoji (chat, mute, delete, VR) | a **monochrome** emoji font |

Every icon is written with variation selector 15, which asks for
the *text* presentation. A colour emoji font supplies the colour
glyph, which the engine can decline for a VS15-marked codepoint
and fall through to tofu — so installing an emoji font is not the
same as fixing it. `fc-list :charset=1F4AC family` shows which
fonts on a box carry the chat glyph.

---

## 3. Setting up the outputs

Everything here is **Tools → Outputs** in the control window.

### 3.1 Adding an output

The picker lists every monitor with its name, pixel size and
position, marks which one is primary, and draws a to-scale diagram
of the arrangement. Check the diagram against the desk before
clicking Add — an output opens fullscreen, and you get one chance
to notice it is about to land on the wrong display.

A monitor already carrying an output is marked as such and cannot
take a second one. Two fullscreen windows on one monitor means one
is invisible with no way to tell which.

**"Nothing marked primary" is a valid reading on X11**, which can
leave no display flagged at all. The panel reports what the
platform says rather than guessing.

### 3.2 Framebuffer is not monitor resolution

The panel shows two numbers and they are different things:

- the **monitor's** own pixel count, on the option line
- the **framebuffer**, chosen separately below it

The framebuffer is the equirectangular image the output renders —
the thing the sphere consumes. It is scaled to the window. The
whole ladder is offered rather than just the rungs that fit the
monitor, because the two most useful cases are at the extremes:
1024 to preview a sphere on a desk monitor, and 8192 to drive a
sphere from a 1080p preview screen.

Start at 4096×2048. Go higher only if the sphere's own resolution
justifies it, and re-read §4 afterwards.

### 3.3 Measuring this machine's decoder budget

The panel shows *N of M video decoders in use* and disables Add
when the budget is spent. `M` defaults to a guess derived from the
machine; **the guess is not a measurement, and the field exists so
you can replace it with one.**

To measure it:

1. Load a video dataset on the control window.
2. Turn on the debug overlay for each output.
3. Add outputs one at a time, watching **fps** on every output
   already running.
4. When an existing output's fps drops as a new one appears, you
   have passed the machine's real budget.
5. Set the budget field to one *below* the count where degradation
   started, and relaunch.

The count is *windows that can hold a decoder* — every control
panel plus every output — not decoders currently decoding. That is
deliberate: an output goes from free to costing a decoder the
instant a video loads, and a dataset load is not a moment where a
refusal can be shown. Counting windows puts the refusal on Add,
where there is a control to disable.

### 3.4 Calibration

Two controls, used together and in this order:

1. **Calibration pattern** — replaces the dataset with a graticule
   carrying pole letters, named anchors, a longitude scale and a
   live resolution readout. It travels the same path a dataset's
   pixels travel, so a pattern that lands correctly proves a
   dataset will.
2. **Rotation offset** — turns the projection to match how the
   sphere is physically mounted. Drag the slider while watching
   the sphere; type a number to reproduce a known value.

Calibration is done **one sphere at a time** — a four-output rig
is four differently-mounted spheres, and the pattern appears only
on the output you toggled.

The southern colour bars are deliberately reversed: two identical
bands would be invariant under a vertical flip, which is the
orientation error this pattern most needs to expose. The
antimeridian is marked at both edges in its own colour, so a seam
artefact and a mis-set rotation cannot look alike.

**The rotation persists; the pattern does not.** The rotation is a
property of the room and comes back next launch. The test pattern
is a property of the afternoon, and an installation that restored
with it on would show no data at all.

### 3.5 Restore on launch

Off by default, and deliberately: an operator who added an output
once, on a laptop later taken home, should not have a window try
to open on a projector that is not there.

Turn it on for a fixed installation. The set comes back next
launch, matched on monitor name **and** signed physical origin —
a name-only match can restore onto a physically different monitor
while looking like it worked. A monitor that no longer matches is
skipped and logged rather than guessed at.

---

## 4. Reading the debug HUD

Turn it on per output: Outputs panel → Debug overlay. It is drawn
on the sphere, so it cannot be silently left on.

```
data   01KQG62XVNKZ112H3AR0K56SX9
sync   +69 ms
link   live
fps    29.0  (raf 60.0)
draw   0.4 ms
buf    4096×2048
gpu    ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 …)
```

| Field | What it means | Healthy |
|---|---|---|
| **data** | what is *on the glass*, not what was requested | the dataset you loaded |
| **sync** | playhead drift from the control window, signed | within ±150 ms; a dash with a reason beside it is often correct — `not-ready` on a still image is the right answer |
| **link** | contact with the control window | `live` |
| **fps (raf)** | frames drawn, against callbacks the browser offered | see below |
| **draw** | mean time inside one render call | see below |
| **buf** | the framebuffer, deliberately not the window | the rung you picked |
| **gpu** | render adapter, plus context state if not healthy | a discrete card — **and not readable on Linux**, see §1.1 |

**Read fps and raf as a pair.** Neither means much alone:

- `1.0 (raf 60.0)` on an idle globe is **correct** — a static
  output is floored at 1 Hz deliberately, so that an output which
  never redraws can still be told apart from a correct frame.
- `29.0 (raf 60.0)` with video is correct — the loop caps at 30.
- `22 (raf 30.0)` is a display running at 30 Hz. See §1.2.
- `19 (raf 60.0)` is the loop declining callbacks it is being
  offered — that is a fault in the app, not your installation.

**`draw` reads differently per platform**, which is worth knowing
before you conclude anything from it. On Windows the render call
submits work and returns, so it reads under a millisecond even
when the GPU is saturated. On Linux the path is synchronous and
the same field reads the real cost — 302 ms was measured on an
iGPU under a translation layer. A sub-millisecond `draw` is not
proof of headroom unless you know which platform you are on.

---

## 5. Health badges in the Outputs panel

A healthy output shows **no badge at all**. That is deliberate — a
row of green chips trains an operator to stop reading the row that
matters.

| Badge | Meaning | What the audience sees |
|---|---|---|
| *(none)* | live | correct, current picture |
| **Starting** | spawned, not yet announced itself | usually momentary |
| **Stale** (amber) | the control window has gone quiet | **a picture, but not a current one** — the sphere looks fine |
| **Display lost** (red) | the output lost its graphics context | nothing — a black sphere |

The distinction between amber and red is the whole value of the
badge, and it is the question you cannot answer by looking at the
sphere: a stale output is still showing something plausible.

Transitions are announced to screen readers as well as shown. A
row *disappearing* is deliberately not announced — that covers a
crash and your own Remove equally, and saying "gone" for a removal
you just asked for is noise.

---

## 6. Unattended launch

For an installation that should come up on boot with no keyboard:

```bash
terraviz --kiosk
```

or set `TERRAVIZ_KIOSK=1` in the environment. Two mechanisms
because they suit different launchers — a `.desktop` autostart
entry or a systemd unit sets a variable naturally, a wrapper
script passes a flag.

`TERRAVIZ_KIOSK=0` and an empty value both mean **off**, so a
deployment templating one unit file across several machines can
disable kiosk explicitly rather than by omission.

Kiosk mode is fullscreen and decorationless: no close button, no
title bar, no menu bar. Exits:

- **Ctrl+Q** (Windows/Linux) or **Cmd+Q** (macOS, via the standard
  application menu)
- **F11** on any window toggles fullscreen and brings the title
  bar back — the escape hatch during calibration
- SIGTERM from the installation's process supervisor

> **Not yet exercised end to end.** `--kiosk` compiles and its
> argument parsing is unit-tested, but its calls into the window
> API have never run on hardware. Try it before an installation
> depends on it.

---

## 7. What this document does not cover

- **Linux qualification.** The feature has run on a second monitor
  on Windows. A dual-monitor Linux workstation pass has not
  happened, and WSL is not a substitute — see `MULTI_MONITOR_PLAN.md`
  Appendix B for three configurations and why none of them
  qualifies anything.
- **Soak behaviour.** Every reading so far is from a single
  sitting. Nobody has watched an installation play for an hour.
- **Recovering a crashed output automatically.** The manager
  notices, badges it and keeps it in the restore config — it does
  not respawn it. Three crashes on one monitor stop new outputs
  going there for the session; relaunching clears that.

---

## See also

- [`MULTI_MONITOR_PLAN.md`](MULTI_MONITOR_PLAN.md) — the design,
  the delivery ladder, and Appendix B's hardware results log
- [`SELF_HOSTING.md`](SELF_HOSTING.md) — standing up a node, if
  this installation serves its own catalog
