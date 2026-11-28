/**
 * G4 — Real Still Fixture Decode & Device-Factor Benchmark (`tote-tsX07wz7py1-gray.pgm.gz`).
 *
 * Gunzips David's real 1080x2400 tote still (`tsX07wz7py1`, 11 chars, 176 modules, ladder),
 * decodes it with `processFrameMulti` and `processFrame` under:
 *   1. flags off (`0`)
 *   2. `verticalMode | cribMatch | requirePrefix`
 *
 * Asserts decode correctness (payload === 'tsX07wz7py1', prefixOk === 1, 0 false positives)
 * and prints Node p50/p95 timings over ~30 iterations. Does NOT fail on timing so the test
 * stays portable across machines.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { parsePGM } from './harness.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrame,
  processFrameMulti,
  extractPayloadString,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import {
  FLAG_VERTICAL_MODE,
  FLAG_CRIB_MATCH,
  FLAG_REQUIRE_PREFIX,
} from '../src/worker/flagbits.js';
import { percentile } from '../src/util/stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures-sim', 'tote-tsX07wz7py1-gray.pgm.gz');
const EXPECTED_PAYLOAD = 'tsX07wz7py1';
const PHONE_MS_A53 = 38;
const FLAGS_ON = FLAG_VERTICAL_MODE | FLAG_CRIB_MATCH | FLAG_REQUIRE_PREFIX;

function measureMulti(luma, width, height, flagsMask, vertMode, iters = 30) {
  const state = createPipelineState(width, height);
  const result = createPipelineResult();
  state.flags = flagsMask;
  state.scanline.mode = vertMode ? 1 : 0;

  // Warmup (5 iterations)
  for (let i = 0; i < 5; i++) {
    processFrameMulti(luma, width, height, state, result, true);
  }

  const samples = new Array(iters);
  let lastDets = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    processFrameMulti(luma, width, height, state, result, true);
    const dt = performance.now() - t0;
    samples[i] = dt;
    lastDets = extractMultiDetections(state);
  }
  samples.sort((a, b) => a - b);
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    detections: lastDets,
    consensusCount: result.consensusCount,
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

console.log('Running G4 real still fixture tests...');

const gzBytes = fs.readFileSync(FIXTURE_PATH);
const pgmBytes = zlib.gunzipSync(gzBytes);
const { width, height, luma } = parsePGM(pgmBytes);

let offStats = null;
let onStats = null;

test('PGM fixture decompresses cleanly to 1080x2400 P5 luma plane', () => {
  assert.equal(width, 1080);
  assert.equal(height, 2400);
  assert.equal(luma.length, 1080 * 2400);
});

test('processFrameMulti decodes tsX07wz7py1 with flags off (0 FP)', () => {
  offStats = measureMulti(luma, width, height, 0, false, 30);
  assert.equal(offStats.detections.length, 1, `expected 1 detection, got ${offStats.detections.length}`);
  assert.equal(offStats.detections[0].payload, EXPECTED_PAYLOAD);
  assert.equal(offStats.detections[0].prefixOk, 1);
  // 0 false positives: every detection matches expected payload
  const fp = offStats.detections.filter((d) => d.payload !== EXPECTED_PAYLOAD);
  assert.equal(fp.length, 0);
});

test('processFrameMulti decodes tsX07wz7py1 with verticalMode+cribMatch+requirePrefix (prefixOk=1, 0 FP)', () => {
  onStats = measureMulti(luma, width, height, FLAGS_ON, true, 30);
  assert.equal(onStats.detections.length, 1, `expected 1 detection, got ${onStats.detections.length}`);
  assert.equal(onStats.detections[0].payload, EXPECTED_PAYLOAD);
  assert.equal(onStats.detections[0].prefixOk, 1);
  const fp = onStats.detections.filter((d) => d.payload !== EXPECTED_PAYLOAD);
  assert.equal(fp.length, 0);
});

test('processFrame decodes tsX07wz7py1 with flags off and with verticalMode+cribMatch+requirePrefix', () => {
  const state = createPipelineState(width, height);
  const res = createPipelineResult();

  state.flags = 0;
  state.scanline.mode = 0;
  const dOff = processFrame(luma, width, height, state, res, true);
  assert.equal(dOff, 1);
  assert.equal(extractPayloadString(res), EXPECTED_PAYLOAD);

  state.flags = FLAGS_ON;
  state.scanline.mode = 1;
  const dOn = processFrame(luma, width, height, state, res, true);
  assert.equal(dOn, 1);
  assert.equal(extractPayloadString(res), EXPECTED_PAYLOAD);
});

const deviceFactor = offStats.p50 > 0 ? (PHONE_MS_A53 / offStats.p50) : 0;
console.log(
  `  INFO  still-fixture (1080x2400, 30 iters): ` +
  `flagsOff p50=${offStats.p50.toFixed(2)}ms p95=${offStats.p95.toFixed(2)}ms | ` +
  `flagsOn p50=${onStats.p50.toFixed(2)}ms p95=${onStats.p95.toFixed(2)}ms | ` +
  `provisional deviceFactorA53=${deviceFactor.toFixed(2)}x (phoneMs=${PHONE_MS_A53})`
);

console.log(`All ${passed} still fixture tests passed.`);
