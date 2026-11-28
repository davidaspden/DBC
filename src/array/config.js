/**
 * A1 — Fulfillment Center (FC) Label & Tote Geometry Profiles (`src/array/config.js`).
 *
 * Keeps tote face orientation (`14Wx16H` vs `16Wx14H`, OQ1) and label orientation
 * (`ladder` = horizontal bars / vertical scan 90° vs `picket` = vertical bars / horizontal scan 0°, OQ2)
 * strictly configurable rather than hard-coded.
 */

export const LEGACY_PROFILE = Object.freeze({
  toteOrientation: '14Wx16H',
  pitchXIn: 14,
  pitchYIn: 16,
  labelLenIn: 6.0,
  labelWidthIn: 2.0,
  payloadChars: 16,
  labelModules: 231,
  labelOrientation: 'ladder',
  expectedScanDeg: 90,
  distanceIn: 30,
  hfovDeg: 70.7,
});

export const FC_PROFILE = Object.freeze({
  toteOrientation: '16Wx14H', // Confirmed OQ1: 16 in wide x 14 in high (wall 64 x 56 in)
  pitchXIn: 16,
  pitchYIn: 14,
  labelLenIn: 3.5,
  labelWidthIn: 2.0,
  payloadChars: 12,
  labelModules: 187, // 11 * 12 + 35 + 20 quiet zones
  labelOrientation: 'ladder', // Confirmed OQ2: horizontal bars, vertical 90 deg scan
  expectedScanDeg: 90,
  distanceIn: 12, // A53 1x optically infeasible at 30 in (< 1 ppm); use 12 in or 2x ISP crop / 4K crop
  hfovDeg: 70.7,
});

/**
 * Resolves `(pitchXIn, pitchYIn)` for `'14Wx16H'` vs `'16Wx14H'` tote orientation (OQ1).
 */
export function resolveTotePitch(toteOrientation = '14Wx16H') {
  if (toteOrientation === '16Wx14H') {
    return { pitchXIn: 16, pitchYIn: 14 };
  }
  return { pitchXIn: 14, pitchYIn: 16 };
}
