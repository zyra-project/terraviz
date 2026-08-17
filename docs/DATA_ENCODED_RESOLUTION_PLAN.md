# Higher-resolution data-encoded video: the 8192×4096 rung

**Status: Phase 0 and Phase 0b closed. Phase 2 superseded.** Seven
browser/platform pairs have run the 8192×4096 rung in both codecs.
Nothing in Phases 1–3 is built. The Phase 0 *instrument* is built;
`public/luma-check/` carries the static bundle through `H_ceiling_8k`,
but **not `I_ceiling_8k_hevc`** — every HEVC row was collected against
`--serve`, which builds its manifest live. One `--emit-static` run on a
machine with libx265 stages the HEVC variant for later re-runs; until
then the deployed copy offers the H.264 rung only.

**HEVC decodes the rung everywhere tested: seven of seven, no
refusals.** Windows Chrome, Windows Firefox, macOS Chrome, macOS
Safari, macOS Firefox, iOS Safari and a Quest 3 all decode
`I_ceiling_8k_hevc` at true native resolution, hand it to WebGL intact,
and round-trip values identically on the path the app uses — 220/256
exact, MAE 0.141, max |e| 1, across x86, Apple silicon and mobile ARM.

**In H.264, only iOS Safari refuses**, and that is the sole negative
result in this document that has ever reproduced. The other two —
Windows Firefox stalling, macOS Chrome refusing — each came from a
single run and each was contradicted three days later, macOS Chrome on
the very same M2 Ultra. **Accepts have held on every re-test; refusals
have not.** A one-run refusal against a self-updating browser is the
weakest row a matrix can carry, and this plan leaned on two of them.

**So Phase 2 is superseded rather than merely unnecessary.** It existed
to serve a population that could not decode the rung, and iOS Safari
was that population. HEVC clears iOS at the full frame size, so there
is no capability fallback left to build. Phase 1 is the whole of the
remaining work, and it should target an **HEVC** rung rather than the
H.264 one it was written for. §HEVC over HLS is not a codec swap is the
scoping that follows from that, and it is where the real cost now sits.

**One hard ceiling did emerge, and it is not about decoding.**
`MAX_TEXTURE_SIZE` is exactly 8192 on both the Quest and macOS Firefox
— two independent device families sitting at precisely the frame width.
Both upload fine at 8192×4096. But a rung any wider loses both, and no
decode capability recovers a texture that will not allocate. **8192 is
the top of this road**, not a waypoint on it.

**Three generalisations in this document were falsified by the next
device to report** — including one written a single commit before the
row that killed it. The per-row records stand; the rules drawn from
them did not. Record the (platform, browser) pair, date it, and wait
for the matrix.

**Playback is now measured on a 7200×3600 stand-in, and it passes on
the device that mattered most.** The clip is 25.9 MP against the rung's
33.6 MP — **23% fewer pixels** — so read the margins, not just the
verdicts: upload cost scales with pixel count, which would put the
Quest's 4.69 ms mean nearer 6.1 ms at the full rung. Still inside the
11.1 ms budget, but with less room than the number below suggests, and
the full rung's sustained cost is an open check rather than a measured
one. The Quest 3 holds 0.994× of real time with zero dropped frames
and a 4.69 ms mean texture upload against its 11.1 ms budget at 90 Hz —
better than either desktop, because a software-decoded frame is already
in memory its unified-memory GPU can address, while a discrete card has
to pull it across PCIe first. Desktop Chrome also keeps up, with an
occasional p95 hitch at 60 Hz.

Nothing now blocks the rung on capability. Mid-range Android is the
only unmeasured row, and the remaining work is delivery — see §HEVC
over HLS is not a codec swap — rather than decode.

**Last reviewed: 2026-08-16.**
**Revisit when:** mid-range Android reports; an AV1 rung is measured;
`DATA_ENCODED_RENDITIONS` changes; the full 8192×4096 rung is *played*
rather than the 7200×3600 stand-in; or any device reports a
`MAX_TEXTURE_SIZE` below 8192, which would put the rung itself back in
question.

This is the implementation plan for the route
[`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md) §Why the
frame is 4096×2048 ranks second — one larger single stream. That
section explains *why* the other three routes lose; this one says what
building this one would take.

---

## Context: what has actually been measured

An 8192×4096 test encode was run through the repo's exact data-encoded
settings — `libx264`, `-profile:v main`, `-pix_fmt yuv420p`, no colour
range or colourspace tags, `-preset slow`, `-crf 18`, and
`scale=…:flags=neighbor` — against a 4096×2048 control, on synthetic
frames carrying all 256 luma codes plus a band of random noise as a
storm-edge analogue.

Three things came out of it, one of them the opposite of what the
scoping section assumed.

**1. The frame size is not the problem.** x264 accepts 8192×4096 at
Main profile and stamps **level 6.0** — not 6.2. Levels 6.0, 6.1 and
6.2 share one 139,264-macroblock frame ceiling and differ only in
bitrate; 8192×4096 is 131,072 macroblocks, so it clears the *lowest* of
the three. The scoping section's "fits level 6.2, barely" understates
the compatibility position, since 6.0 is the better-supported tier.

**2. The bitrate cap is the problem, and it fails silently.**
`DATA_ENCODED_RENDITIONS` carries `maxBitrateKbps: 25_000` alongside
`height: 2048`. Quadrupling the pixels against an unchanged cap
quarters the bits per pixel, and the value round trip degrades in the
tail:

| encode | p50 | p99 | p99.9 | max\|e\| | fraction >5 |
|---|---|---|---|---|---|
| 4096×2048 @ 25 Mbps — control | 0 | 1 | 2 | 13 | 0.006% |
| 8192×4096 @ 25 Mbps | 0 | 1 | **7** | **152** | **0.117%** |
| 8192×4096 @ 100 Mbps | 0 | 1 | 2 | 18 | 0.012% |

At matched bits-per-pixel the 8K encode is indistinguishable from the
shipped rung. At the shipped cap it is not: the p99.9 error more than
triples and the fraction of badly-wrong texels goes up twentyfold.

The distribution matters more than the summary. Median and p99 are
identical across all three — the damage is entirely in the tail, and it
**clusters in high-spatial-frequency regions**. For a reflectivity
field that is precisely the convective cores, so bitrate starvation
corrupts the most interesting data first while leaving the calm
majority untouched. A spot check of open ocean would show nothing
wrong.

**3. The transport lattice is resolution-independent.** All three
encodes recovered **220 of 256** distinct codes, consistent with the
~219 the Encoder section documents. Going bigger neither helps nor
hurts value precision, exactly as the scoping section predicted.

### What has *not* been measured

**~~Whether anything decodes it.~~ Answered — see §Phase 0.** This was
the gating unknown when the section was written; the matrix now records
three native decodes, two refusals and one stall. What remains
unmeasured is narrower and listed there: mid-range Android, a Firefox
re-run, HEVC/AV1 as an alternative to H.264, and the full 8192×4096
rung under playback rather than the 7200×3600 clip that stood in for
it.

Two lesser gaps. The test clip was 10 frames, so VBV never reached
steady state and the reported bitrates (40.5 / 69.7 / 160.8 Mbps) are
I-frame-dominated rather than representative. And the noise band is far
harsher than real model output: the 4K control's max\|e\| of 13 does
not match the max\|e\| 1 that `ffmpeg-hls.ts` records for the shipped
path, which means these absolute numbers are **not** comparable to that
figure. Only the 4K↔8K comparison under identical conditions is valid,
and that comparison is what the table above reports.

---

## Non-goals

- **Tiling, frame sequences, and bandwidth-adaptive ladders.** Ruled
  out with reasons in the scoping section. This plan is the single
  larger stream only.
- **More than ~8 effective bits per texel.** Orthogonal, and answered
  by §Why the chroma planes aren't spare precision.
- **Anything past ~35 MP.** 8192×4096 is the last frame size H.264
  admits. Beyond it the answer is a tiled pyramid with zoom-dependent
  LOD, which is a different renderer and its own plan.
- **Making 8K the default.** Every phase here is opt-in per dataset.
  9.78 km remains correct for the overwhelming majority of the catalog.

---

## Phase 0 — does anything decode it? (gating)

Nothing else in this plan is worth building until this returns. It is
also the cheapest phase, which is why it is first.

Produce one 8192×4096 data-encoded HLS bundle by hand, host it, and
open it on the device matrix. For each device record: does it play;
does `readyState` reach 2; does a `texImage2D` from the video element
succeed; and does a known texel read back the value it should.

The last one is the real test. A device that plays the video but
silently downscales it before the WebGL upload would look fine and
report wrong numbers — the same failure shape as the classified-palette
bug, and worth checking for explicitly rather than trusting playback.

Minimum matrix: desktop Chrome, Firefox, Safari; iOS Safari; one
mid-range Android; Quest browser. `docs/DATA_ENCODED_VIDEO_PLAN.md`
§Encoder already notes Safari and iOS Safari were unverified for the
colour-range decision, so this probe should close that gap at both
resolutions while it is set up.

### The probe

Built, as the `H_ceiling_8k` variant of `scripts/luma-range-check`. It
is the same encoder settings as the shipped data-encoded path, at
8192×4096 — deliberately not a new encoder question — so what it
measures is the device rather than the argv.

```bash
npx tsx scripts/luma-range-check --emit-static   # regenerate + stage
npx tsx scripts/luma-range-check --serve         # LAN URL for a device
```

`--emit-static` writes the bundle into `public/luma-check/`, so every
preview deploy serves it and testing a headset or a phone is a URL
rather than a network setup. The 8K encode adds **78 KiB** — flat bands
compress to almost nothing, so hosting it costs effectively nothing.
"Copy results" puts the whole record on the clipboard, because nobody
is transcribing a table by hand inside a Quest.

Two measurements were added beyond the four this section asks for.

**`MAX_TEXTURE_SIZE`.** A context whose limit is 4096 cannot hold an
8192-wide frame at all, so it settles the question for that device
before any decoding happens. This is a real mobile ceiling, not a
theoretical one — and the check's own CI renderer (SwiftShader) reports
exactly 8192, meaning the proposed rung sits *at* the limit with no
headroom rather than comfortably inside it.

**An isolated-spike region, and it is the one that matters.** The ramp
bands are 32 texels wide at this size, so they survive a silent 2×
downscale completely intact — a device that quietly halved the frame
would pass a ramp-only check while serving averaged values, which is
precisely the failure this section warns about and the same shape as
the classified-palette bug. The lower half of the frame therefore
carries single-texel spikes on a flat background. Measured through the
encoder: they read **252** at native resolution and **63** through a 2×
box downscale, so the `native` column separates the two cases by a
factor of four rather than by a judgement call.

### The matrix

Fill this in as devices report. A failure is a result, not a bug — only
`D_full_proper` sets the check's exit code, so a red row here does not
break CI.

| device / browser | decodes | readyState | decoded size | MAX_TEXTURE_SIZE | texImage2D | native | notes |
|---|---|---|---|---|---|---|---|
| desktop Chrome 150 (Win 11, Intel UHD 770, ANGLE/D3D11) | **yes** | 4 | 8192×4096 | 16384 | ok | **yes** — spike 252.0 | Values round-trip at 8K exactly as at 4K. Decode path unconfirmed; see below. **Also accepts the 8K HEVC variant, spike 253** — see §The 8K HEVC variant has a positive control |
| desktop Chrome 151 (macOS, M2 Ultra, ANGLE Metal) | ~~no~~ → **yes** | 4 | 8192×4096 | 16384 | ok | **yes** — spike 252 | `MediaError` 4 with no software fallback on 2026-08-13; **the same machine** decoded it and passed every path on 2026-08-16. Refusal retired — the browser changed, not the hardware. **Also accepts the 8K HEVC variant, spike 253** — see §macOS Chrome accepts both |
| desktop Firefox (Win 11) | **yes** | 4 | 8192×4096 | 16384 | ok | **yes** — spike 251.0 | Stalled 2026-08-13, did **not** reproduce 2026-08-16 — all paths pass. Cause never attributed; see below. **Also accepts the 8K HEVC variant, spike 253**, with a codec-specific 2D-canvas defect — see §Firefox takes both codecs |
| desktop Firefox (macOS) | **yes** | 4 | 8192×4096 | **8192** | ok | **yes** — spike 251 | Passes every path on **both** codecs, so the Windows HEVC 2D defect is platform-specific. Texture limit equals the frame width, as on the Quest — see §macOS Firefox, which narrows two claims |
| desktop Safari 26.5.2 (macOS, Apple GPU) | **yes** | 4 | 8192×4096 | 16384 | ok | **yes** — spike 252.0 | Decodes what Chrome on the same OS refuses. Decode path unconfirmed. **Also accepts the 8K HEVC variant, spike 253**, and fails the 2D readout identically on *both* codecs — see §Safari's 2D defect is the engine, not the codec |
| iOS Safari 26.6 (iOS 18.7, Apple GPU) | **no** — H.264; **yes** — HEVC | 4 (HEVC) | 8192×4096 (HEVC) | 16384 | ok (HEVC) | **yes** — spike 253 (HEVC) | H.264 gives `MediaError` code 4 at `loadeddata`, refused before playback, re-confirmed 2026-08-16. **The same device decodes the same frame size in HEVC** — see §iOS Safari accepts the full rung in HEVC |
| mid-range Android | | | | | | | |
| Quest 3 (OculusBrowser 149, Adreno 740) | **yes** | 4 | 8192×4096 | **8192** | ok | **yes** — spike 251.0 | Texture limit *equals* the frame width: fits with zero headroom, confirmed uploading in both codecs. **Also accepts the 8K HEVC variant, spike 253** — see §The Quest allocates a texture at exactly its own limit |

**Row 1 — iOS Safari, 2026-08-13.** The rung is refused outright:
`MEDIA_ERR_SRC_NOT_SUPPORTED` fires on load, so `readyState`, decoded
size, `texImage2D` and `native` never get a value. There is nothing
ambiguous to interpret and nothing that could be a downscale in
disguise — the frame never arrives.

Three things this row settles, and one it does not.

**It is not the GL side.** `MAX_TEXTURE_SIZE` is 16384 on this device,
double what the rung needs — the headroom §The probe worried about
(SwiftShader reporting exactly 8192) is comfortable here. Had the video
decoded, WebGL would have held it. The ceiling is the video decoder,
which is the one layer no amount of our own code routes around.

**It is not a bad encode.** The same file's siblings play on this
device, and §Context already establishes 8192×4096 is 131,072
macroblocks against H.264's 139,264 ceiling — legal at level 6.0. The
most likely reading is that Apple's H.264 decoder implements up to
level 5.2 (4096×2304, ≈9.4 MP) and this frame is ≈33.6 MP, about 3.6×
beyond it. That is inference from a well-known platform limit, not
something this probe measured: `MediaError` 4 does not name a reason,
and the probe cannot distinguish an unimplemented level from any other
refusal. It does not change what to build either way.

**It pushes the decision gate toward Phase 2.** The gate says Phase 1
alone if the matrix is broadly green, Phase 1 + Phase 2 if a
population that matters cannot decode it. iOS Safari is named
explicitly in the minimum matrix and is not a population this project
can serve a broken globe to. One row is not the matrix, and the
remaining five could still change the shape of the answer — but they
can only make it worse for Phase-1-alone, since no other device
decoding it would make iOS decode it.

**What it does not settle: whether a smaller rung would clear.** This
probe tests one size. The gap between 4096×2048 (shipped, ≈8.4 MP) and
8192×4096 (≈33.6 MP) is a factor of four, and Apple's ≈9.4 MP limit
sits inside it — close to the shipped size, not the proposed one. The
largest **2:1** frame clearing level 5.2 is 4320×2160 (36,450
macroblocks against the level's 36,864), which is 5% more linear
resolution than ships today. A middle rung is therefore not worth
building: the whole usable headroom below Apple's ceiling is a rounding
error on the frame we already publish. Recording it here so the option
is rejected on its size rather than quietly forgotten and re-derived.

**Row 2 — desktop Chrome, 2026-08-13.** The rung decodes, and it
decodes *properly*. `readyState` 4, decoded size 8192×4096, a clean
`texImage2D`, and — the measurement this section was built around — a
spike mean of **252.0** against the 200 threshold, so the frame is
genuinely native and not a silently halved one wearing the right
dimensions. Values round-trip at 8K exactly as they do at 4K (220/256
exact, gain 1.0005, max|e| 1), which is the useful confirmation that
quadrupling the frame costs nothing in fidelity.

**But the decode path is unconfirmed, and this is the row the
software-decode caveat was written for.** Intel's Quick Sync H.264
decoder does not reach 8192 wide — its ceiling is 4096 — so a UHD 770
almost certainly did not decode this in hardware, which leaves
Chrome's ffmpeg software fallback. That is consistent with everything
observed and is still inference: the probe reads one frame after a
seek and never asks how fast frames arrive, so a decode that took a
second per frame looks identical here to one that took a millisecond.

Confirming it is cheap and should happen before this row is treated as
green. Open `chrome://media-internals` while the check runs and read
the decoder name: `D3D11VideoDecoder` or `MojoVideoDecoder` means
hardware, `FFmpegVideoDecoder` means software. Then watch the 8K clip
play and see whether it holds a watchable rate. If it is software at a
few frames per second, this row does not unblock Phase 1 for desktop
either, and the honest reading of Phase 0 becomes "nothing in the
matrix can play this," not "desktop can."

**Row 3 — desktop Firefox, inconclusive, and the probe's fault.**
Firefox on Windows 11 ran the check and never returned anything at
all. That is a third distinct behaviour: iOS Safari declines cleanly
with a `MediaError`, desktop Chrome accepts, and Firefox neither
fires `loadeddata` nor `error` — it simply stops.

The probe made this worse than it needed to be, in two ways now fixed.
Its waits on `loadeddata` and `seeked` were unbounded, so an element
that fires no event either way hangs the run indefinitely; and the
table rendered only after every variant completed, so the stalled
variant discarded the results of the seven that had already passed.
The observation therefore cannot say *which* variant stalled, which is
the one thing worth knowing. Both waits are now capped at 30 s, a
timeout is recorded as its own outcome distinct from a load failure,
and results repaint after each variant with the variant in flight
named on screen.

Re-running Firefox against the updated page should attribute the stall
and fill this row. The likely answer is that it stalls on
`H_ceiling_8k` and the 4096×256 variants were all fine — but that is a
guess, and the row stays inconclusive until the re-run says so. Worth
recording either way: a decoder that stalls rather than declines is
harder for the Phase 2 fallback to detect than one that errors,
because there is no event to trigger on. If Firefox turns out to
behave this way on the 8K rung, Phase 2 needs a timeout of its own
rather than an `error` handler.

**The re-run happened on 2026-08-16, and that guess was wrong.**
`H_ceiling_8k` is exactly what Firefox handles cleanest: it decodes at
native 8192×4096, uploads, and passes all three value paths at 220/256
with MAE 0.141 — the same numbers every other accepting device
reports. The stall did not reproduce at all, on either variant.

**The cause is unattributed and now probably unattributable.** Three
things changed between the runs: the probe's waits were bounded, its
table began repainting per variant, and three days passed on a browser
that updates itself. The stall is also consistent with a backgrounded
tab against the *unbounded* waits of the original harness, since
Firefox throttles background tabs hard and a media element that never
fires an event would then hang forever — but nothing in the record
distinguishes that from a transient or from a since-fixed Firefox bug.
Recording it as resolved-cause-unknown, because a stall that cannot be
reproduced should not keep a row open, and inventing an explanation for
it would be worse than admitting there isn't one.

**What survives from this row is the design note, and it still
applies.** A decoder that stalls rather than declines is harder for a
Phase 2 fallback to detect than one that errors, because there is no
event to trigger on. That was true when written and remains true; it
simply no longer has a device demonstrating it.

**Row 4 — macOS Chrome.** Chrome 151 on an M2 Ultra refuses the rung
with the same `MediaError` 4 as iOS Safari, and does not attempt a
software fallback despite considerably more CPU headroom than the
Windows box had.

This row was first written up here as settling the
browser-versus-platform question: Blink and WebKit refusing alike on
Apple hardware while the same engine accepted on Windows, therefore
the platform decides. **Row 5 inverts that.** Safari on the same OS
decodes the frame, so the refusal belongs to Chrome-on-macOS
specifically rather than to macOS, and neither half of the pair
generalises on its own.

The 4096×256 variants all pass here, but not in the way any other
device passes them; see
[`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md) §Encoder,
where this row alone costs the full-range recommendation its
universality.

**Re-run 2026-08-16: the refusal did not reproduce.** macOS Chrome
decoded `H_ceiling_8k` at native 8192×4096, `readyState` 4, clean
`texImage2D`, spike 252 — and passed every value path including the 2D
readout. See §macOS Chrome accepts both, and the H.264 refusal did not
reproduce. **Confirmed same machine**, the same M2 Ultra, three days
apart. So this is not a configuration difference between two Macs: the
browser changed underneath the measurement. The refusal is retired
rather than narrowed, and the row above stands only as a record of what
Chrome did on 2026-08-13.

**Row 5 — macOS Safari, which breaks the pattern.** Safari 26.5.2
decodes the rung: `readyState` 4, decoded size 8192×4096, clean
`texImage2D`, and a spike mean of **252.0** against the 200 threshold,
so the frame is genuinely native rather than quietly resampled. Values
round-trip at 8K exactly as at 4K (220/256, gain 1.0005).

Two conclusions recorded earlier in this section die here, and it is
worth naming them rather than editing them away:

- *"Every Apple platform refuses the rung, on both engines."* False.
  macOS Safari is an Apple platform and it accepts.
- *"The browser is not the variable; the platform's decoder is."*
  Inverted. On one macOS machine Safari accepts and Chrome refuses,
  which is the browser being exactly the variable.

What survives is narrower and less quotable: **the (platform, browser)
pair decides, and neither half predicts the answer alone.** iOS Safari
refuses what macOS Safari accepts, so WebKit does not carry the
capability with it. macOS Chrome refuses what macOS Safari accepts, so
neither does the OS. Both generalisations were written after a single
new device and both lasted exactly one more device; the matrix is the
artifact, not the rule someone extracts from it half-full.

**The framerate question applies here too.** Apple's hardware H.264
block does not reach 8192 wide either, so this accept is most likely
VideoToolbox software decode — plausible on an M2 Ultra and evidence
of nothing at all about a MacBook Air or an older Mac. One frame after
a seek is not playback. This row needs the same watch-it-actually-play
check row 2 does before it counts as a capability rather than a
curiosity.

**Row 6 — Quest 3, the accept that changes the reading.** The rung
decodes: `readyState` 4, 8192×4096, clean `texImage2D`, spike mean
**251.0**, native. The two desktop accepts could both be explained away
as workstations brute-forcing a software decode. An Adreno 740 in a
headset cannot be explained that way, and it is the first evidence
that the rung is decodable rather than merely survivable on hardware
with room to spare.

**`MAX_TEXTURE_SIZE` is 8192 — exactly the frame width.** §The probe
flagged this as a worry when CI's SwiftShader reported 8192; it is now
confirmed on the real device class most likely to want the rung. The
frame fits with **zero headroom**: a single texel wider and this device
could not hold it at all, no matter what the decoder managed. Two
consequences worth writing down. Nothing above 8192 wide is available
on this hardware, so the ladder in Phase 3 has a hard ceiling here
rather than a soft one. And the margin between "works" and "cannot be
uploaded" is one texel, so the 8192×4096 geometry is not a starting
point to be nudged later — it is the terminal rung for this device
class.

**And this is where the framerate question is sharpest.** A headset
must hold 72–90 Hz or it is unusable in a way a stuttering desktop
video is not, and this is simultaneously the device where the rung's
angular resolution would matter most. A decode that lands one frame
after a seek says nothing about that. Play the 8K clip in the headset
and watch it before this row counts as a capability.

### Does it play? — measured, and the GPU barely matters

**Windows Chrome 150, 7200×3600 at 25 Mbps, 2026-08-16.** The same clip,
same machine, on both of its GPUs:

| device | mean | implied | p95 | max |
|---|---|---|---|---|
| Intel UHD 770 (integrated) | 11.47 ms | 9.0 GB/s | 30.20 ms | 40.40 ms |
| RTX 4090 Laptop (discrete) | **9.89 ms** | 10.5 GB/s | 19.60 ms | 37.40 ms |

**A 4090 is 1.16× faster than an integrated Intel part at this, and it
has on the order of fifty times the memory bandwidth.** That single
comparison is worth more than either number on its own: whatever
`texImage2D` is spending its time on here, it is not GPU memory
bandwidth, or the discrete card would have walked away with it.

The likely explanation is that the frame never gets near the GPU until
the very last step. **H.264 hardware decode is capped at 4096×4096 on
essentially all consumer silicon** — Intel Quick Sync, NVIDIA NVDEC and
Apple VideoToolbox alike; the 8K decode those parts advertise is for
HEVC and AV1, not H.264. A 7200-wide H.264 stream is therefore
software-decoded on the CPU *whichever* GPU is active, lands in system
memory, and the per-frame cost is the CPU-side colour conversion and
copy — which scales with pixel count and is indifferent to the card it
is eventually handed to. 10 GB/s is an entirely ordinary figure for
that path.

**This reframes Phase 1: the lever is the codec, not the resolution.**
The plan has assumed H.264 throughout because that is what the shipped
ladder emits. But an HEVC or AV1 rung could get *hardware* decode at
8K where H.264 structurally cannot, keeping the frame in GPU memory and
turning the upload into a GPU-side copy rather than a bus transfer.
That is a different and much more promising question than "can we make
the H.264 frame bigger", and it should be answered before Phase 1 is
built. It is inference from a well-known hardware limit plus this
measurement, not something the probe verified directly.

**Playback itself is fine, and consistently so.** All three runs held
0.973–0.975× of real time at the app's own 1.88 fps. Decode is not the
constraint at the rate a data-encoded dataset actually plays.

**The dropped-frame count is a startup artifact, not sustained loss.**
Every run reported exactly **5 of 31**, unchanged across two different
GPUs and three runs. A figure that identical is deterministic — the
first frames as playback starts — rather than 16% of timesteps being
lost throughout. Worth correcting, because "16% of forecast hours never
displayed" was the wrong reading of it.

**Against the frame budget**, on the better of the two GPUs: the mean
(9.89 ms) fits 90 Hz with little room; the p95 (19.60 ms) is 1.77× the
90 Hz budget and still 1.17× the 60 Hz one. So the hitch is real but
occasional, and it arrives roughly twice a second at this playback
rate.

**Row 2 — Quest 3, and it beats both desktops.** The device with the
tightest frame budget, the narrowest memory bus, and no texture
headroom is the fastest of the three by a wide margin:

| device | mean | p95 | budget | mean | p95 |
|---|---|---|---|---|---|
| Intel UHD 770 | 11.47 ms | 30.20 ms | 60 Hz | 0.69× | 1.81× |
| RTX 4090 Laptop | 9.89 ms | 19.60 ms | 60 Hz | 0.59× | 1.17× |
| **Quest 3 / Adreno 740** | **4.69 ms** | **5.10 ms** | **90 Hz** | **0.42×** | **0.46×** |

Playback held **0.994×** with **zero dropped frames** — better than
either desktop on every metric, and 2.1× the 4090 on mean upload, 3.8×
on p95. Implied throughput is 22.1 GB/s against the 4090's 10.5.

**The likely reason is that a discrete GPU is a handicap here.** The
frame is software-decoded into system memory; on the laptop it must
then cross PCIe to VRAM, and the card's enormous local bandwidth never
comes into play because the bottleneck is upstream of it. The Quest has
unified memory and, on Android, Chromium can hand a decoded video frame
to GL through `SurfaceTexture`/`EGLImage` with little or no copy. The
frame is already where the GPU can see it. That also explains why the
Intel part — unified memory but no such fast path in the Windows media
stack — is the slowest of the three.

**Read the budgets by device, which the earlier rows did not.** 90 Hz
only applies to VR. A desktop globe renders at 60 Hz, where the 4090's
mean is 0.59× of budget and only its p95 slightly exceeds it. The
device that genuinely needs 90 Hz is the Quest, and it comes in at
0.42× and 0.46×. Both pass; the desktop's occasional p95 hitch is the
only wart, and it lands on the platform where a dropped frame costs
least.

**This reverses what this section predicted.** It called the Quest
decisive and expected it to fail — "if the upload cost there is
anything like this row's, the rung is not viable in VR at 7200×3600."
It is not like it. It is twice as good, and the prediction was drawn
from a measurement taken on the wrong GPU and generalised to hardware
with a different memory architecture.

**One caveat worth keeping.** The Adreno is a tile-based renderer, and
this probe's own comment notes that a tiler can report near-zero for
work it has merely queued. `gl.finish()` after a `texelFetch` draw
should force the upload to resolve, but a result that inverts the
expected ordering deserves more scrutiny than one that confirms it. If
Phase 1 is going to rest on this row, it is worth a second measurement
that does not depend on `finish()` semantics — a sustained render loop
at 90 Hz with the upload in it, and the frame rate observed rather than
timed.

**Two limits still apply.** The probe calls `gl.finish()` before
stopping the clock, deliberately, so these are an upper bound on what a
pipelined renderer pays. And this is a laptop 4090: upload crosses PCIe
from system RAM, so a desktop card with the same silicon would not
necessarily do better, since the bottleneck appears to be upstream of
the bus anyway.

<details>
<summary>Superseded first run — measured on the wrong GPU</summary>

### Does it play? — first measurement (superseded, wrong GPU)

**Retracted before it was acted on.** The numbers below were measured on
an **Intel UHD 770**, on a machine that has an RTX 4090. The probe
created its WebGL context without a `powerPreference`, so the browser
handed it the integrated GPU — while MapLibre asks for
`powerPreference: "high-performance"` and gets the discrete one. The row
therefore measured upload bandwidth on a device the 2D globe never uses.

The probe now requests `high-performance` to match MapLibre and prints
what was granted alongside what was asked for. The reasoning below about
*where* the constraint lies still holds — decode keeps up, the upload is
what costs — but every absolute number is from the wrong hardware and
must be re-measured.

**One thing this did surface, and it is not a probe bug.** MapLibre asks
for the discrete GPU; **Three.js does not** — its `WebGLRenderer` default
is `powerPreference: 'default'`, and nothing under `src/` overrides it.
So on a hybrid-graphics desktop the VR/AR globe and the Orbit character
page may be rendering on integrated graphics while the 2D globe uses the
discrete card. That deserves checking on its own account, independent of
this plan: a PCVR session on an iGPU would be far more damaging than a
slow texture upload. It does not affect the Quest, which has one GPU.

**Windows Chrome 150, Intel UHD 770 (unintended), 7200×3600 at 25 Mbps, 2026-08-15.**

```
realtime=0.975x  presented=1.8fps  frames=22 over 12.0s  loops=1
dropped=5/31 (16.13%)
texImage2D mean=11.47ms  p95=30.20ms  max=40.40ms
```

**Decode is not the bottleneck, and that reverses the assumption this
plan was built on.** At the rate the app actually plays a data-encoded
dataset — `MIN_PLAYBACK_RATE` 0.0625×, i.e. 1.88 fps — the clip held
0.975× of real time. The decoder is asked for roughly two frames a
second and delivers them. Every worry in §Context about sustained
decode throughput was aimed at the wrong layer.

**The texture upload is the constraint.** A 7200×3600 RGBA upload moves
**103.7 MB per frame**, and the measured times imply 9.0 GB/s at the
mean falling to 2.6 GB/s at the worst — plausible for an integrated GPU
on shared memory, and not something a faster decoder or a lower bitrate
improves. Against a render frame budget:

| | mean 11.47 ms | p95 30.20 ms |
|---|---|---|
| 90 Hz (11.1 ms) | 1.03× over | **2.72× over** |
| 72 Hz (13.9 ms) | 0.83× | **2.17× over** |
| 60 Hz (16.7 ms) | 0.69× | **1.81× over** |

Aggregate cost is small — 1.88 uploads/s × 11.47 ms is **22 ms per
second**, about 2% of the main thread. The problem is not the total but
the *distribution*: it arrives in one lump roughly twice a second, and
each lump overruns a 90 Hz frame. That is a visible hitch on a cadence
slow enough to notice individually rather than a uniform slowdown.

**Dropped frames matter more here than for ordinary video.** 5 of 31 is
16%, and each dropped frame of a data-encoded dataset is a *skipped
timestep* — a forecast hour the viewer never sees — rather than a
skipped picture nobody misses.

Two limits on how far to read this row.

**The probe's own stall inflates the number.** `uploadAndDraw` calls
`gl.finish()` before stopping the clock, deliberately, so the time lands
on the frame that caused it rather than measuring how fast the driver
accepts work. That makes these an *upper* bound on what a pipelined
renderer pays, and it may be causing some of the dropped frames itself.
For a transfer-bound operation the bound is fairly tight — 103.7 MB has
to cross the bus whenever it is attributed — but the p95 in particular
should not be read as a number the app would necessarily hit.

**This is the weakest GPU in the matrix.** An Intel UHD 770 on shared
memory is the floor, not the median; a discrete GPU or Apple silicon
should do considerably better.

**What it makes decisive: the Quest.** It has the tightest budget
(72–90 Hz, where the mean already fails), the narrowest memory bus, and
`MAX_TEXTURE_SIZE` exactly equal to the frame width. It is also the
device where the extra resolution would matter most. If the upload cost
there is anything like this row's, the rung is not viable in VR at
7200×3600 regardless of the decode result — and that, not decoding,
becomes the reason to stop.

</details>

**A different browser does not help on iOS, and that much is
structural.** Chrome, Firefox and Edge on iOS are all WKWebView, since
App Store policy requires it and no major browser has shipped an
alternative engine even after iOS 17.4 opened the door in the EU.
Below the engine, H.264 decode goes through VideoToolbox, and software
decode is not a way out at ≈33.6 MP per frame on a phone. One row
covers every browser on iOS.

**It does not extend to macOS**, which is where an earlier version of
this note overreached. Browsers there bring their own engine *and*
their own decode policy, and rows 4 and 5 disagree on the same
machine — Safari decoding what Chrome refuses. Test each browser on
macOS; test the device on iOS.

**A green row may still be an unusable one.** The probe seeks to 0.2 s
and reads a single frame, which answers "does a frame decode" and not
"does this play." Desktop Chrome falls back to software H.264 decode
where hardware declines, and a software decode of a 33.6 MP frame can
easily succeed once and then sustain nothing like a watchable rate. So
a desktop row that comes back green is necessary but not sufficient
evidence, and Phase 1 should not be unblocked by one without a
framerate observation beside it. Row 2 is exactly that case and is
recorded green-with-an-asterisk for it. On iOS the caveat is moot —
nothing decoded at all.

**The playback clip is deliberately not committed.** `play.html` takes
its clip from `?clip=`, so it carries no asset of its own. The real
7200×3600 clips measured for this section are ~4.3 MB at the shipped
25 Mbps ceiling and ~17.3 MB at 100 Mbps, and git history is
permanent — that is a large one-way cost for a diagnostic that runs a
handful of times. Reproduce them instead, from
`scripts/encode-geotiff-sequence.ts`, and serve them locally:

```bash
# out/ under the check is gitignored, so nothing can be committed by accident
cp real_7200_25mbps.mp4 scripts/luma-range-check/out/
npx tsx scripts/luma-range-check --serve      # prints a LAN URL
# then, on the device:
#   http://<lan-ip>:8791/play.html?clip=/out/real_7200_25mbps.mp4
```

The LAN restriction that motivated `--emit-static` does not bite here:
the devices worth playback-testing are the ones that *accept* the rung,
and iOS — the browser hardest to reach over a LAN — already refuses it
at the decode stage. If a future run needs a device off the network,
committing the 25 Mbps clip alone is the minimal version of that
decision, not both.

**Not yet covered by the probe: HLS delivery.** It serves a progressive
MP4, which isolates the decoder from the delivery layer and is what the
existing check already does. The shipped path is HLS, and
`MediaSource.isTypeSupported()` is documented as optimistic about level
— so a device may well decode this MP4 and still refuse the same stream
through MSE. That is a second question, worth answering before Phase 1
is built, and it is not answered here.

**Decision gate.** If the matrix is broadly green, Phase 1 alone is
enough and Phase 2 is never built. If a population that matters cannot
decode it, Phase 1 plus Phase 2. If almost nothing decodes it, stop —
and record the result here so the question is not reopened from scratch.

## Phase 0b — is H.264 even the right codec? (before Phase 1)

**Cheap, and it may delete Phase 2.** Everything measured so far assumed
H.264, because that is what `DATA_ENCODED_RENDITIONS` emits. That
assumption now looks like the binding constraint rather than a detail.

**The evidence that it matters.** H.264 hardware decode is capped at
**4096×4096** on essentially all consumer silicon — Intel Quick Sync,
NVIDIA NVDEC, Apple VideoToolbox. The 8K decode those parts advertise is
for HEVC and AV1. Two measurements are consistent with a 7200-wide H.264
stream being software-decoded everywhere:

- The per-frame upload cost was **the same on an RTX 4090 as on an Intel
  iGPU** (9.89 ms vs 11.47 ms) — a 1.16× difference from a card with
  roughly fifty times the memory bandwidth. That is what a
  software-decoded frame crossing PCIe looks like, not a GPU-bound
  operation.
- The Quest, with unified memory, was **twice as fast as the 4090**. The
  ordering only makes sense if the cost is getting a CPU-side frame to
  the GPU rather than anything the GPU does with it.

**What an HEVC rung could change.** If the frame is hardware-decoded it
stays in GPU memory, and the upload becomes a GPU-side copy rather than
a bus transfer — which would remove the desktop p95 hitch entirely. But
the bigger prize is on Apple: **iOS Safari refuses the H.264 rung and
decodes HEVC natively.** If it accepts an HEVC rung, the refusal that
puts the gate on its middle branch disappears, and **Phase 2 may not
need to be built at all.** That is a change to what gets built, not a
performance tweak, which is why this belongs before Phase 1 rather than
after.

**The measurement.** `scripts/encode-geotiff-sequence.ts --codec hevc`
re-encodes the same GeoTIFFs at the same resolution and the same bitrate
ceiling; every other encoder argument is unchanged, so the codec is the
only variable. Then run the *unchanged* probes:

```bash
npx tsx scripts/encode-geotiff-sequence.ts \
  --in <tifs> --out scripts/luma-range-check/out/real_7200_hevc.mp4 \
  --codec hevc --vmin -35 --vmax 78.025 --units dBZ
npx tsx scripts/luma-range-check --serve
#   …/play.html?clip=/out/real_7200_hevc.mp4
```

Record the same row per device: decodes, decoded size, `texImage2D`,
realtime ratio, upload mean/p95. The comparison that matters is against
the H.264 row for the same clip on the same device.

**Two encoder details that are not incidental.** `-tag:v hvc1` is set
rather than ffmpeg's default `hev1`: Safari and QuickTime will not play
the latter, so omitting it would manufacture a refusal on the one
platform this test exists to interrogate. And range signalling stays at
the ffmpeg level (`-color_range pc`) for both codecs, matching the "tag
the range and nothing else" form §Encoder measured as surviving
everywhere — adding codec-private colour parameters would confound the
comparison with a second variable.

**What could go wrong, stated up front.** HEVC browser support is
patchier than H.264, not better: Chrome requires hardware support and
the right build, Firefox largely lacks it, and MSE/HLS delivery adds a
compatibility layer beyond progressive MP4. So this could trade one set
of refusals for a different set — a Firefox that currently stalls might
refuse outright, and a mid-range Android might lose a decode it has
today. **A negative result is as useful as a positive one**: it closes
the codec question and Phase 1 proceeds as designed, with H.264
confirmed as the right container rather than merely the incumbent one.

**Encoding cost is worth watching too.** x265 at `-preset slow` on
25-megapixel frames is markedly slower than x264. If HEVC wins on the
decode side, the transcode budget in Phase 1 needs revisiting with real
numbers rather than the H.264 ones. Measured on a laptop CPU: **0.22
fps** at the 25 Mbps ceiling (92.65 s for 20 frames), **0.15 fps** at 77
Mbps (134.19 s).

**The four probe clips, encoder side.** All 20 frames of 7200×3600,
0.667 s, from the same GeoTIFFs.

| clip | MiB | delivered | × ceiling |
|---|---|---|---|
| H.264, 25 Mbps ceiling | 4.31 | 54.2 Mbps | 2.17 |
| HEVC, 25 Mbps ceiling | 3.30 | 41.5 Mbps | 1.66 |
| HEVC, 77 Mbps ceiling | 10.37 | 130.5 Mbps | 1.69 |
| H.264, 100 Mbps ceiling | 17.31 | 217.8 Mbps | 2.18 |

**The overshoot is a stable property of the codec, not noise** — 2.17×
and 2.18× for x264, 1.66× and 1.69× for x265, across a 3–4× change in
ceiling. Both sit well under the 3.70× the VBV window actually permits
over a clip this short, so neither is hitting the cumulative wall.

**But the ceiling still binds at 77 Mbps, which sets a Phase 1 number.**
Raising it 3.08× raised HEVC's delivered rate 3.14× — near-exact
proportionality, which only happens if VBV is still governing per frame.
CRF 18 is therefore *still* unsatisfied at 77 Mbps, so a genuinely
fidelity-grade 7200×3600 rung costs **north of 130 Mbps**. The 77 Mbps
figure was chosen for parity with the shipped 4096×2048 rung's bits per
pixel, and it delivers exactly that and no more.

**HEVC lands 23% below H.264 at a matched ceiling** — 3.30 MiB against
4.31. That is one pair, not a trend: the 77 and 100 Mbps rows are not
matched to each other.

### First result — the desktop prediction holds, on one device

**Windows Chrome 150, RTX 4090 Laptop (discrete), 7200×3600 HEVC,
2026-08-16.** Same machine, same GPU, same resolution, same probe as the
RTX 4090 row in §Does it play?, so the codec is the only variable.

```
gl: ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Laptop GPU, D3D11)
size=7200x3600  duration=0.67s  maxTex=16384  rVFC=yes
realtime=0.998x  presented=1.9fps  frames=23 over 12.3s  loops=1
dropped=5/32 (15.63%)
texImage2D mean=3.95ms  p95=7.60ms  max=60.80ms
verdict: playback KEEPS UP; upload fits 90Hz
```

**The upload cost falls by 2.5×, and the desktop p95 hitch disappears.**

| RTX 4090 Laptop, 7200×3600 | mean | p95 | max |
|---|---|---|---|
| H.264, 25 Mbps ceiling | 9.89 ms | 19.60 ms | 37.40 ms |
| **HEVC, same ceiling** | **3.95 ms** | **7.60 ms** | 60.80 ms |
| change | 2.50× faster | 2.58× faster | 1.63× worse |

That is the specific thing this section predicted — "the upload becomes
a GPU-side copy rather than a bus transfer, which would remove the
desktop p95 hitch entirely". Against the 90 Hz budget the H.264 p95 was
1.77× over; the HEVC p95 is 0.68× of it. The desktop now fits 90 Hz on
mean *and* p95, where before it fitted only 60 Hz and hitched about
twice a second.

**The discrete-GPU handicap is gone, and that is the real evidence.** On
H.264 the 4090 lost to a Quest 3 (9.89 ms against 4.69 ms), which only
made sense if the cost was moving a CPU-side frame across PCIe. On HEVC
the same card returns 3.95 ms — faster than the Quest's H.264 figure,
an implied 26.2 GB/s against 10.5. Nothing about the GPU changed
between the two runs; only where the decoded frame lives.

**One confound, since closed.** The HEVC clip is 41.5 Mbps against the
H.264 clip's 54.2 — 23% fewer bits. A texture upload should not care,
since the decoded frame is 103.7 MB either way, but `texImage2D` can
stall on an in-flight decode and a cheaper stream decodes sooner. The
higher-bitrate re-encode settles it, and did: see §The bitrate confound
is closed below.

**The dropped-frame count is now confirmed as a startup artifact.**
Every run has reported exactly **5** dropped frames — across two GPUs,
two codecs and four runs, while the denominator moved 31 → 32. A
constant that survives a codec change is deterministic startup cost,
not sustained loss. §Does it play? read this correctly.

**`max` is the one number that got worse**, 60.80 ms against 37.40. A
7200×3600 RGBA texture is a 103.7 MB allocation and a hardware decode
session has its own first-frame setup; either lands on the first upload.
It is paid once per dataset load — tolerable on the desktop globe, and
roughly five dropped frames on entering a VR session. Worth watching,
not worth acting on from one sample.

**What this does not settle.** One device, and the desktop half of the
question at that. The prize is iOS Safari, which refuses the H.264 rung
and is the sole reason the gate sits on its middle branch; nothing here
speaks to it. Nor does it speak to the Quest, where the budget is
tightest, or to Firefox, or to whether HEVC trades these refusals for
different ones. The prediction held where it was cheapest to hold.

### The bitrate confound is closed

**Windows Chrome 150, RTX 4090 Laptop, 7200×3600 HEVC at 130.5 Mbps,
2026-08-16.** Same machine, same GPU, same probe; only the bitrate moved.

```
realtime=0.999x  presented=1.9fps  frames=23 over 12.3s  loops=1
dropped=5/32 (15.63%)
texImage2D mean=3.36ms  p95=9.90ms  max=48.80ms
```

| RTX 4090 Laptop, 7200×3600 | delivered | mean | p95 |
|---|---|---|---|
| H.264, 25 Mbps ceiling | 54.2 Mbps | 9.89 ms | 19.60 ms |
| HEVC, 25 Mbps ceiling | 41.5 Mbps | 3.95 ms | 7.60 ms |
| **HEVC, 77 Mbps ceiling** | **130.5 Mbps** | **3.36 ms** | 9.90 ms |

**Tripling the bitrate inside HEVC cost nothing.** 41.5 → 130.5 Mbps is
3.14× the bits and the mean upload went *down*, 3.95 → 3.36 ms. The HEVC
clip now carries **2.4× the bits of the H.264 one and uploads 2.9×
faster**. Bitrate is excluded as the mechanism and the codec accounts
for the whole effect, which is exactly what this run was named to
settle. Implied throughput is 30.9 GB/s against H.264's 10.5 on the
same card.

**Read the mean on these runs, not the p95.** Twenty frames at 1.88 fps
gives 23 samples, so the p95 is the second-worst of 23 — nearly the max,
and not a stable statistic. The p95 moving 7.60 → 9.90 ms across two
runs is well inside what that sample size produces by chance; the mean,
over the same 23, is the comparable number. Both p95 figures sit under
the 11.1 ms budget regardless. A longer clip would fix this, and is
worth having before any of these numbers are quoted as thresholds.

**Sixth run, still exactly 5 dropped frames** — now across two GPUs, two
codecs and three bitrates, though every one of those runs is Chrome on
Windows. The Quest reports 0 on both codecs and iOS reports nothing at
all, so this is a startup artifact of one browser/platform pair rather
than a property of the clip.

**What is still open on the desktop.** Whether H.264's cost rises with
bitrate: the 100 Mbps H.264 clip exists and is unmeasured. If it also
lands near 9.9 ms, both codecs are bitrate-independent and the gap is
purely the decode path — the cleanest form of the result.

### iOS Safari accepts HEVC

**iOS Safari 26.6 (iOS 18.7, iPhone, Apple GPU), 7200×3600 HEVC at
130.5 Mbps, 2026-08-16.** The same browser version, on the same OS
version, that refuses the 8192×4096 H.264 rung with `MediaError` 4
before playback begins.

```
size=7200x3600  maxTex=16384  rVFC=yes
realtime=0.986x  presented=1.8fps  frames=23 over 12.4s  loops=1
dropped=0/0 (—)
texImage2D mean=8.91ms  p95=6.00ms  max=96.00ms
verdict: playback KEEPS UP; upload fits 90Hz
```

**It decodes at native resolution and keeps up.** `size` is 7200×3600,
not a quiet downscale, and playback holds 0.986× of real time at the
app's own 1.88 fps. This is the fidelity-grade clip, not the cheap one:
iOS took the 130.5 Mbps stream.

**Two variables moved, so state the finding narrowly.** The refusal on
record is 8192×4096 **H.264**; this accept is 7200×3600 **HEVC**. Codec
*and* resolution changed together. H.264 hardware decode caps at
4096×4096 on VideoToolbox and iOS ships no software fallback, so the
codec fully explains the old refusal — but that is not the same as
proving iOS takes HEVC at the rung's 33.6 MP. 25.9 → 33.6 MP is **29%
more pixels**, and 8192×4096 sits just above 8K UHD's own count. The
decisive test is an 8192×4096 HEVC variant, and it has not been run.

**What it does establish, which is a great deal.** iOS Safari will
decode a data-encoded frame **3.09× larger than the shipped 4096×2048
rung**, at native resolution, at a bitrate above anything the ladder
would ship, and hand it to WebGL intact. If 8192 turns out to be past
Apple's decoder, a ~7200-wide HEVC rung is a viable target on its own
and still captures most of the resolution win.

**So Phase 2's justification is now conditional rather than settled.**
It exists because iOS Safari refused the rung and iOS is not a
population this project can serve a broken globe to. That refusal is
now known to be codec-specific up to 25.9 MP at least. Phase 2 should
not be built until the 8192×4096 HEVC variant reports.

**Read the p95 here, not the mean — the reverse of the desktop rows.**
`p95` (6.00 ms) coming in *below* `mean` (8.91 ms) is arithmetically
only possible with a heavy right tail, and the tail is visible: 22
samples near 4.95 ms plus the single 96.00 ms maximum average to 8.91
exactly. So the steady-state upload is **roughly 5 ms**, an implied
20.9 GB/s, and the mean is an artifact of one frame.

**That one frame is the first, and 96 ms is the largest first-frame
cost in the matrix** — against 60.80 ms on the 4090 and 48.80 ms at
higher bitrate. It is paid once per dataset load, so on the globe it is
a load hitch rather than a playback one; at 60 Hz it is about six
frames. Worth a second look before an iOS-facing rung ships, not a
blocker.

**`dropped=0/0` is not zero dropped frames.** The denominator is zero
too: WebKit returned nothing useful from `getVideoPlaybackQuality()`,
so the count is unmeasured on this platform rather than perfect. The
0.986× realtime figure is what carries the "it kept up" claim here.

### The Quest gains nothing, and that is the mechanism confirming itself

**Quest 3 (OculusBrowser 149, Adreno 740), 7200×3600 HEVC at 130.5
Mbps, 2026-08-16.**

```
size=7200x3600  maxTex=8192  rVFC=yes
realtime=0.980x  presented=1.8fps  frames=23 over 12.5s  loops=1
dropped=0/32 (0.00%)
texImage2D mean=4.46ms  p95=5.70ms  max=15.80ms
```

| Quest 3, 7200×3600 | mean | p95 | max | realtime |
|---|---|---|---|---|
| H.264, 54.2 Mbps | 4.69 ms | 5.10 ms | — | 0.994× |
| HEVC, 130.5 Mbps | 4.46 ms | 5.70 ms | 15.80 ms | 0.980× |

**Unchanged, and that is the point.** Mean 5% better, p95 12% worse,
both inside what 23 samples produce by chance. The codec that bought
the 4090 a 2.94× improvement buys the Quest nothing at all.

**Which is exactly what the explanation predicts.** HEVC's benefit on
the desktop is the removal of a PCIe crossing: a hardware-decoded frame
stays in VRAM instead of being copied from system memory. The Quest has
unified memory, so a software-decoded frame was already somewhere its
GPU could address and there was no crossing to remove. A mechanism that
only helps where its bottleneck exists is a mechanism, not a
coincidence — and this is the third angle on the same one:

| device | memory | H.264 | HEVC | change |
|---|---|---|---|---|
| RTX 4090 Laptop | discrete, over PCIe | 9.89 ms | **3.36 ms** | 2.94× faster |
| Quest 3 / Adreno 740 | unified | 4.69 ms | 4.46 ms | unchanged |
| iPhone / Apple GPU | unified | **refused** | ~4.95 ms | nothing → everything |

**HEVC costs the Quest nothing either, which is what matters for the
decision.** A codec change that helps desktops enormously, unlocks iOS
entirely and leaves the tightest-budget device where it found it has no
constituency arguing against it.

**The Quest's tail is the best in the matrix**: a 15.80 ms maximum
against 48.80 ms on the 4090 and 96.00 ms on iOS. Its worst single
upload barely exceeds a 90 Hz frame, where the other two overrun one by
4× and 8×. Zero dropped frames of 32, genuinely measured this time.

**`maxTex=8192` is still the thing to watch.** At 7200 wide there are
992 texels of headroom. At the rung's 8192 there are none — the limit
*equals* the frame width. So the Quest's 8192×4096 question is two
questions stacked: whether the decoder takes it, and whether a texture
at exactly `MAX_TEXTURE_SIZE` allocates. Both are unanswered, and both
land on the same variant iOS needs.

### The 8K HEVC variant has a positive control

**Windows Chrome 150 (Win 11), `H_ceiling_8k` and `I_ceiling_8k_hevc`
side by side, 2026-08-16.** Both 8192×4096, one variable apart.

| variant | decoded | ready | decoded size | texImage2D | spike | native |
|---|---|---|---|---|---|---|
| `H_ceiling_8k` (H.264) | yes | 4 | 8192×4096 | ok | 251 | **yes** |
| `I_ceiling_8k_hevc` (HEVC) | yes | 4 | 8192×4096 | ok | **253** | **yes** |

**This row answers nothing about the gate, and that is what makes it
worth having.** Windows Chrome already accepted the H.264 rung, so an
HEVC accept here moves no decision. What it establishes is that the new
variant is a working instrument: it encodes, it decodes at native
resolution, and it round-trips values. A refusal on iOS or the Quest
can now be attributed to the device rather than to a probe input added
two commits ago — which is the difference between a Phase 0b result and
a bug hunt.

**The value round trip is identical to the digit across both codecs**:
220/256 exact, MAE 0.141, max |e| 1, gain 1.0002, offset −0.08, and both
endpoints clean at 0 → 0 and 255 → 255. Switching codec costs the data
nothing.

**Identical is the expected answer, not a suspicious one.** The residual
error at 8 bits is the transport lattice — a property of `yuv420p` and
the untagged range round trip, which both files share — rather than
anything the codec does. Compression loss at CRF 18 on a smooth ramp is
far below one code, so what survives to be measured is the lattice, and
the lattice does not care which encoder produced the frame.

**The one place they differ is the one place they should.** The spike
region is an isolated single texel, the highest-frequency feature in
the frame and the only part a codec can plausibly damage differently:
HEVC returns **253** against H.264's **251**, against 255 for a perfect
read and about 63 through a 2× downscale. Marginally better preservation
from the more efficient codec, and — more to the point — both are
unambiguously native. That the two differ at all is also the proof the
files are genuinely different encodes rather than one file measured
twice.

**`readoutFull` is skipped on both** — 8192×4096 exceeds what a 2D
canvas will hold. Known, and why the WebGL `readout` path is the one
that carries these rows.

### iOS Safari accepts the full rung in HEVC

**iOS Safari 26.6 (iOS 18.7, iPhone, Apple GPU), both 8K variants,
2026-08-16.**

| variant | decoded | ready | decoded size | MAX_TEXTURE_SIZE | texImage2D | spike | native |
|---|---|---|---|---|---|---|---|
| `H_ceiling_8k` (H.264) | **load failed, code 4** | — | — | 16384 | — | — | — |
| `I_ceiling_8k_hevc` (HEVC) | **yes** | 4 | **8192×4096** | 16384 | ok | **253** | **yes** |

**This is the answer the plan was gated on.** iOS Safari decodes the
full 8192×4096 rung in HEVC, at native resolution, and hands it to
WebGL intact. Not the 7200×3600 stand-in — the rung itself. The refusal
that put the gate on its middle branch and made Phase 2 load-bearing is
codec-specific, and the codec clears it.

**The control refused in the same run.** `H_ceiling_8k` failed with
`MediaError` code 4 on the same device, same day, same harness, minutes
apart. So this is a codec difference measured against a live refusal
rather than against a record from three days earlier — which is what
the paired run was for.

**Two of the four value paths report FAIL, and neither is the one the
app uses.**

| path | mechanism | exact | MAE | max \|e\| | |
|---|---|---|---|---|---|
| `readout` | 1×1 `drawImage` into a 2D canvas | 12/256 | 6.809 | 11 | FAIL |
| `readoutSrgb` | same, `colorSpace: 'srgb'` | 12/256 | 6.809 | 11 | FAIL |
| `readoutFull` | whole frame via 2D canvas | skipped — too large | | | |
| **`render`** | **`texImage2D` + readback, WebGL** | **220/256** | **0.141** | **1** | **PASS** |

The failing pair are the 2D-canvas paths, and Safari colour-transforming
a 2D canvas is the documented reason `src/services/glLumaSampler.ts`
exists at all: the shipped `LumaSampler` reads its texel through WebGL2
*because* a 1×1 `drawImage` is wrong on Safari, macOS and iOS alike,
with no 2D fallback and deliberately so. This reproduces a known defect
on a path the app does not take, at a new frame size.

**The path the app does take matches desktop to the digit** — 220/256
exact, MAE 0.141, max |e| 1, endpoints clean at 0 → 0 and 255 → 255,
the same figures §The 8K HEVC variant has a positive control recorded
on Windows Chrome. The spike reads **253 on both devices**. Two
different platforms, one file, identical numbers.

**The failure signature is the transfer-mismatch shape, worth recording
for the next person who meets it**: endpoints pinned with the midtones
bowed, gain 1.0033 and offset +6.10. Same shape §E/F bisected on
Firefox, different cause — there it was the bt709 tags, here it is
Safari's 2D canvas, and these variants carry no colour flags at all. The
shape identifies a class, not a culprit.

**What is still open, and it is not nothing.** This is one iPhone on one
iOS version; Apple's HEVC ceiling may differ on older silicon. Playback
at 8192×4096 on iOS is unmeasured — the 7200×3600 run passed, but that
is 29% fewer pixels and it already carried a 96 ms first-frame cost, the
worst in the matrix. And **macOS Chrome and Firefox remain untested on
HEVC** — Chrome's HEVC support depends on hardware and build, so §Phase
0b's warning that this could trade one set of refusals for a different
set is still live for those two.

### The Quest allocates a texture at exactly its own limit

**Quest 3 (OculusBrowser 149, Adreno 740), both 8K variants,
2026-08-16.**

| variant | decoded | ready | decoded size | MAX_TEXTURE_SIZE | texImage2D | spike | native |
|---|---|---|---|---|---|---|---|
| `H_ceiling_8k` (H.264) | yes | 4 | 8192×4096 | **8192** | ok | 251 | **yes** |
| `I_ceiling_8k_hevc` (HEVC) | yes | 4 | 8192×4096 | **8192** | ok | **253** | **yes** |

**Both of the stacked questions answer yes.** The decoder takes
8192×4096 HEVC, and — the one this device was uniquely placed to settle
— **a texture whose width is exactly `MAX_TEXTURE_SIZE` allocates and
uploads**. Zero headroom is enough headroom. That had been flagged since
the first Quest row as a plausible way for the rung to fail on the
device where the resolution would matter most, and it does not.

**All four value paths pass here, including the two that failed on
iOS.** The Quest's 2D-canvas readout returns 217/256 with MAE 0.152 and
max |e| 1 — marginally lossier than its own WebGL path but comfortably
passing. That is the counterpart the iOS row needed: the 2D-canvas
failure is Safari colour-managing a canvas, not something an 8K frame
does to a 2D readback in general.

**Three platforms, one file, identical numbers on the shipped path.**

| device | render exact | MAE | max \|e\| | spike (H.264 / HEVC) |
|---|---|---|---|---|
| Windows Chrome 150 | 220/256 | 0.141 | 1 | 251 / 253 |
| iOS Safari 26.6 | 220/256 | 0.141 | 1 | — / 253 |
| Quest 3 | 220/256 | 0.141 | 1 | 251 / 253 |

Identical to the digit across x86 Windows, Apple silicon and mobile ARM.
Whatever the transport lattice costs, it costs the same everywhere, and
the codec change does not move it.

### Firefox takes both codecs, and breaks the 2D path on only one

**Windows Firefox (Win 11), both 8K variants, 2026-08-16.** Both decode
at native 8192×4096 with `MAX_TEXTURE_SIZE` 16384, a clean
`texImage2D`, and spikes of 251 for H.264 and 253 for HEVC — the same
pair every other accepting device returns.

| variant | path | exact | MAE | max \|e\| | offset | 255 → | |
|---|---|---|---|---|---|---|---|
| `H_ceiling_8k` | 2D `readout` | 220/256 | 0.141 | 1 | −0.05 | 255 | PASS |
| `H_ceiling_8k` | WebGL `render` | 220/256 | 0.141 | 1 | −0.05 | 255 | PASS |
| `I_ceiling_8k_hevc` | 2D `readout` | **39/256** | **0.852** | **2** | **−0.81** | **254** | **FAIL** |
| `I_ceiling_8k_hevc` | WebGL `render` | 220/256 | 0.141 | 1 | −0.05 | 255 | PASS |

**Same browser, same frame size, same day — only the codec differs.**
Firefox reads an untagged HEVC stream about one code low through a 2D
canvas and an untagged H.264 stream exactly right, with the top
endpoint landing on 254 instead of 255. Since these variants carry no
colour flags at all, what this exposes is that an *untagged* stream is
interpreted per-codec: the decoder has to guess, and Firefox guesses
differently for HEVC than for H.264.

**It is a different defect from the iOS one, despite the same table
cell failing.**

| | exact | MAE | max \|e\| | offset | 255 → |
|---|---|---|---|---|---|
| iOS Safari, HEVC | 12/256 | 6.809 | 11 | **+6.10** | 255 |
| Windows Firefox, HEVC | 39/256 | 0.852 | 2 | **−0.81** | **254** |

Safari's is large, positive, and pins both endpoints — its 2D canvas
colour-transform. Firefox's is small, negative, and lets the top
endpoint slip. Two browsers, two mechanisms, one shared property: the
WebGL path is untouched on both.

**This retroactively strengthens a decision made for a different
reason.** `src/services/glLumaSampler.ts` reads through WebGL2 with **no
2D fallback, deliberately**, and that was chosen because Safari
colour-transforms a 2D canvas. It now also covers a Firefox-plus-HEVC
case that did not exist when the choice was made. A 2D fallback would
have been a latent bug waiting for the codec change this section
recommends.

**In physical terms, on the MPAS clip, the Firefox error is under a
dBZ** — max 2 codes at 0.458 dBZ per code. Small, real, and not on the
path the app takes. Worth knowing for anyone reading values out of a
canvas in a future tool.

### Safari's 2D defect is the engine, not the codec

**macOS Safari 26.5.2 (Apple GPU), both 8K variants, 2026-08-16.** Both
decode at native 8192×4096 with a clean `texImage2D` — spike 252 for
H.264, 253 for HEVC. Fifth HEVC accept.

| variant | 2D `readout` | WebGL `render` |
|---|---|---|
| `H_ceiling_8k` | 12/256, MAE 6.809, max \|e\| 11, offset **+6.10** — FAIL | 220/256, MAE 0.141 — PASS |
| `I_ceiling_8k_hevc` | 12/256, MAE 6.809, max \|e\| 11, offset **+6.10** — FAIL | 220/256, MAE 0.141 — PASS |

**Byte-identical across the two codecs, and byte-identical to iOS.** Not
merely similar: the same 12/256, the same 6.809, the same 1.0033 gain
and +6.10 offset that §iOS Safari accepts the full rung in HEVC
recorded, and the same 1.0005 / −0.07 on the render path. One WebKit
defect, expressed the same way on desktop and mobile, indifferent to
what produced the frame.

**This closes an ambiguity the iOS row could not close on its own.** The
argument there ran through three devices and still had a hole:

| evidence | rules out | leaves open |
|---|---|---|
| iOS Safari — HEVC 2D fails, H.264 unavailable | — | cause: engine or codec? |
| Quest — both 2D paths pass | "8K frames break 2D readback generally" | either remaining cause |
| Firefox — H.264 2D passes, HEVC 2D **fails** | — | makes "HEVC breaks 2D" a live hypothesis |
| **macOS Safari — both fail identically** | **codec** | engine, alone |

Firefox is what made this worth running rather than assuming. Until it
reported, "the 2D path dislikes HEVC" was a perfectly good explanation
of the iOS row, and it happens to be the right explanation *for
Firefox*. Safari with both codecs in hand is the only configuration
that separates them, and it says the two browsers are failing for
different reasons that happen to land in the same table cell.

**So there are three distinct 2D behaviours across the matrix**, and
`glLumaSampler`'s no-2D-fallback rule covers all three: Safari
transforms regardless of codec, Firefox misreads an untagged HEVC
stream specifically, and Chrome and the Quest are clean on both.
(**Narrowed 2026-08-16:** macOS Firefox passes both, so the Firefox
clause is Windows-only and the count is four — see §macOS Firefox.)

**The H.264 spike varies slightly by platform — 251, 252 — while HEVC
reads 253 everywhere.** Five devices, one file, one number. Not load
-bearing, but it is the sort of consistency worth noticing in an
isolated single-texel feature, since that is the measurement most
sensitive to whatever each decoder does differently.

### macOS Chrome accepts both, and the H.264 refusal did not reproduce

**macOS Chrome, both 8K variants, 2026-08-16.** Both decode at native
8192×4096 with a clean `texImage2D` — spike 252 for H.264, 253 for
HEVC — and **all four value paths pass on both**, 220/256 exact, MAE
0.141, gain 1.0005, offset −0.07.

**Sixth HEVC accept. The matrix is complete and HEVC has no refusals.**

| device / browser | H.264 at 8192×4096 | HEVC at 8192×4096 |
|---|---|---|
| Windows Chrome 150 | accepts | **accepts** |
| Windows Firefox | accepts (stall did not reproduce) | **accepts** |
| macOS Safari 26.5.2 | accepts | **accepts** |
| macOS Chrome | accepts (refusal did not reproduce) | **accepts** |
| iOS Safari 26.6 | **`MediaError` 4** | **accepts** |
| Quest 3 (Adreno 740) | accepts | **accepts** |

**The unplanned result is the H.264 column.** This row was recorded on
2026-08-13 as a refusal — `MediaError` 4, no software fallback — and it
now decodes. **Confirmed to be the same M2 Ultra**, three days apart,
so there is no second configuration to blame: Chrome changed underneath
the measurement. The refusal is retired, not narrowed.

**Which leaves iOS Safari as the only H.264 refusal in the entire
matrix** — and the only one that has ever reproduced.

**Two of the three negative results in the original matrix have now
failed to reproduce**, and that is a methodological finding rather than
a coincidence. Firefox's stall and macOS Chrome's refusal were each a
single run against a self-updating browser, three days before a re-run
contradicted them — and the macOS Chrome re-run was on **the same
machine**, so nothing about the hardware explains it. Accepts have held
everywhere on re-test; refusals have not. **A negative result from one run on a browser that updates
itself is the weakest row in any matrix**, and this document leaned on
two of them to argue Phase 2 was load-bearing. Future rows should be
dated, versioned, and re-run before a refusal is allowed to shape what
gets built.

**The gain and offset are identical across all three Apple-platform
browsers** — 1.0005 and −0.07 on macOS Chrome, macOS Safari and iOS
Safari alike, against 1.0002 / −0.08 on Windows Chrome, 0.9998 / −0.05
on Windows Firefox and 0.9998 / −0.06 on the Quest. ~~The platform sets
those digits, not the browser, which is what a shared VideoToolbox
decode path underneath both engines would look like.~~

**Falsified by the next device to report, 2026-08-16.** macOS Firefox
returns 0.9998 / −0.05 — Firefox's *Windows* numbers, on Apple hardware.
The correct statement is narrower: Chrome and Safari agree exactly on
Apple platforms, consistent with both sitting on VideoToolbox, and
Firefox does not join them because it brings its own conversion. See
§macOS Firefox, which narrows two claims. **This is the third
generalisation in this document to be falsified by the next row**, and
it was written on three data points one commit before a fourth arrived.

**And macOS Chrome is clean on the 2D readout for both codecs**, which
sharpens §Safari's 2D defect is the engine, not the codec: two browsers
on the same OS, one transforming the canvas and one not, so the
transform belongs to WebKit rather than to macOS.

### macOS Firefox, which narrows two claims

**macOS Firefox, both 8K variants, 2026-08-16.** Both decode at native
8192×4096 — spike 251 for H.264, 253 for HEVC — and **every value path
passes on both**, 220/256 exact, MAE 0.141, gain 0.9998, offset −0.05.
Seventh row, seventh HEVC accept, still no refusals anywhere.

**Firefox's HEVC 2D defect is Windows-only.** §Firefox takes both codecs
recorded a 2D readout that passed H.264 and failed HEVC, and concluded
Firefox "misreads an untagged HEVC stream specifically". On macOS the
same browser passes both, so that sentence needs its platform: it is
**Firefox on Windows**. The explanation survives narrowing — an untagged
stream is interpreted by whatever decodes it, and Firefox uses different
backends per platform — but the claim as written was one row too broad.

**So the 2D picture across the full matrix is four behaviours, not
three:**

| browser / platform | H.264 2D | HEVC 2D |
|---|---|---|
| Safari (macOS **and** iOS) | fail | fail — identical numbers |
| Firefox (Windows) | pass | **fail** |
| Firefox (macOS) | pass | pass |
| Chrome (Windows, macOS), Quest | pass | pass |

`glLumaSampler`'s no-2D-fallback rule still covers every one of them,
which is the practical point and is unchanged by the narrowing.

**`MAX_TEXTURE_SIZE` is 8192 here, and that is new for a desktop
browser.** Chrome and Safari on the same OS report 16384. Firefox on
macOS sits at exactly the frame width — the same zero-headroom position
as the Quest, which had been treated as a headset peculiarity. It
uploads fine, as the Quest does. **The consequence is for Phase 1
rather than for this row: 8192 is a hard ceiling on two independent
device families, so a rung wider than 8192 loses both**, and no amount
of decode capability recovers a texture that will not allocate.

Assumes Phase 0 passed.

### HEVC over HLS is not a codec swap — scoped 2026-08-16

Phase 0b's result makes an HEVC rung the obvious next step, and the
encoder side really is one field: `HlsRendition` already carries
`height`, `crf` and `maxBitrateKbps`, and `buildFfmpegArgs` hardcodes
`-c:v:${i} libx264` next to them. **The delivery side is where the work
is**, and it was under-scoped when this section was written.

**Apple will not play HEVC in MPEG-TS.** HLS carries HEVC only in fMP4
(CMAF) segments, and this pipeline is TS end to end —
`-hls_segment_filename … segment_%03d.ts`. Adding a codec field alone
produces a stream ffmpeg muxes happily and iOS refuses, which would
manufacture in the publish pipeline exactly the refusal Phase 0b just
removed from the probe. That failure would look like a device
limitation and would not be one.

**And `-hls_segment_type` is a global muxer option, not per-variant**,
so a two-rung HEVC + H.264 ladder cannot mix formats. Either outcome
tomorrow moves the whole ladder to fMP4; only the rung count is still
open. The migration is outcome-independent, which is the one piece of
good news here.

**What assumes `.ts` today**, all of which moves together:

| site | what it does |
|---|---|
| `cli/lib/ffmpeg-hls.ts` | emits `segment_%03d.ts`; the documented layout names it |
| `cli/lib/r2-upload.ts` | MIME map has `.ts → video/mp2t`, nothing for `.m4s` |
| `cli/transcode-from-dispatch.ts` | probes `segment_001.ts`, reads `segment_000.ts`, filters keys on `.endsWith('.ts')` and slices the extension by length |
| `cli/lib/hls-incremental.ts` | content-addressed storage at `segments/sha256/{hex}.ts`, with variant-playlist URIs built from the same shape |

**The last row is the real cost, and it is not a rename.** Incremental
transcode dedups by hashing each segment and storing it once — a model
that works because a TS segment is independently decodable. An fMP4
segment is not: it is meaningless without its rendition's `init.mp4`.
So the content-addressed cache needs a concept it does not have, and
resume/append semantics need re-thinking rather than re-pathing. This
is the reason Phase 1 is not a day's work, and the reason it should not
be started the evening before the last Phase 0b row reports.

**A cheaper route may exist and is worth checking first.** The
data-encoded path publishes **exactly one rung** by design — §Part 2 of
`DATA_ENCODED_VIDEO_PLAN.md` argues an ABR ladder is incoherent when
luma is the measurement. With one rung there is no adaptation to do, so
HLS is buying segmentation and seeking, not its actual purpose. Every
Phase 0b measurement was taken against a **progressive MP4** served
over plain HTTP, and it decoded and played on all four platforms at
8192×4096. If `datasetLoader` can be taught to take a progressive
source for data-encoded rows, the entire fMP4-and-dedup problem is
sidestepped. That is a question about the client, not the encoder, and
it should be answered before the fMP4 migration is costed.

| change | file | note |
|---|---|---|
| Add the rung | `cli/lib/ffmpeg-hls.ts` | `DATA_ENCODED_RENDITIONS` is a single-element `readonly` tuple at `height: 2048`. Needs to become per-dataset rather than a module constant. |
| **Scale `maxBitrateKbps` with pixel count** | same | The measured failure. 25 Mbps at `height: 4096` corrupts values. Either scale to ~100 Mbps or drop the cap and let `crf 18` drive, but it must not bind. |
| Bump `segmentDescriptorHash` | `cli/lib/hls-incremental.ts` | `v: 1` → `2`. Its own docstring warns ladder-wide codec settings are not per-rendition fields; without the bump, segments cached under the old settings get recycled into a bundle carrying the new ones. |
| Accept the resolution | `cli/lib/sos-spec.ts` | Currently *warns* (not fails) on anything other than 4096×2048. Should stay quiet for a data-encoded dataset legitimately at 8192×4096. |
| Publisher opt-in | publisher API + portal | Which datasets get the rung. Transcode cost and storage both roughly quadruple, so this cannot be automatic. |
| Extend the round-trip check | `scripts/luma-range-check` | Add an 8192×4096 variant beside the existing ones, so the fidelity property is guarded rather than measured once by hand. |

**Deploy ordering:** the runner must ship before any dataset opts in, or
a pipeline requests a rung the transcoder does not know how to build.

**The `crf`-versus-`maxrate` question is worth deciding deliberately.**
The measurement shows the cap binding and corrupting values, but the
delivered bitrate on real content is whatever `crf 18` asks for, which
for a smooth field is far below either cap. The synthetic noise band
demanded ~160 Mbps and is not representative. Before picking a number,
encode one real 8K reflectivity or aerosol frame set and see what it
actually wants.

## Phase 2 — pinned two-rung ladder (superseded 2026-08-16)

**Do not build this as a capability fallback. Phase 0b removed its
reason to exist.** It was conditioned on a population that matters
failing Phase 0, and iOS Safari was that population: it refuses the
8192×4096 rung in H.264 and accepts it in HEVC, at the full frame size.
Every other device accepts both. There is no capability gap left to
bridge, so an HEVC Phase 1 is the whole of the work.

The section is kept rather than deleted because **its mechanism is
still wanted for a different reason**. §The ladder as a relative shape
argues for a viewer-operated quality control — a bandwidth choice
rather than a capability fallback — and that is the same pinning
machinery described below, resolved by user choice instead of by
feature detection. Read what follows as the design for that, and read
"resolve capability once at load" as "resolve the viewer's choice once
at load, capability being one input to it".

The original framing follows, unedited.

Publish 8192×4096 and 4096×2048, resolve capability once at load, then
**pin** — `hls.currentLevel`, which locks a rung — rather than
`autoLevelCapping`, which leaves ABR free to move beneath the cap.
Keep `hlsService`'s existing media-error handler as the escape hatch,
since a decode failure is real capability information.

The open design question is what "resolve capability" means in code.
`hlsService` today caps on screen dimension, with a comment noting
`capLevelToPlayerSize` does not work here because the canvas is not
sized at first-frame decode. Screen size is a poor proxy for decoder
capability, and `MediaSource.isTypeSupported()` is documented as
optimistic about level — it commonly returns true and then falls back
to software decode, which is a performance collapse rather than a clean
failure. Phase 0's matrix is what should decide this; do not guess it
in advance.

Two consequences to carry:

- **The rungs disagree about values.** The downscale must be
  `flags=neighbor` per the Encoder section, and neighbour decimation
  means the 4K rung samples the 8K one rather than averaging it. Two
  viewers on different hardware read different numbers at the same
  lat/lon. Neither is wrong; they are different samplings.
- **That has to surface.** The Analyze panel already carries a
  quantisation caveat and needs a resolution one beside it, with a new
  i18n key. Whether a CSV export should record which rung produced it
  is an open question — see below.

---

## The ladder as a relative shape (raised 2026-08-16)

**Status: raised, not decided.** Nothing here gates Phase 1, and none of
it should be built before the Phase 0b matrix closes. It is recorded
because Phase 0b's first non-SOS dataset broke an assumption the ladder
had been resting on unexamined, and because two of the questions have
cheap first steps worth knowing about while the shape is settled.

### The ladder is absolute where it means to be relative

`cli/lib/ffmpeg-hls.test.ts` names its assertion
**`DATA_ENCODED_RENDITIONS publishes the source rung only`** and then
pins `height` to `2048`. Both were true at once for as long as every
dataset in the catalog was 4096×2048: "the source rung" and "the
constant" were the same number, and nothing distinguished intent from
implementation. MPAS at 7200×3600 is the first row where they come
apart, and it comes apart in both directions.

**Above the constant, the decimation is non-integer.** 7200 → 4096 is a
factor of 1.758. `flags=neighbor` selects rather than interpolates, so
every output texel remains a value that was actually measured — the
property the neighbour rule exists to protect, and it holds. What does
not hold is *evenness*: an irregular subset of source columns survives,
and the sampling is lumpy in a way nothing in the asset declares. Phase
2's two rungs are a clean 2:1 and do not have this problem. A
source-relative ladder must not acquire it.

**Below the constant, the pipeline upscales.** A 1° global model is
360×180, and `scale=4096:2048` replicates it to 129× the texels. Being
precise about that cost matters, because most of the obvious objections
to it are wrong:

- *File size barely moves.* Uniformly replicated blocks compress to
  almost nothing in either codec.
- *Statistic values survive.* Area weighting is scale-invariant under
  uniform replication, so the mean, the percentiles and the histogram
  shape are unchanged.
- **Counts do not survive, and counts are exported on purpose.** The
  zonal CSV carries a per-band texel count precisely so a reader knows
  what a number is worth — "a mean over four texels does not deserve the
  weight of one over four thousand". Upscaling turns that column into
  fiction, reporting thousands of samples where there were dozens.
- *Decode and memory are real.* Every device decodes 8.4 MP and holds
  33 MB of texture for 0.065 MP of information.

So the case for a source-relative ladder is not mainly bandwidth. **It
is that the export stops overstating its own precision.**

### The rule that falls out

Top rung is the source resolution. Any rung beneath it is an **integer
-factor decimation** — 1/2, 1/4 — never an arbitrary height. That is the
only form in which every output texel is a real source texel *and* the
sampling stays even. Two constraints come with it: `yuv420p` needs even
dimensions, so an odd source wants a stated policy rather than a silent
round; and a source whose halving lands below anything useful simply
publishes one rung.

### The warning needs provenance that does not currently travel

Phase 2 records that a resolution caveat has to sit beside Analyze's
quantisation one. The gap underneath that is that **the client cannot
presently detect the condition it would be warning about.** It knows the
decoded frame size from the video element and has nothing to compare it
against: `ColorScale` carries value provenance — `vmin`, `vmax`,
`dataMinLuma`, the stops — and no spatial provenance at all.

The first step is therefore smaller than the warning: carry the source
dimensions on the sidecar or the dataset row. Everything else is
downstream of being able to compare two numbers, and with both in hand
the caveat can say *by how much* and whether the factor was integer,
rather than only that something happened.

### A rung the viewer picked is not what determinism forbade

§Part 2 of [`DATA_ENCODED_VIDEO_PLAN.md`](DATA_ENCODED_VIDEO_PLAN.md)
rules out an ABR ladder because a bandwidth dip would swap the rung
mid-session, change the value under the cursor, and make the frame
Analyze reduces non-deterministic. That objection is to **silent,
bandwidth-driven** switching. It does not reach a control the viewer
operated deliberately from a label saying what it costs: they know they
did it, and they can re-run the measurement.

So a manual quality selector is compatible with the argument that killed
automatic ABR, and it is the natural user-facing form of Phase 2's
pinning — the same `hls.currentLevel` mechanism, resolved by choice as
well as by capability. One requirement travels with it: switching rungs
must invalidate any Analyze result on screen, because those statistics
describe a frame that no longer exists. `playbackSettle` is already the
"recompute when the displayed frame changes" seam and is where that
belongs.

### The unresolved tension, stated rather than settled

**One rung and two rungs pull in opposite directions, and Phase 0b does
not settle which wins.**

- **One rung is the cheap path to 8K.** With no adaptation to perform,
  HLS provides segmentation rather than its actual purpose, and the
  fMP4-and-dedup problem in §HEVC over HLS is not a codec swap can be
  routed around entirely by serving a progressive MP4 — which is what
  every measurement in Phase 0b was taken against.
- **Two rungs buy the slow-connection story** and the accuracy/speed
  trade above, and in doing so make HLS earn its place — which drags the
  fMP4 migration and the init-segment problem in the content-addressed
  cache back onto the critical path.

macOS Chrome's result decides whether a **capability** fallback is
needed. It says nothing about whether a **bandwidth** one is wanted.
That second question is about who the catalog is serving, it deserves a
deliberate answer, and the risk worth naming is that a demo deadline
answers it by default.

---

## Verification

- The Phase 0 matrix, recorded here as a table rather than a verdict,
  including the read-back-a-known-texel result per device.
- `scripts/luma-range-check` extended with an 8192×4096 variant —
  **done** (`H_ceiling_8k`), plus an HEVC twin (`I_ceiling_8k_hevc`),
  **run on seven browser/platform pairs**. HEVC: seven accepts, no
  refusals. H.264: six accepts and one refusal (iOS Safari) — the
  Firefox stall and the macOS Chrome refusal both failed to reproduce.
  CI still cannot
  contribute a row — Playwright's Chromium ships no H.264 decoder at
  all — which is why `--serve` and the static bundle exist.
- One real 8K dataset published and probed end to end: hover value,
  Analyze statistics, and a contour pass, each compared against the same
  dataset at 4096×2048. The statistics will differ — that is expected
  and is the point of the caveat line — but they should differ by
  resampling, not by the tail corruption Phase 1's bitrate change fixes.
- A deliberate negative: confirm a device that *cannot* decode the 8K
  rung degrades the way Phase 0 predicted, rather than silently
  presenting downscaled values as measured ones.

## Open questions

1. **Should a reported value carry its resolution?** If two viewers
   read different numbers, an Analyze CSV export arguably has to record
   which rung produced it, or the file is not reproducible. Leaning yes,
   but it widens the export schema.
2. **What bitrate does real 8K content actually want?** See Phase 1.
   Nobody should pick a cap from the synthetic measurement above.
3. ~~**Is 4.89 km worth it at all?**~~ **Answered, 2026-08-16.** The
   question asked for a dataset whose value is visibly limited by the
   grid, and MPAS 3 km reflectivity is one. Published at the shipped
   4096×2048 rung it lands at **9.78 km per texel — 3.3× coarser than
   its own source grid** — and at storm-scale zoom the texels are
   plainly visible as blocks, with individual convective cells a
   handful of texels across.

   That is the justification this plan was missing, and it is worth
   being precise about what it does and does not establish. It shows
   the grid is the binding limit *for this dataset*, not that 4.89 km
   is worth quadrupled transcode and storage for the catalog at large —
   the scoping section still ranks "accept 9.78 km" first, correctly,
   for the overwhelming majority of rows. What changes is that Phase 1
   would no longer be built speculatively: there is now a real dataset,
   already published, that it visibly improves.

   Note the arithmetic does not stop at 4.89 km. Even an 8192-wide
   rung leaves MPAS 1.6× coarser than native, so this buys a
   substantial improvement rather than parity.
