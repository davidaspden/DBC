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

import {
  LEGACY_PAYLOAD_FN,
  FC_12_PAYLOAD_FN,
  computeCode128Modules,
  mulberry32,
} from './label.js';

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
 * Generates tote wall cell definitions (row 0 = top, col 0 = left).
 * Default (`fcMode = false`): 4x4 of 14x16 in totes, 16-char Code 128B (`TOTE-R1C1-000101`, 231 modules, 6 in).
 * FC realism mode (`fcMode = true`): 12-char Code 128B (`tsX11A00001B`, 187 modules, 3.5 in).
 * Accepts optional `cols`, `rows`, `pitchXIn`/`pitchX`, `pitchYIn`/`pitchY`, `labelOffset`, and `label.payloadFn`.
 */
export function createWallCells(opts = {}) {
  const fcMode = Boolean(opts && opts.fcMode);
  const cols = (opts && opts.cols > 0) ? (opts.cols | 0) : GRID_COLS;
  const rows = (opts && opts.rows > 0) ? (opts.rows | 0) : GRID_ROWS;
  const rawPitchX = opts ? (opts.pitchXIn ?? opts.pitchX) : undefined;
  const rawPitchY = opts ? (opts.pitchYIn ?? opts.pitchY) : undefined;
  const pitchXIn = (rawPitchX > 0) ? rawPitchX : TOTE_WIDTH_IN;
  const pitchYIn = (rawPitchY > 0) ? rawPitchY : TOTE_HEIGHT_IN;
  const wallWidthIn = pitchXIn * cols;
  const wallHeightIn = pitchYIn * rows;
  const payloadFn = (opts && opts.label && typeof opts.label.payloadFn === 'function')
    ? opts.label.payloadFn
    : (fcMode ? FC_12_PAYLOAD_FN : LEGACY_PAYLOAD_FN);

  const off = opts && opts.labelOffset ? opts.labelOffset : null;
  const meanX = off && Number.isFinite(off.meanXIn) ? off.meanXIn : 0;
  const meanY = off && Number.isFinite(off.meanYIn) ? off.meanYIn : 0;
  const sigmaX = off && Number.isFinite(off.sigmaXIn) && off.sigmaXIn > 0 ? off.sigmaXIn : 0;
  const sigmaY = off && Number.isFinite(off.sigmaYIn) && off.sigmaYIn > 0 ? off.sigmaYIn : 0;
  const hasOffset = meanX !== 0 || meanY !== 0 || sigmaX > 0 || sigmaY > 0;
  const rng = hasOffset
    ? mulberry32(((off.seed ?? opts.seed ?? 1) >>> 0) ^ 0x3c6ef372)
    : null;

  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      const cx = -wallWidthIn * 0.5 + (c + 0.5) * pitchXIn;
      const cy = wallHeightIn * 0.5 - (r + 0.5) * pitchYIn;
      let labelOffsetXIn = 0;
      let labelOffsetYIn = 0;
      if (hasOffset) {
        let gx = 0;
        let gy = 0;
        if (sigmaX > 0 || sigmaY > 0) {
          const u1 = Math.max(1e-7, rng());
          const u2 = rng();
          const mag = Math.sqrt(-2.0 * Math.log(u1));
          const ang = 2.0 * Math.PI * u2;
          gx = mag * Math.cos(ang);
          gy = mag * Math.sin(ang);
        }
        labelOffsetXIn = meanX + sigmaX * gx;
        labelOffsetYIn = meanY + sigmaY * gy;
      }
      const cell = {
        index: idx,
        row: r,
        col: c,
        id: `R${r + 1}C${c + 1}`,
        payload: payloadFn(r, c, idx),
        cx,
        cy,
      };
      if (hasOffset) {
        cell.labelOffsetXIn = labelOffsetXIn;
        cell.labelOffsetYIn = labelOffsetYIn;
        cell.labelCx = cx + labelOffsetXIn;
        cell.labelCy = cy + labelOffsetYIn;
      }
      cells.push(cell);
    }
  }
  return cells;
}

/**
 * Computes physical field-of-view footprint at `distanceIn` and pixels-per-module (ppm)
 * for a Code 128 barcode of parameterised physical dimensions, orientation & payload length.
 *
 * @param {{
 *   distanceIn: number,
 *   hfovDeg: number,
 *   widthPx: number,
 *   heightPx: number,
 *   totalModules?: number,
 *   labelWidthIn?: number,
 *   labelHeightIn?: number,
 *   orientation?: 'ladder' | 'picket',
 *   payload?: string,
 *   quietModules?: number,
 *   label?: { widthIn?: number, heightIn?: number, orientation?: 'ladder' | 'picket', quietModules?: number, payload?: string }
 * }} params
 */
export function computeOptics({
  distanceIn,
  hfovDeg,
  widthPx,
  heightPx,
  totalModules,
  labelWidthIn,
  labelHeightIn,
  orientation,
  payload,
  quietModules,
  label,
}) {
  const widthIn = labelWidthIn ?? label?.widthIn ?? BARCODE_WIDTH_IN;
  const heightIn = labelHeightIn ?? label?.heightIn ?? BARCODE_HEIGHT_IN;
  const orient = orientation ?? label?.orientation ?? 'ladder';
  const resolvedQuiet = quietModules ?? label?.quietModules ?? 10;
  const resolvedPayload = payload ?? label?.payload;
  const resolvedModules = totalModules !== undefined
    ? totalModules
    : (resolvedPayload ? computeCode128Modules(resolvedPayload, resolvedQuiet) : 231);

  const aspect = widthPx / heightPx;
  const halfHfovRad = (hfovDeg * 0.5) * DEG2RAD;
  const halfTanH = Math.tan(halfHfovRad);
  const halfTanV = halfTanH / aspect;
  const vfovDeg = 2 * Math.atan(halfTanV) * RAD2DEG;

  const visibleWidthIn = 2 * distanceIn * halfTanH;
  const visibleHeightIn = 2 * distanceIn * halfTanV;
  const pxPerInch = widthPx / visibleWidthIn;
  const barcodeHeightPx = heightIn * pxPerInch;
  const barcodeWidthPx = widthIn * pxPerInch;
  const scanLenIn = orient === 'picket' ? widthIn : heightIn;
  const scanLenPx = scanLenIn * pxPerInch;
  const ppm = scanLenPx / resolvedModules;

  return {
    aspect,
    hfovDeg,
    vfovDeg,
    visibleWidthIn,
    visibleHeightIn,
    pxPerInch,
    barcodeHeightPx,
    barcodeWidthPx,
    labelWidthIn: widthIn,
    labelHeightIn: heightIn,
    scanLenIn,
    totalModules: resolvedModules,
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

function cellCenterFor(r, c, cols, rows, pitchXIn, pitchYIn) {
  const wallW = cols * pitchXIn;
  const wallH = rows * pitchYIn;
  return {
    x: -wallW * 0.5 + (c + 0.5) * pitchXIn,
    y: wallH * 0.5 - (r + 0.5) * pitchYIn,
  };
}

/**
 * L3 — Builds wall-space path polylines parameterised by `(cols, rows, pitchXIn, pitchYIn)`.
 * Defaults match the legacy 4x4 14x16 in wall bit-for-bit.
 *
 * @param {{ cols?: number, rows?: number, pitchXIn?: number, pitchYIn?: number, pitchX?: number, pitchY?: number }} [geom]
 */
export function buildWallPolylines(geom = {}) {
  const cols = (geom && geom.cols > 0) ? (geom.cols | 0) : GRID_COLS;
  const rows = (geom && geom.rows > 0) ? (geom.rows | 0) : GRID_ROWS;
  const rawPitchX = geom ? (geom.pitchXIn ?? geom.pitchX) : undefined;
  const rawPitchY = geom ? (geom.pitchYIn ?? geom.pitchY) : undefined;
  const pitchXIn = (rawPitchX > 0) ? rawPitchX : TOTE_WIDTH_IN;
  const pitchYIn = (rawPitchY > 0) ? rawPitchY : TOTE_HEIGHT_IN;
  const cc = (r, c) => cellCenterFor(r, c, cols, rows, pitchXIn, pitchYIn);
  const lastC = cols - 1;
  const lastR = rows - 1;

  // Snake horizontal across all rows
  const snakeHPts = [];
  for (let r = 0; r < rows; r++) {
    if ((r & 1) === 0) {
      snakeHPts.push({ x: cc(r, 0).x - 2, y: cc(r, 0).y });
      snakeHPts.push({ x: cc(r, lastC).x + 2, y: cc(r, lastC).y });
    } else {
      snakeHPts.push({ x: cc(r, lastC).x + 2, y: cc(r, lastC).y });
      snakeHPts.push({ x: cc(r, 0).x - 2, y: cc(r, 0).y });
    }
  }
  const snakeH = buildPolyline(snakeHPts);

  // Snake vertical across all columns
  const snakeVPts = [];
  for (let c = 0; c < cols; c++) {
    if ((c & 1) === 0) {
      snakeVPts.push({ x: cc(0, c).x, y: cc(0, c).y + 2 });
      snakeVPts.push({ x: cc(lastR, c).x, y: cc(lastR, c).y - 2 });
    } else {
      snakeVPts.push({ x: cc(lastR, c).x, y: cc(lastR, c).y - 2 });
      snakeVPts.push({ x: cc(0, c).x, y: cc(0, c).y + 2 });
    }
  }
  const snakeV = buildPolyline(snakeVPts);

  const sweepRow = rows > 1 ? 1 : 0;
  const rowSweep = buildPolyline([
    { x: cc(sweepRow, 0).x - 3, y: cc(sweepRow, 0).y },
    { x: cc(sweepRow, lastC).x + 3, y: cc(sweepRow, lastC).y },
    { x: cc(sweepRow, 0).x - 3, y: cc(sweepRow, 0).y },
  ]);

  const r1 = Math.min(1, lastR);
  const r2 = Math.min(2, lastR);
  const diagonal = buildPolyline([
    { x: cc(0, 0).x - 2, y: cc(0, 0).y + 1 },
    { x: cc(r1, lastC).x + 2, y: cc(r1, lastC).y - 1 },
    { x: cc(0, lastC).x + 2, y: cc(0, lastC).y + 1 },
    { x: cc(r2, 0).x - 2, y: cc(r2, 0).y - 1 },
    { x: cc(r1, 0).x - 2, y: cc(r1, 0).y },
    { x: cc(lastR, lastC).x + 2, y: cc(lastR, lastC).y - 1 },
    { x: cc(r2, lastC).x + 2, y: cc(r2, lastC).y },
    { x: cc(lastR, 0).x - 2, y: cc(lastR, 0).y - 1 },
  ]);

  return {
    'snake-h': snakeH,
    'snake-h-fast-step': snakeH,
    'pan-snake': snakeH,
    'snake-v': snakeV,
    'row-sweep': rowSweep,
    'diagonal-tilt': diagonal,
  };
}

// Precompute canonical default 4x4 14x16 in wall-space waypoints
const DEFAULT_POLYLINES = buildWallPolylines();
const SNAKE_H_POLY = DEFAULT_POLYLINES['snake-h'];
const SNAKE_V_POLY = DEFAULT_POLYLINES['snake-v'];
const ROW_SWEEP_POLY = DEFAULT_POLYLINES['row-sweep'];
const DIAGONAL_POLY = DEFAULT_POLYLINES['diagonal-tilt'];

const polylineCache = new Map();
function getPolylinesForConfig(cfg) {
  const src = (cfg && cfg.scene) ? cfg.scene : cfg;
  if (!src) return DEFAULT_POLYLINES;
  const cols = (src.cols > 0) ? (src.cols | 0) : GRID_COLS;
  const rows = (src.rows > 0) ? (src.rows | 0) : GRID_ROWS;
  const rawPitchX = src.pitchXIn ?? src.pitchX;
  const rawPitchY = src.pitchYIn ?? src.pitchY;
  const pitchXIn = (rawPitchX > 0) ? rawPitchX : TOTE_WIDTH_IN;
  const pitchYIn = (rawPitchY > 0) ? rawPitchY : TOTE_HEIGHT_IN;

  if (cols === GRID_COLS && rows === GRID_ROWS && pitchXIn === TOTE_WIDTH_IN && pitchYIn === TOTE_HEIGHT_IN) {
    return DEFAULT_POLYLINES;
  }
  const key = `${cols}x${rows}:${pitchXIn}x${pitchYIn}`;
  let cached = polylineCache.get(key);
  if (!cached) {
    cached = buildWallPolylines({ cols, rows, pitchXIn, pitchYIn });
    if (polylineCache.size > 32) polylineCache.clear();
    polylineCache.set(key, cached);
  }
  return cached;
}

export const PATH_DEFINITIONS = [
  { id: 'snake-h', label: 'Snake Horizontal (4 rows)', lengthIn: SNAKE_H_POLY.totalLength },
  { id: 'snake-h-fast-step', label: 'Snake Horizontal (fast row step)', lengthIn: SNAKE_H_POLY.totalLength },
  { id: 'snake-v', label: 'Snake Vertical (4 cols)', lengthIn: SNAKE_V_POLY.totalLength },
  { id: 'pan-snake', label: 'Stand-Back Pan (Gimbal)', lengthIn: SNAKE_H_POLY.totalLength },
  { id: 'row-sweep', label: 'Single Row Sweep (R2)', lengthIn: ROW_SWEEP_POLY.totalLength },
  { id: 'diagonal-tilt', label: 'Tilted Diagonal (±15° roll)', lengthIn: DIAGONAL_POLY.totalLength },
  { id: 'manual', label: 'Manual Drag / Zoom', lengthIn: 0 },
];

// T3: optional measured-motion generator `(tSec) => { yawDeg, pitchDeg, rollDeg }`. `null` by default,
// so `sampleCameraPose` is bit-identical to before unless `setMeasuredMotionHook` is called (flag `simMeasuredMotion`).
let measuredMotionHook = null;
export function setMeasuredMotionHook(fn) {
  measuredMotionHook = typeof fn === 'function' ? fn : null;
}
export function hasMeasuredMotionHook() {
  return measuredMotionHook !== null;
}

// T1: extra (registered) paths, e.g. `tape:<name>`. Empty by default, so `PATH_DEFINITIONS` and
// `sampleCameraPose` behave exactly as before unless something registers a path (flag `simTapePose`).
const EXTRA_PATH_SAMPLERS = new Map();

/** Adds a path to `PATH_DEFINITIONS` and routes `sampleCameraPose(def.id, ...)` to `sampler(tSec, cfg)`. */
export function registerExtraPath(def, sampler) {
  if (!def || !def.id || typeof sampler !== 'function') return false;
  unregisterExtraPath(def.id);
  PATH_DEFINITIONS.push(def);
  EXTRA_PATH_SAMPLERS.set(def.id, sampler);
  return true;
}

export function unregisterExtraPath(id) {
  EXTRA_PATH_SAMPLERS.delete(id);
  const i = PATH_DEFINITIONS.findIndex((d) => d.id === id);
  if (i >= 0) PATH_DEFINITIONS.splice(i, 1);
}

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
  if (EXTRA_PATH_SAMPLERS.size !== 0) {
    const extra = EXTRA_PATH_SAMPLERS.get(pathId);
    if (extra) return extra(tSec, cfg);
  }
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

  const polys = getPolylinesForConfig(cfg);
  const poly = polys[pathId] || polys['snake-h'];

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
  // Effective velocity components on wall plane (in/s): vy is along vertical ladder scan axis!
  const activeSpeed = finished ? 0 : (pathId === 'snake-h-fast-step' && Math.abs(s.vy) > 0.5 ? speed * 1.6 : speed);
  const vxInPerSec = s.vx * activeSpeed;
  const vyInPerSec = s.vy * activeSpeed;

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

  if (measuredMotionHook !== null) {
    // T3 (`simMeasuredMotion`): the slider's angular wobble is replaced by the tape-fitted generator.
    // Breathing in z stays slider-driven (the tape's IMU does not measure translation).
    if (jitter > 0) z += jitter * (0.65 * Math.sin(tSec * 2.7) + 0.28 * Math.sin(tSec * 6.3 + 1.1));
    const m = measuredMotionHook(tSec);
    yawDeg += m.yawDeg;
    pitchDeg += m.pitchDeg;
    rollDeg += m.rollDeg;
  } else if (jitter > 0) {
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
    speedInPerSec: finished ? 0 : activeSpeed,
    vxInPerSec,
    vyInPerSec,
    alongScanSpeedInPerSec: Math.abs(vyInPerSec), // Ladder label: vertical motion smears bars; horizontal is harmless
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
