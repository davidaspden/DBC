/**
 * L4 — Recessed Tote Face, Protruding Lips, Interlock Geometry & Ray Parallax Occlusion (`src/sim/lips.js`).
 *
 * Models each tote face as a flat recessed panel (`z = 0`) behind a protruding molded rim
 * (`z = lipHeightIn`):
 *  - `lipHeightIn` (default 0.75 in, OQ8)
 *  - `lipWidthIn` (default 0.65 in)
 *  - `interlockOffsetIn` (default 0.25 in — upper tote overlaps top lip downward)
 *  - Upper lip shadow band (`shadowBandIn`, `shadowDarken`)
 *  - Protruding lip-edge highlight (`lipHighlight`)
 *  - True 3D ray parallax occlusion: camera ray intersects `z = lipHeightIn` before `z = 0`,
 *    occluding label edges at oblique yaw/pitch angles.
 *
 * Mirrored identically in `src/sim/cpu-render.js` and `src/sim/webgl-wall.js`.
 * Zero allocations in per-pixel hot loops.
 */

export const DEFAULT_LIPS_SPEC = Object.freeze({
  enabled: true,
  lipHeightIn: 0.75,
  lipWidthIn: 0.65,
  interlockOffsetIn: 0.25,
  shadowBandIn: 1.25,
  shadowDarken: 0.45,
  lipHighlight: 0.22,
});

/**
 * Normalizes a lips configuration object.
 * Returns `null` when lips are disabled (`null`, `undefined`, `false`, or `{ enabled: false }`).
 *
 * @param {object | boolean | null | undefined} lips
 * @returns {object | null}
 */
export function normalizeLipsSpec(lips) {
  if (!lips || lips === false) return null;
  if (lips === true) {
    return { ...DEFAULT_LIPS_SPEC };
  }
  if (lips.enabled === false) return null;

  const lipHeightIn = Number.isFinite(lips.lipHeightIn) && lips.lipHeightIn >= 0
    ? lips.lipHeightIn
    : DEFAULT_LIPS_SPEC.lipHeightIn;
  const lipWidthIn = Number.isFinite(lips.lipWidthIn) && lips.lipWidthIn >= 0
    ? lips.lipWidthIn
    : DEFAULT_LIPS_SPEC.lipWidthIn;
  const interlockOffsetIn = Number.isFinite(lips.interlockOffsetIn) && lips.interlockOffsetIn >= 0
    ? lips.interlockOffsetIn
    : DEFAULT_LIPS_SPEC.interlockOffsetIn;
  const shadowBandIn = Number.isFinite(lips.shadowBandIn) && lips.shadowBandIn >= 0
    ? lips.shadowBandIn
    : DEFAULT_LIPS_SPEC.shadowBandIn;
  const shadowDarken = Number.isFinite(lips.shadowDarken)
    ? Math.max(0, Math.min(0.9, lips.shadowDarken))
    : DEFAULT_LIPS_SPEC.shadowDarken;
  const lipHighlight = Number.isFinite(lips.lipHighlight)
    ? Math.max(0, Math.min(1.0, lips.lipHighlight))
    : DEFAULT_LIPS_SPEC.lipHighlight;

  return {
    enabled: true,
    lipHeightIn,
    lipWidthIn,
    interlockOffsetIn,
    shadowBandIn,
    shadowDarken,
    lipHighlight,
  };
}

/**
 * Computes the recessed opening bounds inside a tote cell in local tote coordinates (inches).
 *
 * @param {number} halfToteW
 * @param {number} halfToteH
 * @param {object} lips - normalized lips spec
 */
export function computeToteOpening(halfToteW, halfToteH, lips) {
  const openHalfW = Math.max(0.5, halfToteW - lips.lipWidthIn);
  const openTopY = Math.max(0.5, halfToteH - lips.lipWidthIn - lips.interlockOffsetIn);
  const openBotY = -Math.max(0.5, halfToteH - lips.lipWidthIn);
  return { openHalfW, openTopY, openBotY };
}

/**
 * Closed-form ray parallax occlusion of a recessed label edge behind a protruding lip.
 *
 * A ray arriving at oblique angle `angleDeg` (yaw for vertical edges, pitch for horizontal edges)
 * shifts laterally by `lipHeightIn * tan(|angleDeg|)` between `z = 0` and `z = lipHeightIn`.
 *
 * @param {{
 *   lipHeightIn?: number,
 *   gapToLipIn?: number,
 *   angleDeg: number,
 *   labelSpanIn: number,
 * }} params
 * @returns {{ shiftIn: number, occludedIn: number, occludedFraction: number, visibleFraction: number }}
 */
export function computeLipOcclusionFraction({
  lipHeightIn = DEFAULT_LIPS_SPEC.lipHeightIn,
  gapToLipIn = 0,
  angleDeg,
  labelSpanIn,
}) {
  const rad = Math.abs(angleDeg) * (Math.PI / 180);
  const shiftIn = lipHeightIn * Math.tan(rad);
  const rawOccluded = shiftIn - Math.max(0, gapToLipIn);
  const occludedIn = Math.max(0, Math.min(labelSpanIn, rawOccluded));
  const occludedFraction = labelSpanIn > 0 ? occludedIn / labelSpanIn : 0;
  return {
    shiftIn,
    occludedIn,
    occludedFraction,
    visibleFraction: 1 - occludedFraction,
  };
}

/**
 * Computes the intersection of a camera ray (passing through `(wx, wy, 0)` with direction `(Dx, Dy, Dz)`, `Dz < 0`)
 * with the protruding lip plane `z = lipHeightIn`.
 * Writes `[wxLip, wyLip]` into `out` (zero allocation).
 *
 * @param {number} wx
 * @param {number} wy
 * @param {number} Dx
 * @param {number} Dy
 * @param {number} Dz
 * @param {number} lipHeightIn
 * @param {Float64Array | number[]} out
 */
export function intersectLipPlane(wx, wy, Dx, Dy, Dz, lipHeightIn, out) {
  const scale = lipHeightIn / Dz; // Dz < 0 -> shifts toward camera side
  out[0] = wx + scale * Dx;
  out[1] = wy + scale * Dy;
  return out;
}

/**
 * Computes the upper-lip shadow attenuation factor in `(0, 1]` for a visible recessed point at local `ly`.
 * `1.0` = no shadow; `< 1.0` = inside the upper shadow band below `openTopY`.
 *
 * @param {number} ly
 * @param {number} openTopY
 * @param {number} shadowBandIn
 * @param {number} shadowDarken
 * @returns {number}
 */
export function computeUpperLipShadowFactor(ly, openTopY, shadowBandIn, shadowDarken) {
  if (shadowBandIn <= 1e-6 || shadowDarken <= 1e-6) return 1.0;
  const distBelowTop = openTopY - ly;
  if (distBelowTop < 0 || distBelowTop >= shadowBandIn) return 1.0;
  const t = 1.0 - distBelowTop / shadowBandIn;
  // Smooth quadratic falloff strongest directly under the protruding upper lip
  return 1.0 - shadowDarken * t * t;
}
