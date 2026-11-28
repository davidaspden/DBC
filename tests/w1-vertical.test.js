/**
 * Unit tests for Wave 1 Stream W: W11 (geometry/flags plumbing) & W1 (`vertFallback` scanlines).
 *   node tests/w1-vertical.test.js
 */

import assert from 'node:assert/strict';
import {
  createScanlineState,
  buildScanlinePlan,
  sampleScanlineLuma,
  FLAG_VERT_FALLBACK,
} from '../src/worker/scanline.js';
import { createConsensusState, runScanlineConsensus } from '../src/worker/consensus.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
  extractPayloadString,
} from '../src/worker/scanner.worker.js';
import { synthesizeFixture } from './harness.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running W11 + W1 vertical fallback unit tests...');

test('W11 extractMultiDetections attaches additive x0/y0/x1/y1 endpoints and prefixOk', () => {
  const fx = synthesizeFixture({
    id: 'w11_tsx',
    seed: 9101,
    symbology: 'CODE_128',
    payload: 'tsX11A000101',
    subset: 'B',
    angleDeg: 90,
    modulePx: 2.5,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
  });
  const state = createPipelineState(fx.width, fx.height);
  const res = createPipelineResult();
  const count = processFrameMulti(fx.luma, fx.width, fx.height, state, res, true);
  assert.equal(count, 1);
  const dets = extractMultiDetections(state);
  assert.equal(dets[0].payload, 'tsX11A000101');
  assert.equal(dets[0].prefixOk, 1);
  assert.ok(Number.isFinite(dets[0].x0) && Number.isFinite(dets[0].y1));
  assert.ok(Math.hypot(dets[0].x1 - dets[0].x0, dets[0].y1 - dets[0].y0) > 200);
});

test('W1 vertFallback vertical mode decodes >= 95% across 9 horizontal positions (hasRoi=0)', () => {
  const positions = [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90];
  const scanOff = createScanlineState();
  const scanOn = createScanlineState();
  scanOn.flags = FLAG_VERT_FALLBACK;
  scanOn.mode = 1;
  const cons = createConsensusState();
  const res = createPipelineResult();

  let hitsOff = 0;
  let hitsOn = 0;

  for (let i = 0; i < positions.length; i++) {
    const fx = synthesizeFixture({
      id: `w1_pos_${i}`,
      seed: 9200 + i,
      symbology: 'CODE_128',
      payload: `tsX90POS00${i}B`,
      subset: 'B',
      angleDeg: 90,
      modulePx: 2.4,
      barHeightPx: 240,
      centerX: Math.round(1280 * positions[i]),
      centerY: 360,
    });

    // Flag OFF (baseline center-only fan)
    res.detected = 0; res.payloadLen = 0; res.consensusCount = 0;
    const decOff = runScanlineConsensus(fx.luma, fx.width, fx.height, 0, scanOff, cons, res);
    if (decOff === 1 && extractPayloadString(res) === fx.payload) hitsOff++;

    // Flag ON (full-width 11-line vertical fallback)
    res.detected = 0; res.payloadLen = 0; res.consensusCount = 0;
    const decOn = runScanlineConsensus(fx.luma, fx.width, fx.height, 0, scanOn, cons, res);
    if (decOn === 1 && extractPayloadString(res) === fx.payload) hitsOn++;
  }

  assert.ok(hitsOn >= 9, `expected 9/9 vertical fallback hits across frame width, got ${hitsOn}/9 (baseline off=${hitsOff}/9)`);
  assert.ok(hitsOn > hitsOff, `expected W1 (${hitsOn}) to beat baseline center-only fallback (${hitsOff})`);
});

test('W1 sampleScanlineLuma at 90 deg (stepXQ16=0) samples clean vertical strip', () => {
  const w = 1280, h = 720;
  const luma = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) luma[y * w + 320] = y & 255;

  const scan = createScanlineState();
  scan.flags = FLAG_VERT_FALLBACK;
  scan.mode = 1;
  const n = buildScanlinePlan(w, h, createPipelineResult(), 0, scan);
  assert.equal(n, 11);
  assert.equal(scan.lineStepXQ16[0], 0);
  assert.equal(scan.lineStepYQ16[0], 65536);

  // Sample line 2 (x = floor(1280 * 3 / 12) = 320)
  const len = sampleScanlineLuma(luma, w, scan, 2);
  assert.equal(len, h - 5);
  assert.equal(scan.lumaBank[2 * 2304 + 10], 12); // y = 2 + 10 = 12
});

console.log(`All ${passed} W11/W1 vertical fallback tests passed.`);
