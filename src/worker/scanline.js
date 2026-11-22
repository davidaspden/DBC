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
    // Generated scanline descriptors in 16.16 fixed-point integers (zero float boxing!)
    lineCount: 0,
    lineStartXQ16: new Int32Array(MAX_SCANLINES),
    lineStartYQ16: new Int32Array(MAX_SCANLINES),
    lineStepXQ16: new Int32Array(MAX_SCANLINES),
    lineStepYQ16: new Int32Array(MAX_SCANLINES),
    lineLength: new Int32Array(MAX_SCANLINES),

    // Pre-allocated luma cache for all lines: lineIndex * MAX_SCANLINE_LEN + sampleIndex
    lumaBank: new Uint8Array(MAX_SCANLINES * MAX_SCANLINE_LEN),
    // Scratch single-line buffer for Tier C denoised composite profiles
    avgLumaBuf: new Uint8Array(MAX_SCANLINE_LEN),

    // Stage 3 1D derivative, local envelope, sub-pixel edge positions (Q8) & run widths (Q8)
    deriv: new Int16Array(MAX_SCANLINE_LEN),
    absDeriv: new Int16Array(MAX_SCANLINE_LEN),
    localEnv: new Int16Array(MAX_SCANLINE_LEN),

    edgePosQ8: new Int32Array(MAX_RUNS + 2),
    edgePol: new Int8Array(MAX_RUNS + 2),   // -1 = space->bar (falling), +1 = bar->space (rising)
    edgeMag: new Int16Array(MAX_RUNS + 2),

    runWidthsQ8: new Int32Array(MAX_RUNS),  // Q8 fixed-point sub-pixel widths (256 = 1.0 px)
    runIsBar: new Uint8Array(MAX_RUNS),     // 1 = dark bar, 0 = light space
    runCount: 0,
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
