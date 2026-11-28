/**
 * A1 — Fulfillment Center (FC) Label & Tote Geometry Profiles (`src/array/config.js`).
 *
 * Keeps tote face orientation (`14Wx16H` vs `16Wx14H`, OQ1) and label orientation
 * (`ladder` = horizontal bars / vertical scan 90° vs `picket` = vertical bars / horizontal scan 0°, OQ2)
 * strictly configurable rather than hard-coded.
 */

/**
 * Computes total Code 128 module count:
 * `11 * chars + 11 (Start) + 11 (Check) + 13 (Stop) + 2 * quietModules`.
 */
export function computeCode128Modules(payloadOrChars = 11, quietModules = 10) {
  const chars = typeof payloadOrChars === 'string'
    ? payloadOrChars.length
    : ((payloadOrChars | 0) > 0 ? (payloadOrChars | 0) : 11);
  const quiet = (quietModules | 0) >= 0 ? (quietModules | 0) : 10;
  return 11 * chars + 11 + 11 + 13 + 2 * quiet;
}

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
  provenance: 'unconfirmed',
  toteOrientation: '16Wx14H', // UNCONFIRMED (OQ1: 16 in wide x 14 in high provisional; wall 64 x 56 in)
  pitchXIn: 16,
  pitchYIn: 14,
  labelLenIn: 3.5,
  labelWidthIn: 2.0,
  payloadChars: 11, // OQ3: real sample tsX07wz7py1 is 11 chars (176 modules with 2x10 quiet zones)
  labelModules: computeCode128Modules(11),
  labelOrientation: 'ladder', // UNCONFIRMED (OQ2: horizontal bars, vertical 90 deg scan; seen on tsX07wz7py1 still)
  expectedScanDeg: 90,
  distanceIn: 12, // A53 1x optically infeasible at 30 in (< 1 ppm); use 12 in or 2x ISP crop / 4K crop
  hfovDeg: 70.7,
});

/**
 * Resolves an FC profile with optional parameter overrides (OQ1–OQ3).
 */
export function resolveFcProfile(overrides = {}) {
  const payloadChars = overrides.payloadChars ?? FC_PROFILE.payloadChars;
  const quietModules = overrides.quietModules ?? 10;
  const pitch = overrides.toteOrientation ? resolveTotePitch(overrides.toteOrientation) : null;
  return {
    ...FC_PROFILE,
    ...(pitch || {}),
    ...overrides,
    payloadChars,
    labelModules: overrides.labelModules ?? computeCode128Modules(payloadChars, quietModules),
  };
}

/**
 * Resolves `(pitchXIn, pitchYIn)` for `'14Wx16H'` vs `'16Wx14H'` tote orientation (OQ1).
 */
export function resolveTotePitch(toteOrientation = '14Wx16H') {
  if (toteOrientation === '16Wx14H') {
    return { pitchXIn: 16, pitchYIn: 14 };
  }
  return { pitchXIn: 14, pitchYIn: 16 };
}
