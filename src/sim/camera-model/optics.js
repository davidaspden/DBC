/**
 * K5 — Optics Model: Defocus + AF Hunting Lag, Radial Vignette, Mild Barrel
 * Distortion, ISP Unsharp-Mask Sharpening (with Halo) & Demosaic Softness
 * (`src/sim/camera-model/optics.js`).
 *
 * Every sub-effect is individually switchable and gated by top-level `enabled`
 * (`simOptics`, default OFF).
 * Exports `distortPoint` / `undistortPoint` for AR M6 compositor reuse.
 *
 * Zero per-frame heap allocations inside `stepAutofocus` and `applyOpticsModel`.
 */

export const A53_FOCUS_LIMITS = Object.freeze({
  minFocusDistM: 0.10,
  maxFocusDistM: 3.60,
});

export const DEFAULT_OPTICS_CONFIG = Object.freeze({
  enabled: false,

  // Defocus & AF hunting
  defocusEnabled: true,
  focusDistM: 0.30,         // current lens focus distance (m)
  subjectDistM: 0.30,       // target subject distance (m)
  cocScalePx: 1.8,          // circle-of-confusion pixels per diopter (|1/f - 1/s|)
  maxBlurRadiusPx: 8.0,
  afOmegaRadSec: 12.0,      // underdamped AF natural frequency (rad/s)
  afDampingRatio: 0.55,     // < 1 gives realistic slight hunting overshoot
  afJumpKick: 0.35,         // velocity kick on sudden distance/zoom change

  // Light Bayer demosaic softness
  demosaicEnabled: true,
  demosaicStrength: 0.18,   // [0..1] subtle 3x3 separable low-pass

  // Radial vignette falloff
  vignetteEnabled: true,
  vignetteStrength: 0.22,   // corner darkening factor (1 - strength * r^2)

  // Mild barrel distortion (k1 < 0 for barrel, k1 > 0 for pincushion)
  distortionEnabled: true,
  k1: -0.06,

  // ISP unsharp-mask sharpening with halo
  sharpenEnabled: true,
  sharpenAmount: 0.65,      // unsharp mask gain (> 0 creates edge halo overshoot)
  sharpenRadiusPx: 1.5,
});

const MAX_KERNEL_RADIUS = 16;
const MAX_KERNEL_LEN = MAX_KERNEL_RADIUS * 2 + 1;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * Computes defocus blur radius (sigma in pixels) from `|1/focusDistM - 1/subjectDistM|`.
 * Strictly monotone increasing with focus error `|focusDistM - subjectDistM|`.
 *
 * @param {number} focusDistM
 * @param {number} subjectDistM
 * @param {number} [cocScalePx=1.8]
 * @param {number} [maxBlurRadiusPx=8.0]
 * @returns {number}
 */
export function computeDefocusRadiusPx(
  focusDistM,
  subjectDistM,
  cocScalePx = DEFAULT_OPTICS_CONFIG.cocScalePx,
  maxBlurRadiusPx = DEFAULT_OPTICS_CONFIG.maxBlurRadiusPx
) {
  const f = clamp(focusDistM, A53_FOCUS_LIMITS.minFocusDistM, A53_FOCUS_LIMITS.maxFocusDistM);
  const s = Math.max(0.05, subjectDistM);
  const diopterErr = Math.abs(1.0 / f - 1.0 / s);
  const r = diopterErr * cocScalePx;
  return r > maxBlurRadiusPx ? maxBlurRadiusPx : r;
}

/**
 * Applies radial lens distortion `p_d = p_u * (1 + k1 * r^2)` in normalized coordinates
 * (centered at 0, half-diagonal = 1). Writes `[dx, dy]` into `out` (zero allocation).
 * Exported for AR M6 compositor.
 *
 * @param {number} nx
 * @param {number} ny
 * @param {number} k1
 * @param {Float64Array | number[]} out
 * @param {number} [offset=0]
 */
export function distortPoint(nx, ny, k1, out, offset = 0) {
  const r2 = nx * nx + ny * ny;
  const f = 1.0 + k1 * r2;
  out[offset] = nx * f;
  out[offset + 1] = ny * f;
  return out;
}

/**
 * Inverts radial lens distortion `p_u * (1 + k1 * |p_u|^2) = p_d` via 5-step Newton-Raphson
 * (accurate to < 1e-7 for mild |k1| <= 0.35). Writes `[ux, uy]` into `out` (zero allocation).
 * Exported for AR M6 compositor.
 *
 * @param {number} dx
 * @param {number} dy
 * @param {number} k1
 * @param {Float64Array | number[]} out
 * @param {number} [offset=0]
 */
export function undistortPoint(dx, dy, k1, out, offset = 0) {
  if (Math.abs(k1) < 1e-9) {
    out[offset] = dx;
    out[offset + 1] = dy;
    return out;
  }
  const rd = Math.hypot(dx, dy);
  if (rd < 1e-12) {
    out[offset] = 0;
    out[offset + 1] = 0;
    return out;
  }
  let ru = rd;
  for (let iter = 0; iter < 5; iter++) {
    const ru2 = ru * ru;
    const f = ru * (1.0 + k1 * ru2) - rd;
    const df = 1.0 + 3.0 * k1 * ru2;
    if (Math.abs(df) < 1e-9) break;
    ru -= f / df;
  }
  const scale = ru / rd;
  out[offset] = dx * scale;
  out[offset + 1] = dy * scale;
  return out;
}

/**
 * Builds a normalized 1D Gaussian kernel in `kernel` (`Float32Array`), returning radius `R`.
 */
function buildGaussianKernel(sigma, kernel) {
  if (!(sigma > 0.15)) {
    kernel[0] = 1.0;
    return 0;
  }
  let r = Math.ceil(sigma * 2.5) | 0;
  if (r < 1) r = 1;
  if (r > MAX_KERNEL_RADIUS) r = MAX_KERNEL_RADIUS;
  const inv2s2 = 1.0 / (2.0 * sigma * sigma);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const w = Math.exp(-(i * i) * inv2s2);
    kernel[i + r] = w;
    sum += w;
  }
  const invSum = 1.0 / sum;
  const len = 2 * r + 1;
  for (let i = 0; i < len; i++) kernel[i] *= invSum;
  return r;
}

/**
 * Separable 2-pass Gaussian blur from `src` (`Float32Array`) to `dst` (`Float32Array`)
 * using `tmp` (`Float32Array`) and `kernel` (`Float32Array`). Zero heap allocations.
 */
function separableBlurFloat(src, tmp, dst, width, height, kernel, radius) {
  if (radius <= 0) {
    const n = Math.imul(width, height);
    if (dst !== src) {
      for (let i = 0; i < n; i++) dst[i] = src[i];
    }
    return;
  }
  const wm1 = width - 1;
  const hm1 = height - 1;

  // Horizontal pass: src -> tmp
  for (let y = 0; y < height; y++) {
    const rowOff = Math.imul(y, width);
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sx = x + k;
        if (sx < 0) sx = 0;
        else if (sx > wm1) sx = wm1;
        acc += src[rowOff + sx] * kernel[k + radius];
      }
      tmp[rowOff + x] = acc;
    }
  }

  // Vertical pass: tmp -> dst
  for (let y = 0; y < height; y++) {
    const rowOff = Math.imul(y, width);
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        let sy = y + k;
        if (sy < 0) sy = 0;
        else if (sy > hm1) sy = hm1;
        acc += tmp[Math.imul(sy, width) + x] * kernel[k + radius];
      }
      dst[rowOff + x] = acc;
    }
  }
}

/**
 * Builds radial vignette gain map `1 - strength * r^2` (clamped to >= 0.1).
 */
function buildVignetteMap(map, width, height, strength) {
  const cx = (width - 1) * 0.5;
  const cy = (height - 1) * 0.5;
  const invDiag2 = 1.0 / (cx * cx + cy * cy + 1e-6);
  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const rowOff = Math.imul(y, width);
    for (let x = 0; x < width; x++) {
      const dx = x - cx;
      const r2 = (dx * dx + dy2) * invDiag2;
      let g = 1.0 - strength * r2;
      if (g < 0.1) g = 0.1;
      map[rowOff + x] = g;
    }
  }
}

/**
 * Creates a reusable, zero-allocation optics model state for `width x height` frames.
 *
 * @param {number} width
 * @param {number} height
 * @param {Partial<typeof DEFAULT_OPTICS_CONFIG>} [config]
 */
export function createOpticsState(width, height, config = {}) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.imul(w, h);
  const focusDistM = clamp(
    config.focusDistM ?? DEFAULT_OPTICS_CONFIG.focusDistM,
    A53_FOCUS_LIMITS.minFocusDistM,
    A53_FOCUS_LIMITS.maxFocusDistM
  );
  const subjectDistM = config.subjectDistM ?? focusDistM;
  const vignetteStrength = config.vignetteStrength ?? DEFAULT_OPTICS_CONFIG.vignetteStrength;
  const vignetteMap = new Float32Array(n);
  buildVignetteMap(vignetteMap, w, h, vignetteStrength);

  return {
    width: w,
    height: h,
    enabled: Boolean(config.enabled ?? DEFAULT_OPTICS_CONFIG.enabled),

    defocusEnabled: Boolean(config.defocusEnabled ?? DEFAULT_OPTICS_CONFIG.defocusEnabled),
    focusDistM,
    subjectDistM,
    cocScalePx: config.cocScalePx ?? DEFAULT_OPTICS_CONFIG.cocScalePx,
    maxBlurRadiusPx: config.maxBlurRadiusPx ?? DEFAULT_OPTICS_CONFIG.maxBlurRadiusPx,
    afOmegaRadSec: config.afOmegaRadSec ?? DEFAULT_OPTICS_CONFIG.afOmegaRadSec,
    afDampingRatio: config.afDampingRatio ?? DEFAULT_OPTICS_CONFIG.afDampingRatio,
    afJumpKick: config.afJumpKick ?? DEFAULT_OPTICS_CONFIG.afJumpKick,
    afVelocity: 0,
    _lastTargetDistM: subjectDistM,
    _lastZoom: 1.0,

    demosaicEnabled: Boolean(config.demosaicEnabled ?? DEFAULT_OPTICS_CONFIG.demosaicEnabled),
    demosaicStrength: config.demosaicStrength ?? DEFAULT_OPTICS_CONFIG.demosaicStrength,

    vignetteEnabled: Boolean(config.vignetteEnabled ?? DEFAULT_OPTICS_CONFIG.vignetteEnabled),
    vignetteStrength,
    _cachedVignetteStrength: vignetteStrength,

    distortionEnabled: Boolean(config.distortionEnabled ?? DEFAULT_OPTICS_CONFIG.distortionEnabled),
    k1: config.k1 ?? DEFAULT_OPTICS_CONFIG.k1,

    sharpenEnabled: Boolean(config.sharpenEnabled ?? DEFAULT_OPTICS_CONFIG.sharpenEnabled),
    sharpenAmount: config.sharpenAmount ?? DEFAULT_OPTICS_CONFIG.sharpenAmount,
    sharpenRadiusPx: config.sharpenRadiusPx ?? DEFAULT_OPTICS_CONFIG.sharpenRadiusPx,

    // Pre-allocated scratch buffers (zero hot-loop alloc)
    bufA: new Float32Array(n),
    bufB: new Float32Array(n),
    bufC: new Float32Array(n),
    kernel: new Float32Array(MAX_KERNEL_LEN),
    vignetteMap,
    ptTmp: new Float64Array(2),
  };
}

/**
 * Advances the AF hunting lag model by `dtSec` seconds toward `subjectDistM` (clamped to
 * A53 range `[0.1, 3.6]` m). A sudden distance or zoom jump injects a brief hunting kick.
 * Returns the updated `focusDistM` with zero heap allocations.
 *
 * @param {ReturnType<typeof createOpticsState>} state
 * @param {number} dtSec
 * @param {number} subjectDistM
 * @param {number} [zoom=1.0]
 * @returns {number}
 */
export function stepAutofocus(state, dtSec, subjectDistM, zoom = 1.0) {
  const target = clamp(subjectDistM, A53_FOCUS_LIMITS.minFocusDistM, A53_FOCUS_LIMITS.maxFocusDistM);
  state.subjectDistM = subjectDistM;

  if (!state.enabled || !state.defocusEnabled) {
    state.focusDistM = target;
    state.afVelocity = 0;
    state._lastTargetDistM = target;
    state._lastZoom = zoom;
    return state.focusDistM;
  }

  // Detect sudden distance or zoom jump -> inject hunting kick
  const distJump = target - state._lastTargetDistM;
  const zoomJump = Math.abs(zoom - state._lastZoom);
  if (Math.abs(distJump) > 0.05) {
    state.afVelocity += distJump * state.afJumpKick * state.afOmegaRadSec;
  } else if (zoomJump > 0.25) {
    state.afVelocity += (target > 0.5 ? -0.15 : 0.15) * state.afOmegaRadSec;
  }
  state._lastTargetDistM = target;
  state._lastZoom = zoom;

  // Sub-stepped second-order underdamped spring-damper for numerical stability
  const totalDt = dtSec > 0 ? Math.min(dtSec, 0.5) : 0;
  const subSteps = totalDt > 0.02 ? Math.ceil(totalDt / 0.01) : 1;
  const h = totalDt / subSteps;
  const w = state.afOmegaRadSec;
  const w2 = w * w;
  const c = 2.0 * state.afDampingRatio * w;

  let x = state.focusDistM;
  let v = state.afVelocity;
  for (let i = 0; i < subSteps; i++) {
    const accel = w2 * (target - x) - c * v;
    v += accel * h;
    x += v * h;
    if (x < A53_FOCUS_LIMITS.minFocusDistM) {
      x = A53_FOCUS_LIMITS.minFocusDistM;
      if (v < 0) v = 0;
    } else if (x > A53_FOCUS_LIMITS.maxFocusDistM) {
      x = A53_FOCUS_LIMITS.maxFocusDistM;
      if (v > 0) v = 0;
    }
  }
  state.focusDistM = x;
  state.afVelocity = v;
  return x;
}

/**
 * Applies the K5 optics pipeline (defocus blur, demosaic softness, radial vignette,
 * mild barrel distortion, ISP unsharp-mask sharpening) to `src` (`Uint8Array`) -> `out`.
 * Supports in-place (`out === src`) and zero heap allocations.
 *
 * @param {Uint8Array} src
 * @param {number} width
 * @param {number} height
 * @param {ReturnType<typeof createOpticsState>} state
 * @param {Uint8Array} [out]
 * @returns {Uint8Array}
 */
export function applyOpticsModel(src, width, height, state, out = src) {
  const w = width | 0;
  const h = height | 0;
  const n = Math.imul(w, h);

  if (!state || !state.enabled) {
    if (out !== src) {
      for (let i = 0; i < n; i++) out[i] = src[i];
    }
    return out;
  }

  let cur = state.bufA;
  let tmp = state.bufB;
  let aux = state.bufC;

  // Lift Uint8 -> Float32
  for (let i = 0; i < n; i++) cur[i] = src[i];

  // 1) Defocus blur (Gaussian from |1/focusDist - 1/subjectDist|)
  if (state.defocusEnabled) {
    const sigma = computeDefocusRadiusPx(
      state.focusDistM,
      state.subjectDistM,
      state.cocScalePx,
      state.maxBlurRadiusPx
    );
    if (sigma > 0.15) {
      const r = buildGaussianKernel(sigma, state.kernel);
      separableBlurFloat(cur, tmp, aux, w, h, state.kernel, r);
      const swap = cur; cur = aux; aux = swap;
    }
  }

  // 2) Light demosaic softness (separable 3x3 binomial [a, 1-2a, a])
  if (state.demosaicEnabled && state.demosaicStrength > 1e-4) {
    const a = clamp(state.demosaicStrength, 0, 1) * 0.25;
    const c = 1.0 - 2.0 * a;
    state.kernel[0] = a;
    state.kernel[1] = c;
    state.kernel[2] = a;
    separableBlurFloat(cur, tmp, aux, w, h, state.kernel, 1);
    const swap = cur; cur = aux; aux = swap;
  }

  // 3) Mild barrel distortion (pure luma inverse-map warp with bilinear interpolation)
  if (state.distortionEnabled && Math.abs(state.k1) > 1e-6) {
    const k1 = state.k1;
    const cx = (w - 1) * 0.5;
    const cy = (h - 1) * 0.5;
    const halfDiag = Math.hypot(cx, cy) || 1.0;
    const invHalfDiag = 1.0 / halfDiag;
    const wm1 = w - 1;
    const hm1 = h - 1;
    const pt = state.ptTmp;

    for (let y = 0; y < h; y++) {
      const ny = (y - cy) * invHalfDiag;
      const rowOff = Math.imul(y, w);
      for (let x = 0; x < w; x++) {
        const nx = (x - cx) * invHalfDiag;
        // Inverse map: output distorted coord -> undistorted source coord
        undistortPoint(nx, ny, k1, pt, 0);
        const sx = pt[0] * halfDiag + cx;
        const sy = pt[1] * halfDiag + cy;

        if (sx <= 0 || sx >= wm1 || sy <= 0 || sy >= hm1) {
          const csx = sx < 0 ? 0 : (sx > wm1 ? wm1 : (sx + 0.5) | 0);
          const csy = sy < 0 ? 0 : (sy > hm1 ? hm1 : (sy + 0.5) | 0);
          aux[rowOff + x] = cur[Math.imul(csy, w) + csx];
        } else {
          const x0 = sx | 0;
          const y0 = sy | 0;
          const fx = sx - x0;
          const fy = sy - y0;
          const o0 = Math.imul(y0, w) + x0;
          const o1 = o0 + w;
          const top = cur[o0] + (cur[o0 + 1] - cur[o0]) * fx;
          const bot = cur[o1] + (cur[o1 + 1] - cur[o1]) * fx;
          aux[rowOff + x] = top + (bot - top) * fy;
        }
      }
    }
    const swap = cur; cur = aux; aux = swap;
  }

  // 4) Radial vignette falloff
  if (state.vignetteEnabled && state.vignetteStrength > 1e-4) {
    if (state._cachedVignetteStrength !== state.vignetteStrength) {
      buildVignetteMap(state.vignetteMap, w, h, state.vignetteStrength);
      state._cachedVignetteStrength = state.vignetteStrength;
    }
    const vMap = state.vignetteMap;
    for (let i = 0; i < n; i++) cur[i] *= vMap[i];
  }

  // 5) ISP unsharp-mask sharpening with halo
  if (state.sharpenEnabled && state.sharpenAmount > 1e-4) {
    const r = buildGaussianKernel(state.sharpenRadiusPx, state.kernel);
    separableBlurFloat(cur, tmp, aux, w, h, state.kernel, r);
    const amt = state.sharpenAmount;
    for (let i = 0; i < n; i++) {
      cur[i] = cur[i] + amt * (cur[i] - aux[i]);
    }
  }

  // Clamp & quantize Float32 -> Uint8
  for (let i = 0; i < n; i++) {
    const v = (cur[i] + 0.5) | 0;
    out[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
  }
  return out;
}
