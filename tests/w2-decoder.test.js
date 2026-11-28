/**
 * Unit tests for Wave 2 Stream W Decoder Flags:
 *  - W2 (`extraLines`): 13 scanlines on RoI path
 *  - W3 (`cribMatch`): 44-module StartB+'t'+'s'+'X' crib detection & modulePxQ8 estimation
 *  - W4 (`requirePrefix` / `requirePrefixStrict`): tsX boost with mandatory plain-decode fallback
 *  - W6 (`illumNorm`): O(N) integer illumination normalization across strong shadow gradient
 *  - W7 (`subpixEdges`): local mid-crossing primary extractor at low px/module
 *  - W10 (`verticalMode`): fast vertical pass skipping estimateRoi (`tRoiMs === 0`)
 *
 *   node tests/w2-decoder.test.js
 */

import assert from 'node:assert/strict';
import { WORKER_FLAG_BITS } from '../src/flags.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrame,
  processFrameMulti,
  extractPayloadString,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import { synthesizeFixture } from './harness.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running Wave 2 Stream W decoder flag unit tests...');

test('W3 cribMatch detects tsX prefix and estimates modulePxQ8 within 5% of ground truth', () => {
  const fx = synthesizeFixture({
    id: 'w3_tsx_crib',
    seed: 9301,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'tsX42A001234',
    angleDeg: 90,
    modulePx: 2.2,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
  });
  const state = createPipelineState(fx.width, fx.height);
  state.flags = WORKER_FLAG_BITS.cribMatch;
  const res = createPipelineResult();
  const dec = processFrame(fx.luma, fx.width, fx.height, state, res, true);
  assert.equal(dec, 1);
  assert.equal(extractPayloadString(res), 'tsX42A001234');
  assert.equal(state.consensus.c128.cribMatched, 1);
  const estModPx = state.consensus.c128.cribModulePxQ8 / 256;
  assert.ok(Math.abs(estModPx - 2.2) / 2.2 < 0.06, `estModPx=${estModPx}, expected ~2.2`);
});

test('W4 requirePrefix still decodes plain non-tsX labels (mandatory fallback) while strict blocks them', () => {
  const plainFx = synthesizeFixture({
    id: 'w4_plain',
    seed: 9302,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'PLAIN-123456',
    angleDeg: 90,
    modulePx: 2.5,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
  });

  const sFallback = createPipelineState(plainFx.width, plainFx.height);
  sFallback.flags = WORKER_FLAG_BITS.cribMatch | WORKER_FLAG_BITS.requirePrefix;
  const r1 = createPipelineResult();
  assert.equal(processFrame(plainFx.luma, plainFx.width, plainFx.height, sFallback, r1, false), 1);
  assert.equal(extractPayloadString(r1), 'PLAIN-123456');

  const sStrict = createPipelineState(plainFx.width, plainFx.height);
  sStrict.flags = WORKER_FLAG_BITS.requirePrefixStrict;
  const r2 = createPipelineResult();
  assert.equal(processFrame(plainFx.luma, plainFx.width, plainFx.height, sStrict, r2, false), 0);
});

test('W2 + W6 + W7 combined decode low-ppm shadowed/blurred tsX barcode cleanly', () => {
  const fx = synthesizeFixture({
    id: 'w267_hard',
    seed: 9303,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'tsX99HARD01B',
    angleDeg: 90,
    modulePx: 1.9,
    barHeightPx: 150,
    centerX: 640,
    centerY: 360,
    shadowGradient: { minGain: 0.42, maxGain: 1.05, angleDeg: 85 },
    noiseSigma: 5.0,
  });
  const state = createPipelineState(fx.width, fx.height);
  state.flags = WORKER_FLAG_BITS.extraLines | WORKER_FLAG_BITS.illumNorm | WORKER_FLAG_BITS.subpixEdges | WORKER_FLAG_BITS.cribMatch;
  const res = createPipelineResult();
  const count = processFrameMulti(fx.luma, fx.width, fx.height, state, res, true);
  assert.equal(count, 1);
  assert.equal(extractMultiDetections(state)[0].payload, 'tsX99HARD01B');
});

test('W10 verticalMode fast-path decodes vertical label with tRoiMs === 0', () => {
  const fx = synthesizeFixture({
    id: 'w10_vert_fast',
    seed: 9304,
    symbology: 'CODE_128',
    subset: 'B',
    payload: 'tsXVERT0010B',
    angleDeg: 90,
    modulePx: 2.5,
    barHeightPx: 220,
    centerX: 640,
    centerY: 360,
  });
  const state = createPipelineState(fx.width, fx.height);
  state.flags = WORKER_FLAG_BITS.verticalMode;
  state.scanline.mode = 1;
  const res = createPipelineResult();
  const count = processFrameMulti(fx.luma, fx.width, fx.height, state, res, true);
  assert.equal(count, 1);
  assert.equal(res.tRoiMs, 0, `expected estimateRoi skipped (tRoiMs=0), got ${res.tRoiMs}`);
  assert.equal(extractMultiDetections(state)[0].payload, 'tsXVERT0010B');
});

console.log(`All ${passed} Wave 2 Stream W decoder tests passed.`);
