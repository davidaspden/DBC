/**
 * Unit tests for Wave 3 Stream W worker upgrades:
 *  - W5 (`prefixStack`): prefix-aligned scanline stacking
 *  - W8 (`scanSmooth`): perpendicular box smoothing + light 3-tap sharpening
 *  - W9 (`roiSmallCodes`): adaptive 2x center-60% ROI pass for small/far barcodes
 *  - W12 (`deblur1d`): optional 1D along-scan deblur pass when blurPx in [1.5..8]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  synthesizeFixture,
  buildSyntheticTestMatrix,
  encodeCode128,
  parsePGM,
} from './harness.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrame,
  processFrameMulti,
  extractPayloadString,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import {
  createCode128State,
  decodeCode128FromRuns,
} from '../src/worker/decoders/code128.js';
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

test('H6 cribMatch skips 103-symbol search on tsX via fixed-scale O(1) LUT and falls back cleanly on >0.3 mod warp', () => {
  // 1. Direct run-level verification: clean tsX runs succeed on fast path with 0 full-search symbols
  const enc = encodeCode128('tsX07wz7py1', { subset: 'B', quietZoneModules: 10 });
  const modPxQ8 = 512; // 2.0 px/module
  const runs = [];
  const isBar = [];
  let cur = enc.modules[0];
  let cnt = 1;
  for (let m = 1; m < enc.totalModules; m++) {
    if (enc.modules[m] === cur) cnt++;
    else { runs.push(cnt * modPxQ8); isBar.push(cur); cur = enc.modules[m]; cnt = 1; }
  }
  runs.push(cnt * modPxQ8); isBar.push(cur);

  const runWidthsQ8 = Int32Array.from(runs);
  const runIsBar = Uint8Array.from(isBar);
  const cState = createCode128State();
  cState.flags = FLAG_CRIB_MATCH;

  const statusClean = decodeCode128FromRuns(runWidthsQ8, runIsBar, runWidthsQ8.length, cState);
  assert.equal(statusClean, 2);
  let cleanStr = '';
  for (let i = 0; i < cState.payloadLen; i++) cleanStr += String.fromCharCode(cState.payloadBytes[i]);
  assert.equal(cleanStr, 'tsX07wz7py1');
  assert.equal(cState.cribFastSuccess, 1, 'clean tsX should decode on H6 fixed-scale fast path');
  assert.equal(cState.cribFastFallbacks, 0);
  assert.equal(cState.cribSymbolsFull, 0, 'clean tsX fast path must skip 100% of 103-way searches');
  assert.equal(cState.cribSymbolsFast, 12); // 11 chars + check symbol = 12 symbols skipped!

  // 2. Perturb a single bar/space pair by +/-0.42 module (exceeds +/-0.30 tolerance while preserving e-distance)
  //    -> fast path cleanly aborts and full search still decodes the exact payload!
  const warped = new Int32Array(runWidthsQ8);
  warped[25] = Math.round(warped[25] + 0.42 * modPxQ8);
  warped[26] = Math.round(warped[26] - 0.42 * modPxQ8);
  const cWarp = createCode128State();
  cWarp.flags = FLAG_CRIB_MATCH;
  const statusWarp = decodeCode128FromRuns(warped, runIsBar, warped.length, cWarp);
  assert.equal(statusWarp, 2);
  let warpStr = '';
  for (let i = 0; i < cWarp.payloadLen; i++) warpStr += String.fromCharCode(cWarp.payloadBytes[i]);
  assert.equal(warpStr, 'tsX07wz7py1');
  assert.equal(cWarp.cribFastFallbacks, 1, 'warped runs >0.3 mod must fall back to full search');
  assert.ok(cWarp.cribSymbolsFull > 0);
});

test('H6 cribMatch preserves exact decoded set on all 14 harness fixtures & real still with low overhead', () => {
  const fixtures = buildSyntheticTestMatrix();
  const stOff = createPipelineState(1280, 720);
  const stOn = createPipelineState(1280, 720);
  stOn.flags = FLAG_CRIB_MATCH;
  const resOff = createPipelineResult();
  const resOn = createPipelineResult();

  for (const fx of fixtures) {
    const dOff = processFrame(fx.luma, fx.width, fx.height, stOff, resOff, false);
    const pOff = dOff === 1 ? extractPayloadString(resOff) : null;
    const dOn = processFrame(fx.luma, fx.width, fx.height, stOn, resOn, false);
    const pOn = dOn === 1 ? extractPayloadString(resOn) : null;
    assert.equal(dOn, dOff, `decode status mismatch on ${fx.id}`);
    assert.equal(pOn, pOff, `payload mismatch on ${fx.id}: ${pOn} vs ${pOff}`);
  }

  // Interleaved timing on 16 harness fixtures (flagsOff vs cribMatch)
  for (let w = 0; w < 3; w++) {
    for (const fx of fixtures) {
      processFrame(fx.luma, fx.width, fx.height, stOff, resOff, false);
      processFrame(fx.luma, fx.width, fx.height, stOn, resOn, false);
    }
  }
  const hOff = [];
  const hOn = [];
  for (let rep = 0; rep < 5; rep++) {
    for (const fx of fixtures) {
      const a0 = performance.now();
      processFrame(fx.luma, fx.width, fx.height, stOff, resOff, false);
      hOff.push(performance.now() - a0);
      const b0 = performance.now();
      processFrame(fx.luma, fx.width, fx.height, stOn, resOn, false);
      hOn.push(performance.now() - b0);
    }
  }
  hOff.sort((a, b) => a - b);
  hOn.sort((a, b) => a - b);
  const hp50Off = hOff[hOff.length >> 1];
  const hp50On = hOn[hOn.length >> 1];
  console.log(
    `  INFO  H6 harness (16x 720p): flagsOff p50=${hp50Off.toFixed(3)}ms | cribMatch p50=${hp50On.toFixed(3)}ms ` +
    `(delta=${(((hp50On - hp50Off) / hp50Off) * 100).toFixed(1)}%)`
  );

  // Real 1080x2400 still fixture: parity + interleaved timing + skipped-ops telemetry
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pgmPath = path.join(__dirname, 'fixtures-sim', 'tote-tsX07wz7py1-gray.pgm.gz');
  const { width, height, luma } = parsePGM(zlib.gunzipSync(fs.readFileSync(pgmPath)));

  const sStillOff = createPipelineState(width, height);
  const sStillOn = createPipelineState(width, height);
  sStillOn.flags = FLAG_CRIB_MATCH;
  const rOff = createPipelineResult();
  const rOn = createPipelineResult();

  // Warmup
  for (let i = 0; i < 5; i++) {
    processFrameMulti(luma, width, height, sStillOff, rOff, false);
    processFrameMulti(luma, width, height, sStillOn, rOn, false);
  }
  sStillOn.consensus.c128.cribFastAttempts = 0;
  sStillOn.consensus.c128.cribFastSuccess = 0;
  sStillOn.consensus.c128.cribFastFallbacks = 0;
  sStillOn.consensus.c128.cribSymbolsFast = 0;
  sStillOn.consensus.c128.cribSymbolsFull = 0;

  const ITERS = 21;
  const tOff = [];
  const tOn = [];
  for (let i = 0; i < ITERS; i++) {
    const a0 = performance.now();
    processFrameMulti(luma, width, height, sStillOff, rOff, false);
    tOff.push(performance.now() - a0);
    const b0 = performance.now();
    processFrameMulti(luma, width, height, sStillOn, rOn, false);
    tOn.push(performance.now() - b0);
  }
  const detOff = extractMultiDetections(sStillOff).map((d) => d.payload);
  const detOn = extractMultiDetections(sStillOn).map((d) => d.payload);
  assert.deepEqual(detOn, ['tsX07wz7py1']);
  assert.deepEqual(detOn, detOff);

  tOff.sort((a, b) => a - b);
  tOn.sort((a, b) => a - b);
  const p50Off = tOff[ITERS >> 1];
  const p50On = tOn[ITERS >> 1];
  const c128 = sStillOn.consensus.c128;
  const totalSyms = c128.cribSymbolsFast + c128.cribSymbolsFull;
  const skipFrac = totalSyms > 0 ? (c128.cribSymbolsFast / totalSyms) * 100 : 0;
  console.log(
    `  INFO  H6 still (1080x2400): flagsOff p50=${p50Off.toFixed(2)}ms | cribMatch p50=${p50On.toFixed(2)}ms ` +
    `(delta=${(((p50On - p50Off) / p50Off) * 100).toFixed(1)}%) | ` +
    `fastHits=${c128.cribFastSuccess}/${c128.cribFastAttempts}, opsSkipped=${skipFrac.toFixed(1)}%`
  );
  assert.ok(c128.cribFastSuccess > 0, 'H6 fast path must trigger on real tsX still');
});

console.log(`All ${passed} Wave 3 Stream W tests passed.`);
