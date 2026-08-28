#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Zyra Project

// Apache-2.0
//
// Export the §8 "Tap to place Earth on your desk" model.
//
// Generates two binaries from the Blue Marble diffuse texture
// hosted on the SOS CDN — the same texture
// `src/services/photorealEarth.ts` loads at the 2048 tier:
//
//   poster/assets/xr/models/terraviz-earth.glb   (Android Scene Viewer + desktop preview)
//   poster/assets/xr/models/terraviz-earth.usdz  (iOS AR Quick Look)
//
// Both files share the same canonical sphere geometry built once
// in `buildSphere()` — outward unit-sphere normals, CCW winding,
// glTF-convention UVs (V=0 at the top of the texture, matching an
// equirectangular Earth image with the Arctic at top).
//
// Usage (run locally — the sandbox doesn't have outbound network
// to the SOS CDN):
//
//     node poster/scripts/export-earth-model.mjs
//
// Re-run when the upstream Blue Marble texture changes (rare —
// NASA updates Blue Marble approximately once per decade). Commit
// both regenerated binaries alongside any source changes that
// motivated the re-export.
//
// Stdlib only. No external Node deps; no Three.js, no
// `usdzconvert`. The USDZ side is a USDA (text USD) plus the same
// JPEG, packaged in a STORED-only zip with 64-byte-aligned file
// data offsets — Apple AR Quick Look's hard requirements for
// USDZ. ~350 lines total.

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// --- Configuration ----------------------------------------------------------

const TEXTURE_URL =
  'https://d3sik7mbbzunjo.cloudfront.net/terraviz/basemaps/earth_diffuse_2048.jpg'

// Trim 2 from the model-export design doc:
//   - 2048×1024 diffuse (Blue Marble), no specular, no clouds, no night
//     lights. Static lighting only — glTF can't carry runtime shaders.
const SPHERE_RADIUS = 0.5
const SPHERE_LONGITUDE_SEGMENTS = 64 // segments per ring (east→west)
const SPHERE_LATITUDE_SEGMENTS = 32 // ring count (north→south)

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const OUT_GLB = resolve(REPO_ROOT, 'poster/assets/xr/models/terraviz-earth.glb')
const OUT_USDZ = resolve(REPO_ROOT, 'poster/assets/xr/models/terraviz-earth.usdz')

// Filename inside the USDZ archive — the USDA references it by
// this name, so the two must agree.
const USDZ_TEXTURE_FILENAME = 'earth_diffuse_2048.jpg'
const USDZ_USDA_FILENAME = 'terraviz-earth.usda'

// --- Sphere geometry --------------------------------------------------------

/**
 * Build a UV-sphere centered at the origin. Returns Float32 arrays
 * for positions / normals / texcoords and a Uint16 array for
 * triangle indices.
 *
 * Convention: latitude runs north→south (theta 0→π); longitude
 * runs west→east (phi 0→2π). UV.u maps to longitude (0 at the
 * antimeridian), UV.v maps to latitude (0 at the north pole, 1 at
 * the south pole) — matches glTF's image-origin convention where
 * texcoord (0,0) is the upper-left corner of the texture, and an
 * equirectangular Earth texture has the Arctic at top.
 */
function buildSphere() {
  const positions = []
  const normals = []
  const uvs = []
  const indices = []

  // Vertices.
  for (let lat = 0; lat <= SPHERE_LATITUDE_SEGMENTS; lat++) {
    const theta = (lat * Math.PI) / SPHERE_LATITUDE_SEGMENTS
    const sinTheta = Math.sin(theta)
    const cosTheta = Math.cos(theta)

    for (let lon = 0; lon <= SPHERE_LONGITUDE_SEGMENTS; lon++) {
      const phi = (lon * 2 * Math.PI) / SPHERE_LONGITUDE_SEGMENTS
      const sinPhi = Math.sin(phi)
      const cosPhi = Math.cos(phi)

      const x = cosPhi * sinTheta
      const y = cosTheta
      const z = sinPhi * sinTheta

      positions.push(SPHERE_RADIUS * x, SPHERE_RADIUS * y, SPHERE_RADIUS * z)
      normals.push(x, y, z)
      uvs.push(lon / SPHERE_LONGITUDE_SEGMENTS, lat / SPHERE_LATITUDE_SEGMENTS)
    }
  }

  // Indices — two triangles per quad.
  const ringSize = SPHERE_LONGITUDE_SEGMENTS + 1
  for (let lat = 0; lat < SPHERE_LATITUDE_SEGMENTS; lat++) {
    for (let lon = 0; lon < SPHERE_LONGITUDE_SEGMENTS; lon++) {
      const a = lat * ringSize + lon
      const b = a + ringSize
      const c = a + 1
      const d = b + 1
      indices.push(a, b, c, c, b, d)
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  }
}

// --- Binary chunk packing ---------------------------------------------------

function alignTo4(n) {
  return (n + 3) & ~3
}

function concatBuffers(buffers, padTo4 = true) {
  let total = 0
  for (const b of buffers) total += padTo4 ? alignTo4(b.byteLength) : b.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const b of buffers) {
    out.set(new Uint8Array(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength), offset)
    offset += padTo4 ? alignTo4(b.byteLength) : b.byteLength
  }
  return out
}

// --- glTF JSON --------------------------------------------------------------

/**
 * Compute the glTF accessor `min`/`max` arrays for a Float32 buffer
 * laid out as N × 3 vec3s. Required by the spec for POSITION
 * accessors so consumers can build a bounding box without scanning
 * the buffer themselves.
 */
function vec3MinMax(arr) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < arr.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = arr[i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
  }
  return { min, max }
}

function buildGltf({ positions, normals, uvs, indices, textureBytes }) {
  const posBytes = positions.byteLength
  const normBytes = normals.byteLength
  const uvBytes = uvs.byteLength
  const idxBytes = indices.byteLength
  const texBytes = textureBytes.byteLength

  // Buffer view offsets. Each is aligned to 4-byte boundaries to
  // satisfy the glTF spec's component-type alignment rules.
  const posOffset = 0
  const normOffset = alignTo4(posOffset + posBytes)
  const uvOffset = alignTo4(normOffset + normBytes)
  const idxOffset = alignTo4(uvOffset + uvBytes)
  const texOffset = alignTo4(idxOffset + idxBytes)
  const totalBinSize = alignTo4(texOffset + texBytes)

  const { min: posMin, max: posMax } = vec3MinMax(positions)

  return {
    asset: {
      version: '2.0',
      generator: 'TerraViz poster export-earth-model.mjs',
    },
    scene: 0,
    scenes: [{ nodes: [0], name: 'Scene' }],
    nodes: [{ mesh: 0, name: 'Earth' }],
    meshes: [
      {
        name: 'Earth',
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: 'EarthDiffuse',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0, texCoord: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        doubleSided: false,
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    images: [{ bufferView: 4, mimeType: 'image/jpeg' }],
    samplers: [
      {
        magFilter: 9729, // LINEAR
        minFilter: 9987, // LINEAR_MIPMAP_LINEAR
        wrapS: 10497, // REPEAT
        wrapT: 33071, // CLAMP_TO_EDGE — avoid pole seam wraparound
      },
    ],
    accessors: [
      {
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: positions.length / 3,
        type: 'VEC3',
        min: posMin,
        max: posMax,
      },
      {
        bufferView: 1,
        byteOffset: 0,
        componentType: 5126,
        count: normals.length / 3,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        byteOffset: 0,
        componentType: 5126,
        count: uvs.length / 2,
        type: 'VEC2',
      },
      {
        bufferView: 3,
        byteOffset: 0,
        componentType: 5123, // UNSIGNED_SHORT
        count: indices.length,
        type: 'SCALAR',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: posOffset, byteLength: posBytes, target: 34962 },
      { buffer: 0, byteOffset: normOffset, byteLength: normBytes, target: 34962 },
      { buffer: 0, byteOffset: uvOffset, byteLength: uvBytes, target: 34962 },
      { buffer: 0, byteOffset: idxOffset, byteLength: idxBytes, target: 34963 },
      { buffer: 0, byteOffset: texOffset, byteLength: texBytes },
    ],
    buffers: [{ byteLength: totalBinSize }],
    _binSize: totalBinSize,
    _layout: { posOffset, normOffset, uvOffset, idxOffset, texOffset },
  }
}

// --- GLB packaging ----------------------------------------------------------

/**
 * Pack a glTF JSON + binary buffer into a single GLB binary file.
 * Spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout
 *
 * Layout:
 *   header      (12 bytes)  magic "glTF" + version 2 + total length
 *   JSON chunk  (8 + N)     length, type "JSON", JSON bytes (ASCII-padded to 4)
 *   BIN chunk   (8 + M)     length, type "BIN\0", binary bytes (zero-padded to 4)
 */
function packGlb(gltf, binChunk) {
  // Drop our private layout fields before serialisation.
  const { _binSize, _layout, ...gltfPublic } = gltf
  void _binSize
  void _layout
  const jsonText = JSON.stringify(gltfPublic)
  const jsonBytes = new TextEncoder().encode(jsonText)
  const jsonChunkBody = new Uint8Array(alignTo4(jsonBytes.byteLength))
  jsonChunkBody.set(jsonBytes, 0)
  // Pad with ASCII space (per spec) — not zero — so consumers that
  // accidentally read trailing bytes get a parse error rather than
  // a NUL embedded in JSON.
  for (let i = jsonBytes.byteLength; i < jsonChunkBody.byteLength; i++) {
    jsonChunkBody[i] = 0x20
  }
  const binChunkBody = new Uint8Array(alignTo4(binChunk.byteLength))
  binChunkBody.set(binChunk, 0)

  const total = 12 + 8 + jsonChunkBody.byteLength + 8 + binChunkBody.byteLength
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)

  // Header.
  out.set(new TextEncoder().encode('glTF'), 0)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)

  // JSON chunk.
  dv.setUint32(12, jsonChunkBody.byteLength, true)
  out.set(new TextEncoder().encode('JSON'), 16)
  out.set(jsonChunkBody, 20)

  // BIN chunk.
  const binChunkStart = 20 + jsonChunkBody.byteLength
  dv.setUint32(binChunkStart, binChunkBody.byteLength, true)
  out.set(new TextEncoder().encode('BIN\0'), binChunkStart + 4)
  out.set(binChunkBody, binChunkStart + 8)

  return out
}

// --- USDA (text USD) --------------------------------------------------------

/**
 * Trim a float to 6 decimal places and drop trailing zeros — keeps
 * the USDA file from ballooning with full-double-precision noise on
 * trig outputs (`Math.sin`, `Math.cos`).
 */
function f(n) {
  return parseFloat(n.toFixed(6)).toString()
}

function vec3ListUsda(arr) {
  const parts = []
  for (let i = 0; i < arr.length; i += 3) {
    parts.push(`(${f(arr[i])}, ${f(arr[i + 1])}, ${f(arr[i + 2])})`)
  }
  return `[${parts.join(', ')}]`
}

function vec2ListUsda(arr) {
  const parts = []
  for (let i = 0; i < arr.length; i += 2) {
    parts.push(`(${f(arr[i])}, ${f(arr[i + 1])})`)
  }
  return `[${parts.join(', ')}]`
}

/**
 * Emit a USDA (text USD) document for the textured sphere. The
 * mesh shares its `points` / `primvars:normals` / `primvars:st`
 * with the GLB — same indices, same winding, same UVs — so the
 * two outputs render identically modulo viewer differences.
 *
 * `subdivisionScheme = "none"` is critical: USD's default scheme
 * is `catmullClark`, which would re-subdivide our triangle mesh
 * and render a faceted blob.
 *
 * `orientation = "rightHanded"` is USD's default but spelled out
 * for clarity — matches glTF's CCW front-face winding.
 */
function buildUsda({ positions, normals, uvs, indices, textureFilename }) {
  const triCount = indices.length / 3
  const faceVertexCounts = new Array(triCount).fill(3)
  const faceVertexIndices = Array.from(indices)

  return `#usda 1.0
(
    defaultPrim = "Earth"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "Earth"
{
    def Mesh "EarthMesh"
    {
        uniform token subdivisionScheme = "none"
        uniform token orientation = "rightHanded"
        int[] faceVertexCounts = [${faceVertexCounts.join(', ')}]
        int[] faceVertexIndices = [${faceVertexIndices.join(', ')}]
        point3f[] points = ${vec3ListUsda(positions)}
        normal3f[] primvars:normals = ${vec3ListUsda(normals)} (
            interpolation = "vertex"
        )
        texCoord2f[] primvars:st = ${vec2ListUsda(uvs)} (
            interpolation = "vertex"
        )
        rel material:binding = </Earth/EarthMaterial>
    }

    def Material "EarthMaterial"
    {
        token outputs:surface.connect = </Earth/EarthMaterial/PreviewSurface.outputs:surface>

        def Shader "PreviewSurface"
        {
            uniform token info:id = "UsdPreviewSurface"
            color3f inputs:diffuseColor.connect = </Earth/EarthMaterial/Texture.outputs:rgb>
            float inputs:roughness = 1
            float inputs:metallic = 0
            token outputs:surface
        }

        def Shader "Texture"
        {
            uniform token info:id = "UsdUVTexture"
            asset inputs:file = @${textureFilename}@
            float2 inputs:st.connect = </Earth/EarthMaterial/UVTransform.outputs:result>
            color3f outputs:rgb
        }

        def Shader "UVTransform"
        {
            uniform token info:id = "UsdTransform2d"
            float2 inputs:in.connect = </Earth/EarthMaterial/PrimvarReader.outputs:result>
            float2 inputs:scale = (1, -1)
            float2 inputs:translation = (0, 1)
            float inputs:rotation = 0
            float2 outputs:result
        }

        def Shader "PrimvarReader"
        {
            uniform token info:id = "UsdPrimvarReader_float2"
            token inputs:varname = "st"
            float2 outputs:result
        }
    }
}
`
}

// --- USDZ packaging (STORED zip with 64-byte aligned data offsets) ----------

// CRC-32 (IEEE 802.3 polynomial 0xedb88320) — required by the zip
// spec for each entry. Node's `zlib.crc32` would do, but it's
// Node 22+ and we want to stay compatible with whatever runtime
// the local dev box has.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c = (c >>> 8) ^ CRC32_TABLE[(c ^ bytes[i]) & 0xff]
  }
  return (c ^ 0xffffffff) >>> 0
}

/**
 * Pack `entries` into a USDZ archive. Apple AR Quick Look's hard
 * requirements:
 *   1. STORED entries only (compression method 0).
 *   2. Each entry's file data must start at a 64-byte multiple
 *      offset within the archive.
 *   3. The first entry is the "default file" — must be the USDA
 *      (or other USD) entry-point.
 *
 * The 64-byte alignment is achieved by padding the local file
 * header's `extra field` (a variable-length zero-fill region after
 * the filename) so that
 *   localOffset + 30 + filename.length + extraField.length ≡ 0 (mod 64)
 *
 * Spec: https://openusd.org/release/spec_usdz.html
 *       https://pkwaredownloads.blob.core.windows.net/pem/APPNOTE.txt
 */
function packUsdz(entries) {
  const records = entries.map(e => ({
    filename: e.filename,
    data: e.data,
    nameBytes: new TextEncoder().encode(e.filename),
    crc: crc32(e.data),
    size: e.data.byteLength,
  }))

  // First pass — compute extra-field padding so that each entry's
  // file data starts on a 64-byte boundary, and remember the local
  // header offset for the central directory.
  let offset = 0
  for (const r of records) {
    const baseHeaderSize = 30 + r.nameBytes.byteLength
    const dataStart = offset + baseHeaderSize
    r.extraFieldLength = (64 - (dataStart % 64)) % 64
    r.localOffset = offset
    offset += baseHeaderSize + r.extraFieldLength + r.size
  }
  const cdStart = offset

  const parts = []

  // Local file headers + data.
  for (const r of records) {
    const lfh = new Uint8Array(30 + r.nameBytes.byteLength + r.extraFieldLength)
    const dv = new DataView(lfh.buffer)
    dv.setUint32(0, 0x04034b50, true) // signature: PK\3\4
    dv.setUint16(4, 0x000a, true)     // version needed: 1.0 (STORED)
    dv.setUint16(6, 0x0000, true)     // gp bit flag
    dv.setUint16(8, 0x0000, true)     // method: STORED
    dv.setUint16(10, 0x0000, true)    // last mod time
    dv.setUint16(12, 0x0021, true)    // last mod date: 1980-01-01
    dv.setUint32(14, r.crc, true)
    dv.setUint32(18, r.size, true)    // compressed size = uncompressed (STORED)
    dv.setUint32(22, r.size, true)
    dv.setUint16(26, r.nameBytes.byteLength, true)
    dv.setUint16(28, r.extraFieldLength, true)
    lfh.set(r.nameBytes, 30)
    // Extra field is already zero-filled by Uint8Array allocation.
    parts.push(lfh)
    parts.push(r.data)
  }

  // Central directory.
  let cdSize = 0
  for (const r of records) {
    const cdh = new Uint8Array(46 + r.nameBytes.byteLength)
    const dv = new DataView(cdh.buffer)
    dv.setUint32(0, 0x02014b50, true) // signature: PK\1\2
    dv.setUint16(4, 0x0014, true)     // version made by: 2.0
    dv.setUint16(6, 0x000a, true)     // version needed
    dv.setUint16(8, 0x0000, true)     // gp bit flag
    dv.setUint16(10, 0x0000, true)    // method: STORED
    dv.setUint16(12, 0x0000, true)    // mod time
    dv.setUint16(14, 0x0021, true)    // mod date
    dv.setUint32(16, r.crc, true)
    dv.setUint32(20, r.size, true)
    dv.setUint32(24, r.size, true)
    dv.setUint16(28, r.nameBytes.byteLength, true)
    dv.setUint16(30, 0, true)         // extra field length (CD): 0
    dv.setUint16(32, 0, true)         // file comment length
    dv.setUint16(34, 0, true)         // disk number start
    dv.setUint16(36, 0, true)         // internal file attrs
    dv.setUint32(38, 0, true)         // external file attrs
    dv.setUint32(42, r.localOffset, true)
    cdh.set(r.nameBytes, 46)
    parts.push(cdh)
    cdSize += cdh.byteLength
  }

  // End of Central Directory Record.
  const eocd = new Uint8Array(22)
  const dv = new DataView(eocd.buffer)
  dv.setUint32(0, 0x06054b50, true) // signature: PK\5\6
  dv.setUint16(4, 0, true)
  dv.setUint16(6, 0, true)
  dv.setUint16(8, records.length, true)
  dv.setUint16(10, records.length, true)
  dv.setUint32(12, cdSize, true)
  dv.setUint32(16, cdStart, true)
  dv.setUint16(20, 0, true)
  parts.push(eocd)

  let total = 0
  for (const p of parts) total += p.byteLength
  const out = new Uint8Array(total)
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.byteLength
  }
  return out
}

// --- Main -------------------------------------------------------------------

console.log(`[export-earth-model] Fetching ${TEXTURE_URL}`)
const res = await fetch(TEXTURE_URL)
if (!res.ok) {
  console.error(
    `[export-earth-model] Texture fetch failed: ${res.status} ${res.statusText}`,
  )
  console.error(
    "[export-earth-model] Run this from a network with outbound HTTPS to the SOS CDN — sandboxed environments without permissioned egress (CI runners with restricted network policies, dev containers behind strict proxies) typically fail with 403.",
  )
  process.exit(1)
}
const textureBytes = new Uint8Array(await res.arrayBuffer())
console.log(`[export-earth-model]   ${textureBytes.byteLength} bytes`)

console.log('[export-earth-model] Building sphere geometry')
const geometry = buildSphere()
console.log(
  `[export-earth-model]   ${geometry.positions.length / 3} vertices, ${geometry.indices.length / 3} triangles`,
)

console.log('[export-earth-model] Assembling glTF + binary chunk')
const gltf = buildGltf({ ...geometry, textureBytes })
const binChunk = new Uint8Array(gltf._binSize)
binChunk.set(new Uint8Array(geometry.positions.buffer), gltf._layout.posOffset)
binChunk.set(new Uint8Array(geometry.normals.buffer), gltf._layout.normOffset)
binChunk.set(new Uint8Array(geometry.uvs.buffer), gltf._layout.uvOffset)
binChunk.set(new Uint8Array(geometry.indices.buffer), gltf._layout.idxOffset)
binChunk.set(textureBytes, gltf._layout.texOffset)

console.log('[export-earth-model] Packing GLB')
const glb = packGlb(gltf, binChunk)

mkdirSync(dirname(OUT_GLB), { recursive: true })
writeFileSync(OUT_GLB, glb)
console.log(
  `[export-earth-model] Wrote ${relative(REPO_ROOT, OUT_GLB)} (${glb.byteLength} bytes)`,
)

console.log('[export-earth-model] Building USDA (text USD) document')
const usdaText = buildUsda({ ...geometry, textureFilename: USDZ_TEXTURE_FILENAME })
const usdaBytes = new TextEncoder().encode(usdaText)
console.log(`[export-earth-model]   ${usdaBytes.byteLength} bytes`)

console.log('[export-earth-model] Packing USDZ archive')
// Order matters: AR Quick Look treats the first archive entry as
// the default / entry-point USD.
const usdz = packUsdz([
  { filename: USDZ_USDA_FILENAME, data: usdaBytes },
  { filename: USDZ_TEXTURE_FILENAME, data: textureBytes },
])
writeFileSync(OUT_USDZ, usdz)
console.log(
  `[export-earth-model] Wrote ${relative(REPO_ROOT, OUT_USDZ)} (${usdz.byteLength} bytes)`,
)
