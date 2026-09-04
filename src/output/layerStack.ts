// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

/**
 * The output's dataset overlay and multi-shell layer stack.
 *
 * This is the half of the output renderer that decides *what colour a
 * point on the sphere is*; `equirectRtt.ts` decides *which point a
 * pixel shows*. `buildOutputFragmentShader` composes the two.
 *
 * ## The maths here is not new, and must not be
 *
 * Placing a dataset on a sphere means bbox clipping, a `lonOrigin`
 * shift, a `isFlippedInY` flip, and — for a data-encoded dataset — a
 * palette lookup through a 256×1 LUT. All four already exist twice in
 * this repo: as GLSL in `photorealEarth.ts`'s `map_fragment` override,
 * and as the pure TS mirror `datasetProbe.latLonToTexelUv`.
 *
 * Both carry scar tissue worth reading before touching anything below.
 * The shader's own comment records that the expression was copied from
 * `earthTileLayer` with latitude inverted, "so a regional dataset
 * rendered into the mirrored hemisphere — a US bbox landing over the
 * South Pacific". `datasetProbe`'s records that an inverted V "has
 * shipped twice in this codebase". This is exactly the boring,
 * expensive class of bug the plan's Prior-art section says an
 * independent re-derivation would reproduce.
 *
 * So the GLSL below is written to match `photorealEarth`'s, and
 * `overlaySampleUv` mirrors it in TypeScript — and the tests assert
 * that mirror agrees with `datasetProbe.latLonToTexelUv`, which is the
 * canonical mirror of the same shader. Agreement is asserted rather
 * than imported so the output bundle does not pull the i18n runtime in
 * through `datasetProbe`; the test is what keeps the duplicate honest.
 *
 * **The better end state, not done here:** extract one GLSL snippet
 * that `photorealEarth` and this module both `#include`, so there is
 * literally one string. That means editing a shader shared by VR,
 * Orbit and the thumbnail generator — a production refactor with a
 * real regression surface and a moving visual baseline. It deserves
 * its own commit rather than riding along on a ladder rung.
 *
 * ## The shell stack is not shells here
 *
 * The plan describes stacked sphere meshes at radii 1.000 / 1.001 /
 * 1.002, and Open Question 8 asks whether they z-fight at 4K+. On the
 * equirect path that question does not arise: there are no meshes and
 * no depth buffer, so layers composite in array order inside one
 * fragment shader. Array order *is* z-order, exactly as the protocol
 * says. Worth recording as an open question the projection answers for
 * free rather than one still owed a test.
 */

import type { DatasetOverlayOptions } from '../types'
import { EQUIRECT_FRAGMENT_SHADER } from './equirectRtt'

/**
 * How many overlay layers one output composites.
 *
 * Bounded by fragment texture units, not by taste: WebGL guarantees
 * only 8, and the base map plus each layer's texture and its palette
 * LUT all want one. Four layers matches the control window's own
 * 4-globe ceiling, so an output can mirror the busiest layout the app
 * can produce.
 */
export const MAX_OUTPUT_LAYERS = 4

/** Normalised texture coordinates in **shader space**: `v = 1` is the
 *  image's TOP row, because THREE uploads textures with `flipY`. This
 *  is the opposite of `datasetProbe`'s image-space V. */
export interface OverlayUv {
  u: number
  v: number
}

function isGlobalBbox(b: { n: number; s: number; w: number; e: number }): boolean {
  return b.n >= 90 && b.s <= -90 && b.w <= -180 && b.e >= 180
}

/**
 * lat/lon (degrees) → the overlay texture UV to sample, or `null` when
 * the point falls outside a regional dataset's bounding box.
 *
 * `null` is the shader's `discard` / base-map branch: reporting a
 * colour for a fragment the shader would not have drawn is worse than
 * reporting none.
 *
 * A bbox covering the whole globe is treated as no bbox, matching
 * `datasetProbe` — clipping to a box that clips nothing costs a branch
 * and loses the `lonOrigin` shift.
 */
export function overlaySampleUv(
  lat: number,
  lon: number,
  overlay?: DatasetOverlayOptions,
): OverlayUv | null {
  const bbox = overlay?.boundingBox
  const flipY = overlay?.isFlippedInY === true

  if (bbox && !isGlobalBbox(bbox)) {
    const { n, s, w, e } = bbox
    if (lat > n || lat < s) return null
    let u: number
    if (w <= e) {
      if (lon < w || lon > e) return null
      u = (lon - w) / Math.max(e - w, 1e-6)
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      const span = 360 - w + e
      if (lon >= w) u = (lon - w) / span
      else if (lon <= e) u = (lon + 360 - w) / span
      else return null
    }
    // Shader space: the box's NORTH edge is v = 1.
    let v = (lat - s) / Math.max(n - s, 1e-6)
    if (flipY) v = 1 - v
    return { u, v }
  }

  const lonOrigin =
    typeof overlay?.lonOrigin === 'number' && Number.isFinite(overlay.lonOrigin)
      ? overlay.lonOrigin
      : 0
  // GLSL `fract`; JS `%` keeps the dividend's sign, so normalise twice.
  const raw = (lon - lonOrigin) / 360 + 0.5
  const u = ((raw % 1) + 1) % 1
  const v = (lat + 90) / 180
  return { u, v: flipY ? 1 - v : v }
}

/** Uniform names for one overlay slot. A misspelled uniform is
 *  silently ignored by WebGL and reads as "the dataset never loaded". */
export function overlayUniformNames(slot: number): {
  map: string
  lut: string
  bbox: string
  hasBbox: string
  lonOrigin: string
  flipY: string
  dataEncoded: string
  opacity: string
} {
  return {
    map: `uLayer${slot}Map`,
    lut: `uLayer${slot}Lut`,
    bbox: `uLayer${slot}Bbox`,
    hasBbox: `uLayer${slot}HasBbox`,
    lonOrigin: `uLayer${slot}LonOrigin`,
    flipY: `uLayer${slot}FlipY`,
    dataEncoded: `uLayer${slot}DataEncoded`,
    opacity: `uLayer${slot}Opacity`,
  }
}

/**
 * The GLSL mirror of `overlaySampleUv`, plus the data-encoded palette
 * lookup.
 *
 * Returns premultiplied-alpha-free RGBA with `a = 0` outside the bbox,
 * so the caller composites with a plain `mix` and an out-of-bbox
 * fragment contributes nothing rather than a colour.
 *
 * For a data-encoded layer the sampled `.r` is a *measurement*, looked
 * up in the palette LUT. It deliberately skips any contrast or
 * saturation treatment: those exist to make the Earth read well and
 * would silently rewrite every reported value, so the sphere would
 * disagree with the number the control window reports under the
 * cursor.
 */
export const OVERLAY_SAMPLE_GLSL = `
vec4 sampleOverlayLayer(
  sampler2D tex,
  sampler2D lut,
  float lat,
  float lon,
  vec4 bbox,
  int hasBbox,
  float lonOrigin,
  int flipY,
  int dataEncoded,
  float opacity
) {
  vec2 uv;
  if (hasBbox == 1) {
    float bn = bbox.x;
    float bs = bbox.y;
    float bw = bbox.z;
    float be = bbox.w;
    if (lat > bn || lat < bs) return vec4(0.0);
    float bu;
    if (bw <= be) {
      if (lon < bw || lon > be) return vec4(0.0);
      bu = (lon - bw) / max(be - bw, 1e-6);
    } else {
      // Antimeridian-crossing box: inside if east of w OR west of e.
      bool eastSide = lon >= bw;
      bool westSide = lon <= be;
      if (!eastSide && !westSide) return vec4(0.0);
      float span = (360.0 - bw) + be;
      bu = eastSide ? (lon - bw) / span : (lon + 360.0 - bw) / span;
    }
    // v == 1 is the image's TOP row (THREE uploads with flipY), so the
    // box's north edge maps to bv 1, not 0. Inverting this is what put
    // a US bbox over the South Pacific once already.
    float bv = (lat - bs) / max(bn - bs, 1e-6);
    if (flipY == 1) bv = 1.0 - bv;
    uv = vec2(bu, bv);
  } else {
    float fu = fract((lon - lonOrigin) / 360.0 + 0.5);
    float fv = (lat + 90.0) / 180.0;
    if (flipY == 1) fv = 1.0 - fv;
    uv = vec2(fu, fv);
  }

  vec4 texel = texture2D(tex, uv);
  if (dataEncoded == 1) {
    // Luma is a measurement, not a look: no contrast or saturation
    // treatment here, or the sphere reports a different number than
    // the control window measured.
    vec4 pal = texture2D(lut, vec2(texel.r, 0.5));
    return vec4(pal.rgb, pal.a * opacity);
  }
  return vec4(texel.rgb, texel.a * opacity);
}
`.trim()

/**
 * Compose the full output fragment shader: the equirect ray-march from
 * `equirectRtt`, plus `layerCount` overlay slots composited in array
 * order over the base sphere texture.
 *
 * Built as a string rather than shipped as one because the slot count
 * is dynamic and GLSL ES 1.00 has no dynamic sampler indexing — a
 * loop over `uLayer[i]Map` does not compile. Unrolling at build time
 * is the standard way out and keeps the sampler count to what this
 * output actually needs.
 */
export function buildOutputFragmentShader(layerCount: number): string {
  const count = Math.max(0, Math.min(layerCount, MAX_OUTPUT_LAYERS))
  // No layers means no composition: hand back the projection pass
  // untouched rather than a rewritten tail carrying unused hit
  // variables and a hard-coded alpha of 1.
  if (count === 0) return EQUIRECT_FRAGMENT_SHADER

  const declarations: string[] = []
  const composites: string[] = []
  for (let slot = 0; slot < count; slot++) {
    const n = overlayUniformNames(slot)
    declarations.push(
      `uniform sampler2D ${n.map};`,
      `uniform sampler2D ${n.lut};`,
      `uniform vec4 ${n.bbox};`,
      `uniform int ${n.hasBbox};`,
      `uniform float ${n.lonOrigin};`,
      `uniform int ${n.flipY};`,
      `uniform int ${n.dataEncoded};`,
      `uniform float ${n.opacity};`,
    )
    composites.push(
      `  {`,
      `    vec4 layer = sampleOverlayLayer(${n.map}, ${n.lut}, hitLatDeg, hitLonDeg,`,
      `      ${n.bbox}, ${n.hasBbox}, ${n.lonOrigin}, ${n.flipY}, ${n.dataEncoded}, ${n.opacity});`,
      `    colour = mix(colour, layer.rgb, layer.a);`,
      `  }`,
    )
  }

  // The equirect pass ends by writing the base sample to gl_FragColor.
  // Replace that tail with the composite chain, so the ray-march above
  // it stays byte-identical to the shader `equirectRtt`'s own tests
  // cover.
  const BASE_TAIL = '  gl_FragColor = texture2D(uSphereTexture, sphereUv);\n}'
  if (!EQUIRECT_FRAGMENT_SHADER.includes(BASE_TAIL)) {
    throw new Error(
      'equirect fragment shader tail changed; buildOutputFragmentShader can no longer compose it',
    )
  }

  const tail = [
    '  vec3 colour = texture2D(uSphereTexture, sphereUv).rgb;',
    '  float hitLatDeg = degrees(hitLat);',
    '  float hitLonDeg = degrees(hitLon);',
    ...composites,
    '  gl_FragColor = vec4(colour, 1.0);',
    '}',
  ].join('\n')

  const body = EQUIRECT_FRAGMENT_SHADER.replace(BASE_TAIL, tail)

  // GLSL ES 1.00 has no forward declarations: `sampleOverlayLayer` must
  // appear textually before `main()` or the shader fails to compile.
  // Appending it after the body type-checks fine in TypeScript and
  // fails only on a GPU, which is nowhere this repo's tests run — so
  // the ordering is asserted in `layerStack.test.ts`.
  const preamble = `${declarations.join('\n')}\n\n${OVERLAY_SAMPLE_GLSL}\n`
  return body.replace('void main() {', `${preamble}\nvoid main() {`)
}
