/**
 * A8 — Pan Model Upgrades (`panKalman` flag):
 *  - Angle-compensated label-size distance estimator: D = f * L * cos^2(phi) * cos(psi) / lenPx
 *  - Two-read damped Gauss-Newton self-calibration of focal length `f`, standoff `D`, and stance
 *  - Pre-allocated 3-state Kalman residual filter on x = [psi0Rad, pxIn, pyIn] (zero hot-loop allocs)
 *  - Camera-sensor latency cross-correlation tracker & analytical drift budget sigma
 */

const DEG_TO_RAD = Math.PI / 180;

/**
 * Estimates standoff distance D (inches) from measured barcode length `lenPx`, accounting for
 * foreshortening `cos^2(tilt) * cos(pan)` so outer columns do not underestimate D by ~22%.
 */
export function solveDistanceFromLabel({
  fPx,
  labelLenIn,
  lenPx,
  panRad = 0,
  tiltRad = 0,
  minIn = 6,
  maxIn = 50,
}) {
  if (!(fPx > 10 && labelLenIn > 0.5 && lenPx > 10)) return null;
  const cosTilt = Math.max(0.25, Math.cos(tiltRad));
  const cosPan = Math.max(0.25, Math.cos(panRad));
  const rawD = (fPx * labelLenIn * cosTilt * cosTilt * cosPan) / lenPx;
  const clampedD = Math.max(minIn, Math.min(maxIn, rawD));
  return { dIn: clampedD, rawDIn: rawD, clamped: clampedD !== rawD };
}

/**
 * Analytical drift uncertainty sigma (inches) combining gyro angle drift (amplified by sec^2(psi))
 * and body-sway random walk (~3 in / sqrt(s)).
 */
export function computeDriftSigmaIn(dIn, panRad, dtSec, gyroErrRadPerSec = 0.05 * DEG_TO_RAD) {
  const dt = Math.max(0, dtSec || 0);
  const cosPan = Math.max(0.25, Math.cos(panRad || 0));
  const angTerm = (dIn / (cosPan * cosPan)) * (gyroErrRadPerSec * dt);
  const swayTerm = 3.0 * Math.sqrt(dt);
  return Math.hypot(angTerm, swayTerm);
}

/**
 * Solves 5x5 linear system `A * x = b` in-place via Gaussian elimination with partial pivoting.
 * `A` is row-major Float64Array(25), `b` is Float64Array(5), result written to `out` Float64Array(5).
 */
function solveLinear5(A, b, out) {
  const n = 5;
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(A[col * n + col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = r;
      }
    }
    if (maxAbs < 1e-12) return false;
    if (pivotRow !== col) {
      for (let c = col; c < n; c++) {
        const tmp = A[col * n + c];
        A[col * n + c] = A[pivotRow * n + c];
        A[pivotRow * n + c] = tmp;
      }
      const tb = b[col];
      b[col] = b[pivotRow];
      b[pivotRow] = tb;
    }
    const diag = A[col * n + col];
    for (let r = col + 1; r < n; r++) {
      const factor = A[r * n + col] / diag;
      if (factor === 0) continue;
      for (let c = col; c < n; c++) {
        A[r * n + c] -= factor * A[col * n + c];
      }
      b[r] -= factor * b[col];
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let sum = b[i];
    for (let c = i + 1; c < n; c++) {
      sum -= A[i * n + c] * out[c];
    }
    out[i] = sum / A[i * n + i];
  }
  return true;
}

/**
 * Two-read damped Gauss-Newton calibration of `(fPx, dIn, pxIn, pyIn, psi0Rad)` from
 * two corner observations `{ cellX, cellY, rx, ry, wz, lenPx }` (6 measurements, 5 unknowns).
 * Rejects solutions with wall RMS residual > 3.0 in or non-physical f/D.
 */
export function solveTwoReadFocalAndDistance(readA, readB, opts = {}) {
  const labelLenIn = opts.labelLenIn || 3.5;
  const fInit = opts.fPxInit || 1400;
  const dInit = opts.dInInit || 24;
  const pxInit = opts.pxInit || 0;
  const pyInit = opts.pyInit || 0;
  const psiInit = opts.psi0Init || 0;
  const maxIter = opts.maxIter || 12;

  // Parameter vector p = [fPx, dIn, px, py, psi0]
  const p = new Float64Array([fInit, dInit, pxInit, pyInit, psiInit]);
  const rVec = new Float64Array(6);
  const rPert = new Float64Array(6);
  const J = new Float64Array(6 * 5);
  const H = new Float64Array(25);
  const g = new Float64Array(5);
  const dp = new Float64Array(5);

  const reads = [readA, readB];

  function evalResiduals(params, outR) {
    const f = params[0];
    const d = params[1];
    const px = params[2];
    const py = params[3];
    const psi0 = params[4];
    const tanPsi0 = Math.tan(psi0);

    for (let k = 0; k < 2; k++) {
      const rd = reads[k];
      const wz = Math.max(0.25, rd.wz);
      const tanX = rd.rx / wz + tanPsi0;
      const tanY = rd.ry / wz;
      const wxPred = px + d * tanX;
      const wyPred = py + d * tanY;

      const panRad = Math.atan(tanX);
      const tiltRad = Math.atan(tanY * Math.cos(panRad));
      const cosPan = Math.max(0.25, Math.cos(panRad));
      const cosTilt = Math.max(0.25, Math.cos(tiltRad));
      const lenPred = (f * labelLenIn * cosTilt * cosTilt * cosPan) / Math.max(4, d);

      // Weight wall residuals in inches; weight length residual ~0.05 in/px so both scales match
      outR[k * 3 + 0] = wxPred - rd.cellX;
      outR[k * 3 + 1] = wyPred - rd.cellY;
      outR[k * 3 + 2] = (lenPred - rd.lenPx) * 0.05;
    }
  }

  const eps = [2.0, 0.05, 0.05, 0.05, 1e-4];
  let lambda = 1e-3;

  for (let iter = 0; iter < maxIter; iter++) {
    evalResiduals(p, rVec);
    let cost = 0;
    for (let i = 0; i < 6; i++) cost += rVec[i] * rVec[i];

    // Finite-difference Jacobian J (6 x 5)
    for (let j = 0; j < 5; j++) {
      const orig = p[j];
      p[j] = orig + eps[j];
      evalResiduals(p, rPert);
      p[j] = orig;
      const invE = 1 / eps[j];
      for (let i = 0; i < 6; i++) {
        J[i * 5 + j] = (rPert[i] - rVec[i]) * invE;
      }
    }

    // Normal equations: (J^T J + lambda * diag) * dp = -J^T r
    for (let r = 0; r < 5; r++) {
      let gr = 0;
      for (let i = 0; i < 6; i++) gr -= J[i * 5 + r] * rVec[i];
      g[r] = gr;
      for (let c = 0; c < 5; c++) {
        let sum = 0;
        for (let i = 0; i < 6; i++) sum += J[i * 5 + r] * J[i * 5 + c];
        H[r * 5 + c] = sum + (r === c ? lambda * Math.max(1e-4, sum) + 1e-6 : 0);
      }
    }

    if (!solveLinear5(H, g, dp)) break;

    const pNext = new Float64Array(p);
    for (let j = 0; j < 5; j++) pNext[j] += dp[j];
    // Physical clamps during iteration
    pNext[0] = Math.max(300, Math.min(8000, pNext[0]));
    pNext[1] = Math.max(6, Math.min(60, pNext[1]));
    pNext[4] = Math.max(-0.6, Math.min(0.6, pNext[4]));

    evalResiduals(pNext, rPert);
    let nextCost = 0;
    for (let i = 0; i < 6; i++) nextCost += rPert[i] * rPert[i];

    if (nextCost < cost) {
      for (let j = 0; j < 5; j++) p[j] = pNext[j];
      lambda = Math.max(1e-6, lambda * 0.4);
      if (Math.abs(cost - nextCost) < 1e-7) break;
    } else {
      lambda = Math.min(1e4, lambda * 4.0);
    }
  }

  evalResiduals(p, rVec);
  const wallErrA = Math.hypot(rVec[0], rVec[1]);
  const wallErrB = Math.hypot(rVec[3], rVec[4]);
  const rmsWallIn = Math.sqrt(0.5 * (wallErrA * wallErrA + wallErrB * wallErrB));
  const ok = rmsWallIn <= 3.0 && p[0] >= 350 && p[0] <= 7500 && p[1] >= 6 && p[1] <= 55;

  return {
    ok,
    fPx: p[0],
    dIn: p[1],
    pxIn: p[2],
    pyIn: p[3],
    psi0Rad: p[4],
    rmsWallIn: Math.round(rmsWallIn * 100) / 100,
  };
}

/**
 * Pre-allocated 3-state Kalman residual filter on `x = [psi0Rad, pxIn, pyIn]`.
 * Zero hot-loop allocations.
 */
export function createPanKalmanFilter(opts = {}) {
  const qPsiRate = (opts.psiNoiseDegPerSqrtS ?? 0.05) * DEG_TO_RAD;
  const qPosRate = opts.posNoiseInPerSqrtS ?? 3.0;
  const rMeasVar = opts.measVarIn2 ?? 1.5;

  const x = new Float64Array(3); // [psi0Rad, pxIn, pyIn]
  const P = new Float64Array(9); // 3x3 row-major covariance
  const K = new Float64Array(6); // 3x2 Kalman gain
  const Pnew = new Float64Array(9);

  // Latency cross-correlation accumulator
  let lagAcc = 0;
  let lagDen = 0;
  let camSensorOffsetMs = opts.camSensorOffsetMs ?? 50;

  function reset(psi0 = 0, px = 0, py = 0) {
    x[0] = psi0;
    x[1] = px;
    x[2] = py;
    P.fill(0);
    P[0] = (2.0 * DEG_TO_RAD) ** 2;
    P[4] = 9.0; // 3 in std
    P[8] = 9.0;
    lagAcc = 0;
    lagDen = 0;
  }

  reset(opts.psi0 || 0, opts.px || 0, opts.py || 0);

  function predict(dtSec) {
    const dt = Math.max(0.001, Math.min(2.0, dtSec || 0.033));
    P[0] += qPsiRate * qPsiRate * dt;
    P[4] += qPosRate * qPosRate * dt;
    P[8] += qPosRate * qPosRate * dt;
  }

  /**
   * Measurement update from residual `(innovXIn, innovYIn) = (cellX - predX, cellY - predY)`.
   * H = [[hPsi, 1, 0], [0, 0, 1]] where hPsi = dIn / (wzIn * wzIn).
   */
  function update(innovXIn, innovYIn, dIn, wzIn) {
    const wz = Math.max(0.25, wzIn || 1.0);
    const h = (dIn || 24) / (wz * wz);

    // S = H P H^T + R (2x2 symmetric)
    const p00 = P[0], p01 = P[1], p02 = P[2];
    const p10 = P[3], p11 = P[4], p12 = P[5];
    const p20 = P[6], p21 = P[7], p22 = P[8];

    const hp00 = h * p00 + p10;
    const hp01 = h * p01 + p11;
    const hp02 = h * p02 + p12;

    const s00 = hp00 * h + hp01 + rMeasVar;
    const s01 = hp02;
    const s10 = p20 * h + p21;
    const s11 = p22 + rMeasVar;

    const det = s00 * s11 - s01 * s10;
    if (Math.abs(det) < 1e-12) return false;
    const invDet = 1 / det;
    const is00 = s11 * invDet;
    const is01 = -s01 * invDet;
    const is10 = -s10 * invDet;
    const is11 = s00 * invDet;

    // PH^T is 3x2: col0 = [p00*h+p01, p10*h+p11, p20*h+p21], col1 = [p02, p12, p22]
    const ph00 = p00 * h + p01, ph01 = p02;
    const ph10 = p10 * h + p11, ph11 = p12;
    const ph20 = p20 * h + p21, ph21 = p22;

    // K = PH^T * S^{-1} (3x2)
    K[0] = ph00 * is00 + ph01 * is10; K[1] = ph00 * is01 + ph01 * is11;
    K[2] = ph10 * is00 + ph11 * is10; K[3] = ph10 * is01 + ph11 * is11;
    K[4] = ph20 * is00 + ph21 * is10; K[5] = ph20 * is01 + ph21 * is11;

    // State update: x += K * innov
    x[0] += K[0] * innovXIn + K[1] * innovYIn;
    x[1] += K[2] * innovXIn + K[3] * innovYIn;
    x[2] += K[4] * innovXIn + K[5] * innovYIn;

    // Covariance update: P = (I - K H) P
    // I - K H = [[1 - k00*h, -k00, -k01], [-k10*h, 1 - k10, -k11], [-k20*h, -k20, 1 - k21]]
    const m00 = 1 - K[0] * h, m01 = -K[0], m02 = -K[1];
    const m10 = -K[2] * h,    m11 = 1 - K[2], m12 = -K[3];
    const m20 = -K[4] * h,    m21 = -K[4], m22 = 1 - K[5];

    Pnew[0] = m00 * p00 + m01 * p10 + m02 * p20;
    Pnew[1] = m00 * p01 + m01 * p11 + m02 * p21;
    Pnew[2] = m00 * p02 + m01 * p12 + m02 * p22;

    Pnew[3] = m10 * p00 + m11 * p10 + m12 * p20;
    Pnew[4] = m10 * p01 + m11 * p11 + m12 * p21;
    Pnew[5] = m10 * p02 + m11 * p12 + m12 * p22;

    Pnew[6] = m20 * p00 + m21 * p10 + m22 * p20;
    Pnew[7] = m20 * p01 + m21 * p11 + m22 * p21;
    Pnew[8] = m20 * p02 + m21 * p12 + m22 * p22;

    // Enforce symmetry & positive diagonal
    for (let i = 0; i < 9; i++) P[i] = Pnew[i];
    P[1] = P[3] = 0.5 * (P[1] + P[3]);
    P[2] = P[6] = 0.5 * (P[2] + P[6]);
    P[5] = P[7] = 0.5 * (P[5] + P[7]);
    if (P[0] < 1e-8) P[0] = 1e-8;
    if (P[4] < 0.05) P[4] = 0.05;
    if (P[8] < 0.05) P[8] = 0.05;
    return true;
  }

  /**
   * Online camera-sensor lag estimator: correlates horizontal residual `exIn` against
   * wall-plane pan velocity `vxInPerSec` to nudge `camSensorOffsetMs` within [0, 140] ms.
   */
  function updateLatency(exIn, vxInPerSec) {
    if (Math.abs(vxInPerSec) < 3.0) return camSensorOffsetMs;
    lagAcc = lagAcc * 0.92 + exIn * vxInPerSec;
    lagDen = lagDen * 0.92 + vxInPerSec * vxInPerSec;
    if (lagDen > 25) {
      const deltaMs = Math.max(-15, Math.min(15, (lagAcc / lagDen) * 1000 * 0.15));
      camSensorOffsetMs = Math.max(0, Math.min(140, camSensorOffsetMs + deltaMs));
    }
    return camSensorOffsetMs;
  }

  return {
    x,
    P,
    predict,
    update,
    updateLatency,
    reset,
    getCamSensorOffsetMs: () => camSensorOffsetMs,
  };
}
