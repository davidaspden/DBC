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

import { FLAG_CRIB_MATCH, FLAG_STOP_GUARD } from '../flagbits.js';

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

// H6 (flagged `cribMatch`): pre-computed 4 KB O(1) LUT mapping 6 packed 2-bit run widths ((r-1) in 0..3)
// directly to Code 128 symbol codes 0..102 (-1 = invalid). Allocated once at module load.
const CODE128_FAST_LUT = new Int8Array(4096);
CODE128_FAST_LUT.fill(-1);
for (let c = 0; c < 103; c++) {
  const p = c * 6;
  const key =
    ((CODE128_PATTERNS[p] - 1) << 10) |
    ((CODE128_PATTERNS[p + 1] - 1) << 8) |
    ((CODE128_PATTERNS[p + 2] - 1) << 6) |
    ((CODE128_PATTERNS[p + 3] - 1) << 4) |
    ((CODE128_PATTERNS[p + 4] - 1) << 2) |
    (CODE128_PATTERNS[p + 5] - 1);
  CODE128_FAST_LUT[key] = c;
}

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

    // H6 telemetry counters (pure int32, zero allocations)
    cribFastAttempts: 0,
    cribFastSuccess: 0,
    cribFastFallbacks: 0,
    cribSymbolsFast: 0,
    cribSymbolsFull: 0,

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

  const stopGuardOn = (state.flags & FLAG_STOP_GUARD) !== 0;

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
    let dataSpanQ8 = startSum;
    let stopSpanQ8 = 0;
    let cursor = (i + Math.imul(6, step)) | 0;
    let stopped = 0;

    // W3 / H6 (flagged `cribMatch`): match 44-module StartB+'t'+'s'+'X' crib for rock-solid module scale
    let cribLocalMatched = 0;
    let cribTotal44 = 0;
    const cribFlagOn = (state.flags & FLAG_CRIB_MATCH) !== 0;
    if (
      cribFlagOn &&
      bestStart === CODE128_START_B &&
      ((step === 1 && cursor + 18 < rc) || (step === -1 && cursor - 18 >= 0))
    ) {
      let cribSum = 0;
      for (let k = 0; k < 18; k++) {
        cribSum = (cribSum + runWidthsQ8[(cursor + Math.imul(k, step)) | 0]) | 0;
      }
      const total44 = (startSum + cribSum) | 0;
      if (total44 >= (startSum << 1) && total44 <= (startSum << 3) && total44 > 256) {
        // Single division replaces 18 per-run divisions: 44 * 256 * 16384 = 184549376 (< 2^31)
        const scaleQ22 = ((184549376 + (total44 >> 1)) / total44) | 0;
        const maxCribRunQ8 = total44 >> 3; // 5.5 modules -> prevents int32 overflow & fast-rejects >4 mod runs
        let cribErr = 0;
        for (let k = 0; k < 18; k++) {
          const rw = runWidthsQ8[(cursor + Math.imul(k, step)) | 0] | 0;
          if (rw > maxCribRunQ8) { cribErr = 2200; break; }
          const normQ8 = ((Math.imul(rw, scaleQ22) + 8192) >> 14) | 0;
          const d = (normQ8 - TSX_CRIB_RUNS_Q8[k]) | 0;
          cribErr = (cribErr + (d < 0 ? -d : d)) | 0;
          if (cribErr >= 2200) break; // early bailout on non-tsX labels
        }
        if (cribErr < 2200) { // ~0.48 modules avg L1 error across all 18 runs
          cribLocalMatched = 1;
          cribTotal44 = total44;
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

    // H6 (`cribMatch` fast path): when the 44-module StartB+'t'+'s'+'X' crib matches, decode
    // remaining symbols directly via O(1) LUT using the crib-seeded character width window
    // (tolerance +/- 0.30 module per run, no 103-symbol search or per-symbol scale search).
    // Falls back cleanly to the existing full search on tolerance miss or Mod-103 checksum failure.
    let fastDecoded = 0;
    if (cribLocalMatched === 1) {
      state.cribFastAttempts = (state.cribFastAttempts + 1) | 0;
      const TOL_Q8 = 77; // +/- 0.30 module in Q8 (0.3 * 256 = 76.8)
      const fastLut = CODE128_FAST_LUT;

      workSymbols[1] = 84; // 't'
      workSymbols[2] = 83; // 's'
      workSymbols[3] = 56; // 'X'
      workConfsQ10[1] = 960;
      workConfsQ10[2] = 960;
      workConfsQ10[3] = 960;
      let fSymCount = 4;
      let fConfSum = (confSum + 2880) | 0;
      let fCharW = cribTotal44 >> 2; // 11-module width seeded from 44-module crib
      let fDataSpanQ8 = cribTotal44;
      let fStopSpanQ8 = 0;
      let fCursor = (cursor + Math.imul(18, step)) | 0;
      let fStopped = 0;
      let fAborted = 0;

      while (fSymCount < MAX_CODE128_SYMBOLS) {
        const stopEnd = (fCursor + Math.imul(6, step)) | 0;
        if (stopEnd < 0 || stopEnd >= rc) { fAborted = 1; break; }

        const s0 = runWidthsQ8[fCursor] | 0;
        const s1 = runWidthsQ8[(fCursor + step) | 0] | 0;
        const s2 = runWidthsQ8[(fCursor + (step << 1)) | 0] | 0;
        const s3 = runWidthsQ8[(fCursor + Math.imul(3, step)) | 0] | 0;
        const s4 = runWidthsQ8[(fCursor + (step << 2)) | 0] | 0;
        const s5 = runWidthsQ8[(fCursor + Math.imul(5, step)) | 0] | 0;
        const s6 = runWidthsQ8[(fCursor + Math.imul(6, step)) | 0] | 0;

        // Check Stop [2,3,3,1,1,1,2] (13 modules) within tight fixed-scale window [0.78x..1.28x]
        const stopSum = (s0 + s1 + s2 + s3 + s4 + s5 + s6) | 0;
        const expStopW = (Math.imul(fCharW, 303) >> 8) | 0; // 13/11 * fCharW
        if (
          stopSum > 256 &&
          stopSum >= ((Math.imul(expStopW, 200) >> 8) | 0) &&
          stopSum <= ((Math.imul(expStopW, 328) >> 8) | 0)
        ) {
          // 13 * 256 * 16384 = 54525952 (< 2^31; s_k <= stopSum so s_k * invStop <= 54.5M)
          const invStopQ22 = ((54525952 + (stopSum >> 1)) / stopSum) | 0;
          let d0 = (((Math.imul(s0, invStopQ22) + 8192) >> 14) - 512) | 0; if (d0 < 0) d0 = -d0;
          let d1 = (((Math.imul(s1, invStopQ22) + 8192) >> 14) - 768) | 0; if (d1 < 0) d1 = -d1;
          let d2 = (((Math.imul(s2, invStopQ22) + 8192) >> 14) - 768) | 0; if (d2 < 0) d2 = -d2;
          let d3 = (((Math.imul(s3, invStopQ22) + 8192) >> 14) - 256) | 0; if (d3 < 0) d3 = -d3;
          let d4 = (((Math.imul(s4, invStopQ22) + 8192) >> 14) - 256) | 0; if (d4 < 0) d4 = -d4;
          let d5 = (((Math.imul(s5, invStopQ22) + 8192) >> 14) - 256) | 0; if (d5 < 0) d5 = -d5;
          let d6 = (((Math.imul(s6, invStopQ22) + 8192) >> 14) - 512) | 0; if (d6 < 0) d6 = -d6;

          if (
            d0 <= TOL_Q8 && d1 <= TOL_Q8 && d2 <= TOL_Q8 && d3 <= TOL_Q8 &&
            d4 <= TOL_Q8 && d5 <= TOL_Q8 && d6 <= TOL_Q8
          ) {
            const trailIdx = (fCursor + Math.imul(7, step)) | 0;
            const minTrailW = (Math.imul(fCharW, 82) >> 8) | 0; // ~3.52 modules
            const trailOk = stopGuardOn
              ? (trailIdx >= 0 && trailIdx < rc && runIsBar[trailIdx] === 0 && runWidthsQ8[trailIdx] >= minTrailW)
              : (trailIdx < 0 || trailIdx >= rc || runWidthsQ8[trailIdx] >= minTrailW);
            if (trailOk) {
              fStopSpanQ8 = stopSum;
              fStopped = 1;
              break;
            }
          }
        }

        // Fixed-scale window [0.78x..1.28x] around crib-seeded width + O(1) LUT (no 103-way search)
        const charSum = (s0 + s1 + s2 + s3 + s4 + s5) | 0;
        if (
          charSum <= 256 ||
          charSum < ((Math.imul(fCharW, 200) >> 8) | 0) ||
          charSum > ((Math.imul(fCharW, 328) >> 8) | 0)
        ) {
          fAborted = 1;
          break;
        }

        // 11 * 256 * 16384 = 46137344 (< 2^31; s_k <= charSum so s_k * invChar <= 46.1M)
        const invCharQ22 = ((46137344 + (charSum >> 1)) / charSum) | 0;
        const m0 = ((Math.imul(s0, invCharQ22) + 8192) >> 14) | 0;
        const m1 = ((Math.imul(s1, invCharQ22) + 8192) >> 14) | 0;
        const m2 = ((Math.imul(s2, invCharQ22) + 8192) >> 14) | 0;
        const m3 = ((Math.imul(s3, invCharQ22) + 8192) >> 14) | 0;
        const m4 = ((Math.imul(s4, invCharQ22) + 8192) >> 14) | 0;
        const m5 = ((Math.imul(s5, invCharQ22) + 8192) >> 14) | 0;

        const q0 = (m0 + 128) >> 8;
        const q1 = (m1 + 128) >> 8;
        const q2 = (m2 + 128) >> 8;
        const q3 = (m3 + 128) >> 8;
        const q4 = (m4 + 128) >> 8;
        const q5 = (m5 + 128) >> 8;

        if (
          q0 < 1 || q0 > 4 || q1 < 1 || q1 > 4 || q2 < 1 || q2 > 4 ||
          q3 < 1 || q3 > 4 || q4 < 1 || q4 > 4 || q5 < 1 || q5 > 4 ||
          ((q0 + q1 + q2 + q3 + q4 + q5) | 0) !== 11
        ) {
          fAborted = 1;
          break;
        }

        let e0 = (m0 - (q0 << 8)) | 0; if (e0 < 0) e0 = -e0;
        let e1 = (m1 - (q1 << 8)) | 0; if (e1 < 0) e1 = -e1;
        let e2 = (m2 - (q2 << 8)) | 0; if (e2 < 0) e2 = -e2;
        let e3 = (m3 - (q3 << 8)) | 0; if (e3 < 0) e3 = -e3;
        let e4 = (m4 - (q4 << 8)) | 0; if (e4 < 0) e4 = -e4;
        let e5 = (m5 - (q5 << 8)) | 0; if (e5 < 0) e5 = -e5;

        if (e0 > TOL_Q8 || e1 > TOL_Q8 || e2 > TOL_Q8 || e3 > TOL_Q8 || e4 > TOL_Q8 || e5 > TOL_Q8) {
          fAborted = 1;
          break;
        }

        const key =
          ((q0 - 1) << 10) | ((q1 - 1) << 8) | ((q2 - 1) << 6) |
          ((q3 - 1) << 4) | ((q4 - 1) << 2) | (q5 - 1);
        const code = fastLut[key];
        if (code < 0) {
          fAborted = 1;
          break;
        }

        workSymbols[fSymCount] = code;
        workConfsQ10[fSymCount] = 960;
        fConfSum = (fConfSum + 960) | 0;
        fSymCount = (fSymCount + 1) | 0;
        if (stopGuardOn) fDataSpanQ8 = (fDataSpanQ8 + charSum) | 0;
        fCharW = ((Math.imul(fCharW, 128) + Math.imul(charSum, 128)) >> 8) | 0;
        fCursor = (fCursor + Math.imul(6, step)) | 0;
      }

      if (fAborted === 0 && fStopped === 1 && fSymCount >= 5 && verifyCode128Checksum(workSymbols, fSymCount) === 1) {
        symCount = fSymCount;
        confSum = fConfSum;
        prevCharW = fCharW;
        dataSpanQ8 = fDataSpanQ8;
        stopSpanQ8 = fStopSpanQ8;
        cursor = fCursor;
        stopped = 1;
        fastDecoded = 1;
        state.cribFastSuccess = (state.cribFastSuccess + 1) | 0;
        state.cribSymbolsFast = (state.cribSymbolsFast + (fSymCount - 1)) | 0;
      } else {
        state.cribFastFallbacks = (state.cribFastFallbacks + 1) | 0;
      }
    }

    if (fastDecoded === 0) while (symCount < MAX_CODE128_SYMBOLS) {
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

        // Expected stop width = prevCharW * 13 / 11; baseline allows [0.68x .. 1.42x],
        // F1 (`stopGuard`) tightens local Stop width to [0.76x .. 1.32x] and verifies global mean scale.
        const expStopW = ((Math.imul(prevCharW, 303) >> 8) | 0); // 303/256 ≈ 13/11
        const minStopW = (Math.imul(expStopW, stopGuardOn ? 195 : 174) >> 8) | 0;
        const maxStopW = (Math.imul(expStopW, stopGuardOn ? 338 : 364) >> 8) | 0;

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
          const stopErrCap = stopGuardOn ? 640 : MAX_STOP_ERR_Q8;
          if (totalStopErr <= stopErrCap) {
            const trailIdx = (cursor + Math.imul(7, step)) | 0;
            // H2/F1: When cribMatch or stopGuard is active, require >= ~3.52 modules trailing quiet zone
            // (strictly > 3.0) so Stop's own 3-module internal space cannot validate a false early Stop.
            // F1 (`stopGuard`) additionally requires an actually observed trailing light space (rejects
            // clipped tails ending on a bar at scanline boundary) and mean-scale Stop width consistency.
            const minTrailW = (stopGuardOn || cribFlagOn)
              ? ((Math.imul(prevCharW, 82) >> 8) | 0)
              : (prevCharW >> 2);
            let trailOk = stopGuardOn
              ? (trailIdx >= 0 && trailIdx < rc && runIsBar[trailIdx] === 0 && runWidthsQ8[trailIdx] >= minTrailW)
              : (trailIdx < 0 || trailIdx >= rc || runWidthsQ8[trailIdx] >= minTrailW);
            if (trailOk && stopGuardOn) {
              const meanCharW = (dataSpanQ8 / symCount) | 0;
              const expStopMean = (Math.imul(meanCharW, 303) >> 8) | 0;
              if (
                stopSum < ((Math.imul(expStopMean, 174) >> 8) | 0) ||
                stopSum > ((Math.imul(expStopMean, 371) >> 8) | 0)
              ) {
                trailOk = false;
              }
            }
            if (trailOk) {
              stopSpanQ8 = stopSum;
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

      if (cribFlagOn) {
        state.cribSymbolsFull = (state.cribSymbolsFull + 1) | 0;
      }

      if (bestErr > MAX_CHAR_ERR_Q8) break;

      let conf = (1024 - ((Math.imul(bestErr, 1024) / (MAX_CHAR_ERR_Q8 + 150)) | 0)) | 0;
      if (conf < 48) conf = 48;
      workSymbols[symCount] = bestCode;
      workConfsQ10[symCount] = conf;
      confSum = (confSum + conf) | 0;
      symCount = (symCount + 1) | 0;

      // Smooth integer tracking: prevCharW = (166 * prevCharW + 90 * charSum) >> 8
      if (stopGuardOn) dataSpanQ8 = (dataSpanQ8 + charSum) | 0;
      prevCharW = ((Math.imul(prevCharW, 166) + Math.imul(charSum, 90)) >> 8) | 0;
      cursor = (cursor + Math.imul(6, step)) | 0;
    }

    if (stopped === 1 && symCount >= 3) {
      const avgConfQ10 = (confSum / symCount) | 0;

      // F1 (`stopGuard`): Pure-integer span consistency & oblique-tail Mod-103 collision guard.
      // Root cause on oblique low-PPM (~1.35 px/mod) tails (e.g. `fc-tele-30-3p5` cell R4C1
      // `tsX41A00013B` -> `tsX41A00013!`): the 2-px central-difference kernel (`s[i+1]-s[i-1]`)
      // pushes apart opposing edges of <1.5 px 1-module runs, severely distorting run ratios across
      // the barcode (`avgConfQ10 ~ 385..442`) and flipping both the last data symbol ('B'=34 -> '!'=1,
      // conf ~ 369..424) and Mod-103 check symbol (99 -> 12, conf ~ 261..332) into a Mod-103
      // coincidence (`12*(1-34) ≡ 12-99 mod 103`) repeated across adjacent scanlines.
      // Rejecting low-confidence/distorted or span-inconsistent candidates here lets consensus
      // fall through to the blur/low-PPM-resilient mid-crossing extractor (which decodes the true
      // label at `avgConfQ10 ~ 949`). Zero allocations, pure 32-bit integer arithmetic.
      let guardOk = 1;
      if (stopGuardOn) {
        const meanCharW = (dataSpanQ8 / symCount) | 0;
        const totalSpanQ8 = (dataSpanQ8 + stopSpanQ8) | 0;
        const totalMods = (Math.imul(symCount, 11) + 13) | 0;
        const avgEndCharW = (startSum + prevCharW) >> 1;
        const expTotalQ8 = ((Math.imul(avgEndCharW, totalMods) + 5) / 11) | 0;

        if (
          prevCharW < ((Math.imul(startSum, 159) >> 8) | 0) ||
          prevCharW > ((Math.imul(startSum, 410) >> 8) | 0) ||
          prevCharW < ((Math.imul(meanCharW, 184) >> 8) | 0) ||
          prevCharW > ((Math.imul(meanCharW, 353) >> 8) | 0) ||
          totalSpanQ8 < ((Math.imul(expTotalQ8, 205) >> 8) | 0) ||
          totalSpanQ8 > ((Math.imul(expTotalQ8, 318) >> 8) | 0)
        ) {
          guardOk = 0;
        } else if (fastDecoded === 0) {
          const checkConf = workConfsQ10[(symCount - 1) | 0] | 0;
          const lastDataConf = workConfsQ10[(symCount - 2) | 0] | 0;
          if (avgConfQ10 < 480 || checkConf < 380 || ((lastDataConf + checkConf) | 0) < 820) {
            guardOk = 0;
          } else {
            // Mod-103 is prime: any aligned false decode requires >= 2 simultaneously misread symbols.
            // Track the 2nd-lowest symbol confidence and reject if >= 2 symbols are weak (< 360).
            let min1 = 1024;
            let min2 = 1024;
            for (let k = 0; k < symCount; k++) {
              const ck = workConfsQ10[k] | 0;
              if (ck < min1) {
                min2 = min1;
                min1 = ck;
              } else if (ck < min2) {
                min2 = ck;
              }
            }
            if (min2 < 360) guardOk = 0;
          }
        }
      }

      if (guardOk === 0) continue;

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
