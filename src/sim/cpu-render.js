/**
 * R5 — Headless Pure-JS CPU 3D Tote Wall & Analytic Code 128 Renderer (`src/sim/cpu-render.js`).
 *
 * Pure-JS port of the WebGL fragment shader (`src/sim/webgl-wall.js`):
 *  - Exact pinhole ray casting through `mat4Perspective` / `mat4CameraView` / `mat4Multiply`
 *    from `src/sim/paths.js`, intersecting the Z = 0 wall plane.
 *  - Analytic sensor-pixel box-filter integration via `sampleBarcodeIntegrated1D` (`src/sim/label.js`)
 *    using exact analytical screen-space derivatives `hypot(dv/dx, dv/dy)`.
 *  - Tote wall shading (per-cell tone variation, seam gap, beveled rim normals, handle recess,
 *    structural ribs), overhead lighting + diagonal shadow gradient, specular glare lobe,
 *    deterministic seeded `mulberry32` sensor noise, and multi-subframe shutter motion blur.
 *  - Zero per-frame heap allocations in `renderFrame(scene, poses, opts, out)` once warmed up.
 */

import {
  encodeCode128B,
  sampleBarcodeIntegrated1D,
  DEFAULT_LABEL_SPEC,
} from './label.js';
import {
  mat4Perspective,
  mat4CameraView,
  mat4Multiply,
} from './paths.js';

const DEG2RAD = Math.PI / 180;

// Rec.601 luma equivalents of the WebGL wall shader constants
const OUTSIDE_LUMA = 0.299 * 0.045 + 0.587 * 0.055 + 0.114 * 0.07; // ~0.05372
const OUTSIDE_U8 = Math.round(OUTSIDE_LUMA * 255);
const TOTE_BASE_LUMA = 0.299 * 0.24 + 0.587 * 0.29 + 0.114 * 0.36; // ~0.28303
const SEAM_LUMA = 0.299 * 0.05 + 0.587 * 0.06 + 0.114 * 0.08;      // ~0.05929

// Normalized overhead light direction: normalize(vec3(-0.18, 0.42, 0.89))
const LIGHT_LEN = Math.hypot(-0.18, 0.42, 0.89);
const LIGHT_X = -0.18 / LIGHT_LEN;
const LIGHT_Y = 0.42 / LIGHT_LEN;
const LIGHT_Z = 0.89 / LIGHT_LEN;

// Precomputed flat-wall illumination (N = (0, 0, 1))
const FLAT_ILLUM = 0.38 + 0.62 * LIGHT_Z;

// Precomputed bevel normals normalize((±0.35, 0, 1)) and normalize((0, ±0.35, 1))
const BEVEL_INV_LEN = 1.0 / Math.hypot(0.35, 1.0);
const BEVEL_S = 0.35 * BEVEL_INV_LEN;
const BEVEL_Z = 1.0 * BEVEL_INV_LEN;
const BEVEL_ILLUM_PX = 0.38 + 0.62 * Math.max(0, BEVEL_S * LIGHT_X + BEVEL_Z * LIGHT_Z);
const BEVEL_ILLUM_NX = 0.38 + 0.62 * Math.max(0, -BEVEL_S * LIGHT_X + BEVEL_Z * LIGHT_Z);
const BEVEL_ILLUM_PY = 0.38 + 0.62 * Math.max(0, BEVEL_S * LIGHT_Y + BEVEL_Z * LIGHT_Z);
const BEVEL_ILLUM_NY = 0.38 + 0.62 * Math.max(0, -BEVEL_S * LIGHT_Y + BEVEL_Z * LIGHT_Z);

// Precomputed specular power LUTs (1024 entries on [0, 1]) for zero Math.pow in hot loops
const SPEC_LUT_SIZE = 1024;
const SPEC_LUT_SCALE = SPEC_LUT_SIZE - 1;
const POW18_LUT = new Float32Array(SPEC_LUT_SIZE);
const POW42_LUT = new Float32Array(SPEC_LUT_SIZE);
for (let i = 0; i < SPEC_LUT_SIZE; i++) {
  const x = i / SPEC_LUT_SCALE;
  POW18_LUT[i] = Math.pow(x, 18.0);
  POW42_LUT[i] = Math.pow(x, 42.0);
}

// Precomputed structural rib modulation LUT for |lx| in [3.6, 5.6]
const RIB_LUT_SIZE = 512;
const RIB_MIN_X = 3.6;
const RIB_MAX_X = 5.6;
const RIB_LUT_SCALE = (RIB_LUT_SIZE - 1) / (RIB_MAX_X - RIB_MIN_X);
const RIB_LUT = new Float32Array(RIB_LUT_SIZE);
for (let i = 0; i < RIB_LUT_SIZE; i++) {
  const ax = RIB_MIN_X + (i / (RIB_LUT_SIZE - 1)) * (RIB_MAX_X - RIB_MIN_X);
  RIB_LUT[i] = 0.96 + 0.04 * Math.sin(ax * 9.5);
}

/**
 * Seeded mulberry32 PRNG returning floats in [0, 1).
 * Deterministic across runs and platforms; never uses `Math.random`.
 *
 * @param {number} seed
 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x6d2b79f5;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Exact GLSL `hash12(vec2(px, py))` port for deterministic per-tote tone parity.
 */
function hash12(px, py) {
  let x = (px * 0.1031) % 1; if (x < 0) x += 1;
  let y = (py * 0.1031) % 1; if (y < 0) y += 1;
  let z = x;
  const d = x * (y + 33.33) + y * (z + 33.33) + z * (x + 33.33);
  x += d; y += d; z += d;
  let r = ((x + y) * z) % 1;
  if (r < 0) r += 1;
  return r;
}

// ============================================================================
// Pre-encoded Scene Cache (WeakMap -> zero allocations across frames)
// ============================================================================

const sceneCacheMap = new WeakMap();

function getEncodedScene(scene) {
  let cached = sceneCacheMap.get(scene);
  if (cached) return cached;

  const cells = scene.cells;
  const numCells = cells.length;
  const quietModules = scene.label?.quietModules ?? DEFAULT_LABEL_SPEC.quietModules;

  const cellModules = new Array(numCells);
  const cellTotalModules = new Int32Array(numCells);
  const cellCx = new Float32Array(numCells);
  const cellCy = new Float32Array(numCells);
  const toteLuma = new Float32Array(numCells);

  for (let i = 0; i < numCells; i++) {
    const c = cells[i];
    const enc = encodeCode128B(c.payload, quietModules);
    cellModules[i] = enc.modules;
    cellTotalModules[i] = enc.totalModules;
    cellCx[i] = c.cx;
    cellCy[i] = c.cy;
    const tone = 0.92 + 0.14 * hash12(c.col * 7.1, c.row * 13.7);
    toteLuma[i] = TOTE_BASE_LUMA * tone;
  }

  cached = {
    numCells,
    cellModules,
    cellTotalModules,
    cellCx,
    cellCy,
    toteLuma,
  };
  sceneCacheMap.set(scene, cached);
  return cached;
}

// ============================================================================
// Reusable Scratch Buffers (allocated once, resized only on growth)
// ============================================================================

const MAX_SUBFRAMES = 16;
const MAX_CELLS_SCRATCH = 128;

/**
 * Creates a reusable zero-allocation CPU wall renderer context.
 * Preallocates all matrices, ray basis tables, label bounding boxes, and subframe accumulators.
 *
 * @param {number} [maxCells=64]
 * @param {number} [maxLabelBoxPixels=524288]
 */
export function createCpuRenderContext(maxCells = 64, maxLabelBoxPixels = 524288) {
  const capCells = Math.max(MAX_CELLS_SCRATCH, maxCells | 0);
  return {
    projMat: new Float32Array(16),
    viewMat: new Float32Array(16),
    mvpMat: new Float32Array(16),
    // Per-subframe ray parameters (flat stride 18 floats per subframe):
    // [0..2]=camPos(Ox,Oy,Oz), [3..5]=R, [6..8]=U, [9..11]=B,
    // [12..14]=dX(per px), [15..17]=dY(per px)
    poseParams: new Float64Array(MAX_SUBFRAMES * 18),
    // Per-cell union screen bounding boxes across all subframes
    boxMinX: new Int32Array(capCells),
    boxMaxX: new Int32Array(capCells),
    boxMinY: new Int32Array(capCells),
    boxMaxY: new Int32Array(capCells),
    boxVisible: new Uint8Array(capCells),
    // Float32 accumulator for subframe averaging inside each visible label bbox
    boxAcc: new Float32Array(maxLabelBoxPixels),
    // Scratch array for single-pose wrapping without allocation
    singlePoseWrap: [null],
  };
}

const defaultCtx = createCpuRenderContext();

/**
 * Projects a wall-plane point `(wx, wy, 0)` through `mvpMat` into top-down image pixel coordinates.
 * Writes `[px, py, behindFlag]` into `out` at `offset` (zero allocation).
 *
 * @param {Float32Array} mvpMat
 * @param {number} wx
 * @param {number} wy
 * @param {number} width
 * @param {number} height
 * @param {Float64Array} out
 * @param {number} [offset=0]
 */
export function projectWallPointToPixel(mvpMat, wx, wy, width, height, out, offset = 0) {
  const cx = mvpMat[0] * wx + mvpMat[4] * wy + mvpMat[12];
  const cy = mvpMat[1] * wx + mvpMat[5] * wy + mvpMat[13];
  const cw = mvpMat[3] * wx + mvpMat[7] * wy + mvpMat[15];
  if (cw <= 1e-4) {
    out[offset] = 0;
    out[offset + 1] = 0;
    out[offset + 2] = 1;
    return;
  }
  const invW = 1.0 / cw;
  const ndcX = cx * invW;
  const ndcY = cy * invW;
  out[offset] = (ndcX * 0.5 + 0.5) * width - 0.5;
  out[offset + 1] = (0.5 - ndcY * 0.5) * height - 0.5;
  out[offset + 2] = 0;
}

const projTmp = new Float64Array(3);

/**
 * Prepares per-subframe camera ray basis vectors from `mat4Perspective` & `mat4CameraView`.
 */
function preparePoseRayParams(pose, halfTanH, halfTanV, width, height, ctx, slot) {
  const view = ctx.viewMat;
  mat4CameraView(pose, view);

  // Column-major view matrix rows:
  // row 0 = R (indices 0, 4, 8), row 1 = U (1, 5, 9), row 2 = B (2, 6, 10)
  const rx = view[0], ry = view[4], rz = view[8];
  const ux = view[1], uy = view[5], uz = view[9];
  const bx = view[2], by = view[6], bz = view[10];

  const sx = (2.0 * halfTanH) / width;
  const sy = (-2.0 * halfTanV) / height;

  const off = slot * 18;
  const p = ctx.poseParams;
  p[off + 0] = pose.x;
  p[off + 1] = pose.y;
  p[off + 2] = pose.z;
  p[off + 3] = rx;
  p[off + 4] = ry;
  p[off + 5] = rz;
  p[off + 6] = ux;
  p[off + 7] = uy;
  p[off + 8] = uz;
  p[off + 9] = bx;
  p[off + 10] = by;
  p[off + 11] = bz;
  p[off + 12] = sx * rx; // dDx / dx
  p[off + 13] = sx * ry; // dDy / dx
  p[off + 14] = sx * rz; // dDz / dx
  p[off + 15] = sy * ux; // dDx / dy
  p[off + 16] = sy * uy; // dDy / dy
  p[off + 17] = sy * uz; // dDz / dy
}

/**
 * Computes the wall-plane bounding projection of every cell label across all active subframes.
 */
function computeVisibleLabelBoxes(scene, enc, poses, numPoses, halfBW, halfBH, width, height, ctx) {
  const numCells = enc.numCells;
  const boxMinX = ctx.boxMinX;
  const boxMaxX = ctx.boxMaxX;
  const boxMinY = ctx.boxMinY;
  const boxMaxY = ctx.boxMaxY;
  const boxVisible = ctx.boxVisible;
  const projMat = ctx.projMat;
  const viewMat = ctx.viewMat;
  const mvpMat = ctx.mvpMat;

  for (let i = 0; i < numCells; i++) {
    boxMinX[i] = width;
    boxMaxX[i] = -1;
    boxMinY[i] = height;
    boxMaxY[i] = -1;
    boxVisible[i] = 0;
  }

  // Add 0.2 in world pad so shutter edges and partial pixels stay well inside the union box
  const padW = halfBW + 0.25;
  const padH = halfBH + 0.25;

  for (let k = 0; k < numPoses; k++) {
    mat4CameraView(poses[k], viewMat);
    mat4Multiply(projMat, viewMat, mvpMat);

    for (let i = 0; i < numCells; i++) {
      const cx = enc.cellCx[i];
      const cy = enc.cellCy[i];
      let minX = width;
      let maxX = -1;
      let minY = height;
      let maxY = -1;
      let anyBehind = false;

      // Project the 4 corners of the label quad
      for (let c = 0; c < 4; c++) {
        const wx = (c & 1) ? cx + padW : cx - padW;
        const wy = (c & 2) ? cy + padH : cy - padH;
        projectWallPointToPixel(mvpMat, wx, wy, width, height, projTmp, 0);
        if (projTmp[2] !== 0) {
          anyBehind = true;
          break;
        }
        const px = projTmp[0];
        const py = projTmp[1];
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }

      if (anyBehind) {
        // Conservative fallback when a corner crosses behind the camera plane
        boxMinX[i] = 0;
        boxMaxX[i] = width - 1;
        boxMinY[i] = 0;
        boxMaxY[i] = height - 1;
        boxVisible[i] = 1;
        continue;
      }

      if (maxX < 0 || minX >= width || maxY < 0 || minY >= height) continue;

      const x0 = Math.max(0, (Math.floor(minX) | 0) - 2);
      const x1 = Math.min(width - 1, (Math.ceil(maxX) | 0) + 2);
      const y0 = Math.max(0, (Math.floor(minY) | 0) - 2);
      const y1 = Math.min(height - 1, (Math.ceil(maxY) | 0) + 2);

      if (x0 < boxMinX[i]) boxMinX[i] = x0;
      if (x1 > boxMaxX[i]) boxMaxX[i] = x1;
      if (y0 < boxMinY[i]) boxMinY[i] = y0;
      if (y1 > boxMaxY[i]) boxMaxY[i] = y1;
      boxVisible[i] = 1;
    }
  }
}

/**
 * Renders the tote wall (and labels when `includeLabels === true`) for a single pose slot
 * over the full frame into `out` (`Uint8Array`).
 * Zero heap allocations.
 */
function renderFullFrameSinglePose(
  scene,
  enc,
  ctx,
  poseSlot,
  width,
  height,
  halfTanH,
  halfTanV,
  labelWidthIn,
  labelHeightIn,
  isPicket,
  sideMarginIn,
  paperAlbedo,
  inkAlbedo,
  printGain,
  shadowStrength,
  noiseStrength,
  glareStrength,
  seedU32,
  includeLabels,
  out
) {
  const cols = scene.cols | 0;
  const rows = scene.rows | 0;
  const pitchX = scene.pitchXIn;
  const pitchY = scene.pitchYIn;
  const invPitchX = 1.0 / pitchX;
  const invPitchY = 1.0 / pitchY;
  const halfToteW = scene.tote.widthIn * 0.5;
  const halfToteH = scene.tote.heightIn * 0.5;
  const halfWallW = scene.wallWidthIn * 0.5;
  const halfWallH = scene.wallHeightIn * 0.5;
  const invWallW = 1.0 / scene.wallWidthIn;
  const invWallH = 1.0 / scene.wallHeightIn;

  const halfBW = labelWidthIn * 0.5;
  const halfBH = labelHeightIn * 0.5;
  const invLabelW = 1.0 / labelWidthIn;
  const invLabelH = 1.0 / labelHeightIn;
  const barHalfSpan = Math.max(0.05, (isPicket ? halfBH : halfBW) - sideMarginIn);
  const inkMinusPaper = inkAlbedo - paperAlbedo;

  const hasGlare = glareStrength > 0.001;
  const hasNoise = noiseStrength > 0.001;
  const glareToteScale = glareStrength * 0.28;
  const glareLabelScale = glareStrength * 0.16;
  const noiseScale = noiseStrength * 2.0;

  // Linear shadow gradient coefficients:
  // grad = 1 - shadowStrength * (0.42 * (0.5 - wy/wallH) + 0.25 * (0.5 + wx/wallW))
  //      = (1 - 0.335 * shadowStrength) - (0.25 * shadowStrength / wallW) * wx + (0.42 * shadowStrength / wallH) * wy
  const shadC0 = 1.0 - 0.335 * shadowStrength;
  const shadCx = -0.25 * shadowStrength * invWallW;
  const shadCy = 0.42 * shadowStrength * invWallH;

  const pOff = poseSlot * 18;
  const p = ctx.poseParams;
  const camX = p[pOff + 0], camY = p[pOff + 1], camZ = p[pOff + 2];
  const rx = p[pOff + 3], ry = p[pOff + 4], rz = p[pOff + 5];
  const ux = p[pOff + 6], uy = p[pOff + 7], uz = p[pOff + 8];
  const bx = p[pOff + 9], by = p[pOff + 10], bz = p[pOff + 11];
  const dDx_x = p[pOff + 12], dDy_x = p[pOff + 13], dDz_x = p[pOff + 14];
  const dDx_y = p[pOff + 15], dDy_y = p[pOff + 16], dDz_y = p[pOff + 17];

  const x0Ndc = (1.0 / width - 1.0) * halfTanH;
  const y0Ndc = (1.0 - 1.0 / height) * halfTanV;
  const baseDx0 = x0Ndc * rx + y0Ndc * ux - bx;
  const baseDy0 = x0Ndc * ry + y0Ndc * uy - by;
  const baseDz0 = x0Ndc * rz + y0Ndc * uz - bz;

  const toteLuma = enc.toteLuma;
  const cellModules = enc.cellModules;
  const cellTotalModules = enc.cellTotalModules;
  const maxCol = cols - 1;
  const maxRow = rows - 1;

  // Inlined mulberry32 state
  let rng = (seedU32 >>> 0) || 0x6d2b79f5;

  let rowDx = baseDx0;
  let rowDy = baseDy0;
  let rowDz = baseDz0;

  for (let y = 0; y < height; y++) {
    let Dx = rowDx;
    let Dy = rowDy;
    let Dz = rowDz;
    let outIdx = y * width;

    for (let x = 0; x < width; x++, outIdx++) {
      if (Dz >= -1e-6) {
        out[outIdx] = OUTSIDE_U8;
        Dx += dDx_x; Dy += dDy_x; Dz += dDz_x;
        continue;
      }

      const invDz = 1.0 / Dz;
      const t = -camZ * invDz;
      const wx = camX + t * Dx;
      const wy = camY + t * Dy;

      if (wx < -halfWallW || wx > halfWallW || wy < -halfWallH || wy > halfWallH) {
        out[outIdx] = OUTSIDE_U8;
        Dx += dDx_x; Dy += dDy_x; Dz += dDz_x;
        continue;
      }

      const uWall = (wx + halfWallW) * invPitchX;
      const vWall = (halfWallH - wy) * invPitchY;
      let col = uWall | 0;
      if (col < 0) col = 0; else if (col > maxCol) col = maxCol;
      let row = vWall | 0;
      if (row < 0) row = 0; else if (row > maxRow) row = maxRow;
      const cellIdx = row * cols + col;

      const lx = (uWall - col - 0.5) * pitchX;
      const ly = (0.5 - (vWall - row)) * pitchY;
      const absLx = lx < 0 ? -lx : lx;
      const absLy = ly < 0 ? -ly : ly;

      let albedo;
      let baseIllum = FLAT_ILLUM;
      let isLabel = false;
      let nx = 0.0;
      let ny = 0.0;
      let nz = 1.0;

      if (includeLabels && absLx <= halfBW && absLy <= halfBH) {
        isLabel = true;
        const inBars = isPicket ? (absLy <= barHalfSpan) : (absLx <= barHalfSpan);
        if (inBars) {
          let v01, dvDx, dvDy;
          if (!isPicket) {
            v01 = (halfBH - ly) * invLabelH;
            const dyInvDz = Dy * invDz;
            dvDx = -t * (dDy_x - dyInvDz * dDz_x) * invLabelH;
            dvDy = -t * (dDy_y - dyInvDz * dDz_y) * invLabelH;
          } else {
            v01 = (lx + halfBW) * invLabelW;
            const dxInvDz = Dx * invDz;
            dvDx = t * (dDx_x - dxInvDz * dDz_x) * invLabelW;
            dvDy = t * (dDx_y - dxInvDz * dDz_y) * invLabelW;
          }
          const dv = Math.sqrt(dvDx * dvDx + dvDy * dvDy);
          const barCov = sampleBarcodeIntegrated1D(
            cellModules[cellIdx],
            cellTotalModules[cellIdx],
            v01,
            dv,
            printGain
          );
          albedo = paperAlbedo + inkMinusPaper * barCov;
        } else {
          albedo = paperAlbedo;
        }
      } else {
        const edgeX = halfToteW - absLx;
        const edgeY = halfToteH - absLy;
        const edgeDist = edgeX < edgeY ? edgeX : edgeY;
        if (edgeDist < 0.22) {
          albedo = SEAM_LUMA;
        } else if (edgeDist < 0.65) {
          albedo = toteLuma[cellIdx] * 0.78;
          if (edgeX < edgeY) {
            if (lx >= 0) {
              nx = BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_PX;
            } else {
              nx = -BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_NX;
            }
          } else {
            if (ly >= 0) {
              ny = BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_PY;
            } else {
              ny = -BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_NY;
            }
          }
        } else {
          albedo = toteLuma[cellIdx];
          if (absLx < 2.6 && ly > 5.0 && ly < 6.2) {
            albedo *= 0.65;
          } else if (absLx > RIB_MIN_X && absLx < RIB_MAX_X && absLy < 5.5) {
            const ribIdx = ((absLx - RIB_MIN_X) * RIB_LUT_SCALE) | 0;
            albedo *= RIB_LUT[ribIdx];
          }
        }
      }

      let grad = shadC0 + shadCx * wx + shadCy * wy;
      if (grad < 0.35) grad = 0.35;
      else if (grad > 1.15) grad = 1.15;

      let lum = albedo * baseIllum * grad;

      if (hasGlare) {
        const vx = camX - wx;
        const vy = camY - wy;
        const vz = camZ;
        const invV = 1.0 / Math.sqrt(vx * vx + vy * vy + vz * vz);
        const hx = LIGHT_X + vx * invV;
        const hy = LIGHT_Y + vy * invV;
        const hz = LIGHT_Z + vz * invV;
        const invH = 1.0 / Math.sqrt(hx * hx + hy * hy + hz * hz);
        const ndh = (nx * hx + ny * hy + nz * hz) * invH;
        if (ndh > 0.0) {
          const lutIdx = (ndh >= 1.0 ? SPEC_LUT_SCALE : (ndh * SPEC_LUT_SCALE) | 0);
          lum += isLabel
            ? POW42_LUT[lutIdx] * glareLabelScale
            : POW18_LUT[lutIdx] * glareToteScale;
        }
      }

      if (hasNoise) {
        rng = (rng + 0x6d2b79f5) | 0;
        let nt = Math.imul(rng ^ (rng >>> 15), 1 | rng);
        nt = (nt + Math.imul(nt ^ (nt >>> 7), 61 | nt)) ^ nt;
        const u = ((nt ^ (nt >>> 14)) >>> 0) * (1.0 / 4294967296.0);
        lum += (u - 0.5) * noiseScale;
      }

      if (lum <= 0.0) out[outIdx] = 0;
      else if (lum >= 1.0) out[outIdx] = 255;
      else out[outIdx] = (lum * 255.0 + 0.5) | 0;

      Dx += dDx_x; Dy += dDy_x; Dz += dDz_x;
    }

    rowDx += dDx_y;
    rowDy += dDy_y;
    rowDz += dDz_y;
  }
}

/**
 * Accumulates exact subframe shutter motion blur across all `numPoses` poses
 * inside a single visible label bounding box `[x0..x1] x [y0..y1]`.
 * Zero heap allocations (reuses `ctx.boxAcc`).
 */
function renderLabelBoxMultiPose(
  scene,
  enc,
  ctx,
  numPoses,
  x0,
  y0,
  x1,
  y1,
  width,
  height,
  halfTanH,
  halfTanV,
  labelWidthIn,
  labelHeightIn,
  isPicket,
  sideMarginIn,
  paperAlbedo,
  inkAlbedo,
  printGain,
  shadowStrength,
  noiseStrength,
  glareStrength,
  seedU32,
  out
) {
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const count = bw * bh;
  if (count <= 0) return;

  if (ctx.boxAcc.length < count) {
    ctx.boxAcc = new Float32Array(count);
  }
  const acc = ctx.boxAcc;
  acc.fill(0, 0, count);

  const cols = scene.cols | 0;
  const rows = scene.rows | 0;
  const pitchX = scene.pitchXIn;
  const pitchY = scene.pitchYIn;
  const invPitchX = 1.0 / pitchX;
  const invPitchY = 1.0 / pitchY;
  const halfToteW = scene.tote.widthIn * 0.5;
  const halfToteH = scene.tote.heightIn * 0.5;
  const halfWallW = scene.wallWidthIn * 0.5;
  const halfWallH = scene.wallHeightIn * 0.5;
  const invWallW = 1.0 / scene.wallWidthIn;
  const invWallH = 1.0 / scene.wallHeightIn;

  const halfBW = labelWidthIn * 0.5;
  const halfBH = labelHeightIn * 0.5;
  const invLabelW = 1.0 / labelWidthIn;
  const invLabelH = 1.0 / labelHeightIn;
  const barHalfSpan = Math.max(0.05, (isPicket ? halfBH : halfBW) - sideMarginIn);
  const inkMinusPaper = inkAlbedo - paperAlbedo;

  const hasGlare = glareStrength > 0.001;
  const hasNoise = noiseStrength > 0.001;
  const glareToteScale = glareStrength * 0.28;
  const glareLabelScale = glareStrength * 0.16;
  const noiseScale = noiseStrength * 2.0;

  const shadC0 = 1.0 - 0.335 * shadowStrength;
  const shadCx = -0.25 * shadowStrength * invWallW;
  const shadCy = 0.42 * shadowStrength * invWallH;

  const x0Ndc = (1.0 / width - 1.0) * halfTanH;
  const y0Ndc = (1.0 - 1.0 / height) * halfTanV;

  const toteLuma = enc.toteLuma;
  const cellModules = enc.cellModules;
  const cellTotalModules = enc.cellTotalModules;
  const maxCol = cols - 1;
  const maxRow = rows - 1;
  const p = ctx.poseParams;

  for (let k = 0; k < numPoses; k++) {
    const pOff = k * 18;
    const camX = p[pOff + 0], camY = p[pOff + 1], camZ = p[pOff + 2];
    const rx = p[pOff + 3], ry = p[pOff + 4], rz = p[pOff + 5];
    const ux = p[pOff + 6], uy = p[pOff + 7], uz = p[pOff + 8];
    const bx = p[pOff + 9], by = p[pOff + 10], bz = p[pOff + 11];
    const dDx_x = p[pOff + 12], dDy_x = p[pOff + 13], dDz_x = p[pOff + 14];
    const dDx_y = p[pOff + 15], dDy_y = p[pOff + 16], dDz_y = p[pOff + 17];

    const startDx = x0Ndc * rx + y0Ndc * ux - bx + x0 * dDx_x + y0 * dDx_y;
    const startDy = x0Ndc * ry + y0Ndc * uy - by + x0 * dDy_x + y0 * dDy_y;
    const startDz = x0Ndc * rz + y0Ndc * uz - bz + x0 * dDz_x + y0 * dDz_y;

    let rng = ((seedU32 + Math.imul(k + 1, 0x9e3779b1) + Math.imul(x0, 73856093) + Math.imul(y0, 19349663)) >>> 0) || 1;

    let rowDx = startDx;
    let rowDy = startDy;
    let rowDz = startDz;
    let accIdx = 0;

    for (let y = y0; y <= y1; y++) {
      let Dx = rowDx;
      let Dy = rowDy;
      let Dz = rowDz;

      for (let x = x0; x <= x1; x++, accIdx++) {
        if (Dz >= -1e-6) {
          acc[accIdx] += OUTSIDE_LUMA;
          Dx += dDx_x; Dy += dDy_x; Dz += dDz_x;
          continue;
        }

        const invDz = 1.0 / Dz;
        const t = -camZ * invDz;
        const wx = camX + t * Dx;
        const wy = camY + t * Dy;

        if (wx < -halfWallW || wx > halfWallW || wy < -halfWallH || wy > halfWallH) {
          acc[accIdx] += OUTSIDE_LUMA;
          Dx += dDx_x; Dy += dDy_x; Dz += dDz_x;
          continue;
        }

        const uWall = (wx + halfWallW) * invPitchX;
        const vWall = (halfWallH - wy) * invPitchY;
        let col = uWall | 0;
        if (col < 0) col = 0; else if (col > maxCol) col = maxCol;
        let row = vWall | 0;
        if (row < 0) row = 0; else if (row > maxRow) row = maxRow;
        const cellIdx = row * cols + col;

        const lx = (uWall - col - 0.5) * pitchX;
        const ly = (0.5 - (vWall - row)) * pitchY;
        const absLx = lx < 0 ? -lx : lx;
        const absLy = ly < 0 ? -ly : ly;

        let albedo;
        let baseIllum = FLAT_ILLUM;
        let isLabel = false;
        let nx = 0.0;
        let ny = 0.0;
        let nz = 1.0;

        if (absLx <= halfBW && absLy <= halfBH) {
          isLabel = true;
          const inBars = isPicket ? (absLy <= barHalfSpan) : (absLx <= barHalfSpan);
          if (inBars) {
            let v01, dvDx, dvDy;
            if (!isPicket) {
              v01 = (halfBH - ly) * invLabelH;
              const dyInvDz = Dy * invDz;
              dvDx = -t * (dDy_x - dyInvDz * dDz_x) * invLabelH;
              dvDy = -t * (dDy_y - dyInvDz * dDz_y) * invLabelH;
            } else {
              v01 = (lx + halfBW) * invLabelW;
              const dxInvDz = Dx * invDz;
              dvDx = t * (dDx_x - dxInvDz * dDz_x) * invLabelW;
              dvDy = t * (dDx_y - dxInvDz * dDz_y) * invLabelW;
            }
            const dv = Math.sqrt(dvDx * dvDx + dvDy * dvDy);
            const barCov = sampleBarcodeIntegrated1D(
              cellModules[cellIdx],
              cellTotalModules[cellIdx],
              v01,
              dv,
              printGain
            );
            albedo = paperAlbedo + inkMinusPaper * barCov;
          } else {
            albedo = paperAlbedo;
          }
        } else {
          const edgeX = halfToteW - absLx;
          const edgeY = halfToteH - absLy;
          const edgeDist = edgeX < edgeY ? edgeX : edgeY;
          if (edgeDist < 0.22) {
            albedo = SEAM_LUMA;
          } else if (edgeDist < 0.65) {
            albedo = toteLuma[cellIdx] * 0.78;
            if (edgeX < edgeY) {
              if (lx >= 0) {
                nx = BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_PX;
              } else {
                nx = -BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_NX;
              }
            } else {
              if (ly >= 0) {
                ny = BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_PY;
              } else {
                ny = -BEVEL_S; nz = BEVEL_Z; baseIllum = BEVEL_ILLUM_NY;
              }
            }
          } else {
            albedo = toteLuma[cellIdx];
            if (absLx < 2.6 && ly > 5.0 && ly < 6.2) {
              albedo *= 0.65;
            } else if (absLx > RIB_MIN_X && absLx < RIB_MAX_X && absLy < 5.5) {
              const ribIdx = ((absLx - RIB_MIN_X) * RIB_LUT_SCALE) | 0;
              albedo *= RIB_LUT[ribIdx];
            }
          }
        }

        let grad = shadC0 + shadCx * wx + shadCy * wy;
        if (grad < 0.35) grad = 0.35;
        else if (grad > 1.15) grad = 1.15;

        let lum = albedo * baseIllum * grad;

        if (hasGlare) {
          const vx = camX - wx;
          const vy = camY - wy;
          const vz = camZ;
          const invV = 1.0 / Math.sqrt(vx * vx + vy * vy + vz * vz);
          const hx = LIGHT_X + vx * invV;
          const hy = LIGHT_Y + vy * invV;
          const hz = LIGHT_Z + vz * invV;
          const invH = 1.0 / Math.sqrt(hx * hx + hy * hy + hz * hz);
          const ndh = (nx * hx + ny * hy + nz * hz) * invH;
          if (ndh > 0.0) {
            const lutIdx = (ndh >= 1.0 ? SPEC_LUT_SCALE : (ndh * SPEC_LUT_SCALE) | 0);
            lum += isLabel
              ? POW42_LUT[lutIdx] * glareLabelScale
              : POW18_LUT[lutIdx] * glareToteScale;
          }
        }

        if (hasNoise) {
          rng = (rng + 0x6d2b79f5) | 0;
          let nt = Math.imul(rng ^ (rng >>> 15), 1 | rng);
          nt = (nt + Math.imul(nt ^ (nt >>> 7), 61 | nt)) ^ nt;
          const u = ((nt ^ (nt >>> 14)) >>> 0) * (1.0 / 4294967296.0);
          lum += (u - 0.5) * noiseScale;
        }

        if (lum < 0.0) lum = 0.0;
        else if (lum > 1.0) lum = 1.0;
        acc[accIdx] += lum;

        Dx += dDx_x; Dy += dDy_x; Dz += dDz_x;
      }

      rowDx += dDx_y;
      rowDy += dDy_y;
      rowDz += dDz_y;
    }
  }

  const invN = 255.0 / numPoses;
  let accIdx = 0;
  for (let y = y0; y <= y1; y++) {
    let outIdx = y * width + x0;
    for (let x = x0; x <= x1; x++, accIdx++, outIdx++) {
      const v = (acc[accIdx] * invN + 0.5) | 0;
      out[outIdx] = v < 0 ? 0 : (v > 255 ? 255 : v);
    }
  }
}

/**
 * Renders a top-down `width x height` 8-bit luma frame of `scene` for `poses[]`.
 * Zero per-frame heap allocations when `out` (length >= `width * height`) is passed.
 *
 * @param {object} scene - Scene created by `createScene` / `createSceneForPreset` (`src/sim/scene.js`)
 * @param {Array<object> | object} poses - 1 pose (sharp) or N poses across shutter interval (blur)
 * @param {{
 *   width: number,
 *   height: number,
 *   hfovDeg: number,
 *   shadowStrength?: number,
 *   noiseStrength?: number,
 *   glareStrength?: number,
 *   labelWidthIn?: number,
 *   labelHeightIn?: number,
 *   labelOrientation?: 'ladder' | 'picket',
 *   printGain?: number,
 *   frameSeed?: number,
 *   seed?: number,
 *   ctx?: object,
 * }} opts
 * @param {Uint8Array | null} [out]
 * @returns {Uint8Array}
 */
export function renderFrame(scene, poses, opts, out = null) {
  const width = opts.width | 0;
  const height = opts.height | 0;
  const totalPx = Math.imul(width, height);
  const dst = (out && out.byteLength >= totalPx) ? out : new Uint8Array(totalPx);

  const ctx = opts.ctx || defaultCtx;
  const enc = getEncodedScene(scene);

  let poseList;
  let numPoses;
  if (Array.isArray(poses)) {
    poseList = poses;
    numPoses = Math.min(poses.length, MAX_SUBFRAMES);
  } else {
    ctx.singlePoseWrap[0] = poses;
    poseList = ctx.singlePoseWrap;
    numPoses = 1;
  }
  if (numPoses <= 0) {
    dst.fill(OUTSIDE_U8, 0, totalPx);
    return dst;
  }

  const aspect = width / height;
  const halfTanH = Math.tan((opts.hfovDeg * 0.5) * DEG2RAD);
  const halfTanV = halfTanH / aspect;
  const vfovRad = 2.0 * Math.atan(halfTanV);
  mat4Perspective(vfovRad, aspect, 0.5, 500.0, ctx.projMat);

  const lbl = scene.label || DEFAULT_LABEL_SPEC;
  const labelWidthIn = opts.labelWidthIn ?? lbl.widthIn ?? DEFAULT_LABEL_SPEC.widthIn;
  const labelHeightIn = opts.labelHeightIn ?? lbl.heightIn ?? DEFAULT_LABEL_SPEC.heightIn;
  const orientation = opts.labelOrientation ?? lbl.orientation ?? DEFAULT_LABEL_SPEC.orientation;
  const isPicket = orientation === 'picket';
  const sideMarginIn = lbl.sideMarginIn ?? DEFAULT_LABEL_SPEC.sideMarginIn;
  const paperAlbedo = lbl.paperAlbedo ?? DEFAULT_LABEL_SPEC.paperAlbedo;
  const inkAlbedo = lbl.inkAlbedo ?? DEFAULT_LABEL_SPEC.inkAlbedo;
  const printGain = opts.printGain ?? lbl.printGain ?? 1.0;

  const shadowStrength = opts.shadowStrength ?? scene.shadowStrength ?? 0.35;
  const noiseStrength = opts.noiseStrength ?? scene.noiseStrength ?? 0.015;
  const glareStrength = opts.glareStrength ?? scene.glareStrength ?? 0.16;

  const rawSeed = opts.seed !== undefined ? opts.seed : (opts.frameSeed !== undefined ? opts.frameSeed : 0);
  const seedU32 = (Math.imul(Math.round(rawSeed * 1000) | 0, 0x9e3779b1) ^ 0x85ebca6b) >>> 0;

  for (let k = 0; k < numPoses; k++) {
    preparePoseRayParams(poseList[k], halfTanH, halfTanV, width, height, ctx, k);
  }

  if (numPoses === 1) {
    renderFullFrameSinglePose(
      scene,
      enc,
      ctx,
      0,
      width,
      height,
      halfTanH,
      halfTanV,
      labelWidthIn,
      labelHeightIn,
      isPicket,
      sideMarginIn,
      paperAlbedo,
      inkAlbedo,
      printGain,
      shadowStrength,
      noiseStrength,
      glareStrength,
      seedU32,
      true,
      dst
    );
    return dst;
  }

  // Multi-subframe shutter blur:
  // 1) Render tote background analytically at mid-shutter pose (variance-matched noise).
  const midSlot = numPoses >> 1;
  const bgNoise = noiseStrength / Math.sqrt(numPoses);
  renderFullFrameSinglePose(
    scene,
    enc,
    ctx,
    midSlot,
    width,
    height,
    halfTanH,
    halfTanV,
    labelWidthIn,
    labelHeightIn,
    isPicket,
    sideMarginIn,
    paperAlbedo,
    inkAlbedo,
    printGain,
    shadowStrength,
    bgNoise,
    glareStrength,
    seedU32,
    false,
    dst
  );

  // 2) Render each visible label's union bounding box with exact N-pose temporal integration.
  computeVisibleLabelBoxes(
    scene,
    enc,
    poseList,
    numPoses,
    labelWidthIn * 0.5,
    labelHeightIn * 0.5,
    width,
    height,
    ctx
  );

  for (let i = 0; i < enc.numCells; i++) {
    if (ctx.boxVisible[i] === 0) continue;
    renderLabelBoxMultiPose(
      scene,
      enc,
      ctx,
      numPoses,
      ctx.boxMinX[i],
      ctx.boxMinY[i],
      ctx.boxMaxX[i],
      ctx.boxMaxY[i],
      width,
      height,
      halfTanH,
      halfTanV,
      labelWidthIn,
      labelHeightIn,
      isPicket,
      sideMarginIn,
      paperAlbedo,
      inkAlbedo,
      printGain,
      shadowStrength,
      noiseStrength,
      glareStrength,
      seedU32,
      dst
    );
  }

  return dst;
}
