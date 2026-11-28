/**
 * K7 — Moving Specular Glare & Co-Located Camera Torch Model
 * (`src/sim/camera-model/glare.js`).
 *
 * Models physically-inspired Blinn-Phong specular glare lobes on semi-gloss/glossy
 * label stock from:
 *  - Co-located camera torch (peaks where view ray aligns with wall normal, moving
 *    dynamically with camera pose and saturating/washing out local bar contrast).
 *  - Overhead room light source(s).
 * Also provides `computeTorchLuxBoost` to feed K2 AE (driving exposure down when torch is on).
 *
 * Zero per-frame heap allocations inside `applyGlareModel`.
 * Gated by `enabled` / `simGlare` (default OFF).
 */

import { mat4CameraView, mat4Perspective, mat4Multiply } from '../paths.js';
import { projectWallPointToPixel } from '../cpu-render.js';

const DEG2RAD = Math.PI / 180;
const SPEC_LUT_SIZE = 1024;
const SPEC_LUT_MAX = SPEC_LUT_SIZE - 1;

export const DEFAULT_GLARE_CONFIG = Object.freeze({
  enabled: false,
  torchEnabled: false,
  torchIntensity: 0.95,      // specular peak contribution at reference distance
  torchRefDistIn: 12.0,      // reference working distance for inverse-square falloff
  torchLuxAt12In: 900,       // extra scene lux at 12 in (feeds K2 AE)
  torchBeamExp: 4.0,         // mild flashlight cone falloff
  roomGlareEnabled: true,
  roomIntensity: 0.35,       // overhead room specular contribution
  roomLightDirX: -0.15,      // overhead room light direction vector (normalized on use)
  roomLightDirY: 0.35,
  roomLightDirZ: 0.92,
  gloss: 0.85,               // stock gloss multiplier (0 = matte, 0.5-0.85 = semi-gloss, 1.0 = glossy)
  specExponent: 36.0,        // Blinn-Phong specular sharpness exponent
});

function buildSpecLut(lut, exponent) {
  const exp = exponent > 1 ? exponent : 1;
  for (let i = 0; i < SPEC_LUT_SIZE; i++) {
    lut[i] = Math.pow(i / SPEC_LUT_MAX, exp);
  }
}

/**
 * Computes extra scene illumination (lux) contributed by the camera torch at `distanceIn`,
 * intended to feed K2 `stepExposure(expState, dtSec, torchLuxBoost)`.
 * Returns 0 when `enabled === false` or `torchEnabled === false`.
 *
 * @param {number} distanceIn
 * @param {Partial<typeof DEFAULT_GLARE_CONFIG>} [config]
 * @returns {number}
 */
export function computeTorchLuxBoost(distanceIn, config = {}) {
  if (!config.enabled || !config.torchEnabled) return 0;
  const refDist = config.torchRefDistIn ?? DEFAULT_GLARE_CONFIG.torchRefDistIn;
  const luxAtRef = config.torchLuxAt12In ?? DEFAULT_GLARE_CONFIG.torchLuxAt12In;
  const d = distanceIn > 4.0 ? distanceIn : 4.0;
  const ratio = refDist / d;
  return luxAtRef * ratio * ratio;
}

/**
 * Predicts the closed-form image pixel `[px, py, behindFlag]` of the specular hotspot peak
 * on the `Z = 0` wall plane for a given camera `pose` and light source.
 *  - For the co-located camera torch (`lightDir == null`), the peak occurs where `V || N = (0,0,1)`,
 *    i.e., at wall point `(pose.x, pose.y, 0)`.
 *  - For a directional room light `(lx, ly, lz)`, the peak occurs where `V = reflect(-L, N) = (-lx, -ly, lz)`,
 *    i.e., at wall point `(pose.x + pose.z * lx / lz, pose.y + pose.z * ly / lz, 0)`.
 * Writes `[px, py, behindFlag]` into `out` (zero allocation).
 *
 * @param {object} pose
 * @param {number} width
 * @param {number} height
 * @param {number} hfovDeg
 * @param {{ x: number, y: number, z: number } | null} lightDir
 * @param {Float64Array} out
 * @param {ReturnType<typeof createGlareState>} [state]
 */
export function predictSpecHotspotPixel(pose, width, height, hfovDeg, lightDir, out, state) {
  const viewMat = state ? state.viewMat : new Float32Array(16);
  const projMat = state ? state.projMat : new Float32Array(16);
  const mvpMat = state ? state.mvpMat : new Float32Array(16);

  const aspect = width / height;
  const halfTanH = Math.tan((hfovDeg * 0.5) * DEG2RAD);
  const halfTanV = halfTanH / aspect;
  const vfovRad = 2.0 * Math.atan(halfTanV);
  mat4Perspective(vfovRad, aspect, 0.5, 500.0, projMat);
  mat4CameraView(pose, viewMat);
  mat4Multiply(projMat, viewMat, mvpMat);

  let wx = pose.x;
  let wy = pose.y;
  if (lightDir) {
    const len = Math.hypot(lightDir.x, lightDir.y, lightDir.z) || 1.0;
    const lx = lightDir.x / len;
    const ly = lightDir.y / len;
    const lz = Math.max(0.05, lightDir.z / len);
    // H = normalize(L + V) || (0,0,1) => Vx = -lx, Vy = -ly, Vz = lz
    // Since V = normalize(C - W), W = C - (Cz / lz) * V = (Cx + Cz*lx/lz, Cy + Cz*ly/lz, 0)
    wx = pose.x + (pose.z * lx) / lz;
    wy = pose.y + (pose.z * ly) / lz;
  }

  projectWallPointToPixel(mvpMat, wx, wy, width, height, out, 0);
  return out;
}

/**
 * Creates a reusable, zero-allocation specular glare state.
 *
 * @param {Partial<typeof DEFAULT_GLARE_CONFIG>} [config]
 */
export function createGlareState(config = {}) {
  const specExponent = config.specExponent ?? DEFAULT_GLARE_CONFIG.specExponent;
  const specLut = new Float32Array(SPEC_LUT_SIZE);
  buildSpecLut(specLut, specExponent);

  return {
    enabled: Boolean(config.enabled ?? DEFAULT_GLARE_CONFIG.enabled),
    torchEnabled: Boolean(config.torchEnabled ?? DEFAULT_GLARE_CONFIG.torchEnabled),
    torchIntensity: config.torchIntensity ?? DEFAULT_GLARE_CONFIG.torchIntensity,
    torchRefDistIn: config.torchRefDistIn ?? DEFAULT_GLARE_CONFIG.torchRefDistIn,
    torchLuxAt12In: config.torchLuxAt12In ?? DEFAULT_GLARE_CONFIG.torchLuxAt12In,
    torchBeamExp: config.torchBeamExp ?? DEFAULT_GLARE_CONFIG.torchBeamExp,
    roomGlareEnabled: Boolean(config.roomGlareEnabled ?? DEFAULT_GLARE_CONFIG.roomGlareEnabled),
    roomIntensity: config.roomIntensity ?? DEFAULT_GLARE_CONFIG.roomIntensity,
    roomLightDirX: config.roomLightDirX ?? DEFAULT_GLARE_CONFIG.roomLightDirX,
    roomLightDirY: config.roomLightDirY ?? DEFAULT_GLARE_CONFIG.roomLightDirY,
    roomLightDirZ: config.roomLightDirZ ?? DEFAULT_GLARE_CONFIG.roomLightDirZ,
    gloss: config.gloss ?? DEFAULT_GLARE_CONFIG.gloss,
    specExponent,
    _cachedSpecExp: specExponent,

    // Pre-allocated scratch buffers (zero hot-loop alloc)
    specLut,
    viewMat: new Float32Array(16),
    projMat: new Float32Array(16),
    mvpMat: new Float32Array(16),
  };
}

/**
 * Applies moving specular glare (co-located camera torch + overhead room light) onto
 * `src` (`Uint8Array`) and writes to `out`. Supports in-place (`out === src`) and
 * zero heap allocations.
 *
 * When `state.enabled === false` or both torch and room glare are disabled, returns
 * `src` unchanged (exact no-op).
 *
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {object} pose - `{ x, y, z, yawDeg, pitchDeg, rollDeg }`
 * @param {number} hfovDeg
 * @param {ReturnType<typeof createGlareState>} state
 * @param {Uint8Array} [out]
 * @returns {Uint8Array}
 */
export function applyGlareModel(src, width, height, pose, hfovDeg, state, out = src) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.imul(w, h);

  const torchOn = Boolean(state && state.enabled && state.torchEnabled && state.torchIntensity > 1e-4);
  const roomOn = Boolean(state && state.enabled && state.roomGlareEnabled && state.roomIntensity > 1e-4);
  const gloss = state ? state.gloss : 0;

  if (!state || !state.enabled || gloss <= 1e-4 || (!torchOn && !roomOn)) {
    if (out !== src) {
      for (let i = 0; i < n; i++) out[i] = src[i];
    }
    return out;
  }

  if (state._cachedSpecExp !== state.specExponent) {
    buildSpecLut(state.specLut, state.specExponent);
    state._cachedSpecExp = state.specExponent;
  }

  // Camera ray basis identical to cpu-render.js
  const view = state.viewMat;
  mat4CameraView(pose, view);
  const rx = view[0], ry = view[4], rz = view[8];
  const ux = view[1], uy = view[5], uz = view[9];
  const bx = view[2], by = view[6], bz = view[10];

  const aspect = w / h;
  const halfTanH = Math.tan((hfovDeg * 0.5) * DEG2RAD);
  const halfTanV = halfTanH / aspect;
  const sx = (2.0 * halfTanH) / w;
  const sy = (-2.0 * halfTanV) / h;

  const dDx_x = sx * rx, dDy_x = sx * ry, dDz_x = sx * rz;
  const dDx_y = sy * ux, dDy_y = sy * uy, dDz_y = sy * uz;

  // Ray at pixel (0, 0) center: ndcX = -1 + 1/w, ndcY = 1 - 1/h
  const nx0 = -halfTanH + 0.5 * sx;
  const ny0 = halfTanV + 0.5 * sy;
  let rowDx = nx0 * rx + ny0 * ux - bx;
  let rowDy = nx0 * ry + ny0 * uy - by;
  let rowDz = nx0 * rz + ny0 * uz - bz;

  // Normalized room light direction
  const rLen = Math.hypot(state.roomLightDirX, state.roomLightDirY, state.roomLightDirZ) || 1.0;
  const rlx = state.roomLightDirX / rLen;
  const rly = state.roomLightDirY / rLen;
  const rlz = state.roomLightDirZ / rLen;

  // Torch inverse-square distance scaling
  const cz = pose.z > 2.0 ? pose.z : 2.0;
  const distRatio = state.torchRefDistIn / cz;
  const torchDistScale = Math.min(2.2, distRatio * distRatio);
  const torchGain = state.torchIntensity * gloss * torchDistScale * 255.0;
  const roomGain = state.roomIntensity * gloss * 255.0;
  const specLut = state.specLut;

  for (let y = 0; y < h; y++) {
    let Dx = rowDx;
    let Dy = rowDy;
    let Dz = rowDz;
    const rowOff = Math.imul(y, w);

    for (let x = 0; x < w; x++) {
      let glareU8 = 0;

      if (Dz < -1e-4) {
        const invLen = 1.0 / Math.hypot(Dx, Dy, Dz);
        // V = -normalize(D) (direction from wall point to camera)
        const vx = -Dx * invLen;
        const vy = -Dy * invLen;
        const vz = -Dz * invLen;

        if (torchOn && vz > 0) {
          // Co-located torch: L = V => H = V => N.H = vz
          let idx = (vz * SPEC_LUT_MAX + 0.5) | 0;
          if (idx > SPEC_LUT_MAX) idx = SPEC_LUT_MAX;
          // Mild flashlight cone falloff relative to camera forward (-B)
          const cosCone = vx * bx + vy * by + vz * bz;
          const cone = cosCone > 0 ? (cosCone * cosCone) : 0;
          glareU8 += specLut[idx] * cone * torchGain;
        }

        if (roomOn) {
          // Overhead room light: H = normalize(L_room + V), N.H = Hz
          const hx = rlx + vx;
          const hy = rly + vy;
          const hz = rlz + vz;
          if (hz > 0) {
            const ndh = hz / Math.hypot(hx, hy, hz);
            let idx = (ndh * SPEC_LUT_MAX + 0.5) | 0;
            if (idx > SPEC_LUT_MAX) idx = SPEC_LUT_MAX;
            glareU8 += specLut[idx] * roomGain;
          }
        }
      }

      const v = (src[rowOff + x] + glareU8 + 0.5) | 0;
      out[rowOff + x] = v > 255 ? 255 : v;

      Dx += dDx_x;
      Dy += dDy_x;
      Dz += dDz_x;
    }

    rowDx += dDx_y;
    rowDy += dDy_y;
    rowDz += dDz_y;
  }

  return out;
}
