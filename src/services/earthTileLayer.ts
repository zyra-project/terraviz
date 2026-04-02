/**
 * Earth tile layer — Day/night, clouds, and specular effects for MapLibre globe.
 *
 * A MapLibre CustomLayerInterface that composites visual effects on top of
 * the NASA GIBS Blue Marble raster tiles using multi-pass WebGL rendering:
 *
 *   Pass 1 (multiply) — Darkens the night side of the Blue Marble tiles
 *   Pass 2 (additive) — Overlays city lights on the night side
 *   Pass 3 (additive) — Specular sun glint on water (masked by clouds)
 *   Pass 4 (alpha)    — Clouds with day/night darkening and zoom fade
 *
 * All passes render a sphere matching MapLibre's ECEF globe geometry with
 * depth test disabled to avoid z-fighting with the tile layer.
 */

import type { CustomLayerInterface } from 'maplibre-gl'
import type { Map as MaplibreMap } from 'maplibre-gl'
import { getSunPosition } from '../utils/time'

// --- Texture URLs (same assets as the Three.js globe) ---
const NIGHT_LIGHTS_URL = '/assets/Earth_Lights_6K.jpg'
const SPECULAR_MAP_URL = '/assets/Earth_Specular_2K.jpg'
const CLOUD_TEXTURE_URL = 'https://s3.dualstack.us-east-1.amazonaws.com/metadata.sosexplorer.gov/clouds_8192.jpg'

// --- Rendering constants (matched to earthMaterials.ts) ---
const NIGHT_LIGHT_STRENGTH = 0.5
const NIGHT_DARKENING = 0.08 // how dark the night side gets (before city lights)
const CLOUD_RADIUS = 1.005   // slightly above globe surface
const CLOUD_OPACITY = 0.65
const CLOUD_ALPHA_GAMMA = 1.8
const CLOUD_NIGHT_DARKENING = 0.08
const SPECULAR_SHININESS = 40.0
const SPECULAR_STRENGTH = 0.6
const STAR_BRIGHTNESS = 0.4 // higher than Three.js (0.02) since we lack additive glow
const SKYBOX_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const
const SKYBOX_URL_BASE = '/assets/skybox/'

// --- Matrix utility ---

/** Invert a 4x4 column-major matrix. Returns false if singular. */
function invertMat4(out: Float32Array, m: ArrayLike<number>): boolean {
  const a00=m[0],a01=m[1],a02=m[2],a03=m[3],a10=m[4],a11=m[5],a12=m[6],a13=m[7]
  const a20=m[8],a21=m[9],a22=m[10],a23=m[11],a30=m[12],a31=m[13],a32=m[14],a33=m[15]
  const b00=a00*a11-a01*a10,b01=a00*a12-a02*a10,b02=a00*a13-a03*a10
  const b03=a01*a12-a02*a11,b04=a01*a13-a03*a11,b05=a02*a13-a03*a12
  const b06=a20*a31-a21*a30,b07=a20*a32-a22*a30,b08=a20*a33-a23*a30
  const b09=a21*a32-a22*a31,b10=a21*a33-a23*a31,b11=a22*a33-a23*a32
  let det=b00*b11-b01*b10+b02*b09+b03*b08-b04*b07+b05*b06
  if (Math.abs(det)<1e-10) return false
  det=1/det
  out[0]=(a11*b11-a12*b10+a13*b09)*det;out[1]=(a02*b10-a01*b11-a03*b09)*det
  out[2]=(a31*b05-a32*b04+a33*b03)*det;out[3]=(a22*b04-a21*b05-a23*b03)*det
  out[4]=(a12*b08-a10*b11-a13*b07)*det;out[5]=(a00*b11-a02*b08+a03*b07)*det
  out[6]=(a32*b02-a30*b05-a33*b01)*det;out[7]=(a20*b05-a22*b02+a23*b01)*det
  out[8]=(a10*b10-a11*b08+a13*b06)*det;out[9]=(a01*b08-a00*b10-a03*b06)*det
  out[10]=(a30*b04-a31*b02+a33*b00)*det;out[11]=(a21*b02-a20*b04-a23*b00)*det
  out[12]=(a11*b07-a10*b09-a12*b06)*det;out[13]=(a00*b09-a01*b07+a02*b06)*det
  out[14]=(a31*b01-a30*b03-a32*b00)*det;out[15]=(a20*b03-a21*b01+a22*b00)*det
  return true
}

// --- Sphere geometry ---

interface SphereBuffers {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  indices: Uint16Array
  indexCount: number
}

/**
 * Generate a UV sphere with equirectangular texture coordinates.
 * Coordinate convention matches MapLibre's ECEF globe:
 *   x = cos(lat) * sin(lng)
 *   y = sin(lat)
 *   z = cos(lat) * cos(lng)
 * where lat ∈ [+π/2, -π/2] (north→south), lng ∈ [-π, +π].
 *
 * UV mapping: u=0 at -180°, u=0.5 at 0° (prime meridian), u=1 at +180°.
 */
function createSphereGeometry(radius: number, wSegs: number, hSegs: number): SphereBuffers {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []

  for (let y = 0; y <= hSegs; y++) {
    const v = y / hSegs
    const lat = Math.PI / 2 - v * Math.PI // +90° at top to -90° at bottom

    for (let x = 0; x <= wSegs; x++) {
      const u = x / wSegs
      const lng = u * 2 * Math.PI - Math.PI // -180° to +180°

      // MapLibre ECEF convention
      const nx = Math.cos(lat) * Math.sin(lng)
      const ny = Math.sin(lat)
      const nz = Math.cos(lat) * Math.cos(lng)

      positions.push(radius * nx, radius * ny, radius * nz)
      normals.push(nx, ny, nz)
      uvs.push(u, v)
    }
  }

  for (let y = 0; y < hSegs; y++) {
    for (let x = 0; x < wSegs; x++) {
      const a = y * (wSegs + 1) + x
      const b = a + wSegs + 1
      indices.push(a, b, a + 1)
      indices.push(b, b + 1, a + 1)
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
    indexCount: indices.length,
  }
}

// --- Sun direction ---

/** Convert geographic lat/lng (degrees) to a unit direction vector (MapLibre ECEF convention). */
function sunDirectionFromLatLng(latDeg: number, lngDeg: number): [number, number, number] {
  const lat = latDeg * Math.PI / 180
  const lng = lngDeg * Math.PI / 180
  return [
    Math.cos(lat) * Math.sin(lng),
    Math.sin(lat),
    Math.cos(lat) * Math.cos(lng),
  ]
}

// --- Shader source ---

// Pass 1: multiply blend — darkens night side of existing tiles
const darkenVertSrc = `#version 300 es
  layout(location = 0) in vec3 aPosition;
  layout(location = 1) in vec3 aNormal;
  uniform mat4 uMatrix;
  uniform float uRadiusScale;
  out vec3 vNormal;

  void main() {
    vNormal = aNormal;
    gl_Position = uMatrix * vec4(aPosition * uRadiusScale, 1.0);
  }
`

const darkenFragSrc = `#version 300 es
  precision highp float;
  uniform vec3 uSunDir;
  in vec3 vNormal;
  out vec4 fragColor;

  void main() {
    vec3 N = normalize(vNormal);
    float NdotL = dot(N, uSunDir);

    // smoothstep matches earthMaterials.ts: smoothstep(0.0, -0.2, NdotL)
    float nightFactor = smoothstep(0.0, -0.2, NdotL);

    // Day side → white (1.0) = no change under multiply blend
    // Night side → dark (NIGHT_DARKENING) to simulate unlit Earth
    float brightness = mix(1.0, ${NIGHT_DARKENING.toFixed(4)}, nightFactor);

    fragColor = vec4(vec3(brightness), 1.0);
  }
`

// Pass 2: additive blend — overlays city lights on night side
const lightsVertSrc = `#version 300 es
  layout(location = 0) in vec3 aPosition;
  layout(location = 1) in vec3 aNormal;
  layout(location = 2) in vec2 aUV;
  uniform mat4 uMatrix;
  uniform float uRadiusScale;
  out vec3 vNormal;
  out vec2 vUV;

  void main() {
    vNormal = aNormal;
    vUV = aUV;
    gl_Position = uMatrix * vec4(aPosition * uRadiusScale, 1.0);
  }
`

const lightsFragSrc = `#version 300 es
  precision highp float;
  uniform vec3 uSunDir;
  uniform sampler2D uNightLights;
  uniform float uLightStrength;
  in vec3 vNormal;
  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    vec3 N = normalize(vNormal);
    float NdotL = dot(N, uSunDir);

    // Night factor — city lights only visible on dark side
    float nightFactor = smoothstep(0.0, -0.2, NdotL);

    // Sample night lights texture
    vec3 lights = texture(uNightLights, vUV).rgb;

    // Scale by night factor and strength
    // Under additive blend: black (0,0,0) = no change on day side
    vec3 emission = lights * nightFactor * uLightStrength;

    fragColor = vec4(emission, 1.0);
  }
`

// Pass 3: alpha blend — clouds with day/night darkening
const cloudsVertSrc = `#version 300 es
  layout(location = 0) in vec3 aPosition;
  layout(location = 1) in vec3 aNormal;
  layout(location = 2) in vec2 aUV;
  uniform mat4 uMatrix;
  uniform float uRadius;
  uniform float uZoomFade;
  out vec3 vNormal;
  out vec2 vUV;
  out float vZoomFade;

  void main() {
    vNormal = aNormal;
    vUV = aUV;
    vZoomFade = uZoomFade;
    gl_Position = uMatrix * vec4(aPosition * uRadius, 1.0);
  }
`

const cloudsFragSrc = `#version 300 es
  precision highp float;
  uniform vec3 uSunDir;
  uniform sampler2D uCloudTex;
  uniform float uOpacity;
  uniform float uAlphaGamma;
  uniform float uNightDarkening;
  in vec3 vNormal;
  in vec2 vUV;
  in float vZoomFade;
  out vec4 fragColor;

  void main() {
    vec3 N = normalize(vNormal);
    float NdotL = dot(N, uSunDir);

    // Sample cloud texture and convert luminance to alpha
    vec4 texColor = texture(uCloudTex, vUV);
    float lum = dot(texColor.rgb, vec3(0.299, 0.587, 0.114));
    float cloudAlpha = pow(lum, uAlphaGamma) * uOpacity;

    // Day/night factor
    float nightMask = smoothstep(0.0, -0.2, NdotL);

    // Day side: white clouds with alpha transparency
    // Night side: black clouds that block city lights below
    // Boost night-side alpha so even thin clouds obscure lights
    vec3 color = mix(vec3(1.0), vec3(0.0), nightMask);
    float alpha = mix(cloudAlpha, min(cloudAlpha * 2.5, 1.0), nightMask);

    // Fade out clouds as camera zooms in
    alpha *= vZoomFade;

    fragColor = vec4(color, alpha);
  }
`

// Pass 4: additive blend — specular sun glint on water
const specularVertSrc = `#version 300 es
  layout(location = 0) in vec3 aPosition;
  layout(location = 1) in vec3 aNormal;
  layout(location = 2) in vec2 aUV;
  uniform mat4 uMatrix;
  uniform float uRadiusScale;
  out vec3 vNormal;
  out vec2 vUV;

  void main() {
    vNormal = aNormal;
    vUV = aUV;
    gl_Position = uMatrix * vec4(aPosition * uRadiusScale, 1.0);
  }
`

const specularFragSrc = `#version 300 es
  precision highp float;
  uniform vec3 uSunDir;
  uniform vec3 uViewDir;
  uniform sampler2D uSpecMap;
  uniform sampler2D uCloudMask;
  uniform float uShininess;
  uniform float uStrength;
  uniform float uCloudAlphaGamma;
  in vec3 vNormal;
  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    vec3 N = normalize(vNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(uViewDir);

    // Blinn-Phong half vector
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), uShininess);

    // Only on the lit side
    float NdotL = dot(N, L);
    spec *= smoothstep(-0.1, 0.1, NdotL);

    // Mask by specular map (bright = water/shiny, dark = land/matte)
    float specMask = texture(uSpecMap, vUV).r;

    // Reduce glint under clouds — sample cloud density
    vec4 cloudSample = texture(uCloudMask, vUV);
    float cloudLum = dot(cloudSample.rgb, vec3(0.299, 0.587, 0.114));
    float cloudDensity = pow(cloudLum, uCloudAlphaGamma);
    spec *= specMask * uStrength * (1.0 - cloudDensity);

    // Additive: white highlight
    fragColor = vec4(vec3(spec), 1.0);
  }
`

// Skybox: full-screen pass that samples cubemap faces based on camera rotation
const skyboxVertSrc = `#version 300 es
  out vec2 vScreenPos;
  void main() {
    float x = float((gl_VertexID & 1) << 2) - 1.0;
    float y = float((gl_VertexID & 2) << 1) - 1.0;
    vScreenPos = vec2(x, y);
    gl_Position = vec4(x, y, 1.0, 1.0);
  }
`

const skyboxFragSrc = `#version 300 es
  precision highp float;
  uniform sampler2D uFaces[6];
  uniform vec4 uCamera; // (lat, lng, bearing, pitch) in radians
  uniform vec2 uAspectFov; // (aspect ratio, fov in radians)
  uniform float uBrightness;
  in vec2 vScreenPos;
  out vec4 fragColor;

  // Rotation helpers
  vec3 rotX(float a, vec3 v) {
    float c = cos(a), s = sin(a);
    return vec3(v.x, v.y*c - v.z*s, v.y*s + v.z*c);
  }
  vec3 rotY(float a, vec3 v) {
    float c = cos(a), s = sin(a);
    return vec3(v.x*c + v.z*s, v.y, -v.x*s + v.z*c);
  }
  vec3 rotZ(float a, vec3 v) {
    float c = cos(a), s = sin(a);
    return vec3(v.x*c - v.y*s, v.x*s + v.y*c, v.z);
  }

  void main() {
    // Ray direction from screen position using real FOV and aspect ratio
    float halfFov = uAspectFov.y * 0.5;
    float tanFov = tan(halfFov);
    vec3 viewDir = normalize(vec3(
      vScreenPos.x * tanFov * uAspectFov.x,
      vScreenPos.y * tanFov,
      -1.0
    ));

    // Apply camera rotation: pitch → bearing → lat → lng
    // This matches MapLibre's camera model
    float lat = uCamera.x, lng = uCamera.y, bearing = uCamera.z, pitch = uCamera.w;
    vec3 dir = viewDir;
    dir = rotX(-pitch, dir);
    dir = rotZ(bearing, dir);
    dir = rotX(-lat, dir);
    dir = rotY(lng, dir);

    // Rotate -90° around X: astronomical Z-up → Y-up (matches Three.js skybox)
    dir = vec3(dir.x, -dir.z, dir.y);

    // Sample the correct cubemap face
    vec3 absDir = abs(dir);
    vec2 uv;
    int face;
    if (absDir.x >= absDir.y && absDir.x >= absDir.z) {
      face = dir.x > 0.0 ? 0 : 1;
      uv = dir.x > 0.0
        ? vec2(-dir.z / absDir.x, -dir.y / absDir.x)
        : vec2(dir.z / absDir.x, -dir.y / absDir.x);
    } else if (absDir.y >= absDir.x && absDir.y >= absDir.z) {
      face = dir.y > 0.0 ? 2 : 3;
      uv = dir.y > 0.0
        ? vec2(dir.x / absDir.y, dir.z / absDir.y)
        : vec2(dir.x / absDir.y, -dir.z / absDir.y);
    } else {
      face = dir.z > 0.0 ? 4 : 5;
      uv = dir.z > 0.0
        ? vec2(dir.x / absDir.z, -dir.y / absDir.z)
        : vec2(-dir.x / absDir.z, -dir.y / absDir.z);
    }
    uv = uv * 0.5 + 0.5;

    vec3 color = vec3(0.0);
    if (face == 0) color = texture(uFaces[0], uv).rgb;
    else if (face == 1) color = texture(uFaces[1], uv).rgb;
    else if (face == 2) color = texture(uFaces[2], uv).rgb;
    else if (face == 3) color = texture(uFaces[3], uv).rgb;
    else if (face == 4) color = texture(uFaces[4], uv).rgb;
    else color = texture(uFaces[5], uv).rgb;

    fragColor = vec4(color * uBrightness, 1.0);
  }
`

// Dataset overlay: simple textured sphere (proper equirectangular mapping)
const datasetVertSrc = `#version 300 es
  layout(location = 0) in vec3 aPosition;
  layout(location = 2) in vec2 aUV;
  uniform mat4 uMatrix;
  uniform float uRadiusScale;
  out vec2 vUV;

  void main() {
    vUV = aUV;
    gl_Position = uMatrix * vec4(aPosition * uRadiusScale, 1.0);
  }
`

const datasetFragSrc = `#version 300 es
  precision highp float;
  uniform sampler2D uDatasetTex;
  in vec2 vUV;
  out vec4 fragColor;

  void main() {
    fragColor = texture(uDatasetTex, vUV);
  }
`

// --- Atmosphere light sync ---

/**
 * Set MapLibre's light once using anchor:'map'.
 *
 * With anchor:'map', MapLibre automatically applies camera rotations
 * each frame — no per-frame setLight() calls needed, so zero lag.
 *
 * MapLibre's getSunPos pipeline for anchor:'map':
 *   cart = sphericalToCartesian(r, az, polar)
 *   lp = [-cart.x, -cart.y, -cart.z]   (negate)
 *   lp = ... * Rx(lat) * Ry(-lng) * lp (camera rotation)
 *   → used as sun direction in atmosphere shader
 *
 * We want the final result to equal our ECEF sun direction. Since MapLibre
 * applies the camera rotation automatically, we just need:
 *   -cart = sunECEF  →  cart = -sunECEF
 * Then solve for [azimuthal, polar] from cart = -sunECEF.
 */
export function syncAtmosphereLight(map: MaplibreMap, sunLat: number, sunLng: number): void {
  const sLatR = sunLat * Math.PI / 180
  const sLngR = sunLng * Math.PI / 180

  // cart = -sunECEF (so that negate(cart) = sunECEF)
  const cx = -(Math.cos(sLatR) * Math.sin(sLngR))
  const cy = -(Math.sin(sLatR))
  const cz = -(Math.cos(sLatR) * Math.cos(sLngR))

  // Solve: cart = sphericalToCartesian(r, az, polar)
  // where az_internal = (az + 90) * π/180
  //   x = r * cos(az_internal) * sin(polar_rad)
  //   y = r * sin(az_internal) * sin(polar_rad)
  //   z = r * cos(polar_rad)
  const r = Math.sqrt(cx * cx + cy * cy + cz * cz)
  if (r < 1e-10) return

  const polar = Math.acos(Math.max(-1, Math.min(1, cz / r))) * 180 / Math.PI
  const azInternal = Math.atan2(cy, cx)
  const azimuthal = ((azInternal * 180 / Math.PI - 90) % 360 + 360) % 360

  map.setLight({
    anchor: 'map',
    position: [1.5, azimuthal, polar],
  })
}

/** Compute MapLibre light position for a given sun lat/lng. */
export function computeSunLightPosition(sunLat: number, sunLng: number): [number, number, number] {
  const sLatR = sunLat * Math.PI / 180
  const sLngR = sunLng * Math.PI / 180
  const cx = -(Math.cos(sLatR) * Math.sin(sLngR))
  const cy = -(Math.sin(sLatR))
  const cz = -(Math.cos(sLatR) * Math.cos(sLngR))
  const r = Math.sqrt(cx * cx + cy * cy + cz * cz)
  if (r < 1e-10) return [1.5, 0, 90]
  const polar = Math.acos(Math.max(-1, Math.min(1, cz / r))) * 180 / Math.PI
  const azInternal = Math.atan2(cy, cx)
  const azimuthal = ((azInternal * 180 / Math.PI - 90) % 360 + 360) % 360
  return [1.5, azimuthal, polar]
}

// --- Layer implementation ---

interface DatasetProgram {
  program: WebGLProgram
  matrixLoc: WebGLUniformLocation | null
  texLoc: WebGLUniformLocation | null
  radiusScaleLoc: WebGLUniformLocation | null
}

interface DayNightProgram {
  program: WebGLProgram
  matrixLoc: WebGLUniformLocation | null
  sunDirLoc: WebGLUniformLocation | null
  radiusScaleLoc: WebGLUniformLocation | null
}

interface LightsProgram extends DayNightProgram {
  nightTexLoc: WebGLUniformLocation | null
  strengthLoc: WebGLUniformLocation | null
}

interface SpecularProgram extends DayNightProgram {
  specMapLoc: WebGLUniformLocation | null
  cloudMaskLoc: WebGLUniformLocation | null
  viewDirLoc: WebGLUniformLocation | null
  shininessLoc: WebGLUniformLocation | null
  strengthLoc: WebGLUniformLocation | null
  cloudAlphaGammaLoc: WebGLUniformLocation | null
}

interface CloudsProgram extends DayNightProgram {
  cloudTexLoc: WebGLUniformLocation | null
  radiusLoc: WebGLUniformLocation | null
  opacityLoc: WebGLUniformLocation | null
  alphaGammaLoc: WebGLUniformLocation | null
  nightDarkeningLoc: WebGLUniformLocation | null
  zoomFadeLoc: WebGLUniformLocation | null
}

function compileProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  label: string,
): WebGLProgram | null {
  const vs = gl.createShader(gl.VERTEX_SHADER)!
  gl.shaderSource(vs, vsSrc)
  gl.compileShader(vs)
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.error(`[EarthTileLayer] ${label} vertex shader:`, gl.getShaderInfoLog(vs))
    return null
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER)!
  gl.shaderSource(fs, fsSrc)
  gl.compileShader(fs)
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    console.error(`[EarthTileLayer] ${label} fragment shader:`, gl.getShaderInfoLog(fs))
    return null
  }

  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error(`[EarthTileLayer] ${label} link:`, gl.getProgramInfoLog(prog))
    return null
  }
  return prog
}

/** Extended interface for controlling the earth tile layer from MapRenderer. */
export interface EarthTileLayerControl {
  /** The MapLibre custom layer interface. */
  layer: CustomLayerInterface
  /** Resolves when all textures (night lights, specular, clouds) have loaded. */
  ready: Promise<void>
  /** Update sun direction. Called by MapRenderer.enableSunLighting(). */
  setSunPosition(lat: number, lng: number): void
  /** Clear sun override — reverts to real-time sun position. */
  clearSunOverride(): void
  /** Show or hide all earth effects (day/night, lights, specular, clouds). */
  setVisible(visible: boolean): void
  /** Inflate effects sphere to cover exaggerated terrain. 0 = no terrain. */
  setTerrainExaggeration(exaggeration: number): void
  /** Display an equirectangular image as a dataset overlay on the globe. */
  setDatasetTexture(image: HTMLCanvasElement | HTMLImageElement): void
  /** Display an equirectangular video as a dataset overlay on the globe. */
  setDatasetVideo(video: HTMLVideoElement): void
  /** Remove the current dataset overlay (image or video). */
  clearDatasetTexture(): void
}

/**
 * Create a MapLibre CustomLayerInterface that composites day/night shading,
 * city lights, specular glint, and clouds onto the globe tiles.
 */
export function createEarthTileLayer(): EarthTileLayerControl {
  let darken: DayNightProgram | null = null
  let lights: LightsProgram | null = null
  let specular: SpecularProgram | null = null
  let clouds: CloudsProgram | null = null
  let vao: WebGLVertexArrayObject | null = null
  let indexCount = 0
  let nightTex: WebGLTexture | null = null
  let nightTexReady = false
  let specTex: WebGLTexture | null = null
  let specTexReady = false
  let cloudTex: WebGLTexture | null = null
  let cloudTexReady = false
  let dataset: DatasetProgram | null = null
  let datasetTex: WebGLTexture | null = null
  let datasetVideo: HTMLVideoElement | null = null
  let datasetActive = false
  let skyboxProg: WebGLProgram | null = null
  let skyboxInvProjLoc: WebGLUniformLocation | null = null
  let skyboxCameraLoc: WebGLUniformLocation | null = null
  let skyboxAspectFovLoc: WebGLUniformLocation | null = null
  let skyboxBrightnessLoc: WebGLUniformLocation | null = null
  let skyboxFaceLocs: (WebGLUniformLocation | null)[] = []
  let skyboxFaceTextures: (WebGLTexture | null)[] = []
  let skyboxReady = false
  let glRef: WebGL2RenderingContext | null = null
  let mapRef: MaplibreMap | null = null

  // Sun direction — updated each frame from real time, or set externally
  let sunDir: [number, number, number] = [1, 0, 0]
  let sunOverride: { lat: number; lng: number } | null = null
  let visible = true

  // Terrain-aware radius scale — inflates effects sphere to cover exaggerated terrain.
  // Max Earth elevation ~8848m / 6371km radius ≈ 0.00139 normalized.
  // Scale = 1.0 + 0.002 * exaggeration (with safety margin).
  let terrainRadiusScale = 1.0

  // Readiness tracking — resolves when all textures are loaded
  let resolveReady: () => void
  const readyPromise = new Promise<void>(r => { resolveReady = r })
  const checkReady = () => {
    if (nightTexReady && specTexReady && cloudTexReady) resolveReady()
  }

  const layer: CustomLayerInterface = {
    id: 'earth-tile-layer',
    type: 'custom',
    renderingMode: '3d',

    onAdd(_map: MaplibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext) {
      mapRef = _map

      // Set atmosphere light once — with anchor:'map', MapLibre handles
      // camera rotation automatically so no per-frame updates needed.
      const initSun = getSunPosition(new Date())
      syncAtmosphereLight(_map, initSun.lat, initSun.lng)

      const gl2 = gl as WebGL2RenderingContext
      glRef = gl2

      // --- Compile skybox shader and load cubemap faces ---
      skyboxProg = compileProgram(gl2, skyboxVertSrc, skyboxFragSrc, 'skybox')
      if (skyboxProg) {
        skyboxInvProjLoc = gl2.getUniformLocation(skyboxProg, 'uInvProjMatrix')
        skyboxCameraLoc = gl2.getUniformLocation(skyboxProg, 'uCamera')
        skyboxAspectFovLoc = gl2.getUniformLocation(skyboxProg, 'uAspectFov')
        skyboxBrightnessLoc = gl2.getUniformLocation(skyboxProg, 'uBrightness')
        skyboxFaceLocs = SKYBOX_FACES.map((_, i) =>
          gl2.getUniformLocation(skyboxProg!, `uFaces[${i}]`))

        // Load 6 face textures
        let facesLoaded = 0
        skyboxFaceTextures = SKYBOX_FACES.map((face, i) => {
          const tex = gl2.createTexture()
          gl2.bindTexture(gl2.TEXTURE_2D, tex)
          gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 1, 1, 0, gl2.RGBA, gl2.UNSIGNED_BYTE,
            new Uint8Array([0, 0, 0, 255]))
          const faceImg = new Image()
          faceImg.crossOrigin = 'anonymous'
          faceImg.onload = () => {
            gl2.bindTexture(gl2.TEXTURE_2D, tex)
            gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, faceImg)
            gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR)
            gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR)
            gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.CLAMP_TO_EDGE)
            gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE)
            facesLoaded++
            if (facesLoaded === 6) {
              skyboxReady = true
              _map.triggerRepaint()
              console.info('[EarthTileLayer] Skybox loaded (6 faces)')
            }
          }
          faceImg.src = SKYBOX_URL_BASE + face + '.jpg'
          return tex
        })
      }

      // --- Compile dataset overlay shader ---
      const datasetProg = compileProgram(gl2, datasetVertSrc, datasetFragSrc, 'dataset')
      if (datasetProg) {
        dataset = {
          program: datasetProg,
          matrixLoc: gl2.getUniformLocation(datasetProg, 'uMatrix'),
          texLoc: gl2.getUniformLocation(datasetProg, 'uDatasetTex'),
          radiusScaleLoc: gl2.getUniformLocation(datasetProg, 'uRadiusScale'),
        }
      }

      // --- Compile all earth effect shader programs ---
      const darkenProg = compileProgram(gl2, darkenVertSrc, darkenFragSrc, 'darken')
      if (darkenProg) {
        darken = {
          program: darkenProg,
          matrixLoc: gl2.getUniformLocation(darkenProg, 'uMatrix'),
          sunDirLoc: gl2.getUniformLocation(darkenProg, 'uSunDir'),
          radiusScaleLoc: gl2.getUniformLocation(darkenProg, 'uRadiusScale'),
        }
      }

      const lightsProg = compileProgram(gl2, lightsVertSrc, lightsFragSrc, 'lights')
      if (lightsProg) {
        lights = {
          program: lightsProg,
          matrixLoc: gl2.getUniformLocation(lightsProg, 'uMatrix'),
          sunDirLoc: gl2.getUniformLocation(lightsProg, 'uSunDir'),
          nightTexLoc: gl2.getUniformLocation(lightsProg, 'uNightLights'),
          strengthLoc: gl2.getUniformLocation(lightsProg, 'uLightStrength'),
          radiusScaleLoc: gl2.getUniformLocation(lightsProg, 'uRadiusScale'),
        }
      }

      const cloudsProg = compileProgram(gl2, cloudsVertSrc, cloudsFragSrc, 'clouds')
      if (cloudsProg) {
        clouds = {
          program: cloudsProg,
          matrixLoc: gl2.getUniformLocation(cloudsProg, 'uMatrix'),
          sunDirLoc: gl2.getUniformLocation(cloudsProg, 'uSunDir'),
          radiusScaleLoc: null, // clouds use uRadius instead
          cloudTexLoc: gl2.getUniformLocation(cloudsProg, 'uCloudTex'),
          radiusLoc: gl2.getUniformLocation(cloudsProg, 'uRadius'),
          opacityLoc: gl2.getUniformLocation(cloudsProg, 'uOpacity'),
          alphaGammaLoc: gl2.getUniformLocation(cloudsProg, 'uAlphaGamma'),
          nightDarkeningLoc: gl2.getUniformLocation(cloudsProg, 'uNightDarkening'),
          zoomFadeLoc: gl2.getUniformLocation(cloudsProg, 'uZoomFade'),
        }
      }

      const specularProg = compileProgram(gl2, specularVertSrc, specularFragSrc, 'specular')
      if (specularProg) {
        specular = {
          program: specularProg,
          matrixLoc: gl2.getUniformLocation(specularProg, 'uMatrix'),
          sunDirLoc: gl2.getUniformLocation(specularProg, 'uSunDir'),
          radiusScaleLoc: gl2.getUniformLocation(specularProg, 'uRadiusScale'),
          specMapLoc: gl2.getUniformLocation(specularProg, 'uSpecMap'),
          cloudMaskLoc: gl2.getUniformLocation(specularProg, 'uCloudMask'),
          viewDirLoc: gl2.getUniformLocation(specularProg, 'uViewDir'),
          shininessLoc: gl2.getUniformLocation(specularProg, 'uShininess'),
          strengthLoc: gl2.getUniformLocation(specularProg, 'uStrength'),
          cloudAlphaGammaLoc: gl2.getUniformLocation(specularProg, 'uCloudAlphaGamma'),
        }
      }

      // --- Generate sphere geometry ---
      const sphere = createSphereGeometry(1.0, 64, 64)
      indexCount = sphere.indexCount

      vao = gl2.createVertexArray()
      gl2.bindVertexArray(vao)

      // Position buffer (used by both programs at location 0)
      const posBuf = gl2.createBuffer()
      gl2.bindBuffer(gl2.ARRAY_BUFFER, posBuf)
      gl2.bufferData(gl2.ARRAY_BUFFER, sphere.positions, gl2.STATIC_DRAW)
      gl2.enableVertexAttribArray(0)
      gl2.vertexAttribPointer(0, 3, gl2.FLOAT, false, 0, 0)

      // Normal buffer (location 1)
      const normBuf = gl2.createBuffer()
      gl2.bindBuffer(gl2.ARRAY_BUFFER, normBuf)
      gl2.bufferData(gl2.ARRAY_BUFFER, sphere.normals, gl2.STATIC_DRAW)
      gl2.enableVertexAttribArray(1)
      gl2.vertexAttribPointer(1, 3, gl2.FLOAT, false, 0, 0)

      // UV buffer (location 2 — only used by lights program)
      const uvBuf = gl2.createBuffer()
      gl2.bindBuffer(gl2.ARRAY_BUFFER, uvBuf)
      gl2.bufferData(gl2.ARRAY_BUFFER, sphere.uvs, gl2.STATIC_DRAW)
      gl2.enableVertexAttribArray(2)
      gl2.vertexAttribPointer(2, 2, gl2.FLOAT, false, 0, 0)

      // Index buffer
      const idxBuf = gl2.createBuffer()
      gl2.bindBuffer(gl2.ELEMENT_ARRAY_BUFFER, idxBuf)
      gl2.bufferData(gl2.ELEMENT_ARRAY_BUFFER, sphere.indices, gl2.STATIC_DRAW)

      gl2.bindVertexArray(null)

      // --- Load night lights texture asynchronously ---
      nightTex = gl2.createTexture()
      gl2.bindTexture(gl2.TEXTURE_2D, nightTex)
      // 1x1 black placeholder until image loads
      gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 1, 1, 0, gl2.RGBA, gl2.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]))

      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        gl2.bindTexture(gl2.TEXTURE_2D, nightTex)
        gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, img)
        gl2.generateMipmap(gl2.TEXTURE_2D)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR_MIPMAP_LINEAR)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.REPEAT)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE)
        nightTexReady = true
        checkReady()
        _map.triggerRepaint()
        console.info('[EarthTileLayer] Night lights texture loaded (%dx%d)', img.width, img.height)
      }
      img.onerror = () => {
        console.warn('[EarthTileLayer] Failed to load night lights texture:', NIGHT_LIGHTS_URL)
        nightTexReady = true // resolve ready even on failure
        checkReady()
      }
      img.src = NIGHT_LIGHTS_URL

      // --- Load cloud texture asynchronously ---
      cloudTex = gl2.createTexture()
      gl2.bindTexture(gl2.TEXTURE_2D, cloudTex)
      gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 1, 1, 0, gl2.RGBA, gl2.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]))

      const cloudImg = new Image()
      cloudImg.crossOrigin = 'anonymous'
      cloudImg.onload = () => {
        gl2.bindTexture(gl2.TEXTURE_2D, cloudTex)
        gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, cloudImg)
        gl2.generateMipmap(gl2.TEXTURE_2D)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR_MIPMAP_LINEAR)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.REPEAT)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE)
        cloudTexReady = true
        checkReady()
        _map.triggerRepaint()
        console.info('[EarthTileLayer] Cloud texture loaded (%dx%d)', cloudImg.width, cloudImg.height)
      }
      cloudImg.onerror = () => {
        console.warn('[EarthTileLayer] Failed to load cloud texture:', CLOUD_TEXTURE_URL)
        cloudTexReady = true
        checkReady()
      }
      cloudImg.src = CLOUD_TEXTURE_URL

      // --- Load specular map texture asynchronously ---
      specTex = gl2.createTexture()
      gl2.bindTexture(gl2.TEXTURE_2D, specTex)
      gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, 1, 1, 0, gl2.RGBA, gl2.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 255]))

      const specImg = new Image()
      specImg.crossOrigin = 'anonymous'
      specImg.onload = () => {
        gl2.bindTexture(gl2.TEXTURE_2D, specTex)
        gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, specImg)
        gl2.generateMipmap(gl2.TEXTURE_2D)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MIN_FILTER, gl2.LINEAR_MIPMAP_LINEAR)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_MAG_FILTER, gl2.LINEAR)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_S, gl2.REPEAT)
        gl2.texParameteri(gl2.TEXTURE_2D, gl2.TEXTURE_WRAP_T, gl2.CLAMP_TO_EDGE)
        specTexReady = true
        checkReady()
        _map.triggerRepaint()
        console.info('[EarthTileLayer] Specular map loaded (%dx%d)', specImg.width, specImg.height)
      }
      specImg.onerror = () => {
        console.warn('[EarthTileLayer] Failed to load specular map:', SPECULAR_MAP_URL)
        specTexReady = true
        checkReady()
      }
      specImg.src = SPECULAR_MAP_URL

      console.info('[EarthTileLayer] Day/night+clouds+specular layer initialized (%d triangles)', indexCount / 3)
    },

    render(gl, args) {
      if (!vao) return
      const gl2 = gl as WebGL2RenderingContext
      const matrix = args.defaultProjectionData.mainMatrix

      // --- Skybox: full-screen pass behind the globe ---
      // Reconstructs view direction per-pixel and samples cubemap faces.
      // Depth test ensures stars only show where no globe was drawn.
      if (skyboxReady && skyboxProg && mapRef) {
        gl2.enable(gl2.DEPTH_TEST)
        gl2.depthFunc(gl2.LEQUAL)
        gl2.depthMask(false)
        gl2.disable(gl2.BLEND)
        gl2.disable(gl2.CULL_FACE)

        gl2.useProgram(skyboxProg)
        gl2.uniform1f(skyboxBrightnessLoc, STAR_BRIGHTNESS)

        // Aspect ratio and FOV for correct angular coverage
        const canvas = mapRef.getCanvas()
        const aspect = canvas.width / canvas.height
        const fov = ((mapRef as any).transform?._fov ?? 0.6435) as number
        gl2.uniform2f(skyboxAspectFovLoc, aspect, fov)

        // Pass camera rotation angles — skybox responds to rotation only, not zoom
        const center = mapRef.getCenter()
        const bearing = mapRef.getBearing() * Math.PI / 180
        const pitch = mapRef.getPitch() * Math.PI / 180
        const lat = center.lat * Math.PI / 180
        const lng = center.lng * Math.PI / 180
        gl2.uniform4f(skyboxCameraLoc, lat, lng, bearing, pitch)

        // Bind all 6 face textures
        for (let i = 0; i < 6; i++) {
          gl2.activeTexture(gl2.TEXTURE0 + i)
          gl2.bindTexture(gl2.TEXTURE_2D, skyboxFaceTextures[i])
          gl2.uniform1i(skyboxFaceLocs[i], i)
        }

        // Full-screen triangle (vertex IDs only, no VAO needed)
        gl2.bindVertexArray(null)
        gl2.drawArrays(gl2.TRIANGLES, 0, 3)

        gl2.depthMask(true)
        gl2.depthFunc(gl2.LESS)
      }

      // Common GL state for sphere passes
      gl2.disable(gl2.DEPTH_TEST)
      gl2.enable(gl2.CULL_FACE)
      gl2.cullFace(gl2.BACK)
      gl2.bindVertexArray(vao)

      // --- Dataset overlay: opaque textured sphere (replaces earth effects) ---
      if (datasetActive && dataset && datasetTex) {
        // For video datasets, re-upload the current frame every render
        if (datasetVideo && !datasetVideo.paused && datasetVideo.readyState >= 2) {
          gl2.bindTexture(gl2.TEXTURE_2D, datasetTex)
          gl2.texImage2D(gl2.TEXTURE_2D, 0, gl2.RGBA, gl2.RGBA, gl2.UNSIGNED_BYTE, datasetVideo)
          // Request next frame so we keep updating
          mapRef?.triggerRepaint()
        }

        gl2.disable(gl2.BLEND)
        gl2.useProgram(dataset.program)
        gl2.uniformMatrix4fv(dataset.matrixLoc, false, matrix)
        gl2.uniform1f(dataset.radiusScaleLoc, terrainRadiusScale)
        gl2.activeTexture(gl2.TEXTURE0)
        gl2.bindTexture(gl2.TEXTURE_2D, datasetTex)
        gl2.uniform1i(dataset.texLoc, 0)
        gl2.drawElements(gl2.TRIANGLES, indexCount, gl2.UNSIGNED_SHORT, 0)

        // Restore GL state and return — no earth effects when dataset is active
        gl2.bindVertexArray(null)
        gl2.enable(gl2.DEPTH_TEST)
        gl2.disable(gl2.CULL_FACE)
        return
      }

      if (!darken || !visible) {
        gl2.bindVertexArray(null)
        gl2.enable(gl2.DEPTH_TEST)
        gl2.disable(gl2.CULL_FACE)
        return
      }

      // Update sun direction from override or real-time
      const sun = sunOverride ?? getSunPosition(new Date())
      sunDir = sunDirectionFromLatLng(sun.lat, sun.lng)

      // --- Pass 1: Multiply blend — darken night side ---
      gl2.enable(gl2.BLEND)
      gl2.blendFunc(gl2.DST_COLOR, gl2.ZERO) // result = src * dst

      gl2.useProgram(darken.program)
      gl2.uniformMatrix4fv(darken.matrixLoc, false, matrix)
      gl2.uniform1f(darken.radiusScaleLoc, terrainRadiusScale)
      gl2.uniform3f(darken.sunDirLoc, sunDir[0], sunDir[1], sunDir[2])
      gl2.drawElements(gl2.TRIANGLES, indexCount, gl2.UNSIGNED_SHORT, 0)

      // --- Pass 2: Additive blend — overlay city lights ---
      if (lights && nightTexReady) {
        gl2.blendFunc(gl2.ONE, gl2.ONE) // result = src + dst

        gl2.useProgram(lights.program)
        gl2.uniformMatrix4fv(lights.matrixLoc, false, matrix)
        gl2.uniform1f(lights.radiusScaleLoc, terrainRadiusScale)
        gl2.uniform3f(lights.sunDirLoc, sunDir[0], sunDir[1], sunDir[2])
        gl2.uniform1f(lights.strengthLoc, NIGHT_LIGHT_STRENGTH)

        gl2.activeTexture(gl2.TEXTURE0)
        gl2.bindTexture(gl2.TEXTURE_2D, nightTex)
        gl2.uniform1i(lights.nightTexLoc, 0)

        gl2.drawElements(gl2.TRIANGLES, indexCount, gl2.UNSIGNED_SHORT, 0)
      }

      // --- Pass 3: Additive blend — specular sun glint on water ---
      if (specular && specTexReady && mapRef) {
        gl2.blendFunc(gl2.ONE, gl2.ONE) // additive

        // View direction: approximate as ECEF normal at camera center
        const center = mapRef.getCenter()
        const vLatR = center.lat * Math.PI / 180
        const vLngR = center.lng * Math.PI / 180
        const viewDir: [number, number, number] = [
          Math.cos(vLatR) * Math.sin(vLngR),
          Math.sin(vLatR),
          Math.cos(vLatR) * Math.cos(vLngR),
        ]

        gl2.useProgram(specular.program)
        gl2.uniformMatrix4fv(specular.matrixLoc, false, matrix)
        gl2.uniform1f(specular.radiusScaleLoc, terrainRadiusScale)
        gl2.uniform3f(specular.sunDirLoc, sunDir[0], sunDir[1], sunDir[2])
        gl2.uniform3f(specular.viewDirLoc, viewDir[0], viewDir[1], viewDir[2])
        gl2.uniform1f(specular.shininessLoc, SPECULAR_SHININESS)
        gl2.uniform1f(specular.strengthLoc, SPECULAR_STRENGTH)

        gl2.activeTexture(gl2.TEXTURE0)
        gl2.bindTexture(gl2.TEXTURE_2D, specTex)
        gl2.uniform1i(specular.specMapLoc, 0)

        gl2.activeTexture(gl2.TEXTURE1)
        gl2.bindTexture(gl2.TEXTURE_2D, cloudTex)
        gl2.uniform1i(specular.cloudMaskLoc, 1)
        gl2.uniform1f(specular.cloudAlphaGammaLoc, CLOUD_ALPHA_GAMMA)

        gl2.drawElements(gl2.TRIANGLES, indexCount, gl2.UNSIGNED_SHORT, 0)
      }

      // --- Pass 4: Alpha blend — clouds with day/night darkening ---
      if (clouds && cloudTexReady) {
        // Standard alpha blend: clouds over existing content
        gl2.blendFunc(gl2.SRC_ALPHA, gl2.ONE_MINUS_SRC_ALPHA)

        // Fade clouds: fully visible at zoom ≤3, fully gone at zoom ≥6
        const zoom = mapRef?.getZoom() ?? 0
        const zoomFade = 1.0 - Math.max(0, Math.min(1, (zoom - 3) / 3))

        gl2.useProgram(clouds.program)
        gl2.uniformMatrix4fv(clouds.matrixLoc, false, matrix)
        gl2.uniform3f(clouds.sunDirLoc, sunDir[0], sunDir[1], sunDir[2])
        gl2.uniform1f(clouds.radiusLoc, CLOUD_RADIUS * terrainRadiusScale)
        gl2.uniform1f(clouds.opacityLoc, CLOUD_OPACITY)
        gl2.uniform1f(clouds.alphaGammaLoc, CLOUD_ALPHA_GAMMA)
        gl2.uniform1f(clouds.nightDarkeningLoc, CLOUD_NIGHT_DARKENING)
        gl2.uniform1f(clouds.zoomFadeLoc, zoomFade)

        gl2.activeTexture(gl2.TEXTURE0)
        gl2.bindTexture(gl2.TEXTURE_2D, cloudTex)
        gl2.uniform1i(clouds.cloudTexLoc, 0)

        gl2.drawElements(gl2.TRIANGLES, indexCount, gl2.UNSIGNED_SHORT, 0)
      }

      // Restore MapLibre's expected GL state
      gl2.bindVertexArray(null)
      gl2.disable(gl2.BLEND)
      gl2.enable(gl2.DEPTH_TEST)
      gl2.disable(gl2.CULL_FACE)
    },

    onRemove(_map: MaplibreMap, gl: WebGL2RenderingContext | WebGLRenderingContext) {
      const gl2 = gl as WebGL2RenderingContext
      if (skyboxProg) gl2.deleteProgram(skyboxProg)
      for (const tex of skyboxFaceTextures) if (tex) gl2.deleteTexture(tex)
      if (dataset) gl2.deleteProgram(dataset.program)
      if (darken) gl2.deleteProgram(darken.program)
      if (lights) gl2.deleteProgram(lights.program)
      if (specular) gl2.deleteProgram(specular.program)
      if (clouds) gl2.deleteProgram(clouds.program)
      if (vao) gl2.deleteVertexArray(vao)
      if (nightTex) gl2.deleteTexture(nightTex)
      if (specTex) gl2.deleteTexture(specTex)
      if (cloudTex) gl2.deleteTexture(cloudTex)
      if (datasetTex) gl2.deleteTexture(datasetTex)
    },
  }

  return {
    layer,
    ready: readyPromise,
    setSunPosition(lat: number, lng: number) {
      sunOverride = { lat, lng }
      if (mapRef) {
        syncAtmosphereLight(mapRef, lat, lng)
        mapRef.triggerRepaint()
      }
    },
    clearSunOverride() {
      sunOverride = null
      if (mapRef) {
        const sun = getSunPosition(new Date())
        syncAtmosphereLight(mapRef, sun.lat, sun.lng)
        mapRef.triggerRepaint()
      }
    },
    setVisible(v: boolean) {
      visible = v
      mapRef?.triggerRepaint()
    },
    setTerrainExaggeration(exaggeration: number) {
      // Match MapLibre's globe terrain formula: displacement = exag * elevation / GLOBE_RADIUS
      // where GLOBE_RADIUS = 6_371_008.8 (from maplibre-gl/src/geo/lng_lat.ts).
      // Max elevation ~8848m (Everest). Add 5% margin to prevent z-fighting.
      const MAX_ELEVATION_M = 8848
      const GLOBE_RADIUS = 6_371_008.8
      terrainRadiusScale = 1.0 + (MAX_ELEVATION_M * exaggeration / GLOBE_RADIUS) * 1.05
      mapRef?.triggerRepaint()
    },
    setDatasetTexture(image: HTMLCanvasElement | HTMLImageElement) {
      if (!glRef) return
      datasetVideo = null // clear any previous video
      if (!datasetTex) {
        datasetTex = glRef.createTexture()
      }
      glRef.bindTexture(glRef.TEXTURE_2D, datasetTex)
      glRef.texImage2D(glRef.TEXTURE_2D, 0, glRef.RGBA, glRef.RGBA, glRef.UNSIGNED_BYTE, image)
      glRef.generateMipmap(glRef.TEXTURE_2D)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_MIN_FILTER, glRef.LINEAR_MIPMAP_LINEAR)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_MAG_FILTER, glRef.LINEAR)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_WRAP_S, glRef.REPEAT)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_WRAP_T, glRef.CLAMP_TO_EDGE)
      datasetActive = true
      mapRef?.triggerRepaint()
    },
    setDatasetVideo(video: HTMLVideoElement) {
      if (!glRef) return
      datasetVideo = video
      if (!datasetTex) {
        datasetTex = glRef.createTexture()
      }
      // Initialize with a single frame — render loop will update per-frame
      glRef.bindTexture(glRef.TEXTURE_2D, datasetTex)
      glRef.texImage2D(glRef.TEXTURE_2D, 0, glRef.RGBA, glRef.RGBA, glRef.UNSIGNED_BYTE, video)
      // No mipmaps for video — LINEAR only (regenerating mipmaps per frame is expensive)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_MIN_FILTER, glRef.LINEAR)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_MAG_FILTER, glRef.LINEAR)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_WRAP_S, glRef.REPEAT)
      glRef.texParameteri(glRef.TEXTURE_2D, glRef.TEXTURE_WRAP_T, glRef.CLAMP_TO_EDGE)
      datasetActive = true
      mapRef?.triggerRepaint()
    },
    clearDatasetTexture() {
      datasetActive = false
      datasetVideo = null
      mapRef?.triggerRepaint()
    },
  }
}
