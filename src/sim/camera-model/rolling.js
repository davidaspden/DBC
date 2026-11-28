/**
 * K4 — Rolling Shutter Band Renderer (`src/sim/camera-model/rolling.js`).
 *
 * Models CMOS rolling shutter readout (`readoutMs` 20-30 ms, default 25 ms) by
 * evaluating/interpolating camera pose at `t0 + (rowCenter / height) * readoutSec`
 * across horizontal row bands (`bandHeight`, default 8 rows).
 *
 * Supports:
 *  - Custom zero-alloc `renderBandFn(y0, y1, pose, out)` callback, OR
 *  - Direct composition over `renderFrame` from `../cpu-render.js` using a
 *    pre-allocated scratch frame buffer (no edits to `cpu-render.js`).
 *
 * When `enabled === false` (`simRolling` off), delegates directly to a single
 * pose render so output is bit-for-bit identical to standard rendering.
 *
 * Zero per-frame heap allocations inside `renderRollingBands` / `renderRollingFrame`.
 * Gated by `enabled` / `simRolling` (default OFF).
 */

import { renderFrame, createCpuRenderContext } from '../cpu-render.js';

export const DEFAULT_ROLLING_CONFIG = Object.freeze({
  enabled: false,
  readoutMs: 25.0,   // typical smartphone CMOS rolling readout (20-30 ms)
  bandHeight: 8,     // rows per interpolated pose band
});

/**
 * Linearly interpolates between `poseA` and `poseB` at fraction `t` into `out` (zero allocation).
 *
 * @param {object} poseA
 * @param {object} poseB
 * @param {number} t
 * @param {object} out
 * @returns {object}
 */
export function interpolatePose(poseA, poseB, t, out) {
  const s = 1.0 - t;
  out.x = poseA.x * s + poseB.x * t;
  out.y = poseA.y * s + poseB.y * t;
  out.z = poseA.z * s + poseB.z * t;
  out.yawDeg = (poseA.yawDeg || 0) * s + (poseB.yawDeg || 0) * t;
  out.pitchDeg = (poseA.pitchDeg || 0) * s + (poseB.pitchDeg || 0) * t;
  out.rollDeg = (poseA.rollDeg || 0) * s + (poseB.rollDeg || 0) * t;
  return out;
}

/**
 * Computes closed-form horizontal rolling-shutter shear (pixels) of a vertical edge
 * spanning `dyPx` rows during a horizontal pan at `speedInPerSec`.
 *
 * @param {number} speedInPerSec
 * @param {number} readoutMs
 * @param {number} pxPerInch
 * @param {number} dyPx
 * @param {number} heightPx
 * @returns {number}
 */
export function expectedRollingShearPx(speedInPerSec, readoutMs, pxPerInch, dyPx, heightPx) {
  if (!(heightPx > 0)) return 0;
  const dtSec = (dyPx / heightPx) * (readoutMs * 1e-3);
  return speedInPerSec * dtSec * pxPerInch;
}

/**
 * Creates a reusable, zero-allocation rolling shutter renderer state.
 *
 * @param {number} width
 * @param {number} height
 * @param {Partial<typeof DEFAULT_ROLLING_CONFIG>} [config]
 */
export function createRollingState(width, height, config = {}) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.imul(w, h);
  return {
    width: w,
    height: h,
    enabled: Boolean(config.enabled ?? DEFAULT_ROLLING_CONFIG.enabled),
    readoutMs: config.readoutMs ?? DEFAULT_ROLLING_CONFIG.readoutMs,
    bandHeight: Math.max(1, (config.bandHeight ?? DEFAULT_ROLLING_CONFIG.bandHeight) | 0),

    // Pre-allocated scratch buffers & structs (zero hot-loop alloc)
    scratchFrame: new Uint8Array(n),
    cpuCtx: createCpuRenderContext(),
    bandPose: { x: 0, y: 0, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    bandOpts: {
      width: w,
      height: h,
      hfovDeg: 70.7,
      shadowStrength: undefined,
      noiseStrength: undefined,
      glareStrength: undefined,
      labelWidthIn: undefined,
      labelHeightIn: undefined,
      labelOrientation: undefined,
      printGain: undefined,
      seed: 0,
      ctx: null,
    },
  };
}

/**
 * Resolves a pose at time `tRowSec` (fraction `frac` in [0, 1]) into `outPose`.
 * `poseSource` may be:
 *  - a function `(tSec, outPose) => void | pose`
 *  - an object `{ poseStart, poseEnd }` (interpolated by `frac`)
 *  - a single static pose object
 */
function resolvePoseAtBand(poseSource, t0Sec, tRowSec, frac, outPose) {
  if (typeof poseSource === 'function') {
    const res = poseSource(tRowSec, outPose);
    if (res && res !== outPose) {
      outPose.x = res.x;
      outPose.y = res.y;
      outPose.z = res.z;
      outPose.yawDeg = res.yawDeg || 0;
      outPose.pitchDeg = res.pitchDeg || 0;
      outPose.rollDeg = res.rollDeg || 0;
    }
    return outPose;
  }
  if (poseSource && poseSource.poseStart && poseSource.poseEnd) {
    return interpolatePose(poseSource.poseStart, poseSource.poseEnd, frac, outPose);
  }
  // Static pose fallback
  outPose.x = poseSource.x;
  outPose.y = poseSource.y;
  outPose.z = poseSource.z;
  outPose.yawDeg = poseSource.yawDeg || 0;
  outPose.pitchDeg = poseSource.pitchDeg || 0;
  outPose.rollDeg = poseSource.rollDeg || 0;
  return outPose;
}

/**
 * Renders a frame via a user-supplied band renderer `renderBandFn(y0, y1, pose, out)`.
 * When `state.enabled === false`, invokes `renderBandFn(0, height, poseAtT0, out)` once.
 * Zero per-frame heap allocations.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} t0Sec
 * @param {Function | { poseStart: object, poseEnd: object } | object} poseSource
 * @param {(y0: number, y1: number, pose: object, out: Uint8Array) => void} renderBandFn
 * @param {ReturnType<typeof createRollingState>} state
 * @param {Uint8Array} out
 * @returns {Uint8Array}
 */
export function renderRollingBands(width, height, t0Sec, poseSource, renderBandFn, state, out) {
  const h = height | 0;
  const bandPose = state.bandPose;

  if (!state.enabled) {
    resolvePoseAtBand(poseSource, t0Sec, t0Sec, 0, bandPose);
    renderBandFn(0, h, bandPose, out);
    return out;
  }

  const readoutSec = state.readoutMs * 1e-3;
  const bandH = state.bandHeight > 0 ? state.bandHeight : 8;
  const invH = 1.0 / h;

  for (let y0 = 0; y0 < h; y0 += bandH) {
    const y1 = y0 + bandH < h ? y0 + bandH : h;
    const rowCenter = (y0 + y1) * 0.5;
    const frac = rowCenter * invH;
    const tRow = t0Sec + frac * readoutSec;
    resolvePoseAtBand(poseSource, t0Sec, tRow, frac, bandPose);
    renderBandFn(y0, y1, bandPose, out);
  }
  return out;
}

/**
 * Renders a full `scene` frame with rolling shutter by composing row bands over
 * `renderFrame` from `../cpu-render.js` using `state.scratchFrame` (zero allocation).
 *
 * When `state.enabled === false` (`simRolling` off), calls `renderFrame` directly with
 * the single `t0Sec` pose so output is bit-for-bit identical to standard rendering.
 *
 * @param {object} scene
 * @param {number} t0Sec
 * @param {Function | { poseStart: object, poseEnd: object } | object} poseSource
 * @param {object} renderOpts - same shape as `renderFrame` opts
 * @param {ReturnType<typeof createRollingState>} state
 * @param {Uint8Array} out
 * @returns {Uint8Array}
 */
export function renderRollingFrame(scene, t0Sec, poseSource, renderOpts, state, out) {
  const w = (renderOpts.width ?? state.width) | 0;
  const h = (renderOpts.height ?? state.height) | 0;
  const bandPose = state.bandPose;

  // Copy renderOpts fields into pre-allocated bandOpts (zero alloc)
  const bOpts = state.bandOpts;
  bOpts.width = w;
  bOpts.height = h;
  bOpts.hfovDeg = renderOpts.hfovDeg;
  bOpts.shadowStrength = renderOpts.shadowStrength;
  bOpts.noiseStrength = renderOpts.noiseStrength;
  bOpts.glareStrength = renderOpts.glareStrength;
  bOpts.labelWidthIn = renderOpts.labelWidthIn;
  bOpts.labelHeightIn = renderOpts.labelHeightIn;
  bOpts.labelOrientation = renderOpts.labelOrientation;
  bOpts.printGain = renderOpts.printGain;
  bOpts.seed = renderOpts.seed !== undefined ? renderOpts.seed : (renderOpts.frameSeed ?? 0);
  bOpts.ctx = renderOpts.ctx || state.cpuCtx;

  if (!state.enabled) {
    resolvePoseAtBand(poseSource, t0Sec, t0Sec, 0, bandPose);
    return renderFrame(scene, bandPose, bOpts, out);
  }

  const readoutSec = state.readoutMs * 1e-3;
  const bandH = state.bandHeight > 0 ? state.bandHeight : 8;
  const invH = 1.0 / h;
  const scratch = state.scratchFrame;

  for (let y0 = 0; y0 < h; y0 += bandH) {
    const y1 = y0 + bandH < h ? y0 + bandH : h;
    const rowCenter = (y0 + y1) * 0.5;
    const frac = rowCenter * invH;
    const tRow = t0Sec + frac * readoutSec;
    resolvePoseAtBand(poseSource, t0Sec, tRow, frac, bandPose);
    renderFrame(scene, bandPose, bOpts, scratch);

    const start = Math.imul(y0, w);
    const end = Math.imul(y1, w);
    for (let i = start; i < end; i++) {
      out[i] = scratch[i];
    }
  }
  return out;
}
