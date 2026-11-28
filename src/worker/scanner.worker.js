/**
 * Dedicated Web Worker Pipeline Orchestrator & Pre-Allocated TypedArray Pool (Code 128).
 *
 * Ties together Stages 1–5 with strictly zero per-frame heap allocations inside `processFrame()`
 * and `processFrameMulti()`:
 *  - Stage 1 (`roi.js`): 4x/2x downscale, 3x3 Scharr + 8x8 Structure Tensor, Top-12 RoI & theta
 *  - Stage 2 (`scanline.js`): 11 parallel oriented scanlines (or 12-line fallback fan)
 *  - Stage 3 (`scanline.js`): 1D first-derivative peak + local adaptive zero-crossing edges
 *  - Stage 4 (`consensus.js` + `decoders/code128.js`): Soft decoding & 3-tier consensus voting
 *  - Stage 5 (`decoders/code128.js`): Modulo 103 mathematical checksum gate + >= 2 agreement
 *
 * Supports both single-target fast lock (`processFrame`) and multi-barcode U-boat sweep
 * decoding (`processFrameMulti`, decoding up to 12 simultaneous Code 128 labels per frame).
 */

import { createRoiState, estimateRoi, selectRoiCluster, MAX_ROI_CLUSTERS } from './roi.js';
import {
  FLAG_VERT_FALLBACK,
  FLAG_VERTICAL_MODE,
  FLAG_FLOW_ON,
  FLAG_DECODE_ANCHOR,
} from './flagbits.js';
import {
  createScanlineState,
  MAX_SCANLINE_LEN,
  buildScanlinePlan,
  sampleScanlineLuma,
  extractRunsFromScanline,
} from './scanline.js';
import {
  createConsensusState,
  runScanlineConsensus,
  runScanlineConsensusMulti,
  MIN_CONSENSUS_AGREEMENT,
  SYMBOLOGY_NONE,
} from './consensus.js';
import { MAX_CODE128_PAYLOAD, MAX_CODE128_SYMBOLS } from './decoders/code128.js';
import { createFlowState, computeOpticalFlow } from './flow.js';

export const MAX_DETECTIONS = MAX_ROI_CLUSTERS;

/**
 * Pre-allocates the complete Stage 1–5 pipeline memory pool once for `(width, height)`.
 */
export function createPipelineState(width = 1280, height = 720) {
  const roi = createRoiState(width, height);
  return {
    width: width | 0,
    height: height | 0,
    flags: 0,
    predFlowDxDs: 0,
    predFlowDyDs: 0,
    roi,
    scanline: createScanlineState(),
    consensus: createConsensusState(),
    flow: createFlowState(roi.dsW, roi.dsH),

    // Pre-allocated multi-barcode per-frame detection bank (zero hot-loop allocations)
    detCount: 0,
    detPayloadBytes: new Uint8Array(MAX_DETECTIONS * MAX_CODE128_PAYLOAD),
    detPayloadLens: new Uint16Array(MAX_DETECTIONS),
    detSymbolBytes: new Uint8Array(MAX_DETECTIONS * MAX_CODE128_SYMBOLS),
    detSymbolCounts: new Uint8Array(MAX_DETECTIONS),
    detRoiX: new Int32Array(MAX_DETECTIONS),
    detRoiY: new Int32Array(MAX_DETECTIONS),
    detRoiW: new Int32Array(MAX_DETECTIONS),
    detRoiH: new Int32Array(MAX_DETECTIONS),
    detCenterX: new Float32Array(MAX_DETECTIONS),
    detCenterY: new Float32Array(MAX_DETECTIONS),
    detMajorLen: new Float32Array(MAX_DETECTIONS),
    detThetaDeg: new Float32Array(MAX_DETECTIONS),
    detConfidence: new Float32Array(MAX_DETECTIONS),
    detAgreeCount: new Uint16Array(MAX_DETECTIONS),
  };
}

/**
 * Allocates a single reusable ScanResult struct mutated in-place by `processFrame()`.
 */
export function createPipelineResult() {
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
    payloadBytes: new Uint8Array(MAX_CODE128_PAYLOAD),
    symbolCount: 0,
    symbolBytes: new Uint8Array(MAX_CODE128_SYMBOLS),
    tRoiMs: 0,
    tScanMs: 0,
    tDecodeMs: 0,
    tFlowMs: 0,
    tTotalMs: 0,
    flowDx: 0,
    flowDy: 0,
    flowConf: 0,
    flowTiles: 0,
  };
}

/**
 * Stores a decoded cluster result into `state`'s pre-allocated multi-detection bank
 * if its payload has not already been recorded in the current frame.
 */
function storeUniqueFrameDetection(state, result) {
  const len = result.payloadLen | 0;
  if (len <= 0) return;

  const count = state.detCount | 0;
  const bank = state.detPayloadBytes;
  const lens = state.detPayloadLens;
  const pBytes = result.payloadBytes;

  // Deduplicate identical payload within the same frame
  for (let d = 0; d < count; d++) {
    if (lens[d] !== len) continue;
    const base = Math.imul(d, MAX_CODE128_PAYLOAD);
    let same = 1;
    for (let k = 0; k < len; k++) {
      if (bank[(base + k) | 0] !== pBytes[k]) {
        same = 0;
        break;
      }
    }
    if (same === 1) return;
  }

  if (count >= MAX_DETECTIONS) return;

  const pBase = Math.imul(count, MAX_CODE128_PAYLOAD);
  for (let k = 0; k < len; k++) {
    bank[(pBase + k) | 0] = pBytes[k];
  }
  lens[count] = len;

  const symCount = result.symbolCount | 0;
  const sBase = Math.imul(count, MAX_CODE128_SYMBOLS);
  for (let k = 0; k < symCount; k++) {
    state.detSymbolBytes[(sBase + k) | 0] = result.symbolBytes[k];
  }
  state.detSymbolCounts[count] = symCount;

  state.detRoiX[count] = result.roiX;
  state.detRoiY[count] = result.roiY;
  state.detRoiW[count] = result.roiW;
  state.detRoiH[count] = result.roiH;
  state.detCenterX[count] = result.roiCenterX;
  state.detCenterY[count] = result.roiCenterY;
  state.detMajorLen[count] = result.roiMajorLen;
  state.detThetaDeg[count] = result.thetaDeg;
  state.detConfidence[count] = result.roiConfidence;
  state.detAgreeCount[count] = result.consensusCount;

  state.detCount = (count + 1) | 0;
}

/**
 * Executes Stages 1–5 (single-barcode fast early-exit mode) with zero heap allocations.
 */
export function processFrame(luma, width, height, state, result, measureStages = false) {
  const t0 = measureStages ? performance.now() : 0;
  const activeFlags = state.flags | 0;
  state.scanline.flags = activeFlags;
  state.scanline.linesEvaluated = 0;
  state.scanline.linesRejectedEarly = 0;
  state.scanline.matchLinesEvaluated = 0;
  state.scanline.matchLinesRejected = 0;
  state.roi.flags = activeFlags;

  const hasRoi = estimateRoi(luma, width, height, state.roi, result);
  if ((activeFlags & FLAG_FLOW_ON) !== 0) {
    computeOpticalFlow(
      state.roi.downsampled,
      state.roi.dsW,
      state.roi.dsH,
      state.roi.dsShift,
      state.predFlowDxDs,
      state.predFlowDyDs,
      state.flow,
      measureStages
    );
    result.flowDx = state.flow.dxFullPx;
    result.flowDy = state.flow.dyFullPx;
    result.flowConf = state.flow.conf;
    result.flowTiles = state.flow.tilesAccepted;
    result.tFlowMs = state.flow.tFlowMs;
  }
  const t1 = measureStages ? performance.now() : 0;

  let decoded = 0;
  if (hasRoi === 1) {
    const kCount = state.roi.clusterCount | 0;
    for (let c = 0; c < kCount; c++) {
      if (c > 0) selectRoiCluster(state.roi, c, result);
      decoded = runScanlineConsensus(
        luma,
        width,
        height,
        1,
        state.scanline,
        state.consensus,
        result
      );
      if (decoded === 1) break;
    }
    if (decoded === 0) {
      decoded = runScanlineConsensus(
        luma,
        width,
        height,
        0,
        state.scanline,
        state.consensus,
        result
      );
      if (decoded === 0 && kCount > 1) {
        selectRoiCluster(state.roi, 0, result);
      }
    }
  } else {
    decoded = runScanlineConsensus(
      luma,
      width,
      height,
      0,
      state.scanline,
      state.consensus,
      result
    );
  }
  if (decoded === 1) {
    state.roi.noRoiStreak = 0;
  }
  const t2 = measureStages ? performance.now() : 0;

  if (measureStages) {
    result.tRoiMs = t1 - t0;
    result.tDecodeMs = t2 - t1;
    result.tTotalMs = t2 - t0;
  }

  return decoded;
}

/**
 * Collects all slots from `state.consensus` that reached >= MIN_CONSENSUS_AGREEMENT into
 * `state.det*`, assigning each barcode its own tight individual bounding box along the scanline.
 */
function collectMultiConsensusSlots(state, result, width, height) {
  const cState = state.consensus;
  const sCount = cState.slotCount | 0;
  for (let s = 0; s < sCount; s++) {
    const votes = cState.slotVotes[s] | 0;
    if (votes < MIN_CONSENSUS_AGREEMENT) continue;

    const pLen = cState.slotLens[s] | 0;
    const pBase = Math.imul(s, MAX_CODE128_PAYLOAD);
    for (let k = 0; k < pLen; k++) {
      result.payloadBytes[k] = cState.slotPayloads[(pBase + k) | 0];
    }
    const symLen = cState.slotSymCounts[s] | 0;
    const sBase = Math.imul(s, MAX_CODE128_SYMBOLS);
    for (let k = 0; k < symLen; k++) {
      result.symbolBytes[k] = cState.slotSymbols[(sBase + k) | 0];
    }

    // Build tight individual bbox around this specific barcode (handles merged carton columns!)
    let x0 = Math.floor(cState.slotMinX[s]) - 12;
    let y0 = Math.floor(cState.slotMinY[s]) - 12;
    let x1 = Math.ceil(cState.slotMaxX[s]) + 12;
    let y1 = Math.ceil(cState.slotMaxY[s]) + 12;
    if (x0 < 0) x0 = 0;
    if (y0 < 0) y0 = 0;
    if (x1 > width) x1 = width;
    if (y1 > height) y1 = height;

    result.detected = 1;
    result.payloadLen = pLen;
    result.symbolCount = symLen;
    result.consensusCount = votes;
    result.roiX = x0;
    result.roiY = y0;
    result.roiW = (x1 - x0) | 0;
    result.roiH = (y1 - y0) | 0;
    result.roiCenterX = (x0 + x1) * 0.5;
    result.roiCenterY = (y0 + y1) * 0.5;
    result.roiMajorLen = cState.slotSpanSum[s] / votes;
    // B8 (`decodeAnchor`): report the mean midpoint of the decoded start-stop spans as the label centre
    const midN = cState.slotMidN[s] | 0;
    if ((state.flags & FLAG_DECODE_ANCHOR) !== 0 && midN > 0) {
      result.roiCenterX = cState.slotMidSumX[s] / midN;
      result.roiCenterY = cState.slotMidSumY[s] / midN;
    }

    storeUniqueFrameDetection(state, result);
  }
}

/**
 * Executes Stages 1–5 in Multi-Barcode Sweep Mode: decodes ALL visible Code 128 clusters
 * AND ALL stacked/adjacent Code 128 barcodes crossed along merged columns (up to 24 per frame).
 * Zero heap allocations per frame.
 *
 * @returns {number} Number of distinct Code 128 barcodes decoded in this frame (`state.detCount`)
 */
export function processFrameMulti(luma, width, height, state, result, measureStages = false) {
  const t0 = measureStages ? performance.now() : 0;
  state.detCount = 0;
  const activeFlags = state.flags | 0;
  state.scanline.flags = activeFlags;
  state.scanline.linesEvaluated = 0;
  state.scanline.linesRejectedEarly = 0;
  state.scanline.matchLinesEvaluated = 0;
  state.scanline.matchLinesRejected = 0;
  state.roi.flags = activeFlags;

  // W10 (flagged `verticalMode`): try 11-line vertical plan BEFORE estimateRoi (skips t_roi on decode!)
  const useVertFast = (activeFlags & FLAG_VERTICAL_MODE) !== 0 && (state.scanline.mode | 0) === 1;
  if (useVertFast) {
    const savedFlags = state.scanline.flags;
    state.scanline.flags = savedFlags | FLAG_VERT_FALLBACK;
    result.detected = 0;
    result.payloadLen = 0;
    result.symbolCount = 0;
    result.consensusCount = 0;
    result.thetaDeg = 90;
    const fastHits = runScanlineConsensusMulti(
      luma,
      width,
      height,
      0,
      state.scanline,
      state.consensus,
      result
    );
    state.scanline.flags = savedFlags;
    if (fastHits > 0) {
      collectMultiConsensusSlots(state, result, width, height);
      if (state.detCount > 0) {
        const pLen = state.detPayloadLens[0];
        for (let k = 0; k < pLen; k++) result.payloadBytes[k] = state.detPayloadBytes[k];
        const sCount = state.detSymbolCounts[0];
        for (let k = 0; k < sCount; k++) result.symbolBytes[k] = state.detSymbolBytes[k];
        result.detected = 1;
        result.payloadLen = pLen;
        result.symbolCount = sCount;
        result.roiX = state.detRoiX[0];
        result.roiY = state.detRoiY[0];
        result.roiW = state.detRoiW[0];
        result.roiH = state.detRoiH[0];
        result.roiCenterX = state.detCenterX[0];
        result.roiCenterY = state.detCenterY[0];
        result.roiMajorLen = state.detMajorLen[0];
        result.thetaDeg = 90;
        result.roiConfidence = state.detConfidence[0];
        result.consensusCount = state.detAgreeCount[0];
        if (measureStages) {
          const tEnd = performance.now();
          result.tRoiMs = 0;
          result.tDecodeMs = tEnd - t0;
          result.tTotalMs = tEnd - t0;
        }
        return state.detCount;
      }
    }
  }

  const hasRoi = estimateRoi(luma, width, height, state.roi, result);
  if ((activeFlags & FLAG_FLOW_ON) !== 0) {
    computeOpticalFlow(
      state.roi.downsampled,
      state.roi.dsW,
      state.roi.dsH,
      state.roi.dsShift,
      state.predFlowDxDs,
      state.predFlowDyDs,
      state.flow,
      measureStages
    );
    result.flowDx = state.flow.dxFullPx;
    result.flowDy = state.flow.dyFullPx;
    result.flowConf = state.flow.conf;
    result.flowTiles = state.flow.tilesAccepted;
    result.tFlowMs = state.flow.tFlowMs;
  }
  const t1 = measureStages ? performance.now() : 0;

  if (hasRoi === 1) {
    const kCount = state.roi.clusterCount | 0;
    for (let c = 0; c < kCount; c++) {
      selectRoiCluster(state.roi, c, result);
      // W10: in verticalMode, reject non-vertical clusters outside 90 +/- 25 deg
      if (useVertFast && (result.thetaDeg < 65 || result.thetaDeg > 115)) {
        continue;
      }
      result.detected = 0;
      result.payloadLen = 0;
      result.symbolCount = 0;
      result.consensusCount = 0;

      const hits = runScanlineConsensusMulti(
        luma,
        width,
        height,
        1,
        state.scanline,
        state.consensus,
        result
      );
      if (hits > 0) {
        collectMultiConsensusSlots(state, result, width, height);
      }
    }

    // Center-strip fallback fan ONLY if none of the Top-K RoI clusters decoded
    if (state.detCount === 0) {
      result.detected = 0;
      result.payloadLen = 0;
      result.symbolCount = 0;
      result.consensusCount = 0;
      const hits = runScanlineConsensusMulti(
        luma,
        width,
        height,
        0,
        state.scanline,
        state.consensus,
        result
      );
      if (hits > 0) {
        collectMultiConsensusSlots(state, result, width, height);
      } else if (kCount > 0) {
        selectRoiCluster(state.roi, 0, result);
      }
    } else {
      // Populate primary `result` fields from detection #0 for backwards-compatible callers
      const pLen = state.detPayloadLens[0];
      for (let k = 0; k < pLen; k++) result.payloadBytes[k] = state.detPayloadBytes[k];
      const sCount = state.detSymbolCounts[0];
      for (let k = 0; k < sCount; k++) result.symbolBytes[k] = state.detSymbolBytes[k];
      result.detected = 1;
      result.payloadLen = pLen;
      result.symbolCount = sCount;
      result.roiX = state.detRoiX[0];
      result.roiY = state.detRoiY[0];
      result.roiW = state.detRoiW[0];
      result.roiH = state.detRoiH[0];
      result.roiCenterX = state.detCenterX[0];
      result.roiCenterY = state.detCenterY[0];
      result.roiMajorLen = state.detMajorLen[0];
      result.thetaDeg = state.detThetaDeg[0];
      result.roiConfidence = state.detConfidence[0];
      result.consensusCount = state.detAgreeCount[0];
    }
  } else {
    const hits = runScanlineConsensusMulti(
      luma,
      width,
      height,
      0,
      state.scanline,
      state.consensus,
      result
    );
    if (hits > 0) {
      collectMultiConsensusSlots(state, result, width, height);
    }
  }

  if (state.detCount > 0) {
    state.roi.noRoiStreak = 0;
  }
  const t2 = measureStages ? performance.now() : 0;
  if (measureStages) {
    result.tRoiMs = t1 - t0;
    result.tDecodeMs = t2 - t1;
    result.tTotalMs = t2 - t0;
  }

  return state.detCount;
}

// ============================================================================
// Result String / Hex Formatters (Invoked ONLY on Validated Decode Output)
// ============================================================================

const HEX_CHARS = '0123456789ABCDEF';

function toHexByte(b) {
  return HEX_CHARS[(b >> 4) & 15] + HEX_CHARS[b & 15];
}

function bytesSliceToAscii(bytes, offset, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += String.fromCharCode(bytes[offset + i]);
  }
  return out;
}

function bytesSliceToHex(bytes, offset, len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    if (i > 0) out += ' ';
    out += toHexByte(bytes[offset + i]);
  }
  return out;
}

function symbolsSliceToHex(syms, offset, count) {
  if (count < 3) return '';
  const start = syms[offset];
  const startLabel = start === 103 ? 'StartA' : (start === 104 ? 'StartB' : (start === 105 ? 'StartC' : 'Start?'));
  let out = `[${toHexByte(start)}:${startLabel}]`;
  for (let i = 1; i < count - 1; i++) {
    out += ` ${toHexByte(syms[offset + i])}`;
  }
  const chk = syms[offset + count - 1];
  out += ` [${toHexByte(chk)}:Mod103] [6A:Stop]`;
  return out;
}

export function extractPayloadString(result) {
  const len = result.payloadLen | 0;
  if (result.detected !== 1 || len <= 0) return '';
  return bytesSliceToAscii(result.payloadBytes, 0, len);
}

export function extractPayloadHex(result) {
  const len = result.payloadLen | 0;
  if (result.detected !== 1 || len <= 0) return '';
  return bytesSliceToHex(result.payloadBytes, 0, len);
}

export function extractSymbolsHex(result) {
  const count = result.symbolCount | 0;
  if (result.detected !== 1 || count < 3) return '';
  return symbolsSliceToHex(result.symbolBytes, 0, count);
}

/**
 * Extracts all validated detections from `state` after `processFrameMulti()`.
 */
export function extractMultiDetections(state) {
  const count = state.detCount | 0;
  if (count === 0) return [];
  const out = new Array(count);
  for (let d = 0; d < count; d++) {
    const pOff = d * MAX_CODE128_PAYLOAD;
    const pLen = state.detPayloadLens[d];
    const sOff = d * MAX_CODE128_SYMBOLS;
    const sCount = state.detSymbolCounts[d];
    const payload = bytesSliceToAscii(state.detPayloadBytes, pOff, pLen);
    const cx = state.detCenterX[d];
    const cy = state.detCenterY[d];
    const majorLen = state.detMajorLen[d];
    const thetaDeg = state.detThetaDeg[d];
    const rad = (thetaDeg * Math.PI) / 180;
    const halfDx = Math.cos(rad) * majorLen * 0.5;
    const halfDy = Math.sin(rad) * majorLen * 0.5;
    out[d] = {
      payload,
      payloadHex: bytesSliceToHex(state.detPayloadBytes, pOff, pLen),
      symbolsHex: symbolsSliceToHex(state.detSymbolBytes, sOff, sCount),
      symbology: 'CODE_128',
      prefixOk: payload.startsWith('tsX') ? 1 : 0,
      roiX: state.detRoiX[d],
      roiY: state.detRoiY[d],
      roiW: state.detRoiW[d],
      roiH: state.detRoiH[d],
      roiCenterX: cx,
      roiCenterY: cy,
      roiMajorLen: majorLen,
      x0: cx - halfDx,
      y0: cy - halfDy,
      x1: cx + halfDx,
      y1: cy + halfDy,
      thetaDeg,
      roiConfidence: state.detConfidence[d],
      consensusCount: state.detAgreeCount[d],
    };
  }
  return out;
}

/**
 * Builds an intermediate pipeline debug snapshot ONLY when `msg.debug === true`.
 * When multi-barcode detections exist, re-samples Detection #0's exact center scanline
 * (and collects center scanlines across all decoded detections) so Debug View never shows
 * a rejected trailing seam cluster.
 */
function buildDebugSnapshot(luma, width, height, state, result) {
  const roi = state.roi;
  const scan = state.scanline;

  const clusters = [];
  for (let c = 0; c < roi.clusterCount; c++) {
    clusters.push({
      x: roi.clusterX[c],
      y: roi.clusterY[c],
      w: roi.clusterW[c],
      h: roi.clusterH[c],
      cx: roi.clusterCenterX[c],
      cy: roi.clusterCenterY[c],
      thetaDeg: roi.clusterThetaDeg[c],
      conf: roi.clusterConfidence[c],
    });
  }

  const scanlines = [];
  let lineIdx = 0;
  let waveLen = 0;
  let waveOffset = 0;

  if (state.detCount > 0) {
    // Draw the exact center scanline across EVERY decoded detection in the frame
    for (let d = 0; d < state.detCount; d++) {
      const rad = (state.detThetaDeg[d] * Math.PI) / 180;
      const half = Math.max(36, state.detMajorLen[d] * 0.5 + 14);
      const dx = Math.cos(rad) * half;
      const dy = Math.sin(rad) * half;
      scanlines.push({
        x0: state.detCenterX[d] - dx,
        y0: state.detCenterY[d] - dy,
        x1: state.detCenterX[d] + dx,
        y1: state.detCenterY[d] + dy,
        active: d === 0,
      });
    }

    // Re-extract Detection #0's crisp center waveform + runs for Canvas 2–3
    result.roiCenterX = state.detCenterX[0];
    result.roiCenterY = state.detCenterY[0];
    result.roiMajorLen = state.detMajorLen[0];
    result.roiMinorLen = Math.min(state.detRoiW[0], state.detRoiH[0]);
    result.thetaDeg = state.detThetaDeg[0];
    const nLines = buildScanlinePlan(width, height, result, 1, scan, 7);
    if (nLines > 0) {
      lineIdx = 0;
      waveLen = sampleScanlineLuma(luma, width, scan, 0);
      waveOffset = 0;
      extractRunsFromScanline(scan.lumaBank, 0, waveLen, scan, 72, 18);
    }
  } else {
    lineIdx = Math.min(state.consensus.lastLineIdx | 0, Math.max(0, (scan.lineCount | 0) - 1));
    waveLen = scan.lineCount > 0 ? (scan.lineLength[lineIdx] | 0) : 0;
    waveOffset = Math.imul(lineIdx, MAX_SCANLINE_LEN);
    for (let i = 0; i < scan.lineCount; i++) {
      const x0 = scan.lineStartXQ16[i] / 65536;
      const y0 = scan.lineStartYQ16[i] / 65536;
      const len = scan.lineLength[i];
      const x1 = x0 + (scan.lineStepXQ16[i] / 65536) * len;
      const y1 = y0 + (scan.lineStepYQ16[i] / 65536) * len;
      scanlines.push({ x0, y0, x1, y1, active: i === lineIdx });
    }
  }

  return {
    dsW: roi.dsW,
    dsH: roi.dsH,
    dsShift: roi.dsShift,
    downsampled: new Uint8Array(roi.downsampled),
    gridW: roi.gridW,
    gridH: roi.gridH,
    blockCoherence: new Float32Array(roi.blockCoherence),
    blockScore: new Float32Array(roi.blockScore),
    blockDirCos2: new Float32Array(roi.blockDirCos2),
    blockDirSin2: new Float32Array(roi.blockDirSin2),
    blockState: new Uint8Array(roi.blockState),
    clusters,
    scanlines,
    waveLineIdx: lineIdx,
    waveLuma: waveLen > 0 ? new Uint8Array(scan.lumaBank.subarray(waveOffset, waveOffset + waveLen)) : new Uint8Array(0),
    runCount: scan.runCount,
    runWidthsQ8: scan.runCount > 0 ? new Int32Array(scan.runWidthsQ8.subarray(0, scan.runCount)) : new Int32Array(0),
    runIsBar: scan.runCount > 0 ? new Uint8Array(scan.runIsBar.subarray(0, scan.runCount)) : new Uint8Array(0),
  };
}

// ============================================================================
// Web Worker Message Handler (Browser Worker Context Only)
// ============================================================================

if (
  typeof self !== 'undefined' &&
  typeof self.postMessage === 'function' &&
  typeof window === 'undefined'
) {
  let workerState = null;
  const workerResult = createPipelineResult();

  self.onmessage = (event) => {
    const msg = event.data;
    if (!msg) return;

    if (msg.type === 'init') {
      const w = (msg.width | 0) || 1280;
      const h = (msg.height | 0) || 720;
      workerState = createPipelineState(w, h);
      workerState.flags = msg.flags | 0;
      workerState.scanline.flags = workerState.flags;
      self.postMessage({ type: 'ready', width: w, height: h, flags: workerState.flags });
      return;
    }

    if (msg.type === 'frame') {
      const width = msg.width | 0;
      const height = msg.height | 0;
      const buffer = msg.buffer;

      if (!workerState || workerState.width !== width || workerState.height !== height) {
        workerState = createPipelineState(width, height);
      }
      if (msg.flags !== undefined) {
        workerState.flags = msg.flags | 0;
      }
      workerState.scanline.flags = workerState.flags | 0;
      workerState.roi.flags = workerState.flags | 0;
      workerState.scanline.mode = msg.vertical ? 1 : 0;
      workerState.scanline.blurPx = Number.isFinite(msg.blurPx) ? msg.blurPx : 0;
      workerState.predFlowDxDs = Number.isFinite(msg.predFlowDxDs) ? msg.predFlowDxDs : 0;
      workerState.predFlowDyDs = Number.isFinite(msg.predFlowDyDs) ? msg.predFlowDyDs : 0;

      workerResult.detected = 0;
      workerResult.consensusCount = 0;
      workerResult.symbologyId = SYMBOLOGY_NONE;
      workerResult.payloadLen = 0;
      workerResult.symbolCount = 0;
      workerResult.tRoiMs = 0;
      workerResult.tDecodeMs = 0;
      workerResult.tFlowMs = 0;
      workerResult.tTotalMs = 0;
      workerResult.flowDx = 0;
      workerResult.flowDy = 0;
      workerResult.flowConf = 0;
      workerResult.flowTiles = 0;

      const luma = new Uint8Array(buffer, msg.byteOffset | 0, Math.imul(width, height));
      const useMulti = msg.multi !== false;
      const detCount = useMulti
        ? processFrameMulti(luma, width, height, workerState, workerResult, true)
        : processFrame(luma, width, height, workerState, workerResult, true);

      const decoded = detCount > 0 ? 1 : 0;
      const detections = useMulti ? extractMultiDetections(workerState) : null;
      const payload = decoded === 1 ? extractPayloadString(workerResult) : null;
      const payloadHex = decoded === 1 ? extractPayloadHex(workerResult) : null;
      const symbolsHex = decoded === 1 ? extractSymbolsHex(workerResult) : null;
      const debug = msg.debug ? buildDebugSnapshot(luma, width, height, workerState, workerResult) : null;

      self.postMessage(
        {
          type: 'result',
          frameId: msg.frameId | 0,
          tFrameMs: msg.tFrameMs || 0,
          cropX: msg.cropX | 0,
          cropY: msg.cropY | 0,
          frameW: width,
          frameH: height,
          flags: workerState.flags | 0,
          tCaptureMs: msg.tCaptureMs || 0,
          detected: decoded,
          detectionCount: detCount,
          detections,
          payload,
          payloadHex,
          symbolsHex,
          symbology: decoded === 1 ? 'CODE_128' : null,
          roiX: workerResult.roiX,
          roiY: workerResult.roiY,
          roiW: workerResult.roiW,
          roiH: workerResult.roiH,
          roiCenterX: workerResult.roiCenterX,
          roiCenterY: workerResult.roiCenterY,
          roiMajorLen: workerResult.roiMajorLen,
          roiMinorLen: workerResult.roiMinorLen,
          roiConfidence: workerResult.roiConfidence,
          thetaDeg: workerResult.thetaDeg,
          consensusCount: workerResult.consensusCount,
          tRoiMs: workerResult.tRoiMs,
          tDecodeMs: workerResult.tDecodeMs,
          tFlowMs: workerResult.tFlowMs,
          tTotalMs: workerResult.tTotalMs,
          flowDx: workerResult.flowDx,
          flowDy: workerResult.flowDy,
          flowConf: workerResult.flowConf,
          flowTiles: workerResult.flowTiles,
          debug,
          buffer,
        },
        [buffer]
      );
    }
  };
}
