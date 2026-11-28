/**
 * Stage 4 & Stage 5: Soft Decoding & Multi-Scanline Consensus Engine (Code 128).
 *
 * Pure 32-bit integer, zero-allocation three-tier consensus enforcing Stage 5 gates
 * (strict Modulo 103 mathematical checksum + >= 2 agreeing scanlines):
 *
 *  Tier A — Fast Exact Payload Consensus (Center-Outward Early Exit):
 *    Samples and decodes scanlines on demand. Immediately locks and exits as soon as
 *    any Mod-103-valid payload reaches >= 2 agreeing scanlines (typically 2 lines / <0.25 ms).
 *
 *  Tier B — Cross-Scanline Character-Level Soft Voting:
 *    Aggregates Q10 per-position symbol confidence votes across Stop-anchored scanlines
 *    sharing the same symbol count, then validates via strict Modulo 103.
 *
 *  Tier C — Aligned Parallel Grayscale Profile Averaging + 1D Motion-Blur Unsharp Pass:
 *    In RoI mode, averages adjacent parallel scanlines (aligned in Q16 along theta) to
 *    suppress sensor noise, and tests both the denoised profile and a 1D unsharp-sharpened
 *    profile (`2*s[i] - (s[i-2] + s[i+2])/2`) to cancel 4–5 px motion blur / defocus,
 *    still strictly gated by Modulo 103 and >= 2 agreeing votes.
 *
 * Zero-Allocation Guarantee:
 *  Zero floats in hot loops, zero V8 HeapNumber allocations, all buffers allocated once.
 */

import {
  FLAG_EXTRA_LINES,
  FLAG_CRIB_MATCH,
  FLAG_REQUIRE_PREFIX,
  FLAG_REQUIRE_PREFIX_STRICT,
  FLAG_PREFIX_STACK,
  FLAG_ILLUM_NORM,
  FLAG_SUBPIX_EDGES,
  FLAG_DEBLUR_1D,
  FLAG_DECODE_ANCHOR,
  FLAG_MODULE_EST,
  FLAG_BLUR_EDGES,
  FLAG_MATCH_FILTER,
} from './flagbits.js';
import {
  MAX_SCANLINES,
  MAX_SCANLINE_LEN,
  MAX_RUNS,
  buildScanlinePlan,
  sampleScanlineLuma,
  normaliseScanlineLuma,
  deblurScanlineLuma,
  extractRunsFromScanline,
  extractRunsLocalMidCrossing,
  extractRunsBlurResilient,
  fuseEdgeBanksToRuns,
  estimateModuleWidthQ8,
  matchFilterScanline,
} from './scanline.js';
import {
  MAX_CODE128_SYMBOLS,
  MAX_CODE128_PAYLOAD,
  createCode128State,
  decodeCode128FromRuns,
  decodeAllCode128FromRuns,
  verifyCode128Checksum,
  decodeCode128SymbolsToBytes,
} from './decoders/code128.js';

export const SYMBOLOGY_NONE = 0;
export const SYMBOLOGY_CODE_128 = 1;
export const MIN_CONSENSUS_AGREEMENT = 2;

const MAX_EXACT_SLOTS = MAX_SCANLINES + 12;

/**
 * Pre-allocates all Stage 4/5 consensus buffers once during worker initialization.
 */
export function createConsensusState() {
  return {
    c128: createCode128State(),

    // Tier A exact payload slot table (flat buffer, zero allocations)
    slotCount: 0,
    slotPayloads: new Uint8Array(MAX_EXACT_SLOTS * MAX_CODE128_PAYLOAD),
    slotLens: new Uint16Array(MAX_EXACT_SLOTS),
    slotVotes: new Uint16Array(MAX_EXACT_SLOTS),
    slotLastLine: new Int16Array(MAX_EXACT_SLOTS),
    slotSymbols: new Uint8Array(MAX_EXACT_SLOTS * MAX_CODE128_SYMBOLS),
    slotSymCounts: new Uint8Array(MAX_EXACT_SLOTS),
    slotMinX: new Float32Array(MAX_EXACT_SLOTS),
    slotMinY: new Float32Array(MAX_EXACT_SLOTS),
    slotMaxX: new Float32Array(MAX_EXACT_SLOTS),
    slotMaxY: new Float32Array(MAX_EXACT_SLOTS),
    slotSpanSum: new Float32Array(MAX_EXACT_SLOTS),
    // B8 (`decodeAnchor`): running sum of decoded-span midpoints (full-frame px) and its hit count per slot
    slotMidSumX: new Float64Array(MAX_EXACT_SLOTS),
    slotMidSumY: new Float64Array(MAX_EXACT_SLOTS),
    slotMidN: new Int32Array(MAX_EXACT_SLOTS),
    // B8 part 2 (`decodeAnchor`): decoded span of the last Tier C profile decode, as [startPx, endPx] along
    // `tcLine` (scanline sample coordinates); `tcValid` is reset per consensus call
    tcValid: 0,
    tcLine: 0,
    tcSpan: new Float64Array(2),

    // Tier B soft candidate bank (integer Q10 confidences)
    softCount: 0,
    softSymCounts: new Uint8Array(MAX_SCANLINES),
    softSymbols: new Uint8Array(MAX_SCANLINES * MAX_CODE128_SYMBOLS),
    softConfsQ10: new Int32Array(MAX_SCANLINES * MAX_CODE128_SYMBOLS),
    lenHist: new Uint8Array(MAX_CODE128_SYMBOLS + 1),
    voteMatrix: new Int32Array(MAX_CODE128_SYMBOLS * 106),
    votedSymbols: new Uint8Array(MAX_CODE128_SYMBOLS),
    votedPayload: new Uint8Array(MAX_CODE128_PAYLOAD),
    lastLineIdx: 0,

    // W5 (`prefixStack`): pre-allocated per-line crib anchors & stacking scratch
    lineCribMatched: new Uint8Array(MAX_SCANLINES),
    lineCribStartPxQ8: new Int32Array(MAX_SCANLINES),
    lineCribErrQ8: new Int32Array(MAX_SCANLINES),
    lineCribDir: new Int8Array(MAX_SCANLINES),
    stackLines: new Int8Array(MAX_SCANLINES),
    stackShifts: new Int32Array(MAX_SCANLINES),
    stackWeights: new Int32Array(MAX_SCANLINES),
  };
}

/**
 * Records a Mod-103-validated payload into the Tier A exact consensus table.
 */
function recordExactVote(cState, payloadBytes, payloadLen) {
  const slotCount = cState.slotCount | 0;
  const slotPayloads = cState.slotPayloads;
  const slotLens = cState.slotLens;
  const slotVotes = cState.slotVotes;
  const len = payloadLen | 0;

  for (let s = 0; s < slotCount; s++) {
    if (slotLens[s] !== len) continue;
    const base = Math.imul(s, MAX_CODE128_PAYLOAD);
    let same = 1;
    for (let k = 0; k < len; k++) {
      if (slotPayloads[(base + k) | 0] !== payloadBytes[k]) {
        same = 0;
        break;
      }
    }
    if (same === 1) {
      const votes = (slotVotes[s] + 1) | 0;
      slotVotes[s] = votes;
      return votes;
    }
  }

  if (slotCount < MAX_EXACT_SLOTS) {
    const base = Math.imul(slotCount, MAX_CODE128_PAYLOAD);
    for (let k = 0; k < len; k++) {
      slotPayloads[(base + k) | 0] = payloadBytes[k];
    }
    slotLens[slotCount] = len;
    slotVotes[slotCount] = 1;
    cState.slotCount = (slotCount + 1) | 0;
    return 1;
  }
  return 0;
}

/**
 * Copies a winning validated Code 128 payload & raw symbols into the pre-allocated ScanResult struct.
 */
function emitResult(result, payloadBytes, payloadLen, symbols, symbolCount, agreeCount) {
  const out = result.payloadBytes;
  const maxCopy = out.length < payloadLen ? out.length : payloadLen;
  for (let i = 0; i < maxCopy; i++) {
    out[i] = payloadBytes[i];
  }
  const symOut = result.symbolBytes;
  if (symOut) {
    const maxSym = symOut.length < symbolCount ? symOut.length : symbolCount;
    for (let i = 0; i < maxSym; i++) {
      symOut[i] = symbols[i];
    }
    result.symbolCount = maxSym | 0;
  }
  result.detected = 1;
  result.symbologyId = SYMBOLOGY_CODE_128;
  result.payloadLen = maxCopy | 0;
  result.consensusCount = agreeCount | 0;
}

/**
 * Stores a Stop-anchored candidate from `cState.c128` into the Tier B soft vote bank.
 */
function storeSoftCandidate(cState) {
  const idx = cState.softCount | 0;
  if (idx >= MAX_SCANLINES) return;
  const c128 = cState.c128;
  const symCount = c128.symbolCount | 0;
  if (symCount < 3 || symCount > MAX_CODE128_SYMBOLS) return;

  cState.softSymCounts[idx] = symCount;
  const base = Math.imul(idx, MAX_CODE128_SYMBOLS);
  for (let k = 0; k < symCount; k++) {
    cState.softSymbols[(base + k) | 0] = c128.symbols[k];
    cState.softConfsQ10[(base + k) | 0] = c128.symbolConfsQ10[k];
  }
  cState.softCount = (idx + 1) | 0;
}

/**
 * Tier B: Cross-scanline character-level soft voting across Stop-anchored scanlines.
 */
function tryTierBSoftVoting(cState, result) {
  const softCount = cState.softCount | 0;
  if (softCount < MIN_CONSENSUS_AGREEMENT) return 0;

  const lenHist = cState.lenHist;
  for (let i = 0; i <= MAX_CODE128_SYMBOLS; i++) lenHist[i] = 0;

  let bestLen = 0;
  let bestLenCount = 0;
  for (let i = 0; i < softCount; i++) {
    const sc = cState.softSymCounts[i];
    const next = (lenHist[sc] + 1) | 0;
    lenHist[sc] = next;
    if (next > bestLenCount) {
      bestLenCount = next;
      bestLen = sc;
    }
  }

  if (bestLenCount < MIN_CONSENSUS_AGREEMENT || bestLen < 3) return 0;

  const voteMatrix = cState.voteMatrix;
  const matrixLen = Math.imul(bestLen, 106);
  for (let i = 0; i < matrixLen; i++) voteMatrix[i] = 0;

  for (let i = 0; i < softCount; i++) {
    if (cState.softSymCounts[i] !== bestLen) continue;
    const sBase = Math.imul(i, MAX_CODE128_SYMBOLS);
    for (let pos = 0; pos < bestLen; pos++) {
      const sym = cState.softSymbols[(sBase + pos) | 0];
      const conf = cState.softConfsQ10[(sBase + pos) | 0];
      const mIdx = (Math.imul(pos, 106) + sym) | 0;
      voteMatrix[mIdx] = (voteMatrix[mIdx] + conf) | 0;
    }
  }

  const votedSymbols = cState.votedSymbols;
  for (let pos = 0; pos < bestLen; pos++) {
    const rowOff = Math.imul(pos, 106);
    let bestSym = 0;
    let bestScore = -1;
    const symMin = pos === 0 ? 103 : 0;
    const symMax = pos === 0 ? 106 : 103;
    for (let s = symMin; s < symMax; s++) {
      const v = voteMatrix[(rowOff + s) | 0] | 0;
      if (v > bestScore) {
        bestScore = v;
        bestSym = s;
      }
    }
    votedSymbols[pos] = bestSym;
  }

  if (verifyCode128Checksum(votedSymbols, bestLen) === 1) {
    const payloadLen = decodeCode128SymbolsToBytes(votedSymbols, bestLen, cState.votedPayload);
    if (payloadLen > 0) {
      if ((cState.c128.flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0 && !hasTsXPrefixBytes(cState.votedPayload, 0, payloadLen)) {
        return 0;
      }
      emitResult(result, cState.votedPayload, payloadLen, votedSymbols, bestLen, bestLenCount);
      return 1;
    }
  }
  return 0;
}

/**
 * B8 part 2 (`decodeAnchor`): after a Tier C profile decode, converts the decoded symbol's start and stop
 * run positions into scanline sample coordinates on `lineIdx` (`profileOffset` = scanline index of the
 * profile's sample 0) so the reported box can sit on the decoded bars. Runs only on a successful decode.
 */
function recordTierCSpan(scanState, cState, lineIdx, profileOffset) {
  if ((scanState.flags & FLAG_DECODE_ANCHOR) === 0) return;
  const c128 = cState.c128;
  const a = c128.spanRunA | 0;
  const b = c128.spanRunB | 0;
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  const widths = scanState.runWidthsQ8;
  let acc = scanState.runOriginQ8 | 0;
  for (let r = 0; r < lo; r++) acc = (acc + widths[r]) | 0;
  const startQ8 = acc;
  for (let r = lo; r <= hi; r++) acc = (acc + widths[r]) | 0;
  cState.tcSpan[0] = profileOffset + startQ8 / 256.0;
  cState.tcSpan[1] = profileOffset + acc / 256.0;
  cState.tcLine = lineIdx | 0;
  cState.tcValid = 1;
}

/**
 * W5 (flagged `prefixStack`): Aligns scanlines where W3 detected the `tsX` crib on their
 * exact sub-pixel start-bar edge, weights inversely by crib error, and decodes the composite.
 * Pure integer math, zero heap allocations.
 */
function tryPrefixAlignedStacking(scanState, cState, result) {
  const lineCount = scanState.lineCount | 0;
  const matched = cState.lineCribMatched;
  const startsQ8 = cState.lineCribStartPxQ8;
  const errsQ8 = cState.lineCribErrQ8;
  const dirs = cState.lineCribDir;

  // Pick dominant direction (+1 or -1) with >= 2 crib hits and lowest-error anchor line
  let fwdCount = 0;
  let revCount = 0;
  let bestFwd = -1;
  let bestFwdErr = 0x7fffffff;
  let bestRev = -1;
  let bestRevErr = 0x7fffffff;

  for (let i = 0; i < lineCount; i++) {
    if (matched[i] !== 1) continue;
    const e = errsQ8[i] | 0;
    if (dirs[i] >= 0) {
      fwdCount++;
      if (e < bestFwdErr) { bestFwdErr = e; bestFwd = i; }
    } else {
      revCount++;
      if (e < bestRevErr) { bestRevErr = e; bestRev = i; }
    }
  }

  const targetDir = fwdCount >= revCount ? 1 : -1;
  const refLine = targetDir === 1 ? bestFwd : bestRev;
  const nMatch = targetDir === 1 ? fwdCount : revCount;
  if (nMatch < 2 || refLine < 0) return 0;

  const stackLines = cState.stackLines;
  const stackShifts = cState.stackShifts;
  const stackWeights = cState.stackWeights;
  const refStartQ8 = startsQ8[refLine] | 0;
  const refLen = scanState.lineLength[refLine] | 0;

  let mCount = 0;
  let iStart = 0;
  let iEnd = refLen;
  let totalW = 0;

  for (let i = 0; i < lineCount; i++) {
    if (matched[i] !== 1) continue;
    if ((dirs[i] >= 0 ? 1 : -1) !== targetDir) continue;
    const shift = ((startsQ8[i] - refStartQ8 + 128) >> 8) | 0;
    const lLen = scanState.lineLength[i] | 0;
    if (-shift > iStart) iStart = -shift;
    if (lLen - shift < iEnd) iEnd = (lLen - shift) | 0;
    let w = ((2400 - errsQ8[i]) >> 6) | 0;
    if (w < 1) w = 1;
    stackLines[mCount] = i;
    stackShifts[mCount] = shift;
    stackWeights[mCount] = w;
    totalW = (totalW + w) | 0;
    mCount++;
  }

  const span = (iEnd - iStart) | 0;
  if (mCount < 2 || span < 64 || totalW <= 0) return 0;

  const lumaBank = scanState.lumaBank;
  const avgBuf = scanState.avgLumaBuf;
  const halfW = totalW >> 1;

  for (let x = 0; x < span; x++) {
    let acc = 0;
    const refPos = (iStart + x) | 0;
    for (let m = 0; m < mCount; m++) {
      const idx = (Math.imul(stackLines[m], MAX_SCANLINE_LEN) + refPos + stackShifts[m]) | 0;
      acc = (acc + Math.imul(lumaBank[idx], stackWeights[m])) | 0;
    }
    avgBuf[x] = ((acc + halfW) / totalW) | 0;
  }

  const c128 = cState.c128;
  const useBlurEdges = (scanState.flags & FLAG_BLUR_EDGES) !== 0;
  const useMatchFilter = (scanState.flags & FLAG_MATCH_FILTER) !== 0;
  c128.mfValid = 0;
  for (let pass = 0; pass < 2; pass++) {
    const runCount = pass === 0
      ? extractRunsLocalMidCrossing(avgBuf, 0, span, scanState, 20)
      : extractRunsFromScanline(avgBuf, 0, span, scanState, 66, 15);
    if (runCount < 25) continue;
    if (useMatchFilter && pass === 0) {
      matchFilterScanline(avgBuf, 0, span, scanState, c128, 0);
    }
    if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
    const status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount, c128);
    if (status === 2) {
      if ((c128.flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0 && !hasTsXPrefixBytes(c128.payloadBytes, 0, c128.payloadLen)) {
        continue;
      }
      cState.lastLineIdx = refLine;
      recordTierCSpan(scanState, cState, refLine, iStart);
      emitResult(result, c128.payloadBytes, c128.payloadLen, c128.symbols, c128.symbolCount, mCount);
      return 1;
    }
  }
  // BL2 (`blurEdges`): fallback LoG + proximity-fusion pass on prefix-stacked profile
  if (useBlurEdges) {
    scanState.blurFallbackTriggered = (scanState.blurFallbackTriggered + 1) | 0;
    let rcBlur = extractRunsBlurResilient(avgBuf, 0, span, scanState, 1, 0);
    for (let bPass = 0; bPass < 2; bPass++) {
      if (bPass === 1) {
        if ((scanState.edgeCountB | 0) < 24) break;
        rcBlur = fuseEdgeBanksToRuns(span, scanState, 0, scanState.edgeCountB, 320);
      }
      if (rcBlur < 25) continue;
      if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
      const status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, rcBlur, c128);
      if (status === 2) {
        if ((c128.flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0 && !hasTsXPrefixBytes(c128.payloadBytes, 0, c128.payloadLen)) {
          continue;
        }
        cState.lastLineIdx = refLine;
        recordTierCSpan(scanState, cState, refLine, iStart);
        emitResult(result, c128.payloadBytes, c128.payloadLen, c128.symbols, c128.symbolCount, mCount);
        return 1;
      }
    }
  }
  return 0;
}

/**
 * Tier C: Aligned parallel grayscale profile averaging (groups of 3 adjacent scanlines)
 * + 1D unsharp sharpening (`2*s[i] - (s[i-2] + s[i+2])/2`) to cancel noise and 4–5 px blur.
 */
function tryTierCProfileAveraging(scanState, cState, result) {
  if ((scanState.flags & (FLAG_PREFIX_STACK | FLAG_MATCH_FILTER)) !== 0) {
    if (tryPrefixAlignedStacking(scanState, cState, result) === 1) return 1;
  }
  const lineCount = scanState.lineCount | 0;
  if (lineCount < 3) return 0;

  const lumaBank = scanState.lumaBank;
  const avgBuf = scanState.avgLumaBuf;
  const c128 = cState.c128;
  const useMatchFilter = (scanState.flags & FLAG_MATCH_FILTER) !== 0;

  // Step direction in Q8 (stepXQ16 >> 8, max 256) for integer alignment dot-product
  const uxQ8 = scanState.lineStepXQ16[0] >> 8;
  const uyQ8 = scanState.lineStepYQ16[0] >> 8;

  for (let g = 0; g < 7; g++) {
    let a = 0;
    let b = 0;
    let c = 0;
    if (g === 0) { a = 2; b = 0; c = 1; }
    else if (g === 1) { a = 0; b = 1; c = 3; }
    else if (g === 2) { a = 0; b = 2; c = 4; }
    else if (g === 3) { a = 1; b = 3; c = 5; }
    else if (g === 4) { a = 2; b = 4; c = 6; }
    else if (g === 5) { a = 3; b = 5; c = 7; }
    else { a = 4; b = 6; c = 8; }

    if (a >= lineCount || b >= lineCount || c >= lineCount) continue;

    // Integer Q8 alignment projection along scanline direction
    const refXQ8 = scanState.lineStartXQ16[b] >> 8;
    const refYQ8 = scanState.lineStartYQ16[b] >> 8;
    const dxAQ8 = (refXQ8 - (scanState.lineStartXQ16[a] >> 8)) | 0;
    const dyAQ8 = (refYQ8 - (scanState.lineStartYQ16[a] >> 8)) | 0;
    const dxCQ8 = (refXQ8 - (scanState.lineStartXQ16[c] >> 8)) | 0;
    const dyCQ8 = (refYQ8 - (scanState.lineStartYQ16[c] >> 8)) | 0;

    const shiftA = ((Math.imul(dxAQ8, uxQ8) + Math.imul(dyAQ8, uyQ8) + 32768) >> 16) | 0;
    const shiftC = ((Math.imul(dxCQ8, uxQ8) + Math.imul(dyCQ8, uyQ8) + 32768) >> 16) | 0;

    const lenB = scanState.lineLength[b] | 0;
    const lenA = scanState.lineLength[a] | 0;
    const lenC = scanState.lineLength[c] | 0;

    let iStart = 0;
    if (-shiftA > iStart) iStart = -shiftA;
    if (-shiftC > iStart) iStart = -shiftC;

    let iEnd = lenB;
    if (lenA - shiftA < iEnd) iEnd = (lenA - shiftA) | 0;
    if (lenC - shiftC < iEnd) iEnd = (lenC - shiftC) | 0;

    const span = (iEnd - iStart) | 0;
    if (span < 64) continue;

    const baseA = (Math.imul(a, MAX_SCANLINE_LEN) + shiftA + iStart) | 0;
    const baseB = (Math.imul(b, MAX_SCANLINE_LEN) + iStart) | 0;
    const baseC = (Math.imul(c, MAX_SCANLINE_LEN) + shiftC + iStart) | 0;

    for (let i = 0; i < span; i++) {
      const sum = (lumaBank[(baseA + i) | 0] + lumaBank[(baseB + i) | 0] + lumaBank[(baseC + i) | 0]) | 0;
      avgBuf[i] = ((sum + 1) / 3) | 0;
    }

    // Pass 0: local adaptive envelope zero-crossing on denoised profile (immune to blur width bloat)
    // Pass 1: derivative peaks on denoised profile
    let groupDecoded = 0;
    c128.mfValid = 0;
    for (let pass = 0; pass < 2; pass++) {
      const runCount = pass === 0
        ? extractRunsLocalMidCrossing(avgBuf, 0, span, scanState, 24)
        : extractRunsFromScanline(avgBuf, 0, span, scanState, 66, 15);
      if (runCount < 25) continue;
      if (useMatchFilter && pass === 0) {
        matchFilterScanline(avgBuf, 0, span, scanState, c128, 0);
      }
      if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;

      const status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount, c128);
      if (status === 2) {
        if ((c128.flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0 && !hasTsXPrefixBytes(c128.payloadBytes, 0, c128.payloadLen)) {
          continue;
        }
        const votes = recordExactVote(cState, c128.payloadBytes, c128.payloadLen);
        if (votes >= MIN_CONSENSUS_AGREEMENT) {
          cState.lastLineIdx = b;
          recordTierCSpan(scanState, cState, b, iStart);
          emitResult(result, c128.payloadBytes, c128.payloadLen, c128.symbols, c128.symbolCount, votes);
          return 1;
        }
        groupDecoded = 1;
        break;
      }
    }

    // BL2 (`blurEdges`): Tier C fallback LoG + proximity fusion when primary & mid-crossing miss
    if (groupDecoded === 0 && (scanState.flags & FLAG_BLUR_EDGES) !== 0) {
      scanState.blurFallbackTriggered = (scanState.blurFallbackTriggered + 1) | 0;
      let rcBlur = extractRunsBlurResilient(avgBuf, 0, span, scanState, 1, 0);
      for (let bPass = 0; bPass < 2; bPass++) {
        if (bPass === 1) {
          if ((scanState.edgeCountB | 0) < 24) break;
          rcBlur = fuseEdgeBanksToRuns(span, scanState, 0, scanState.edgeCountB, 320);
        }
        if (rcBlur < 25) continue;
        if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
        const status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, rcBlur, c128);
        if (status === 2) {
          if ((c128.flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0 && !hasTsXPrefixBytes(c128.payloadBytes, 0, c128.payloadLen)) {
            continue;
          }
          const votes = recordExactVote(cState, c128.payloadBytes, c128.payloadLen);
          if (votes >= MIN_CONSENSUS_AGREEMENT) {
            cState.lastLineIdx = b;
            recordTierCSpan(scanState, cState, b, iStart);
            emitResult(result, c128.payloadBytes, c128.payloadLen, c128.symbols, c128.symbolCount, votes);
            return 1;
          }
          break;
        }
      }
    }
  }

  return 0;
}

function hasTsXPrefixBytes(bytes, offset, len) {
  return len >= 3 &&
    bytes[offset] === 116 &&     // 't'
    bytes[offset + 1] === 115 && // 's'
    bytes[offset + 2] === 88;    // 'X'
}

/**
 * Runs Stages 2–5 with zero heap allocations and zero float-boxing.
 */
export function runScanlineConsensus(luma, width, height, hasRoi, scanState, cState, result) {
  cState.slotCount = 0;
  cState.softCount = 0;
  cState.lastLineIdx = 0;

  const flags = scanState.flags | 0;
  const numLines = (flags & FLAG_EXTRA_LINES) !== 0 ? 13 : 11;
  const useIllum = (flags & FLAG_ILLUM_NORM) !== 0;
  const useDeblur = (flags & FLAG_DEBLUR_1D) !== 0 && scanState.blurPx >= 1.5 && scanState.blurPx <= 8.0;
  const useSubpixFirst = (flags & FLAG_SUBPIX_EDGES) !== 0;
  const useReqPrefix = (flags & FLAG_REQUIRE_PREFIX) !== 0;
  const useStrictPrefix = (flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0;
  const useModuleEst = (flags & FLAG_MODULE_EST) !== 0;
  const useBlurEdges = (flags & FLAG_BLUR_EDGES) !== 0;
  const useMatchFilter = (flags & FLAG_MATCH_FILTER) !== 0;
  if (useModuleEst || useMatchFilter) {
    scanState.roiMajorLen = hasRoi === 1 ? (result.roiMajorLen | 0) : 0;
  }

  const lineCount = buildScanlinePlan(width, height, result, hasRoi, scanState, numLines);
  if (lineCount <= 0) return 0;

  const lumaBank = scanState.lumaBank;
  const c128 = cState.c128;
  c128.flags = flags;
  c128.cribMatched = 0;
  c128.mfValid = 0;

  // Tier A: Sample & decode scanlines center-outward with immediate early-exit on consensus >= 2
  for (let i = 0; i < lineCount; i++) {
    cState.lineCribMatched[i] = 0;
    const len = sampleScanlineLuma(luma, width, scanState, i);
    const lumaOffset = Math.imul(i, MAX_SCANLINE_LEN);
    if (useIllum) {
      normaliseScanlineLuma(lumaBank, lumaOffset, len, scanState, 24);
    }
    if (useDeblur) {
      deblurScanlineLuma(lumaBank, lumaOffset, len, scanState.blurPx, scanState);
    }

    c128.cribMatched = 0;
    c128.mfValid = 0;
    const runCount = useSubpixFirst
      ? extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20)
      : extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18);
    let blurEstHint = 0;
    if (useModuleEst) {
      scanState.linesEvaluated = (scanState.linesEvaluated + 1) | 0;
      if (estimateModuleWidthQ8(lumaBank, lumaOffset, len, scanState, useSubpixFirst ? 0 : 1, 0) === 0) {
        // When both moduleEst and blurEdges are ON, allow blur-weakened in-range periodic lines
        // (strength >= 140) to fall through to BL2 instead of early-rejecting valid blurred codes.
        const mQ8 = scanState.moduleWidthQ8 | 0;
        const canBlurRescue = useBlurEdges &&
          mQ8 >= (scanState.derivedMinModQ8 | 0) &&
          mQ8 <= (scanState.derivedMaxModQ8 | 0) &&
          (scanState.modulePeakStrength | 0) >= 140;
        if (!canBlurRescue) {
          scanState.linesRejectedEarly = (scanState.linesRejectedEarly + 1) | 0;
          continue;
        }
        blurEstHint = 1;
      } else if (useBlurEdges && (scanState.modulePeakStrength | 0) < 380) {
        blurEstHint = 1;
      }
    }
    if (useMatchFilter) {
      scanState.matchLinesEvaluated = (scanState.matchLinesEvaluated + 1) | 0;
      if (matchFilterScanline(lumaBank, lumaOffset, len, scanState, c128, 0) === 0) {
        scanState.matchLinesRejected = (scanState.matchLinesRejected + 1) | 0;
        continue;
      }
      c128.mfRunOriginQ8 = scanState.runOriginQ8;
    }
    let status = 0;
    if (runCount >= 25) {
      status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount, c128);
    }

    // Secondary complementary extractor pass
    let runCount2 = 0;
    if (status < 2) {
      runCount2 = useSubpixFirst
        ? extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18)
        : extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20);
      if (runCount2 >= 25) {
        if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
        const status2 = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount2, c128);
        if (status2 > status) status = status2;
      }
    }

    // BL2 (`blurEdges`): Fallback-only LoG + proximity fusion when primary + secondary fail to decode,
    // produce a suspicious run count (< 19 or > MAX_RUNS - 4), or BL1 moduleEst reports blur.
    // Note: when `deblur1d` is also ON, `lumaBank` was already sharpened above, so `smooth = 0`
    // avoids double-filtering while exploiting the sharpened slope cleanly.
    if (useBlurEdges && status < 2) {
      const suspiciousRuns = runCount < 19 || runCount > (MAX_RUNS - 4) ||
        runCount2 < 19 || runCount2 > (MAX_RUNS - 4);
      if (blurEstHint === 1 || suspiciousRuns || status < 2) {
        scanState.blurFallbackTriggered = (scanState.blurFallbackTriggered + 1) | 0;
        let rcBlur = extractRunsBlurResilient(lumaBank, lumaOffset, len, scanState, 1, 0);
        if (rcBlur >= 25) {
          if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
          const status3 = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, rcBlur, c128);
          if (status3 > status) status = status3;
        }
        if (status < 2 && (scanState.edgeCountB | 0) >= 24) {
          rcBlur = fuseEdgeBanksToRuns(len, scanState, 0, scanState.edgeCountB, 320);
          if (rcBlur >= 25) {
            if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
            const status4 = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, rcBlur, c128);
            if (status4 > status) status = status4;
          }
        }
      }
    }

    if (c128.cribMatched === 1) {
      cState.lineCribMatched[i] = 1;
      cState.lineCribStartPxQ8[i] = c128.cribStartPxQ8;
      cState.lineCribErrQ8[i] = c128.cribErrQ8;
      cState.lineCribDir[i] = c128.cribDir;
    } else if (useMatchFilter && c128.mfValid === 1 && (c128.mfTsxScore >= 600 || c128.mfStartScore >= 620)) {
      // BL3 extends cribMatch / prefixStack with sub-pixel matched-filter Start B / tsX anchor
      const anchorScore = c128.mfTsxScore >= 600 ? c128.mfTsxScore : c128.mfStartScore;
      cState.lineCribMatched[i] = 1;
      cState.lineCribStartPxQ8[i] = c128.mfStartPosQ8;
      cState.lineCribErrQ8[i] = ((1024 - anchorScore) << 1) | 0;
      cState.lineCribDir[i] = c128.mfDir;
    }

    if (status === 2) {
      const isTsx = hasTsXPrefixBytes(c128.payloadBytes, 0, c128.payloadLen);
      if (useStrictPrefix && !isTsx) continue;

      const votes = recordExactVote(cState, c128.payloadBytes, c128.payloadLen);
      storeSoftCandidate(cState);
      // W4 (`requirePrefix`): tsX + crib match earns fast lock on 1 line; plain labels still require >= 2
      const neededVotes = (useReqPrefix && isTsx && c128.cribMatched === 1) ? 1 : MIN_CONSENSUS_AGREEMENT;
      if (votes >= neededVotes) {
        cState.lastLineIdx = i;
        emitResult(result, c128.payloadBytes, c128.payloadLen, c128.symbols, c128.symbolCount, votes);
        return 1;
      }
    } else if (status === 1) {
      storeSoftCandidate(cState);
    }
  }

  // Tier B: Cross-scanline character-level soft voting
  if (tryTierBSoftVoting(cState, result) === 1) {
    return 1;
  }

  // Tier C: Aligned parallel grayscale profile averaging + 1D sharpening (RoI mode)
  if (hasRoi === 1 && tryTierCProfileAveraging(scanState, cState, result) === 1) {
    return 1;
  }

  return 0;
}

/**
 * Records a multi-hit barcode decoded on `lineIdx` into `cState.slot*`, enforcing at most
 * 1 vote per scanline per payload and tracking the tight bounding box of each individual
 * barcode along the scanline.
 */
function recordMultiLineHit(cState, scanState, lineIdx, hitIdx) {
  const c128 = cState.c128;
  const pLen = c128.hitPayloadLens[hitIdx] | 0;
  if (pLen <= 0) return;

  const hBase = Math.imul(hitIdx, MAX_CODE128_PAYLOAD);
  const slotCount = cState.slotCount | 0;
  const slotPayloads = cState.slotPayloads;
  const slotLens = cState.slotLens;
  const slotVotes = cState.slotVotes;
  const slotLastLine = cState.slotLastLine;

  // Compute exact endpoints of this barcode in full-resolution image coordinates
  const sx0 = scanState.lineStartXQ16[lineIdx] / 65536.0;
  const sy0 = scanState.lineStartYQ16[lineIdx] / 65536.0;
  const ux = scanState.lineStepXQ16[lineIdx] / 65536.0;
  const uy = scanState.lineStepYQ16[lineIdx] / 65536.0;
  // B8 (`decodeAnchor`): hit positions are relative to run 0, which may start after sample 0 of the
  // scanline; add the run origin so the span lands on the real symbol start/stop.
  const anchorOn = (scanState.flags & FLAG_DECODE_ANCHOR) !== 0;
  const originPx = anchorOn ? scanState.runOriginQ8 / 256.0 : 0;
  const p0 = c128.hitStartPx[hitIdx] + originPx;
  const p1 = c128.hitEndPx[hitIdx] + originPx;
  const ax = sx0 + ux * p0;
  const ay = sy0 + uy * p0;
  const bx = sx0 + ux * p1;
  const by = sy0 + uy * p1;
  const loX = ax < bx ? ax : bx;
  const hiX = ax > bx ? ax : bx;
  const loY = ay < by ? ay : by;
  const hiY = ay > by ? ay : by;
  const spanPx = p1 > p0 ? (p1 - p0) : (p0 - p1);
  const midX = (ax + bx) * 0.5;
  const midY = (ay + by) * 0.5;

  for (let s = 0; s < slotCount; s++) {
    if (slotLens[s] !== pLen) continue;
    const base = Math.imul(s, MAX_CODE128_PAYLOAD);
    let same = 1;
    for (let k = 0; k < pLen; k++) {
      if (slotPayloads[(base + k) | 0] !== c128.hitPayloads[(hBase + k) | 0]) {
        same = 0;
        break;
      }
    }
    if (same === 1) {
      // Do not double-count two passes (deriv + mid-crossing) on the same scanline
      if (slotLastLine[s] === lineIdx) return;
      slotLastLine[s] = lineIdx;
      slotVotes[s] = (slotVotes[s] + 1) | 0;
      if (loX < cState.slotMinX[s]) cState.slotMinX[s] = loX;
      if (loY < cState.slotMinY[s]) cState.slotMinY[s] = loY;
      if (hiX > cState.slotMaxX[s]) cState.slotMaxX[s] = hiX;
      if (hiY > cState.slotMaxY[s]) cState.slotMaxY[s] = hiY;
      cState.slotSpanSum[s] += spanPx;
      if (anchorOn) {
        cState.slotMidSumX[s] += midX;
        cState.slotMidSumY[s] += midY;
        cState.slotMidN[s] = (cState.slotMidN[s] + 1) | 0;
      }
      return;
    }
  }

  if (slotCount < MAX_EXACT_SLOTS) {
    const pBase = Math.imul(slotCount, MAX_CODE128_PAYLOAD);
    for (let k = 0; k < pLen; k++) {
      slotPayloads[(pBase + k) | 0] = c128.hitPayloads[(hBase + k) | 0];
    }
    const sCount = c128.hitSymbolCounts[hitIdx] | 0;
    const hsBase = Math.imul(hitIdx, MAX_CODE128_SYMBOLS);
    const sBase = Math.imul(slotCount, MAX_CODE128_SYMBOLS);
    for (let k = 0; k < sCount; k++) {
      cState.slotSymbols[(sBase + k) | 0] = c128.hitSymbols[(hsBase + k) | 0];
    }
    cState.slotSymCounts[slotCount] = sCount;
    slotLens[slotCount] = pLen;
    slotVotes[slotCount] = 1;
    slotLastLine[slotCount] = lineIdx;
    cState.slotMinX[slotCount] = loX;
    cState.slotMinY[slotCount] = loY;
    cState.slotMaxX[slotCount] = hiX;
    cState.slotMaxY[slotCount] = hiY;
    cState.slotSpanSum[slotCount] = spanPx;
    cState.slotMidSumX[slotCount] = anchorOn ? midX : 0;
    cState.slotMidSumY[slotCount] = anchorOn ? midY : 0;
    cState.slotMidN[slotCount] = anchorOn ? 1 : 0;
    cState.slotCount = (slotCount + 1) | 0;
  }
}

/**
 * Multi-barcode consensus engine for a single Stage 1 RoI cluster (or fallback fan):
 * Decodes ALL stacked/adjacent Code 128 barcodes crossed along the same scanlines
 * (e.g., stacked vertical cartons bridged by cardboard seams on a U-boat).
 *
 * Populates `cState.slot*` with all candidates; caller inspects slots with `slotVotes[s] >= 2`.
 * Zero heap allocations per call.
 *
 * @returns {number} Number of slots in `cState` that reached `>= MIN_CONSENSUS_AGREEMENT`
 */
export function runScanlineConsensusMulti(luma, width, height, hasRoi, scanState, cState, result) {
  cState.slotCount = 0;
  cState.tcValid = 0;
  cState.softCount = 0;
  cState.lastLineIdx = 0;

  const flags = scanState.flags | 0;
  const numLines = (flags & FLAG_EXTRA_LINES) !== 0 ? 13 : 11;
  const useIllum = (flags & FLAG_ILLUM_NORM) !== 0;
  const useDeblur = (flags & FLAG_DEBLUR_1D) !== 0 && scanState.blurPx >= 1.5 && scanState.blurPx <= 8.0;
  const useSubpixFirst = (flags & FLAG_SUBPIX_EDGES) !== 0;
  const useStrictPrefix = (flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0;
  const useModuleEst = (flags & FLAG_MODULE_EST) !== 0;
  const useBlurEdges = (flags & FLAG_BLUR_EDGES) !== 0;
  const useMatchFilter = (flags & FLAG_MATCH_FILTER) !== 0;
  if (useModuleEst || useMatchFilter) {
    scanState.roiMajorLen = hasRoi === 1 ? (result.roiMajorLen | 0) : 0;
  }

  // For tall/merged clusters (e.g. 2–4 stacked cartons sharing one column), cast 11–13 lines
  // and sweep across the full cluster so every stacked barcode reaches >= 2 agreement.
  const isMergedCluster = hasRoi === 1 && result.roiMajorLen > 360.0;
  const lineCount = buildScanlinePlan(width, height, result, hasRoi, scanState, numLines);
  if (lineCount <= 0) return 0;

  const lumaBank = scanState.lumaBank;
  const c128 = cState.c128;
  c128.flags = flags;
  c128.mfValid = 0;

  for (let i = 0; i < lineCount; i++) {
    cState.lineCribMatched[i] = 0;
    const len = sampleScanlineLuma(luma, width, scanState, i);
    const lumaOffset = Math.imul(i, MAX_SCANLINE_LEN);
    if (useIllum) {
      normaliseScanlineLuma(lumaBank, lumaOffset, len, scanState, 24);
    }
    if (useDeblur) {
      deblurScanlineLuma(lumaBank, lumaOffset, len, scanState.blurPx, scanState);
    }

    c128.cribMatched = 0;
    c128.mfValid = 0;
    const runCount1 = useSubpixFirst
      ? extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20)
      : extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18);
    if (useModuleEst) {
      scanState.linesEvaluated = (scanState.linesEvaluated + 1) | 0;
      if (estimateModuleWidthQ8(lumaBank, lumaOffset, len, scanState, useSubpixFirst ? 0 : 1, isMergedCluster ? 1 : 0) === 0) {
        const mQ8 = scanState.moduleWidthQ8 | 0;
        const canBlurRescue = useBlurEdges &&
          mQ8 >= (scanState.derivedMinModQ8 | 0) &&
          mQ8 <= (scanState.derivedMaxModQ8 | 0) &&
          (scanState.modulePeakStrength | 0) >= 140;
        if (!canBlurRescue) {
          scanState.linesRejectedEarly = (scanState.linesRejectedEarly + 1) | 0;
          continue;
        }
      }
    }
    if (useMatchFilter) {
      scanState.matchLinesEvaluated = (scanState.matchLinesEvaluated + 1) | 0;
      if (matchFilterScanline(lumaBank, lumaOffset, len, scanState, c128, isMergedCluster ? 1 : 0) === 0) {
        scanState.matchLinesRejected = (scanState.matchLinesRejected + 1) | 0;
        continue;
      }
      c128.mfRunOriginQ8 = scanState.runOriginQ8;
    }
    let hits1 = 0;
    if (runCount1 >= 25) {
      hits1 = decodeAllCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount1, c128);
      for (let h = 0; h < hits1; h++) {
        if (useStrictPrefix && !hasTsXPrefixBytes(c128.hitPayloads, Math.imul(h, MAX_CODE128_PAYLOAD), c128.hitPayloadLens[h])) continue;
        recordMultiLineHit(cState, scanState, i, h);
      }
    }

    // Run complementary pass if primary missed or on merged multi-carton columns
    let hits2 = 0;
    let runCount2 = 0;
    if (hits1 === 0 || isMergedCluster) {
      runCount2 = useSubpixFirst
        ? extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18)
        : extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20);
      if (runCount2 >= 25) {
        if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
        hits2 = decodeAllCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount2, c128);
        for (let h = 0; h < hits2; h++) {
          if (useStrictPrefix && !hasTsXPrefixBytes(c128.hitPayloads, Math.imul(h, MAX_CODE128_PAYLOAD), c128.hitPayloadLens[h])) continue;
          recordMultiLineHit(cState, scanState, i, h);
        }
      }
    }

    // BL2 (`blurEdges`): Fallback-only LoG + proximity fusion when primary + secondary miss
    if (useBlurEdges && hits1 === 0 && hits2 === 0) {
      scanState.blurFallbackTriggered = (scanState.blurFallbackTriggered + 1) | 0;
      let rcBlur = extractRunsBlurResilient(lumaBank, lumaOffset, len, scanState, 1, 0);
      let hits3 = 0;
      if (rcBlur >= 25) {
        if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
        hits3 = decodeAllCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, rcBlur, c128);
        for (let h = 0; h < hits3; h++) {
          if (useStrictPrefix && !hasTsXPrefixBytes(c128.hitPayloads, Math.imul(h, MAX_CODE128_PAYLOAD), c128.hitPayloadLens[h])) continue;
          recordMultiLineHit(cState, scanState, i, h);
        }
      }
      if (hits3 === 0 && (scanState.edgeCountB | 0) >= 24) {
        rcBlur = fuseEdgeBanksToRuns(len, scanState, 0, scanState.edgeCountB, 320);
        if (rcBlur >= 25) {
          if (useMatchFilter) c128.mfRunOriginQ8 = scanState.runOriginQ8;
          const hits4 = decodeAllCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, rcBlur, c128);
          for (let h = 0; h < hits4; h++) {
            if (useStrictPrefix && !hasTsXPrefixBytes(c128.hitPayloads, Math.imul(h, MAX_CODE128_PAYLOAD), c128.hitPayloadLens[h])) continue;
            recordMultiLineHit(cState, scanState, i, h);
          }
        }
      }
    }

    if (c128.cribMatched === 1) {
      cState.lineCribMatched[i] = 1;
      cState.lineCribStartPxQ8[i] = c128.cribStartPxQ8;
      cState.lineCribErrQ8[i] = c128.cribErrQ8;
      cState.lineCribDir[i] = c128.cribDir;
    } else if (useMatchFilter && c128.mfValid === 1 && (c128.mfTsxScore >= 600 || c128.mfStartScore >= 620)) {
      const anchorScore = c128.mfTsxScore >= 600 ? c128.mfTsxScore : c128.mfStartScore;
      cState.lineCribMatched[i] = 1;
      cState.lineCribStartPxQ8[i] = c128.mfStartPosQ8;
      cState.lineCribErrQ8[i] = ((1024 - anchorScore) << 1) | 0;
      cState.lineCribDir[i] = c128.mfDir;
    }

    // Fast early exit for normal single-barcode clusters once a payload reaches >= 2 votes
    if (!isMergedCluster && i >= 1) {
      let locked = 0;
      for (let s = 0; s < cState.slotCount; s++) {
        if (cState.slotVotes[s] >= MIN_CONSENSUS_AGREEMENT) {
          locked++;
          cState.lastLineIdx = i;
        }
      }
      if (locked > 0) return locked;
    }
  }

  let lockedCount = 0;
  for (let s = 0; s < cState.slotCount; s++) {
    if (cState.slotVotes[s] >= MIN_CONSENSUS_AGREEMENT) {
      lockedCount++;
    }
  }

  // If Tier A multi-hit found nothing, fall back to Tier C profile averaging on normal clusters
  if (lockedCount === 0 && hasRoi === 1) {
    if (tryTierCProfileAveraging(scanState, cState, result) === 1) {
      // Promote Tier C result into slot 0 for uniform caller collection
      const pLen = result.payloadLen | 0;
      for (let k = 0; k < pLen; k++) cState.slotPayloads[k] = result.payloadBytes[k];
      const sCount = result.symbolCount | 0;
      for (let k = 0; k < sCount; k++) cState.slotSymbols[k] = result.symbolBytes[k];
      cState.slotSymCounts[0] = sCount;
      cState.slotLens[0] = pLen;
      cState.slotVotes[0] = result.consensusCount;
      cState.slotMinX[0] = result.roiX;
      cState.slotMinY[0] = result.roiY;
      cState.slotMaxX[0] = result.roiX + result.roiW;
      cState.slotMaxY[0] = result.roiY + result.roiH;
      cState.slotSpanSum[0] = result.roiMajorLen * result.consensusCount;
      cState.slotMidN[0] = 0; // Tier C: keep the RoI-box centre unless the decoded span is anchored below
      if (cState.tcValid === 1 && (flags & FLAG_DECODE_ANCHOR) !== 0) {
        // B8 part 2: slide the RoI box/centre along the scan axis onto the decoded start-stop span and use
        // the decoded span length. The across-axis position stays the RoI cluster's.
        const tl = cState.tcLine | 0;
        const ux = scanState.lineStepXQ16[tl] / 65536.0;
        const uy = scanState.lineStepYQ16[tl] / 65536.0;
        const tMid = (cState.tcSpan[0] + cState.tcSpan[1]) * 0.5;
        const mx = scanState.lineStartXQ16[tl] / 65536.0 + ux * tMid;
        const my = scanState.lineStartYQ16[tl] / 65536.0 + uy * tMid;
        const rcx = result.roiCenterX;
        const rcy = result.roiCenterY;
        const along = (mx - rcx) * ux + (my - rcy) * uy;
        const dx = ux * along;
        const dy = uy * along;
        cState.slotMinX[0] += dx;
        cState.slotMaxX[0] += dx;
        cState.slotMinY[0] += dy;
        cState.slotMaxY[0] += dy;
        // Near-axis-aligned labels: trim the box along the scan axis to the decoded span itself
        const sA = cState.tcSpan[0];
        const sB = cState.tcSpan[1];
        const ax0 = scanState.lineStartXQ16[tl] / 65536.0 + ux * sA;
        const ay0 = scanState.lineStartYQ16[tl] / 65536.0 + uy * sA;
        const bx0 = scanState.lineStartXQ16[tl] / 65536.0 + ux * sB;
        const by0 = scanState.lineStartYQ16[tl] / 65536.0 + uy * sB;
        if (uy >= 0.9 || uy <= -0.9) {
          cState.slotMinY[0] = ay0 < by0 ? ay0 : by0;
          cState.slotMaxY[0] = ay0 < by0 ? by0 : ay0;
        } else if (ux >= 0.9 || ux <= -0.9) {
          cState.slotMinX[0] = ax0 < bx0 ? ax0 : bx0;
          cState.slotMaxX[0] = ax0 < bx0 ? bx0 : ax0;
        }
        cState.slotMidSumX[0] = rcx + dx;
        cState.slotMidSumY[0] = rcy + dy;
        cState.slotMidN[0] = 1;
        const spanLen = cState.tcSpan[1] - cState.tcSpan[0];
        cState.slotSpanSum[0] = (spanLen < 0 ? -spanLen : spanLen) * result.consensusCount;
      }
      cState.slotCount = 1;
      return 1;
    }
  }

  return lockedCount;
}
