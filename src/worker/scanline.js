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
  FLAG_BLUR_EDGES,
  FLAG_MATCH_FILTER,
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
  FLAG_BLUR_EDGES,
  FLAG_MATCH_FILTER,
};

// ============================================================================
// BL3 (`matchFilter`): Pre-computed Q8 Scale-Bucketed Matched-Filter Templates
// ============================================================================
// 12 geometrically-spaced module-width buckets covering 1.25 .. 5.83 px/mod at stride 1;
// larger module widths (> 5.83 px/mod) decimate with integer stride >= 2 into the same bank.
// Slot layout (36 templates, fixed stride 168 Int16 samples each):
//   0..11  : Start B (2 quiet + 11 Start B = 13 modules)
//   12..23 : Stop    (13 Stop + 2 trailing quiet = 15 modules)
//   24..35 : Start B + tsX (2 quiet + 44 modules = 46 modules; baseStride=2 for buckets >= 8)
export const MF_NUM_BUCKETS = 12;
export const MF_TPL_STRIDE = 168;
export const MF_TPL_COUNT = MF_NUM_BUCKETS * 3;
export const MF_SCALE_BUCKETS_Q8 = new Int32Array([
  320, 368, 422, 486, 560, 644, 740, 852, 980, 1126, 1296, 1492,
]);

// Ideal module bitstreams (1 = dark bar, 0 = light space)
const MF_BITS_START_B = new Uint8Array([
  0, 0,
  1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0,
]);
const MF_BITS_STOP = new Uint8Array([
  1, 1, 0, 0, 0, 1, 1, 1, 0, 1, 0, 1, 1,
  0, 0,
]);
const MF_BITS_START_TSX = new Uint8Array([
  0, 0,
  1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, // Start B (104): 2,1,1,2,1,4
  1, 0, 0, 1, 1, 1, 1, 0, 1, 0, 0, // 't' (84):      1,2,4,1,1,2
  1, 0, 1, 1, 1, 1, 0, 0, 1, 0, 0, // 's' (83):      1,1,4,2,1,2
  1, 1, 1, 0, 0, 0, 1, 0, 1, 1, 0, // 'X' (56):      3,3,1,1,2,1
]);

function isqrt32(n) {
  const x = n | 0;
  if (x <= 0) return 0;
  if (x < 4) return 1;
  let r = 1 << ((32 - Math.clz32(x)) >> 1);
  r = (r + ((x / r) | 0)) >> 1;
  r = (r + ((x / r) | 0)) >> 1;
  r = (r + ((x / r) | 0)) >> 1;
  r = (r + ((x / r) | 0)) >> 1;
  if (Math.imul(r, r) > x) r = (r - 1) | 0;
  return r;
}

const MF_INIT_BANK = new Int16Array(MF_TPL_COUNT * MF_TPL_STRIDE);
const MF_INIT_LENS = new Uint8Array(MF_TPL_COUNT);
const MF_INIT_NORMS = new Int32Array(MF_TPL_COUNT);
const MF_INIT_BASE_STRIDE = new Uint8Array(MF_TPL_COUNT);

function buildZeroMeanTemplate(bits, modQ8, baseStride, dstBank, slot) {
  const effModPx = (modQ8 / 256.0) / baseStride;
  let len = Math.round(bits.length * effModPx) | 0;
  if (len < 8) len = 8;
  if (len > MF_TPL_STRIDE) len = MF_TPL_STRIDE;

  const off = Math.imul(slot, MF_TPL_STRIDE);
  let sum = 0;
  for (let k = 0; k < len; k++) {
    // Exact box integration over pixel [k, k+1] in module coordinates
    const m0 = k / effModPx;
    const m1 = (k + 1) / effModPx;
    const i0 = Math.floor(m0);
    const i1 = Math.floor(m1);
    let barFrac = 0;
    for (let m = i0; m <= i1; m++) {
      const a = m > m0 ? m : m0;
      const b = (m + 1) < m1 ? (m + 1) : m1;
      if (b > a && m >= 0 && m < bits.length && bits[m] === 1) {
        barFrac += (b - a);
      }
    }
    const frac = barFrac / (m1 - m0);
    // Dark bar -> -128, light space -> +128
    const val = Math.round(128 - 256 * frac) | 0;
    dstBank[(off + k) | 0] = val;
    sum = (sum + val) | 0;
  }

  // Zero-mean adjustment so dot product is strictly DC-offset invariant
  const mean = Math.round(sum / len) | 0;
  let normSq = 0;
  for (let k = 0; k < len; k++) {
    const v = (dstBank[(off + k) | 0] - mean) | 0;
    dstBank[(off + k) | 0] = v;
    normSq = (normSq + Math.imul(v, v)) | 0;
  }

  MF_INIT_LENS[slot] = len;
  MF_INIT_NORMS[slot] = isqrt32(normSq);
  MF_INIT_BASE_STRIDE[slot] = baseStride;
}

for (let b = 0; b < MF_NUM_BUCKETS; b++) {
  const mQ8 = MF_SCALE_BUCKETS_Q8[b];
  buildZeroMeanTemplate(MF_BITS_START_B, mQ8, 1, MF_INIT_BANK, b);
  buildZeroMeanTemplate(MF_BITS_STOP, mQ8, 1, MF_INIT_BANK, MF_NUM_BUCKETS + b);
  buildZeroMeanTemplate(MF_BITS_START_TSX, mQ8, b >= 8 ? 2 : 1, MF_INIT_BANK, (MF_NUM_BUCKETS << 1) + b);
}

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
    edgeCount: 0,

    // BL2 (`blurEdges`): pre-allocated secondary LoG edge bank & fallback trigger telemetry
    edgePosQ8B: new Int32Array(MAX_RUNS + 2),
    edgePolB: new Int8Array(MAX_RUNS + 2),
    edgeMagB: new Int16Array(MAX_RUNS + 2),
    edgeCountB: 0,
    blurFallbackTriggered: 0,

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

    // BL3 (`matchFilter`): pre-allocated template bank, correlation scratch & scalar hits
    templateBank: new Int16Array(MF_INIT_BANK),
    templateLens: new Uint8Array(MF_INIT_LENS),
    templateNorms: new Int32Array(MF_INIT_NORMS),
    templateBaseStride: new Uint8Array(MF_INIT_BASE_STRIDE),
    templateCount: MF_TPL_COUNT,
    corrScratch: new Int32Array(MAX_SCANLINE_LEN),
    startPosQ8: 0,
    stopPosQ8: 0,
    startScore: 0,
    stopScore: 0,
    tsxScore: 0,
    matchDir: 0,
    matchScaleQ8: 0,
    matchLinesEvaluated: 0,
    matchLinesRejected: 0,
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
    state.edgeCount = 0;
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

  state.edgeCount = edgeCount;
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
 * BL2 (`blurEdges`): 1D integer 2nd-derivative / LoG zero-crossing edge extractor into
 * pre-allocated Bank B (`edgePosQ8B`, `edgePolB`, `edgeMagB`).
 *
 * Under motion blur, defocus, or print-gain spread, narrow 1-module bars/spaces lose
 * peak amplitude and often fail to cross the 50% mid-level or the primary 1st-derivative
 * relative threshold, whereas the 2nd-derivative inflection point (`s''(x) = 0`) remains
 * anchored to the true bar boundary.
 *
 * Kernel & independent composition with W12 (`deblur1d`):
 *  - `smooth = 0` (default): 3-tap exact integer 2nd difference `[1, -2, 1]` with 2-tap
 *    centered slope `s[i] - s[i-1]` right across the zero-crossing (no neighbor bleeding
 *    on 2.0–2.5 px/mod blurred bars). When `deblur1d` is also ON, `deblurScanlineLuma`
 *    has already sharpened `lumaBuf` in-place, so `smooth = 0` avoids double-filtering.
 *  - `smooth = 1`: 3-tap binomial pre-smooth `[1, 2, 1] >> 2` into `state.scratchLuma`
 *    followed by `[1, -2, 1]` (= 5-tap integer LoG `[1, 0, -2, 0, 1]`).
 *
 * Reuses `state.deriv` (2nd deriv), `state.absDeriv` (|2-tap slope|), `state.localEnv`
 * (bidirectional envelope), and `state.scratchLuma` (when `smooth !== 0`).
 * Pure 32-bit integer Q8 math, zero allocations.
 *
 * @returns {number} Number of 2nd-derivative zero-crossing edges extracted (`state.edgeCountB`)
 */
export function extractLogEdges(lumaBuf, offset, len, state, relThreshQ8 = 16, minSlope = 3, smooth = 0) {
  const n = len | 0;
  if (n < 16) {
    state.edgeCountB = 0;
    return 0;
  }

  let src = lumaBuf;
  let srcBase = offset | 0;
  if (smooth !== 0) {
    const scratch = state.scratchLuma;
    const base = offset | 0;
    scratch[0] = lumaBuf[base];
    const sLast = (n - 1) | 0;
    for (let i = 1; i < sLast; i++) {
      const idx = (base + i) | 0;
      scratch[i] = (lumaBuf[idx - 1] + (lumaBuf[idx] << 1) + lumaBuf[idx + 1] + 2) >> 2;
    }
    scratch[sLast] = lumaBuf[(base + sLast) | 0];
    src = scratch;
    srcBase = 0;
  }

  const logBuf = state.deriv;
  const absSlope = state.absDeriv;
  const localEnv = state.localEnv;
  const edgePosQ8B = state.edgePosQ8B;
  const edgePolB = state.edgePolB;
  const edgeMagB = state.edgeMagB;

  logBuf[0] = 0;
  absSlope[0] = 0;
  localEnv[0] = 0;

  // Pass 1: Integer 2nd difference [1, -2, 1] + 2-tap centered slope & forward envelope
  let env = 0;
  const last = (n - 1) | 0;
  for (let i = 1; i < last; i++) {
    const idx = (srcBase + i) | 0;
    logBuf[i] = (src[idx - 1] - (src[idx] << 1) + src[idx + 1]) | 0;
    const d1 = (src[idx] - src[idx - 1]) | 0;
    const ad1 = d1 < 0 ? -d1 : d1;
    absSlope[i] = ad1;
    env = (Math.imul(env, 247) >> 8) | 0;
    if (ad1 > env) env = ad1;
    localEnv[i] = env;
  }
  logBuf[last] = 0;
  absSlope[last] = 0;
  localEnv[last] = 0;

  // Pass 2: Backward max-envelope for shadow-invariant local contrast gating
  env = 0;
  for (let i = last - 1; i >= 1; i--) {
    const ad1 = absSlope[i];
    env = (Math.imul(env, 247) >> 8) | 0;
    if (ad1 > env) env = ad1;
    if (env > localEnv[i]) localEnv[i] = env;
  }

  // Pass 3: Sub-pixel Q8 2nd-derivative zero-crossings with slope polarity & adaptive gating
  let countB = 0;
  const maxEdges = (MAX_RUNS + 1) | 0;
  const relQ8 = relThreshQ8 | 0;
  const minS = minSlope | 0;
  const minGapQ8 = 128; // 0.5 px minimum inter-edge spacing

  for (let i = 2; i < last; i++) {
    const Lm = logBuf[i - 1];
    const L0 = logBuf[i];
    let pol = 0;
    if (Lm <= 0 && L0 > 0) pol = -1;      // space -> bar (falling edge)
    else if (Lm >= 0 && L0 < 0) pol = 1;  // bar -> space (rising edge)
    if (pol === 0) continue;

    const idx = (srcBase + i) | 0;
    const d1 = (src[idx] - src[idx - 1]) | 0;
    if ((pol === -1 && d1 >= 0) || (pol === 1 && d1 <= 0)) continue;

    const ad1 = d1 < 0 ? -d1 : d1;
    let thresh = (Math.imul(localEnv[i], relQ8) >> 8) | 0;
    if (thresh < minS) thresh = minS;
    if (ad1 < thresh) continue;

    const denom = (Lm - L0) | 0;
    let fracQ8 = 128;
    if (denom !== 0) {
      fracQ8 = ((Lm << 8) / denom) | 0;
      if (fracQ8 < 0) fracQ8 = 0;
      else if (fracQ8 > 256) fracQ8 = 256;
    }
    const posQ8 = (((i - 1) << 8) + fracQ8) | 0;

    if (countB === 0) {
      edgePosQ8B[0] = posQ8;
      edgePolB[0] = pol;
      edgeMagB[0] = ad1;
      countB = 1;
    } else {
      const prevIdx = (countB - 1) | 0;
      if (edgePolB[prevIdx] === pol) {
        if (ad1 > edgeMagB[prevIdx]) {
          edgePosQ8B[prevIdx] = posQ8;
          edgeMagB[prevIdx] = ad1;
        }
      } else if (((posQ8 - edgePosQ8B[prevIdx]) | 0) >= minGapQ8 && countB < maxEdges) {
        edgePosQ8B[countB] = posQ8;
        edgePolB[countB] = pol;
        edgeMagB[countB] = ad1;
        countB++;
      }
    }
  }

  state.edgeCountB = countB;
  return countB;
}

/**
 * BL2 (`blurEdges`): Proximity-fuses primary 1st-derivative edges (Bank A: `edgePosQ8[0..nA-1]`)
 * with LoG 2nd-derivative zero-crossing edges (Bank B: `edgePosQ8B[0..nB-1]`) directly into
 * `state.runWidthsQ8` / `state.runIsBar` using a single O(nA + nB) two-pointer pass with
 * 1-edge lookahead.
 *
 * - Matched same-polarity edges within `proxQ8` are blended (50/50 when primary is strong;
 *   25/75 LoG-weighted when primary is weak/blurred) to cancel bias and reduce jitter.
 * - Unmatched LoG edges fill in narrow 1-module bars/spaces dropped by primary under blur.
 * - Pass `nA = 0` for pure LoG-only run extraction from Bank B.
 *
 * Pure 32-bit integer arithmetic, zero heap allocations.
 *
 * @returns {number} Number of fused runs extracted (`state.runCount`)
 */
export function fuseEdgeBanksToRuns(len, state, nA, nB, proxQ8 = 320) {
  const n = len | 0;
  const countA = nA | 0;
  const countB = nB | 0;
  if (n < 16 || ((countA + countB) | 0) < 2) {
    state.runCount = 0;
    return 0;
  }

  const posA = state.edgePosQ8;
  const polA = state.edgePol;
  const magA = state.edgeMag;
  const posB = state.edgePosQ8B;
  const polB = state.edgePolB;
  const magB = state.edgeMagB;
  const runWidthsQ8 = state.runWidthsQ8;
  const runIsBar = state.runIsBar;
  const prox = proxQ8 | 0;

  let a = 0;
  let b = 0;
  let rc = 0;
  let hasPrev = 0;
  let prevPosQ8 = 0;
  let prevPol = 0;
  let hasCur = 0;
  let curPosQ8 = 0;
  let curPol = 0;
  let curMag = 0;

  while (a < countA || b < countB) {
    let candPos = 0;
    let candPol = 0;
    let candMag = 0;

    if (a < countA && b < countB) {
      const pA = posA[a];
      const pB = posB[b];
      const diff = (pA - pB) | 0;
      const absDiff = diff < 0 ? -diff : diff;
      if (absDiff <= prox && polA[a] === polB[b]) {
        const mA = magA[a];
        const mB = magB[b] << 1;
        // Blend 50/50 on strong primary edges; favor LoG 75/25 on weak/blurred primary edges
        candPos = mA >= 36
          ? ((pA + pB + 1) >> 1)
          : ((pA + Math.imul(pB, 3) + 2) >> 2);
        candPol = polA[a];
        candMag = (mA + mB) | 0;
        a++;
        b++;
      } else if (pA <= pB) {
        candPos = pA;
        candPol = polA[a];
        candMag = magA[a];
        a++;
      } else {
        candPos = pB;
        candPol = polB[b];
        candMag = magB[b] << 1;
        b++;
      }
    } else if (a < countA) {
      candPos = posA[a];
      candPol = polA[a];
      candMag = magA[a];
      a++;
    } else {
      candPos = posB[b];
      candPol = polB[b];
      candMag = magB[b] << 1;
      b++;
    }

    if (hasCur === 0) {
      curPosQ8 = candPos;
      curPol = candPol;
      curMag = candMag;
      hasCur = 1;
    } else if (candPol === curPol) {
      if (candMag > curMag) {
        curPosQ8 = candPos;
        curMag = candMag;
      }
    } else {
      // Polarity flipped: commit `cur` and emit run
      if (hasPrev === 0) {
        state.runOriginQ8 = curPol === -1 ? 0 : curPosQ8;
        if (curPol === -1 && rc < MAX_RUNS) {
          runWidthsQ8[rc] = curPosQ8 > 26 ? curPosQ8 : 26;
          runIsBar[rc] = 0;
          rc++;
        }
        hasPrev = 1;
      } else if (rc < MAX_RUNS) {
        const w = (curPosQ8 - prevPosQ8) | 0;
        runWidthsQ8[rc] = w > 26 ? w : 26;
        runIsBar[rc] = prevPol === -1 ? 1 : 0;
        rc++;
      }
      prevPosQ8 = curPosQ8;
      prevPol = curPol;
      curPosQ8 = candPos;
      curPol = candPol;
      curMag = candMag;
    }
  }

  // Finalize pending `cur` edge
  if (hasPrev === 1 && hasCur === 1) {
    if (rc < MAX_RUNS) {
      const w = (curPosQ8 - prevPosQ8) | 0;
      runWidthsQ8[rc] = w > 26 ? w : 26;
      runIsBar[rc] = prevPol === -1 ? 1 : 0;
      rc++;
    }
    if (curPol === 1 && rc < MAX_RUNS) {
      const tail = (((n - 1) << 8) - curPosQ8) | 0;
      runWidthsQ8[rc] = tail > 26 ? tail : 26;
      runIsBar[rc] = 0;
      rc++;
    }
  } else {
    rc = 0;
  }

  state.runCount = rc;
  return rc;
}

/**
 * BL2 (`blurEdges`): Fallback blur-resilient run extractor combining integer LoG
 * zero-crossings with proximity fusion against primary 1st-derivative edges (when
 * `hasPrimaryEdges !== 0` and `state.edgeCount >= 2`).
 *
 * Pure 32-bit integer arithmetic, zero heap allocations.
 *
 * @returns {number} Number of runs extracted (`state.runCount`)
 */
export function extractRunsBlurResilient(lumaBuf, offset, len, state, hasPrimaryEdges = 0, smooth = 0) {
  const nB = extractLogEdges(lumaBuf, offset, len, state, 16, 3, smooth);
  const nA = hasPrimaryEdges !== 0 ? (state.edgeCount | 0) : 0;
  if (((nA + nB) | 0) < 2) {
    state.runCount = 0;
    return 0;
  }

  let proxQ8 = 320; // 1.25 px default proximity fusion window
  const modQ8 = state.moduleWidthQ8 | 0;
  if (modQ8 >= 256) {
    proxQ8 = modQ8 >> 1;
    if (proxQ8 < 192) proxQ8 = 192;
    else if (proxQ8 > 512) proxQ8 = 512;
  }

  return fuseEdgeBanksToRuns(len, state, nA, nB, proxQ8);
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

// ============================================================================
// BL3 (`matchFilter`): Scale-Bucketed Matched Filter (Start B / Stop / tsX)
// ============================================================================

/**
 * Selects the nearest pre-allocated Q8 scale bucket index `0..11` for an effective
 * module width `effModQ8` (after any integer decimation stride). Pure int32, zero alloc.
 */
export function selectMatchFilterBucket(effModQ8) {
  const m = effModQ8 | 0;
  let bestB = 0;
  let bestDiff = 0x7fffffff;
  for (let b = 0; b < MF_NUM_BUCKETS; b++) {
    let d = (m - MF_SCALE_BUCKETS_Q8[b]) | 0;
    if (d < 0) d = -d;
    if (d < bestDiff) {
      bestDiff = d;
      bestB = b;
    }
  }
  return bestB;
}

/**
 * Pure-integer sliding-window zero-mean NCC correlation of a single pre-allocated template
 * against `lumaBuf[offset .. offset+len-1]`.
 *
 * When `writeCorr !== 0`, writes `max(corrScratch[c], scoreQ10)` at the pattern's bar-span
 * center `c = x + centerOff` so downstream `stopGuard` can query local Stop correlation in O(1).
 * Returns packed `(bestScoreQ10 << 12) | (bestX & 0xfff)` (zero object allocations!).
 */
function correlateTemplate1D(
  lumaBuf,
  offset,
  len,
  tplBank,
  tplOff,
  tplLen,
  tplNorm,
  stride,
  reversed,
  centerOff,
  corrScratch,
  writeCorr
) {
  const n = len | 0;
  const L = tplLen | 0;
  const st = stride | 0;
  const span = (Math.imul(L - 1, st) + 1) | 0;
  if (L < 8 || span > n || tplNorm <= 0) return 0;

  const base = offset | 0;
  const maxX = (n - span) | 0;
  // Minimum local variance: std dev >= 6 luma levels -> varS >= 36 * L (rejects flat/blank lines)
  const minVarS = Math.imul(36, L);
  const tLast = (tplOff + L - 1) | 0;

  let bestScore = 0;
  let bestX = 0;

  if (st === 1) {
    // Fast stride-1 path with O(1) sliding winSum & winSqSum
    let winSum = 0;
    let winSqSum = 0;
    for (let k = 0; k < L; k++) {
      const v = lumaBuf[(base + k) | 0];
      winSum = (winSum + v) | 0;
      winSqSum = (winSqSum + Math.imul(v, v)) | 0;
    }

    for (let x = 0; x <= maxX; x++) {
      const meanSq = (Math.imul(winSum, winSum) / L) | 0;
      const varS = (winSqSum - meanSq) | 0;
      if (varS >= minVarS) {
        let dot = 0;
        const p = (base + x) | 0;
        if (reversed === 0) {
          for (let k = 0; k < L; k++) {
            dot = (dot + Math.imul(lumaBuf[(p + k) | 0], tplBank[(tplOff + k) | 0])) | 0;
          }
        } else {
          for (let k = 0; k < L; k++) {
            dot = (dot + Math.imul(lumaBuf[(p + k) | 0], tplBank[(tLast - k) | 0])) | 0;
          }
        }
        if (dot > 0) {
          const sNorm = isqrt32(varS);
          const denom = Math.imul(sNorm, tplNorm);
          if (denom > 15) {
            let score = (((dot >> 4) << 10) / (denom >> 4)) | 0;
            if (score > 1024) score = 1024;
            if (score > bestScore) {
              bestScore = score;
              bestX = x;
            }
            if (writeCorr !== 0) {
              const cx = (x + centerOff) | 0;
              if (cx >= 0 && cx < n && score > corrScratch[cx]) {
                corrScratch[cx] = score;
              }
            }
          }
        }
      }
      if (x < maxX) {
        const vOut = lumaBuf[(base + x) | 0];
        const vIn = lumaBuf[(base + x + L) | 0];
        winSum = (winSum - vOut + vIn) | 0;
        winSqSum = (winSqSum - Math.imul(vOut, vOut) + Math.imul(vIn, vIn)) | 0;
      }
    }
  } else {
    // Decimated stride >= 2 path (close-range barcodes > 5.83 px/mod)
    for (let x = 0; x <= maxX; x = (x + st) | 0) {
      let winSum = 0;
      let winSqSum = 0;
      const p = (base + x) | 0;
      for (let k = 0; k < L; k++) {
        const v = lumaBuf[(p + Math.imul(k, st)) | 0];
        winSum = (winSum + v) | 0;
        winSqSum = (winSqSum + Math.imul(v, v)) | 0;
      }
      const meanSq = (Math.imul(winSum, winSum) / L) | 0;
      const varS = (winSqSum - meanSq) | 0;
      if (varS >= minVarS) {
        let dot = 0;
        if (reversed === 0) {
          for (let k = 0; k < L; k++) {
            dot = (dot + Math.imul(lumaBuf[(p + Math.imul(k, st)) | 0], tplBank[(tplOff + k) | 0])) | 0;
          }
        } else {
          for (let k = 0; k < L; k++) {
            dot = (dot + Math.imul(lumaBuf[(p + Math.imul(k, st)) | 0], tplBank[(tLast - k) | 0])) | 0;
          }
        }
        if (dot > 0) {
          const sNorm = isqrt32(varS);
          const denom = Math.imul(sNorm, tplNorm);
          if (denom > 15) {
            let score = (((dot >> 4) << 10) / (denom >> 4)) | 0;
            if (score > 1024) score = 1024;
            if (score > bestScore) {
              bestScore = score;
              bestX = x;
            }
            if (writeCorr !== 0) {
              const cx = (x + centerOff) | 0;
              const lo = cx >= 0 ? cx : 0;
              const hi = (cx + st) < n ? (cx + st) : n;
              for (let j = lo; j < hi; j++) {
                if (score > corrScratch[j]) corrScratch[j] = score;
              }
            }
          }
        }
      }
    }
  }

  return ((bestScore & 0x7ff) << 12) | (bestX & 0xfff);
}

/**
 * Evaluates a single template at a narrow local window `[xMin .. xMax]` (used for the
 * combined `Start B + tsX` template right at the Start B peak, zero full-line overhead).
 */
function correlateTemplateLocal(
  lumaBuf,
  offset,
  len,
  tplBank,
  tplOff,
  tplLen,
  tplNorm,
  stride,
  reversed,
  xMin,
  xMax
) {
  const n = len | 0;
  const L = tplLen | 0;
  const st = stride | 0;
  const span = (Math.imul(L - 1, st) + 1) | 0;
  if (L < 8 || span > n || tplNorm <= 0) return 0;

  let lo = xMin | 0;
  if (lo < 0) lo = 0;
  let hi = xMax | 0;
  const maxValid = (n - span) | 0;
  if (hi > maxValid) hi = maxValid;
  if (lo > hi) return 0;

  const base = offset | 0;
  const minVarS = Math.imul(36, L);
  const tLast = (tplOff + L - 1) | 0;
  let bestScore = 0;

  for (let x = lo; x <= hi; x++) {
    let winSum = 0;
    let winSqSum = 0;
    let dot = 0;
    const p = (base + x) | 0;
    if (st === 1) {
      if (reversed === 0) {
        for (let k = 0; k < L; k++) {
          const v = lumaBuf[(p + k) | 0];
          winSum = (winSum + v) | 0;
          winSqSum = (winSqSum + Math.imul(v, v)) | 0;
          dot = (dot + Math.imul(v, tplBank[(tplOff + k) | 0])) | 0;
        }
      } else {
        for (let k = 0; k < L; k++) {
          const v = lumaBuf[(p + k) | 0];
          winSum = (winSum + v) | 0;
          winSqSum = (winSqSum + Math.imul(v, v)) | 0;
          dot = (dot + Math.imul(v, tplBank[(tLast - k) | 0])) | 0;
        }
      }
    } else {
      if (reversed === 0) {
        for (let k = 0; k < L; k++) {
          const v = lumaBuf[(p + Math.imul(k, st)) | 0];
          winSum = (winSum + v) | 0;
          winSqSum = (winSqSum + Math.imul(v, v)) | 0;
          dot = (dot + Math.imul(v, tplBank[(tplOff + k) | 0])) | 0;
        }
      } else {
        for (let k = 0; k < L; k++) {
          const v = lumaBuf[(p + Math.imul(k, st)) | 0];
          winSum = (winSum + v) | 0;
          winSqSum = (winSqSum + Math.imul(v, v)) | 0;
          dot = (dot + Math.imul(v, tplBank[(tLast - k) | 0])) | 0;
        }
      }
    }
    if (dot > 0) {
      const meanSq = (Math.imul(winSum, winSum) / L) | 0;
      const varS = (winSqSum - meanSq) | 0;
      if (varS >= minVarS) {
        const sNorm = isqrt32(varS);
        const denom = Math.imul(sNorm, tplNorm);
        if (denom > 3) {
          let score = (Math.imul(dot >> 2, 1024) / (denom >> 2)) | 0;
          if (score > 1024) score = 1024;
          if (score > bestScore) bestScore = score;
        }
      }
    }
  }

  return bestScore;
}

/**
 * Fallback module-width estimate (Q8) used by BL3 when BL1 (`moduleEst`) is OFF.
 * Uses Code 128's edge-shift-invariant `6 runs = 11 modules` ratio on non-quiet runs,
 * falling back to `roiMajorLen / 176` or 2.2 px/mod. Pure int32, zero alloc.
 */
function fallbackModuleWidthQ8(state) {
  const rc = state.runCount | 0;
  if (rc >= 16) {
    const rw = state.runWidthsQ8;
    const isBar = state.runIsBar;
    const rEnd = (rc - 1) | 0;
    // First pass: mean of dark bars (never quiet zones; Code 128 mean bar = 11/6 = 1.833 mod)
    let barSum = 0;
    let barCnt = 0;
    for (let r = 1; r < rEnd; r++) {
      if (isBar[r] === 1) {
        barSum = (barSum + rw[r]) | 0;
        barCnt = (barCnt + 1) | 0;
      }
    }
    if (barCnt >= 6) {
      const roughModQ8 = ((Math.imul(barSum, 6) + Math.imul(barCnt, 5)) / Math.imul(barCnt, 11)) | 0;
      const quietCap = Math.imul(roughModQ8, 6);
      let sum = 0;
      let used = 0;
      for (let r = 1; r < rEnd; r++) {
        const w = rw[r] | 0;
        if (isBar[r] === 0 && w >= quietCap) continue;
        sum = (sum + w) | 0;
        used = (used + 1) | 0;
      }
      if (used >= 12) {
        const den = Math.imul(used, 11);
        let modQ8 = ((Math.imul(sum, 6) + (den >> 1)) / den) | 0;
        if (modQ8 < 256) modQ8 = 256;
        else if (modQ8 > 10240) modQ8 = 10240;
        return modQ8;
      }
    }
  }
  const roiLen = state.roiMajorLen | 0;
  if (roiLen > 64) {
    let modQ8 = ((roiLen << 8) / DEFAULT_EXPECTED_MODULES) | 0;
    if (modQ8 < 256) modQ8 = 256;
    else if (modQ8 > 10240) modQ8 = 10240;
    return modQ8;
  }
  return 560; // 2.19 px/mod default
}

/**
 * BL3 (`matchFilter`): Pre-allocated Start B / Stop / combined Start B+tsX matched filter.
 *
 * 1. Selects pre-allocated Q8 scale-bucketed templates using BL1's `moduleWidthQ8` (or
 *    fallback scale estimate if BL1 is off). No per-frame template building or allocation.
 * 2. Correlates Start B (fwd + rev) and Stop (fwd + rev) into `state.corrScratch` (which
 *    retains the per-pixel Stop correlation profile for `stopGuard` O(1) lookup).
 * 3. Evaluates the combined `Start B + tsX` template locally at the Start B peak to extend
 *    `FLAG_CRIB_MATCH` / `prefixStack`.
 * 4. Populates scalar hit fields on `state` and `c128`, and returns `1` (pass -> decode) or
 *    `0` (early-reject gate -> skip decode on this scanline).
 *
 * Strictly zero heap allocations and pure 32-bit integer arithmetic.
 */
export function matchFilterScanline(lumaBuf, offset, len, state, c128 = null, isMergedCluster = 0) {
  const n = len | 0;
  state.startPosQ8 = 0;
  state.stopPosQ8 = 0;
  state.startScore = 0;
  state.stopScore = 0;
  state.tsxScore = 0;
  state.matchDir = 0;
  state.matchScaleQ8 = 0;

  if (c128 !== null) {
    c128.mfValid = 0;
    c128.mfStartPosQ8 = 0;
    c128.mfStopPosQ8 = 0;
    c128.mfStartScore = 0;
    c128.mfStopScore = 0;
    c128.mfTsxScore = 0;
    c128.mfDir = 0;
    c128.mfScaleQ8 = 0;
    c128.mfLineLen = n;
    c128.mfStopCorr = null;
    c128.lastStopCorrQ10 = 0;
  }

  if (n < 48) return 0;

  // 1. Determine module width Q8 (from BL1 if available, else fallback estimate)
  const bl1ModQ8 = (state.flags & FLAG_MODULE_EST) !== 0 ? (state.moduleWidthQ8 | 0) : 0;
  const modQ8 = bl1ModQ8 >= 256 ? bl1ModQ8 : fallbackModuleWidthQ8(state);

  let stride = 1;
  let effModQ8 = modQ8;
  if (modQ8 > 1600) {
    stride = ((modQ8 + 384) / 768) | 0;
    if (stride < 2) stride = 2;
    effModQ8 = ((modQ8 + (stride >> 1)) / stride) | 0;
  }

  const baseBucket = selectMatchFilterBucket(effModQ8);
  const bank = state.templateBank;
  const lens = state.templateLens;
  const norms = state.templateNorms;
  const baseStrides = state.templateBaseStride;
  const corrScratch = state.corrScratch;

  // 2. Correlate Start B (fwd + rev) on baseBucket; check adjacent buckets if score < 620
  let bestStartScore = 0;
  let bestStartX = 0;
  let bestStartDir = 1;
  let bestBucket = baseBucket;

  for (let pass = 0; pass < 3; pass++) {
    let b = baseBucket;
    if (pass === 1) {
      if (bestStartScore >= 620 || baseBucket <= 0) continue;
      b = (baseBucket - 1) | 0;
    } else if (pass === 2) {
      if (bestStartScore >= 620 || baseBucket >= (MF_NUM_BUCKETS - 1)) continue;
      b = (baseBucket + 1) | 0;
    }
    const slot = b;
    const tOff = Math.imul(slot, MF_TPL_STRIDE);
    const tLen = lens[slot] | 0;
    const tNorm = norms[slot] | 0;

    const pFwd = correlateTemplate1D(lumaBuf, offset, n, bank, tOff, tLen, tNorm, stride, 0, 0, corrScratch, 0);
    const sFwd = pFwd >> 12;
    if (sFwd > bestStartScore) {
      bestStartScore = sFwd;
      bestStartX = pFwd & 0xfff;
      bestStartDir = 1;
      bestBucket = b;
    }

    const pRev = correlateTemplate1D(lumaBuf, offset, n, bank, tOff, tLen, tNorm, stride, 1, 0, corrScratch, 0);
    const sRev = pRev >> 12;
    if (sRev > bestStartScore) {
      bestStartScore = sRev;
      bestStartX = pRev & 0xfff;
      bestStartDir = -1;
      bestBucket = b;
    }
  }

  // 3. Correlate Stop (fwd + rev) into corrScratch (aligned to Stop 13-module bar center)
  for (let i = 0; i < n; i++) corrScratch[i] = 0;

  let bestStopScore = 0;
  let bestStopCenter = 0;
  let bestStopDir = 0;
  let stopBucket = bestStartScore >= 460 ? bestBucket : baseBucket;

  for (let pass = 0; pass < 3; pass++) {
    let b = stopBucket;
    if (pass === 1) {
      if (bestStopScore >= 600 || stopBucket <= 0) continue;
      b = (stopBucket - 1) | 0;
    } else if (pass === 2) {
      if (bestStopScore >= 600 || stopBucket >= (MF_NUM_BUCKETS - 1)) continue;
      b = (stopBucket + 1) | 0;
    }
    const slot = (MF_NUM_BUCKETS + b) | 0;
    const tOff = Math.imul(slot, MF_TPL_STRIDE);
    const tLen = lens[slot] | 0;
    const tNorm = norms[slot] | 0;
    const spanPx = (Math.imul(tLen - 1, stride) + 1) | 0;
    // Stop is [13 bars, 2 quiet] -> fwd bar center is 6.5/15 of span, rev bar center is 8.5/15
    const fwdCenterOff = (Math.imul(spanPx, 111) >> 8) | 0; // 111/256 ≈ 6.5/15
    const revCenterOff = (Math.imul(spanPx, 145) >> 8) | 0; // 145/256 ≈ 8.5/15

    const pFwd = correlateTemplate1D(lumaBuf, offset, n, bank, tOff, tLen, tNorm, stride, 0, fwdCenterOff, corrScratch, 1);
    const sFwd = pFwd >> 12;
    if (sFwd > bestStopScore) {
      bestStopScore = sFwd;
      bestStopCenter = ((pFwd & 0xfff) + fwdCenterOff) | 0;
      bestStopDir = 1;
      if (bestStartScore < 460) bestBucket = b;
    }

    const pRev = correlateTemplate1D(lumaBuf, offset, n, bank, tOff, tLen, tNorm, stride, 1, revCenterOff, corrScratch, 1);
    const sRev = pRev >> 12;
    if (sRev > bestStopScore) {
      bestStopScore = sRev;
      bestStopCenter = ((pRev & 0xfff) + revCenterOff) | 0;
      bestStopDir = -1;
      if (bestStartScore < 460) bestBucket = b;
    }
  }

  // 4. Optional combined `Start B + tsX` template locally at the Start B peak
  let tsxScore = 0;
  const winScaleQ8 = Math.imul(MF_SCALE_BUCKETS_Q8[bestBucket], stride);
  const startLen = lens[bestBucket] | 0;
  const startSpan = (Math.imul(startLen - 1, stride) + 1) | 0;

  if (bestStartScore >= 460) {
    const tsxSlot = ((MF_NUM_BUCKETS << 1) + bestBucket) | 0;
    const tsxOff = Math.imul(tsxSlot, MF_TPL_STRIDE);
    const tsxLen = lens[tsxSlot] | 0;
    const tsxNorm = norms[tsxSlot] | 0;
    const tsxStride = Math.imul(stride, baseStrides[tsxSlot] | 0);
    const tsxSpan = (Math.imul(tsxLen - 1, tsxStride) + 1) | 0;
    const pad = Math.imul(4, stride);

    if (bestStartDir === 1) {
      tsxScore = correlateTemplateLocal(
        lumaBuf, offset, n, bank, tsxOff, tsxLen, tsxNorm, tsxStride, 0,
        (bestStartX - pad) | 0,
        (bestStartX + pad) | 0
      );
    } else {
      const revStart = (bestStartX + startSpan - tsxSpan) | 0;
      tsxScore = correlateTemplateLocal(
        lumaBuf, offset, n, bank, tsxOff, tsxLen, tsxNorm, tsxStride, 1,
        (revStart - pad) | 0,
        (revStart + pad) | 0
      );
    }
  }

  // Compute Start B bar-0 sub-pixel position (Q8) for cribMatch / prefixStack alignment
  const quiet2Q8 = (winScaleQ8 << 1) | 0; // 2 quiet modules before Start B bar 0
  let startPosQ8 = 0;
  if (bestStartScore > 0) {
    startPosQ8 = bestStartDir === 1
      ? (((bestStartX << 8) + quiet2Q8) | 0)
      : ((((bestStartX + startSpan) << 8) - quiet2Q8) | 0);
  }
  const stopPosQ8 = bestStopScore > 0 ? (bestStopCenter << 8) : 0;
  const finalDir = bestStartScore >= bestStopScore ? bestStartDir : (bestStopDir !== 0 ? bestStopDir : bestStartDir);

  state.startPosQ8 = startPosQ8;
  state.stopPosQ8 = stopPosQ8;
  state.startScore = bestStartScore;
  state.stopScore = bestStopScore;
  state.tsxScore = tsxScore;
  state.matchDir = finalDir;
  state.matchScaleQ8 = winScaleQ8;

  if (c128 !== null) {
    c128.mfValid = 1;
    c128.mfStartPosQ8 = startPosQ8;
    c128.mfStopPosQ8 = stopPosQ8;
    c128.mfStartScore = bestStartScore;
    c128.mfStopScore = bestStopScore;
    c128.mfTsxScore = tsxScore;
    c128.mfDir = finalDir;
    c128.mfScaleQ8 = winScaleQ8;
    c128.mfLineLen = n;
    c128.mfStopCorr = corrScratch;
  }

  // 5. Early-reject gate: require geometrically consistent (Start B + Stop), or strong Stop (Start A/C), or strong tsX
  const minSpanQ8 = Math.imul(winScaleQ8, 28);
  const sameDirSpanOk = (bestStartDir === bestStopDir) && (
    bestStartDir === 1
      ? ((stopPosQ8 - startPosQ8) | 0) >= minSpanQ8
      : ((startPosQ8 - stopPosQ8) | 0) >= minSpanQ8
  );
  const pass = (bestStopScore >= 580 && bestStartScore >= 540 && (isMergedCluster !== 0 || sameDirSpanOk)) ||
    (bestStopScore >= 680 && bestStartScore >= 440) ||
    (bestStopScore >= 740) ||
    (tsxScore >= 620) ||
    (isMergedCluster !== 0 && bestStopScore >= 600);

  return pass ? 1 : 0;
}
