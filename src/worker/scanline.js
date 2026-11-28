/**
 * Stage 2 & Stage 3: Oriented Sparse Scanline Casting & 1D Local Adaptive Edge Extraction.
 *
 * Stage 2 (Target: 1–3 ms):
 *  - Computes 7–15 (default 11) parallel scanline descriptors along dominant angle theta
 *    within the Stage 1 RoI, ordered center-outward for fast consensus early-exit.
 *  - When RoI confidence < threshold, generates a fast multi-angle fallback fan
 *    (0°, +15°, -15°, 90° × 3 parallel lines = 12 lines) across the frame center strip.
 *  - Samples full-resolution luma along each scanline using 16.16 fixed-point bilinear
 *    interpolation (pure 32-bit integer inner loop, zero stair-step aliasing).
 *
 * Stage 3 (Target: 2–5 ms):
 *  - Computes 1D central first derivative d[i] = s[i+1] - s[i-1] (optimal passband for
 *    modulePx >= 1.8, attenuating Nyquist noise).
 *  - Tracks a bidirectional O(N) local max-envelope of |d[i]| so deep shadows (0.3x gain)
 *    and bright highlights (1.06x gain) on the same barcode both stay cleanly above threshold
 *    without global Otsu thresholding.
 *  - Locates sub-pixel edge positions in Q8 fixed-point 32-bit integers (1/256 px precision)
 *    via 3-point parabolic interpolation of derivative peaks (= 2nd-derivative zero-crossing)
 *    with strict alternating bar/space polarity — eliminating V8 HeapNumber float boxing.
 *
 * Zero-Allocation Guarantee:
 *  All buffers are pre-allocated once in `createScanlineState()`. Zero heap allocations and
 *  zero V8 HeapNumber float-boxing across per-frame and per-scanline hot loops.
 */

export const MAX_SCANLINES = 15;
export const MAX_SCANLINE_LEN = 2304; // > hypot(1920, 1080) = 2202.9 px
export const MAX_RUNS = 512;

// Worker feature-flag bits (canonical source: `src/worker/flagbits.js`)
import {
  FLAG_VERT_FALLBACK,
  FLAG_EXTRA_LINES,
  FLAG_CRIB_MATCH,
  FLAG_REQUIRE_PREFIX,
  FLAG_REQUIRE_PREFIX_STRICT,
  FLAG_PREFIX_STACK,
  FLAG_ILLUM_NORM,
  FLAG_SUBPIX_EDGES,
  FLAG_SCAN_SMOOTH,
  FLAG_ROI_SMALL_CODES,
  FLAG_VERTICAL_MODE,
  FLAG_DEBLUR_1D,
  FLAG_FLOW_ON,
  FLAG_STOP_GUARD,
  FLAG_MODULE_EST,
} from './flagbits.js';
import { computeCode128Modules } from '../array/config.js';
import { findTsxCribModuleWidthQ8 } from './decoders/code128.js';

export {
  FLAG_VERT_FALLBACK,
  FLAG_EXTRA_LINES,
  FLAG_CRIB_MATCH,
  FLAG_REQUIRE_PREFIX,
  FLAG_REQUIRE_PREFIX_STRICT,
  FLAG_PREFIX_STACK,
  FLAG_ILLUM_NORM,
  FLAG_SUBPIX_EDGES,
  FLAG_SCAN_SMOOTH,
  FLAG_ROI_SMALL_CODES,
  FLAG_VERTICAL_MODE,
  FLAG_DEBLUR_1D,
  FLAG_FLOW_ON,
  FLAG_STOP_GUARD,
  FLAG_MODULE_EST,
};

const DEFAULT_EXPECTED_MODULES = computeCode128Modules(11);   // 176 (FC 11-char + 2x10 quiet)
const MIN_CODE128_BAR_MODULES = computeCode128Modules(4, 0);  // 79 (4-char bar span, no quiet)
export const MODULE_STRENGTH_FLOOR_Q10 = 220;

const DEG_TO_RAD = Math.PI / 180;

// Fallback directional fan angles (degrees): 0°, +15°, -15° (165°), 90°
const FALLBACK_ANGLES_DEG = new Int32Array([0, 15, 165, 90]);
// Center-outward offsets for fallback parallel strip (pixels)
const FALLBACK_OFFSETS_PX = new Int32Array([0, 36, -36]);

/**
 * Pre-allocates all Stage 2 & Stage 3 buffers once during worker initialization.
 */
export function createScanlineState() {
  return {
    // Runtime mode (0 = auto, 1 = vertical), worker bitmask & W12 blur length (zero allocation)
    mode: 0,
    flags: 0,
    blurPx: 0,

    // Generated scanline descriptors in 16.16 fixed-point integers (zero float boxing!)
    lineCount: 0,
    lineStartXQ16: new Int32Array(MAX_SCANLINES),
    lineStartYQ16: new Int32Array(MAX_SCANLINES),
    lineStepXQ16: new Int32Array(MAX_SCANLINES),
    lineStepYQ16: new Int32Array(MAX_SCANLINES),
    lineLength: new Int32Array(MAX_SCANLINES),

    // Pre-allocated luma cache for all lines: lineIndex * MAX_SCANLINE_LEN + sampleIndex
    lumaBank: new Uint8Array(MAX_SCANLINES * MAX_SCANLINE_LEN),
    // Scratch single-line buffers for Tier C, W8 sharpening & W12 deblur (zero allocation)
    avgLumaBuf: new Uint8Array(MAX_SCANLINE_LEN),
    scratchLuma: new Uint8Array(MAX_SCANLINE_LEN),

    // Scratch integer prefix-sum buffer for W6 O(N) illumination normalisation (zero allocation)
    illumPrefix: new Int32Array(MAX_SCANLINE_LEN + 1),

    // Stage 3 1D derivative, local envelope, sub-pixel edge positions (Q8) & run widths (Q8)
    deriv: new Int16Array(MAX_SCANLINE_LEN),
    absDeriv: new Int16Array(MAX_SCANLINE_LEN),
    localEnv: new Int16Array(MAX_SCANLINE_LEN),

    edgePosQ8: new Int32Array(MAX_RUNS + 2),
    edgePol: new Int8Array(MAX_RUNS + 2),   // -1 = space->bar (falling), +1 = bar->space (rising)
    edgeMag: new Int16Array(MAX_RUNS + 2),

    runWidthsQ8: new Int32Array(MAX_RUNS),  // Q8 fixed-point sub-pixel widths (256 = 1.0 px)
    // B8: scanline sample position (Q8) where run 0 starts. 0 when the runs tile the line from sample 0,
    // else the first edge (the deriv extractor drops a leading bar->space edge's run). Write-only unless `decodeAnchor`.
    runOriginQ8: 0,
    runIsBar: new Uint8Array(MAX_RUNS),     // 1 = dark bar, 0 = light space
    runCount: 0,

    // BL1 (`moduleEst`): pre-allocated autocorrelation buffer, scalar results & early-reject telemetry
    corrLags: new Int32Array(64),
    moduleWidthQ8: 0,
    modulePeakStrength: 0,
    moduleSource: 0,                        // 0 = none, 1 = crib, 2 = autocorr
    expectedModules: 0,                     // 0 = default computeCode128Modules(11)
    roiMajorLen: 0,                         // Stage 1 RoI major length in px (0 when no RoI)
    derivedMinModQ8: 0,
    derivedMaxModQ8: 0,
    linesEvaluated: 0,
    linesRejectedEarly: 0,
  };
}

/**
 * Generates oriented scanline descriptors for Stage 2 directly in 16.16 fixed-point Int32s
 * (inlined clipping avoids passing floats across function boundaries -> zero HeapNumbers).
 *
 * @returns {number} Number of valid scanlines generated
 */
export function buildScanlinePlan(width, height, result, hasRoi, state, numLines = 11) {
  const lineStartXQ16 = state.lineStartXQ16;
  const lineStartYQ16 = state.lineStartYQ16;
  const lineStepXQ16 = state.lineStepXQ16;
  const lineStepYQ16 = state.lineStepYQ16;
  const lineLength = state.lineLength;

  const minX = 1.0;
  const maxX = width - 2.001;
  const minY = 1.0;
  const maxY = height - 2.001;
  let count = 0;

  if (hasRoi === 1) {
    const n = numLines > MAX_SCANLINES ? MAX_SCANLINES : (numLines < 7 ? 7 : numLines);
    const rad = result.thetaDeg * DEG_TO_RAD;
    const ux = Math.cos(rad);
    const uy = Math.sin(rad);
    const perpX = -uy;
    const perpY = ux;
    const stepXQ16 = Math.round(ux * 65536.0) | 0;
    const stepYQ16 = Math.round(uy * 65536.0) | 0;

    const baseCx = result.roiCenterX;
    const baseCy = result.roiCenterY;

    let halfMajor = result.roiMajorLen * 0.5 + 56.0;
    if (halfMajor < 240.0) halfMajor = 240.0;
    if (halfMajor > 1100.0) halfMajor = 1100.0;

    let halfMinor = result.roiMinorLen * 0.39;
    if (halfMinor < 20.0) halfMinor = 20.0;
    if (halfMinor > 260.0) halfMinor = 260.0;

    const halfIdx = (n - 1) >> 1;
    const stepMinor = halfIdx > 0 ? halfMinor / halfIdx : 0;

    const hasUx = Math.abs(ux) > 1e-6;
    const hasUy = Math.abs(uy) > 1e-6;
    const invUx = hasUx ? 1.0 / ux : 0;
    const invUy = hasUy ? 1.0 / uy : 0;

    for (let k = 0; k < n; k++) {
      let signedStep = 0;
      if (k > 0) {
        const mag = (k + 1) >> 1;
        signedStep = (k & 1) === 1 ? mag : -mag;
      }
      const off = signedStep * stepMinor;
      const cx = baseCx + perpX * off;
      const cy = baseCy + perpY * off;

      let tMin = -halfMajor;
      let tMax = halfMajor;

      if (hasUx) {
        let tx0 = (minX - cx) * invUx;
        let tx1 = (maxX - cx) * invUx;
        if (tx0 > tx1) { const tmp = tx0; tx0 = tx1; tx1 = tmp; }
        if (tx0 > tMin) tMin = tx0;
        if (tx1 < tMax) tMax = tx1;
      } else if (cx < minX || cx > maxX) {
        continue;
      }

      if (hasUy) {
        let ty0 = (minY - cy) * invUy;
        let ty1 = (maxY - cy) * invUy;
        if (ty0 > ty1) { const tmp = ty0; ty0 = ty1; ty1 = tmp; }
        if (ty0 > tMin) tMin = ty0;
        if (ty1 < tMax) tMax = ty1;
      } else if (cy < minY || cy > maxY) {
        continue;
      }

      if (tMax <= tMin) continue;
      let len = ((tMax - tMin) | 0) + 1;
      if (len < 64) continue;
      if (len > MAX_SCANLINE_LEN) len = MAX_SCANLINE_LEN;

      lineStartXQ16[count] = Math.round((cx + ux * tMin) * 65536.0) | 0;
      lineStartYQ16[count] = Math.round((cy + uy * tMin) * 65536.0) | 0;
      lineStepXQ16[count] = stepXQ16;
      lineStepYQ16[count] = stepYQ16;
      lineLength[count] = len;
      count++;
    }
  } else if ((state.flags & FLAG_VERT_FALLBACK) !== 0) {
    // W1 (flagged): full-width vertical fallback scanlines (integer arithmetic, zero allocations)
    const wInt = width | 0;
    const hInt = height | 0;
    let vLen = (hInt - 5) | 0;
    if (vLen > MAX_SCANLINE_LEN) vLen = MAX_SCANLINE_LEN;

    if ((state.mode | 0) === 1) {
      // Vertical mode: 11 evenly spaced full-height 90° scanlines across the full frame width
      const nVert = 11;
      if (vLen >= 64) {
        for (let i = 0; i < nVert && count < MAX_SCANLINES; i++) {
          const x = ((wInt * (i + 1)) / (nVert + 1)) | 0;
          if (x < 2 || x > wInt - 3) continue;
          lineStartXQ16[count] = x << 16;
          lineStartYQ16[count] = 2 << 16;
          lineStepXQ16[count] = 0;
          lineStepYQ16[count] = 65536;
          lineLength[count] = vLen;
          count++;
        }
      }
    } else {
      // Auto mode: 0°, +15°, 165° with 2 offsets each (6 lines) + 5 full-width vertical lines = 11
      const baseCx = width * 0.5;
      const baseCy = height * 0.5;
      const halfMajor = width * 0.46;
      for (let a = 0; a < 3; a++) {
        const rad = FALLBACK_ANGLES_DEG[a] * DEG_TO_RAD;
        const ux = Math.cos(rad);
        const uy = Math.sin(rad);
        const perpX = -uy;
        const perpY = ux;
        const stepXQ16 = Math.round(ux * 65536.0) | 0;
        const stepYQ16 = Math.round(uy * 65536.0) | 0;
        const hasUx = Math.abs(ux) > 1e-6;
        const hasUy = Math.abs(uy) > 1e-6;
        const invUx = hasUx ? 1.0 / ux : 0;
        const invUy = hasUy ? 1.0 / uy : 0;

        for (let o = 0; o < 2; o++) {
          if (count >= MAX_SCANLINES) break;
          const off = FALLBACK_OFFSETS_PX[o];
          const cx = baseCx + perpX * off;
          const cy = baseCy + perpY * off;
          let tMin = -halfMajor;
          let tMax = halfMajor;
          if (hasUx) {
            let tx0 = (minX - cx) * invUx;
            let tx1 = (maxX - cx) * invUx;
            if (tx0 > tx1) { const tmp = tx0; tx0 = tx1; tx1 = tmp; }
            if (tx0 > tMin) tMin = tx0;
            if (tx1 < tMax) tMax = tx1;
          } else if (cx < minX || cx > maxX) continue;
          if (hasUy) {
            let ty0 = (minY - cy) * invUy;
            let ty1 = (maxY - cy) * invUy;
            if (ty0 > ty1) { const tmp = ty0; ty0 = ty1; ty1 = tmp; }
            if (ty0 > tMin) tMin = ty0;
            if (ty1 < tMax) tMax = ty1;
          } else if (cy < minY || cy > maxY) continue;
          if (tMax <= tMin) continue;
          let len = ((tMax - tMin) | 0) + 1;
          if (len < 64) continue;
          if (len > MAX_SCANLINE_LEN) len = MAX_SCANLINE_LEN;
          lineStartXQ16[count] = Math.round((cx + ux * tMin) * 65536.0) | 0;
          lineStartYQ16[count] = Math.round((cy + uy * tMin) * 65536.0) | 0;
          lineStepXQ16[count] = stepXQ16;
          lineStepYQ16[count] = stepYQ16;
          lineLength[count] = len;
          count++;
        }
      }
      if (vLen >= 64) {
        for (let i = 0; i < 5 && count < MAX_SCANLINES; i++) {
          const x = ((wInt * (i + 1)) / 6) | 0;
          if (x < 2 || x > wInt - 3) continue;
          lineStartXQ16[count] = x << 16;
          lineStartYQ16[count] = 2 << 16;
          lineStepXQ16[count] = 0;
          lineStepYQ16[count] = 65536;
          lineLength[count] = vLen;
          count++;
        }
      }
    }
  } else {
    // Low-confidence fallback fan: 0°, +15°, -15°, 90° across center strip
    const baseCx = width * 0.5;
    const baseCy = height * 0.5;
    for (let a = 0; a < 4; a++) {
      const rad = FALLBACK_ANGLES_DEG[a] * DEG_TO_RAD;
      const ux = Math.cos(rad);
      const uy = Math.sin(rad);
      const perpX = -uy;
      const perpY = ux;
      const stepXQ16 = Math.round(ux * 65536.0) | 0;
      const stepYQ16 = Math.round(uy * 65536.0) | 0;
      const halfMajor = a === 3 ? height * 0.46 : width * 0.46;

      const hasUx = Math.abs(ux) > 1e-6;
      const hasUy = Math.abs(uy) > 1e-6;
      const invUx = hasUx ? 1.0 / ux : 0;
      const invUy = hasUy ? 1.0 / uy : 0;

      for (let o = 0; o < 3; o++) {
        if (count >= MAX_SCANLINES) break;
        const off = FALLBACK_OFFSETS_PX[o];
        const cx = baseCx + perpX * off;
        const cy = baseCy + perpY * off;

        let tMin = -halfMajor;
        let tMax = halfMajor;

        if (hasUx) {
          let tx0 = (minX - cx) * invUx;
          let tx1 = (maxX - cx) * invUx;
          if (tx0 > tx1) { const tmp = tx0; tx0 = tx1; tx1 = tmp; }
          if (tx0 > tMin) tMin = tx0;
          if (tx1 < tMax) tMax = tx1;
        } else if (cx < minX || cx > maxX) {
          continue;
        }

        if (hasUy) {
          let ty0 = (minY - cy) * invUy;
          let ty1 = (maxY - cy) * invUy;
          if (ty0 > ty1) { const tmp = ty0; ty0 = ty1; ty1 = tmp; }
          if (ty0 > tMin) tMin = ty0;
          if (ty1 < tMax) tMax = ty1;
        } else if (cy < minY || cy > maxY) {
          continue;
        }

        if (tMax <= tMin) continue;
        let len = ((tMax - tMin) | 0) + 1;
        if (len < 64) continue;
        if (len > MAX_SCANLINE_LEN) len = MAX_SCANLINE_LEN;

        lineStartXQ16[count] = Math.round((cx + ux * tMin) * 65536.0) | 0;
        lineStartYQ16[count] = Math.round((cy + uy * tMin) * 65536.0) | 0;
        lineStepXQ16[count] = stepXQ16;
        lineStepYQ16[count] = stepYQ16;
        lineLength[count] = len;
        count++;
      }
    }
  }

  state.lineCount = count;
  return count;
}

/**
 * Samples full-resolution luma along scanline `lineIdx` into `state.lumaBank` at offset
 * `lineIdx * MAX_SCANLINE_LEN` using pure 32-bit 16.16 fixed-point bilinear interpolation.
 */
export function sampleScanlineLuma(luma, width, state, lineIdx) {
  const len = state.lineLength[lineIdx] | 0;
  const dst = state.lumaBank;
  const dstBase = Math.imul(lineIdx, MAX_SCANLINE_LEN);
  const w = width | 0;

  let fx = state.lineStartXQ16[lineIdx] | 0;
  let fy = state.lineStartYQ16[lineIdx] | 0;
  const stepX = state.lineStepXQ16[lineIdx] | 0;
  const stepY = state.lineStepYQ16[lineIdx] | 0;

  if ((state.flags & FLAG_SCAN_SMOOTH) !== 0 && len >= 3) {
    // W8 (flagged `scanSmooth`): 3-tap box average perpendicular to scan direction (along bars)
    // followed by light 3-tap integer sharpening [-1, 6, -1] / 4 across bars. Zero allocations.
    const h = (luma.length / w) | 0;
    const maxX = (w - 2) | 0;
    const maxY = (h - 2) | 0;
    const perpX = (-stepY) | 0;
    const perpY = stepX | 0;
    const scratch = state.scratchLuma;

    for (let i = 0; i < len; i++) {
      let sum3 = 0;
      for (let t = -1; t <= 1; t++) {
        let sx = (fx + Math.imul(perpX, t)) | 0;
        let sy = (fy + Math.imul(perpY, t)) | 0;
        let ix = sx >> 16;
        let iy = sy >> 16;
        if (ix < 0) { ix = 0; sx = 0; } else if (ix > maxX) { ix = maxX; sx = maxX << 16; }
        if (iy < 0) { iy = 0; sy = 0; } else if (iy > maxY) { iy = maxY; sy = maxY << 16; }
        const wx = (sx >> 8) & 255;
        const wy = (sy >> 8) & 255;
        const iwx = (256 - wx) | 0;
        const iwy = (256 - wy) | 0;
        const row0 = (Math.imul(iy, w) + ix) | 0;
        const row1 = (row0 + w) | 0;
        const top = (Math.imul(luma[row0], iwx) + Math.imul(luma[row0 + 1], wx)) | 0;
        const bot = (Math.imul(luma[row1], iwx) + Math.imul(luma[row1 + 1], wx)) | 0;
        sum3 = (sum3 + ((Math.imul(top, iwy) + Math.imul(bot, wy) + 32768) >> 16)) | 0;
      }
      scratch[i] = ((sum3 + 1) / 3) | 0;
      fx = (fx + stepX) | 0;
      fy = (fy + stepY) | 0;
    }

    dst[dstBase] = scratch[0];
    const last = (len - 1) | 0;
    for (let i = 1; i < last; i++) {
      let v = ((Math.imul(scratch[i], 6) - scratch[i - 1] - scratch[i + 1] + 2) >> 2) | 0;
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      dst[(dstBase + i) | 0] = v;
    }
    dst[(dstBase + last) | 0] = scratch[last];
    return len;
  }

  for (let i = 0; i < len; i++) {
    const ix = fx >> 16;
    const iy = fy >> 16;
    const wx = (fx >> 8) & 255;
    const wy = (fy >> 8) & 255;
    const iwx = (256 - wx) | 0;
    const iwy = (256 - wy) | 0;

    const row0 = (Math.imul(iy, w) + ix) | 0;
    const row1 = (row0 + w) | 0;

    const top = (Math.imul(luma[row0], iwx) + Math.imul(luma[row0 + 1], wx)) | 0;
    const bot = (Math.imul(luma[row1], iwx) + Math.imul(luma[row1 + 1], wx)) | 0;
    dst[(dstBase + i) | 0] = (Math.imul(top, iwy) + Math.imul(bot, wy) + 32768) >> 16;

    fx = (fx + stepX) | 0;
    fy = (fy + stepY) | 0;
  }

  return len;
}

/**
 * W12 (flagged `deblur1d`): Optional 1D along-scan inverse-box / Wiener-style deblur pass
 * in pure Q8 integer math when along-scan motion blur `blurPx` is in `[1.5, 8.0]`.
 * Gain is capped (`<= 0.75`) to prevent noise amplification; no-op outside `[1.5, 8.0]`.
 */
export function deblurScanlineLuma(lumaBuf, offset, len, blurPx, state) {
  if (!(blurPx >= 1.5 && blurPx <= 8.0)) return;
  const n = len | 0;
  if (n < 16) return;
  const base = offset | 0;
  const scratch = state.scratchLuma;
  for (let i = 0; i < n; i++) {
    scratch[i] = lumaBuf[(base + i) | 0];
  }

  let r = Math.round(blurPx * 0.5) | 0;
  if (r < 1) r = 1;
  else if (r > 4) r = 4;

  let gainQ8 = Math.round(blurPx * 36) | 0;
  if (gainQ8 > 192) gainQ8 = 192;

  const end = (n - r) | 0;
  for (let i = r; i < end; i++) {
    const s = scratch[i];
    const avg = (scratch[(i - r) | 0] + scratch[(i + r) | 0]) >> 1;
    let v = (s + ((Math.imul((s - avg) | 0, gainQ8) + 128) >> 8)) | 0;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    lumaBuf[(base + i) | 0] = v;
  }
}

/**
 * W6 (flagged `illumNorm`): O(N) pure-integer running-mean illumination normalisation in-place
 * on `lumaBuf[offset .. offset+len-1]`. Removes slow shadow gradients and glare ramps without
 * allocations so bar/space transitions stay centered around luma 128.
 */
export function normaliseScanlineLuma(lumaBuf, offset, len, state, halfWin = 24) {
  const n = len | 0;
  if (n < 16) return;
  const pref = state.illumPrefix;
  const base = offset | 0;
  pref[0] = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc = (acc + lumaBuf[(base + i) | 0]) | 0;
    pref[(i + 1) | 0] = acc;
  }
  const hw = halfWin | 0;
  for (let i = 0; i < n; i++) {
    let lo = (i - hw) | 0;
    if (lo < 0) lo = 0;
    let hi = (i + hw + 1) | 0;
    if (hi > n) hi = n;
    const span = (hi - lo) | 0;
    const mean = ((pref[hi] - pref[lo]) / span) | 0;
    let v = (128 + (lumaBuf[(base + i) | 0] - mean)) | 0;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    lumaBuf[(base + i) | 0] = v;
  }
}

/**
 * Stage 3: Extracts sub-pixel bar/space run widths in Q8 fixed-point integers (`256 = 1.0 px`)
 * via 1D central first-derivative peak detection + integer parabolic zero-crossing interpolation
 * and a bidirectional local adaptive contrast envelope (zero global thresholding, zero floats).
 *
 * @returns {number} Number of runs extracted (`state.runCount`)
 */
export function extractRunsFromScanline(lumaBuf, offset, len, state, relThreshQ8 = 72, minDeriv = 18) {
  const n = len | 0;
  if (n < 16) {
    state.runCount = 0;
    return 0;
  }

  const deriv = state.deriv;
  const absDeriv = state.absDeriv;
  const localEnv = state.localEnv;
  const edgePosQ8 = state.edgePosQ8;
  const edgePol = state.edgePol;
  const edgeMag = state.edgeMag;
  const runWidthsQ8 = state.runWidthsQ8;
  const runIsBar = state.runIsBar;

  const base = offset | 0;

  // Pass 1: 1D central first derivative d[i] = s[i+1] - s[i-1] & forward max-envelope
  deriv[0] = 0;
  absDeriv[0] = 0;
  localEnv[0] = 0;

  let env = 0;
  const last = (n - 1) | 0;
  for (let i = 1; i < last; i++) {
    const idx = (base + i) | 0;
    const d = (lumaBuf[idx + 1] - lumaBuf[idx - 1]) | 0;
    deriv[i] = d;
    const ad = d < 0 ? -d : d;
    absDeriv[i] = ad;
    env = (Math.imul(env, 247) >> 8) | 0;
    if (ad > env) env = ad;
    localEnv[i] = env;
  }
  deriv[last] = 0;
  absDeriv[last] = 0;
  localEnv[last] = 0;

  // Pass 2: Backward max-envelope for symmetric local contrast normalization across shadows
  env = 0;
  for (let i = last - 1; i >= 1; i--) {
    const ad = absDeriv[i];
    env = (Math.imul(env, 247) >> 8) | 0;
    if (ad > env) env = ad;
    if (env > localEnv[i]) localEnv[i] = env;
  }

  // Pass 3: First-derivative local extrema + integer Q8 parabolic sub-pixel localization
  let edgeCount = 0;
  const maxEdges = (MAX_RUNS + 1) | 0;
  const minD = minDeriv | 0;
  const relQ8 = relThreshQ8 | 0;
  const end = (n - 2) | 0;

  for (let i = 2; i < end; i++) {
    const d = deriv[i];
    const ad = absDeriv[i];

    let thresh = (Math.imul(localEnv[i], relQ8) >> 8) | 0;
    if (thresh < minD) thresh = minD;
    if (ad < thresh) continue;

    const dm = deriv[i - 1];
    const dp = deriv[i + 1];
    let pol = 0;

    if (d < 0) {
      if (d <= dm && d < dp) pol = -1; // space -> bar (falling edge)
    } else if (d > 0) {
      if (d >= dm && d > dp) pol = 1;  // bar -> space (rising edge)
    }
    if (pol === 0) continue;

    // Integer Q8 parabolic vertex: deltaQ8 = ((dm - dp) << 7) / (dm - 2*d + dp) in [-128, 128]
    const denom = (dm - (d << 1) + dp) | 0;
    let deltaQ8 = 0;
    if (denom !== 0) {
      deltaQ8 = (((dm - dp) << 7) / denom) | 0;
      if (deltaQ8 < -128) deltaQ8 = -128;
      else if (deltaQ8 > 128) deltaQ8 = 128;
    }
    const posQ8 = ((i << 8) + deltaQ8) | 0;

    if (edgeCount === 0) {
      edgePosQ8[0] = posQ8;
      edgePol[0] = pol;
      edgeMag[0] = ad;
      edgeCount = 1;
    } else {
      const prevIdx = (edgeCount - 1) | 0;
      if (edgePol[prevIdx] === pol) {
        if (ad > edgeMag[prevIdx]) {
          edgePosQ8[prevIdx] = posQ8;
          edgeMag[prevIdx] = ad;
        }
      } else if (edgeCount < maxEdges) {
        edgePosQ8[edgeCount] = posQ8;
        edgePol[edgeCount] = pol;
        edgeMag[edgeCount] = ad;
        edgeCount++;
      }
    }
  }

  if (edgeCount < 2) {
    state.runCount = 0;
    return 0;
  }

  // Convert alternating Q8 edge positions into Q8 bar/space run widths (256 = 1.0 px)
  let rc = 0;
  state.runOriginQ8 = edgePol[0] === -1 ? 0 : edgePosQ8[0];
  if (edgePol[0] === -1 && rc < MAX_RUNS) {
    runWidthsQ8[rc] = edgePosQ8[0] > 26 ? edgePosQ8[0] : 26;
    runIsBar[rc] = 0;
    rc++;
  }

  for (let e = 0; e < edgeCount - 1 && rc < MAX_RUNS; e++) {
    const w = (edgePosQ8[e + 1] - edgePosQ8[e]) | 0;
    runWidthsQ8[rc] = w > 26 ? w : 26;
    runIsBar[rc] = edgePol[e] === -1 ? 1 : 0;
    rc++;
  }

  if (edgePol[edgeCount - 1] === 1 && rc < MAX_RUNS) {
    const w = (((n - 1) << 8) - edgePosQ8[edgeCount - 1]) | 0;
    runWidthsQ8[rc] = w > 26 ? w : 26;
    runIsBar[rc] = 0;
    rc++;
  }

  state.runCount = rc;
  return rc;
}

/**
 * Stage 3 Blur-Resilient Companion Extractor: Local Adaptive Envelope Zero-Crossing.
 *
 * When optical defocus or directional motion blur exceeds 1 module width, first-derivative
 * peaks shift outward from narrow 1-module bars, whereas the local 50% mid-level crossing
 * `s[i] - (localMax[i] + localMin[i]) / 2 = 0` remains anchored to the true geometric bar
 * boundaries while adapting smoothly across uneven shadow gradients (no global threshold).
 *
 * Reuses pre-allocated `state.deriv` (localMax), `state.absDeriv` (localMin), and
 * `state.edgePosQ8` / `state.runWidthsQ8` with strictly zero heap allocations.
 *
 * @returns {number} Number of bar/space runs extracted (`state.runCount`)
 */
export function extractRunsLocalMidCrossing(lumaBuf, offset, len, state, minContrast = 24) {
  const n = len | 0;
  if (n < 16) {
    state.runCount = 0;
    return 0;
  }

  const localMax = state.deriv;    // reuse pre-allocated Int16Array
  const localMin = state.absDeriv; // reuse pre-allocated Int16Array
  const runWidthsQ8 = state.runWidthsQ8;
  const runIsBar = state.runIsBar;
  const base = offset | 0;

  // Pass 1: Forward local max/min envelope (decay ~0.9766/px -> ~30 px span, ~1 char)
  // Using Q8 fixed-point envelope tracking so decay is smooth and exact in integers.
  let hiQ8 = lumaBuf[base] << 8;
  let loQ8 = hiQ8;
  localMax[0] = lumaBuf[base];
  localMin[0] = lumaBuf[base];

  for (let i = 1; i < n; i++) {
    const v = lumaBuf[(base + i) | 0];
    const vQ8 = v << 8;
    // Exponentially relax hi downward and lo upward toward current sample
    hiQ8 = (hiQ8 - ((hiQ8 - vQ8) >> 6)) | 0;
    if (vQ8 > hiQ8) hiQ8 = vQ8;
    loQ8 = (loQ8 + ((vQ8 - loQ8) >> 6)) | 0;
    if (vQ8 < loQ8) loQ8 = vQ8;
    localMax[i] = hiQ8 >> 8;
    localMin[i] = loQ8 >> 8;
  }

  // Pass 2: Backward local max/min envelope for zero-phase symmetric bounds across shadows
  hiQ8 = lumaBuf[(base + n - 1) | 0] << 8;
  loQ8 = hiQ8;
  for (let i = n - 2; i >= 0; i--) {
    const v = lumaBuf[(base + i) | 0];
    const vQ8 = v << 8;
    hiQ8 = (hiQ8 - ((hiQ8 - vQ8) >> 6)) | 0;
    if (vQ8 > hiQ8) hiQ8 = vQ8;
    loQ8 = (loQ8 + ((vQ8 - loQ8) >> 6)) | 0;
    if (vQ8 < loQ8) loQ8 = vQ8;
    const bHi = hiQ8 >> 8;
    const bLo = loQ8 >> 8;
    if (bHi > localMax[i]) localMax[i] = bHi;
    if (bLo < localMin[i]) localMin[i] = bLo;
  }

  // Pass 3: Sub-pixel Q8 linear zero-crossing of diff[i] = 2*s[i] - (localMax[i] + localMin[i])
  state.runOriginQ8 = 0; // mid-crossing runs tile the scanline from sample 0
  const minC = minContrast | 0;
  let prevDiff = ((lumaBuf[base] << 1) - (localMax[0] + localMin[0])) | 0;
  let curBar = prevDiff < 0 ? 1 : 0;
  let lastEdgeQ8 = 0;
  let rc = 0;

  for (let i = 1; i < n; i++) {
    const hi = localMax[i];
    const lo = localMin[i];
    const diff = ((lumaBuf[(base + i) | 0] << 1) - (hi + lo)) | 0;

    if (((hi - lo) | 0) >= minC) {
      const nextBar = diff < 0 ? 1 : 0;
      if (nextBar !== curBar) {
        // Exact Q8 sub-pixel zero-crossing between (i - 1) and i
        const denom = (prevDiff - diff) | 0;
        let fracQ8 = 128;
        if (denom !== 0) {
          fracQ8 = ((prevDiff << 8) / denom) | 0;
          if (fracQ8 < 0) fracQ8 = 0;
          else if (fracQ8 > 256) fracQ8 = 256;
        }
        const edgeQ8 = (((i - 1) << 8) + fracQ8) | 0;
        const wQ8 = (edgeQ8 - lastEdgeQ8) | 0;
        if (rc < MAX_RUNS) {
          runWidthsQ8[rc] = wQ8 > 26 ? wQ8 : 26;
          runIsBar[rc] = curBar;
          rc++;
        }
        lastEdgeQ8 = edgeQ8;
        curBar = nextBar;
      }
    }
    prevDiff = diff;
  }

  // Trailing run
  if (rc < MAX_RUNS) {
    const tailQ8 = (((n - 1) << 8) - lastEdgeQ8) | 0;
    runWidthsQ8[rc] = tailQ8 > 26 ? tailQ8 : 26;
    runIsBar[rc] = curBar;
    rc++;
  }

  state.runCount = rc;
  return rc;
}

/**
 * BL1 (`moduleEst`): Computes dynamic valid module-width bounds `[derivedMinModQ8, derivedMaxModQ8]`
 * on `state` from `expectedModules` (default `computeCode128Modules(11) = 176`) and `roiMajorLen`
 * (or scanline length `scanLen` when `roiMajorLen === 0`), using a ~±50% derived band so valid
 * close-range (>= 8 px/mod) and far-range (~1.3-1.5 px/mod) barcodes are never rejected.
 * Pure 32-bit integer arithmetic, zero heap allocations.
 */
export function updateDerivedModuleRangeQ8(scanLen, state, isMergedCluster = 0) {
  const sLen = scanLen | 0;
  const userExp = state.expectedModules | 0;
  const expMods = userExp > 0 ? userExp : DEFAULT_EXPECTED_MODULES;
  const roiLen = state.roiMajorLen > 0 ? (state.roiMajorLen | 0) : 0;

  let minQ8 = 230; // ~0.90 px/mod Nyquist floor
  let maxQ8 = 1024;

  if (roiLen > 0) {
    const nomQ8 = ((roiLen << 8) / expMods) | 0;
    // On merged multi-carton clusters (2-4 stacked labels), allow lower bound down to 1.0 px/mod
    minQ8 = isMergedCluster !== 0 ? 256 : (nomQ8 >> 1);
    if (minQ8 < 230) minQ8 = 230;

    if (userExp > 0) {
      maxQ8 = (nomQ8 + (nomQ8 >> 1)) | 0; // +50% around parameterized expectedModules
    } else {
      const shortNomQ8 = ((roiLen << 8) / MIN_CODE128_BAR_MODULES) | 0;
      maxQ8 = (shortNomQ8 + (shortNomQ8 >> 1)) | 0;
    }
    if (maxQ8 < ((minQ8 + 256) | 0)) maxQ8 = (minQ8 + 256) | 0;
  } else {
    // Fallback fan (no RoI): derive bounds from scanline length ratios
    minQ8 = ((sLen << 8) / Math.imul(expMods, 8)) | 0;
    if (minQ8 < 230) minQ8 = 230;
    const maxBaseMods = userExp > 0 ? expMods : MIN_CODE128_BAR_MODULES;
    const nomMaxQ8 = ((sLen << 8) / maxBaseMods) | 0;
    maxQ8 = (nomMaxQ8 + (nomMaxQ8 >> 1)) | 0;
    if (maxQ8 < 1024) maxQ8 = 1024;
  }

  state.derivedMinModQ8 = minQ8;
  state.derivedMaxModQ8 = maxQ8;
}

/**
 * BL1 (`moduleEst`): Crib-first, bounded-autocorrelation-fallback module-width estimator +
 * derived-range early-reject gate.
 *
 * 1. Primary (`moduleSource = 1`): matches 44-module Start B + `t,s,X` crib on `state.runWidthsQ8`
 *    -> `moduleWidthQ8 = cribSpanQ8 / 44` and Q10 strength from crib score.
 * 2. Fallback (`moduleSource = 2`, only when crib misses): bounded integer autocorrelation of
 *    `state.absDeriv` into `state.corrLags[0..maxLag]` (`maxLag <= 63`), parabolic peak lag,
 *    and `/1, /2, /3, /4` divisor selection minimizing L1 distance of non-quiet run widths to
 *    integer multiples `1..4`. Strength = `(peak * 1024) / max(1, lag0)` (Q10).
 * 3. Early-reject gate: returns 0 (skip decode) if strength < `MODULE_STRENGTH_FLOOR_Q10` OR
 *    `moduleWidthQ8` falls outside `[derivedMinModQ8, derivedMaxModQ8]`.
 *
 * Strictly zero heap allocations and pure 32-bit integer arithmetic.
 *
 * @returns {number} 1 = pass (proceed to decode), 0 = early reject (skip decode)
 */
export function estimateModuleWidthQ8(lumaBuf, offset, len, state, hasAbsDeriv = 1, isMergedCluster = 0) {
  const n = len | 0;
  state.moduleWidthQ8 = 0;
  state.modulePeakStrength = 0;
  state.moduleSource = 0;

  updateDerivedModuleRangeQ8(n, state, isMergedCluster);
  if (n < 32) return 0;

  const minModQ8 = state.derivedMinModQ8 | 0;
  const maxModQ8 = state.derivedMaxModQ8 | 0;

  // 1. Primary: crib-first estimator (Start B + t, s, X -> 44 modules)
  if ((state.runCount | 0) >= 25) {
    if (findTsxCribModuleWidthQ8(state.runWidthsQ8, state.runIsBar, state.runCount, state) === 1) {
      const mQ8 = state.moduleWidthQ8 | 0;
      const str = state.modulePeakStrength | 0;
      return (str >= MODULE_STRENGTH_FLOOR_Q10 && mQ8 >= minModQ8 && mQ8 <= maxModQ8) ? 1 : 0;
    }
  }

  // 2. Fallback: bounded integer autocorrelation of absDeriv into state.corrLags
  const absDeriv = state.absDeriv;
  if (hasAbsDeriv === 0) {
    const base = offset | 0;
    const last = (n - 1) | 0;
    absDeriv[0] = 0;
    absDeriv[last] = 0;
    for (let i = 1; i < last; i++) {
      const idx = (base + i) | 0;
      const d = (lumaBuf[idx + 1] - lumaBuf[idx - 1]) | 0;
      absDeriv[i] = d < 0 ? -d : d;
    }
  }

  // Restrict autocorrelation to active edge span (absDeriv >= 12) for speed & SNR
  let firstActive = n;
  let lastActive = -1;
  let activeCount = 0;
  const lastSample = (n - 1) | 0;
  for (let i = 1; i < lastSample; i++) {
    if (absDeriv[i] >= 12) {
      if (i < firstActive) firstActive = i;
      lastActive = i;
      activeCount = (activeCount + 1) | 0;
    }
  }

  state.moduleSource = 2;
  const activeSpan = (lastActive - firstActive + 1) | 0;
  if (activeCount < 36 || activeSpan < 40) {
    return 0;
  }

  let maxLag = activeSpan >> 2;
  if (maxLag > 63) maxLag = 63;
  if (maxLag < 8) return 0;

  const corrLags = state.corrLags;
  let lag0 = 0;
  for (let i = firstActive; i <= lastActive; i++) {
    const v = absDeriv[i];
    lag0 = (lag0 + Math.imul(v, v)) | 0;
  }
  corrLags[0] = lag0;
  if (lag0 <= 0) return 0;

  for (let lag = 1; lag <= maxLag; lag++) {
    let acc = 0;
    const end = (lastActive - lag) | 0;
    for (let i = firstActive; i <= end; i++) {
      acc = (acc + Math.imul(absDeriv[i], absDeriv[(i + lag) | 0])) | 0;
    }
    corrLags[lag] = acc;
  }

  // Locate both the first significant local peak (always 1*M..3*M, never a 5*M/11*M harmonic)
  // and the global strongest local peak after descending off the zero-lag main lobe.
  let seenRise = 0;
  let bestLag = 0;
  let bestPeak = 0;
  let firstLag = 0;
  let firstPeak = 0;
  for (let lag = 2; lag < maxLag; lag++) {
    const cur = corrLags[lag] | 0;
    const prev = corrLags[lag - 1] | 0;
    if (cur > prev) seenRise = 1;
    if (seenRise === 1) {
      const next = corrLags[lag + 1] | 0;
      if (cur >= prev && cur >= next && (cur > prev || cur > next)) {
        if (firstLag === 0 && cur > (lag0 >> 4)) {
          firstLag = lag;
          firstPeak = cur;
        }
        if (cur > bestPeak) {
          bestPeak = cur;
          bestLag = lag;
        }
      }
    }
  }

  if (bestLag === 0 || bestPeak <= 0) return 0;

  // Parabolic sub-pixel peak lag refinement in Q8 for both bestLag and firstLag
  let bestPeakLagQ8 = bestLag << 8;
  {
    const ym = corrLags[bestLag - 1] | 0;
    const y0 = corrLags[bestLag] | 0;
    const yp = corrLags[bestLag + 1] | 0;
    let diff = (ym - yp) | 0;
    let den = (ym - (y0 << 1) + yp) | 0;
    if (den !== 0) {
      while (diff > 8388607 || diff < -8388607) {
        diff >>= 1;
        den >>= 1;
      }
      if (den !== 0) {
        let deltaQ8 = ((diff << 7) / den) | 0;
        if (deltaQ8 < -128) deltaQ8 = -128;
        else if (deltaQ8 > 128) deltaQ8 = 128;
        bestPeakLagQ8 = ((bestLag << 8) + deltaQ8) | 0;
      }
    }
  }

  let firstPeakLagQ8 = bestPeakLagQ8;
  if (firstLag > 0 && firstLag !== bestLag) {
    firstPeakLagQ8 = firstLag << 8;
    const ym = corrLags[firstLag - 1] | 0;
    const y0 = corrLags[firstLag] | 0;
    const yp = corrLags[firstLag + 1] | 0;
    let diff = (ym - yp) | 0;
    let den = (ym - (y0 << 1) + yp) | 0;
    if (den !== 0) {
      while (diff > 8388607 || diff < -8388607) {
        diff >>= 1;
        den >>= 1;
      }
      if (den !== 0) {
        let deltaQ8 = ((diff << 7) / den) | 0;
        if (deltaQ8 < -128) deltaQ8 = -128;
        else if (deltaQ8 > 128) deltaQ8 = 128;
        firstPeakLagQ8 = ((firstLag << 8) + deltaQ8) | 0;
      }
    }
  }

  // Overflow-safe Q10 peak strength: (bestPeak * 1024) / max(1, lag0)
  let p = bestPeak;
  let l0 = lag0;
  while (l0 > 2000000) {
    p >>= 1;
    l0 >>= 1;
  }
  const strengthQ10 = l0 > 0 ? ((Math.imul(p, 1024) / l0) | 0) : 0;

  // Test candidate divisors /1, /2, /3, /4 on firstPeakLagQ8 and bestPeakLagQ8 against
  // extracted non-quiet run widths (integer multiples 1..4), then refine by run sum ratio.
  const rc = state.runCount | 0;
  let chosenModQ8 = firstPeakLagQ8;
  let fitOk = 1;
  if (rc >= 12) {
    const runWidthsQ8 = state.runWidthsQ8;
    const runIsBar = state.runIsBar;
    const rEnd = (rc - 1) | 0;
    let bestFitErrQ8 = 0x3fffffff;
    let bestWidthSum = 0;
    let bestUsed = 0;
    let bestHasVariety = 0;
    const numPeaks = (firstLag > 0 && firstLag !== bestLag) ? 2 : 1;

    for (let pk = 0; pk < numPeaks; pk++) {
      const pkLagQ8 = pk === 0 ? firstPeakLagQ8 : bestPeakLagQ8;
      for (let div = 1; div <= 4; div++) {
        const candQ8 = ((pkLagQ8 + (div >> 1)) / div) | 0;
        if (candQ8 < 205 || candQ8 > 10240) continue;
        const halfC = candQ8 >> 1;
        let errSum = 0;
        let widthSum = 0;
        let used = 0;
        let cnt1 = 0;
        let cnt2 = 0;
        let cnt34 = 0;

        for (let r = 1; r < rEnd; r++) {
          const wQ8 = runWidthsQ8[r] | 0;
          const ratioQ8 = (((wQ8 << 8) + halfC) / candQ8) | 0;
          if (runIsBar[r] === 0 && ratioQ8 >= 1792) continue; // ignore quiet zones (>= 7 mod)
          let q = (ratioQ8 + 128) >> 8;
          if (q < 1) q = 1;
          else if (q > 4) q = 4;
          if (q === 1) cnt1 = (cnt1 + 1) | 0;
          else if (q === 2) cnt2 = (cnt2 + 1) | 0;
          else cnt34 = (cnt34 + 1) | 0;
          let d = (ratioQ8 - (q << 8)) | 0;
          if (d < 0) d = -d;
          errSum = (errSum + d) | 0;
          widthSum = (widthSum + wQ8) | 0;
          used = (used + 1) | 0;
        }

        if (used >= 8) {
          const avgErr = (errSum / used) | 0;
          // Code 128 invariant: 6 runs per 11 modules -> mean run width = 11/6 = 1.8333 mod (469 Q8).
          // Edge-shift / ink-bleed invariant, disambiguates 1.5x vs 2.0x harmonic aliases.
          const meanRunQ8 = (widthSum / used) | 0;
          const meanRatioQ8 = (((meanRunQ8 << 8) + halfC) / candQ8) | 0;
          let meanErr = (meanRatioQ8 - 469) | 0;
          if (meanErr < 0) meanErr = -meanErr;
          const totalScore = (avgErr + meanErr) | 0;
          if ((totalScore + 6) < bestFitErrQ8) {
            bestFitErrQ8 = totalScore;
            chosenModQ8 = candQ8;
            bestWidthSum = widthSum;
            bestUsed = used;
            // Every Code 128 symbol sequence (Start + data + Check + Stop) has 1-mod, 2-mod,
            // and 3/4-mod runs; uniform rib/fabric square waves lack multi-width variety.
            bestHasVariety = (used < 16 || (cnt1 >= 2 && cnt2 >= 1 && cnt34 >= 1)) ? 1 : 0;
          }
        }
      }
    }

    if (bestFitErrQ8 > 200 || bestHasVariety === 0) {
      fitOk = 0;
    }

    // Edge-shift-invariant sub-pixel refinement using Code 128's 6 runs = 11 modules ratio
    // (only when candidate already fits cleanly and refined width stays within +/-25% of peak)
    if (bestFitErrQ8 < 180 && bestUsed >= 18 && chosenModQ8 >= 205) {
      const den = Math.imul(bestUsed, 11);
      const refQ8 = ((Math.imul(bestWidthSum, 6) + (den >> 1)) / den) | 0;
      if (refQ8 >= ((Math.imul(chosenModQ8, 192) >> 8) | 0) && refQ8 <= ((Math.imul(chosenModQ8, 320) >> 8) | 0)) {
        chosenModQ8 = refQ8;
      }
    }
  }

  state.moduleWidthQ8 = chosenModQ8;
  state.modulePeakStrength = strengthQ10;

  return (fitOk === 1 && strengthQ10 >= MODULE_STRENGTH_FLOOR_Q10 && chosenModQ8 >= minModQ8 && chosenModQ8 <= maxModQ8) ? 1 : 0;
}
