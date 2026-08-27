// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * Encode a directory of single-band GeoTIFFs into a data-encoded video
 * plus the matching `color_scale` sidecar.
 *
 *   npx tsx scripts/encode-geotiff-sequence.ts --in ./tifs --out ./out/real.mp4
 *
 * Built for the Phase 0 playback probe in
 * `docs/DATA_ENCODED_RESOLUTION_PLAN.md`: the luma check's own variants
 * are twelve identical flat-band frames lasting 0.4 s, which decode for
 * free and would report any device as fine. Measuring playback needs
 * real data at a real resolution, which is what this produces.
 *
 * It is equally the encoder half of a publishable dataset — the sidecar
 * it writes is the `color_scale` the catalog expects — but note that
 * `DATA_ENCODED_RENDITIONS` currently pins published data-encoded video
 * to a single 4096x2048 rung, so anything larger is transcoded *down*
 * on publish. Until Phase 1 lifts that, the output here is for the
 * probe, not for `zyra-publish`.
 *
 * Requires `gdalinfo` and `gdal_translate` on PATH (GDAL) and `ffmpeg`.
 * Neither is an npm dependency and neither is needed to run the SPA;
 * this is a one-shot authoring tool.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

// The catalog's default encode rate (`cli/lib/ffmpeg-hls.ts`
// OUTPUT_FRAME_RATE), and this script's rate when `--playback-fps` is
// not given: one coded frame per source frame.
//
// It used to be the *only* rate this emitted, because
// `tourEngine` assumed 30 when converting a tour's requested frame rate
// into a `playbackRate`. It no longer assumes: it divides by the
// dataset's own `playback_fps`, so a file encoded at its own rate and
// one transcoded with held frames behave the same inside a tour. That
// is what lets `--playback-fps` emit a real frame rate instead of
// manufacturing duplicates — see `outputFrameRate`.
const OUTPUT_FRAME_RATE = 30

/**
 * Bitrate ceiling, in kbps, matching `DATA_ENCODED_RENDITIONS` in
 * `cli/lib/ffmpeg-hls.ts` — which pairs `-crf` with `-maxrate` and a
 * `-bufsize` of twice that.
 *
 * CRF alone is a quality target with no ceiling. On 25-plus-megapixel
 * frames six hours apart, the inter-frame deltas are enormous and it
 * will happily spend hundreds of megabits per second: a first run here
 * produced 816 Mbps, about 33x what the catalog serves. That is the
 * wrong artifact twice over — far too large to keep, and a heavier
 * decode than the shipped path would ever ask a device to perform, so
 * a probe fed by it answers a question nobody asked.
 *
 * `docs/DATA_ENCODED_RESOLUTION_PLAN.md` §Context measured value
 * corruption at this ceiling against 100 Mbps for an 8K frame (max
 * error 7 vs 2, 0.117% vs 0.012% of pixels). Raise it with
 * `--max-bitrate` when testing what a higher-fidelity rung would cost;
 * the default is what ships today.
 */
const DEFAULT_MAX_BITRATE_KBPS = 25_000

/** x264's `--vbv-init` default: the fraction of `-bufsize` already
 *  available at the first frame. */
const VBV_INIT_FRACTION = 0.9

/** How many times `-maxrate` the VBV buffer is set to. */
const BUFSIZE_MULTIPLE = 2

/**
 * Seconds after which average bitrate converges on the ceiling, i.e.
 * when the clip outlasts the VBV buffer.
 *
 * The buffer holds `BUFSIZE_MULTIPLE` seconds of bits at the ceiling and
 * starts `VBV_INIT_FRACTION` full, so their product is the runtime the
 * initial fullness covers on its own — and it does not move when the
 * ceiling does, because bufsize is pinned to a multiple of it.
 *
 * A *duration*, deliberately, though it was a frame count until
 * `--playback-fps` existed. While every clip was read at 30 fps the two
 * were the same statement and the frame count was the easier one to
 * print. They are not the same statement any more: twenty frames read at
 * 2 fps is a ten-second clip that comfortably outlasts the buffer, and a
 * frame-count test would announce the opposite while the encoder did the
 * right thing. The buffer drains in seconds; it has never had an opinion
 * about frames.
 */
const SECONDS_FOR_RATE_TO_AMORTISE = VBV_INIT_FRACTION * BUFSIZE_MULTIPLE

/**
 * Lowest luma code that carries data; everything below is the reserved
 * no-data band (`ColorScale.dataMinLuma` in `src/types/color-scale.ts`).
 *
 * Not 1. The H.264 round trip moves codes by up to one step on several
 * of the browser/platform pairs measured in
 * `docs/DATA_ENCODED_VIDEO_PLAN.md` §Encoder, so a no-data band exactly
 * one code wide can be read as data and the lowest real value can be
 * read as no-data. Eight codes costs 3% of the range and makes the
 * boundary unambiguous.
 */
const DEFAULT_DATA_MIN_LUMA = 8

/**
 * Codec-specific arguments. Everything else about the encode is shared,
 * so what differs here is exactly what a codec comparison is allowed to
 * vary.
 *
 * **Why HEVC is worth an option at all.** H.264 hardware decode is
 * capped at 4096x4096 on essentially all consumer silicon — Intel Quick
 * Sync, NVIDIA NVDEC and Apple VideoToolbox alike. The 8K decode those
 * parts advertise is HEVC and AV1. `DATA_ENCODED_RESOLUTION_PLAN.md`
 * measured a 7200-wide H.264 clip costing the same per-frame upload on
 * an RTX 4090 as on an Intel iGPU — a card with ~50x the memory
 * bandwidth — which is what a software-decoded frame crossing the bus
 * looks like. If HEVC gets hardware decode at this size, the frame
 * stays in GPU memory and the whole cost profile changes. More
 * importantly, iOS Safari refuses the H.264 rung outright, and iOS
 * decodes HEVC natively: if it accepts an HEVC rung, the refusal that
 * makes Phase 2 necessary disappears.
 *
 * `-tag:v hvc1` is not optional. ffmpeg defaults HEVC in MP4 to the
 * `hev1` sample entry, which Safari and QuickTime will not play — so
 * omitting it would produce a false refusal on the exact platform this
 * option exists to test, which is the worst outcome a probe can deliver.
 *
 * Range signalling is deliberately left at the ffmpeg level
 * (`-color_range pc`) for both, matching the "tag the range and nothing
 * else" form that `DATA_ENCODED_VIDEO_PLAN.md` measured as the one that
 * survives everywhere. Adding codec-private colour params would confound
 * the comparison with a second variable.
 */
const CODECS: Record<string, { args: string[]; note: string }> = {
  h264: {
    args: ['-c:v', 'libx264', '-profile:v', 'main'],
    note: 'what the catalog ships today',
  },
  hevc: {
    args: ['-c:v', 'libx265', '-profile:v', 'main', '-tag:v', 'hvc1'],
    note: 'hardware decode above 4096 wide; required for an iOS accept',
  },
}

/** Default palette: a viridis-like ramp with the bottom of the range
 *  fading to transparent, matching the published smoke pipeline's habit
 *  of not drawing a haze over the whole globe for values that are
 *  indistinguishable from nothing. The SPA rebuilds its LUT from these
 *  stops, so this is a default rather than a commitment. */
const DEFAULT_STOPS = [
  { t: 0, rgba: [68, 1, 84, 0] },
  { t: 0.25, rgba: [59, 82, 139, 180] },
  { t: 0.5, rgba: [33, 145, 140, 220] },
  { t: 0.75, rgba: [94, 201, 98, 240] },
  { t: 1, rgba: [253, 231, 37, 255] },
]

interface Args {
  in: string
  out: string
  vmin?: number
  vmax?: number
  units?: string
  dataMinLuma: number
  nodata?: number
  maxBitrateKbps: number
  playbackFps?: number
  codec: string
  keepTemp: boolean
  lossless: boolean
}

/** Flags that consume the following argv entry as their value. */
const VALUE_FLAGS = [
  'in', 'out', 'vmin', 'vmax', 'units', 'data-min-luma', 'nodata',
  'max-bitrate', 'playback-fps', 'codec',
] as const

/** Flags that are presence-only. */
const BOOLEAN_FLAGS = ['keep-temp', 'lossless'] as const

/**
 * Reject anything this script does not understand, before it does work.
 *
 * Every flag was previously read by looking for its own name and
 * ignoring the rest of argv, so a name this script had never heard of
 * simply did nothing. That is the worst available behaviour for a tool
 * whose runs take minutes and whose output is uploaded somewhere: a
 * flag carried over from a newer checkout, or a typo, produces a
 * complete, plausible, silently wrong artifact.
 *
 * It cost exactly that once. `--lossless` was passed to a checkout that
 * did not have it yet; the run ignored it, emitted a perfectly ordinary
 * lossy encode, and the file was published and analysed before anyone
 * noticed the flag had never been implemented in that copy.
 *
 * `--flag=value` is rejected explicitly rather than lumped in with
 * unknown names, because it is not a typo — it is a reasonable guess
 * about a convention this parser does not implement, and it would
 * otherwise fail in the same silent way.
 */
function rejectUnknownArgs(argv: string[]): void {
  const known = new Set<string>([...VALUE_FLAGS, ...BOOLEAN_FLAGS])
  const valued = new Set<string>(VALUE_FLAGS)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      throw new Error(
        `unexpected argument "${arg}". Every input is named — `
        + `did you mean --in ${arg}?`)
    }
    const name = arg.slice(2)
    if (name.includes('=')) {
      const [head] = name.split('=')
      throw new Error(
        `--${head}=... is not supported; this script takes the value as the `
        + `next argument.\n  Use: --${head} <value>`)
    }
    if (!known.has(name)) {
      throw new Error(
        `unknown flag --${name}.\n`
        + `  Known flags: ${[...VALUE_FLAGS].map(f => '--' + f).join(', ')}, `
        + `${[...BOOLEAN_FLAGS].map(f => '--' + f).join(', ')}\n`
        + `  A flag this copy does not implement is ignored no longer: it used `
        + `to produce a\n  complete, plausible, silently wrong file.`)
    }
    if (valued.has(name)) {
      // The value is skipped so it is not mistaken for a flag — values
      // may legitimately look like one, and `--vmin -35` is the case
      // that matters. But skipping it *unchecked* reopened the hole
      // this function exists to close: in `--out --losless`, the
      // misspelling is swallowed as `--out`'s value, never validated,
      // and the run writes a lossy encode to a file literally named
      // `--losless`.
      //
      // A single dash is what a negative number wears; two is what a
      // flag wears. Nothing this script accepts as a value begins with
      // two, so that is the line.
      const value = argv[i + 1]
      if (value === undefined) {
        throw new Error(`--${name} needs a value, and none followed it.`)
      }
      if (value.startsWith('--')) {
        throw new Error(
          `--${name} needs a value, but the next argument is "${value}".\n`
          + `  If "${value}" was meant as a flag, --${name} is missing its value.\n`
          + `  If it was meant as the value, this script cannot express that — `
          + `values may\n  start with a single dash (--vmin -35) but not two.`)
      }
      i++
    }
  }
}

function parseArgs(argv: string[]): Args {
  rejectUnknownArgs(argv)
  const get = (name: string): string | undefined => {
    const i = argv.indexOf('--' + name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  const num = (name: string): number | undefined => {
    const raw = get(name)
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n)) throw new Error(`--${name} expects a number, got ${raw}`)
    return n
  }
  const inDir = get('in')
  if (!inDir) throw new Error('--in <dir> is required')
  // `dataMinLuma` goes straight into the sidecar, and `parseColorScale`
  // is fail-closed about it. A fractional or out-of-range value is
  // accepted happily by `mapToLuma`, encodes a whole sequence, and then
  // yields a sidecar the server and the renderer both reject — an
  // unpublishable artifact produced silently, an hour after the mistake.
  // 254 rather than 255 because at least one code must remain above the
  // no-data band for data to occupy.
  const lumaLo = num('data-min-luma') ?? DEFAULT_DATA_MIN_LUMA
  if (!Number.isInteger(lumaLo) || lumaLo < 0 || lumaLo > 254) {
    throw new Error(`--data-min-luma must be an integer in 0..254, got ${lumaLo}`)
  }
  // `--playback-fps` is how a dataset that should advance slowly gets
  // encoded: the frames are *read* at that rate and written at 30, so
  // each one is held for `30 / fps` output frames. It has to be baked
  // into the file because nothing in the player applies a dataset's
  // `playback_fps` — `tourEngine` is the only thing that ever sets
  // `playbackRate`, and only during a tour. This mirrors
  // `cli/transcode-from-dispatch.ts`, which does the same with
  // `-framerate` on the image-sequence input.
  const playbackFps = num('playback-fps')
  if (playbackFps !== undefined
      && (!(playbackFps > 0) || playbackFps > OUTPUT_FRAME_RATE)) {
    throw new Error(
      `--playback-fps must be greater than 0 and at most ${OUTPUT_FRAME_RATE}, `
      + `got ${playbackFps}. Above ${OUTPUT_FRAME_RATE} would drop frames rather `
      + `than hold them.`)
  }

  // Validated up front for the same reason as the luma floor: an
  // unrecognised codec would otherwise reach ffmpeg as a missing
  // encoder, minutes into a run, as a wall of stderr.
  const codec = (get('codec') ?? 'h264').toLowerCase()
  // `hasOwn`, not `in`: `in` walks the prototype chain, so `--codec
  // toString` would pass and then fail later at `CODECS[codec].args`
  // with a message about the wrong thing. The point of validating here
  // is that an unrecognised codec says so immediately.
  if (!Object.hasOwn(CODECS, codec)) {
    throw new Error(`--codec must be one of ${Object.keys(CODECS).join(', ')}, got ${codec}`)
  }
  // `--lossless` is refused here rather than where the ffmpeg arguments
  // are built, because by that point `requireTools` has run and
  // `gdalinfo` has read every frame — including the full range scan
  // when --vmin/--vmax were not given. On twenty 55 MB GeoTIFFs that is
  // minutes of work before an invocation that could never have
  // succeeded. Same reasoning as the codec check above it.
  const lossless = argv.includes('--lossless')
  if (lossless && codec !== 'hevc') {
    throw new Error(
      `--lossless requires --codec hevc, got ${codec}.\n`
      + '  Lossless H.264 needs the High 4:4:4 Predictive profile, which this\n'
      + '  script does not emit: it pins Main for device compatibility, and a\n'
      + '  4:4:4 stream is not what the hardware decoding these datasets wants.\n'
      + '  HEVC is the codec for data-encoded video above 4096 wide anyway.')
  }
  return {
    in: resolve(inDir),
    out: resolve(get('out') ?? 'out/data-encoded.mp4'),
    vmin: num('vmin'),
    vmax: num('vmax'),
    units: get('units'),
    dataMinLuma: lumaLo,
    nodata: num('nodata'),
    maxBitrateKbps: num('max-bitrate') ?? DEFAULT_MAX_BITRATE_KBPS,
    playbackFps: playbackFps,
    codec,
    keepTemp: argv.includes('--keep-temp'),
    lossless,
  }
}

function run(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`${bin} not found on PATH (${r.error.message})`)
  if (r.status !== 0) {
    throw new Error(`${bin} failed:\n${(r.stderr || '').slice(-2000)}`)
  }
  return r.stdout
}

interface Info {
  width: number
  height: number
  noDataValue?: number
  min?: number
  max?: number
}

/** `-stats` is what makes min/max available, and it is why this is not
 *  merged into one call per file: computing statistics reads the whole
 *  raster, so it only runs when the caller has not supplied the range. */
function gdalInfo(file: string, withStats: boolean): Info {
  const args = ['-json']
  if (withStats) args.push('-stats')
  args.push(file)
  const j = JSON.parse(run('gdalinfo', args)) as {
    size: [number, number]
    bands: { noDataValue?: number; minimum?: number; maximum?: number }[]
  }
  if (!j.bands?.length) throw new Error(`${file} has no raster bands`)
  if (j.bands.length > 1) {
    process.stderr.write(
      `  warning: ${file} has ${j.bands.length} bands; only band 1 is read\n`)
  }
  return {
    width: j.size[0],
    height: j.size[1],
    noDataValue: j.bands[0].noDataValue,
    min: j.bands[0].minimum,
    max: j.bands[0].maximum,
  }
}

/** GeoTIFF -> flat little-endian Float32, which Node can read without a
 *  TIFF decoder. ENVI is the simplest GDAL format that is literally the
 *  raster with a text header beside it. */
function toFloatRaster(src: string, dest: string): void {
  run('gdal_translate', ['-q', '-of', 'ENVI', '-ot', 'Float32', '-b', '1', src, dest])
}

/**
 * Map physical values onto luma codes.
 *
 * The exact inverse of `lumaToValue` in `src/types/color-scale.ts`:
 * `value = vmin + (luma - lo) / (255 - lo) * (vmax - vmin)`. Written
 * here as the forward direction so the two can be checked against each
 * other by eye rather than re-derived.
 *
 * Out-of-range values clamp to the ends, which is the documented meaning
 * of vmin/vmax rather than a shortcut. No-data goes to 0 — below
 * `dataMinLuma`, so `isTransparentLuma` reports it as nothing measured
 * rather than as a reading at the bottom of the scale.
 */
function mapToLuma(
  src: Float32Array, out: Uint8Array, vmin: number, vmax: number,
  lo: number, nodata: number | undefined,
): void {
  const span = vmax - vmin
  const range = 255 - lo
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (Number.isNaN(v) || (nodata !== undefined && v === nodata)) { out[i] = 0; continue }
    const t = (v - vmin) / span
    out[i] = t <= 0 ? lo : t >= 1 ? 255 : Math.round(lo + t * range)
  }
}

/**
 * Check every external binary before doing any work.
 *
 * Without this the run fails at first use: `gdalinfo` on file one, or —
 * far worse — `ffmpeg` only once the statistics pass has read every
 * raster, which on twenty 55 MB GeoTIFFs is minutes of work discarded.
 * The HEVC case is nastier still, because a perfectly good ffmpeg can
 * lack libx265: that failure would land *after* the frames were
 * generated and piped, at the point where the encoder is asked to
 * exist.
 */
/**
 * Why a slow dataset is encoded at its own frame rate rather than held
 * across a 30 fps one.
 *
 * The first version of this duplicated frames: read at `sourceFps`,
 * write at 30, so each source frame occupied `30 / sourceFps` output
 * frames. That produced a file whose container said 30 fps, which the
 * catalog liked, and which shimmered on screen.
 *
 * The duplicates are not copies. A held frame's residual is measured
 * against the *reconstruction* of its reference, not against the
 * source, so the encoder spends its remaining budget creeping toward
 * the true value across the run: frame one of a hold is a rough
 * approximation and frame fifteen is a better one. Measured at
 * 3600x1800 with the shipped ceiling, **zero of twenty-nine held pairs
 * decoded bit-identically**, and 28.5% of pixels changed between
 * consecutive frames of what should have been a still image. On a
 * palette with hard bands — the NWS reflectivity ramp steps every
 * 5 dBZ, about eleven luma codes apart — that drift lands as pixels
 * flipping between adjacent colours, which is what a viewer reported
 * as shimmering.
 *
 * Things that do not fix it, all measured: raising the ceiling four
 * times over (3/29 identical), `cutree=0` (worse, 0/29), removing the
 * VBV cap entirely (2/29 at ten times the size). Only `lossless=1`
 * made holds stable, at a size no one wants. The refinement is
 * inherent to lossy coding, not a parameter mistake.
 *
 * Encoding at the source rate removes the duplicates, and with them
 * the problem: there is no second frame to refine toward anything.
 * Each frame is coded once, displayed for `1 / fps` seconds by the
 * container, and never touched again. It is also strictly better use
 * of the bitrate, since the budget is spread across the frames that
 * carry information instead of across fifteen copies of each.
 *
 * `scenecut=0` went with the duplicates, and had to. It existed
 * because duplication *manufactured* scene cuts — the one real frame
 * arriving after a run of identical ones looks exactly like a cut, and
 * coding each as an I-frame cost ~105 MB against ~10 MB. Without
 * duplication those cuts are not manufactured, they are real: two
 * consecutive frames of a forecast are hours apart and share little.
 * Forcing a P-frame across a break that genuine buys nothing and
 * predicts from an uncorrelated reference, so the detector is left to
 * do its job.
 *
 * The cost is that the file's frame rate is no longer the catalog's 30.
 * That mattered while `tourEngine` assumed 30 when converting a tour's
 * requested rate into a `playbackRate`; it now divides by the dataset's
 * own `playback_fps`, so a dataset encoded this way and one transcoded
 * with held frames behave identically inside a tour. Set the row's
 * `playback_fps` to the same value passed here.
 */
function outputFrameRate(sourceFps: number): number {
  return sourceFps
}

/**
 * Rate control: quality-targeted by default, exact under `--lossless`.
 *
 * The default pairs CRF with a `-maxrate` ceiling, because CRF alone
 * has none and will spend hundreds of megabits per second on frames
 * this large. That is the right shape for a picture. It is a
 * compromise for a measurement, and the size of the compromise is
 * easy to under-estimate: at 7200x3600 the shipped ceiling works out
 * to about 0.03 bits per pixel, which is nowhere near enough to carry
 * exact sample values.
 *
 * `--lossless` says the luma *is* the data and must survive intact.
 * Every decoded texel then equals the byte that went in, so a hover
 * readout, a statistic and a contour all describe the source rather
 * than a reconstruction of it. CRF and the ceiling are dropped rather
 * than combined: both are quality targets, and a target below
 * "exact" is what is being refused.
 *
 * It is not the default because the files are large — on
 * incompressible synthetic speckle, roughly an order of magnitude over
 * the capped encode. Real fields are mostly no-data and highly
 * structured, so the true cost is a question for the frames in hand,
 * which is exactly why this is a flag and not a constant.
 */
function rateControlArgs(args: Args): string[] {
  if (!args.lossless) {
    // CRF is not comparable across codecs — x265 needs a higher number
    // for the same quality — but the bitrate ceiling binds well before
    // CRF does on frames this large, so two codecs are compared at
    // matched *bitrate* rather than matched CRF. That is the right
    // axis anyway: the question is what a device does with a given
    // stream, not which encoder is more efficient.
    //
    // bufsize at `BUFSIZE_MULTIPLE` x maxrate mirrors
    // `buildFfmpegArgs`, and the amortisation threshold is derived
    // from the same constant, so the reported bound cannot drift from
    // the encode it describes.
    return [
      '-crf', '18',
      '-maxrate', `${args.maxBitrateKbps}k`,
      '-bufsize', `${args.maxBitrateKbps * BUFSIZE_MULTIPLE}k`,
    ]
  }
  // Unreachable through `parseArgs`, which refuses this pairing before
  // any frames are read — the message a user sees lives there. Kept
  // because this function's contract is its arguments, not its one
  // current caller, and because emitting `-qp 0` alongside the Main
  // profile produces no output file at all rather than a warning.
  if (args.codec !== 'hevc') {
    throw new Error(`--lossless requires --codec hevc, got ${args.codec}`)
  }
  return ['-x265-params', 'lossless=1']
}

function requireTools(codec: string): void {
  const missing: string[] = []
  const broken: string[] = []
  for (const [bin, probe] of [
    ['gdalinfo', '--version'],
    ['gdal_translate', '--version'],
    ['ffmpeg', '-version'],
  ] as const) {
    const r = spawnSync(bin, [probe], { encoding: 'utf8' })
    if (r.error) { missing.push(bin); continue }
    // Found is not the same as runnable. A bundled GDAL invoked outside
    // its own environment spawns cleanly and then dies loading its DLLs:
    // no stdout, no stderr, and an exit status Windows reports as
    // 0xC0000135. Counting that as present just moves the failure into
    // the first real call, which is what this function exists to stop.
    // Output on either stream counts, since a tool that prints its
    // version to stderr is still a working tool.
    const said = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    if (r.status !== 0 || !said) {
      broken.push(`${bin} (exit ${r.status ?? r.signal ?? 'unknown'})`)
    }
  }
  if (broken.length && !missing.length) {
    throw new Error(
      `on PATH but not runnable: ${broken.join(', ')}\n`
      + `  The binary was found and started, then exited without saying anything.\n`
      + `  On Windows exit 3221225781 (0xC0000135) is a missing DLL, which is what\n`
      + `  a bundled GDAL does when it runs outside the environment it belongs to —\n`
      + `  putting one directory on PATH is not always enough to satisfy it.\n`
      + `  Start ArcGIS Pro's "Python Command Prompt" (bin\\Python\\Scripts\\proenv.bat)\n`
      + `  or the OSGeo4W Shell, which activate the whole environment, and run this\n`
      + `  from there instead.`)
  }
  if (missing.length) {
    throw new Error(
      `not on PATH: ${missing.join(', ')}\n`
      + `  GDAL ships inside QGIS, OSGeo4W and ArcGIS Pro, and none of the three put\n`
      + `  it on PATH. On Windows, find it with:\n`
      + `    Get-ChildItem 'C:\\Program Files' -Recurse -Filter gdalinfo.exe -EA SilentlyContinue\n`
      + `  then APPEND that directory to $env:PATH, not prepend: those are whole\n`
      + `  bundled environments, and a conda ffmpeg built without libx264/libx265\n`
      + `  would otherwise shadow a working one.`)
  }
  // A build without the encoder is the failure this function exists to
  // move forward: ffmpeg is present, so nothing above catches it, and
  // libx265 is the one people are missing.
  const enc = codec === 'hevc' ? 'libx265' : 'libx264'
  const r = spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' })
  if (!(r.stdout ?? '').includes(enc)) {
    throw new Error(
      `this ffmpeg has no ${enc} encoder, which --codec ${codec} needs.\n`
      + `  Check with: ffmpeg -hide_banner -encoders | findstr ${enc.slice(3)}\n`
      + `  Full builds (gyan.dev or BtbN on Windows) carry it; minimal ones may not.`)
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(args.in)) throw new Error(`--in ${args.in} does not exist`)
  requireTools(args.codec)

  const files = readdirSync(args.in)
    .filter(f => ['.tif', '.tiff'].includes(extname(f).toLowerCase()))
    .sort()
    .map(f => join(args.in, f))
  if (!files.length) throw new Error(`no .tif/.tiff files in ${args.in}`)

  const first = gdalInfo(files[0], false)
  const { width, height } = first
  process.stdout.write(`${files.length} frames, ${width}x${height}\n`)

  // A sequence whose frames disagree on size would be encoded as
  // whichever size ffmpeg was told about, silently misreading every
  // later frame's bytes as the wrong shape.
  for (const f of files.slice(1)) {
    const info = gdalInfo(f, false)
    if (info.width !== width || info.height !== height) {
      throw new Error(`${f} is ${info.width}x${info.height}, expected ${width}x${height}`)
    }
  }
  if (width !== height * 2) {
    process.stderr.write(
      `  warning: ${width}x${height} is not 2:1; the globe expects equirectangular\n`)
  }

  const nodata = args.nodata ?? first.noDataValue

  // One scale for the whole sequence, never per frame. A per-frame
  // range would make the same luma mean a different value in each
  // frame, which is the one thing a data-encoded video may not do.
  let { vmin, vmax } = args as { vmin?: number; vmax?: number }
  if (vmin === undefined || vmax === undefined) {
    process.stdout.write('computing range across all frames (pass --vmin/--vmax to skip)…\n')
    let lo = Infinity, hi = -Infinity
    for (const f of files) {
      const s = gdalInfo(f, true)
      if (s.min !== undefined) lo = Math.min(lo, s.min)
      if (s.max !== undefined) hi = Math.max(hi, s.max)
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      throw new Error('could not derive a range; pass --vmin and --vmax')
    }
    vmin = vmin ?? lo
    vmax = vmax ?? hi
  }
  if (vmin === vmax) throw new Error(`vmin equals vmax (${vmin}); nothing to encode`)
  process.stdout.write(`range ${vmin} … ${vmax}${args.units ? ' ' + args.units : ''}`
    + `  (luma ${args.dataMinLuma}…255, 0 = no data)\n`)
  // An upper bound, not an estimate, and it must account for the VBV
  // buffer rather than just the drain rate.
  //
  // `-maxrate` with `-bufsize` is a leaky-bucket constraint: bits drain
  // at maxrate from a buffer that x264 starts ~90% full (`--vbv-init`).
  // A clip spends the initial fullness *plus* whatever drains during
  // its runtime, so `rate x duration` is only the whole story once the
  // clip outlasts the buffer, which takes
  // `SECONDS_FOR_RATE_TO_AMORTISE` and is independent of the ceiling —
  // raising maxrate raises the buffer in step.
  //
  // Printing the naive product instead cost a real run: 20 frames came
  // out at 2.15x the "prediction" and tripped a stop-and-report rule
  // built on it, when the ceiling had been applied correctly the whole
  // time. A bound that a correct encode can exceed is worse than no
  // bound, because it trains people to ignore it.
  // Duration is set by how fast the frames are *read*. With
  // `--playback-fps 2` twenty frames are ten seconds, not two thirds of
  // one, and every bitrate/size figure below depends on getting this
  // right.
  const sourceFps = args.playbackFps ?? OUTPUT_FRAME_RATE
  const durationSec = files.length / sourceFps
  const boundBytes =
    (VBV_INIT_FRACTION * args.maxBitrateKbps * BUFSIZE_MULTIPLE * 1000
      + args.maxBitrateKbps * 1000 * durationSec) / 8
  process.stdout.write(`codec ${args.codec} — ${CODECS[args.codec].note}\n`)
  if (args.lossless) {
    // No ceiling, so no bound worth printing: the size is whatever the
    // data costs to carry exactly. Saying so beats printing a figure
    // derived from a ceiling that is not in force.
    process.stdout.write(
      `lossless — every decoded texel equals the byte that went in.\n`
      + `  ${files.length} frames (${durationSec.toFixed(2)}s); size is set by the data,\n`
      + `  not by a ceiling, and --max-bitrate is ignored\n`)
  } else {
    process.stdout.write(
      `ceiling ${args.maxBitrateKbps} kbps `
      + `(bufsize ${args.maxBitrateKbps * BUFSIZE_MULTIPLE}k)`
      + `  → at most ${(boundBytes / 1e6).toFixed(1)} MB for ${files.length} frames`
      + ` (${durationSec.toFixed(2)}s)\n`)
    if (durationSec < SECONDS_FOR_RATE_TO_AMORTISE) {
      process.stdout.write(
        `  note: under ${SECONDS_FOR_RATE_TO_AMORTISE.toFixed(1)}s the buffer, not the rate, sets the size —\n`
        + `        expect an average bitrate above the ceiling, which is correct VBV behaviour\n`)
    }
  }

  mkdirSync(dirname(args.out), { recursive: true })
  const tmp = join(dirname(args.out), '.geotiff-frames')
  mkdirSync(tmp, { recursive: true })

  // Settings measured across five browser/platform pairs in
  // `docs/DATA_ENCODED_VIDEO_PLAN.md` §Encoder. The range conversion and
  // the range tag together are what survive; adding *some* of transfer,
  // primaries and matrix is the combination that breaks Chromium, so
  // this deliberately sets the range and nothing else.
  const ff = spawn('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-s:v', `${width}x${height}`,
    '-framerate', String(sourceFps), '-i', 'pipe:0',
    '-vf', 'scale=in_range=full:out_range=full',
    '-color_range', 'pc',
    ...CODECS[args.codec].args,
    '-pix_fmt', 'yuv420p',
    // Output at the source rate: one coded frame per source frame,
    // displayed for `1 / fps` seconds by the container. See
    // `outputFrameRate` for why this is not the catalog's 30 — briefly,
    // holding frames across a faster container makes the encoder refine
    // each duplicate toward the true value, and that drift is visible
    // as shimmer on a hard-banded palette.
    '-r', String(outputFrameRate(sourceFps)),
    // CRF is not comparable across codecs — x265 needs a higher number
    // for the same quality — but the bitrate ceiling below binds well
    // before CRF does on frames this large, so the two encodes are
    // compared at matched *bitrate* rather than matched CRF. That is the
    // right axis anyway: the question is what a device does with a given
    // stream, not which encoder is more efficient.
    '-preset', 'slow',
    ...rateControlArgs(args),
    '-an',
    // Move `moov` to the front. ffmpeg writes it last in a single-pass
    // encode, because it cannot know the sample table until every frame
    // is written — which is fine for a local file and wrong for one
    // served over HTTP. A progressive player cannot parse a thing until
    // it has the movie header, so with `moov` at the tail it must
    // range-request the end of the file before it can begin, and on a
    // phone those extra round trips are the difference between playing
    // and timing out. HLS hid this by segmenting; publishing a file as
    // uploaded does not.
    '-movflags', '+faststart',
    args.out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] })

  const failed = new Promise<never>((_, rej) => {
    ff.on('error', e => rej(new Error(`ffmpeg not found on PATH (${e.message})`)))
    ff.on('close', code => {
      if (code !== 0) rej(new Error(`ffmpeg exited ${code}`))
    })
  })

  const luma = new Uint8Array(width * height)
  const write = (chunk: Uint8Array): Promise<void> =>
    new Promise((res, rej) => {
      // Respect back-pressure. An 8-bit 7200x3600 frame is 26 MB and
      // libx264 at `slow` is far behind the loop that produces them;
      // ignoring the return value buffers the whole sequence in memory.
      if (ff.stdin.write(chunk)) return res()
      ff.stdin.once('drain', res)
      ff.stdin.once('error', rej)
    })

  const encodeAll = async (): Promise<void> => {
    for (let i = 0; i < files.length; i++) {
      const raw = join(tmp, `f${i}.img`)
      toFloatRaster(files[i], raw)
      const buf = readFileSync(raw)
      const expect = width * height * 4
      if (buf.length !== expect) {
        throw new Error(`${files[i]} produced ${buf.length} bytes, expected ${expect}`)
      }
      // Little-endian: GDAL writes ENVI in host byte order and every
      // platform this runs on is little-endian. The header beside the
      // raster records it as `byte order = 0` if it ever needs checking.
      const floats = new Float32Array(buf.buffer, buf.byteOffset, width * height)
      mapToLuma(floats, luma, vmin as number, vmax as number, args.dataMinLuma, nodata)
      await write(luma)
      if (!args.keepTemp) rmSync(raw, { force: true })
      rmSync(raw + '.hdr', { force: true })
      rmSync(raw + '.aux.xml', { force: true })
      process.stdout.write(`  frame ${i + 1}/${files.length}\r`)
    }
    ff.stdin.end()
  }

  Promise.race([encodeAll().then(() => new Promise<void>(res => ff.on('close', () => res()))), failed])
    .then(() => {
      if (!args.keepTemp) rmSync(tmp, { recursive: true, force: true })
      const sidecar = args.out.replace(/\.mp4$/, '') + '.color_scale.json'
      writeFileSync(sidecar, JSON.stringify({
        stops: DEFAULT_STOPS,
        vmin,
        vmax,
        ...(args.units ? { units: args.units } : {}),
        dataMinLuma: args.dataMinLuma,
      }, null, 2) + '\n')
      process.stdout.write(
        `\nwrote ${args.out}\n      ${sidecar}\n\n`
        + `Probe it with:\n`
        + `  <deploy>/luma-check/play.html?clip=<url-to-mp4>\n`
        + `which defaults to the app's own 0.0625x playback rate; add &rate=1\n`
        + `for the 16x-heavier stress case.\n`)
    })
    .catch((e: Error) => {
      process.stderr.write(`\n${e.message}\n`)
      process.exitCode = 1
    })
}

const USAGE = `
encode-geotiff-sequence — GeoTIFF sequence -> data-encoded video + color_scale

  npx tsx scripts/encode-geotiff-sequence.ts --in <dir> [options]

  --in <dir>            directory of single-band .tif/.tiff, sorted by name
  --out <file.mp4>      default out/data-encoded.mp4
  --vmin <n> --vmax <n> physical range; default is the min/max across all
                        frames, which costs a full statistics pass
  --units <s>           unit label carried into the sidecar, e.g. "mg m-2"
  --data-min-luma <n>   lowest luma code carrying data (default ${DEFAULT_DATA_MIN_LUMA})
  --nodata <n>          override the GeoTIFF's own no-data value
  --codec <h264|hevc>   default h264. hevc unlocks hardware decode above
                        4096 wide and is the one Apple decodes natively,
                        so it is the lever for an iOS accept.
  --playback-fps <n>    encode at <n> frames per second, so the dataset
                        advances at that rate. Set the dataset row's
                        playback_fps to the same value: the player needs it
                        for tour playback-rate maths, not for ordinary
                        playback, where the rate is already in the file.
                        Encoding at the real rate rather than holding each
                        frame across a 30 fps container is what keeps a
                        hard-banded palette from shimmering.
  --max-bitrate <kbps>  ceiling, default ${DEFAULT_MAX_BITRATE_KBPS} (what the catalog ships).
                        Without it CRF alone is uncapped and will emit
                        hundreds of Mbps on large frames.
  --lossless            encode so every decoded texel equals the byte that
                        went in. For data-encoded video the luma IS the
                        measurement, and the default CRF+ceiling is a
                        quality target rather than an exactness one.
                        Ignores --max-bitrate. Files are much larger.
  --keep-temp           leave the intermediate rasters in place

Needs gdalinfo, gdal_translate and ffmpeg on PATH.
`

try {
  main()
} catch (e) {
  // A stack trace is the wrong output for a missing flag. This gets run
  // cold, on whichever machine holds the data rather than the history.
  process.stderr.write(`error: ${(e as Error).message}\n${USAGE}`)
  process.exitCode = 1
}
