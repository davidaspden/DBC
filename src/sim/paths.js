/**
 * Physical geometry, optical math, 3D camera matrices, and motion path generators
 * for the 4x4 Tote Wall WebGL Barcode Simulator.
 *
 * Coordinate system (right-handed, units = inches):
 *  - Wall lies on plane Z = 0, centered at (0, 0, 0).
 *  - +X = right, +Y = up, +Z = out of wall toward camera.
 *  - Tote face: 14 in wide (X) x 16 in tall (Y).
 *  - 4x4 grid: 56 in wide (X in [-28, +28]) x 64 in tall (Y in [-32, +32]).
 *  - Vertical Code 128 barcode centered on each tote: 2 in wide (X) x 6 in tall (Y).
 */

export const TOTE_WIDTH_IN = 14;
export const TOTE_HEIGHT_IN = 16;
export const BARCODE_WIDTH_IN = 2;
export const BARCODE_HEIGHT_IN = 6;
export const GRID_COLS = 4;
export const GRID_ROWS = 4;
export const WALL_WIDTH_IN = TOTE_WIDTH_IN * GRID_COLS;   // 56 in
export const WALL_HEIGHT_IN = TOTE_HEIGHT_IN * GRID_ROWS; // 64 in

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/**
 * Generates the 16 canonical tote definitions (row 0 = top, col 0 = left).
 * Default (`fcMode = false`): 16-char Code 128B (`TOTE-R1C1-000101`, 231 modules, 6 in).
 * FC realism mode (`fcMode = true`): 12-char Code 128B (`tsX11A000101`, 187 modules, 3.5 in).
 */
export function createWallCells(opts = {}) {
  const fcMode = Boolean(opts && opts.fcMode);
  const cells = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      const idx = r * GRID_COLS + c;
      const num = String(idx + 1).padStart(2, '0');
      const cx = -WALL_WIDTH_IN * 0.5 + (c + 0.5) * TOTE_WIDTH_IN;
      const cy = WALL_HEIGHT_IN * 0.5 - (r + 0.5) * TOTE_HEIGHT_IN;
      cells.push({
        index: idx,
        row: r,
        col: c,
        id: `R${r + 1}C${c + 1}`,
        payload: fcMode ? `tsX${r + 1}${c + 1}A000${num}B` : `TOTE-R${r + 1}C${c + 1}-00${num}${num}`,
        cx,
        cy,
      });
    }
  }
  return cells;
}

/**
 * Computes physical field-of-view footprint at `distanceIn` and pixels-per-module (ppm)
 * for a vertical Code 128 barcode of height `labelHeightIn` (default 6 in).
 *
 * @param {{
 *   distanceIn: number,
 *   hfovDeg: number,
 *   widthPx: number,
 *   heightPx: number,
 *   totalModules?: number,
 *   labelHeightIn?: number
 * }} params
 */
export function computeOptics({
  distanceIn,
  hfovDeg,
  widthPx,
  heightPx,
  totalModules = 231,
  labelHeightIn = BARCODE_HEIGHT_IN,
}) {
  const aspect = widthPx / heightPx;
  const halfHfovRad = (hfovDeg * 0.5) * DEG2RAD;
  const halfTanH = Math.tan(halfHfovRad);
  const halfTanV = halfTanH / aspect;
  const vfovDeg = 2 * Math.atan(halfTanV) * RAD2DEG;

  const visibleWidthIn = 2 * distanceIn * halfTanH;
  const visibleHeightIn = 2 * distanceIn * halfTanV;
  const pxPerInch = widthPx / visibleWidthIn;
  const barcodeHeightPx = labelHeightIn * pxPerInch;
  const barcodeWidthPx = BARCODE_WIDTH_IN * pxPerInch;
  const ppm = barcodeHeightPx / totalModules;

  return {
    aspect,
    hfovDeg,
    vfovDeg,
    visibleWidthIn,
    visibleHeightIn,
    pxPerInch,
    barcodeHeightPx,
    barcodeWidthPx,
    labelHeightIn,
    ppm,
    nyquistOk: ppm >= 2.0,
  };
}

/**
 * Builds an arc-length-parameterized polyline from control points `[{x, y}, ...]`.
 */
function buildPolyline(points) {
  const cumLen = new Float64Array(points.length);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.hypot(dx, dy);
    cumLen[i] = total;
  }
  return { points, cumLen, totalLength: total };
}

function samplePolyline(poly, dist) {
  const pts = poly.points;
  const cum = poly.cumLen;
  const total = poly.totalLength;
  if (total <= 1e-6 || pts.length < 2) {
    return { x: pts[0].x, y: pts[0].y, vx: 0, vy: 0 };
  }
  const d = Math.max(0, Math.min(total, dist));
  let seg = 0;
  while (seg < pts.length - 2 && cum[seg + 1] < d) seg++;
  const segLen = cum[seg + 1] - cum[seg];
  const frac = segLen > 1e-6 ? (d - cum[seg]) / segLen : 0;
  const p0 = pts[seg];
  const p1 = pts[seg + 1];
  const ux = segLen > 1e-6 ? (p1.x - p0.x) / segLen : 0;
  const uy = segLen > 1e-6 ? (p1.y - p0.y) / segLen : 0;
  return {
    x: p0.x + (p1.x - p0.x) * frac,
    y: p0.y + (p1.y - p0.y) * frac,
    vx: ux,
    vy: uy,
  };
}

function cellCenter(r, c) {
  return {
    x: -WALL_WIDTH_IN * 0.5 + (c + 0.5) * TOTE_WIDTH_IN,
    y: WALL_HEIGHT_IN * 0.5 - (r + 0.5) * TOTE_HEIGHT_IN,
  };
}

// Precompute canonical wall-space waypoints for each path mode
const SNAKE_H_POLY = buildPolyline([
  // Row 1 L->R (slight 2 in lead-in/out so edge labels fully cross center)
  { x: cellCenter(0, 0).x - 2, y: cellCenter(0, 0).y },
  { x: cellCenter(0, 3).x + 2, y: cellCenter(0, 3).y },
  // Drop to Row 2 R->L
  { x: cellCenter(1, 3).x + 2, y: cellCenter(1, 3).y },
  { x: cellCenter(1, 0).x - 2, y: cellCenter(1, 0).y },
  // Drop to Row 3 L->R
  { x: cellCenter(2, 0).x - 2, y: cellCenter(2, 0).y },
  { x: cellCenter(2, 3).x + 2, y: cellCenter(2, 3).y },
  // Drop to Row 4 R->L
  { x: cellCenter(3, 3).x + 2, y: cellCenter(3, 3).y },
  { x: cellCenter(3, 0).x - 2, y: cellCenter(3, 0).y },
]);

const SNAKE_V_POLY = buildPolyline([
  // Col 1 T->B
  { x: cellCenter(0, 0).x, y: cellCenter(0, 0).y + 2 },
  { x: cellCenter(3, 0).x, y: cellCenter(3, 0).y - 2 },
  // Col 2 B->T
  { x: cellCenter(3, 1).x, y: cellCenter(3, 1).y - 2 },
  { x: cellCenter(0, 1).x, y: cellCenter(0, 1).y + 2 },
  // Col 3 T->B
  { x: cellCenter(0, 2).x, y: cellCenter(0, 2).y + 2 },
  { x: cellCenter(3, 2).x, y: cellCenter(3, 2).y - 2 },
  // Col 4 B->T
  { x: cellCenter(3, 3).x, y: cellCenter(3, 3).y - 2 },
  { x: cellCenter(0, 3).x, y: cellCenter(0, 3).y + 2 },
]);

const ROW_SWEEP_POLY = buildPolyline([
  { x: cellCenter(1, 0).x - 3, y: cellCenter(1, 0).y },
  { x: cellCenter(1, 3).x + 3, y: cellCenter(1, 3).y },
  { x: cellCenter(1, 0).x - 3, y: cellCenter(1, 0).y },
]);

const DIAGONAL_POLY = buildPolyline([
  { x: cellCenter(0, 0).x - 2, y: cellCenter(0, 0).y + 1 },
  { x: cellCenter(1, 3).x + 2, y: cellCenter(1, 3).y - 1 },
  { x: cellCenter(0, 3).x + 2, y: cellCenter(0, 3).y + 1 },
  { x: cellCenter(2, 0).x - 2, y: cellCenter(2, 0).y - 1 },
  { x: cellCenter(1, 0).x - 2, y: cellCenter(1, 0).y },
  { x: cellCenter(3, 3).x + 2, y: cellCenter(3, 3).y - 1 },
  { x: cellCenter(2, 3).x + 2, y: cellCenter(2, 3).y },
  { x: cellCenter(3, 0).x - 2, y: cellCenter(3, 0).y - 1 },
]);

export const PATH_DEFINITIONS = [
  { id: 'snake-h', label: 'Snake Horizontal (4 rows)', lengthIn: SNAKE_H_POLY.totalLength },
  { id: 'snake-v', label: 'Snake Vertical (4 cols)', lengthIn: SNAKE_V_POLY.totalLength },
  { id: 'pan-snake', label: 'Stand-Back Pan (Gimbal)', lengthIn: SNAKE_H_POLY.totalLength },
  { id: 'row-sweep', label: 'Single Row Sweep (R2)', lengthIn: ROW_SWEEP_POLY.totalLength },
  { id: 'diagonal-tilt', label: 'Tilted Diagonal (±15° roll)', lengthIn: DIAGONAL_POLY.totalLength },
  { id: 'manual', label: 'Manual Drag / Zoom', lengthIn: 0 },
];

/**
 * Evaluates camera pose at simulation time `tSec`.
 *
 * @param {string} pathId
 * @param {number} tSec
 * @param {{
 *   distanceIn: number,
 *   speedInPerSec: number,
 *   jitter?: number,
 *   loop?: boolean,
 *   manualPose?: { x: number, y: number, z: number, yawDeg: number, pitchDeg: number, rollDeg: number }
 * }} cfg
 */
export function sampleCameraPose(pathId, tSec, cfg) {
  const zBase = Math.max(4, cfg.distanceIn || 10);
  const speed = Math.max(0.5, cfg.speedInPerSec || 18);
  const jitter = Math.max(0, Math.min(1, cfg.jitter || 0));
  const loop = cfg.loop !== false;

  if (pathId === 'manual') {
    const m = cfg.manualPose || { x: 0, y: 0, z: zBase, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    return {
      x: m.x,
      y: m.y,
      z: m.z ?? zBase,
      yawDeg: m.yawDeg || 0,
      pitchDeg: m.pitchDeg || 0,
      rollDeg: m.rollDeg || 0,
      targetX: m.x,
      targetY: m.y,
      speedInPerSec: 0,
      progress: 0,
      durationSec: 0,
      finished: false,
    };
  }

  let poly = SNAKE_H_POLY;
  if (pathId === 'snake-v') poly = SNAKE_V_POLY;
  else if (pathId === 'row-sweep') poly = ROW_SWEEP_POLY;
  else if (pathId === 'diagonal-tilt') poly = DIAGONAL_POLY;

  const durationSec = poly.totalLength / speed;
  const rawDist = tSec * speed;
  let dist;
  let finished = false;
  if (loop) {
    dist = ((rawDist % poly.totalLength) + poly.totalLength) % poly.totalLength;
  } else {
    dist = Math.min(poly.totalLength, Math.max(0, rawDist));
    finished = rawDist >= poly.totalLength;
  }

  const s = samplePolyline(poly, dist);
  const progress = poly.totalLength > 0 ? dist / poly.totalLength : 0;

  let x = s.x;
  let y = s.y;
  let z = zBase;
  let yawDeg = 0;
  let pitchDeg = 0;
  let rollDeg = 0;

  if (pathId === 'pan-snake') {
    // Camera stands anchored at (0, 0, zBase) and rotates yaw & pitch to aim at (s.x, s.y, 0)
    x = 0;
    y = 0;
    z = zBase;
    yawDeg = Math.atan2(s.x, zBase) * RAD2DEG;
    const horizDist = Math.hypot(s.x, zBase);
    pitchDeg = Math.atan2(s.y, horizDist) * RAD2DEG;
  } else if (pathId === 'diagonal-tilt') {
    rollDeg = 15 * Math.sin(tSec * 1.45);
  }

  if (jitter > 0) {
    // Realistic handheld operator wobble (multi-harmonic breathing + wrist micro-shake)
    z += jitter * (0.65 * Math.sin(tSec * 2.7) + 0.28 * Math.sin(tSec * 6.3 + 1.1));
    yawDeg += jitter * (1.8 * Math.sin(tSec * 3.9 + 0.4) + 0.9 * Math.cos(tSec * 9.1));
    pitchDeg += jitter * (1.6 * Math.cos(tSec * 3.3 + 0.9) + 0.8 * Math.sin(tSec * 8.4));
    rollDeg += jitter * (3.2 * Math.sin(tSec * 2.2 + 0.7) + 1.2 * Math.cos(tSec * 5.7));
  }

  return {
    x,
    y,
    z: Math.max(4, z),
    yawDeg,
    pitchDeg,
    rollDeg,
    targetX: s.x,
    targetY: s.y,
    speedInPerSec: finished ? 0 : speed,
    progress,
    durationSec,
    finished,
  };
}

// ============================================================================
// Minimal Zero-Dependency Column-Major 4x4 Matrix Math (WebGL Convention)
// ============================================================================

export function mat4Perspective(vfovRad, aspect, near, far, out = new Float32Array(16)) {
  const f = 1.0 / Math.tan(vfovRad * 0.5);
  const nf = 1.0 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

/**
 * Builds View matrix (world -> camera) for camera at `(x, y, z)` looking toward -Z,
 * rotated by `yawDeg` (around +Y; positive yaw looks right toward +X),
 * `pitchDeg` (around +X; positive pitch looks up toward +Y),
 * and `rollDeg` (around view axis).
 */
export function mat4CameraView(pose, out = new Float32Array(16)) {
  const cy = Math.cos(-pose.yawDeg * DEG2RAD);
  const sy = Math.sin(-pose.yawDeg * DEG2RAD);
  const cp = Math.cos(pose.pitchDeg * DEG2RAD);
  const sp = Math.sin(pose.pitchDeg * DEG2RAD);
  const cr = Math.cos(pose.rollDeg * DEG2RAD);
  const sr = Math.sin(pose.rollDeg * DEG2RAD);

  // Camera world basis (right R, up U, backward B = -forward):
  // Forward direction starts at (0, 0, -1), yaw right (+X), pitch up (+Y)
  const fx = -sy * cp;
  const fy = sp;
  const fz = -cy * cp;

  // Backward vector B = -F
  const bx = -fx;
  const by = -fy;
  const bz = -fz;

  // Unrolled Right = normalize(F x worldUp(0,1,0)) = (-fz, 0, fx) / hypot
  let rx0 = -fz;
  let ry0 = 0;
  let rz0 = fx;
  const rLen = Math.hypot(rx0, rz0) || 1;
  rx0 /= rLen;
  rz0 /= rLen;

  // Unrolled Up = B x R0
  const ux0 = by * rz0 - bz * ry0;
  const uy0 = bz * rx0 - bx * rz0;
  const uz0 = bx * ry0 - by * rx0;

  // Apply roll around viewing axis
  const rx = rx0 * cr + ux0 * sr;
  const ry = ry0 * cr + uy0 * sr;
  const rz = rz0 * cr + uz0 * sr;

  const ux = -rx0 * sr + ux0 * cr;
  const uy = -ry0 * sr + uy0 * cr;
  const uz = -rz0 * sr + uz0 * cr;

  // Column-major view matrix: [R^T; U^T; B^T] with translation -dot(axis, pos)
  out[0] = rx;  out[4] = ry;  out[8]  = rz;  out[12] = -(rx * pose.x + ry * pose.y + rz * pose.z);
  out[1] = ux;  out[5] = uy;  out[9]  = uz;  out[13] = -(ux * pose.x + uy * pose.y + uz * pose.z);
  out[2] = bx;  out[6] = by;  out[10] = bz;  out[14] = -(bx * pose.x + by * pose.y + bz * pose.z);
  out[3] = 0;   out[7] = 0;   out[11] = 0;   out[15] = 1;
  return out;
}

export function mat4Multiply(a, b, out = new Float32Array(16)) {
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}
