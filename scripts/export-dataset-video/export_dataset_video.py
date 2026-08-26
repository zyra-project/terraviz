#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 The Zyra Project

"""Export a data-encoded catalog dataset as a standalone colour MP4 + SOS sidecars.

A dataset published with `renderEncoding: "data-luma"` ships frames whose luma
*is* the normalised value; the colour lives in the row's `colorScale` sidecar
and is applied by the globe shaders at draw time (see
`docs/DATA_ENCODED_VIDEO_PLAN.md`). Downloading the published asset therefore
gets you a greyscale field, which is useless outside the app.

This applies that same palette offline and writes a self-contained bundle:

    <slug>.mp4      colourised, no text burned in
    sidecar.json    frame -> valid time, bbox + pixel->lat/lon, colour scale
    labels.txt      one human-readable date per *movie frame* (SOS label file)
    legend.png      the dataset's published legend
    thumbnail.png   the dataset's published thumbnail

H.264 has no alpha plane, so the palette's transparency has to resolve against
something; frames are composited over the same equirectangular basemap the globe
uses, cropped to the dataset's bounding box so the two are in register. Pass
`--no-basemap` for flat black instead.

Colour handling mirrors `src/types/color-scale.ts` exactly — `build_color_scale_lut`
below is a line-for-line port of `buildColorScaleLut`. If that file changes, change
this too.

Why Python, in a repo whose scripts/ is TypeScript: this needs frame-accurate
H.264 decode. Shelling out to the ffmpeg CLI is not dependable here (a static
ffmpeg segfaults decoding 4096x2048 H.264 in the CI-style container this was
built in), whereas PyAV's libav bindings decode it fine. ffmpeg is still used for
*encoding*, which works.

Dependencies:  pip install av pillow numpy requests imageio-ffmpeg
Usage:         python3 export_dataset_video.py --dataset north-america-smoke
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import time
import subprocess
import sys
from urllib.parse import urljoin

import av
import numpy as np
import requests
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

DEFAULT_NODE = 'https://terraviz.zyra-project.org'
DEFAULT_ASSET_BASE = 'https://d3sik7mbbzunjo.cloudfront.net/terraviz/basemaps'
RENDER_ENCODING_DATA_LUMA = 'data-luma'
COLOR_SCALE_LUT_SIZE = 256
GLOBAL_BBOX = {'n': 90.0, 's': -90.0, 'w': -180.0, 'e': 180.0}


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------
# Colour scale — port of src/types/color-scale.ts
# --------------------------------------------------------------------------

def js_round(x: float) -> int:
    """Match JavaScript Math.round: ties round toward +Infinity.

    Python's built-in round() is banker's rounding (ties-to-even), so at an
    exact x.5 interpolated channel it would diverge from the TypeScript this
    ports. Every value fed here is non-negative (rgba 0-255 interpolated by a
    fraction in [0,1]), for which Math.round(x) == floor(x + 0.5). Keeping the
    LUT bit-identical to the shader's is the whole point of the port.
    """
    return math.floor(x + 0.5)


def build_color_scale_lut(scale: dict) -> np.ndarray:
    """Expand a ColorScale into the 256-entry RGBA LUT the shaders sample.

    Linear interpolation between adjacent stops in straight (non-premultiplied)
    8-bit space, which is what the shader's mix(base, palette, alpha) expects.
    """
    stops = sorted(scale['stops'], key=lambda s: s['t'])
    if len(stops) < 2:
        raise ValueError('colorScale needs at least two stops')
    lut = np.zeros((COLOR_SCALE_LUT_SIZE, 4), dtype=np.uint8)
    cutoff = scale.get('transparentRange') or 0.0
    si = 0
    for i in range(COLOR_SCALE_LUT_SIZE):
        t = i / (COLOR_SCALE_LUT_SIZE - 1)
        while si < len(stops) - 2 and stops[si + 1]['t'] < t:
            si += 1
        a = stops[si]
        b = stops[si + 1] if si + 1 < len(stops) else a
        span = b['t'] - a['t']
        f = min(1.0, max(0.0, (t - a['t']) / span)) if span > 0 else 0.0
        for c in range(4):
            lut[i, c] = js_round(a['rgba'][c] + (b['rgba'][c] - a['rgba'][c]) * f)
        # Below transparentRange nothing was measured; force alpha to 0 rather
        # than trusting the palette's own low end.
        if t < cutoff:
            lut[i, 3] = 0
    return lut


def luma_to_value(luma: float, scale: dict) -> float:
    return scale['vmin'] + (luma / 255.0) * (scale['vmax'] - scale['vmin'])


# --------------------------------------------------------------------------
# Catalog + asset fetch
# --------------------------------------------------------------------------

def http_get(url: str, timeout: int = 120, attempts: int = 4,
             stream: bool = False) -> requests.Response:
    """GET with retry. The CDN resets large transfers often enough that a
    single-shot fetch makes re-running this a coin flip.

    `stream=True` returns before the body is read, so the caller must consume
    (and close) the response — `download_to` does. JSON/text callers leave it
    False and get the whole body buffered, which is what `.json()`/`.text` want.
    """
    delay = 2.0
    last = None
    for i in range(attempts):
        try:
            r = requests.get(url, timeout=timeout, stream=stream)
            r.raise_for_status()
            return r
        except (requests.ConnectionError, requests.Timeout,
                requests.HTTPError, requests.ChunkedEncodingError) as exc:
            # A 4xx will not fix itself; anything else might.
            status = getattr(getattr(exc, 'response', None), 'status_code', None)
            if status is not None and 400 <= status < 500:
                raise
            last = exc
            if i < attempts - 1:
                log('  retry %d/%d after %s' % (i + 1, attempts - 1, type(exc).__name__))
                time.sleep(delay)
                delay *= 2
    raise SystemExit('giving up on %s: %s' % (url, last))


def download_to(url: str, dest: str, timeout: int = 300) -> None:
    """Stream a URL to a temp file and rename on success.

    Streamed in chunks rather than buffering the whole body: the .ts segments
    and 8K basemap textures are multi-megabyte, and there is no reason to hold
    a full copy in memory. Writing straight to `dest` would also leave a
    truncated or zero-byte file behind when a transfer dies, and the next run
    would treat that corpse as a valid cache entry — renaming only after a
    complete read makes the cache all-or-nothing.
    """
    tmp = dest + '.part'
    r = http_get(url, timeout=timeout, stream=True)
    try:
        with open(tmp, 'wb') as fh:
            for chunk in r.iter_content(chunk_size=1 << 16):
                if chunk:
                    fh.write(chunk)
    finally:
        r.close()
    os.replace(tmp, dest)


def is_cached(path: str) -> bool:
    return os.path.exists(path) and os.path.getsize(path) > 0


def resolve_dataset(node: str, ref: str) -> dict:
    """Find a dataset row by ULID id or slug."""
    cat = http_get(f'{node}/api/v1/catalog').json()
    for d in cat.get('datasets', []):
        if d.get('id') == ref or d.get('slug') == ref:
            return d
    # Only advertise datasets this script can actually export: data-luma with a
    # colorScale. A row with some other renderEncoding, or none, would just fail
    # the checks in main(), so listing it here would be misleading.
    slugs = [d.get('slug') for d in cat.get('datasets', [])
             if d.get('renderEncoding') == RENDER_ENCODING_DATA_LUMA and d.get('colorScale')]
    listing = '\n  '.join(s for s in slugs if s) or '(none on this node)'
    raise SystemExit(
        'dataset %r not found on %s.\nExportable data-encoded datasets:\n  %s'
        % (ref, node, listing))


PERIOD_RE = re.compile(
    r'^P(?:(?P<days>\d+)D)?(?:T(?:(?P<hours>\d+)H)?(?:(?P<mins>\d+)M)?(?:(?P<secs>\d+)S)?)?$')


def parse_period(period: str) -> dt.timedelta:
    """Parse the ISO-8601 durations the catalog uses (PT1H, PT3H, PT6H, P1D...)."""
    m = PERIOD_RE.match(period or '')
    if not m or not any(m.groupdict().values()):
        raise SystemExit('unsupported period %r' % period)
    g = {k: int(v) if v else 0 for k, v in m.groupdict().items()}
    return dt.timedelta(days=g['days'], hours=g['hours'],
                        minutes=g['mins'], seconds=g['secs'])


def parse_time(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def fetch_segments(node: str, row: dict, work: str) -> list[str]:
    """Follow the manifest -> HLS playlists and download every segment locally.

    The segments are fetched with requests rather than handing the .m3u8 to
    ffmpeg because ffmpeg's TLS path is not reliable behind an egress proxy;
    downloading first also makes re-runs cheap.
    """
    link = row['dataLink']
    manifest_url = link if link.startswith('http') else urljoin(node, link)
    manifest = http_get(manifest_url).json()
    hls = manifest.get('hls')
    if not hls:
        raise SystemExit('dataset has no HLS rendition: %s' % json.dumps(manifest)[:300])

    master = http_get(hls).text
    variant = None
    for line in master.splitlines():
        line = line.strip()
        if line and not line.startswith('#'):
            variant = urljoin(hls, line)
            break
    if variant is None:
        raise SystemExit('no variant stream in master playlist')

    media = http_get(variant).text
    seg_urls = [urljoin(variant, ln.strip())
                for ln in media.splitlines()
                if ln.strip() and not ln.startswith('#')]
    if not seg_urls:
        raise SystemExit('no segments in media playlist')

    os.makedirs(work, exist_ok=True)
    paths = []
    for i, u in enumerate(seg_urls):
        p = os.path.join(work, 'seg_%03d.ts' % i)
        if not is_cached(p):
            download_to(u, p)
        paths.append(p)
    log('  %d segments (%.1f MB)'
        % (len(paths), sum(os.path.getsize(p) for p in paths) / 1e6))
    return paths


def fetch_asset(url: str | None, dest: str, what: str) -> bool:
    if not url:
        log('  no %s published for this dataset' % what)
        return False
    try:
        download_to(url, dest)
    except (requests.HTTPError, SystemExit) as exc:
        # A missing legend should not throw away a finished video.
        log('  %s fetch failed (%s)' % (what, exc))
        return False
    log('  %s -> %s (%d bytes)' % (what, os.path.basename(dest), os.path.getsize(dest)))
    return True


# --------------------------------------------------------------------------
# Source frames
# --------------------------------------------------------------------------

def iter_all_frames(paths: list[str]):
    for p in paths:
        c = av.open(p)
        for f in c.decode(video=0):
            yield f.to_ndarray(format='gray')
        c.close()


def count_frames(paths: list[str]) -> int:
    return sum(1 for _ in iter_all_frames(paths))


def verify_hold_model(paths: list[str], total: int, n_data: int) -> None:
    """Check the encode really holds each data frame for total/n_data frames.

    The publish pipeline runs the data rate below the video frame rate, so each
    forecast step repeats. Sampling the middle of each hold is only correct if
    the holds are uniform, so confirm the largest (n_data - 1) inter-frame
    changes land where the uniform model predicts. Warn rather than abort: a
    dataset encoded 1:1 (total == n_data) has no holds and needs no check.
    """
    if total == n_data:
        log('  1:1 encode, no hold structure to verify')
        return
    prev = None
    diffs = []
    for a in iter_all_frames(paths):
        cur = a.astype(np.int16)
        if prev is not None:
            diffs.append(float(np.abs(cur - prev).mean()))
        prev = cur
    d = np.array(diffs)
    step = total / n_data
    predicted = [int(round(k * step)) for k in range(1, n_data)]
    observed = sorted(int(i) + 1 for i in np.argsort(d)[::-1][:n_data - 1])
    within1 = sum(1 for p, o in zip(predicted, observed) if abs(p - o) <= 1)
    ranked = np.sort(d)[::-1]
    smallest_tr, largest_noise = float(ranked[n_data - 2]), float(ranked[n_data - 1])
    log('  hold model: %d/%d transitions within 1 frame; '
        'smallest transition %.4f vs largest non-transition %.4f'
        % (within1, len(predicted), smallest_tr, largest_noise))
    if within1 < len(predicted):
        log('  WARNING: hold structure is not uniform; frame timing may be off')


def sample_indices(total: int, n_data: int) -> list[int]:
    """Middle of each hold — maximally far from boundary jitter."""
    step = total / n_data
    return [min(total - 1, int((k + 0.5) * step)) for k in range(n_data)]


def iter_sampled(paths: list[str], indices: list[int]):
    wanted = {int(v): k for k, v in enumerate(indices)}
    i = 0
    for a in iter_all_frames(paths):
        if i in wanted:
            yield wanted[i], a
        i += 1


# --------------------------------------------------------------------------
# Backdrop
# --------------------------------------------------------------------------

def crop_bbox(img: Image.Image, bbox: dict, out_w: int, out_h: int) -> Image.Image:
    W, H = img.size
    return img.resize((out_w, out_h), Image.LANCZOS, box=(
        (bbox['w'] + 180.0) / 360.0 * W,
        (90.0 - bbox['n']) / 180.0 * H,
        (bbox['e'] + 180.0) / 360.0 * W,
        (90.0 - bbox['s']) / 180.0 * H,
    ))


def cached(asset_base: str, name: str, cache_dir: str) -> str:
    os.makedirs(cache_dir, exist_ok=True)
    p = os.path.join(cache_dir, name)
    if not is_cached(p):
        log('  fetching basemap asset %s' % name)
        download_to(f'{asset_base}/{name}', p)
    return p


def build_background(bbox, w, h, asset_base, cache_dir, dim, borders=True):
    """Dimmed Blue-Marble land with coastlines/borders over it.

    Dimmed because the low end of a typical palette is pale and low-alpha; over
    full-brightness terrain a thin plume is invisible. Borders are drawn light
    grey rather than black so they read as reference lines, not as data.
    """
    base = crop_bbox(Image.open(cached(asset_base, 'earth_diffuse_8192.jpg', cache_dir))
                     .convert('RGB'), bbox, w, h)
    base = Image.blend(Image.new('RGB', base.size, (0, 0, 0)), base, dim)
    if borders:
        bd = crop_bbox(Image.open(cached(asset_base, 'country-borders-black-8192.png',
                                         cache_dir)).convert('RGBA'), bbox, w, h)
        alpha = bd.split()[3].point(lambda v: int(v * 0.5))
        base.paste(Image.new('RGB', base.size, (150, 163, 178)), (0, 0), alpha)
    return base


# --------------------------------------------------------------------------
# Encode
# --------------------------------------------------------------------------

def ffmpeg_path(explicit: str | None) -> str:
    if explicit:
        return explicit
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return 'ffmpeg'


def probe_frame_count(path: str) -> int:
    c = av.open(path)
    n = sum(1 for _ in c.decode(video=0))
    c.close()
    return n


def write_labels(path: str, starts: list[dt.datetime], repeat: int, fmt: str) -> list[str]:
    lines = []
    for valid in starts:
        lines.extend([valid.strftime(fmt)] * repeat)
    with open(path, 'w') as fh:
        fh.write('\n'.join(lines) + '\n')
    return lines


# --------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser(
        description='Export a data-encoded dataset as a colour MP4 + SOS sidecars.')
    ap.add_argument('--dataset', required=True, help='catalog slug or ULID id')
    ap.add_argument('--node', default=DEFAULT_NODE)
    ap.add_argument('--out-dir', default='export-out')
    ap.add_argument('--work-dir', default=None, help='segment/basemap cache (default <out-dir>/.cache)')
    ap.add_argument('--asset-base', default=DEFAULT_ASSET_BASE)
    ap.add_argument('--width', type=int, default=None, help='default: source width')
    ap.add_argument('--height', type=int, default=None)
    ap.add_argument('--fps-in', type=float, default=8.0, help='forecast steps per second')
    ap.add_argument('--fps-out', type=float, default=24.0, help='container frame rate')
    ap.add_argument('--crf', type=int, default=18)
    ap.add_argument('--preset', default='slow')
    ap.add_argument('--dim', type=float, default=0.55, help='basemap brightness 0-1')
    ap.add_argument('--no-basemap', action='store_true', help='composite over flat black')
    ap.add_argument('--no-borders', action='store_true')
    ap.add_argument('--label-format', default='%a %b %d, %Y  %H:%M UTC')
    ap.add_argument('--ffmpeg', default=None)
    args = ap.parse_args()

    repeat_f = args.fps_out / args.fps_in
    if abs(repeat_f - round(repeat_f)) > 1e-9:
        raise SystemExit('--fps-out must be an integer multiple of --fps-in '
                         '(got %g / %g); otherwise labels cannot map 1:1 to frames'
                         % (args.fps_out, args.fps_in))
    repeat = int(round(repeat_f))

    out_dir = args.out_dir
    work = args.work_dir or os.path.join(out_dir, '.cache')
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(work, exist_ok=True)

    log('resolving %s on %s' % (args.dataset, args.node))
    row = resolve_dataset(args.node, args.dataset)
    slug = row.get('slug') or row['id']
    log('  %s  (%s)' % (row.get('title'), row['id']))

    if row.get('renderEncoding') != RENDER_ENCODING_DATA_LUMA:
        raise SystemExit(
            'dataset renderEncoding is %r, not %r — it is already a picture, so '
            'download the published asset directly; there is no palette to apply.'
            % (row.get('renderEncoding'), RENDER_ENCODING_DATA_LUMA))
    scale = row.get('colorScale')
    if not scale:
        raise SystemExit('dataset is data-luma but carries no colorScale sidecar')

    bbox = row.get('boundingBox') or GLOBAL_BBOX
    start = parse_time(row['startTime'])
    end = parse_time(row['endTime'])
    period = parse_period(row.get('period'))
    n_data = int(round((end - start) / period)) + 1
    log('  %s .. %s every %s -> %d steps'
        % (row['startTime'], row['endTime'], row.get('period'), n_data))

    log('fetching video segments')
    segs = fetch_segments(args.node, row, work)

    log('scanning source frames')
    total = count_frames(segs)
    log('  %d encoded frames for %d data steps (%.3f per step)'
        % (total, n_data, total / n_data))
    if total < n_data:
        raise SystemExit('encode has fewer frames (%d) than data steps (%d)'
                         % (total, n_data))
    verify_hold_model(segs, total, n_data)
    indices = sample_indices(total, n_data)

    probe = av.open(segs[0])
    src_w = probe.streams.video[0].codec_context.width
    src_h = probe.streams.video[0].codec_context.height
    probe.close()
    width = args.width or src_w
    height = args.height or src_h
    log('  source %dx%d -> output %dx%d' % (src_w, src_h, width, height))

    log('building backdrop')
    if args.no_basemap:
        bg = np.zeros((height, width, 3), dtype=np.float32)
    else:
        bg = np.asarray(
            build_background(bbox, width, height, args.asset_base, work,
                             args.dim, borders=not args.no_borders).convert('RGB'),
            dtype=np.float32)

    lut = build_color_scale_lut(scale)
    mp4 = os.path.join(out_dir, '%s.mp4' % slug)
    ff = ffmpeg_path(args.ffmpeg)
    log('encoding %s' % mp4)
    proc = subprocess.Popen(
        [ff, '-y', '-loglevel', 'error',
         '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (width, height),
         '-r', str(args.fps_in), '-i', 'pipe:0',
         '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
         '-preset', args.preset, '-crf', str(args.crf),
         '-r', str(args.fps_out), '-movflags', '+faststart', mp4],
        stdin=subprocess.PIPE)

    peak = 0
    written = 0
    for _k, gray in iter_sampled(segs, indices):
        peak = max(peak, int(gray.max()))
        rgba = lut[gray].astype(np.float32)
        a = rgba[:, :, 3:4] / 255.0
        comp = bg if bg.shape[:2] == gray.shape else None
        if comp is None:
            raise SystemExit('backdrop %s does not match frame %s'
                             % (bg.shape[:2], gray.shape))
        frame = comp * (1 - a) + rgba[:, :, :3] * a
        if (frame.shape[1], frame.shape[0]) != (width, height):
            frame = np.asarray(Image.fromarray(frame.astype(np.uint8))
                               .resize((width, height), Image.LANCZOS), dtype=np.float32)
        proc.stdin.write(np.clip(frame, 0, 255).astype(np.uint8).tobytes())
        written += 1
        if written % 20 == 0:
            log('  %d/%d' % (written, n_data))
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit('ffmpeg failed')
    if written != n_data:
        raise SystemExit('wrote %d frames, expected %d' % (written, n_data))

    # SOS reads labels.txt positionally, so a line count that disagrees with the
    # movie's real frame count silently shifts every label after the mismatch.
    # Probe the finished file rather than trusting the arithmetic.
    n_frames = probe_frame_count(mp4)
    log('  encoded %d container frames (%d steps x %d)' % (n_frames, n_data, repeat))
    if n_frames != n_data * repeat:
        raise SystemExit(
            'container has %d frames but %d steps x %d repeat = %d; refusing to '
            'write a labels.txt that would be misaligned'
            % (n_frames, n_data, repeat, n_data * repeat))

    starts = [start + period * k for k in range(n_data)]
    labels = os.path.join(out_dir, 'labels.txt')
    lines = write_labels(labels, starts, repeat, args.label_format)
    assert len(lines) == n_frames
    log('  labels.txt: %d lines == %d frames' % (len(lines), n_frames))

    units = scale.get('units') or ''
    cut = (scale.get('transparentRange') or 0) * (scale['vmax'] - scale['vmin']) + scale['vmin']
    sidecar = {
        'datasetId': row['id'],
        'slug': slug,
        'title': row.get('title'),
        'source': row.get('organization'),
        'attribution': row.get('attributionText'),
        'license': row.get('licenseStatement') or row.get('licenseSpdx'),
        'websiteLink': row.get('websiteLink'),
        'sourceEncoding': 'data-luma (luma carries the normalised value)',
        'renderedFrom': '%s/api/v1/datasets/%s/manifest' % (args.node, row['id']),
        'renderedAt': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'video': {
            'file': os.path.basename(mp4),
            'width': width, 'height': height,
            'fps': args.fps_out,
            'containerFrames': n_frames,
            'dataSteps': n_data,
            'framesPerStep': repeat,
            'projection': 'equirectangular (plate carree), lat/lon linear in pixel space',
            'boundingBox': bbox,
            'note': 'Pixel (x, y) maps to lon = w + (x + 0.5)/width * (e - w), '
                    'lat = n - (y + 0.5)/height * (n - s).',
            'basemap': 'flat black' if args.no_basemap else
                       'NASA Blue Marble, dimmed to %g' % args.dim,
        },
        'colorScale': {
            'vmin': scale['vmin'], 'vmax': scale['vmax'], 'units': units,
            'transparentRange': scale.get('transparentRange'),
            'note': 'Colour is the dataset sidecar palette applied to source luma. '
                    'Values below %g %s are drawn fully transparent (nothing measured '
                    'there), so bare basemap means "below that", not necessarily zero.'
                    % (cut, units),
        },
        'frames': [
            {'frame': k, 'step': k,
             'firstContainerFrame': k * repeat,
             'validTime': v.strftime('%Y-%m-%dT%H:%M:%SZ')}
            for k, v in enumerate(starts)
        ],
    }
    with open(os.path.join(out_dir, 'sidecar.json'), 'w') as fh:
        json.dump(sidecar, fh, indent=2)

    log('fetching published assets')
    fetch_asset(row.get('legendLink'), os.path.join(out_dir, 'legend.png'), 'legend')
    fetch_asset(row.get('thumbnailLink'), os.path.join(out_dir, 'thumbnail.png'), 'thumbnail')

    log('')
    log('done -> %s' % os.path.abspath(out_dir))
    log('  %s  %dx%d, %d frames, %.1f s'
        % (os.path.basename(mp4), width, height, n_frames, n_frames / args.fps_out))
    log('  peak value in run: %g %s' % (luma_to_value(peak, scale), units))
    log('  valid %s .. %s' % (starts[0].strftime('%Y-%m-%dT%H:%MZ'),
                              starts[-1].strftime('%Y-%m-%dT%H:%MZ')))


if __name__ == '__main__':
    sys.exit(main())
