/**
 * G4 — Regression tests against David's real Samsung Galaxy A53 5G (`SM-A536B`)
 * diagnostics JSON fixture (`tests/fixtures-sim/diag-cc0f88.json`, captured 2026-11-28 04:51 GMT).
 *
 * Exercises the real PP1, PP3, PP4, PP5, and PP6 functions from `src/diag/*` directly
 * against the verbatim captured report so none of those device-specific fixes can regress.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { recommend } from '../src/diag/recommend.js';
import { resolveOsGuess, buildDefaultLabelTests } from '../src/diag/probe.js';
import { classifyMotionPermissionPath, measureGyroAtRestWithRetry } from '../src/diag/sensors.js';
import { formatReportText } from '../src/diag/report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures-sim', 'diag-cc0f88.json');
const cc0f88 = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

console.log('Running G4 diag-cc0f88 regression tests...');

await test('fixture loads verbatim cc0f88 A53 report with expected metadata & camera caps', async () => {
  assert.equal(cc0f88.version, 1);
  assert.equal(cc0f88.reportId, 'cc0f88');
  assert.equal(cc0f88.env.highEntropy.model, 'SM-A536B');
  assert.equal(cc0f88.cameras.length, 4);
  const mainCam = cc0f88.cameras.find((c) => c.idHash === '004839289298');
  assert.ok(mainCam, 'camera 0 (004839289298) must exist');
  assert.equal(mainCam.capabilities.torch, true);
  assert.equal(mainCam.capabilities.exposureTime.min, 0.42);
  assert.equal(mainCam.capabilities.exposureTime.max, 1000);
  assert.equal(mainCam.capabilities.iso.min, 50);
  assert.equal(mainCam.capabilities.iso.max, 3200);
  assert.equal(cc0f88.capture.measuredFps, 10.1);
});

await test('PP1: recommend(cc0f88) returns part2-slide and selects camera 0 (not false part3-tele)', async () => {
  // The raw captured report had the pre-PP1 false-positive `part3-tele` recommendation;
  // re-running current `recommend()` on the verbatim fixture must pick `part2-slide` + camera 0.
  const rec = recommend(cc0f88);
  assert.equal(rec.mode, 'part2-slide');
  assert.equal(rec.recommendedCameraHash, '004839289298');
});

await test('PP3: resolveOsGuess(cc0f88.env) returns Android 16.0.0 rather than frozen UA Android 10', async () => {
  assert.equal(cc0f88.env.osGuess, 'Android 10'); // raw pre-PP3 field in fixture
  const resolved = resolveOsGuess(cc0f88.env.userAgent, cc0f88.env.highEntropy);
  assert.equal(resolved, 'Android 16.0.0');
});

await test('PP4: classifyMotionPermissionPath never labels Android Chrome as devicemotion-ios', async () => {
  assert.equal(cc0f88.sensors.permission.path, 'devicemotion-ios'); // raw pre-PP4 bug in fixture
  const withGeneric = classifyMotionPermissionPath({
    hasGenericGyro: Boolean(cc0f88.sensors.generic.Gyroscope && cc0f88.sensors.generic.Gyroscope.constructed),
    hasDeviceMotion: Boolean(cc0f88.sensors.deviceMotion && cc0f88.sensors.deviceMotion.present),
    hasRequestPermission: true,
    userAgent: cc0f88.env.userAgent,
    platform: cc0f88.env.highEntropy.platform,
  });
  assert.equal(withGeneric, 'generic-sensor');
  assert.notEqual(withGeneric, 'devicemotion-ios');

  const withoutGeneric = classifyMotionPermissionPath({
    hasGenericGyro: false,
    hasDeviceMotion: true,
    hasRequestPermission: true,
    userAgent: cc0f88.env.userAgent,
    platform: cc0f88.env.highEntropy.platform,
  });
  assert.equal(withoutGeneric, 'devicemotion-android');
  assert.notEqual(withoutGeneric, 'devicemotion-ios');
});

await test('PP5: buildDefaultLabelTests populates explicit skipped reasons (not empty {})', async () => {
  assert.deepEqual(cc0f88.labelTests, {}); // raw pre-PP5 empty object in fixture
  const lt = buildDefaultLabelTests('not-run-interactive-test');
  assert.equal(lt.in8.skipped, true);
  assert.equal(lt.in8.reason, 'not-run-interactive-test');
  assert.equal(lt.in30.skipped, true);
  assert.equal(lt.in30.reason, 'not-run-interactive-test');

  const patched = { ...cc0f88, labelTests: lt, recommendation: recommend(cc0f88) };
  const txt = formatReportText(patched);
  assert.ok(txt.includes('skipped (not-run-interactive-test)'), 'formatted report must explain skipped labelTests');
});

await test('PP6: measureGyroAtRestWithRetry fails on cc0f88 rms 1.92 dps and passes on 0.2 dps still fixture', async () => {
  const movedSample = { ...cc0f88.sensors.atRest };
  assert.equal(movedSample.rmsDps, 1.92);

  // When both attempts see the cc0f88 rms=1.92 moved window -> fails and refuses to record bias.
  let movedCalls = 0;
  const failRes = await measureGyroAtRestWithRetry({
    durationMs: 2000,
    countdownSec: 0,
    maxRetries: 1,
    onStatus: () => {},
    sleepFn: async () => {},
    sampleFn: async () => {
      movedCalls++;
      return { ...movedSample };
    },
  });
  assert.equal(movedCalls, 2);
  assert.equal(failRes.pass, false);
  assert.equal(failRes.biasRecorded, false);
  assert.equal(failRes.biasDps, null);

  // When retry returns a clean still window (rms 0.2 dps) -> passes and records bias.
  const stillSample = {
    source: 'Gyroscope',
    durationMs: 2000,
    n: 118,
    biasDps: { x: 0.02, y: -0.03, z: 0.01 },
    maxAbsBiasDps: 0.03,
    rmsDps: 0.2,
    pass: true,
    movedDuringTest: false,
    error: null,
  };
  let retryCalls = 0;
  const passRes = await measureGyroAtRestWithRetry({
    durationMs: 2000,
    countdownSec: 0,
    maxRetries: 1,
    onStatus: () => {},
    sleepFn: async () => {},
    sampleFn: async () => {
      retryCalls++;
      return retryCalls === 1 ? { ...movedSample } : { ...stillSample };
    },
  });
  assert.equal(retryCalls, 2);
  assert.equal(passRes.pass, true);
  assert.equal(passRes.biasRecorded, true);
  assert.deepEqual(passRes.biasDps, stillSample.biasDps);
});

console.log(`All ${passed} diag-cc0f88 tests passed.`);
