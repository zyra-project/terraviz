/**
 * Verifies that an 8-bit value survives the H.264 round trip intact —
 * the precondition for `docs/DATA_ENCODED_VIDEO_PLAN.md`, where luma
 * *is* the normalised data value rather than a picture of it.
 *
 * A colour-range mismatch is total failure rather than degradation: it
 * shifts every value by 16/255 ≈ 0.063, which is larger than the smoke
 * palette's entire `transparent_range` of 12/256 ≈ 0.047. So "no data"
 * stops being transparent everywhere at once.
 *
 * The check encodes a 0..255 luma ramp through this repo's exact ladder
 * settings, plays it in a browser, and samples it back through both
 * paths the design relies on:
 *
 *   - **render path** — video → WebGL texture → `readPixels`
 *   - **readout path** — the 1×1 `drawImage` the hover probe uses
 *
 * A variant passes only if the recovered value equals the source within
 * one 8-bit step *and* the fitted transform is the identity. Gain ≠ 1 or
 * offset ≠ 0 is the signature of a range mismatch.
 *
 * Usage:
 *   npx tsx scripts/luma-range-check            # encode + run headless
 *   npx tsx scripts/luma-range-check --serve    # serve for a real device
 *
 * `--serve` exists because Safari and iOS Safari cannot be driven from
 * CI here; it prints a LAN URL to open on the device under test.
 *
 * It also carries the Phase 0 probe of
 * `docs/DATA_ENCODED_RESOLUTION_PLAN.md`: the `H_ceiling_8k` variant is
 * the same encoder settings at 8192x4096, and the capability record it
 * produces per device — decodes / `readyState` / decoded size /
 * `MAX_TEXTURE_SIZE` / `texImage2D` / a known texel — is the matrix
 * that plan gates on. A failure there is a finding to write down, not a
 * regression: only `D_full_proper` sets the exit code.
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRAMES = join(HERE, '.frames')
const OUT = join(HERE, 'out')
const FRAME_COUNT = 12

/** The shipped data-encoded rung's width. The colour-range variants
 *  only need enough rows to sample a band centre, so they use a short
 *  frame — the question they answer is per-code, not per-pixel. */
const RANGE_W = 4096
const RANGE_H = 256

/** The rung Phase 0 of `docs/DATA_ENCODED_RESOLUTION_PLAN.md` is
 *  gating on: a full-size spherical frame, not a strip. The height
 *  matters here — a decoder that tops out at 4K, or a GL context whose
 *  `MAX_TEXTURE_SIZE` is 4096, fails on the frame's area rather than on
 *  its width alone. */
const CEIL_W = 8192
const CEIL_H = 4096

/**
 * Where the page should sample a given variant. Derived here and
 * published in `variants.json` so the encoder and the browser cannot
 * disagree about the frame's layout — the page used to hardcode
 * 4096x256 and would have silently sampled the wrong texels the moment
 * a second size existed.
 */
interface Geometry {
  width: number
  height: number
  /** Texels per ramp band — always `width / 256`. */
  bandWidth: number
  /** Row to sample the ramp at: the middle of the ramp region. */
  bandSampleY: number
  /** Spacing of the isolated spikes, or 0 for a variant with none. */
  spikeStep: number
  /** First row of the spike region; equals `height` when there is none. */
  spikeTop: number
}

function geometryFor(v: Variant): Geometry {
  const spikeStep = v.spikeStep ?? 0
  // A spike region takes the lower half; without one the ramp owns
  // the whole frame, which is what the 4096x256 variants have always
  // been.
  const spikeTop = spikeStep ? Math.floor(v.height / 2) : v.height
  return {
    width: v.width,
    height: v.height,
    bandWidth: v.width / 256,
    bandSampleY: Math.floor(spikeTop / 2),
    spikeStep,
    spikeTop,
  }
}

/**
 * What the page needs in order to sample a variant, built from the same
 * `geometryFor` the encoder uses. Served rather than hardcoded, and
 * built in one place rather than two, for the reason the `/variants.json`
 * handler already documents: a list that lives in the page goes stale
 * silently, and a second copy here would drift the same way.
 */
function variantManifest(): ReadonlyArray<Record<string, unknown>> {
  return VARIANTS.map(v => ({ name: v.name, note: v.note, ...geometryFor(v) }))
}

/**
 * The four encoder configurations worth distinguishing. `A_today` is
 * what `cli/lib/ffmpeg-hls.ts` emits right now; the rest are candidate
 * fixes. `B_tag_only` is included precisely because it is the obvious
 * fix and it does not work — `-color_range pc` retags the stream
 * without changing what swscale actually writes, which manufactures the
 * mismatch it was meant to prevent.
 */
interface Variant {
  name: string
  /** Filter chain. `{W}` / `{H}` expand to the variant's own size, so a
   *  scale filter cannot drift from the frame it is scaling. */
  vf?: string
  extra: string[]
  note: string
  width: number
  height: number
  /** Set to add the isolated-spike region — see `writeFrames`. */
  spikeStep?: number
  /** Replaces `LADDER`'s codec args. Appending `-c:v` to `extra` would
   *  also work, since ffmpeg takes the last occurrence — but a variant
   *  that silently encoded H.264 while labelled HEVC would manufacture a
   *  refusal on the platform this exists to interrogate, which is the
   *  worst result a probe can produce. Naming it here lets `encodeAll`
   *  verify the stream it actually got. */
  codec?: string[]
}

const VARIANTS: ReadonlyArray<Variant> = [
  { name: 'A_today', extra: [], note: "today's settings — no colour flags at all",
    width: RANGE_W, height: RANGE_H },
  {
    name: 'B_tag_only',
    extra: ['-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=pc'],
    note: 'retag only — the naive fix, expected to FAIL',
    width: RANGE_W, height: RANGE_H,
  },
  {
    name: 'C_limited', vf: 'scale=in_range=full:out_range=limited',
    extra: ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv'],
    note: 'consistent limited range — survives, but only 219 code levels',
    width: RANGE_W, height: RANGE_H,
  },
  {
    name: 'D_full_proper', vf: 'scale=in_range=full:out_range=full',
    extra: ['-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-color_trc', 'bt709', '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=pc'],
    note: 'conversion AND tag both full range — the recommended setting',
    width: RANGE_W, height: RANGE_H,
  },
  // E and F bisect a Firefox/Windows failure that D does not survive: the
  // WebGL render path came back with endpoints exact but midtones off by
  // up to 20 codes, while the 2D `drawImage` readout was 256/256 exact on
  // the same file. Endpoints pinned with a bow in between is a transfer
  // mismatch, not a range one — and B and D failed with *identical*
  // numbers despite differing only in the range conversion, which rules
  // the range flags out as the trigger. That leaves the bt709
  // transfer/primaries/matrix tags, which A (passing) does not carry.
  {
    name: 'E_range_only', vf: 'scale=in_range=full:out_range=full',
    extra: ['-color_range', 'pc', '-x264-params', 'range=pc'],
    note: 'full-range conversion + range tag, NO transfer/primaries/matrix tags',
    width: RANGE_W, height: RANGE_H,
  },
  {
    name: 'F_no_trc', vf: 'scale=in_range=full:out_range=full',
    extra: ['-color_range', 'pc', '-colorspace', 'bt709', '-color_primaries', 'bt709',
            '-x264-params', 'colorprim=bt709:colormatrix=bt709:range=pc'],
    note: 'everything D has except --color_trc — isolates the transfer tag',
    width: RANGE_W, height: RANGE_H,
  },
  // What `buildFfmpegArgs` emits for a data-encoded rendition after the
  // E/F results ruled the range tag out: a nearest-neighbour scale and
  // nothing else. A is the same settings without the scale filter, so
  // this exists to confirm the filter itself does not reintroduce a
  // range conversion.
  {
    name: 'G_neighbor_only', vf: 'scale={W}:{H}:flags=neighbor',
    extra: [],
    note: 'exactly what the encoder now emits — neighbor scale, no colour flags',
    width: RANGE_W, height: RANGE_H,
  },
  // Phase 0 of `docs/DATA_ENCODED_RESOLUTION_PLAN.md`. Same encoder
  // settings as G — this is deliberately not a new encoder question —
  // at the frame size the plan is gating on. What changes is the frame,
  // so what it answers is "does this device decode 8192x4096 and hand
  // it to WebGL intact", not "do these flags round-trip".
  //
  // The spike region is the reason this variant is not just G with a
  // bigger `-vf`. A 32-texel band survives a silent 2x downscale
  // unharmed, so a ramp alone would report PASS on a device that
  // quietly halved the frame and served averaged values — the exact
  // failure the plan calls out, and the same shape as the
  // classified-palette bug. Isolated single-texel spikes do not
  // survive it: measured here, they read 252 at native resolution and
  // 63 through a 2x box downscale.
  {
    name: 'H_ceiling_8k', vf: 'scale={W}:{H}:flags=neighbor',
    extra: [],
    note: 'Phase 0 — 8192x4096 at the shipped data-encoded settings',
    width: CEIL_W, height: CEIL_H, spikeStep: 64,
  },
  // Phase 0b of `docs/DATA_ENCODED_RESOLUTION_PLAN.md`. H's twin with one
  // variable changed, so a difference between the two rows is the codec
  // and nothing else.
  //
  // Two devices converged on this exact question. iOS Safari refuses H at
  // 8192x4096 H.264 and accepts 7200x3600 HEVC — codec and resolution both
  // moved, so what it does at 8192 wide in HEVC is unknown, and Phase 2
  // exists or does not exist depending on the answer. The Quest decodes
  // 7200x3600 HEVC comfortably but has `MAX_TEXTURE_SIZE` of exactly 8192,
  // so this row asks it two things at once: whether the decoder takes the
  // frame, and whether a texture at precisely the limit allocates.
  //
  // `-tag:v hvc1` for the same reason `encode-geotiff-sequence` sets it:
  // ffmpeg's default `hev1` sample entry is refused by Safari and
  // QuickTime, which would fabricate exactly the refusal being tested.
  {
    name: 'I_ceiling_8k_hevc', vf: 'scale={W}:{H}:flags=neighbor',
    codec: ['-c:v', 'libx265', '-profile:v', 'main', '-tag:v', 'hvc1'],
    extra: [],
    note: 'Phase 0b — H with HEVC instead of H.264, the only variable',
    width: CEIL_W, height: CEIL_H, spikeStep: 64,
  },
]

// --- PNG writing (grayscale, colour type 0) ------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

function grayPng(w: number, h: number, pixels: Buffer): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // colour type 0 = grayscale
  const raw = Buffer.alloc((w + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0 // filter type: none, so the bytes stay verbatim
    pixels.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Frame directory for one geometry. Sized, so two variants at
 *  different resolutions cannot read each other's frames. */
function frameDir(g: Geometry): string {
  return join(FRAMES, `${g.width}x${g.height}${g.spikeStep ? `s${g.spikeStep}` : ''}`)
}

/**
 * 256 flat bands, one per code value — flat so that neither chroma
 * subsampling nor DCT ringing contaminates the sample at a band centre.
 *
 * Where the geometry asks for one, the lower half additionally carries
 * isolated single-texel spikes of 255 on a 0 background, `spikeStep`
 * apart in both axes. They are the native-resolution detector: any
 * resample averages a spike with its neighbours and collapses its
 * amplitude, while the bands above are far too wide to notice. The
 * spacing is wide enough that each spike sits on its own flat
 * background, which is what keeps DCT ringing off the sample.
 */
function writeFrames(g: Geometry): void {
  const dir = frameDir(g)
  mkdirSync(dir, { recursive: true })
  const row = Buffer.alloc(g.width)
  for (let v = 0; v < 256; v++) row.fill(v, v * g.bandWidth, (v + 1) * g.bandWidth)
  const px = Buffer.alloc(g.width * g.height)
  for (let y = 0; y < g.spikeTop; y++) row.copy(px, y * g.width)
  if (g.spikeStep) {
    const half = g.spikeStep / 2
    for (let y = g.spikeTop + half; y < g.height; y += g.spikeStep) {
      for (let x = half; x < g.width; x += g.spikeStep) px[y * g.width + x] = 255
    }
  }
  const png = grayPng(g.width, g.height, px)
  for (let f = 1; f <= FRAME_COUNT; f++) {
    writeFileSync(join(dir, `f${String(f).padStart(4, '0')}.png`), png)
  }
}

// --- encoding ------------------------------------------------------------

function ffmpegBin(): string {
  return process.env.FFMPEG_BIN ?? 'ffmpeg'
}

function ffprobeBin(): string {
  return process.env.FFPROBE_BIN ?? 'ffprobe'
}

/**
 * Check the external binaries before generating a single frame.
 *
 * `ffprobe` is only needed by variants that name a codec, and it is
 * invoked *after* that variant encodes — which on `I_ceiling_8k_hevc`
 * means after an 8192x4096 x265 encode and every variant before it. A
 * missing ffprobe would therefore discard minutes of work and a rerun
 * would redo all of it. This is the same failure `requireTools` exists
 * to prevent in `scripts/encode-geotiff-sequence.ts`, reintroduced here
 * by the commit that added the codec check; found in review.
 */
function requireProbeTools(): void {
  const needed: string[] = [ffmpegBin()]
  if (VARIANTS.some(v => v.codec)) needed.push(ffprobeBin())
  const missing = needed.filter(bin => {
    const r = spawnSync(bin, ['-version'], { encoding: 'utf8' })
    return Boolean(r.error) || r.status !== 0
  })
  if (missing.length) {
    throw new Error(
      `not on PATH, or present but not runnable: ${missing.join(', ')}\n`
      + `  ffprobe is required because a variant names its own codec, and the\n`
      + `  encode is verified against the stream it actually produced. Override\n`
      + `  the binary names with FFMPEG_BIN / FFPROBE_BIN if they differ here.`)
  }
}

/** Ladder settings copied from `buildFfmpegArgs` in `cli/lib/ffmpeg-hls.ts`,
 *  split so a variant can replace the codec without disturbing anything
 *  else about the encode. */
const LADDER_CODEC = ['-c:v', 'libx264', '-profile:v', 'main']
const LADDER_REST = ['-pix_fmt', 'yuv420p', '-preset', 'slow', '-crf', '18', '-an']

/** ffmpeg's encoder name -> the codec name ffprobe reports for it. Used
 *  to check that the file on disk is the codec the variant asked for. */
const ENCODER_STREAM_NAME: Record<string, string> = {
  libx264: 'h264',
  libx265: 'hevc',
}

/** Read back the encoded stream's codec. A variant naming a codec is
 *  making a claim about the file, and an unverified claim about a probe
 *  input is how a false negative gets recorded as a device limitation. */
function encodedCodec(file: string): string | undefined {
  const r = spawnSync(
    ffprobeBin(),
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
     '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' })
  if (r.error || r.status !== 0) return undefined
  return (r.stdout ?? '').trim() || undefined
}

/** One frame set per distinct geometry, not per variant — the seven
 *  colour-range variants all share the same 4096x256 frames, and
 *  re-rendering them per variant would dominate the run. */
function writeAllFrames(): void {
  const seen = new Set<string>()
  for (const v of VARIANTS) {
    const g = geometryFor(v)
    const dir = frameDir(g)
    if (seen.has(dir)) continue
    seen.add(dir)
    writeFrames(g)
    process.stdout.write(`  frames ${g.width}x${g.height}\n`)
  }
}

function encodeAll(): void {
  mkdirSync(OUT, { recursive: true })
  for (const v of VARIANTS) {
    const g = geometryFor(v)
    const args = ['-y', '-framerate', '30', '-i', join(frameDir(g), 'f%04d.png')]
    // `{W}`/`{H}` rather than a literal size: a scale filter that
    // disagreed with its own frame would silently resample the thing
    // this check exists to measure.
    if (v.vf) {
      args.push('-vf', v.vf.replaceAll('{W}', String(g.width)).replaceAll('{H}', String(g.height)))
    }
    const codecArgs = v.codec ?? LADDER_CODEC
    args.push(...codecArgs, ...LADDER_REST, ...v.extra, join(OUT, `${v.name}.mp4`))
    const r = spawnSync(ffmpegBin(), args, { encoding: 'utf8' })
    if (r.status !== 0) {
      throw new Error(`ffmpeg failed for ${v.name}:\n${r.stderr?.slice(-2000) ?? r.error}`)
    }
    // Only checked when the variant named a codec, so the seven original
    // rows never acquire an ffprobe dependency they did not have.
    let codecNote = ''
    if (v.codec) {
      const encoder = codecArgs[codecArgs.indexOf('-c:v') + 1] ?? ''
      // `hasOwn` for the same reason `parseArgs` uses it in
      // `encode-geotiff-sequence.ts`: a plain lookup inherits
      // `Object.prototype`, so an encoder named `toString` would
      // resolve to a truthy function, clear the guard below, and then
      // fail the comparison with a message about codecs.
      const want = Object.hasOwn(ENCODER_STREAM_NAME, encoder)
        ? ENCODER_STREAM_NAME[encoder]
        : undefined
      if (!want) {
        throw new Error(
          `${v.name} names encoder "${encoder}", which is not in ENCODER_STREAM_NAME.\n` +
          `  Add it there rather than skipping the check — an unverified codec is the\n` +
          `  one thing this field exists to prevent.`)
      }
      const got = encodedCodec(join(OUT, `${v.name}.mp4`))
      if (got === undefined) {
        throw new Error(
          `${v.name} asked for a specific codec but ffprobe could not read the result.\n` +
          `  This variant's whole purpose is the codec, so an unverified file is not usable.\n` +
          `  Set FFPROBE_BIN if ffprobe is installed under another name.`)
      }
      if (got !== want) {
        throw new Error(
          `${v.name} encoded as ${got}, not ${want}.\n` +
          `  A probe input mislabelled by codec would record a device limitation that\n` +
          `  is really an encoder one. Check that this ffmpeg has the encoder:\n` +
          `    ffmpeg -hide_banner -encoders | grep ${encoder}`)
      }
      codecNote = `${got}  `
    }
    const kib = statSync(join(OUT, `${v.name}.mp4`)).size / 1024
    process.stdout.write(
      `  encoded ${v.name.padEnd(18)}${`${g.width}x${g.height}`.padEnd(11)}` +
      `${kib.toFixed(0).padStart(6)} KiB  ${codecNote}${v.note}\n`)
  }
}

// --- serving -------------------------------------------------------------

const MIME: Record<string, string> = { '.html': 'text/html', '.mp4': 'video/mp4' }

function serve(port: number): Promise<{ port: number; close: () => void }> {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0])
    // The variant list has to come from VARIANTS, not from the page. It
    // used to be hardcoded in page.html's click handler, so every
    // browser reached through --serve silently tested a stale subset
    // while the Playwright path (which passes the list explicitly)
    // tested all of them — the two paths disagreed about what "the
    // check" even was, and adding a variant here did nothing on a real
    // device.
    if (rel === '/variants.json') {
      const body = Buffer.from(JSON.stringify(variantManifest()))
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      return res.end(body)
    }
    const p = join(HERE, rel === '/' ? 'page.html' : rel)
    if (!p.startsWith(HERE) || !existsSync(p)) {
      // Say what *is* there. A bare "not found" sends the tester back to
      // the machine to run `ls`, and on a headset that is a real
      // errand — while the same 404 reaches `<video>` as MediaError 4,
      // indistinguishable from a decoder refusing the stream. Listing
      // the directory turns "did I mistype it, or can this device not
      // decode it?" into something the response answers on its own.
      const dir = dirname(p)
      let hint = ''
      if (dir.startsWith(HERE) && existsSync(dir)) {
        const names = readdirSync(dir).sort()
        hint = names.length
          ? `\n\nfiles in ${dir.slice(HERE.length) || '/'}:\n  ${names.join('\n  ')}`
          : `\n\n${dir.slice(HERE.length) || '/'} is empty`
      } else {
        hint = `\n\nno such directory: ${dir.slice(HERE.length) || '/'}`
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      return res.end(`not found: ${rel}\nserving from: ${HERE}${hint}\n`)
    }
    const body = readFileSync(p)
    res.writeHead(200, {
      'Content-Type': MIME[extname(p)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
    })
    res.end(body)
  })
  return new Promise(resolve => {
    server.listen(port, '0.0.0.0', () =>
      resolve({ port: (server.address() as { port: number }).port, close: () => server.close() }))
  })
}

function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) if (ni.family === 'IPv4' && !ni.internal) return ni.address
  }
  return 'localhost'
}

/**
 * Write the check as a static bundle for the Pages deploy to serve.
 *
 * `--serve` binds the LAN, which is the wrong shape for iOS Safari when
 * the phone and the dev box are not on a reachable network — a common
 * case, and the one browser most likely to differ, since HLS goes
 * through the native player there rather than MSE. Emitting into
 * `public/` puts the same page on every preview deploy, so verifying a
 * new browser is a URL rather than a network setup.
 *
 * The page fetches `./variants.json` and `./out/<name>.mp4`, both
 * relative, so this layout works unchanged behind a static host.
 */
function emitStatic(dest: string): void {
  mkdirSync(join(dest, 'out'), { recursive: true })
  writeFileSync(join(dest, 'page.html'), readFileSync(join(HERE, 'page.html')))
  // The playback check ships beside the luma check but takes its clip
  // from `?clip=`, so it carries no asset of its own and costs the
  // deploy nothing.
  writeFileSync(join(dest, 'play.html'), readFileSync(join(HERE, 'play.html')))
  writeFileSync(
    join(dest, 'variants.json'),
    JSON.stringify(variantManifest(), null, 2) + '\n')
  for (const v of VARIANTS) {
    writeFileSync(join(dest, 'out', `${v.name}.mp4`),
      readFileSync(join(OUT, `${v.name}.mp4`)))
  }
}

// --- main ----------------------------------------------------------------

interface Row {
  name: string
  path?: string
  error?: string
  exact?: number
  mae?: number
  maxAbs?: number
  gain?: number
  offset?: number
  v0?: number
  v255?: number
  pass?: boolean
  glRenderer?: string
}

/**
 * The Phase 0 record for one variant: the four things
 * `docs/DATA_ENCODED_RESOLUTION_PLAN.md` asks to be written down per
 * device, plus the two limits that decide the answer before any value
 * is sampled.
 *
 * `maxTextureSize` is not in the plan's list and should be. A context
 * whose limit is 4096 cannot hold an 8192-wide frame at all, so it
 * settles the question without decoding anything — and it is a real
 * ceiling on mobile, not a theoretical one.
 *
 * `spikeMean` is how a *silent* failure gets caught. See the
 * `H_ceiling_8k` variant note: a downscale that would leave the ramp
 * bands untouched collapses these spikes, so a decoded-but-resampled
 * frame reads native=false rather than passing quietly.
 */
interface Cap {
  name: string
  expectedWidth: number
  expectedHeight: number
  decoded?: boolean
  readyState?: number
  videoWidth?: number
  videoHeight?: number
  maxTextureSize?: number
  texUpload?: string
  spikeMean?: number
  spikeNative?: boolean
  error?: string
}

interface CheckResult {
  rows: Row[]
  caps: Cap[]
}

async function main(): Promise<void> {
  const serveOnly = process.argv.includes('--serve')
  const emitStaticTo = process.argv.includes('--emit-static')
    ? join(HERE, '..', '..', 'public', 'luma-check')
    : null

  requireProbeTools()

  process.stdout.write('Generating ramp frames…\n')
  writeAllFrames()
  process.stdout.write('Encoding variants…\n')
  encodeAll()

  if (emitStaticTo) {
    emitStatic(emitStaticTo)
    process.stdout.write(
      `\nWrote ${VARIANTS.length} variants to public/luma-check/.\n` +
      `Commit them and the Pages deploy serves the check at\n\n` +
      `    <deploy-url>/luma-check/page.html\n\n` +
      `Re-run this whenever VARIANTS changes.\n`)
    return
  }

  const { port, close } = await serve(serveOnly ? 8791 : 0)
  const names = VARIANTS.map(v => v.name)

  if (serveOnly) {
    process.stdout.write(
      `\nOpen this on the device under test:\n\n` +
      `    http://${lanAddress()}:${port}/page.html\n\n` +
      `Press "Run check". Every colour-range row must read PASS.\n` +
      `H_ceiling_8k is the Phase 0 probe — record its capability row per\n` +
      `device (desktop Chrome / Firefox / Safari, iOS Safari, a mid-range\n` +
      `Android, Quest browser) rather than treating a failure as a bug.\n` +
      `"Copy results" puts the whole record on the clipboard.\nCtrl-C to stop.\n`)
    return
  }

  const { chromium, firefox, webkit } = await import('playwright')
  const engine = process.env.LUMA_BROWSER ?? 'chromium'
  const launcher = engine === 'firefox' ? firefox : engine === 'webkit' ? webkit : chromium
  // Playwright's bundled Chromium is the open-source build and has NO
  // proprietary codecs — it reports `canPlayType` empty for every H.264
  // profile. Point LUMA_BROWSER_PATH at a real Chrome/Edge to test H.264.
  const executablePath = process.env.LUMA_BROWSER_PATH
  const browser = await launcher.launch({
    ...(executablePath ? { executablePath } : {}),
    args: engine === 'chromium'
      ? ['--no-sandbox', '--autoplay-policy=no-user-gesture-required',
         '--enable-unsafe-swiftshader', '--use-angle=swiftshader']
      : [],
  })
  const page = await browser.newPage()
  await page.goto(`http://127.0.0.1:${port}/page.html`)
  const { rows, caps } = (await page.evaluate(
    n => (window as unknown as { runCheck: (v: string[]) => Promise<CheckResult> }).runCheck(n),
    names,
  )) as CheckResult
  await browser.close()
  close()

  // Phase 0 first. On a device that cannot decode the frame at all the
  // value table below is empty, and this is the entire result — so it
  // has to be the thing that prints, not a footnote under a blank table.
  process.stdout.write(
    `\n${'variant'.padEnd(16)}${'decoded'.padEnd(9)}${'ready'.padEnd(7)}` +
    `${'size'.padEnd(13)}${'maxTex'.padEnd(8)}${'upload'.padEnd(9)}` +
    `${'spike'.padEnd(7)}native\n`)
  for (const c of caps) {
    if (c.error) {
      process.stdout.write(`${c.name.padEnd(16)}ERROR: ${c.error}\n`)
      continue
    }
    const size = `${c.videoWidth}x${c.videoHeight}`
    const sizeOk = c.videoWidth === c.expectedWidth && c.videoHeight === c.expectedHeight
    const texOk = (c.maxTextureSize ?? 0) >= c.expectedWidth
    process.stdout.write(
      `${c.name.padEnd(16)}${(c.decoded ? 'yes' : 'NO').padEnd(9)}` +
      `${String(c.readyState ?? '-').padEnd(7)}` +
      `${(sizeOk ? size : `${size}!`).padEnd(13)}` +
      `${(texOk ? String(c.maxTextureSize) : `${c.maxTextureSize}!`).padEnd(8)}` +
      `${(c.texUpload ?? '-').padEnd(9)}` +
      `${(c.spikeMean === undefined ? '—' : c.spikeMean.toFixed(0)).padEnd(7)}` +
      `${c.spikeNative === undefined ? '—' : c.spikeNative ? 'yes' : 'NO'}\n`)
  }
  process.stdout.write(
    `  ( ! = below what the variant needs; native=NO means the frame ` +
    `decoded but was resampled )\n`)

  process.stdout.write(
    `\n${'variant'.padEnd(15)}${'path'.padEnd(9)}${'exact'.padEnd(9)}` +
    `${'MAE'.padEnd(8)}${'max|e|'.padEnd(8)}${'gain'.padEnd(9)}${'offset'.padEnd(9)}0→   255→\n`)
  let failed = false
  for (const r of rows) {
    if (r.error) {
      process.stdout.write(`${r.name.padEnd(15)}${(r.path ?? '').padEnd(9)}ERROR: ${r.error}\n`)
      failed = true
      continue
    }
    const verdict = r.pass ? 'PASS' : 'FAIL'
    process.stdout.write(
      `${r.name.padEnd(15)}${(r.path ?? '').padEnd(9)}${`${r.exact}/256`.padEnd(9)}` +
      `${r.mae!.toFixed(3).padEnd(8)}${String(r.maxAbs).padEnd(8)}` +
      `${r.gain!.toFixed(4).padEnd(9)}${r.offset!.toFixed(2).padEnd(9)}` +
      `${String(r.v0).padEnd(5)}${String(r.v255).padEnd(6)}${verdict}\n`)
    // Only the recommended setting is required to pass; B_tag_only is
    // expected to fail and its failure is the point of including it.
    if (r.name === 'D_full_proper' && !r.pass) failed = true
  }
  if (rows.length) process.stdout.write(`\nGL: ${rows.find(r => r.glRenderer)?.glRenderer ?? 'n/a'}\n`)
  if (failed) {
    process.stdout.write('\nFAILED — the recommended encoder setting did not round-trip.\n')
    process.exitCode = 1
  } else {
    process.stdout.write('\nOK — luma survives the round trip under D_full_proper.\n')
  }
}

main().catch(err => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
})
