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

// The catalog encodes every dataset at 30 fps and expresses a dataset's
// display rate as `playbackRate = requestedFps / 30`
// (`cli/lib/ffmpeg-hls.ts` OUTPUT_FRAME_RATE). Emitting anything else
// silently changes what every consumer's playback-rate maths means, so
// this is fixed rather than a flag.
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

/** Frames after which average bitrate converges on the ceiling, i.e.
 *  when the clip outlasts the VBV buffer. `VBV_INIT_FRACTION * 2 *
 *  OUTPUT_FRAME_RATE`, with the 2 being bufsize's multiple of maxrate —
 *  so it does not move when the ceiling does. */
const MIN_FRAMES_FOR_RATE_TO_AMORTISE = Math.ceil(VBV_INIT_FRACTION * 2 * OUTPUT_FRAME_RATE)

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
  codec: string
  keepTemp: boolean
}

function parseArgs(argv: string[]): Args {
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
  return {
    in: resolve(inDir),
    out: resolve(get('out') ?? 'out/data-encoded.mp4'),
    vmin: num('vmin'),
    vmax: num('vmax'),
    units: get('units'),
    dataMinLuma: lumaLo,
    nodata: num('nodata'),
    maxBitrateKbps: num('max-bitrate') ?? DEFAULT_MAX_BITRATE_KBPS,
    codec,
    keepTemp: argv.includes('--keep-temp'),
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
  // clip outlasts the buffer. With bufsize pinned at 2x maxrate that
  // takes ~54 frames at 30 fps, and it is independent of the ceiling —
  // raising maxrate raises the buffer in step.
  //
  // Printing the naive product instead cost a real run: 20 frames came
  // out at 2.15x the "prediction" and tripped a stop-and-report rule
  // built on it, when the ceiling had been applied correctly the whole
  // time. A bound that a correct encode can exceed is worse than no
  // bound, because it trains people to ignore it.
  const durationSec = files.length / OUTPUT_FRAME_RATE
  const boundBytes =
    (VBV_INIT_FRACTION * args.maxBitrateKbps * 2 * 1000
      + args.maxBitrateKbps * 1000 * durationSec) / 8
  process.stdout.write(`codec ${args.codec} — ${CODECS[args.codec].note}\n`)
  process.stdout.write(
    `ceiling ${args.maxBitrateKbps} kbps (bufsize ${args.maxBitrateKbps * 2}k)`
    + `  → at most ${(boundBytes / 1e6).toFixed(1)} MB for ${files.length} frames`
    + ` (${durationSec.toFixed(2)}s)\n`)
  if (files.length < MIN_FRAMES_FOR_RATE_TO_AMORTISE) {
    process.stdout.write(
      `  note: under ${MIN_FRAMES_FOR_RATE_TO_AMORTISE} frames the buffer, not the rate, sets the size —\n`
      + `        expect an average bitrate above the ceiling, which is correct VBV behaviour\n`)
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
    '-framerate', String(OUTPUT_FRAME_RATE), '-i', 'pipe:0',
    '-vf', 'scale=in_range=full:out_range=full',
    '-color_range', 'pc',
    ...CODECS[args.codec].args,
    '-pix_fmt', 'yuv420p',
    // CRF is not comparable across codecs — x265 needs a higher number
    // for the same quality — but the bitrate ceiling below binds well
    // before CRF does on frames this large, so the two encodes are
    // compared at matched *bitrate* rather than matched CRF. That is the
    // right axis anyway: the question is what a device does with a given
    // stream, not which encoder is more efficient.
    '-preset', 'slow', '-crf', '18',
    // The ceiling, without which CRF alone has none. bufsize at 2x
    // maxrate mirrors `buildFfmpegArgs`.
    '-maxrate', `${args.maxBitrateKbps}k`,
    '-bufsize', `${args.maxBitrateKbps * 2}k`,
    '-an',
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
  --max-bitrate <kbps>  ceiling, default ${DEFAULT_MAX_BITRATE_KBPS} (what the catalog ships).
                        Without it CRF alone is uncapped and will emit
                        hundreds of Mbps on large frames.
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
