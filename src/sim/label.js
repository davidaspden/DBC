/**
 * L1 — Parameterised Label Geometry, Code 128B Encoder & Analytic 1D Coverage (`src/sim/label.js`).
 *
 * Shared by both the WebGL/CPU 3D wall renderers (R5) and the AR compositor (M6) so there is a
 * single source of truth for module counts, encoding, physical scan length, and pixel integration.
 */

import { CODE128_PATTERNS, CODE128_START_B } from '../worker/decoders/code128.js';

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

/**
 * Computes exact Code 128 module count:
 * `11 * chars + 11 (Start) + 11 (Check) + 13 (Stop) + 2 * quietModules`.
 *
 * @param {string | number} payloadOrChars
 * @param {number} [quietModules=10]
 */
export function computeCode128Modules(payloadOrChars, quietModules = 10) {
  const chars = typeof payloadOrChars === 'string'
    ? payloadOrChars.length
    : (payloadOrChars | 0);
  if (chars <= 0) {
    throw new Error(`Code 128 payload must have >= 1 character, got ${chars}`);
  }
  const quiet = quietModules | 0;
  return 11 * chars + 11 + 11 + 13 + 2 * quiet;
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
