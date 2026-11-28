/**
 * M4 — camera pose from the wall homography (`src/ar/pose.js`).
 *
 * `solve(H, fx, fy, cx, cy, refX, refY, out)` decomposes `H` (wall inches -> image px, from `homography.js`) with the
 * pinhole intrinsics into the camera pose relative to the wall.
 *
 * Wall frame (as `layout.js`): origin top-left, +x right, +y down, +z INTO the wall (the camera sits at
 * negative z). Angle convention matches `tests/helpers/ar-dot-render.js` and the sim: yaw right +, pitch
 * up +, roll about the optical axis (applied last).
 *
 * `out` is caller owned and reused (no allocation per call):
 *   R[9]       camera-from-wall rotation (row-major; rows = camera x, y, forward in wall coordinates)
 *   C[3]       camera centre in the wall frame (inches)
 *   distanceIn distance from the camera to where its optical axis meets the wall
 *   aimX, aimY that wall point (inches)
 *   yawDeg, pitchDeg, rollDeg
 *   orthoErr   how far the raw decomposition was from a rotation (0 = exact), diagnostic
 */
export function createPoseSolver() {
  const R = new Float64Array(9); // working rotation (columns r1 r2 r3 in M-space)
  const Rn = new Float64Array(9);
  const RAD = 180 / Math.PI;

  function polar(M) {
    // R <- 0.5 (R + R^-T), repeated: converges to the nearest rotation matrix
    for (let it = 0; it < 8; it++) {
      const a = M[0]; const b = M[1]; const c = M[2];
      const d = M[3]; const e = M[4]; const f = M[5];
      const g = M[6]; const h = M[7]; const i = M[8];
      const c00 = e * i - f * h; const c01 = -(d * i - f * g); const c02 = d * h - e * g;
      const c10 = -(b * i - c * h); const c11 = a * i - c * g; const c12 = -(a * h - b * g);
      const c20 = b * f - c * e; const c21 = -(a * f - c * d); const c22 = a * e - b * d;
      const det = a * c00 + b * c01 + c * c02;
      if (!(Math.abs(det) > 1e-12)) return false;
      const id = 1 / det;
      // inverse transpose = cofactor / det
      Rn[0] = 0.5 * (a + c00 * id); Rn[1] = 0.5 * (b + c01 * id); Rn[2] = 0.5 * (c + c02 * id);
      Rn[3] = 0.5 * (d + c10 * id); Rn[4] = 0.5 * (e + c11 * id); Rn[5] = 0.5 * (f + c12 * id);
      Rn[6] = 0.5 * (g + c20 * id); Rn[7] = 0.5 * (h + c21 * id); Rn[8] = 0.5 * (i + c22 * id);
      let diff = 0;
      for (let k = 0; k < 9; k++) { diff += Math.abs(Rn[k] - M[k]); M[k] = Rn[k]; }
      if (diff < 1e-13) break;
    }
    return true;
  }

  /** @returns {boolean} false when H is degenerate or the wall is behind the camera */
  function solve(H, fx, fy, cx, cy, refX, refY, out) {
    // M = K^-1 H  (columns m1 m2 m3)
    const m00 = (H[0] - cx * H[6]) / fx; const m01 = (H[1] - cx * H[7]) / fx; const m02 = (H[2] - cx * H[8]) / fx;
    const m10 = (H[3] - cy * H[6]) / fy; const m11 = (H[4] - cy * H[7]) / fy; const m12 = (H[5] - cy * H[8]) / fy;
    const m20 = H[6]; const m21 = H[7]; const m22 = H[8];
    const n1 = Math.hypot(m00, m10, m20);
    const n2 = Math.hypot(m01, m11, m21);
    if (!(n1 > 1e-12 && n2 > 1e-12)) return false;
    let lam = 2 / (n1 + n2);
    // the sign of H is arbitrary: choose it so a wall point that is IN VIEW (refX, refY; e.g. the centroid of the
    // matched dots) is in front of the camera. The wall origin itself may be behind the camera.
    if (m20 * refX + m21 * refY + m22 < 0) lam = -lam;
    const r1x = lam * m00; const r1y = lam * m10; const r1z = lam * m20;
    const r2x = lam * m01; const r2y = lam * m11; const r2z = lam * m21;
    const tx = lam * m02; const ty = lam * m12; const tz = lam * m22;
    // r3 = r1 x r2, raw matrix with columns r1 r2 r3
    const r3x = r1y * r2z - r1z * r2y; const r3y = r1z * r2x - r1x * r2z; const r3z = r1x * r2y - r1y * r2x;
    R[0] = r1x; R[1] = r2x; R[2] = r3x;
    R[3] = r1y; R[4] = r2y; R[5] = r3y;
    R[6] = r1z; R[7] = r2z; R[8] = r3z;
    let before = 0;
    for (let k = 0; k < 9; k++) before += R[k] * R[k];
    if (!polar(R)) return false;
    let err = 0;
    err = Math.abs(before - 3);
    const Ro = out.R;
    for (let k = 0; k < 9; k++) Ro[k] = R[k];
    // camera centre C = -R^T t
    out.C[0] = -(R[0] * tx + R[3] * ty + R[6] * tz);
    out.C[1] = -(R[1] * tx + R[4] * ty + R[7] * tz);
    out.C[2] = -(R[2] * tx + R[5] * ty + R[8] * tz);
    // forward (row 2), camera x (row 0)
    const f0 = R[6]; const f1 = R[7]; const f2 = R[8];
    out.yawDeg = Math.atan2(f0, f2) * RAD;
    out.pitchDeg = -Math.asin(Math.max(-1, Math.min(1, f1))) * RAD;
    // roll: camera x axis against the roll-free camera x (normalised cross([0,1,0], f))
    const nx = Math.hypot(f2, f0);
    const x0x = f2 / nx; const x0z = -f0 / nx; // xc0 = (f2, 0, -f0) / |.|
    // yc0 = f x xc0
    const y0x = f1 * x0z; const y0y = f2 * x0x - f0 * x0z; const y0z = -f1 * x0x;
    const cxv0 = R[0]; const cxv1 = R[1]; const cxv2 = R[2];
    out.rollDeg = Math.atan2(cxv0 * y0x + cxv1 * y0y + cxv2 * y0z, cxv0 * x0x + cxv2 * x0z) * RAD;
    // where the optical axis meets the wall (z = 0)
    if (Math.abs(f2) < 1e-9) return false;
    const s = -out.C[2] / f2;
    out.distanceIn = s;
    out.aimX = out.C[0] + s * f0;
    out.aimY = out.C[1] + s * f1;
    out.orthoErr = err;
    return true;
  }

  return { solve };
}

/** A result record for `solve` (create once, reuse). */
export function createPoseResult() {
  return { R: new Float64Array(9), C: new Float64Array(3), distanceIn: 0, aimX: 0, aimY: 0, yawDeg: 0, pitchDeg: 0, rollDeg: 0, orthoErr: 0 };
}
