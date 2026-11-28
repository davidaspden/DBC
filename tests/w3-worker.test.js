/**
 * Unit tests for Wave 3 Stream W worker upgrades:
 *  - W5 (`prefixStack`): prefix-aligned scanline stacking
 *  - W8 (`scanSmooth`): perpendicular box smoothing + light 3-tap sharpening
 *  - W9 (`roiSmallCodes`): adaptive 2x center-60% ROI pass for small/far barcodes
 *  - W12 (`deblur1d`): optional 1D along-scan deblur pass when blurPx in [1.5..8]
 */
import assert from 'node:assert/strict';
import { synthesizeFixture } from './harness.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrame,
  processFrameMulti,
  extractPayloadString,
} from '../src/worker/scanner.worker.js';
import {
  FLAG_CRIB_MATCH,
  FLAG_PREFIX_STACK,
  FLAG_SCAN_SMOOTH,
  FLAG_ROI_SMALL_CODES,
  FLAG_DEBLUR_1D,
  FLAG_FLOW_ON,
  createScanlineState,
  deblurScanlineLuma,
} from '../src/worker/scanline.js';
import { estimateRoi } from '../src/worker/roi.js';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

test('W5 prefixStack + W8 scanSmooth decode noisy/blurred tsX barcode cleanly with 0 FP on negatives', () => {
  const fix = synthesizeFixture({
    name: 'w3_tsx_noisy',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX98234101B',
    angleDeg: 90,
    modulePx: 2.2,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
    blurSigma: 0.9,
    noiseStd: 10,
  });

  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_CRIB_MATCH | FLAG_PREFIX_STACK | FLAG_SCAN_SMOOTH;

  const decoded = processFrame(fix.luma, 1280, 720, state, res, true);
  assert.equal(decoded, 1);
  assert.equal(extractPayloadString(res), 'tsX98234101B');

  // Verify negative clutter frame remains 0 FP
  const blank = new Uint8Array(1280 * 720).fill(140);
  const negDec = processFrame(blank, 1280, 720, state, res, true);
  assert.equal(negDec, 0);
});

test('W9 roiSmallCodes finds small ~12% frame-length barcode on 2x center-60% pass', () => {
  // Small barcode (~160 px major len on 1280x720 = 12.5% of frame width, barHeight 38 px)
  const fix = synthesizeFixture({
    name: 'w9_small_code',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX4401A',
    angleDeg: 0,
    modulePx: 1.5,
    barHeightPx: 36,
    centerX: 640,
    centerY: 360,
  });

  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_ROI_SMALL_CODES;
  state.roi.flags = FLAG_ROI_SMALL_CODES;

  // Simulate 3 frames; on frame 3 (noRoiStreak === 3) small2x runs if 4x missed
  let found = 0;
  for (let f = 0; f < 4; f++) {
    const ok = estimateRoi(fix.luma, 1280, 720, state.roi, res);
    if (ok === 1) {
      found = 1;
      break;
    }
  }
  assert.equal(found, 1, 'W9 should detect small barcode cluster via 4x or 2x fallback');
  assert.ok(Math.abs(res.roiCenterX - 640) < 60, `unexpected center X ${res.roiCenterX}`);
  assert.ok(Math.abs(res.roiCenterY - 360) < 60, `unexpected center Y ${res.roiCenterY}`);
});

test('W12 deblurScanlineLuma boosts blurred bar contrast and is a no-op when blurPx < 1.5', () => {
  const scanState = createScanlineState();
  const buf = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    buf[i] = Math.round(128 + 30 * Math.sin(i * 0.8));
  }
  const copyClean = new Uint8Array(buf);
  deblurScanlineLuma(buf, 0, 64, 1.0, scanState);
  assert.deepEqual(buf, copyClean, 'blurPx < 1.5 must be a no-op');

  deblurScanlineLuma(buf, 0, 64, 3.0, scanState);
  // Peak-to-trough amplitude should strictly increase
  let origSpan = 0;
  let newSpan = 0;
  let oMin = 255, oMax = 0, nMin = 255, nMax = 0;
  for (let i = 8; i < 56; i++) {
    if (copyClean[i] < oMin) oMin = copyClean[i];
    if (copyClean[i] > oMax) oMax = copyClean[i];
    if (buf[i] < nMin) nMin = buf[i];
    if (buf[i] > nMax) nMax = buf[i];
  }
  origSpan = oMax - oMin;
  newSpan = nMax - nMin;
  assert.ok(newSpan > origSpan, `expected contrast boost: ${newSpan} vs ${origSpan}`);
});

test('W13 flowOn runs cleanly inside processFrameMulti without regressing decode', () => {
  const fix = synthesizeFixture({
    name: 'w13_multi_flow',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX77001122B',
    angleDeg: 90,
    modulePx: 2.5,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
  });

  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_FLOW_ON;

  const n1 = processFrameMulti(fix.luma, 1280, 720, state, res, true);
  assert.equal(n1, 1);
  assert.equal(extractPayloadString(res), 'tsX77001122B');
  // Second identical frame -> flow runs with ~0 shift
  const n2 = processFrameMulti(fix.luma, 1280, 720, state, res, true);
  assert.equal(n2, 1);
  assert.ok(Math.abs(res.flowDx) < 1.0 && Math.abs(res.flowDy) < 1.0);
});

console.log(`All ${passed} Wave 3 Stream W tests passed.`);
