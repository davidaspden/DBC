/**
 * M4 — AR wall tracker (`src/ar/tracker.js`), behind the `arWall` sim flag (default OFF).
 *
 * Per frame: M2 dots -> M3 matcher -> homography -> `pose.js` camera pose. State machine:
 *
 *   LOCKED     the previous map, moved by the measured image velocity (and optionally the gyro),
 *              re-fits to the dots (`matcher.track`, ~0.04 ms): pose is measured;
 *   COASTING   the re-fit failed (blur, occlusion, too few dots): the pose is predicted from the
 *              last map and the damped velocity for up to `maxCoast` frames (default 6);
 *   LOST       coasting ran out: a cold-start `matcher.match` runs every frame, seeded with priors
 *              (the caller's stance / gyro priors, else the last good pose with wide tolerances);
 *   DISABLED   the flag is off (nothing is read or written; `update` returns at once).
 *
 * `arGyroPrior` (a separate default-off sim flag) is honoured by passing a camera rotation increment
 * `rotDelta` (see `rotDeltaFromGyro`): the previous map is pre-rotated by `K Rd K^-1` before the re-fit.
 *
 * Memory: everything is allocated in `createWallTracker`; `update` reuses typed arrays and one status
 * record (no object/array literals, closures or subarray calls on the frame path).
 */
import { createDotDetector } from './dots.js';
import { createWallMatcher } from './lattice.js';
import { createPoseSolver, createPoseResult } from './pose.js';
import { invert3, project } from './homography.js';
import { isSimOn } from '../sim/simflags.js';

export const TRACK_DISABLED = 0;
export const TRACK_LOST = 1;
export const TRACK_COASTING = 2;
export const TRACK_LOCKED = 3;
export const TRACK_STATE_NAMES = Object.freeze(['DISABLED', 'LOST', 'COASTING', 'LOCKED']);

/**
 * Camera rotation increment from a gyro sample: `out = exp(-[w] dt)` (row-major 3x3), w in rad/s in the
 * camera frame (x right, y down, z forward, right-handed). New camera coords = out * old camera coords.
 */
export function rotDeltaFromGyro(wx, wy, wz, dt, out) {
  const ax = wx * dt; const ay = wy * dt; const az = wz * dt;
  const th = Math.hypot(ax, ay, az);
  if (th < 1e-12) { out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0; out[4] = 1; out[5] = 0; out[6] = 0; out[7] = 0; out[8] = 1; return out; }
  const kx = ax / th; const ky = ay / th; const kz = az / th;
  const c = Math.cos(-th); const s = Math.sin(-th); const v = 1 - c;
  out[0] = c + kx * kx * v; out[1] = kx * ky * v - kz * s; out[2] = kx * kz * v + ky * s;
  out[3] = ky * kx * v + kz * s; out[4] = c + ky * ky * v; out[5] = ky * kz * v - kx * s;
  out[6] = kz * kx * v - ky * s; out[7] = kz * ky * v + kx * s; out[8] = c + kz * kz * v;
  return out;
}

/**
 * @param {{ layout: object, width: number, height: number, hfovDeg?: number, fx?: number,
 *           enabled?: boolean, maxCoast?: number, minInliers?: number, maxRmsPx?: number,
 *           minDiameterPx?: number }} cfg
 */
export function createWallTracker(cfg) {
  const width = cfg.width | 0;
  const height = cfg.height | 0;
  const enabled = cfg.enabled === undefined ? isSimOn('arWall') : Boolean(cfg.enabled);
  const maxCoast = cfg.maxCoast ?? 6;
  const minInliers = cfg.minInliers ?? 6;
  const maxRms = cfg.maxRmsPx ?? 1.0;
  const fx = cfg.fx || (width / 2) / Math.tan(((cfg.hfovDeg || 60) * Math.PI) / 360);
  const fy = fx;
  const cx = width / 2;
  const cy = height / 2;

  const detector = createDotDetector({ width, height, maxDots: cfg.maxDots || 256 });
  const matcher = createWallMatcher({ layout: cfg.layout, maxDets: cfg.maxDots || 256 });
  const poseSolver = createPoseSolver();

  const H = new Float64Array(9); // current wall->image map
  const Hprev = new Float64Array(9);
  const Hpred = new Float64Array(9);
  const Hinv = new Float64Array(9);
  const A = new Float64Array(9);
  const tmp = new Float64Array(9);
  const p0 = new Float64Array(2);
  const p1 = new Float64Array(2);
  const model = matcher.model;

  const matchOpts = { width, height, minInliers, maxRmsPx: maxRms, minDiameterPx: cfg.minDiameterPx || 10,
    centerX: undefined, centerY: undefined, centerTolIn: 12, axisAngleDeg: undefined, axisTolDeg: 30 };
  const trackOpts = { width, height, minInliers, tolFrac: 0.25, minDiameterPx: cfg.minDiameterPx || 10 };
  let havePriors = false;
  let haveLast = false;
  // scalar state lives in a typed array: a closure-captured `let` holding a double boxes a heap number per write
  const sc = new Float64Array(5); // 0 refX, 1 refY (wall centroid of the last matched dots), 2 vx, 3 vy (px/frame), 4 coast frames

  const status = {
    state: enabled ? TRACK_LOST : TRACK_DISABLED,
    frame: 0,
    dots: 0,
    inliers: 0,
    rmsPx: 0,
    coast: 0,
    poseValid: false,
    pose: createPoseResult(),
    H,
    lockedFrames: 0,
    totalFrames: 0,
  };

  /** Caller priors for cold starts (stance from the user, roll from the gyro). Pass undefined to clear. */
  function setPriors(centerX, centerY, centerTolIn, axisAngleDeg, axisTolDeg) {
    matchOpts.centerX = centerX; matchOpts.centerY = centerY; matchOpts.centerTolIn = centerTolIn ?? 12;
    matchOpts.axisAngleDeg = axisAngleDeg; matchOpts.axisTolDeg = axisTolDeg ?? 30;
    havePriors = centerX !== undefined || axisAngleDeg !== undefined;
  }

  function multiply3(Aa, Bb, out) {
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) out[r * 3 + c] = Aa[r * 3] * Bb[c] + Aa[r * 3 + 1] * Bb[3 + c] + Aa[r * 3 + 2] * Bb[6 + c];
    }
  }

  /** Hpred = T(v) * (K Rd K^-1) * H */
  function predict(rotDelta, damp) {
    if (rotDelta) {
      // A = K Rd K^-1
      // Kinv = [[1/fx 0 -cx/fx],[0 1/fy -cy/fy],[0 0 1]]
      tmp[0] = 1 / fx; tmp[1] = 0; tmp[2] = -cx / fx; tmp[3] = 0; tmp[4] = 1 / fy; tmp[5] = -cy / fy; tmp[6] = 0; tmp[7] = 0; tmp[8] = 1;
      multiply3(rotDelta, tmp, A); // Rd Kinv
      // K * (Rd Kinv)
      for (let c = 0; c < 3; c++) {
        const a0 = A[c]; const a1 = A[3 + c]; const a2 = A[6 + c];
        tmp[c] = fx * a0 + cx * a2; tmp[3 + c] = fy * a1 + cy * a2; tmp[6 + c] = a2;
      }
      multiply3(tmp, H, Hpred);
    } else {
      for (let k = 0; k < 9; k++) Hpred[k] = H[k];
    }
    const dx = sc[2] * damp; const dy = sc[3] * damp;
    for (let c = 0; c < 3; c++) { Hpred[c] += dx * Hpred[6 + c]; Hpred[3 + c] += dy * Hpred[6 + c]; }
  }

  function centroidOfMatches(res, dots) {
    let sx = 0; let sy = 0; let n = 0;
    for (let d = 0; d < dots.count; d++) {
      const m = res.detToModel[d];
      if (m >= 0) { sx += model.x[m]; sy += model.y[m]; n++; }
    }
    if (n > 0) { sc[0] = sx / n; sc[1] = sy / n; }
    return n;
  }

  let gyroUsed = false;
  function accept(res, dots, fromTrack) {
    for (let k = 0; k < 9; k++) Hprev[k] = H[k];
    for (let k = 0; k < 9; k++) H[k] = res.H[k];
    const hadRef = haveLast;
    centroidOfMatches(res, dots);
    if (fromTrack && hadRef && !gyroUsed) {
      project(Hprev, sc[0], sc[1], p0);
      project(H, sc[0], sc[1], p1);
      // note: Hprev was not rotated by the gyro; the velocity is the residual image motion per frame
      sc[2] = 0.6 * (p1[0] - p0[0]) + 0.4 * sc[2];
      sc[3] = 0.6 * (p1[1] - p0[1]) + 0.4 * sc[3];
    } else { sc[2] = 0; sc[3] = 0; }
    haveLast = true;
    sc[4] = 0;
    status.coast = 0;
    status.state = TRACK_LOCKED;
    status.inliers = res.inliers;
    status.rmsPx = res.rmsPx;
  }

  function computePose() {
    status.poseValid = poseSolver.solve(H, fx, fy, cx, cy, sc[0], sc[1], status.pose);
  }

  /**
   * @param {Uint8Array} luma full frame
   * @param {Float64Array} [rotDelta] camera rotation increment since the last frame (needs `arGyroPrior` use)
   * @returns {typeof status} the reused status record
   */
  function update(luma, rotDelta) {
    if (!enabled) { status.state = TRACK_DISABLED; return status; }
    status.frame++;
    status.totalFrames++;
    gyroUsed = rotDelta !== undefined && rotDelta !== null;
    const dots = detector.detect(luma);
    status.dots = dots.count;
    let locked = false;

    if (haveLast && (status.state === TRACK_LOCKED || status.state === TRACK_COASTING)) {
      // with a gyro increment the pan is already in the prediction: no extra image-velocity term
      predict(rotDelta || null, rotDelta ? 0 : sc[4] === 0 ? 1 : Math.pow(0.5, sc[4]));
      const r = matcher.track(dots, Hpred, trackOpts);
      if (r.ok && r.inliers >= minInliers && r.rmsPx <= maxRms) {
        accept(r, dots, true);
        locked = true;
      } else {
        sc[4]++;
        status.coast = sc[4];
        if (sc[4] <= maxCoast) {
          for (let k = 0; k < 9; k++) H[k] = Hpred[k]; // predicted map (velocity-extrapolated)
          status.state = TRACK_COASTING;
          status.inliers = 0;
        } else {
          status.state = TRACK_LOST;
        }
      }
    }

    if (status.state === TRACK_LOST || !haveLast) {
      // cold start: stance/gyro priors if the caller gave them, else the last good pose with wide tolerances
      if (!havePriors && haveLast && invert3(H, Hinv)) {
        project(Hinv, cx, cy, p0);
        matchOpts.centerX = p0[0]; matchOpts.centerY = p0[1]; matchOpts.centerTolIn = 14;
        matchOpts.axisAngleDeg = undefined;
      }
      const r = matcher.match(dots, matchOpts);
      if (!havePriors) { matchOpts.centerX = undefined; matchOpts.centerY = undefined; }
      if (r.ok) { haveLast = false; accept(r, dots, false); haveLast = true; locked = true; status.coast = 0; }
    }

    if (status.state === TRACK_LOCKED || status.state === TRACK_COASTING) {
      computePose();
      if (status.state === TRACK_LOCKED) status.lockedFrames++;
    } else status.poseValid = false;
    return status;
  }

  function reset() {
    status.state = enabled ? TRACK_LOST : TRACK_DISABLED;
    haveLast = false; sc[4] = 0; sc[2] = 0; sc[3] = 0; status.poseValid = false;
  }

  return { update, setPriors, reset, status, enabled, detector, matcher, intrinsics: { fx, fy, cx, cy } };
}
