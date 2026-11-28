/**
 * A7 — Hold Attitude Preflight Classifier & 8-Way Dihedral Axis Remap Solver (`src/array/setup.js`).
 *
 * Pure zero-DOM math so all start-orientation edge cases (portrait, landscape, rolled 15°,
 * tilted 20°, 8 axis permutations/sign flips) are unit-tested deterministically in Node.
 */

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Classifies phone hold attitude before/at zeroing.
 *
 * @param {{
 *   rollDeg: number,
 *   pitchDeg: number,
 *   screenAngle?: number,
 *   frameW?: number,
 *   frameH?: number,
 *   labelOrientation?: 'ladder' | 'picket'
 * }} info
 */
export function classifyHold(info) {
  const rollDeg = info.rollDeg || 0;
  const pitchDeg = info.pitchDeg || 0;
  const absRoll = Math.abs(rollDeg);
  const absPitch = Math.abs(pitchDeg);
  const frameW = info.frameW || 1920;
  const frameH = info.frameH || 1080;
  const labelOri = info.labelOrientation || 'ladder';
  const isLandscapeFrame = frameW > frameH;
  const scanOnShortAxis = (labelOri === 'ladder' && isLandscapeFrame) || (labelOri === 'picket' && !isLandscapeFrame);

  if (absPitch > 40) {
    return {
      verdict: 'AIM_WALL',
      tone: 'warn',
      message: `Aim at the wall (pitch ${Math.round(pitchDeg)}°)`,
      scanOnShortAxis,
    };
  }
  if (absRoll > 25) {
    return {
      verdict: 'ROTATED',
      tone: 'warn',
      message: scanOnShortAxis
        ? `Rotated (${Math.round(rollDeg)}°) — portrait gives ~78% more pixels along the label`
        : `Phone rotated (${Math.round(rollDeg)}°) — roll compensated automatically`,
      scanOnShortAxis,
    };
  }
  if (absRoll > 10) {
    return {
      verdict: 'LEVEL_PHONE',
      tone: 'warn',
      message: `Level the phone (roll ${Math.round(rollDeg)}° — compensated)`,
      scanOnShortAxis,
    };
  }
  return {
    verdict: 'OK',
    tone: 'good',
    message: `Level & square (roll ${Math.round(rollDeg)}°, pitch ${Math.round(pitchDeg)}°)`,
    scanOnShortAxis,
  };
}

/**
 * The 8 elements of the dihedral group D4 (axis swap + sign flips) for camera-to-sensor axis remapping.
 */
export const AXIS_REMAPS = Object.freeze([
  { id: 0, swap: false, sx:  1, sy:  1, label: 'identity (+x, +y)' },
  { id: 1, swap: false, sx: -1, sy:  1, label: 'invertPan (-x, +y)' },
  { id: 2, swap: false, sx:  1, sy: -1, label: 'invertTilt (+x, -y)' },
  { id: 3, swap: false, sx: -1, sy: -1, label: 'invertBoth (-x, -y)' },
  { id: 4, swap: true,  sx:  1, sy:  1, label: 'swap (+y, +x)' },
  { id: 5, swap: true,  sx: -1, sy:  1, label: 'rot90CW (-y, +x)' },
  { id: 6, swap: true,  sx:  1, sy: -1, label: 'rot90CCW (+y, -x)' },
  { id: 7, swap: true,  sx: -1, sy: -1, label: 'swapFlip (-y, -x)' },
]);

export function applyAxisRemap(rx, ry, remap) {
  if (!remap || remap.id === 0) return { x: rx, y: ry };
  if (remap.swap) {
    return { x: remap.sx * ry, y: remap.sy * rx };
  }
  return { x: remap.sx * rx, y: remap.sy * ry };
}

/**
 * Solves which of the 8 D4 camera-to-sensor axis remaps best aligns observed unit-tangent
 * projections `reads = [{ tx, ty, expectedX, expectedY }]` onto the wall lattice at standoff `distanceIn`.
 *
 * Returns `{ improved, remap, bestErrIn, currentErrIn }`.
 */
export function solveAxisRemap(reads, { distanceIn = 30, pitchXIn = 14, pitchYIn = 16, currentRemapId = 0 } = {}) {
  if (!Array.isArray(reads) || reads.length < 3) {
    return { improved: false, remap: AXIS_REMAPS[currentRemapId] || AXIS_REMAPS[0], bestErrIn: Infinity, currentErrIn: Infinity };
  }

  const evalRemap = (remap) => {
    const dxs = [];
    const dys = [];
    const pts = [];
    for (let i = 0; i < reads.length; i++) {
      const r = reads[i];
      const m = applyAxisRemap(r.tx, r.ty, remap);
      const wx = distanceIn * m.x;
      const wy = distanceIn * m.y;
      pts.push({ wx, wy, ex: r.expectedX, ey: r.expectedY });
      dxs.push(r.expectedX - wx);
      dys.push(r.expectedY - wy);
    }
    dxs.sort((a, b) => a - b);
    dys.sort((a, b) => a - b);
    const medX = dxs[dxs.length >> 1];
    const medY = dys[dys.length >> 1];

    let errSum = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      errSum += Math.hypot((p.wx + medX) - p.ex, (p.wy + medY) - p.ey);
    }
    return errSum / pts.length;
  };

  const curRemap = AXIS_REMAPS[currentRemapId] || AXIS_REMAPS[0];
  const currentErrIn = evalRemap(curRemap);
  let bestRemap = curRemap;
  let bestErrIn = currentErrIn;

  for (let i = 0; i < AXIS_REMAPS.length; i++) {
    const err = evalRemap(AXIS_REMAPS[i]);
    if (err < bestErrIn - 1e-6) {
      bestErrIn = err;
      bestRemap = AXIS_REMAPS[i];
    }
  }

  const minPitch = Math.min(pitchXIn, pitchYIn);
  const improved =
    bestRemap.id !== curRemap.id &&
    bestErrIn < minPitch * 0.25 &&
    bestErrIn < currentErrIn * 0.6;

  return {
    improved,
    remap: bestRemap,
    bestErrIn: Math.round(bestErrIn * 100) / 100,
    currentErrIn: Math.round(currentErrIn * 100) / 100,
  };
}

/**
 * Extracts world-relative gravity pitch & roll (degrees) from a gravity-aligned device quaternion
 * `qWorldFromCam` (world +Z = up, camera forward = (0,0,-1), camera image-up = (0,1,0)).
 */
export function extractGravityPitchRollDeg(qWorldFromCam, rotateFn) {
  const f = new Float64Array(3);
  const u = new Float64Array(3);
  const r = new Float64Array(3);
  rotateFn(qWorldFromCam, 0, 0, -1, f);
  rotateFn(qWorldFromCam, 0, 1, 0, u);
  rotateFn(qWorldFromCam, 1, 0, 0, r);

  // Elevation of optical axis above horizontal (world Z = up)
  const pitchDeg = Math.asin(Math.max(-1, Math.min(1, f[2]))) * RAD_TO_DEG;
  // Signed roll: projection of world-up (0,0,1) onto camera right r vs image-up u
  const rollDeg = Math.atan2(r[2], u[2]) * RAD_TO_DEG;
  return { pitchDeg, rollDeg };
}
