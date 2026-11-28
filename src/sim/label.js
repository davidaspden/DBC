/**
 * L1 — Parameterised Label Geometry, Code 128B Encoder & Analytic 1D Coverage (`src/sim/label.js`).
 *
 * Shared by both the WebGL/CPU 3D wall renderers (R5) and the AR compositor (M6) so there is a
 * single source of truth for module counts, encoding, physical scan length, and pixel integration.
 */

import { CODE128_PATTERNS, CODE128_START_B } from '../worker/decoders/code128.js';
import { mulberry32 } from './prng.js';
export { mulberry32 } from './prng.js';
export { computeCode128Modules } from '../array/config.js';

export const CODE128_STOP_PATTERN = new Uint8Array([2, 3, 3, 1, 1, 1, 2]);

export const DEFAULT_LABEL_SPEC = Object.freeze({
  widthIn: 2.0,
  heightIn: 6.0,
  quietModules: 10,
  printGain: 1.0,
  orientation: 'ladder', // 'ladder' (horizontal bars, 90° vertical scan) | 'picket' (vertical bars, 0° scan)
  sideMarginIn: 0.12,
  paperAlbedo: 0.93,
  inkAlbedo: 0.06,
});

/**
 * Default legacy 2x6 in cell payload generator (16 chars -> 231 modules with 2x10 quiet zones).
 */
export function LEGACY_PAYLOAD_FN(row, col, index) {
  const num = String(index + 1).padStart(2, '0');
  return `TOTE-R${row + 1}C${col + 1}-00${num}${num}`;
}

/**
 * Legacy FC 3.5 in preset payload generator (12 chars -> 187 modules with 2x10 quiet zones).
 */
export function FC_12_PAYLOAD_FN(row, col, index) {
  const num = String(index + 1).padStart(2, '0');
  return `tsX${row + 1}${col + 1}A000${num}B`;
}

const BASE36_LOWER = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * L2 — Generates a deterministic array of unique 11-char FC `tsX` payloads
 * matching the real tote label pattern `tsX07wz7py1` (`tsX` + 2 digits + 6 base-36 lowercase chars).
 * 11 characters -> 176 modules with 2x10 quiet zones.
 *
 * @param {number} [count=16]
 * @param {number} [seed=1]
 * @returns {string[]}
 */
export function generateFcTsxPayloads(count = 16, seed = 1) {
  const n = Math.max(1, count | 0);
  const rng = mulberry32((seed >>> 0) ^ 0x51f15e1d);
  const used = new Set();
  const list = new Array(n);

  for (let i = 0; i < n; i++) {
    let payload = '';
    for (let attempt = 0; attempt < 64; attempt++) {
      const d0 = (rng() * 10) | 0;
      const d1 = (rng() * 10) | 0;
      let suffix = '';
      for (let k = 0; k < 6; k++) {
        suffix += BASE36_LOWER[(rng() * 36) | 0];
      }
      payload = `tsX${d0}${d1}${suffix}`;
      if (!used.has(payload)) {
        used.add(payload);
        break;
      }
    }
    list[i] = payload;
  }
  return list;
}

/**
 * L2 — Creates a seeded `payloadFn(row, col, index)` yielding unique 11-char `tsX` payloads.
 *
 * @param {{ seed?: number, count?: number }} [opts]
 */
export function createFcLabelPayloadFn(opts = {}) {
  const seed = opts.seed ?? 1;
  const baseCount = Math.max(16, (opts.count ?? 64) | 0);
  const cache = generateFcTsxPayloads(baseCount, seed);
  return function fcTsxPayloadFn(row, col, index) {
    const idx = index >= 0 ? (index | 0) : ((row * 4 + col) | 0);
    if (idx < cache.length) return cache[idx];
    const extra = generateFcTsxPayloads(idx + 1, seed);
    return extra[idx];
  };
}

/**
 * L2 — Builds a seeded FC 2x3.5 in ladder label specification (`simFcLabel`):
 *  - 2.0 in x 3.5 in ladder orientation
 *  - 11-char `tsX` payloads (176 modules with quiet 10)
 *  - seeded printGain in [0.95, 1.05] (1.0 +/- 5%)
 *
 * @param {{ seed?: number, count?: number, printGain?: number }} [opts]
 */
export function createFcLabelSpec(opts = {}) {
  const seed = opts.seed ?? 1;
  const rng = mulberry32((seed >>> 0) ^ 0x2c1b3c6d);
  const printGain = Number.isFinite(opts.printGain)
    ? opts.printGain
    : (0.95 + rng() * 0.10);
  return normalizeLabelSpec({
    widthIn: 2.0,
    heightIn: 3.5,
    quietModules: 10,
    printGain,
    orientation: 'ladder',
    payloadFn: createFcLabelPayloadFn({ seed, count: opts.count ?? 64 }),
  }, true);
}

/**
 * Encodes an ASCII string using ISO/IEC 15417 Code 128 Set B into a binary module Uint8Array
 * (`1` = dark bar, `0` = space / quiet zone). Bit-identical to `tests/harness.js` `encodeCode128`.
 *
 * @param {string} payload
 * @param {number} [quietModules=10]
 */
export function encodeCode128B(payload, quietModules = 10) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('Code 128B requires a non-empty string payload');
  }
  if (quietModules < 10) {
    throw new Error('Code 128 requires at least 10 quiet-zone modules on each side');
  }

  const dataLen = payload.length;
  const symbols = new Uint8Array(dataLen + 2); // Start B + data + Check
  symbols[0] = CODE128_START_B;
  let checksum = CODE128_START_B;
  for (let i = 0; i < dataLen; i++) {
    const ch = payload.charCodeAt(i);
    if (ch < 32 || ch > 126) {
      throw new Error(`Unsupported Code 128B character code ${ch} in "${payload}"`);
    }
    const sym = ch - 32;
    symbols[i + 1] = sym;
    checksum += (i + 1) * sym;
  }
  symbols[dataLen + 1] = checksum % 103;

  const dataModules = symbols.length * 11 + 13;
  const totalModules = quietModules * 2 + dataModules;
  const modules = new Uint8Array(totalModules);

  let cursor = quietModules;
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
    payload,
    symbols,
    checkSymbol: symbols[dataLen + 1],
    quietModules,
    dataChars: dataLen,
    dataModules,
    totalModules,
    modules,
  };
}

/**
 * Normalizes a label specification and derives scan/cross-bar physical dimensions.
 */
export function normalizeLabelSpec(spec = {}, fcMode = false) {
  const widthIn = Number.isFinite(spec.widthIn) ? spec.widthIn : DEFAULT_LABEL_SPEC.widthIn;
  const heightIn = Number.isFinite(spec.heightIn)
    ? spec.heightIn
    : (fcMode ? 3.5 : DEFAULT_LABEL_SPEC.heightIn);
  const quietModules = Number.isFinite(spec.quietModules) ? spec.quietModules : DEFAULT_LABEL_SPEC.quietModules;
  const printGain = Number.isFinite(spec.printGain) ? spec.printGain : DEFAULT_LABEL_SPEC.printGain;
  const orientation = spec.orientation === 'picket' ? 'picket' : 'ladder';
  const sideMarginIn = Number.isFinite(spec.sideMarginIn) ? spec.sideMarginIn : DEFAULT_LABEL_SPEC.sideMarginIn;
  const paperAlbedo = Number.isFinite(spec.paperAlbedo) ? spec.paperAlbedo : DEFAULT_LABEL_SPEC.paperAlbedo;
  const inkAlbedo = Number.isFinite(spec.inkAlbedo) ? spec.inkAlbedo : DEFAULT_LABEL_SPEC.inkAlbedo;
  const payloadFn = typeof spec.payloadFn === 'function'
    ? spec.payloadFn
    : (fcMode ? FC_12_PAYLOAD_FN : LEGACY_PAYLOAD_FN);

  return {
    widthIn,
    heightIn,
    quietModules,
    printGain,
    orientation,
    sideMarginIn,
    paperAlbedo,
    inkAlbedo,
    payloadFn,
    scanLenIn: orientation === 'picket' ? widthIn : heightIn,
    barSpanIn: orientation === 'picket' ? heightIn : widthIn,
  };
}

/**
 * Analytical 1D sensor-pixel box-filter integration over binary Code 128 module strip.
 * Zero heap allocations; directly mirrors GLSL `sampleBarcodeIntegrated`.
 *
 * @param {Uint8Array} modules
 * @param {number} totalModules
 * @param {number} v01 - normalized position along scan axis in [0, 1]
 * @param {number} dvPerPx - normalized derivative |dv| per pixel
 * @param {number} [printGain=1.0] - 1.0 nominal; >1 thickens bars, <1 thins bars
 * @returns {number} coverage in [0, 1] (1 = ink bar, 0 = paper space)
 */
export function sampleBarcodeIntegrated1D(modules, totalModules, v01, dvPerPx, printGain = 1.0) {
  const mCenter = v01 * totalModules;
  let dm = dvPerPx * totalModules;
  if (dm < 0.02) dm = 0.02;
  else if (dm > 6.0) dm = 6.0;

  const m0 = mCenter - 0.5 * dm;
  const m1 = mCenter + 0.5 * dm;

  const halfGainShift = printGain === 1.0
    ? 0.0
    : Math.max(-0.4, Math.min(0.4, 0.5 * (printGain - 1.0)));

  let startIdx = Math.floor(m0) | 0;
  let endIdx = Math.floor(m1) | 0;
  if (halfGainShift > 0) {
    startIdx -= 1;
    endIdx += 1;
  }

  let acc = 0.0;
  if (halfGainShift === 0.0) {
    const maxStep = startIdx + 7;
    if (endIdx > maxStep) endIdx = maxStep;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      if (idx < 0 || idx >= totalModules) continue;
      if (modules[idx] === 0) continue;
      const lo = m0 > idx ? m0 : idx;
      const idx1 = idx + 1;
      const hi = m1 < idx1 ? m1 : idx1;
      if (hi > lo) acc += hi - lo;
    }
  } else {
    const maxStep = startIdx + 9;
    if (endIdx > maxStep) endIdx = maxStep;
    for (let idx = startIdx; idx <= endIdx; idx++) {
      if (idx < 0 || idx >= totalModules) continue;
      if (modules[idx] === 0) continue;
      const leftFree = idx > 0 && modules[idx - 1] === 0;
      const rightFree = idx + 1 < totalModules && modules[idx + 1] === 0;
      const barLo = leftFree ? idx - halfGainShift : idx;
      const barHi = rightFree ? idx + 1 + halfGainShift : idx + 1;
      const lo = m0 > barLo ? m0 : barLo;
      const hi = m1 < barHi ? m1 : barHi;
      if (hi > lo) acc += hi - lo;
    }
  }

  const cov = acc / dm;
  if (cov <= 0.0) return 0.0;
  if (cov >= 1.0) return 1.0;
  return cov;
}

/**
 * L7 — Pure zero-allocation scan-axis coordinate warp for label curvature / corner peel.
 * Maps normalized scan coordinate `v01` in [0, 1] by adding `peelWarp * v01 * (1 - v01) * (2 * v01 - 1)`.
 * Returns warped `v01` clamped to [0, 1].
 *
 * @param {number} v01
 * @param {number} peelWarp
 * @returns {number}
 */
export function warpLabelScanCoord(v01, peelWarp) {
  if (peelWarp === 0.0) return v01;
  const w = v01 + peelWarp * v01 * (1.0 - v01) * (2.0 * v01 - 1.0);
  if (w <= 0.0) return 0.0;
  if (w >= 1.0) return 1.0;
  return w;
}

/**
 * L7 — Derivative scale |d(warpLabelScanCoord)/dv| for accurate box-filter pixel footprint.
 *
 * @param {number} v01
 * @param {number} peelWarp
 * @returns {number}
 */
export function warpLabelScanDeriv(v01, peelWarp) {
  if (peelWarp === 0.0) return 1.0;
  // d/dv [ v*(1-v)*(2v-1) ] = d/dv [ -2v^3 + 3v^2 - v ] = -6v^2 + 6v - 1
  const d = 1.0 + peelWarp * (-6.0 * v01 * v01 + 6.0 * v01 - 1.0);
  return d > 0.1 ? d : 0.1;
}
