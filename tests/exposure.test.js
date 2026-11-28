/**
 * Unit tests for C4 Exposure & Speed Budget Helpers (`src/camera.js` + `src/capture/exposure.js`).
 *   node tests/exposure.test.js
 */

import assert from 'node:assert/strict';
import { getExposureInfo, setExposure } from '../src/camera.js';
import { computeMaxSafeSpeedInPerSec, formatExposureLabel } from '../src/capture/exposure.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running C4 exposure unit tests...');

await test('getExposureInfo handles missing track and parses W3C 100us exposure units', async () => {
  const empty = getExposureInfo(null);
  assert.equal(empty.supported, false);
  assert.equal(empty.manualSupported, false);

  const mockTrack = {
    getCapabilities: () => ({
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 1, max: 1000, step: 1 },
      iso: { min: 100, max: 3200, step: 50 },
    }),
    getSettings: () => ({ exposureMode: 'manual', exposureTime: 20, iso: 1600 }),
  };
  const info = getExposureInfo(mockTrack);
  assert.equal(info.manualSupported, true);
  assert.ok(Math.abs(info.exposureTimeSec - 0.002) < 1e-6);
  assert.equal(formatExposureLabel(info), '1/500s ISO 1600');
});

await test('setExposure uses two-step applyConstraints (mode first, then time + ISO)', async () => {
  const calls = [];
  const mockTrack = {
    getCapabilities: () => ({
      exposureMode: ['continuous', 'manual'],
      exposureTime: { min: 2, max: 1000, step: 2 },
      iso: { min: 100, max: 3300, step: 50 },
    }),
    getSettings: () => ({ exposureMode: 'manual', exposureTime: 20, iso: 2500 }),
    applyConstraints: async (c) => { calls.push(c); },
  };
  const res = await setExposure(mockTrack, { targetSec: 1 / 500, enableManual: true });
  assert.equal(res.ok, true);
  assert.equal(res.mode, 'manual');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].advanced[0].exposureMode, 'manual');
  assert.equal(calls[1].advanced[0].exposureTime, 20);
  assert.equal(calls[1].advanced[0].iso, 2500);
});

await test('computeMaxSafeSpeedInPerSec matches 3.5 in / 187-module blur physics', async () => {
  const v60 = computeMaxSafeSpeedInPerSec({ exposureSec: 1 / 60, labelLenIn: 3.5, modules: 187, blurModulesLimit: 1.0 });
  const v500 = computeMaxSafeSpeedInPerSec({ exposureSec: 1 / 500, labelLenIn: 3.5, modules: 187, blurModulesLimit: 1.0 });
  assert.ok(v60 > 1.0 && v60 < 1.3, `1/60s v_max=${v60}`);
  assert.ok(v500 > 8.5 && v500 < 10.0, `1/500s v_max=${v500}`);
});

console.log(`All ${passed} C4 exposure tests passed.`);
