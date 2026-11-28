/**
 * K2 — Auto-Exposure & ISO Model with Galaxy A53 Limits (`src/sim/camera-model/exposure.js`).
 *
 * Models Samsung Galaxy A53 5G (diag-cc0f88.json) exposure & ISO control:
 *  - `exposureTimeMs` in [0.042 ms, 100 ms] (Chrome 100 us units: 0.42..1000)
 *  - `iso` in [50, 3200]
 *  - `evComp` in [-2, +2] EV
 *  - `mode`: `'continuous'` (AE with convergence lag) | `'manual'` (PP2 locked exposure)
 *
 * AE behaviour:
 *  - Solves `exposureSec * iso` for a mid-grey target given scene `lux` (+ optional torch boost).
 *  - Prefers extending exposure up to a frame-rate-driven ceiling before pushing ISO up,
 *    reproducing the real A53 low-light collapse to 100 ms exposure (10 fps).
 *  - Exponential convergence lag in log-EV space (`convergenceTauSec` in [0.3, 1.0] s).
 *  - PP2 locked-exposure mode: fixed short exposure (e.g. 4 ms) + raised ISO (e.g. 1600-3200)
 *    + `minFrameRate: 30` keeps delivery at 30 fps with sharp bars.
 *
 * Zero per-frame heap allocations inside `stepExposure`.
 * Gated by `enabled` / `simCamera` (default OFF).
 */

export const A53_EXPOSURE_LIMITS = Object.freeze({
  minExposureMs: 0.042,
  maxExposureMs: 100.0,
  minChromeUnits: 0.42,
  maxChromeUnits: 1000.0,
  minIso: 50,
  maxIso: 3200,
  minEvComp: -2.0,
  maxEvComp: 2.0,
});

export const LUX_PRESETS = Object.freeze({
  low: 15,
  dim: 40,
  normal: 400,
  bright: 1500,
});

export const DEFAULT_EXPOSURE_CONFIG = Object.freeze({
  enabled: false,
  mode: 'continuous',          // 'continuous' | 'manual'
  lux: LUX_PRESETS.normal,     // numeric lux or 'low'|'dim'|'normal'|'bright'
  targetLuma: 0.46,            // mid-grey target in [0, 1]
  evComp: 0.0,                 // [-2, +2] EV
  nominalFps: 30,
  minFrameRate: 15,            // default Chrome request (A53 AE allows stretching to 100 ms)
  strictFrameRateCeiling: false,
  preferredMaxExposureMs: 16.67, // AE comfort knee before raising ISO in normal light
  isoKneeBeforeSlowShutter: 400, // ISO level at which AE starts extending shutter toward ceiling
  convergenceTauSec: 0.5,      // AE convergence time constant (0.3-1.0 s)
  calibrationLuxSecIso: 1200,  // lux * exposureSec * iso for targetLuma = 0.46
  manualExposureMs: 4.0,       // used when mode === 'manual'
  manualIso: 1600,             // used when mode === 'manual'
  initialExposureMs: 12.0,
  initialIso: 200,
});

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Resolves a numeric or named lux preset (`'low'|'dim'|'normal'|'bright'`).
 *
 * @param {number | string} lux
 * @returns {number}
 */
export function resolveLux(lux) {
  if (typeof lux === 'string' && Object.prototype.hasOwnProperty.call(LUX_PRESETS, lux)) {
    return LUX_PRESETS[lux];
  }
  const n = Number(lux);
  return Number.isFinite(n) && n > 0 ? n : LUX_PRESETS.normal;
}

/**
 * Converts exposure time in milliseconds to Chrome's 100-microsecond units.
 */
export function exposureMsToChromeUnits(ms) {
  return clamp(ms, A53_EXPOSURE_LIMITS.minExposureMs, A53_EXPOSURE_LIMITS.maxExposureMs) * 10.0;
}

/**
 * Converts Chrome's 100-microsecond exposure units to milliseconds.
 */
export function chromeUnitsToExposureMs(units) {
  return clamp(units * 0.1, A53_EXPOSURE_LIMITS.minExposureMs, A53_EXPOSURE_LIMITS.maxExposureMs);
}

/**
 * Computes the steady-state AE target `(exposureMs, iso, requiredProduct)` for a given
 * scene brightness and frame-rate ceiling, writing into `out` (zero allocation).
 */
export function solveAeTarget(
  effectiveLux,
  targetLuma,
  evComp,
  calibrationLuxSecIso,
  expCeilingMs,
  preferredMaxExpMs,
  isoKnee,
  out
) {
  const safeLux = effectiveLux > 0.25 ? effectiveLux : 0.25;
  const evMult = Math.pow(2.0, clamp(evComp, A53_EXPOSURE_LIMITS.minEvComp, A53_EXPOSURE_LIMITS.maxEvComp));
  const lumaRatio = (targetLuma > 0.05 ? targetLuma : 0.46) / 0.46;
  const requiredProduct = (calibrationLuxSecIso * lumaRatio * evMult) / safeLux; // exposureSec * iso

  const minExpMs = A53_EXPOSURE_LIMITS.minExposureMs;
  const maxExpMs = clamp(expCeilingMs, minExpMs, A53_EXPOSURE_LIMITS.maxExposureMs);
  const kneeExpMs = clamp(preferredMaxExpMs, minExpMs, maxExpMs);
  const minIso = A53_EXPOSURE_LIMITS.minIso;
  const maxIso = A53_EXPOSURE_LIMITS.maxIso;
  const kneeIso = clamp(isoKnee, minIso, maxIso);

  let expMs;
  let iso;

  // Phase 1: Base ISO (100), grow exposure up to preferred knee (e.g. 16.67 ms)
  const baseIso = 100;
  const expAtBaseMs = (requiredProduct / baseIso) * 1000.0;
  if (expAtBaseMs <= kneeExpMs) {
    if (expAtBaseMs < minExpMs) {
      // Very bright: clamp exposure and lower ISO down to 50
      expMs = minExpMs;
      iso = clamp(requiredProduct / (expMs * 1e-3), minIso, baseIso);
    } else if (expAtBaseMs < 2.0) {
      // Bright: allow ISO to drop toward 50 while keeping fast shutter
      iso = minIso;
      expMs = clamp((requiredProduct / iso) * 1000.0, minExpMs, kneeExpMs);
    } else {
      expMs = expAtBaseMs;
      iso = baseIso;
    }
  } else {
    // Phase 2: Raise ISO up to isoKnee while holding preferredMaxExpMs (keeps 30 fps in normal light)
    const isoAtKneeExp = requiredProduct / (kneeExpMs * 1e-3);
    if (isoAtKneeExp <= kneeIso) {
      expMs = kneeExpMs;
      iso = isoAtKneeExp;
    } else {
      // Phase 3: Prefer longer exposure up to expCeilingMs (e.g. 100 ms on A53) before maxing ISO
      const expAtKneeIsoMs = (requiredProduct / kneeIso) * 1000.0;
      if (expAtKneeIsoMs <= maxExpMs) {
        expMs = expAtKneeIsoMs;
        iso = kneeIso;
      } else {
        // Phase 4: Exposure is pegged at ceiling; push ISO up to maxIso (3200)
        expMs = maxExpMs;
        iso = clamp(requiredProduct / (expMs * 1e-3), minIso, maxIso);
      }
    }
  }

  out.targetExposureMs = clamp(expMs, minExpMs, A53_EXPOSURE_LIMITS.maxExposureMs);
  out.targetIso = clamp(iso, minIso, maxIso);
  out.requiredProduct = requiredProduct;
}

/**
 * Creates a reusable, zero-allocation exposure controller state.
 *
 * @param {Partial<typeof DEFAULT_EXPOSURE_CONFIG>} [config]
 */
export function createExposureState(config = {}) {
  const mode = config.mode ?? DEFAULT_EXPOSURE_CONFIG.mode;
  const initExp = mode === 'manual'
    ? clamp(config.manualExposureMs ?? DEFAULT_EXPOSURE_CONFIG.manualExposureMs, A53_EXPOSURE_LIMITS.minExposureMs, A53_EXPOSURE_LIMITS.maxExposureMs)
    : clamp(config.initialExposureMs ?? DEFAULT_EXPOSURE_CONFIG.initialExposureMs, A53_EXPOSURE_LIMITS.minExposureMs, A53_EXPOSURE_LIMITS.maxExposureMs);
  const initIso = mode === 'manual'
    ? clamp(config.manualIso ?? DEFAULT_EXPOSURE_CONFIG.manualIso, A53_EXPOSURE_LIMITS.minIso, A53_EXPOSURE_LIMITS.maxIso)
    : clamp(config.initialIso ?? DEFAULT_EXPOSURE_CONFIG.initialIso, A53_EXPOSURE_LIMITS.minIso, A53_EXPOSURE_LIMITS.maxIso);

  return {
    enabled: Boolean(config.enabled ?? DEFAULT_EXPOSURE_CONFIG.enabled),
    mode,
    lux: resolveLux(config.lux ?? DEFAULT_EXPOSURE_CONFIG.lux),
    targetLuma: config.targetLuma ?? DEFAULT_EXPOSURE_CONFIG.targetLuma,
    evComp: clamp(config.evComp ?? DEFAULT_EXPOSURE_CONFIG.evComp, A53_EXPOSURE_LIMITS.minEvComp, A53_EXPOSURE_LIMITS.maxEvComp),
    nominalFps: config.nominalFps ?? DEFAULT_EXPOSURE_CONFIG.nominalFps,
    minFrameRate: config.minFrameRate ?? DEFAULT_EXPOSURE_CONFIG.minFrameRate,
    strictFrameRateCeiling: Boolean(config.strictFrameRateCeiling ?? DEFAULT_EXPOSURE_CONFIG.strictFrameRateCeiling),
    preferredMaxExposureMs: config.preferredMaxExposureMs ?? DEFAULT_EXPOSURE_CONFIG.preferredMaxExposureMs,
    isoKneeBeforeSlowShutter: config.isoKneeBeforeSlowShutter ?? DEFAULT_EXPOSURE_CONFIG.isoKneeBeforeSlowShutter,
    convergenceTauSec: clamp(config.convergenceTauSec ?? DEFAULT_EXPOSURE_CONFIG.convergenceTauSec, 0.05, 5.0),
    calibrationLuxSecIso: config.calibrationLuxSecIso ?? DEFAULT_EXPOSURE_CONFIG.calibrationLuxSecIso,
    manualExposureMs: clamp(config.manualExposureMs ?? DEFAULT_EXPOSURE_CONFIG.manualExposureMs, A53_EXPOSURE_LIMITS.minExposureMs, A53_EXPOSURE_LIMITS.maxExposureMs),
    manualIso: clamp(config.manualIso ?? DEFAULT_EXPOSURE_CONFIG.manualIso, A53_EXPOSURE_LIMITS.minIso, A53_EXPOSURE_LIMITS.maxIso),

    // Internal continuous state
    exposureTimeMs: initExp,
    iso: initIso,
    _solveTmp: { targetExposureMs: initExp, targetIso: initIso, requiredProduct: 1.0 },

    // Reusable per-frame output struct
    outExposure: {
      exposureTimeMs: initExp,
      exposureSec: initExp * 1e-3,
      chromeExposureUnits: initExp * 10.0,
      iso: initIso,
      evComp: 0.0,
      mode,
      lux: resolveLux(config.lux ?? DEFAULT_EXPOSURE_CONFIG.lux),
      effectiveLux: resolveLux(config.lux ?? DEFAULT_EXPOSURE_CONFIG.lux),
      targetExposureMs: initExp,
      targetIso: initIso,
      exposureGain: 1.0,
      maxAchievableFps: 30.0,
    },
  };
}

/**
 * Configures PP2 locked-exposure mode on an existing state (fixed short exposure +
 * raised ISO + minFrameRate 30).
 *
 * @param {ReturnType<typeof createExposureState>} state
 * @param {number} [exposureMs=4.0]
 * @param {number} [iso=1600]
 * @param {number} [minFrameRate=30]
 */
export function applyLockedExposure(state, exposureMs = 4.0, iso = 1600, minFrameRate = 30) {
  state.mode = 'manual';
  state.manualExposureMs = clamp(exposureMs, A53_EXPOSURE_LIMITS.minExposureMs, A53_EXPOSURE_LIMITS.maxExposureMs);
  state.manualIso = clamp(iso, A53_EXPOSURE_LIMITS.minIso, A53_EXPOSURE_LIMITS.maxIso);
  state.minFrameRate = minFrameRate;
  state.strictFrameRateCeiling = true;
  state.exposureTimeMs = state.manualExposureMs;
  state.iso = state.manualIso;
}

/**
 * Advances the exposure controller by `dtSec` seconds.
 * Mutates and returns `out` (defaults to `state.outExposure`) with zero heap allocations.
 *
 * @param {ReturnType<typeof createExposureState>} state
 * @param {number} dtSec
 * @param {number} [torchLuxBoost=0] - optional extra illumination from K7 torch
 * @param {number} [luxOverride]     - optional per-frame scene lux override
 * @param {object} [out]
 */
export function stepExposure(state, dtSec, torchLuxBoost = 0, luxOverride, out = state.outExposure) {
  const baseLux = luxOverride !== undefined ? luxOverride : state.lux;
  const boost = torchLuxBoost > 0 ? torchLuxBoost : 0;
  const effectiveLux = baseLux + boost;

  const nominalFps = state.nominalFps > 0 ? state.nominalFps : 30;

  if (!state.enabled) {
    // Flag OFF: fixed ideal exposure, unity gain, full nominal fps
    const idealExpMs = 1000.0 / (nominalFps * 4.0); // 1/120 s
    out.exposureTimeMs = idealExpMs;
    out.exposureSec = idealExpMs * 1e-3;
    out.chromeExposureUnits = idealExpMs * 10.0;
    out.iso = 100;
    out.evComp = 0;
    out.mode = 'continuous';
    out.lux = baseLux;
    out.effectiveLux = effectiveLux;
    out.targetExposureMs = idealExpMs;
    out.targetIso = 100;
    out.exposureGain = 1.0;
    out.maxAchievableFps = nominalFps;
    return out;
  }

  // Determine AE exposure ceiling from frame-rate request
  let expCeilingMs = A53_EXPOSURE_LIMITS.maxExposureMs;
  if (state.strictFrameRateCeiling && state.minFrameRate > 0) {
    const fpsCapMs = 1000.0 / state.minFrameRate;
    if (fpsCapMs < expCeilingMs) expCeilingMs = fpsCapMs;
  }

  const tmp = state._solveTmp;
  solveAeTarget(
    effectiveLux,
    state.targetLuma,
    state.evComp,
    state.calibrationLuxSecIso,
    expCeilingMs,
    state.preferredMaxExposureMs,
    state.isoKneeBeforeSlowShutter,
    tmp
  );

  if (state.mode === 'manual') {
    state.exposureTimeMs = clamp(state.manualExposureMs, A53_EXPOSURE_LIMITS.minExposureMs, A53_EXPOSURE_LIMITS.maxExposureMs);
    state.iso = clamp(state.manualIso, A53_EXPOSURE_LIMITS.minIso, A53_EXPOSURE_LIMITS.maxIso);
  } else {
    // Continuous AE with first-order exponential convergence in log space
    const dt = dtSec > 0 ? dtSec : 0;
    const alpha = dt > 0 ? (1.0 - Math.exp(-dt / state.convergenceTauSec)) : 0;
    if (alpha > 0) {
      const logCurExp = Math.log(state.exposureTimeMs);
      const logTgtExp = Math.log(tmp.targetExposureMs);
      const logCurIso = Math.log(state.iso);
      const logTgtIso = Math.log(tmp.targetIso);
      state.exposureTimeMs = clamp(
        Math.exp(logCurExp + alpha * (logTgtExp - logCurExp)),
        A53_EXPOSURE_LIMITS.minExposureMs,
        A53_EXPOSURE_LIMITS.maxExposureMs
      );
      state.iso = clamp(
        Math.exp(logCurIso + alpha * (logTgtIso - logCurIso)),
        A53_EXPOSURE_LIMITS.minIso,
        A53_EXPOSURE_LIMITS.maxIso
      );
    }
  }

  const achievedProduct = (state.exposureTimeMs * 1e-3) * state.iso;
  const gain = tmp.requiredProduct > 1e-9 ? (achievedProduct / tmp.requiredProduct) : 1.0;
  const expFps = 1000.0 / state.exposureTimeMs;
  const maxFps = expFps < nominalFps ? expFps : nominalFps;

  out.exposureTimeMs = state.exposureTimeMs;
  out.exposureSec = state.exposureTimeMs * 1e-3;
  out.chromeExposureUnits = state.exposureTimeMs * 10.0;
  out.iso = state.iso;
  out.evComp = state.evComp;
  out.mode = state.mode;
  out.lux = baseLux;
  out.effectiveLux = effectiveLux;
  out.targetExposureMs = state.mode === 'manual' ? state.manualExposureMs : tmp.targetExposureMs;
  out.targetIso = state.mode === 'manual' ? state.manualIso : tmp.targetIso;
  out.exposureGain = gain;
  out.maxAchievableFps = maxFps;
  return out;
}
