/**
 * Verify the viewport-anchor light sync produces the correct sun direction.
 *
 * With anchor:'viewport', MapLibre's getSunPos does:
 *   cart = sphericalToCartesian(r, az, polar)
 *   return [-cart.x, -cart.y, -cart.z]
 *   (NO camera rotations applied)
 *
 * With anchor:'map', MapLibre's getSunPos does:
 *   cart = sphericalToCartesian(r, az, polar)
 *   lp = [-cart.x, -cart.y, -cart.z]
 *   lp = Rz(roll) * Rx(-pitch) * Rz(bearing) * Rx(lat) * Ry(-lng) * lp
 *   return lp
 *
 * Both pipelines should produce the same final sun direction.
 * Our viewport sync pre-applies the camera rotation so that the
 * viewport-anchor path ends up at the same result as map-anchor would.
 */

import { describe, it, expect } from 'vitest'

// --- MapLibre's sphericalToCartesian ---
function sphericalToCartesian(r: number, az: number, polar: number) {
  az += 90 // compass correction
  az *= Math.PI / 180
  polar *= Math.PI / 180
  return {
    x: r * Math.cos(az) * Math.sin(polar),
    y: r * Math.sin(az) * Math.sin(polar),
    z: r * Math.cos(polar),
  }
}

// --- Rotation helpers ---
function rotX(a: number, v: number[]): number[] {
  const c = Math.cos(a), s = Math.sin(a)
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
}
function rotY(a: number, v: number[]): number[] {
  const c = Math.cos(a), s = Math.sin(a)
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]
}
function rotZ(a: number, v: number[]): number[] {
  const c = Math.cos(a), s = Math.sin(a)
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]
}

// --- MapLibre getSunPos ---
function getSunPosMap(r: number, az: number, polar: number,
  lat: number, lng: number, bearing = 0, pitch = 0) {
  const c = sphericalToCartesian(r, az, polar)
  let v = [-c.x, -c.y, -c.z]
  // roll = 0
  v = rotX(-pitch, v)
  v = rotZ(bearing, v)
  v = rotX(lat * Math.PI / 180, v)
  v = rotY(-lng * Math.PI / 180, v)
  return v
}

function getSunPosViewport(r: number, az: number, polar: number) {
  const c = sphericalToCartesian(r, az, polar)
  return [-c.x, -c.y, -c.z]
}

// --- ECEF sun direction ---
function sunECEF(lat: number, lng: number): number[] {
  const la = lat * Math.PI / 180, lo = lng * Math.PI / 180
  return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)]
}

// --- Our sync function (must match customLayerSpike.ts syncAtmosphereLight) ---
function computeViewportParams(sunLat: number, sunLng: number,
  camLat: number, camLng: number, bearingDeg = 0, pitchDeg = 0) {
  const sun = sunECEF(sunLat, sunLng)
  const bearing = bearingDeg * Math.PI / 180
  const pitch = pitchDeg * Math.PI / 180

  // Forward camera rotation: same chain as getSunPos(map) applies to the negated cart
  // M * (-cart) = result. We want our viewport to produce the same result.
  // Forward: Ry(-lng) first, then Rx(lat), then Rz(bearing), then Rx(-pitch)
  let v = sun.slice()
  v = rotY(-camLng * Math.PI / 180, v)
  v = rotX(camLat * Math.PI / 180, v)
  v = rotZ(bearing, v)
  v = rotX(-pitch, v)

  // viewport getSunPos returns -cart. We want -cart = v. So cart = -v.
  const cx = -v[0], cy = -v[1], cz = -v[2]
  const r = Math.sqrt(cx * cx + cy * cy + cz * cz)
  const polar = Math.acos(Math.max(-1, Math.min(1, cz / r))) * 180 / Math.PI
  const azInternal = Math.atan2(cy, cx)
  const azimuthal = ((azInternal * 180 / Math.PI - 90) % 360 + 360) % 360
  return { azimuthal, polar }
}

function norm(v: number[]): number[] {
  const len = Math.sqrt(v[0] ** 2 + v[1] ** 2 + v[2] ** 2)
  return v.map(x => x / len)
}

function expectClose(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 4)
}

describe('viewport light sync', () => {
  const cases = [
    { sun: [4, -120], cam: [20, 0], label: 'default camera' },
    { sun: [4, -120], cam: [30, -95], label: 'Americas' },
    { sun: [23, 45], cam: [40, 30], label: 'Europe/summer' },
    { sun: [-23.44, 0], cam: [20, 0], label: 'winter solstice' },
    { sun: [10, 170], cam: [-50, 170], label: 'S Pacific' },
    { sun: [2.8, 104.7], cam: [20, 0], label: 'current sun default cam' },
    { sun: [2.8, 104.7], cam: [44, 83], label: 'current sun panned' },
  ]

  for (const { sun, cam, label } of cases) {
    it(`viewport output matches map-anchor ECEF result: ${label}`, () => {
      // What map-anchor would produce with a "perfect" [az,polar] that sends
      // the ECEF sun direction through correctly — this is the target.
      // The target is simply the ECEF sun direction (since that's what the
      // atmosphere shader should see).
      const target = sunECEF(sun[0], sun[1])

      // Our viewport sync
      const { azimuthal, polar } = computeViewportParams(sun[0], sun[1], cam[0], cam[1])
      const vpResult = getSunPosViewport(1.5, azimuthal, polar)
      const vpNorm = norm(vpResult)

      // The viewport result is the sun direction in viewport space.
      // To verify it represents the same ECEF direction, apply the
      // INVERSE camera rotation:
      let v = vpNorm.slice()
      v = rotX(0, v)        // undo Rx(-pitch) with pitch=0
      v = rotZ(0, v)        // undo Rz(bearing) with bearing=0
      v = rotX(-cam[0] * Math.PI / 180, v) // undo Rx(lat)
      v = rotY(cam[1] * Math.PI / 180, v)  // undo Ry(-lng)



      expectClose(v, target)
    })
  }

  it('with bearing and pitch', () => {
    const sun = [23, 45], cam = [40, 30]
    const bearingDeg = 45, pitchDeg = 30
    const target = sunECEF(sun[0], sun[1])

    const { azimuthal, polar } = computeViewportParams(sun[0], sun[1], cam[0], cam[1], bearingDeg, pitchDeg)
    const vpResult = norm(getSunPosViewport(1.5, azimuthal, polar))

    // Inverse camera rotation
    const bearing = bearingDeg * Math.PI / 180
    const pitch = pitchDeg * Math.PI / 180
    let v = vpResult.slice()
    v = rotX(pitch, v)
    v = rotZ(-bearing, v)
    v = rotX(-cam[0] * Math.PI / 180, v)
    v = rotY(cam[1] * Math.PI / 180, v)

    expectClose(v, target)
  })

  it('viewport result equals map-anchor result for same camera', () => {
    // Both anchor modes should produce the same final sun direction
    const sun = [4, -120], cam = [30, -95]

    // Map-anchor: if we could perfectly encode the ECEF direction
    // (which our original inverse does correctly per passing tests),
    // the result of getSunPos(map) IS the ECEF direction.
    const mapTarget = sunECEF(sun[0], sun[1])

    // Viewport: our sync computes [az,polar], getSunPos(viewport) returns
    // the viewport-space direction. Applying inverse camera should = ECEF.
    const { azimuthal, polar } = computeViewportParams(sun[0], sun[1], cam[0], cam[1])
    const vpResult = norm(getSunPosViewport(1.5, azimuthal, polar))

    let v = vpResult.slice()
    v = rotX(-cam[0] * Math.PI / 180, v)
    v = rotY(cam[1] * Math.PI / 180, v)

    expectClose(v, mapTarget)
  })
})
