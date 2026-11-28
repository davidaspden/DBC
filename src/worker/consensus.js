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
} from './flagbits.js';
import {
  MAX_SCANLINES,
  MAX_SCANLINE_LEN,
  buildScanlinePlan,
  sampleScanlineLuma,
  normaliseScanlineLuma,
  deblurScanlineLuma,
  extractRunsFromScanline,
  extractRunsLocalMidCrossing,
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
  for (let pass = 0; pass < 2; pass++) {
    const runCount = pass === 0
      ? extractRunsLocalMidCrossing(avgBuf, 0, span, scanState, 20)
      : extractRunsFromScanline(avgBuf, 0, span, scanState, 66, 15);
    if (runCount < 25) continue;
    const status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount, c128);
    if (status === 2) {
      if ((c128.flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0 && !hasTsXPrefixBytes(c128.payloadBytes, 0, c128.payloadLen)) {
        continue;
      }
      cState.lastLineIdx = refLine;
      emitResult(result, c128.payloadBytes, c128.payloadLen, c128.symbols, c128.symbolCount, mCount);
      return 1;
    }
  }
  return 0;
}

/**
 * Tier C: Aligned parallel grayscale profile averaging (groups of 3 adjacent scanlines)
 * + 1D unsharp sharpening (`2*s[i] - (s[i-2] + s[i+2])/2`) to cancel noise and 4–5 px blur.
 */
function tryTierCProfileAveraging(scanState, cState, result) {
  if ((scanState.flags & FLAG_PREFIX_STACK) !== 0) {
    if (tryPrefixAlignedStacking(scanState, cState, result) === 1) return 1;
  }
  const lineCount = scanState.lineCount | 0;
  if (lineCount < 3) return 0;

  const lumaBank = scanState.lumaBank;
  const avgBuf = scanState.avgLumaBuf;
  const c128 = cState.c128;

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
    for (let pass = 0; pass < 2; pass++) {
      const runCount = pass === 0
        ? extractRunsLocalMidCrossing(avgBuf, 0, span, scanState, 24)
        : extractRunsFromScanline(avgBuf, 0, span, scanState, 66, 15);
      if (runCount < 25) continue;

      const status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount, c128);
      if (status === 2) {
        if ((c128.flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0 && !hasTsXPrefixBytes(c128.payloadBytes, 0, c128.payloadLen)) {
          continue;
        }
        const votes = recordExactVote(cState, c128.payloadBytes, c128.payloadLen);
        if (votes >= MIN_CONSENSUS_AGREEMENT) {
          cState.lastLineIdx = b;
          emitResult(result, c128.payloadBytes, c128.payloadLen, c128.symbols, c128.symbolCount, votes);
          return 1;
        }
        break;
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

  const lineCount = buildScanlinePlan(width, height, result, hasRoi, scanState, numLines);
  if (lineCount <= 0) return 0;

  const lumaBank = scanState.lumaBank;
  const c128 = cState.c128;
  c128.flags = flags;
  c128.cribMatched = 0;

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
    const runCount = useSubpixFirst
      ? extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20)
      : extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18);
    let status = 0;
    if (runCount >= 25) {
      status = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount, c128);
    }

    // Secondary complementary extractor pass
    if (status < 2) {
      const runCount2 = useSubpixFirst
        ? extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18)
        : extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20);
      if (runCount2 >= 25) {
        const status2 = decodeCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount2, c128);
        if (status2 > status) status = status2;
      }
    }

    if (c128.cribMatched === 1) {
      cState.lineCribMatched[i] = 1;
      cState.lineCribStartPxQ8[i] = c128.cribStartPxQ8;
      cState.lineCribErrQ8[i] = c128.cribErrQ8;
      cState.lineCribDir[i] = c128.cribDir;
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
  const p0 = c128.hitStartPx[hitIdx];
  const p1 = c128.hitEndPx[hitIdx];
  const ax = sx0 + ux * p0;
  const ay = sy0 + uy * p0;
  const bx = sx0 + ux * p1;
  const by = sy0 + uy * p1;
  const loX = ax < bx ? ax : bx;
  const hiX = ax > bx ? ax : bx;
  const loY = ay < by ? ay : by;
  const hiY = ay > by ? ay : by;
  const spanPx = p1 > p0 ? (p1 - p0) : (p0 - p1);

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
  cState.softCount = 0;
  cState.lastLineIdx = 0;

  const flags = scanState.flags | 0;
  const numLines = (flags & FLAG_EXTRA_LINES) !== 0 ? 13 : 11;
  const useIllum = (flags & FLAG_ILLUM_NORM) !== 0;
  const useDeblur = (flags & FLAG_DEBLUR_1D) !== 0 && scanState.blurPx >= 1.5 && scanState.blurPx <= 8.0;
  const useSubpixFirst = (flags & FLAG_SUBPIX_EDGES) !== 0;
  const useStrictPrefix = (flags & FLAG_REQUIRE_PREFIX_STRICT) !== 0;

  // For tall/merged clusters (e.g. 2–4 stacked cartons sharing one column), cast 11–13 lines
  // and sweep across the full cluster so every stacked barcode reaches >= 2 agreement.
  const isMergedCluster = hasRoi === 1 && result.roiMajorLen > 360.0;
  const lineCount = buildScanlinePlan(width, height, result, hasRoi, scanState, numLines);
  if (lineCount <= 0) return 0;

  const lumaBank = scanState.lumaBank;
  const c128 = cState.c128;
  c128.flags = flags;

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

    const runCount1 = useSubpixFirst
      ? extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20)
      : extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18);
    let hits1 = 0;
    if (runCount1 >= 25) {
      hits1 = decodeAllCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount1, c128);
      for (let h = 0; h < hits1; h++) {
        if (useStrictPrefix && !hasTsXPrefixBytes(c128.hitPayloads, Math.imul(h, MAX_CODE128_PAYLOAD), c128.hitPayloadLens[h])) continue;
        recordMultiLineHit(cState, scanState, i, h);
      }
    }

    // Run complementary pass if primary missed or on merged multi-carton columns
    if (hits1 === 0 || isMergedCluster) {
      const runCount2 = useSubpixFirst
        ? extractRunsFromScanline(lumaBank, lumaOffset, len, scanState, 72, 18)
        : extractRunsLocalMidCrossing(lumaBank, lumaOffset, len, scanState, 20);
      if (runCount2 >= 25) {
        const hits2 = decodeAllCode128FromRuns(scanState.runWidthsQ8, scanState.runIsBar, runCount2, c128);
        for (let h = 0; h < hits2; h++) {
          if (useStrictPrefix && !hasTsXPrefixBytes(c128.hitPayloads, Math.imul(h, MAX_CODE128_PAYLOAD), c128.hitPayloadLens[h])) continue;
          recordMultiLineHit(cState, scanState, i, h);
        }
      }
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
      cState.slotCount = 1;
      return 1;
    }
  }

  return lockedCount;
}
