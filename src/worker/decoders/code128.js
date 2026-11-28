/**
 * Stage 4 & Stage 5: Code 128 1D Soft Decoder & Modulo 103 Checksum Gate.
 *
 * Pure 32-bit integer (Q8 fixed-point) ISO/IEC 15417 Code 128 decoder operating directly
 * on Stage 3 `runWidthsQ8` (`256 = 1.0 px`) with:
 *  - Bidirectional scanning (forward + reverse) for full 360° physical orientation coverage
 *  - Start A/B/C + Stop (106) guard pattern anchoring with quiet-zone verification
 *  - Per-character local width normalization (prevents perspective phase drift)
 *  - Combined edge-to-similar-edge (e-distance, ink-bleed invariant) + individual-run Q8 scoring
 *  - Full Subset A, B, C + inline CODE A/B/C, SHIFT, and FNC1 decoding
 *  - Strict Modulo 103 mathematical checksum validation
 *
 * Zero-Allocation Guarantee:
 *  Zero floats, zero helper calls taking float args, zero V8 HeapNumber allocations.
 */

import { FLAG_CRIB_MATCH } from '../flagbits.js';

export const MAX_CODE128_SYMBOLS = 64;
export const MAX_CODE128_PAYLOAD = 128;
export const MAX_LINE_HITS = 8;

export const CODE128_FNC3 = 96;
export const CODE128_FNC2 = 97;
export const CODE128_SHIFT = 98;
export const CODE128_CODE_C = 99;
export const CODE128_CODE_B = 100;
export const CODE128_CODE_A = 101;
export const CODE128_FNC1 = 102;
export const CODE128_START_A = 103;
export const CODE128_START_B = 104;
export const CODE128_START_C = 105;
export const CODE128_STOP = 106;

/**
 * ISO/IEC 15417 Code 128 symbol patterns (0..105), 6 runs per symbol (b0,s0,b1,s1,b2,s2),
 * each summing to 11 modules.
 */
export const CODE128_PATTERNS = new Uint8Array([
  2,1,2,2,2,2,  2,2,2,1,2,2,  2,2,2,2,2,1,  1,2,1,2,2,3,  1,2,1,3,2,2,
  1,3,1,2,2,2,  1,2,2,2,1,3,  1,2,2,3,1,2,  1,3,2,2,1,2,  2,2,1,2,1,3,
  2,2,1,3,1,2,  2,3,1,2,1,2,  1,1,2,2,3,2,  1,2,2,1,3,2,  1,2,2,2,3,1,
  1,1,3,2,2,2,  1,2,3,1,2,2,  1,2,3,2,2,1,  2,2,3,2,1,1,  2,2,1,1,3,2,
  2,2,1,2,3,1,  2,1,3,2,1,2,  2,2,3,1,1,2,  3,1,2,1,3,1,  3,1,1,2,2,2,
  3,2,1,1,2,2,  3,2,1,2,2,1,  3,1,2,2,1,2,  3,2,2,1,1,2,  3,2,2,2,1,1,
  2,1,2,1,2,3,  2,1,2,3,2,1,  2,3,2,1,2,1,  1,1,1,3,2,3,  1,3,1,1,2,3,
  1,3,1,3,2,1,  1,1,2,3,1,3,  1,3,2,1,1,3,  1,3,2,3,1,1,  2,1,1,3,1,3,
  2,3,1,1,1,3,  2,3,1,3,1,1,  1,1,2,1,3,3,  1,1,2,3,3,1,  1,3,2,1,3,1,
  1,1,3,1,2,3,  1,1,3,3,2,1,  1,3,3,1,2,1,  3,1,3,1,2,1,  2,1,1,3,3,1,
  2,3,1,1,3,1,  2,1,3,1,1,3,  2,1,3,3,1,1,  2,1,3,1,3,1,  3,1,1,1,2,3,
  3,1,1,3,2,1,  3,3,1,1,2,1,  3,1,2,1,1,3,  3,1,2,3,1,1,  3,3,2,1,1,1,
  3,1,4,1,1,1,  2,2,1,4,1,1,  4,3,1,1,1,1,  1,1,1,2,2,4,  1,1,1,4,2,2,
  1,2,1,1,2,4,  1,2,1,4,2,1,  1,4,1,1,2,2,  1,4,1,2,2,1,  1,1,2,2,1,4,
  1,1,2,4,1,2,  1,2,2,1,1,4,  1,2,2,4,1,1,  1,4,2,1,1,2,  1,4,2,2,1,1,
  2,4,1,2,1,1,  2,2,1,1,1,4,  4,1,3,1,1,1,  2,4,1,1,1,2,  1,3,4,1,1,1,
  1,1,1,2,4,2,  1,2,1,1,4,2,  1,2,1,2,4,1,  1,1,4,2,1,2,  1,2,4,1,1,2,
  1,2,4,2,1,1,  4,1,1,2,1,2,  4,2,1,1,1,2,  4,2,1,2,1,1,  2,1,2,1,4,1,
  2,1,4,1,2,1,  4,1,2,1,2,1,  1,1,1,1,4,3,  1,1,1,3,4,1,  1,3,1,1,4,1,
  1,1,4,1,1,3,  1,1,4,3,1,1,  4,1,1,1,1,3,  4,1,1,3,1,1,  1,1,3,1,4,1,
  1,1,4,1,3,1,  3,1,1,1,4,1,  4,1,1,1,3,1,  2,1,1,4,1,2,  2,1,1,2,1,4,
  2,1,1,2,3,2,
]);

// Pre-computed Q8 fixed-point tables (1 module = 256) for pure Smi integer inner loops
const CODE128_PATTERNS_Q8 = new Int16Array(106 * 6);
const CODE128_E_SUMS_Q8 = new Int16Array(106 * 4);
for (let c = 0; c < 106; c++) {
  const p = c * 6;
  const e = c * 4;
  for (let k = 0; k < 6; k++) {
    CODE128_PATTERNS_Q8[p + k] = CODE128_PATTERNS[p + k] << 8;
  }
  CODE128_E_SUMS_Q8[e] = (CODE128_PATTERNS[p] + CODE128_PATTERNS[p + 1]) << 8;
  CODE128_E_SUMS_Q8[e + 1] = (CODE128_PATTERNS[p + 1] + CODE128_PATTERNS[p + 2]) << 8;
  CODE128_E_SUMS_Q8[e + 2] = (CODE128_PATTERNS[p + 2] + CODE128_PATTERNS[p + 3]) << 8;
  CODE128_E_SUMS_Q8[e + 3] = (CODE128_PATTERNS[p + 3] + CODE128_PATTERNS[p + 4]) << 8;
}

// W3 (flagged `cribMatch`): exact 18-run width table for Code 128B `t` (84), `s` (83), `X` (56)
// Preceded by Start B (104) = 2,1,1,2,1,4 -> 44 modules total, weighted checksum mod 103 = 7.
const TSX_CRIB_RUNS_Q8 = new Int16Array([
  1 << 8, 2 << 8, 4 << 8, 1 << 8, 1 << 8, 2 << 8, // 't' (84)
  1 << 8, 1 << 8, 4 << 8, 2 << 8, 1 << 8, 2 << 8, // 's' (83)
  3 << 8, 3 << 8, 1 << 8, 1 << 8, 2 << 8, 1 << 8, // 'X' (56)
]);

/**
 * Pre-allocated scratch state for single-scanline Code 128 decoding (all integers).
 */
export function createCode128State() {
  return {
    flags: 0,
    cribMatched: 0,
    cribModulePxQ8: 0,
    cribStartPxQ8: 0,
    cribErrQ8: 0,
    cribDir: 0,

    workSymbols: new Uint8Array(MAX_CODE128_SYMBOLS),
    workConfsQ10: new Int32Array(MAX_CODE128_SYMBOLS),

    symbols: new Uint8Array(MAX_CODE128_SYMBOLS),
    symbolConfsQ10: new Int32Array(MAX_CODE128_SYMBOLS),
    symbolCount: 0,
    checksumOk: 0,
    stopFound: 0,
    avgConfidenceQ10: 0,

    payloadBytes: new Uint8Array(MAX_CODE128_PAYLOAD),
    payloadLen: 0,

    // Pre-allocated multi-hit bank for scanlines crossing multiple stacked barcodes
    hitCount: 0,
    hitPayloads: new Uint8Array(MAX_LINE_HITS * MAX_CODE128_PAYLOAD),
    hitPayloadLens: new Uint16Array(MAX_LINE_HITS),
    hitSymbols: new Uint8Array(MAX_LINE_HITS * MAX_CODE128_SYMBOLS),
    hitSymbolCounts: new Uint8Array(MAX_LINE_HITS),
    hitStartPx: new Float32Array(MAX_LINE_HITS),
    hitEndPx: new Float32Array(MAX_LINE_HITS),
    prefixPosQ8: new Int32Array(514),
  };
}

/**
 * Verifies Code 128 Modulo 103 mathematical checksum on `symbols[0..count-1]`.
 */
export function verifyCode128Checksum(symbols, count) {
  if (count < 3) return 0;
  const startSym = symbols[0];
  if (startSym !== CODE128_START_A && startSym !== CODE128_START_B && startSym !== CODE128_START_C) {
    return 0;
  }
  let sum = startSym | 0;
  const dataEnd = (count - 1) | 0;
  for (let i = 1; i < dataEnd; i++) {
    sum = (sum + Math.imul(i, symbols[i])) | 0;
  }
  return (sum % 103) === symbols[dataEnd] ? 1 : 0;
}

/**
 * Converts a checksum-validated Code 128 symbol sequence `symbols[0..count-1]`
 * into raw ASCII bytes inside pre-allocated `outBytes`.
 */
export function decodeCode128SymbolsToBytes(symbols, count, outBytes) {
  if (count < 3) return 0;
  const startSym = symbols[0];
  let mode = 0;
  if (startSym === CODE128_START_A) mode = 1;
  else if (startSym === CODE128_START_B) mode = 2;
  else if (startSym === CODE128_START_C) mode = 3;
  else return 0;

  const dataEnd = (count - 1) | 0;
  const maxOut = outBytes.length | 0;
  let outLen = 0;
  let shiftNext = 0;

  for (let i = 1; i < dataEnd; i++) {
    const sym = symbols[i];
    if (sym > 102) return 0;

    const curMode = shiftNext !== 0 ? (mode === 1 ? 2 : 1) : mode;
    shiftNext = 0;

    if (curMode === 3) {
      if (sym < 100) {
        if (outLen + 2 > maxOut) return 0;
        const tens = (sym / 10) | 0;
        const ones = (sym - Math.imul(tens, 10)) | 0;
        outBytes[outLen++] = (48 + tens) | 0;
        outBytes[outLen++] = (48 + ones) | 0;
      } else if (sym === CODE128_CODE_B) {
        mode = 2;
      } else if (sym === CODE128_CODE_A) {
        mode = 1;
      } else if (sym === CODE128_FNC1) {
        // GS1 FNC1
      } else {
        return 0;
      }
    } else if (curMode === 2) {
      if (sym <= 94) {
        if (outLen >= maxOut) return 0;
        outBytes[outLen++] = (sym + 32) | 0;
      } else if (sym === 95) {
        if (outLen >= maxOut) return 0;
        outBytes[outLen++] = 127;
      } else if (sym === CODE128_SHIFT) {
        shiftNext = 1;
      } else if (sym === CODE128_CODE_C) {
        mode = 3;
      } else if (sym === CODE128_CODE_A) {
        mode = 1;
      } else if (sym === CODE128_FNC1 || sym === CODE128_FNC2 || sym === CODE128_FNC3) {
        // Control function code
      } else {
        return 0;
      }
    } else {
      if (sym <= 63) {
        if (outLen >= maxOut) return 0;
        outBytes[outLen++] = (sym + 32) | 0;
      } else if (sym <= 95) {
        if (outLen >= maxOut) return 0;
        outBytes[outLen++] = (sym - 64) | 0;
      } else if (sym === CODE128_SHIFT) {
        shiftNext = 1;
      } else if (sym === CODE128_CODE_C) {
        mode = 3;
      } else if (sym === CODE128_CODE_B) {
        mode = 2;
      } else if (sym === CODE128_FNC1 || sym === CODE128_FNC2 || sym === CODE128_FNC3) {
        // Control function code
      } else {
        return 0;
      }
    }
  }

  return outLen;
}

/**
 * Pure 32-bit integer Code 128 decoder along `runWidthsQ8[0..runCount-1]` in direction `dir` (+1 or -1).
 * All scoring loops are inlined to guarantee zero V8 HeapNumber allocations.
 *
 * @returns {number} 2 = strict Mod-103 pass, 1 = soft Stop-anchored candidate, 0 = none
 */
function tryDecodeDirection(runWidthsQ8, runIsBar, runCount, dir, state, multiHit = 0) {
  const MAX_START_ERR_Q8 = 560; // ~2.19 modules combined L1
  const MAX_CHAR_ERR_Q8 = 680;  // ~2.66 modules combined L1
  const MAX_STOP_ERR_Q8 = 780;  // ~3.05 modules combined L1

  const MIN_CHAR_SUM_Q8 = 11 << 8;  // 11.0 px (modulePx >= 1.0)
  const MAX_CHAR_SUM_Q8 = 260 << 8; // 260.0 px (modulePx <= 23.6 for large 1080p carton labels)

  const workSymbols = state.workSymbols;
  const workConfsQ10 = state.workConfsQ10;
  const patQ8 = CODE128_PATTERNS_Q8;
  const eQ8 = CODE128_E_SUMS_Q8;

  const rc = runCount | 0;
  const step = dir | 0;
  if (rc < 25) return 0;

  const startIdx = step === 1 ? 0 : (rc - 1);
  const endLimit = step === 1 ? (rc - 25) : 24;

  for (let i = startIdx; step === 1 ? (i <= endLimit) : (i >= endLimit); i = (i + step) | 0) {
    if (runIsBar[i] !== 1) continue;

    const r0 = runWidthsQ8[i] | 0;
    const r1 = runWidthsQ8[(i + step) | 0] | 0;
    const r2 = runWidthsQ8[(i + (step << 1)) | 0] | 0;
    const r3 = runWidthsQ8[(i + Math.imul(3, step)) | 0] | 0;
    const r4 = runWidthsQ8[(i + (step << 2)) | 0] | 0;
    const r5 = runWidthsQ8[(i + Math.imul(5, step)) | 0] | 0;

    const startSum = (r0 + r1 + r2 + r3 + r4 + r5) | 0;
    if (startSum < MIN_CHAR_SUM_Q8 || startSum > MAX_CHAR_SUM_Q8) continue;

    // Quiet-zone guard before Start bar (>= ~3.2 modules if explicit space precedes)
    const quietIdx = (i - step) | 0;
    if (quietIdx >= 0 && quietIdx < rc) {
      if (runWidthsQ8[quietIdx] < ((Math.imul(startSum, 74) >> 8) | 0)) continue;
    }

    // Normalize 6 runs to Q8 module units (sum = 11 * 256 = 2816)
    const halfSum = startSum >> 1;
    const n0 = ((Math.imul(r0, 2816) + halfSum) / startSum) | 0;
    const n1 = ((Math.imul(r1, 2816) + halfSum) / startSum) | 0;
    const n2 = ((Math.imul(r2, 2816) + halfSum) / startSum) | 0;
    const n3 = ((Math.imul(r3, 2816) + halfSum) / startSum) | 0;
    const n4 = ((Math.imul(r4, 2816) + halfSum) / startSum) | 0;
    const n5 = ((Math.imul(r5, 2816) + halfSum) / startSum) | 0;
    const e0 = (n0 + n1) | 0;
    const e1 = (n1 + n2) | 0;
    const e2 = (n2 + n3) | 0;
    const e3 = (n3 + n4) | 0;

    // Score Start A (103), Start B (104), Start C (105) inline
    let bestStart = CODE128_START_A;
    let bestStartErr = 999999;
    for (let code = CODE128_START_A; code <= CODE128_START_C; code++) {
      const p = Math.imul(code, 6);
      const ep = code << 2;

      let d = (e0 - eQ8[ep]) | 0;
      let err = d < 0 ? -d : d;
      d = (e1 - eQ8[ep + 1]) | 0;
      err = (err + (d < 0 ? -d : d)) | 0;
      d = (e2 - eQ8[ep + 2]) | 0;
      err = (err + (d < 0 ? -d : d)) | 0;
      d = (e3 - eQ8[ep + 3]) | 0;
      err = (err + (d < 0 ? -d : d)) | 0;

      let ind = 0;
      d = (n0 - patQ8[p]) | 0;
      ind = (ind + (d < 0 ? -d : d)) | 0;
      d = (n1 - patQ8[p + 1]) | 0;
      ind = (ind + (d < 0 ? -d : d)) | 0;
      d = (n2 - patQ8[p + 2]) | 0;
      ind = (ind + (d < 0 ? -d : d)) | 0;
      d = (n3 - patQ8[p + 3]) | 0;
      ind = (ind + (d < 0 ? -d : d)) | 0;
      d = (n4 - patQ8[p + 4]) | 0;
      ind = (ind + (d < 0 ? -d : d)) | 0;
      d = (n5 - patQ8[p + 5]) | 0;
      ind = (ind + (d < 0 ? -d : d)) | 0;

      const totalErr = (err + ((Math.imul(ind, 115) >> 8) | 0)) | 0;
      if (totalErr < bestStartErr) {
        bestStartErr = totalErr;
        bestStart = code;
      }
    }
    if (bestStartErr > MAX_START_ERR_Q8) continue;

    // Anchor accepted -> traverse character by character
    workSymbols[0] = bestStart;
    const startConf = (1024 - ((Math.imul(bestStartErr, 1024) / (MAX_START_ERR_Q8 + 128)) | 0)) | 0;
    workConfsQ10[0] = startConf > 64 ? startConf : 64;
    let symCount = 1;
    let confSum = workConfsQ10[0] | 0;
    let prevCharW = startSum;
    let cursor = (i + Math.imul(6, step)) | 0;
    let stopped = 0;

    // W3 (flagged `cribMatch`): match 44-module StartB+'t'+'s'+'X' crib for rock-solid module scale
    if (
      (state.flags & FLAG_CRIB_MATCH) !== 0 &&
      bestStart === CODE128_START_B &&
      ((step === 1 && cursor + 18 < rc) || (step === -1 && cursor - 18 >= 0))
    ) {
      let cribSum = 0;
      for (let k = 0; k < 18; k++) {
        cribSum = (cribSum + runWidthsQ8[(cursor + Math.imul(k, step)) | 0]) | 0;
      }
      const total44 = (startSum + cribSum) | 0;
      if (total44 > 256) {
        const half44 = total44 >> 1;
        let cribErr = 0;
        for (let k = 0; k < 18; k++) {
          const rw = runWidthsQ8[(cursor + Math.imul(k, step)) | 0] | 0;
          // 44 modules * 256 = 11264
          const normQ8 = ((Math.imul(rw, 11264) + half44) / total44) | 0;
          const d = (normQ8 - TSX_CRIB_RUNS_Q8[k]) | 0;
          cribErr = (cribErr + (d < 0 ? -d : d)) | 0;
        }
        if (cribErr < 2200) { // ~0.48 modules avg L1 error across all 18 runs
          state.cribMatched = 1;
          state.cribModulePxQ8 = ((total44 + 22) / 44) | 0;
          state.cribErrQ8 = cribErr;
          state.cribDir = step;
          // Sub-pixel Q8 start-bar offset along scanline (for W5 prefix-aligned stacking)
          let posQ8 = 0;
          const endIdx = step === 1 ? i : ((i + 1) | 0);
          for (let r = 0; r < endIdx; r++) {
            posQ8 = (posQ8 + runWidthsQ8[r]) | 0;
          }
          state.cribStartPxQ8 = posQ8;
          // Seed char width from 44-module average (total44 / 4 = 11 modules!)
          prevCharW = total44 >> 2;
        }
      }
    }

    while (symCount < MAX_CODE128_SYMBOLS) {
      const stopEnd = (cursor + Math.imul(6, step)) | 0;
      if (stopEnd < 0 || stopEnd >= rc) break;

      // Check Stop pattern [2,3,3,1,1,1,2] (13 modules -> Q8 sum = 3328)
      if (symCount >= 3) {
        const s0 = runWidthsQ8[cursor] | 0;
        const s1 = runWidthsQ8[(cursor + step) | 0] | 0;
        const s2 = runWidthsQ8[(cursor + (step << 1)) | 0] | 0;
        const s3 = runWidthsQ8[(cursor + Math.imul(3, step)) | 0] | 0;
        const s4 = runWidthsQ8[(cursor + (step << 2)) | 0] | 0;
        const s5 = runWidthsQ8[(cursor + Math.imul(5, step)) | 0] | 0;
        const s6 = runWidthsQ8[(cursor + Math.imul(6, step)) | 0] | 0;
        const stopSum = (s0 + s1 + s2 + s3 + s4 + s5 + s6) | 0;

        // Expected stop width = prevCharW * 13 / 11; allow [0.68x .. 1.42x]
        const expStopW = ((Math.imul(prevCharW, 303) >> 8) | 0); // 303/256 ≈ 13/11
        const minStopW = (Math.imul(expStopW, 174) >> 8) | 0;
        const maxStopW = (Math.imul(expStopW, 364) >> 8) | 0;

        if (stopSum >= minStopW && stopSum <= maxStopW && stopSum > 256) {
          const hs = stopSum >> 1;
          const sn0 = ((Math.imul(s0, 3328) + hs) / stopSum) | 0;
          const sn1 = ((Math.imul(s1, 3328) + hs) / stopSum) | 0;
          const sn2 = ((Math.imul(s2, 3328) + hs) / stopSum) | 0;
          const sn3 = ((Math.imul(s3, 3328) + hs) / stopSum) | 0;
          const sn4 = ((Math.imul(s4, 3328) + hs) / stopSum) | 0;
          const sn5 = ((Math.imul(s5, 3328) + hs) / stopSum) | 0;
          const sn6 = ((Math.imul(s6, 3328) + hs) / stopSum) | 0;

          // Edge-to-similar-edge targets for [2,3,3,1,1,1,2] in Q8: [1280, 1536, 1024, 512, 512, 768]
          let d = ((sn0 + sn1) - 1280) | 0;
          let sErr = d < 0 ? -d : d;
          d = ((sn1 + sn2) - 1536) | 0;
          sErr = (sErr + (d < 0 ? -d : d)) | 0;
          d = ((sn2 + sn3) - 1024) | 0;
          sErr = (sErr + (d < 0 ? -d : d)) | 0;
          d = ((sn3 + sn4) - 512) | 0;
          sErr = (sErr + (d < 0 ? -d : d)) | 0;
          d = ((sn4 + sn5) - 512) | 0;
          sErr = (sErr + (d < 0 ? -d : d)) | 0;
          d = ((sn5 + sn6) - 768) | 0;
          sErr = (sErr + (d < 0 ? -d : d)) | 0;

          let sInd = 0;
          d = (sn0 - 512) | 0; sInd = (sInd + (d < 0 ? -d : d)) | 0;
          d = (sn1 - 768) | 0; sInd = (sInd + (d < 0 ? -d : d)) | 0;
          d = (sn2 - 768) | 0; sInd = (sInd + (d < 0 ? -d : d)) | 0;
          d = (sn3 - 256) | 0; sInd = (sInd + (d < 0 ? -d : d)) | 0;
          d = (sn4 - 256) | 0; sInd = (sInd + (d < 0 ? -d : d)) | 0;
          d = (sn5 - 256) | 0; sInd = (sInd + (d < 0 ? -d : d)) | 0;
          d = (sn6 - 512) | 0; sInd = (sInd + (d < 0 ? -d : d)) | 0;

          const totalStopErr = (sErr + ((Math.imul(sInd, 115) >> 8) | 0)) | 0;
          if (totalStopErr <= MAX_STOP_ERR_Q8) {
            const trailIdx = (cursor + Math.imul(7, step)) | 0;
            const trailOk = trailIdx < 0 || trailIdx >= rc || runWidthsQ8[trailIdx] >= (prevCharW >> 2);
            if (trailOk) {
              stopped = 1;
              break;
            }
          }
        }
      }

      // Decode next 6-run symbol (0..102)
      const cEnd = (cursor + Math.imul(5, step)) | 0;
      if (cEnd < 0 || cEnd >= rc) break;

      const c0 = runWidthsQ8[cursor] | 0;
      const c1 = runWidthsQ8[(cursor + step) | 0] | 0;
      const c2 = runWidthsQ8[(cursor + (step << 1)) | 0] | 0;
      const c3 = runWidthsQ8[(cursor + Math.imul(3, step)) | 0] | 0;
      const c4 = runWidthsQ8[(cursor + (step << 2)) | 0] | 0;
      const c5 = runWidthsQ8[(cursor + Math.imul(5, step)) | 0] | 0;
      const charSum = (c0 + c1 + c2 + c3 + c4 + c5) | 0;

      // Local character-width continuity check ([0.66x .. 1.46x])
      const minW = (Math.imul(prevCharW, 169) >> 8) | 0;
      const maxW = (Math.imul(prevCharW, 374) >> 8) | 0;
      if (charSum < minW || charSum > maxW) break;

      const hc = charSum >> 1;
      const cn0 = ((Math.imul(c0, 2816) + hc) / charSum) | 0;
      const cn1 = ((Math.imul(c1, 2816) + hc) / charSum) | 0;
      const cn2 = ((Math.imul(c2, 2816) + hc) / charSum) | 0;
      const cn3 = ((Math.imul(c3, 2816) + hc) / charSum) | 0;
      const cn4 = ((Math.imul(c4, 2816) + hc) / charSum) | 0;
      const cn5 = ((Math.imul(c5, 2816) + hc) / charSum) | 0;
      const ce0 = (cn0 + cn1) | 0;
      const ce1 = (cn1 + cn2) | 0;
      const ce2 = (cn2 + cn3) | 0;
      const ce3 = (cn3 + cn4) | 0;

      let bestCode = 0;
      let bestErr = 999999;
      for (let code = 0; code < 103; code++) {
        const p = Math.imul(code, 6);
        const ep = code << 2;

        let d = (ce0 - eQ8[ep]) | 0;
        let err = d < 0 ? -d : d;
        d = (ce1 - eQ8[ep + 1]) | 0;
        err = (err + (d < 0 ? -d : d)) | 0;
        d = (ce2 - eQ8[ep + 2]) | 0;
        err = (err + (d < 0 ? -d : d)) | 0;
        d = (ce3 - eQ8[ep + 3]) | 0;
        err = (err + (d < 0 ? -d : d)) | 0;

        if (err >= bestErr) continue; // fast branch prune

        let ind = 0;
        d = (cn0 - patQ8[p]) | 0;
        ind = (ind + (d < 0 ? -d : d)) | 0;
        d = (cn1 - patQ8[p + 1]) | 0;
        ind = (ind + (d < 0 ? -d : d)) | 0;
        d = (cn2 - patQ8[p + 2]) | 0;
        ind = (ind + (d < 0 ? -d : d)) | 0;
        d = (cn3 - patQ8[p + 3]) | 0;
        ind = (ind + (d < 0 ? -d : d)) | 0;
        d = (cn4 - patQ8[p + 4]) | 0;
        ind = (ind + (d < 0 ? -d : d)) | 0;
        d = (cn5 - patQ8[p + 5]) | 0;
        ind = (ind + (d < 0 ? -d : d)) | 0;

        const totalErr = (err + ((Math.imul(ind, 115) >> 8) | 0)) | 0;
        if (totalErr < bestErr) {
          bestErr = totalErr;
          bestCode = code;
        }
      }

      if (bestErr > MAX_CHAR_ERR_Q8) break;

      let conf = (1024 - ((Math.imul(bestErr, 1024) / (MAX_CHAR_ERR_Q8 + 150)) | 0)) | 0;
      if (conf < 48) conf = 48;
      workSymbols[symCount] = bestCode;
      workConfsQ10[symCount] = conf;
      confSum = (confSum + conf) | 0;
      symCount = (symCount + 1) | 0;

      // Smooth integer tracking: prevCharW = (166 * prevCharW + 90 * charSum) >> 8
      prevCharW = ((Math.imul(prevCharW, 166) + Math.imul(charSum, 90)) >> 8) | 0;
      cursor = (cursor + Math.imul(6, step)) | 0;
    }

    if (stopped === 1 && symCount >= 3) {
      const avgConfQ10 = (confSum / symCount) | 0;
      const modOk = verifyCode128Checksum(workSymbols, symCount);

      if (modOk === 1) {
        const payloadLen = decodeCode128SymbolsToBytes(workSymbols, symCount, state.payloadBytes);
        if (payloadLen > 0) {
          for (let k = 0; k < symCount; k++) {
            state.symbols[k] = workSymbols[k];
            state.symbolConfsQ10[k] = workConfsQ10[k];
          }
          state.symbolCount = symCount;
          state.checksumOk = 1;
          state.stopFound = 1;
          state.avgConfidenceQ10 = avgConfQ10;
          state.payloadLen = payloadLen;

          if (multiHit === 0) {
            return 2;
          }

          // Multi-hit mode: record unique hit + pixel span along scanline, then keep scanning
          const hcNow = state.hitCount | 0;
          let dup = 0;
          for (let h = 0; h < hcNow; h++) {
            if (state.hitPayloadLens[h] !== payloadLen) continue;
            const hBase = Math.imul(h, MAX_CODE128_PAYLOAD);
            let same = 1;
            for (let k = 0; k < payloadLen; k++) {
              if (state.hitPayloads[(hBase + k) | 0] !== state.payloadBytes[k]) {
                same = 0;
                break;
              }
            }
            if (same === 1) { dup = 1; break; }
          }
          if (dup === 0 && hcNow < MAX_LINE_HITS) {
            const pBase = Math.imul(hcNow, MAX_CODE128_PAYLOAD);
            for (let k = 0; k < payloadLen; k++) state.hitPayloads[(pBase + k) | 0] = state.payloadBytes[k];
            state.hitPayloadLens[hcNow] = payloadLen;

            const sBase = Math.imul(hcNow, MAX_CODE128_SYMBOLS);
            for (let k = 0; k < symCount; k++) state.hitSymbols[(sBase + k) | 0] = workSymbols[k];
            state.hitSymbolCounts[hcNow] = symCount;

            const runA = i;
            const runB = (cursor + Math.imul(6, step)) | 0;
            const loRun = runA < runB ? runA : runB;
            const hiRun = runA > runB ? runA : runB;
            state.hitStartPx[hcNow] = state.prefixPosQ8[loRun] / 256.0;
            state.hitEndPx[hcNow] = state.prefixPosQ8[hiRun + 1] / 256.0;
            state.hitCount = (hcNow + 1) | 0;
          }

          // Jump past this barcode's Stop pattern and keep scanning this scanline
          i = (cursor + Math.imul(6, step)) | 0;
        }
      } else if (state.checksumOk === 0 && (state.stopFound === 0 || avgConfQ10 > state.avgConfidenceQ10)) {
        for (let k = 0; k < symCount; k++) {
          state.symbols[k] = workSymbols[k];
          state.symbolConfsQ10[k] = workConfsQ10[k];
        }
        state.symbolCount = symCount;
        state.stopFound = 1;
        state.avgConfidenceQ10 = avgConfQ10;
      }
    }
  }

  return multiHit === 1 ? (state.hitCount > 0 ? 2 : state.stopFound) : state.stopFound;
}

/**
 * Decodes a Code 128 candidate from Stage 3 Q8 fixed-point run widths (forward & reverse).
 * Strictly zero heap allocations and zero float boxing.
 */
export function decodeCode128FromRuns(runWidthsQ8, runIsBar, runCount, state) {
  state.symbolCount = 0;
  state.checksumOk = 0;
  state.stopFound = 0;
  state.avgConfidenceQ10 = 0;
  state.payloadLen = 0;

  const fwd = tryDecodeDirection(runWidthsQ8, runIsBar, runCount, 1, state, 0);
  if (fwd === 2) return 2;

  const rev = tryDecodeDirection(runWidthsQ8, runIsBar, runCount, -1, state, 0);
  if (rev === 2) return 2;

  return state.stopFound;
}

/**
 * Decodes ALL valid Code 128 barcodes crossed by a single scanline (both forward & reverse),
 * storing each unique hit + its exact pixel span along the scanline in `state.hit*`.
 * Essential when stacked cartons share a horizontal/vertical seam and merge into one cluster.
 *
 * @returns {number} Number of distinct Mod-103-valid Code 128 barcodes found on this scanline
 */
export function decodeAllCode128FromRuns(runWidthsQ8, runIsBar, runCount, state) {
  state.symbolCount = 0;
  state.checksumOk = 0;
  state.stopFound = 0;
  state.avgConfidenceQ10 = 0;
  state.payloadLen = 0;
  state.hitCount = 0;

  // Build prefix pixel offsets once per scanline (Q8 integers, zero allocations)
  const rc = runCount | 0;
  const pref = state.prefixPosQ8;
  let acc = 0;
  pref[0] = 0;
  for (let r = 0; r < rc; r++) {
    acc = (acc + runWidthsQ8[r]) | 0;
    pref[r + 1] = acc;
  }

  tryDecodeDirection(runWidthsQ8, runIsBar, rc, 1, state, 1);
  tryDecodeDirection(runWidthsQ8, runIsBar, rc, -1, state, 1);
  return state.hitCount;
}
