/**
 * K3 — Sensor Noise, Fixed-Pattern Noise, Black Level, Tone Curve & ISP Denoise
 * (`src/sim/camera-model/sensor.js`).
 *
 * Models CMOS sensor photometry and ISP post-processing on 8-bit luma frames:
 *  - Exposure signal gain (`exposureGain`)
 *  - Shot noise (`sigma_shot = shotCoeff * sqrt(signal * gain)`)
 *  - Read noise (`sigma_read = readNoiseBase + readNoisePerGain * gain`)
 *  - Fixed-pattern noise (seeded per-column + per-pixel offset tables)
 *  - Black level pedestal (`blackLevel`)
 *  - Tone curve (gamma + S-curve + clip via precomputed 4096-entry LUT)
 *  - ISO-scaled light separable ISP denoise blur
 *
 * Zero per-frame heap allocations inside `applySensorModel`.
 * Seeded deterministic PRNG (never `Math.random`).
 * Gated by `enabled` / `simCamera` (default OFF).
 */

import { mulberry32 } from '../cpu-render.js';

export const DEFAULT_SENSOR_CONFIG = Object.freeze({
  enabled: false,
  iso: 200,
  exposureGain: 1.0,
  shotCoeff: 0.018,         // shot noise coefficient at gain=1 (ISO 100) in [0,1] luma units
  readNoiseBase: 0.004,     // base read noise std dev in [0,1] luma units
  readNoisePerGain: 0.0025, // additional read noise per unit analog gain (ISO/100)
  fpnColStd: 0.003,         // per-column fixed-pattern noise std dev
  fpnPixStd: 0.002,         // per-pixel fixed-pattern noise std dev
  blackLevel: 0.015,        // sensor black pedestal in [0,1] (~3.8/255)
  toneEnabled: true,
  gamma: 1.0,               // display/ISP gamma exponent (1.0 = neutral)
  sCurveStrength: 0.15,     // mild S-curve contrast boost
  denoiseEnabled: true,
  denoiseStrength: 0.35,    // max separable 3x3 denoise blend at high ISO
  seed: 4242,
});

const TONE_LUT_SIZE = 4096;
const TONE_LUT_MAX = TONE_LUT_SIZE - 1;

function clamp01(v) {
  return v < 0 ? 0 : (v > 1 ? 1 : v);
}

/**
 * Computes the theoretical total temporal+spatial noise standard deviation (in 0..255 luma units)
 * at a given input signal level (0..255) before tone-curve clipping and ISP denoise.
 *
 * @param {number} signalU8
 * @param {Partial<typeof DEFAULT_SENSOR_CONFIG>} [config]
 * @returns {number}
 */
export function expectedNoiseSigmaU8(signalU8, config = {}) {
  const iso = config.iso ?? DEFAULT_SENSOR_CONFIG.iso;
  const gain = Math.max(0.5, iso / 100.0);
  const expGain = config.exposureGain ?? DEFAULT_SENSOR_CONFIG.exposureGain;
  const shotCoeff = config.shotCoeff ?? DEFAULT_SENSOR_CONFIG.shotCoeff;
  const readBase = config.readNoiseBase ?? DEFAULT_SENSOR_CONFIG.readNoiseBase;
  const readPerGain = config.readNoisePerGain ?? DEFAULT_SENSOR_CONFIG.readNoisePerGain;
  const fpnColStd = config.fpnColStd ?? DEFAULT_SENSOR_CONFIG.fpnColStd;
  const fpnPixStd = config.fpnPixStd ?? DEFAULT_SENSOR_CONFIG.fpnPixStd;

  const sig = clamp01((signalU8 / 255.0) * expGain);
  const sigmaShot = shotCoeff * Math.sqrt(sig * gain);
  const sigmaRead = readBase + readPerGain * gain;
  const totalNorm = Math.sqrt(
    sigmaShot * sigmaShot +
    sigmaRead * sigmaRead +
    fpnColStd * fpnColStd +
    fpnPixStd * fpnPixStd
  );
  return totalNorm * 255.0;
}

/**
 * Populates a 4096-entry tone-curve LUT (`Uint8Array`) from blackLevel, gamma, and sCurveStrength.
 */
function buildToneLut(lut, blackLevel, toneEnabled, gamma, sCurveStrength) {
  const blk = clamp01(blackLevel);
  const scale = 1.0 - blk;
  const invGamma = gamma > 0.05 ? (1.0 / gamma) : 1.0;
  const s = sCurveStrength;
  for (let i = 0; i < TONE_LUT_SIZE; i++) {
    let v = i / TONE_LUT_MAX;
    if (toneEnabled) {
      if (invGamma !== 1.0) v = Math.pow(v, invGamma);
      if (s !== 0) {
        // Smooth S-curve preserving endpoints 0 and 1
        v = v + s * v * (1.0 - v) * (2.0 * v - 1.0);
        if (v < 0) v = 0;
        else if (v > 1) v = 1;
      }
    }
    const outV = blk + scale * v;
    const u8 = (outV * 255.0 + 0.5) | 0;
    lut[i] = u8 < 0 ? 0 : (u8 > 255 ? 255 : u8);
  }
}

/**
 * Generates seeded fixed-pattern noise tables (unit-variance Irwin-Hall normals).
 */
function populateFpnTables(colFpn, pixFpn, width, height, fpnColStd, fpnPixStd, seed) {
  const rng = mulberry32((seed ^ 0x51f15e3) >>> 0);
  if (fpnColStd > 0) {
    for (let x = 0; x < width; x++) {
      const z = 2.0 * (rng() + rng() + rng() - 1.5);
      colFpn[x] = z * fpnColStd;
    }
  } else {
    colFpn.fill(0, 0, width);
  }

  const n = Math.imul(width, height);
  if (fpnPixStd > 0) {
    for (let i = 0; i < n; i++) {
      const z = 2.0 * (rng() + rng() + rng() - 1.5);
      pixFpn[i] = z * fpnPixStd;
    }
  } else {
    pixFpn.fill(0, 0, n);
  }
}

/**
 * Creates a reusable, zero-allocation sensor model state for `width x height` frames.
 *
 * @param {number} width
 * @param {number} height
 * @param {Partial<typeof DEFAULT_SENSOR_CONFIG>} [config]
 */
export function createSensorState(width, height, config = {}) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.imul(w, h);
  const seed = (config.seed ?? DEFAULT_SENSOR_CONFIG.seed) >>> 0;
  const fpnColStd = config.fpnColStd ?? DEFAULT_SENSOR_CONFIG.fpnColStd;
  const fpnPixStd = config.fpnPixStd ?? DEFAULT_SENSOR_CONFIG.fpnPixStd;
  const blackLevel = config.blackLevel ?? DEFAULT_SENSOR_CONFIG.blackLevel;
  const toneEnabled = config.toneEnabled ?? DEFAULT_SENSOR_CONFIG.toneEnabled;
  const gamma = config.gamma ?? DEFAULT_SENSOR_CONFIG.gamma;
  const sCurveStrength = config.sCurveStrength ?? DEFAULT_SENSOR_CONFIG.sCurveStrength;

  const colFpn = new Float32Array(w);
  const pixFpn = new Float32Array(n);
  populateFpnTables(colFpn, pixFpn, w, h, fpnColStd, fpnPixStd, seed);

  const toneLut = new Uint8Array(TONE_LUT_SIZE);
  buildToneLut(toneLut, blackLevel, toneEnabled, gamma, sCurveStrength);

  return {
    width: w,
    height: h,
    enabled: Boolean(config.enabled ?? DEFAULT_SENSOR_CONFIG.enabled),
    iso: config.iso ?? DEFAULT_SENSOR_CONFIG.iso,
    exposureGain: config.exposureGain ?? DEFAULT_SENSOR_CONFIG.exposureGain,
    shotCoeff: config.shotCoeff ?? DEFAULT_SENSOR_CONFIG.shotCoeff,
    readNoiseBase: config.readNoiseBase ?? DEFAULT_SENSOR_CONFIG.readNoiseBase,
    readNoisePerGain: config.readNoisePerGain ?? DEFAULT_SENSOR_CONFIG.readNoisePerGain,
    fpnColStd,
    fpnPixStd,
    blackLevel,
    toneEnabled,
    gamma,
    sCurveStrength,
    denoiseEnabled: Boolean(config.denoiseEnabled ?? DEFAULT_SENSOR_CONFIG.denoiseEnabled),
    denoiseStrength: config.denoiseStrength ?? DEFAULT_SENSOR_CONFIG.denoiseStrength,
    seed,

    // Pre-allocated scratch buffers (zero hot-loop alloc)
    colFpn,
    pixFpn,
    toneLut,
    scratchBlur: new Uint8Array(n),
    _lutBlack: blackLevel,
    _lutTone: toneEnabled,
    _lutGamma: gamma,
    _lutSCurve: sCurveStrength,
  };
}

/**
 * Applies the K3 sensor model (exposure gain, shot+read+FPN noise, black level,
 * tone curve, and ISO-scaled light ISP denoise) to `src` (`Uint8Array`) and writes to `out`.
 * Supports in-place (`out === src`) and zero heap allocations.
 *
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {ReturnType<typeof createSensorState>} state
 * @param {Uint8Array} [out]
 * @param {number} [frameIndex=0]
 * @returns {Uint8Array}
 */
export function applySensorModel(src, width, height, state, out = src, frameIndex = 0) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.imul(w, h);

  if (!state || !state.enabled) {
    if (out !== src) {
      for (let i = 0; i < n; i++) out[i] = src[i];
    }
    return out;
  }

  // Refresh tone LUT only if tone parameters changed
  if (
    state._lutBlack !== state.blackLevel ||
    state._lutTone !== state.toneEnabled ||
    state._lutGamma !== state.gamma ||
    state._lutSCurve !== state.sCurveStrength
  ) {
    buildToneLut(state.toneLut, state.blackLevel, state.toneEnabled, state.gamma, state.sCurveStrength);
    state._lutBlack = state.blackLevel;
    state._lutTone = state.toneEnabled;
    state._lutGamma = state.gamma;
    state._lutSCurve = state.sCurveStrength;
  }

  const gain = Math.max(0.5, state.iso / 100.0);
  const expGain = state.exposureGain;
  const shotCoeff = state.shotCoeff;
  const sigmaRead = state.readNoiseBase + state.readNoisePerGain * gain;
  const hasFpn = (state.fpnColStd > 0 || state.fpnPixStd > 0);
  const colFpn = state.colFpn;
  const pixFpn = state.pixFpn;
  const toneLut = state.toneLut;

  // Deterministic per-frame 32-bit PRNG seed (mulberry32 core inlined for zero alloc & speed)
  let rng = (state.seed ^ Math.imul((frameIndex + 1) | 0, 0x9e3779b1)) | 0;
  if (rng === 0) rng = 0x6d2b79f5;

  const inv255 = 1.0 / 255.0;
  const invU32 = 1.0 / 4294967296.0;

  // Decide whether ISP denoise will run after noise+tone
  let denoiseAlpha = 0;
  if (state.denoiseEnabled && state.denoiseStrength > 0 && state.iso > 100) {
    const isoFrac = (state.iso - 100.0) / 1500.0;
    const clampedFrac = isoFrac < 0 ? 0 : (isoFrac > 1 ? 1 : isoFrac);
    denoiseAlpha = state.denoiseStrength * clampedFrac * 0.25; // kernel [a, 1-2a, a]
  }

  const noiseDst = denoiseAlpha > 1e-4 ? state.scratchBlur : out;

  for (let y = 0; y < h; y++) {
    const rowOff = Math.imul(y, w);
    for (let x = 0; x < w; x++) {
      const idx = rowOff + x;
      let sig = src[idx] * inv255 * expGain;
      if (sig < 0) sig = 0;
      else if (sig > 1) sig = 1;

      const sigmaShot = shotCoeff * Math.sqrt(sig * gain);
      const sigmaDyn = Math.sqrt(sigmaShot * sigmaShot + sigmaRead * sigmaRead);

      // 3-sample Irwin-Hall standard normal (exact mean 0, variance 1)
      rng = (rng + 0x6d2b79f5) | 0;
      let t1 = Math.imul(rng ^ (rng >>> 15), 1 | rng);
      t1 = (t1 + Math.imul(t1 ^ (t1 >>> 7), 61 | t1)) ^ t1;
      const u1 = ((t1 ^ (t1 >>> 14)) >>> 0) * invU32;

      rng = (rng + 0x6d2b79f5) | 0;
      let t2 = Math.imul(rng ^ (rng >>> 15), 1 | rng);
      t2 = (t2 + Math.imul(t2 ^ (t2 >>> 7), 61 | t2)) ^ t2;
      const u2 = ((t2 ^ (t2 >>> 14)) >>> 0) * invU32;

      rng = (rng + 0x6d2b79f5) | 0;
      let t3 = Math.imul(rng ^ (rng >>> 15), 1 | rng);
      t3 = (t3 + Math.imul(t3 ^ (t3 >>> 7), 61 | t3)) ^ t3;
      const u3 = ((t3 ^ (t3 >>> 14)) >>> 0) * invU32;

      const z = 2.0 * (u1 + u2 + u3 - 1.5);
      let v = sig + z * sigmaDyn;
      if (hasFpn) v += colFpn[x] + pixFpn[idx];

      if (v < 0) v = 0;
      else if (v > 1) v = 1;

      noiseDst[idx] = toneLut[(v * TONE_LUT_MAX + 0.5) | 0];
    }
  }

  // Optional ISO-scaled light separable 3x3 ISP denoise blur
  if (denoiseAlpha > 1e-4) {
    const a = denoiseAlpha;
    const c = 1.0 - 2.0 * a;
    // Horizontal pass: scratchBlur -> out
    for (let y = 0; y < h; y++) {
      const rowOff = Math.imul(y, w);
      out[rowOff] = noiseDst[rowOff];
      const last = rowOff + w - 1;
      for (let i = rowOff + 1; i < last; i++) {
        out[i] = (a * (noiseDst[i - 1] + noiseDst[i + 1]) + c * noiseDst[i] + 0.5) | 0;
      }
      if (w > 1) out[last] = noiseDst[last];
    }
    // Vertical pass: out -> scratchBlur -> copy back to out
    for (let x = 0; x < w; x++) {
      noiseDst[x] = out[x];
      const lastOff = Math.imul(h - 1, w) + x;
      noiseDst[lastOff] = out[lastOff];
    }
    for (let y = 1; y < h - 1; y++) {
      const rowOff = Math.imul(y, w);
      const prevOff = rowOff - w;
      const nextOff = rowOff + w;
      for (let x = 0; x < w; x++) {
        const idx = rowOff + x;
        noiseDst[idx] = (a * (out[prevOff + x] + out[nextOff + x]) + c * out[idx] + 0.5) | 0;
      }
    }
    for (let i = 0; i < n; i++) out[i] = noiseDst[i];
  }

  return out;
}
