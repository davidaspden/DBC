/**
 * Phase 1: Offline Benchmark & Fixture Harness (Code 128 Scope)
 *
 * Dual-environment Vanilla ES Module (Node.js CLI & Browser ESM compatible, zero dependencies):
 *  1. Deterministic PRNG & math utilities
 *  2. ISO/IEC 15417 Code 128B / Code 128C bitstream encoder & table self-verifier
 *  3. 720p (1280x720) synthetic luma synthesizer (rotations, 2x2 SSAA, shadows, glare, blur, noise, clutter)
 *  4. Zero-dependency real-world PGM (P5) & raw Y-plane fixture loader + PGM debug exporter
 *  5. Canonical Code 128 720p benchmark matrix (0°, 15°, 37°, 90°, 143°, degradations & negative controls)
 *  6. Zero-allocation frame execution profiler, heap-delta audit & Phase 1 baseline 4x-downsample benchmark
 *
 * Angle Convention (shared across Phases 1–4):
 *  - Origin (0, 0) at top-left; +x right, +y down.
 *  - thetaDeg in [0, 180) is the scanline traversal direction (perpendicular to bars):
 *      0°  -> vertical bars, horizontal scanlines along (1, 0), |Gx| dominates
 *      90° -> horizontal bars, vertical scanlines along (0, 1), |Gy| dominates
 *      θ   -> bars rotated clockwise by θ; scanlines step along (cos θ, sin θ)
 */

import {
  createRoiState,
  estimateRoi,
  ROI_CONFIDENCE_THRESHOLD,
} from '../src/worker/roi.js';
import {
  createPipelineState,
  processFrame,
  extractPayloadString,
} from '../src/worker/scanner.worker.js';

export const FRAME_WIDTH = 1280;
export const FRAME_HEIGHT = 720;

export const SYMBOLOGY_NONE = 0;
export const SYMBOLOGY_CODE_128 = 1;

export const CODE128_START_A = 103;
export const CODE128_START_B = 104;
export const CODE128_START_C = 105;
export const CODE128_STOP = 106;

// ============================================================================
// 1. Deterministic PRNG & Math Helpers
// ============================================================================

/**
 * Deterministic xorshift32 PRNG returning floats in [0, 1).
 * @param {number} seed
 */
export function createRng(seed) {
  let state = (seed | 0) || 0x12345678;
  return {
    nextUint32() {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    },
    next() {
      return this.nextUint32() / 4294967296;
    },
    nextGaussian() {
      let u1 = this.next();
      if (u1 < 1e-12) u1 = 1e-12;
      const u2 = this.next();
      return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(6.283185307179586 * u2);
    },
  };
}

/**
 * Shortest circular angular difference modulo 180 degrees (in [0, 90]).
 * @param {number} aDeg
 * @param {number} bDeg
 */
export function angularErrorDeg180(aDeg, bDeg) {
  let diff = Math.abs((((aDeg - bDeg) % 180) + 180) % 180);
  if (diff > 90) diff = 180 - diff;
  return diff;
}

// ============================================================================
// 2. ISO/IEC 15417 Code 128 Pattern Table & Bitstream Encoders
// ============================================================================

/**
 * Flat 106 * 6 table of Code 128 symbol run widths (bar, space, bar, space, bar, space)
 * for symbol values 0..105. Every symbol sums to 11 modules with even bar-width sum.
 */
export const CODE128_PATTERNS = new Uint8Array([
  2,1,2,2,2,2,  2,2,2,1,2,2,  2,2,2,2,2,1,  1,2,1,2,2,3,  1,2,1,3,2,2,  // 0..4
  1,3,1,2,2,2,  1,2,2,2,1,3,  1,2,2,3,1,2,  1,3,2,2,1,2,  2,2,1,2,1,3,  // 5..9
  2,2,1,3,1,2,  2,3,1,2,1,2,  1,1,2,2,3,2,  1,2,2,1,3,2,  1,2,2,2,3,1,  // 10..14
  1,1,3,2,2,2,  1,2,3,1,2,2,  1,2,3,2,2,1,  2,2,3,2,1,1,  2,2,1,1,3,2,  // 15..19
  2,2,1,2,3,1,  2,1,3,2,1,2,  2,2,3,1,1,2,  3,1,2,1,3,1,  3,1,1,2,2,2,  // 20..24
  3,2,1,1,2,2,  3,2,1,2,2,1,  3,1,2,2,1,2,  3,2,2,1,1,2,  3,2,2,2,1,1,  // 25..29
  2,1,2,1,2,3,  2,1,2,3,2,1,  2,3,2,1,2,1,  1,1,1,3,2,3,  1,3,1,1,2,3,  // 30..34
  1,3,1,3,2,1,  1,1,2,3,1,3,  1,3,2,1,1,3,  1,3,2,3,1,1,  2,1,1,3,1,3,  // 35..39
  2,3,1,1,1,3,  2,3,1,3,1,1,  1,1,2,1,3,3,  1,1,2,3,3,1,  1,3,2,1,3,1,  // 40..44
  1,1,3,1,2,3,  1,1,3,3,2,1,  1,3,3,1,2,1,  3,1,3,1,2,1,  2,1,1,3,3,1,  // 45..49
  2,3,1,1,3,1,  2,1,3,1,1,3,  2,1,3,3,1,1,  2,1,3,1,3,1,  3,1,1,1,2,3,  // 50..54
  3,1,1,3,2,1,  3,3,1,1,2,1,  3,1,2,1,1,3,  3,1,2,3,1,1,  3,3,2,1,1,1,  // 55..59
  3,1,4,1,1,1,  2,2,1,4,1,1,  4,3,1,1,1,1,  1,1,1,2,2,4,  1,1,1,4,2,2,  // 60..64
  1,2,1,1,2,4,  1,2,1,4,2,1,  1,4,1,1,2,2,  1,4,1,2,2,1,  1,1,2,2,1,4,  // 65..69
  1,1,2,4,1,2,  1,2,2,1,1,4,  1,2,2,4,1,1,  1,4,2,1,1,2,  1,4,2,2,1,1,  // 70..74
  2,4,1,2,1,1,  2,2,1,1,1,4,  4,1,3,1,1,1,  2,4,1,1,1,2,  1,3,4,1,1,1,  // 75..79
  1,1,1,2,4,2,  1,2,1,1,4,2,  1,2,1,2,4,1,  1,1,4,2,1,2,  1,2,4,1,1,2,  // 80..84
  1,2,4,2,1,1,  4,1,1,2,1,2,  4,2,1,1,1,2,  4,2,1,2,1,1,  2,1,2,1,4,1,  // 85..89
  2,1,4,1,2,1,  4,1,2,1,2,1,  1,1,1,1,4,3,  1,1,1,3,4,1,  1,3,1,1,4,1,  // 90..94
  1,1,4,1,1,3,  1,1,4,3,1,1,  4,1,1,1,1,3,  4,1,1,3,1,1,  1,1,3,1,4,1,  // 95..99
  1,1,4,1,3,1,  3,1,1,1,4,1,  4,1,1,1,3,1,  2,1,1,4,1,2,  2,1,1,2,1,4,  // 100..104
  2,1,1,2,3,2,                                                           // 105 (Start C)
]);

/** Stop pattern (symbol 106): 7 runs summing to 13 modules (bar, space, bar, space, bar, space, bar). */
export const CODE128_STOP_PATTERN = new Uint8Array([2, 3, 3, 1, 1, 1, 2]);

/**
 * Verifies ISO/IEC 15417 structural invariants of CODE128_PATTERNS:
 * - 106 unique 6-run symbols
 * - Each symbol sums to 11 modules with even bar sum and odd space sum
 * - Stop symbol sums to 13 modules
 */
export function verifyCode128Table() {
  if (CODE128_PATTERNS.length !== 106 * 6) {
    throw new Error(`Invalid CODE128_PATTERNS length: ${CODE128_PATTERNS.length}`);
  }
  const seen = new Set();
  for (let code = 0; code < 106; code++) {
    const base = code * 6;
    const b0 = CODE128_PATTERNS[base];
    const s0 = CODE128_PATTERNS[base + 1];
    const b1 = CODE128_PATTERNS[base + 2];
    const s1 = CODE128_PATTERNS[base + 3];
    const b2 = CODE128_PATTERNS[base + 4];
    const s2 = CODE128_PATTERNS[base + 5];
    const barSum = b0 + b1 + b2;
    const spaceSum = s0 + s1 + s2;
    if (barSum + spaceSum !== 11 || (barSum & 1) !== 0 || (spaceSum & 1) !== 1) {
      throw new Error(`Code 128 pattern parity/sum failure at symbol ${code}`);
    }
    const key = `${b0}${s0}${b1}${s1}${b2}${s2}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate Code 128 pattern ${key} at symbol ${code}`);
    }
    seen.add(key);
  }
  let stopSum = 0;
  for (let i = 0; i < CODE128_STOP_PATTERN.length; i++) stopSum += CODE128_STOP_PATTERN[i];
  if (stopSum !== 13) {
    throw new Error(`Invalid Code 128 stop pattern sum: ${stopSum}`);
  }
  return true;
}

/**
 * Encodes a payload into an exact ISO/IEC 15417 Code 128 binary module stream.
 * Each byte in `modules` is 1 (dark bar) or 0 (light space / quiet zone).
 *
 * @param {string} payload
 * @param {{ subset?: 'B' | 'C', quietZoneModules?: number }} [opts]
 */
export function encodeCode128(payload, opts = {}) {
  const subset = opts.subset || 'B';
  const quietZoneModules = opts.quietZoneModules ?? 10;
  if (quietZoneModules < 10) {
    throw new Error('Code 128 requires at least 10 quiet-zone modules on each side');
  }

  /** @type {number[]} */
  const symbols = [];
  if (subset === 'C') {
    if (payload.length === 0 || (payload.length & 1) !== 0 || !/^\d+$/.test(payload)) {
      throw new Error(`Code 128C requires an even-length numeric string, got "${payload}"`);
    }
    symbols.push(CODE128_START_C);
    for (let i = 0; i < payload.length; i += 2) {
      const val = (payload.charCodeAt(i) - 48) * 10 + (payload.charCodeAt(i + 1) - 48);
      symbols.push(val);
    }
  } else if (subset === 'B') {
    if (payload.length === 0) {
      throw new Error('Code 128B requires a non-empty payload');
    }
    symbols.push(CODE128_START_B);
    for (let i = 0; i < payload.length; i++) {
      const ch = payload.charCodeAt(i);
      if (ch < 32 || ch > 126) {
        throw new Error(`Unsupported Code 128B character code ${ch} in "${payload}"`);
      }
      symbols.push(ch - 32);
    }
  } else {
    throw new Error(`Unsupported Code 128 subset "${subset}"`);
  }

  // Modulo 103 check symbol: Start + sum_{i=1..N}(i * symbol[i]) mod 103
  let checksum = symbols[0];
  for (let i = 1; i < symbols.length; i++) {
    checksum += i * symbols[i];
  }
  const checkSymbol = checksum % 103;
  symbols.push(checkSymbol);

  const dataModules = symbols.length * 11 + 13;
  const totalModules = quietZoneModules * 2 + dataModules;
  const modules = new Uint8Array(totalModules);

  let cursor = quietZoneModules;
  for (let s = 0; s < symbols.length; s++) {
    const base = symbols[s] * 6;
    for (let r = 0; r < 6; r++) {
      const runLen = CODE128_PATTERNS[base + r];
      const isBar = (r & 1) === 0 ? 1 : 0;
      for (let k = 0; k < runLen; k++) {
        modules[cursor++] = isBar;
      }
    }
  }
  for (let r = 0; r < 7; r++) {
    const runLen = CODE128_STOP_PATTERN[r];
    const isBar = (r & 1) === 0 ? 1 : 0;
    for (let k = 0; k < runLen; k++) {
      modules[cursor++] = isBar;
    }
  }

  return {
    subset,
    payload,
    symbols: Uint8Array.from(symbols),
    checkSymbol,
    quietZoneModules,
    dataModules,
    totalModules,
    modules,
  };
}

/**
 * Exact clean-bitstream round-trip verifier for synthetic Code 128 module arrays.
 * Confirms generated ground truth is strictly decodable and passes Modulo 103.
 * @param {Uint8Array} modules
 * @param {number} quietZoneModules
 */
export function verifyEncodedCode128Modules(modules, quietZoneModules) {
  const startOffset = quietZoneModules;
  const bodyLen = modules.length - quietZoneModules * 2;
  if (bodyLen < 35 || (bodyLen - 13) % 11 !== 0) {
    throw new Error(`Invalid Code 128 body module count: ${bodyLen}`);
  }
  const symCount = (bodyLen - 13) / 11;
  const patternMap = new Map();
  for (let code = 0; code < 106; code++) {
    const base = code * 6;
    const key =
      `${CODE128_PATTERNS[base]}${CODE128_PATTERNS[base + 1]}` +
      `${CODE128_PATTERNS[base + 2]}${CODE128_PATTERNS[base + 3]}` +
      `${CODE128_PATTERNS[base + 4]}${CODE128_PATTERNS[base + 5]}`;
    patternMap.set(key, code);
  }

  const decodedSymbols = [];
  for (let s = 0; s < symCount; s++) {
    const segStart = startOffset + s * 11;
    let runStr = '';
    let idx = segStart;
    const segEnd = segStart + 11;
    let expect = 1;
    while (idx < segEnd) {
      let run = 0;
      while (idx < segEnd && modules[idx] === expect) {
        run++;
        idx++;
      }
      runStr += String(run);
      expect ^= 1;
    }
    const sym = patternMap.get(runStr);
    if (sym === undefined) {
      throw new Error(`Unrecognized 11-module symbol "${runStr}" at index ${s}`);
    }
    decodedSymbols.push(sym);
  }

  // Verify Stop pattern (13 modules)
  const stopStart = startOffset + symCount * 11;
  let stopStr = '';
  let idx = stopStart;
  let expect = 1;
  while (idx < stopStart + 13) {
    let run = 0;
    while (idx < stopStart + 13 && modules[idx] === expect) {
      run++;
      idx++;
    }
    stopStr += String(run);
    expect ^= 1;
  }
  if (stopStr !== '2331112') {
    throw new Error(`Invalid stop pattern "${stopStr}"`);
  }

  // Verify Modulo 103 checksum
  const checkExpected = decodedSymbols[decodedSymbols.length - 1];
  let sum = decodedSymbols[0];
  for (let i = 1; i < decodedSymbols.length - 1; i++) {
    sum += i * decodedSymbols[i];
  }
  if (sum % 103 !== checkExpected) {
    throw new Error(`Mod 103 mismatch: computed ${sum % 103}, encoded ${checkExpected}`);
  }

  // Reconstruct payload text
  const startSym = decodedSymbols[0];
  let text = '';
  if (startSym === CODE128_START_B) {
    for (let i = 1; i < decodedSymbols.length - 1; i++) {
      text += String.fromCharCode(decodedSymbols[i] + 32);
    }
  } else if (startSym === CODE128_START_C) {
    for (let i = 1; i < decodedSymbols.length - 1; i++) {
      const v = decodedSymbols[i];
      text += v < 10 ? `0${v}` : String(v);
    }
  } else {
    throw new Error(`Unexpected start symbol ${startSym}`);
  }
  return text;
}

// ============================================================================
// 3. 720p Synthetic Luma Image Synthesizer
// ============================================================================

function clampByte(v) {
  if (v < 0) return 0;
  if (v > 255) return 255;
  return (v + 0.5) | 0;
}

/**
 * Renders background textures/clutter into a 720p luma plane.
 * @param {Uint8Array} luma
 * @param {number} width
 * @param {number} height
 * @param {'flat' | 'gradient' | 'cluttered'} style
 * @param {number} baseLuma
 * @param {ReturnType<typeof createRng>} rng
 */
function renderBackground(luma, width, height, style, baseLuma, rng) {
  if (style === 'flat') {
    luma.fill(baseLuma);
    return;
  }

  const invW = 1 / width;
  const invH = 1 / height;
  for (let y = 0; y < height; y++) {
    const yn = y * invH;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const xn = x * invW;
      const v = baseLuma + (xn - 0.5) * 34 + (yn - 0.5) * 26;
      luma[rowOff + x] = clampByte(v);
    }
  }

  if (style === 'cluttered') {
    // Low-frequency packaging / desk boxes and non-periodic distractor blocks
    const boxCount = 14;
    for (let b = 0; b < boxCount; b++) {
      const bw = 60 + ((rng.next() * 210) | 0);
      const bh = 36 + ((rng.next() * 140) | 0);
      const bx = (rng.next() * (width - bw)) | 0;
      const by = (rng.next() * (height - bh)) | 0;
      const boxLuma = clampByte(70 + rng.next() * 125);
      const borderLuma = clampByte(boxLuma - 35);
      for (let y = by; y < by + bh; y++) {
        const rowOff = y * width;
        const isEdgeY = y < by + 2 || y >= by + bh - 2;
        for (let x = bx; x < bx + bw; x++) {
          const isEdgeX = x < bx + 2 || x >= bx + bw - 2;
          luma[rowOff + x] = isEdgeY || isEdgeX ? borderLuma : boxLuma;
        }
      }
    }
    // Simulated text-line blobs (low coherence, irregular spacing)
    for (let t = 0; t < 24; t++) {
      const tx = 40 + ((rng.next() * (width - 260)) | 0);
      const ty = 40 + ((rng.next() * (height - 80)) | 0);
      const glyphs = 6 + ((rng.next() * 12) | 0);
      let gx = tx;
      for (let g = 0; g < glyphs; g++) {
        const gw = 6 + ((rng.next() * 8) | 0);
        const gh = 10 + ((rng.next() * 6) | 0);
        const gl = clampByte(55 + rng.next() * 45);
        for (let y = ty; y < ty + gh && y < height; y++) {
          const rowOff = y * width;
          for (let x = gx; x < gx + gw && x < width; x++) {
            luma[rowOff + x] = gl;
          }
        }
        gx += gw + 4 + ((rng.next() * 5) | 0);
      }
    }
  }
}

/**
 * Stamps a rotated, anti-aliased (2x2 SSAA) Code 128 barcode onto the luma buffer
 * via inverse coordinate mapping (zero Moiré holes at arbitrary angles).
 */
function stampRotatedBarcode(luma, width, height, encoded, geom) {
  const {
    centerX,
    centerY,
    angleDeg,
    modulePx,
    barHeightPx,
    labelPadY = 22,
    barLumaLow = 24,
    barLumaHigh = 228,
  } = geom;

  const totalWidthPx = encoded.totalModules * modulePx;
  const halfW = totalWidthPx * 0.5;
  const halfBarH = barHeightPx * 0.5;
  const halfLabelH = halfBarH + labelPadY;

  const rad = (angleDeg * Math.PI) / 180;
  const cosT = Math.cos(rad);
  const sinT = Math.sin(rad);

  // Compute exact rotated bounding boxes (both full label and active bar region)
  const labelExtentX = Math.abs(halfW * cosT) + Math.abs(halfLabelH * sinT);
  const labelExtentY = Math.abs(halfW * sinT) + Math.abs(halfLabelH * cosT);

  const barHalfW = (encoded.dataModules * modulePx) * 0.5;
  const barExtentX = Math.abs(barHalfW * cosT) + Math.abs(halfBarH * sinT);
  const barExtentY = Math.abs(barHalfW * sinT) + Math.abs(halfBarH * cosT);

  const minX = Math.max(0, Math.floor(centerX - labelExtentX) - 1);
  const maxX = Math.min(width - 1, Math.ceil(centerX + labelExtentX) + 1);
  const minY = Math.max(0, Math.floor(centerY - labelExtentY) - 1);
  const maxY = Math.min(height - 1, Math.ceil(centerY + labelExtentY) + 1);

  const invModulePx = 1 / modulePx;
  const modules = encoded.modules;
  const totalModules = encoded.totalModules;

  // 2x2 sub-pixel offsets for anti-aliasing
  const ssOffsets = [-0.25, 0.25];

  for (let y = minY; y <= maxY; y++) {
    const rowOff = y * width;
    for (let x = minX; x <= maxX; x++) {
      let insideCount = 0;
      let accum = 0;
      for (let oy = 0; oy < 2; oy++) {
        const dy = y + ssOffsets[oy] - centerY;
        for (let ox = 0; ox < 2; ox++) {
          const dx = x + ssOffsets[ox] - centerX;
          const u = dx * cosT + dy * sinT;
          const v = -dx * sinT + dy * cosT;
          if (Math.abs(u) <= halfW && Math.abs(v) <= halfLabelH) {
            insideCount++;
            if (Math.abs(v) <= halfBarH) {
              const modIdx = Math.floor((u + halfW) * invModulePx);
              const isBar = modIdx >= 0 && modIdx < totalModules ? modules[modIdx] : 0;
              accum += isBar ? barLumaLow : barLumaHigh;
            } else {
              accum += barLumaHigh;
            }
          }
        }
      }
      if (insideCount === 4) {
        luma[rowOff + x] = (accum * 0.25 + 0.5) | 0;
      } else if (insideCount > 0) {
        const bg = luma[rowOff + x];
        const blended = (accum + bg * (4 - insideCount)) * 0.25;
        luma[rowOff + x] = (blended + 0.5) | 0;
      }
    }
  }

  return {
    labelBbox: {
      minX: Math.max(0, Math.floor(centerX - labelExtentX)),
      minY: Math.max(0, Math.floor(centerY - labelExtentY)),
      maxX: Math.min(width - 1, Math.ceil(centerX + labelExtentX)),
      maxY: Math.min(height - 1, Math.ceil(centerY + labelExtentY)),
    },
    bbox: {
      minX: Math.max(0, Math.floor(centerX - barExtentX)),
      minY: Math.max(0, Math.floor(centerY - barExtentY)),
      maxX: Math.min(width - 1, Math.ceil(centerX + barExtentX)),
      maxY: Math.min(height - 1, Math.ceil(centerY + barExtentY)),
    },
  };
}

/**
 * Applies a smooth uneven shadow illumination gradient across the frame.
 * Designed so global Otsu fails while local derivative edge extraction succeeds.
 */
function applyShadowGradient(luma, width, height, opts) {
  const { minGain = 0.30, maxGain = 1.06, angleDeg = 18 } = opts;
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const cx = width * 0.5;
  const cy = height * 0.5;
  const span = Math.abs(cx * cosA) + Math.abs(cy * sinA);
  const invSpan = span > 0 ? 1 / (2 * span) : 0;
  const gainRange = maxGain - minGain;

  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const proj = (x - cx) * cosA + dy * sinA;
      let t = proj * invSpan + 0.5;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      // Smoothstep for natural shadow falloff
      const s = t * t * (3 - 2 * t);
      const gain = minGain + gainRange * s;
      luma[rowOff + x] = clampByte(luma[rowOff + x] * gain);
    }
  }
}

/**
 * Applies a localized additive 2D Gaussian specular glare hotspot.
 */
function applyGlareSpot(luma, width, height, opts) {
  const { cx, cy, radius = 95, intensity = 160 } = opts;
  const invTwoSigma2 = 1 / (2 * radius * radius);
  const r3 = Math.ceil(radius * 3);
  const minX = Math.max(0, (cx - r3) | 0);
  const maxX = Math.min(width - 1, (cx + r3) | 0);
  const minY = Math.max(0, (cy - r3) | 0);
  const maxY = Math.min(height - 1, (cy + r3) | 0);

  for (let y = minY; y <= maxY; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const rowOff = y * width;
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const add = intensity * Math.exp(-(dx * dx + dy2) * invTwoSigma2);
      luma[rowOff + x] = clampByte(luma[rowOff + x] + add);
    }
  }
}

/**
 * Applies mild directional 1D motion blur using a pre-allocated scratch plane.
 */
function applyMotionBlur(luma, scratch, width, height, opts) {
  const { lengthPx = 4, angleDeg = 0 } = opts;
  const taps = Math.max(3, (lengthPx | 0) | 1); // odd tap count >= 3
  const half = (taps - 1) >> 1;
  const rad = (angleDeg * Math.PI) / 180;
  const dxStep = Math.cos(rad);
  const dyStep = Math.sin(rad);

  const offsetsX = new Float32Array(taps);
  const offsetsY = new Float32Array(taps);
  const weights = new Float32Array(taps);
  let weightSum = 0;
  for (let i = 0; i < taps; i++) {
    const k = i - half;
    offsetsX[i] = k * dxStep;
    offsetsY[i] = k * dyStep;
    // Slight triangular weighting for realistic shutter integration
    const w = half + 1 - Math.abs(k) * 0.35;
    weights[i] = w;
    weightSum += w;
  }
  for (let i = 0; i < taps; i++) weights[i] /= weightSum;

  const maxX = width - 1;
  const maxY = height - 1;
  for (let y = 0; y < height; y++) {
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let t = 0; t < taps; t++) {
        let sx = (x + offsetsX[t] + 0.5) | 0;
        let sy = (y + offsetsY[t] + 0.5) | 0;
        if (sx < 0) sx = 0;
        else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0;
        else if (sy > maxY) sy = maxY;
        acc += luma[sy * width + sx] * weights[t];
      }
      scratch[rowOff + x] = (acc + 0.5) | 0;
    }
  }
  luma.set(scratch);
}

/**
 * Adds deterministic zero-mean Gaussian camera sensor read noise.
 */
function applySensorNoise(luma, sigma, rng) {
  if (sigma <= 0) return;
  for (let i = 0; i < luma.length; i++) {
    luma[i] = clampByte(luma[i] + rng.nextGaussian() * sigma);
  }
}

/**
 * Synthesizes a complete 1280x720 synthetic fixture with immutable ground truth.
 * @param {object} spec
 * @param {Uint8Array} [blurScratch]
 */
export function synthesizeFixture(spec, blurScratch) {
  const width = spec.width ?? FRAME_WIDTH;
  const height = spec.height ?? FRAME_HEIGHT;
  const luma = new Uint8Array(width * height);
  const rng = createRng(spec.seed ?? 1337);

  renderBackground(
    luma,
    width,
    height,
    spec.background ?? 'gradient',
    spec.bgLuma ?? 168,
    rng
  );

  let encoded = null;
  let bbox = null;
  let labelBbox = null;

  if (spec.symbology === 'CODE_128') {
    encoded = encodeCode128(spec.payload, {
      subset: spec.subset ?? 'B',
      quietZoneModules: spec.quietZoneModules ?? 10,
    });
    // Self-check every generated ground-truth Code 128 bitstream
    const roundTrip = verifyEncodedCode128Modules(encoded.modules, encoded.quietZoneModules);
    if (roundTrip !== spec.payload) {
      throw new Error(
        `Fixture "${spec.id}" Code 128 round-trip mismatch: expected "${spec.payload}", got "${roundTrip}"`
      );
    }
    const stamped = stampRotatedBarcode(luma, width, height, encoded, {
      centerX: spec.centerX ?? width * 0.5,
      centerY: spec.centerY ?? height * 0.5,
      angleDeg: spec.angleDeg ?? 0,
      modulePx: spec.modulePx ?? 3.0,
      barHeightPx: spec.barHeightPx ?? 148,
      labelPadY: spec.labelPadY ?? 22,
      barLumaLow: spec.barLumaLow ?? 24,
      barLumaHigh: spec.barLumaHigh ?? 228,
    });
    bbox = stamped.bbox;
    labelBbox = stamped.labelBbox;
  }

  if (spec.shadowGradient) {
    applyShadowGradient(luma, width, height, spec.shadowGradient);
  }
  if (spec.glareSpot) {
    applyGlareSpot(luma, width, height, spec.glareSpot);
  }
  if (spec.motionBlur) {
    const scratch = blurScratch && blurScratch.length === luma.length
      ? blurScratch
      : new Uint8Array(luma.length);
    applyMotionBlur(luma, scratch, width, height, spec.motionBlur);
  }
  if (spec.noiseSigma) {
    applySensorNoise(luma, spec.noiseSigma, rng);
  }

  return {
    id: spec.id,
    source: 'synthetic',
    symbology: spec.symbology,
    symbologyId: spec.symbology === 'CODE_128' ? SYMBOLOGY_CODE_128 : SYMBOLOGY_NONE,
    subset: spec.subset ?? null,
    payload: spec.payload ?? null,
    width,
    height,
    angleDeg: spec.symbology === 'CODE_128' ? (((spec.angleDeg ?? 0) % 180) + 180) % 180 : null,
    centerX: spec.symbology === 'CODE_128' ? (spec.centerX ?? width * 0.5) : null,
    centerY: spec.symbology === 'CODE_128' ? (spec.centerY ?? height * 0.5) : null,
    modulePx: spec.modulePx ?? null,
    barHeightPx: spec.barHeightPx ?? null,
    totalModules: encoded ? encoded.totalModules : 0,
    bbox,
    labelBbox,
    distortions: {
      background: spec.background ?? 'gradient',
      shadowGradient: spec.shadowGradient ?? null,
      glareSpot: spec.glareSpot ?? null,
      motionBlur: spec.motionBlur ?? null,
      noiseSigma: spec.noiseSigma ?? 0,
    },
    luma,
  };
}

/**
 * Synthesizes a realistic multi-carton U-boat grid fixture (e.g. 4x4 = 16 or 2x2 = 4
 * vertical Code 128 labels) with cardboard carton borders, uneven per-carton shading,
 * diagonal warehouse shadow gradients, specular glare hotspots, mild skew & sensor noise.
 */
export function synthesizeGridFixture(spec) {
  const width = spec.width ?? 1920;
  const height = spec.height ?? 1080;
  const rows = spec.rows ?? 4;
  const cols = spec.cols ?? 4;
  const baseAngleDeg = spec.angleDeg ?? 90; // 90° = vertical barcodes (horizontal bars)
  const subset = spec.subset ?? 'C';
  const skewMaxDeg = spec.skewMaxDeg ?? 3.5;
  const rng = createRng(spec.seed ?? 7701);

  const luma = new Uint8Array(width * height);
  renderBackground(luma, width, height, 'gradient', 124, rng);

  const padX = Math.round(width * 0.03);
  const padY = Math.round(height * 0.025);
  const cellW = (width - padX * 2) / cols;
  const cellH = (height - padY * 2) / rows;
  const gap = Math.max(6, Math.round(Math.min(cellW, cellH) * 0.04));

  const items = [];
  let idx = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, idx++) {
      const x0 = Math.round(padX + c * cellW + gap * 0.5);
      const y0 = Math.round(padY + r * cellH + gap * 0.5);
      const x1 = Math.round(padX + (c + 1) * cellW - gap * 0.5);
      const y1 = Math.round(padY + (r + 1) * cellH - gap * 0.5);

      // Draw cardboard carton face with slight per-box shade variation
      const boxBase = clampByte(115 + (rng.next() - 0.5) * 34);
      const seamLuma = clampByte(boxBase - 42);
      for (let y = y0; y <= y1 && y < height; y++) {
        const rowOff = y * width;
        const isBorderY = y <= y0 + 2 || y >= y1 - 2;
        for (let x = x0; x <= x1 && x < width; x++) {
          const isBorderX = x <= x0 + 2 || x >= x1 - 2;
          luma[rowOff + x] = (isBorderY || isBorderX) ? seamLuma : boxBase;
        }
      }

      const payload = subset === 'C'
        ? `8800${String(r + 1).padStart(2, '0')}${String(c + 1).padStart(2, '0')}` // 8-digit Code 128C
        : `UB-${r + 1}X${c + 1}-${String(idx + 1).padStart(2, '0')}`;            // 8-char Code 128B

      const encoded = encodeCode128(payload, { subset, quietZoneModules: 10 });

      const isVertical = Math.abs((((baseAngleDeg % 180) + 180) % 180) - 90) < 45;
      const availMajor = (isVertical ? (y1 - y0) : (x1 - x0)) * 0.88;
      const availMinor = (isVertical ? (x1 - x0) : (y1 - y0)) * 0.44;
      const modulePx = spec.modulePx ?? Math.max(1.4, availMajor / encoded.totalModules);
      const barHeightPx = spec.barHeightPx ?? Math.max(44, Math.min(180, availMinor));
      const skew = (rng.next() * 2 - 1) * skewMaxDeg;
      const angleDeg = baseAngleDeg + skew;

      // Vary per-label ink contrast & paper brightness (simulates mixed thermal printers & shadows)
      const labelHigh = clampByte(200 + rng.next() * 35);
      const labelLow = clampByte(18 + rng.next() * 34);

      const cx = (x0 + x1) * 0.5 + (rng.next() - 0.5) * (cellW * 0.08);
      const cy = (y0 + y1) * 0.5 + (rng.next() - 0.5) * (cellH * 0.04);

      const stamped = stampRotatedBarcode(luma, width, height, encoded, {
        centerX: cx,
        centerY: cy,
        angleDeg,
        modulePx,
        barHeightPx,
        labelPadY: Math.max(8, Math.round(barHeightPx * 0.14)),
        barLumaLow: labelLow,
        barLumaHigh: labelHigh,
      });

      items.push({
        row: r,
        col: c,
        payload,
        angleDeg: (((angleDeg % 180) + 180) % 180),
        modulePx,
        barHeightPx,
        bbox: stamped.bbox,
      });
    }
  }

  // Global warehouse shading issues: overhead shadow falloff + localized glare spots + blur + noise
  if (spec.shadowGradient) {
    applyShadowGradient(luma, width, height, spec.shadowGradient);
  }
  if (Array.isArray(spec.glareSpots)) {
    for (const g of spec.glareSpots) {
      applyGlareSpot(luma, width, height, g);
    }
  }
  if (spec.motionBlur) {
    const scratch = new Uint8Array(luma.length);
    applyMotionBlur(luma, scratch, width, height, spec.motionBlur);
  }
  if (spec.noiseSigma) {
    applySensorNoise(luma, spec.noiseSigma, rng);
  }

  return {
    id: spec.id,
    source: 'synthetic-grid',
    rows,
    cols,
    width,
    height,
    items,
    luma,
  };
}

export const UBOAT_GRID_SPECS = [
  {
    id: 'uboat_4x4_vert_1080p_shaded',
    seed: 7701,
    width: 1920,
    height: 1080,
    rows: 4,
    cols: 4,
    angleDeg: 90,
    subset: 'C',
    skewMaxDeg: 3.5,
    shadowGradient: { minGain: 0.34, maxGain: 1.06, angleDeg: 55 },
    glareSpots: [
      { cx: 520, cy: 310, radius: 95, intensity: 115 },
      { cx: 1460, cy: 760, radius: 85, intensity: 105 },
    ],
    noiseSigma: 4.5,
  },
  {
    id: 'uboat_4x4_vert_portrait_1080x1920_shaded',
    seed: 7702,
    width: 1080,
    height: 1920,
    rows: 4,
    cols: 4,
    angleDeg: 90,
    subset: 'C',
    skewMaxDeg: 3.5,
    shadowGradient: { minGain: 0.34, maxGain: 1.06, angleDeg: 62 },
    glareSpots: [
      { cx: 310, cy: 520, radius: 90, intensity: 115 },
      { cx: 790, cy: 1380, radius: 90, intensity: 105 },
    ],
    noiseSigma: 4.5,
  },
  {
    id: 'uboat_4x4_vert_720p_shaded',
    seed: 7703,
    width: 1280,
    height: 720,
    rows: 4,
    cols: 4,
    angleDeg: 90,
    subset: 'C',
    skewMaxDeg: 3.0,
    shadowGradient: { minGain: 0.36, maxGain: 1.05, angleDeg: 55 },
    glareSpots: [{ cx: 340, cy: 200, radius: 65, intensity: 105 }],
    noiseSigma: 4.0,
  },
  {
    id: 'uboat_2x2_vert_720p_fallback_hard',
    seed: 7704,
    width: 1280,
    height: 720,
    rows: 2,
    cols: 2,
    angleDeg: 90,
    subset: 'C',
    skewMaxDeg: 5.0,
    shadowGradient: { minGain: 0.30, maxGain: 1.06, angleDeg: 48 },
    glareSpots: [{ cx: 880, cy: 220, radius: 85, intensity: 130 }],
    motionBlur: { lengthPx: 3, angleDeg: 15 },
    noiseSigma: 5.0,
  },
  {
    id: 'uboat_2x2_vert_1080p_fallback_hard',
    seed: 7705,
    width: 1920,
    height: 1080,
    rows: 2,
    cols: 2,
    angleDeg: 90,
    subset: 'B',
    skewMaxDeg: 5.0,
    shadowGradient: { minGain: 0.30, maxGain: 1.06, angleDeg: 48 },
    glareSpots: [{ cx: 1340, cy: 310, radius: 110, intensity: 135 }],
    motionBlur: { lengthPx: 3, angleDeg: 20 },
    noiseSigma: 5.0,
  },
];

// ============================================================================
// 4. Zero-Dependency PGM (P5) & Raw-Y Real Fixture Loader / Exporter
// ============================================================================

/**
 * Parses a binary P5 Portable GrayMap (.pgm) Uint8Array into { width, height, luma }.
 * @param {Uint8Array} bytes
 */
export function parsePGM(bytes) {
  let offset = 0;
  const len = bytes.length;

  function readToken() {
    while (offset < len) {
      const c = bytes[offset];
      if (c === 35) { // '#' comment line
        while (offset < len && bytes[offset] !== 10) offset++;
      } else if (c === 32 || c === 9 || c === 10 || c === 13) {
        offset++;
      } else {
        break;
      }
    }
    const start = offset;
    while (offset < len) {
      const c = bytes[offset];
      if (c === 32 || c === 9 || c === 10 || c === 13 || c === 35) break;
      offset++;
    }
    let tok = '';
    for (let i = start; i < offset; i++) tok += String.fromCharCode(bytes[i]);
    return tok;
  }

  const magic = readToken();
  if (magic !== 'P5') {
    throw new Error(`Unsupported PGM format "${magic}" (expected binary P5)`);
  }
  const width = Number.parseInt(readToken(), 10);
  const height = Number.parseInt(readToken(), 10);
  const maxVal = Number.parseInt(readToken(), 10);
  if (!(width > 0) || !(height > 0) || maxVal !== 255) {
    throw new Error(`Invalid PGM header: ${width}x${height} maxVal=${maxVal}`);
  }
  // Consume single whitespace delimiter after maxVal
  if (offset < len && (bytes[offset] === 10 || bytes[offset] === 13 || bytes[offset] === 32 || bytes[offset] === 9)) {
    offset++;
  }
  const pixelCount = width * height;
  if (bytes.length - offset < pixelCount) {
    throw new Error(`Truncated PGM payload: expected ${pixelCount} bytes, got ${bytes.length - offset}`);
  }
  const luma = new Uint8Array(pixelCount);
  luma.set(bytes.subarray(offset, offset + pixelCount));
  return { width, height, luma };
}

/**
 * Serializes a grayscale luma plane into a binary P5 PGM Uint8Array.
 * @param {Uint8Array} luma
 * @param {number} width
 * @param {number} height
 */
export function encodePGM(luma, width, height) {
  const headerStr = `P5\n${width} ${height}\n255\n`;
  const out = new Uint8Array(headerStr.length + width * height);
  for (let i = 0; i < headerStr.length; i++) {
    out[i] = headerStr.charCodeAt(i);
  }
  out.set(luma.subarray(0, width * height), headerStr.length);
  return out;
}

/**
 * Loads optional real-world 720p captures listed in `<fixturesDir>/manifest.json`.
 * Uses dynamic Node imports so this module remains 100% browser-importable.
 * @param {string} fixturesDir
 */
export async function loadRealFixtures(fixturesDir) {
  if (typeof process === 'undefined' || !process.versions?.node) {
    return [];
  }
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const manifestPath = path.join(fixturesDir, 'manifest.json');

  let rawManifest;
  try {
    rawManifest = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }

  const entries = JSON.parse(rawManifest);
  if (!Array.isArray(entries)) {
    throw new Error(`Invalid manifest at ${manifestPath}: expected JSON array`);
  }

  const loaded = [];
  for (const entry of entries) {
    const filePath = path.join(fixturesDir, entry.file);
    const fileBytes = new Uint8Array(await fs.readFile(filePath));
    let width = entry.width ?? FRAME_WIDTH;
    let height = entry.height ?? FRAME_HEIGHT;
    let luma;

    const fmt = entry.format ?? (entry.file.toLowerCase().endsWith('.pgm') ? 'pgm' : 'raw-y');
    if (fmt === 'pgm') {
      const parsed = parsePGM(fileBytes);
      width = parsed.width;
      height = parsed.height;
      luma = parsed.luma;
    } else if (fmt === 'raw-y') {
      const expected = width * height;
      if (fileBytes.length < expected) {
        throw new Error(`Raw-Y fixture ${entry.file} too short: ${fileBytes.length} < ${expected}`);
      }
      luma = new Uint8Array(expected);
      luma.set(fileBytes.subarray(0, expected));
    } else {
      throw new Error(`Unsupported real fixture format "${fmt}" in ${entry.file}`);
    }

    loaded.push({
      id: entry.id,
      source: 'real',
      symbology: entry.symbology ?? 'CODE_128',
      symbologyId: entry.symbology === 'NONE' ? SYMBOLOGY_NONE : SYMBOLOGY_CODE_128,
      subset: entry.subset ?? null,
      payload: entry.payload ?? null,
      width,
      height,
      angleDeg: entry.angleDeg ?? null,
      centerX: entry.centerX ?? null,
      centerY: entry.centerY ?? null,
      modulePx: entry.modulePx ?? null,
      barHeightPx: entry.barHeightPx ?? null,
      totalModules: 0,
      bbox: entry.bbox ?? null,
      labelBbox: null,
      distortions: { realCapture: true },
      luma,
    });
  }
  return loaded;
}

// ============================================================================
// 5. Canonical Code 128 720p Synthetic Test Matrix
// ============================================================================

export const SYNTHETIC_CODE128_SPECS = [
  // Core rotation sweep (0°, 15°, 37°, 90°, 143°) — Code 128B & 128C
  {
    id: 'c128b_0deg_clean',
    seed: 1001,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'AGY-100MS-00',
    angleDeg: 0,
    modulePx: 3.0,
    barHeightPx: 150,
    background: 'gradient',
  },
  {
    id: 'c128b_15deg_clean',
    seed: 1002,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'SCAN-FAST-15',
    angleDeg: 15,
    modulePx: 3.0,
    barHeightPx: 150,
    background: 'gradient',
  },
  {
    id: 'c128b_37deg_clean',
    seed: 1003,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'TILT-37-DEG',
    angleDeg: 37,
    modulePx: 3.0,
    barHeightPx: 150,
    background: 'gradient',
  },
  {
    id: 'c128b_90deg_clean',
    seed: 1004,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'VERTICAL-90',
    angleDeg: 90,
    modulePx: 2.8,
    barHeightPx: 150,
    background: 'gradient',
  },
  {
    id: 'c128b_143deg_clean',
    seed: 1005,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'OBTUSE-143',
    angleDeg: 143,
    modulePx: 3.0,
    barHeightPx: 145,
    background: 'gradient',
  },
  {
    id: 'c128b_217deg_upside_down',
    seed: 1008,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'REVERSE-217',
    angleDeg: 217,
    modulePx: 3.0,
    barHeightPx: 150,
    background: 'gradient',
    noiseSigma: 3.5,
  },
  {
    id: 'c128c_0deg_clean',
    seed: 1006,
    symbology: 'CODE_128',
    subset: 'C',
    payload: '00123456789012',
    angleDeg: 0,
    modulePx: 3.2,
    barHeightPx: 150,
    background: 'flat',
    bgLuma: 180,
  },
  {
    id: 'c128c_37deg_clean',
    seed: 1007,
    symbology: 'CODE_128',
    subset: 'C',
    payload: '98765432109876',
    angleDeg: 37,
    modulePx: 3.2,
    barHeightPx: 150,
    background: 'gradient',
  },

  // Uneven shadow gradients & localized specular glare
  {
    id: 'c128b_37deg_shadow',
    seed: 2001,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'SHADOW-GRAD-37',
    angleDeg: 37,
    modulePx: 2.8,
    barHeightPx: 150,
    background: 'gradient',
    shadowGradient: { minGain: 0.30, maxGain: 1.06, angleDeg: 28 },
    noiseSigma: 3.5,
  },
  {
    id: 'c128c_15deg_shadow_glare',
    seed: 2002,
    symbology: 'CODE_128',
    subset: 'C',
    payload: '42009911882277',
    angleDeg: 15,
    centerX: 640,
    centerY: 360,
    modulePx: 3.0,
    barHeightPx: 156,
    background: 'gradient',
    shadowGradient: { minGain: 0.36, maxGain: 1.04, angleDeg: -12 },
    glareSpot: { cx: 740, cy: 315, radius: 72, intensity: 145 },
    noiseSigma: 3.0,
  },

  // Mild directional motion blur & sensor noise
  {
    id: 'c128b_15deg_blur_noise',
    seed: 3001,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'BLUR-15-NOISE',
    angleDeg: 15,
    modulePx: 3.0,
    barHeightPx: 150,
    background: 'gradient',
    motionBlur: { lengthPx: 5, angleDeg: 15 },
    noiseSigma: 6.0,
  },
  {
    id: 'c128b_37deg_shadow_blur_noise',
    seed: 3002,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'COMBO-37-HARD',
    angleDeg: 37,
    modulePx: 3.0,
    barHeightPx: 155,
    background: 'gradient',
    shadowGradient: { minGain: 0.34, maxGain: 1.05, angleDeg: 40 },
    motionBlur: { lengthPx: 4, angleDeg: 25 },
    noiseSigma: 5.5,
  },
  {
    id: 'c128b_90deg_shadow_blur',
    seed: 3003,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'VERT-90-BLUR',
    angleDeg: 90,
    modulePx: 2.8,
    barHeightPx: 150,
    background: 'gradient',
    shadowGradient: { minGain: 0.35, maxGain: 1.05, angleDeg: 85 },
    motionBlur: { lengthPx: 3, angleDeg: 90 },
    noiseSigma: 4.0,
  },

  // Off-center small scale + cluttered background distractors
  {
    id: 'c128b_22deg_small_offcenter_clutter',
    seed: 4001,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'SMALL-OFF-22',
    angleDeg: 22,
    centerX: 880,
    centerY: 470,
    modulePx: 2.2,
    barHeightPx: 112,
    background: 'cluttered',
    bgLuma: 155,
    shadowGradient: { minGain: 0.55, maxGain: 1.02, angleDeg: 10 },
    noiseSigma: 4.5,
  },

  // Negative controls (no barcode -> must emit 0 false positives & bound worst-case fallback time)
  {
    id: 'neg_blank_gradient',
    seed: 9001,
    symbology: 'NONE',
    background: 'gradient',
    bgLuma: 165,
    shadowGradient: { minGain: 0.40, maxGain: 1.05, angleDeg: 20 },
    noiseSigma: 4.0,
  },
  {
    id: 'neg_cluttered_distractors',
    seed: 9002,
    symbology: 'NONE',
    background: 'cluttered',
    bgLuma: 150,
    noiseSigma: 5.0,
  },
];

/**
 * Generates the full canonical 720p Code 128 synthetic test matrix.
 */
export function buildSyntheticTestMatrix(specs = SYNTHETIC_CODE128_SPECS) {
  verifyCode128Table();
  const blurScratch = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  const fixtures = new Array(specs.length);
  for (let i = 0; i < specs.length; i++) {
    fixtures[i] = synthesizeFixture(specs[i], blurScratch);
  }
  return fixtures;
}

// ============================================================================
// 6. Zero-Allocation Pipeline Contract, Profiler & Phase 1 Baseline
// ============================================================================

/**
 * Allocates the single reusable ScanResult struct mutated in-place per frame.
 * Zero heap allocations occur inside hot loops using this contract.
 */
export function createScanResult() {
  return {
    detected: 0,
    roiX: 0,
    roiY: 0,
    roiW: 0,
    roiH: 0,
    roiCenterX: 0,
    roiCenterY: 0,
    roiMajorLen: 0,
    roiMinorLen: 0,
    roiConfidence: 0,
    thetaDeg: 0,
    consensusCount: 0,
    symbologyId: SYMBOLOGY_NONE,
    payloadLen: 0,
    payloadBytes: new Uint8Array(128),
    tRoiMs: 0,
    tScanMs: 0,
    tDecodeMs: 0,
    tTotalMs: 0,
  };
}

/**
 * Resets a pre-allocated ScanResult struct in-place (zero allocations).
 */
export function resetScanResult(result) {
  result.detected = 0;
  result.roiX = 0;
  result.roiY = 0;
  result.roiW = 0;
  result.roiH = 0;
  result.roiCenterX = 0;
  result.roiCenterY = 0;
  result.roiMajorLen = 0;
  result.roiMinorLen = 0;
  result.roiConfidence = 0;
  result.thetaDeg = 0;
  result.consensusCount = 0;
  result.symbologyId = SYMBOLOGY_NONE;
  result.payloadLen = 0;
  result.tRoiMs = 0;
  result.tScanMs = 0;
  result.tDecodeMs = 0;
  result.tTotalMs = 0;
}

/**
 * Pre-allocated scratch state for Phase 1 baseline 4x downscale microbenchmark
 * (1280x720 -> 320x180 integer box downsample + checksum accumulator).
 */
export function createBaselineState(width = FRAME_WIDTH, height = FRAME_HEIGHT) {
  const dsW = width >> 2;
  const dsH = height >> 2;
  return {
    width,
    height,
    dsW,
    dsH,
    downsampled: new Uint8Array(dsW * dsH),
    sink: 0,
  };
}

/**
 * Zero-allocation 32-bit integer 4x4 box downscaler (1280x720 -> 320x180).
 * Establishes baseline 720p memory-pass performance before Phase 2 adds Gx/Gy + Structure Tensor.
 */
export function runBaselineDownsample4x(luma, width, height, state, result) {
  const dsW = state.dsW | 0;
  const dsH = state.dsH | 0;
  const dst = state.downsampled;
  const w = width | 0;
  const w2 = (w << 1) | 0;
  const w3 = (w2 + w) | 0;

  let dstIdx = 0;
  let checksum = 0;
  for (let dy = 0; dy < dsH; dy++) {
    const row0 = ((dy << 2) * w) | 0;
    const row1 = (row0 + w) | 0;
    const row2 = (row0 + w2) | 0;
    const row3 = (row0 + w3) | 0;
    for (let dx = 0; dx < dsW; dx++) {
      const sx = (dx << 2) | 0;
      const sum =
        (luma[row0 + sx] + luma[row0 + sx + 1] + luma[row0 + sx + 2] + luma[row0 + sx + 3] +
         luma[row1 + sx] + luma[row1 + sx + 1] + luma[row1 + sx + 2] + luma[row1 + sx + 3] +
         luma[row2 + sx] + luma[row2 + sx + 1] + luma[row2 + sx + 2] + luma[row2 + sx + 3] +
         luma[row3 + sx] + luma[row3 + sx + 1] + luma[row3 + sx + 2] + luma[row3 + sx + 3]) | 0;
      const avg = (sum + 8) >> 4;
      dst[dstIdx++] = avg;
      checksum = (checksum + avg) | 0;
    }
  }
  state.sink = checksum;
  result.detected = 0;
  result.roiX = 0;
  result.roiY = 0;
  result.roiW = width;
  result.roiH = height;
}

function nowMs() {
  return performance.now();
}

/**
 * Computes timing percentiles in-place from a Float64Array of sample durations.
 * @param {Float64Array} samples
 */
export function summarizeTimings(samples) {
  const n = samples.length;
  if (n === 0) {
    return { count: 0, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  let sum = 0;
  for (let i = 0; i < n; i++) sum += samples[i];
  samples.sort();
  const at = (p) => {
    const idx = Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))));
    return samples[idx];
  };
  return {
    count: n,
    min: samples[0],
    mean: sum / n,
    p50: at(0.50),
    p95: at(0.95),
    p99: at(0.99),
    max: samples[n - 1],
  };
}

/**
 * Runs a warm-up + zero-allocation measured benchmark loop across all fixtures.
 * Also audits V8 heap growth in Node.js to catch hot-loop allocations early.
 *
 * @param {Array<object>} fixtures
 * @param {(luma: Uint8Array, w: number, h: number, state: object, result: object) => void} processFn
 * @param {object} state
 * @param {{ warmupIters?: number, measureIters?: number }} [opts]
 */
export function profileFrameLoop(fixtures, processFn, state, opts = {}) {
  const warmupIters = opts.warmupIters ?? 25;
  const measureIters = opts.measureIters ?? 50;
  const fixtureCount = fixtures.length;
  const totalMeasuredFrames = fixtureCount * measureIters;

  // Pre-allocate all timing & result buffers BEFORE entering hot loops
  const tTotalSamples = new Float64Array(totalMeasuredFrames);
  const tRoiSamples = new Float64Array(totalMeasuredFrames);
  const tScanSamples = new Float64Array(totalMeasuredFrames);
  const tDecodeSamples = new Float64Array(totalMeasuredFrames);
  const perFixtureSums = new Float64Array(fixtureCount);
  const result = createScanResult();

  // 1. JIT Warm-up phase (unmeasured)
  for (let w = 0; w < warmupIters; w++) {
    for (let f = 0; f < fixtureCount; f++) {
      const fx = fixtures[f];
      resetScanResult(result);
      processFn(fx.luma, fx.width, fx.height, state, result);
    }
  }

  // 2. Measured timing loop (strictly zero allocations in pipeline)
  let sampleIdx = 0;
  for (let iter = 0; iter < measureIters; iter++) {
    for (let f = 0; f < fixtureCount; f++) {
      const fx = fixtures[f];
      resetScanResult(result);
      const t0 = nowMs();
      processFn(fx.luma, fx.width, fx.height, state, result);
      const elapsed = nowMs() - t0;
      tTotalSamples[sampleIdx] = elapsed;
      tRoiSamples[sampleIdx] = result.tRoiMs;
      tScanSamples[sampleIdx] = result.tScanMs;
      tDecodeSamples[sampleIdx] = result.tDecodeMs;
      perFixtureSums[f] += elapsed;
      sampleIdx++;
    }
  }

  // 3. Dedicated untimed heap-allocation audit (isolates pipeline from timer overhead)
  const hasNodeMem = typeof process !== 'undefined' && typeof process.memoryUsage === 'function';
  let heapBefore = 0;
  let heapAfter = 0;
  let heapDeltaBytes = null;
  let auditFrames = 0;
  if (hasNodeMem) {
    const auditIters = Math.max(20, measureIters);
    auditFrames = auditIters * fixtureCount;
    if (typeof globalThis.gc === 'function') globalThis.gc();
    heapBefore = process.memoryUsage().heapUsed;
    for (let iter = 0; iter < auditIters; iter++) {
      for (let f = 0; f < fixtureCount; f++) {
        const fx = fixtures[f];
        resetScanResult(result);
        processFn(fx.luma, fx.width, fx.height, state, result);
      }
    }
    heapAfter = process.memoryUsage().heapUsed;
    heapDeltaBytes = heapAfter - heapBefore;
  }

  const perFixtureMeanMs = new Array(fixtureCount);
  for (let f = 0; f < fixtureCount; f++) {
    perFixtureMeanMs[f] = {
      id: fixtures[f].id,
      meanMs: perFixtureSums[f] / measureIters,
    };
  }

  return {
    totalMeasuredFrames,
    warmupFrames: warmupIters * fixtureCount,
    auditFrames,
    total: summarizeTimings(tTotalSamples),
    roi: summarizeTimings(tRoiSamples),
    scan: summarizeTimings(tScanSamples),
    decode: summarizeTimings(tDecodeSamples),
    perFixtureMeanMs,
    heapBeforeBytes: heapBefore,
    heapAfterBytes: heapAfter,
    heapDeltaBytes,
    bytesPerFrame: heapDeltaBytes !== null && auditFrames > 0 ? heapDeltaBytes / auditFrames : null,
  };
}

/**
 * Computes luma contrast sanity stats for a fixture (used in Phase 1 verification).
 */
function inspectFixtureStats(fx) {
  const luma = fx.luma;
  let min = 255;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < luma.length; i++) {
    const v = luma[i];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return {
    min,
    max,
    mean: sum / luma.length,
  };
}

// ============================================================================
// 7. Phase 2 RoI Evaluation & Visual Debug Overlay Helpers (PPM & Canvas)
// ============================================================================

/**
 * Computes fraction of ground-truth barcode bbox covered by the detected RoI bbox.
 */
function computeBboxRecall(gtBbox, roiX, roiY, roiW, roiH) {
  if (!gtBbox || roiW <= 0 || roiH <= 0) return 0;
  const gx0 = gtBbox.minX;
  const gy0 = gtBbox.minY;
  const gx1 = gtBbox.maxX;
  const gy1 = gtBbox.maxY;
  const rx0 = roiX;
  const ry0 = roiY;
  const rx1 = roiX + roiW;
  const ry1 = roiY + roiH;

  const ix0 = gx0 > rx0 ? gx0 : rx0;
  const iy0 = gy0 > ry0 ? gy0 : ry0;
  const ix1 = gx1 < rx1 ? gx1 : rx1;
  const iy1 = gy1 < ry1 ? gy1 : ry1;
  if (ix1 <= ix0 || iy1 <= iy0) return 0;

  const interArea = (ix1 - ix0) * (iy1 - iy0);
  const gtArea = Math.max(1, (gx1 - gx0) * (gy1 - gy0));
  return interArea / gtArea;
}

/**
 * Draws a thick pixel line into an RGB Uint8Array (3 bytes/px) using Bresenham stepping.
 */
function drawRgbLine(rgb, width, height, x0, y0, x1, y1, r, g, b, thickness = 2) {
  let ix0 = x0 | 0;
  let iy0 = y0 | 0;
  const ix1 = x1 | 0;
  const iy1 = y1 | 0;
  const dx = Math.abs(ix1 - ix0);
  const dy = Math.abs(iy1 - iy0);
  const sx = ix0 < ix1 ? 1 : -1;
  const sy = iy0 < iy1 ? 1 : -1;
  let err = dx - dy;
  const half = thickness >> 1;

  while (true) {
    for (let oy = -half; oy <= half; oy++) {
      const py = iy0 + oy;
      if (py < 0 || py >= height) continue;
      for (let ox = -half; ox <= half; ox++) {
        const px = ix0 + ox;
        if (px < 0 || px >= width) continue;
        const off = (py * width + px) * 3;
        rgb[off] = r;
        rgb[off + 1] = g;
        rgb[off + 2] = b;
      }
    }
    if (ix0 === ix1 && iy0 === iy1) break;
    const e2 = err << 1;
    if (e2 > -dy) {
      err -= dy;
      ix0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      iy0 += sy;
    }
  }
}

function drawRgbRect(rgb, width, height, x0, y0, x1, y1, r, g, b, thickness = 2) {
  drawRgbLine(rgb, width, height, x0, y0, x1, y0, r, g, b, thickness);
  drawRgbLine(rgb, width, height, x1, y0, x1, y1, r, g, b, thickness);
  drawRgbLine(rgb, width, height, x1, y1, x0, y1, r, g, b, thickness);
  drawRgbLine(rgb, width, height, x0, y1, x0, y0, r, g, b, thickness);
}

/**
 * Generates a zero-dependency binary P6 RGB PPM debug visualization showing:
 *  - Cyan rectangle: ground-truth barcode bounding box
 *  - Blue outlines: active winning structure-tensor 32x32 blocks
 *  - Bright green rectangle: detected Stage 1 RoI bounding box
 *  - Magenta vector: dominant bar-normal scanline angle theta through RoI centroid
 */
export function encodeRoiDebugPPM(fixture, result, roiState) {
  const width = fixture.width;
  const height = fixture.height;
  const luma = fixture.luma;
  const headerStr = `P6\n${width} ${height}\n255\n`;
  const out = new Uint8Array(headerStr.length + width * height * 3);
  for (let i = 0; i < headerStr.length; i++) {
    out[i] = headerStr.charCodeAt(i);
  }
  const rgb = out.subarray(headerStr.length);
  for (let i = 0, j = 0; i < luma.length; i++, j += 3) {
    const v = luma[i];
    rgb[j] = v;
    rgb[j + 1] = v;
    rgb[j + 2] = v;
  }

  // Winning structure-tensor cluster blocks (soft blue outline)
  if (roiState && roiState.bestCellCount > 0) {
    const gridW = roiState.gridW;
    for (let i = 0; i < roiState.bestCellCount; i++) {
      const cell = roiState.bestCells[i];
      const by = (cell / gridW) | 0;
      const bx = cell - by * gridW;
      drawRgbRect(rgb, width, height, bx * 32, by * 32, (bx + 1) * 32 - 1, (by + 1) * 32 - 1, 50, 150, 255, 1);
    }
  }

  // Ground-truth barcode bbox (cyan)
  if (fixture.bbox) {
    const b = fixture.bbox;
    drawRgbRect(rgb, width, height, b.minX, b.minY, b.maxX, b.maxY, 0, 235, 255, 2);
  }

  // Detected RoI bbox (green) and dominant angle vector theta (magenta)
  if (result.roiConfidence >= ROI_CONFIDENCE_THRESHOLD && result.roiW > 0 && result.roiH > 0) {
    drawRgbRect(
      rgb, width, height,
      result.roiX, result.roiY,
      result.roiX + result.roiW - 1, result.roiY + result.roiH - 1,
      0, 255, 80, 3
    );
    const rad = (result.thetaDeg * Math.PI) / 180;
    const halfLen = Math.max(60, result.roiMajorLen * 0.5);
    const dx = Math.cos(rad) * halfLen;
    const dy = Math.sin(rad) * halfLen;
    const cx = result.roiCenterX;
    const cy = result.roiCenterY;
    drawRgbLine(rgb, width, height, cx - dx, cy - dy, cx + dx, cy + dy, 255, 40, 220, 3);
    // Arrowhead at +theta tip
    const ax = cx + dx;
    const ay = cy + dy;
    const headLen = 18;
    const a1 = rad + Math.PI * 0.8;
    const a2 = rad - Math.PI * 0.8;
    drawRgbLine(rgb, width, height, ax, ay, ax + Math.cos(a1) * headLen, ay + Math.sin(a1) * headLen, 255, 230, 0, 3);
    drawRgbLine(rgb, width, height, ax, ay, ax + Math.cos(a2) * headLen, ay + Math.sin(a2) * headLen, 255, 230, 0, 3);
  }

  return out;
}

/**
 * Browser Canvas 2D helper for visualizing Stage 1 RoI bbox & orientation vector live.
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} result
 * @param {object} [fixture]
 */
export function drawRoiDebugOverlay(ctx, result, fixture = null) {
  ctx.save();
  if (fixture?.bbox) {
    const b = fixture.bbox;
    ctx.strokeStyle = 'rgba(0, 235, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
    ctx.setLineDash([]);
  }
  if (result.roiConfidence >= ROI_CONFIDENCE_THRESHOLD && result.roiW > 0 && result.roiH > 0) {
    ctx.strokeStyle = '#00ff55';
    ctx.lineWidth = 3;
    ctx.strokeRect(result.roiX, result.roiY, result.roiW, result.roiH);

    const rad = (result.thetaDeg * Math.PI) / 180;
    const halfLen = Math.max(50, result.roiMajorLen * 0.5);
    const dx = Math.cos(rad) * halfLen;
    const dy = Math.sin(rad) * halfLen;
    ctx.strokeStyle = '#ff28dc';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(result.roiCenterX - dx, result.roiCenterY - dy);
    ctx.lineTo(result.roiCenterX + dx, result.roiCenterY + dy);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Evaluates Stage 1 (src/worker/roi.js) accuracy across all fixtures against Phase 2 gates:
 *  - Positive barcodes: RoI detected, angle error <= 3.0 deg, high bbox coverage
 *  - Negative controls: RoI rejected (confidence < ROI_CONFIDENCE_THRESHOLD)
 */
export function evaluateRoiMatrix(fixtures) {
  const roiState = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  const result = createScanResult();
  const rows = [];

  let positiveTotal = 0;
  let positiveDetected = 0;
  let anglePassCount = 0;
  let maxAngleErr = 0;
  let negativeTotal = 0;
  let negativeClean = 0;

  for (const fx of fixtures) {
    resetScanResult(result);
    const detected = estimateRoi(fx.luma, fx.width, fx.height, roiState, result);
    const isPositive = fx.symbology === 'CODE_128';

    let angleErr = null;
    let recall = null;
    let pass = false;

    if (isPositive) {
      positiveTotal++;
      if (detected) positiveDetected++;
      angleErr = fx.angleDeg !== null ? angularErrorDeg180(result.thetaDeg, fx.angleDeg) : null;
      recall = computeBboxRecall(fx.bbox, result.roiX, result.roiY, result.roiW, result.roiH);
      const angleOk = angleErr === null || angleErr <= 3.0;
      if (detected && angleOk) anglePassCount++;
      if (detected && angleErr !== null && angleErr > maxAngleErr) maxAngleErr = angleErr;
      pass = detected === 1 && angleOk && (recall === null || recall >= 0.85);
    } else {
      negativeTotal++;
      pass = detected === 0;
      if (pass) negativeClean++;
    }

    rows.push({
      id: fx.id,
      isPositive,
      detected,
      confidence: result.roiConfidence,
      gtAngleDeg: fx.angleDeg,
      estAngleDeg: result.thetaDeg,
      angleErr,
      recall,
      roiX: result.roiX,
      roiY: result.roiY,
      roiW: result.roiW,
      roiH: result.roiH,
      cells: roiState.bestCellCount,
      pass,
    });
  }

  return {
    rows,
    positiveTotal,
    positiveDetected,
    anglePassCount,
    maxAngleErr,
    negativeTotal,
    negativeClean,
    allPassed: rows.every((r) => r.pass),
  };
}

// ============================================================================
// 8. Node.js CLI Runner
// ============================================================================

async function runCli() {
  const args = process.argv.slice(2);
  let warmupIters = 25;
  let measureIters = 50;
  let dumpPgmDir = null;
  let dumpRoiDebugDir = null;
  let fixturesDir = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--iters=')) {
      measureIters = Math.max(1, Number.parseInt(a.slice(8), 10) || 50);
    } else if (a.startsWith('--warmup=')) {
      warmupIters = Math.max(0, Number.parseInt(a.slice(9), 10) || 25);
    } else if (a === '--dump-pgm') {
      dumpPgmDir = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'tests/fixtures/generated';
    } else if (a.startsWith('--dump-pgm=')) {
      dumpPgmDir = a.slice(11);
    } else if (a === '--dump-roi-debug') {
      dumpRoiDebugDir = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'tests/fixtures/roi_debug';
    } else if (a.startsWith('--dump-roi-debug=')) {
      dumpRoiDebugDir = a.slice(17);
    } else if (a.startsWith('--fixtures-dir=')) {
      fixturesDir = a.slice(15);
    }
  }

  const path = await import('node:path');
  const fs = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const resolvedFixturesDir = fixturesDir ?? path.join(__dirname, 'fixtures');

  console.log('=== Sub-100ms Barcode Scanner — Benchmark & Verification Harness (Code 128) ===');
  const tGen0 = nowMs();
  const syntheticFixtures = buildSyntheticTestMatrix();
  const realFixtures = await loadRealFixtures(resolvedFixturesDir);
  const fixtures = syntheticFixtures.concat(realFixtures);
  const tGenMs = nowMs() - tGen0;

  console.log(
    `Generated ${syntheticFixtures.length} synthetic 1280x720 fixtures` +
    ` + loaded ${realFixtures.length} real fixtures in ${tGenMs.toFixed(1)} ms.\n`
  );

  if (dumpPgmDir) {
    await fs.mkdir(dumpPgmDir, { recursive: true });
    for (const fx of syntheticFixtures) {
      const pgmBytes = encodePGM(fx.luma, fx.width, fx.height);
      await fs.writeFile(path.join(dumpPgmDir, `${fx.id}.pgm`), pgmBytes);
    }
    console.log(`Exported ${syntheticFixtures.length} PGM images to ${dumpPgmDir}\n`);
  }

  // ---- Phase 2: Stage 1 RoI & Structure Tensor Verification ----
  const roiEval = evaluateRoiMatrix(fixtures);

  if (dumpRoiDebugDir) {
    await fs.mkdir(dumpRoiDebugDir, { recursive: true });
    const dbgState = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
    const dbgResult = createScanResult();
    for (const fx of fixtures) {
      resetScanResult(dbgResult);
      estimateRoi(fx.luma, fx.width, fx.height, dbgState, dbgResult);
      const ppmBytes = encodeRoiDebugPPM(fx, dbgResult, dbgState);
      await fs.writeFile(path.join(dumpRoiDebugDir, `${fx.id}_roi.ppm`), ppmBytes);
    }
    console.log(`Exported ${fixtures.length} RGB PPM RoI debug overlays to ${dumpRoiDebugDir}\n`);
  }

  console.log('Phase 2 — Stage 1 RoI & Structure Tensor Accuracy Matrix (Gate: ±3.0°, recall >= 85%):');
  console.log(
    'ID'.padEnd(36) +
    'Det'.padEnd(5) +
    'Conf'.padEnd(7) +
    'GT θ'.padEnd(7) +
    'Est θ'.padEnd(8) +
    'Err θ'.padEnd(8) +
    'Recall'.padEnd(8) +
    'Cells'.padEnd(7) +
    'Status'
  );
  console.log('-'.repeat(98));
  for (const r of roiEval.rows) {
    const gtCol = r.gtAngleDeg !== null ? `${r.gtAngleDeg.toFixed(0)}°` : '-';
    const estCol = r.detected ? `${r.estAngleDeg.toFixed(2)}°` : '-';
    const errCol = r.angleErr !== null && r.detected ? `${r.angleErr.toFixed(2)}°` : '-';
    const recCol = r.recall !== null ? `${(r.recall * 100).toFixed(0)}%` : '-';
    console.log(
      r.id.padEnd(36) +
      String(r.detected).padEnd(5) +
      r.confidence.toFixed(2).padEnd(7) +
      gtCol.padEnd(7) +
      estCol.padEnd(8) +
      errCol.padEnd(8) +
      recCol.padEnd(8) +
      String(r.cells).padEnd(7) +
      (r.pass ? 'PASS' : 'FAIL')
    );
  }
  console.log(
    `\nPhase 2 Accuracy Summary: Positives=${roiEval.positiveDetected}/${roiEval.positiveTotal}, ` +
    `Angle<=3°=${roiEval.anglePassCount}/${roiEval.positiveTotal} (maxErr=${roiEval.maxAngleErr.toFixed(2)}°), ` +
    `NegativesClean=${roiEval.negativeClean}/${roiEval.negativeTotal} -> ${roiEval.allPassed ? 'ALL PASS' : 'FAILED'}`
  );

  // ---- Phase 2: Stage 1 Timing & Zero-Allocation Profiler ----
  console.log(`\nRunning Stage 1 RoI Profiler (${warmupIters} warmup + ${measureIters} measured iters/fixture)...`);
  const roiState = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  const roiReport = profileFrameLoop(fixtures, estimateRoi, roiState, {
    warmupIters,
    measureIters,
  });

  const t = roiReport.total;
  const timeGatePass = t.p95 < 5.0;
  console.log('\nPhase 2 — Stage 1 RoI & Structure Tensor Timings (1280x720 -> 320x180 + Scharr + Tensor + BFS):');
  console.log(
    `  Frames: ${roiReport.totalMeasuredFrames} | ` +
    `min=${t.min.toFixed(3)}ms  mean=${t.mean.toFixed(3)}ms  ` +
    `p50=${t.p50.toFixed(3)}ms  p95=${t.p95.toFixed(3)}ms  ` +
    `p99=${t.p99.toFixed(3)}ms  max=${t.max.toFixed(3)}ms`
  );
  console.log(
    `  Heap Audit (${roiReport.auditFrames} frames): before=${roiReport.heapBeforeBytes} B, ` +
    `after=${roiReport.heapAfterBytes} B, delta=${roiReport.heapDeltaBytes} B ` +
    `(${roiReport.bytesPerFrame.toFixed(2)} B/frame)` +
    (typeof globalThis.gc === 'function' ? ' [--expose-gc active]' : ' [tip: pass --expose-gc]')
  );
  console.log(
    `  Stage 1 Hard Gate (< 5.000 ms): ${timeGatePass ? 'PASS' : 'FAIL'} ` +
    `(${(5.0 - t.p95).toFixed(3)} ms margin at p95)`
  );

  if (!roiEval.allPassed || !timeGatePass) {
    process.exitCode = 1;
  }

  // ---- Phase 3: Full End-to-End Code 128 Pipeline Verification (Stages 1–5) ----
  const pipeEval = evaluateFullPipelineMatrix(fixtures);
  console.log('\nPhase 3 — End-to-End Code 128 Decode Matrix (Gate: >95% accuracy, 0 false positives):');
  console.log(
    'ID'.padEnd(36) +
    'Det'.padEnd(5) +
    'Agree'.padEnd(7) +
    'Expected'.padEnd(18) +
    'Decoded'.padEnd(18) +
    'Status'
  );
  console.log('-'.repeat(92));
  for (const r of pipeEval.rows) {
    console.log(
      r.id.padEnd(36) +
      String(r.detected).padEnd(5) +
      String(r.consensusCount).padEnd(7) +
      (r.expected ?? '(none)').padEnd(18) +
      (r.decoded ?? '-').padEnd(18) +
      (r.pass ? 'PASS' : 'FAIL')
    );
  }
  const accPct = pipeEval.positiveTotal > 0
    ? (pipeEval.positiveExact / pipeEval.positiveTotal) * 100
    : 0;
  console.log(
    `\nPhase 3 Accuracy Summary: Decoded=${pipeEval.positiveExact}/${pipeEval.positiveTotal} (${accPct.toFixed(1)}%), ` +
    `FalsePositives=${pipeEval.falsePositives}/${pipeEval.negativeTotal} -> ` +
    `${pipeEval.accuracyGatePass ? 'PASS' : 'FAIL'}`
  );

  // ---- Phase 3: Full Pipeline Timing & Zero-Allocation Profiler ----
  console.log(`\nRunning Full Pipeline Profiler Stages 1–5 (${warmupIters} warmup + ${measureIters} measured iters/fixture)...`);
  const pipeState = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const pipeReport = profileFrameLoop(fixtures, processFrame, pipeState, {
    warmupIters,
    measureIters,
  });

  const pt = pipeReport.total;
  const pipeTimePass = pt.p95 < 20.0;
  console.log('\nPhase 3 — Full Pipeline Timings Stages 1–5 (1280x720 -> RoI + Scanlines + Edges + Code 128 + Consensus):');
  console.log(
    `  Frames: ${pipeReport.totalMeasuredFrames} | ` +
    `min=${pt.min.toFixed(3)}ms  mean=${pt.mean.toFixed(3)}ms  ` +
    `p50=${pt.p50.toFixed(3)}ms  p95=${pt.p95.toFixed(3)}ms  ` +
    `p99=${pt.p99.toFixed(3)}ms  max=${pt.max.toFixed(3)}ms`
  );
  console.log(
    `  Heap Audit (${pipeReport.auditFrames} frames): before=${pipeReport.heapBeforeBytes} B, ` +
    `after=${pipeReport.heapAfterBytes} B, delta=${pipeReport.heapDeltaBytes} B ` +
    `(${pipeReport.bytesPerFrame.toFixed(2)} B/frame)` +
    (typeof globalThis.gc === 'function' ? ' [--expose-gc active]' : ' [tip: pass --expose-gc]')
  );
  console.log(
    `  Phase 3 Hard Gate (< 20.000 ms/frame): ${pipeTimePass ? 'PASS' : 'FAIL'} ` +
    `(${(20.0 - pt.p95).toFixed(3)} ms margin at p95)`
  );

  if (!pipeEval.accuracyGatePass || !pipeTimePass) {
    process.exitCode = 1;
  }
}

/**
 * Evaluates the full Stages 1–5 Code 128 pipeline across all fixtures.
 */
export function evaluateFullPipelineMatrix(fixtures) {
  const pipeState = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const result = createScanResult();
  const rows = [];

  let positiveTotal = 0;
  let positiveExact = 0;
  let negativeTotal = 0;
  let falsePositives = 0;

  for (const fx of fixtures) {
    resetScanResult(result);
    const detected = processFrame(fx.luma, fx.width, fx.height, pipeState, result, false);
    const decoded = detected === 1 ? extractPayloadString(result) : null;
    const isPositive = fx.symbology === 'CODE_128';
    let pass = false;

    if (isPositive) {
      positiveTotal++;
      pass = detected === 1 && decoded === fx.payload && result.consensusCount >= 2;
      if (pass) positiveExact++;
    } else {
      negativeTotal++;
      if (detected === 1) falsePositives++;
      pass = detected === 0;
    }

    rows.push({
      id: fx.id,
      isPositive,
      detected,
      consensusCount: result.consensusCount,
      expected: fx.payload,
      decoded,
      pass,
    });
  }

  const accuracy = positiveTotal > 0 ? positiveExact / positiveTotal : 1;
  return {
    rows,
    positiveTotal,
    positiveExact,
    negativeTotal,
    falsePositives,
    accuracy,
    accuracyGatePass: accuracy > 0.95 && falsePositives === 0,
  };
}

// Run CLI only when executed directly under Node.js
if (typeof process !== 'undefined' && process.versions?.node) {
  const { pathToFileURL } = await import('node:url');
  if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await runCli();
  }
}
