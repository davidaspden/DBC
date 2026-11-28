/**
 * Unit tests for Step D0 (Standalone Device Diagnostics).
 * Runs in Node.js ESM with zero external dependencies:
 *   node tests/diag.test.js
 */

import assert from 'node:assert/strict';
import { hashDeviceId } from '../src/diag/hash.js';
import { classifyCameras } from '../src/diag/cameras.js';
import { recommend } from '../src/diag/recommend.js';
import { formatReportJson, formatReportText } from '../src/diag/report.js';

let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

function baseEnv(overrides = {}) {
  return {
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-A536B) AppleWebKit/537.36 Chrome/134.0.0.0 Mobile Safari/537.36',
    osGuess: 'Android 14',
    browserGuess: 'Chrome 134',
    uaModelGuess: 'SM-A536B',
    highEntropy: { model: 'SM-A536B', platform: 'Android', platformVersion: '14' },
    screenWidth: 412,
    screenHeight: 915,
    devicePixelRatio: 2.625,
    isSecureContext: true,
    protocol: 'https:',
    supportedConstraints: { zoom: true, focusMode: true, torch: true },
    ...overrides,
  };
}

function a53Fixture(overrides = {}) {
  const cams = classifyCameras([
    {
      index: 0,
      label: 'camera2 0, facing back',
      idHash: 'a1b2c3d4e5f6',
      groupHash: '112233445566',
      facing: 'environment',
      capabilities: {
        width: { min: 160, max: 4000 },
        height: { min: 120, max: 3000 },
        zoom: { min: 1, max: 10, step: 0.1 },
        focusMode: ['continuous', 'manual'],
        focusDistance: { min: 0.1, max: 10 },
        exposureTime: 'n/a',
        iso: 'n/a',
        torch: true,
      },
      settings: { width: 1920, height: 1080, frameRate: 30, zoom: 1, focusMode: 'continuous' },
      resolutions: {
        '720p': { ok: true, width: 1280, height: 720, frameRate: 30 },
        '1080p': { ok: true, width: 1920, height: 1080, frameRate: 30 },
        '4K': { ok: false, error: 'OverconstrainedError' },
      },
      zoomSweep: {
        steps: [
          { requested: 1, achieved: 1, meanLuma: 120, frameDiff: 0, capDelta: false },
          { requested: 2, achieved: 2, meanLuma: 121, frameDiff: 8, capDelta: false },
          { requested: 3, achieved: 3, meanLuma: 119, frameDiff: 9, capDelta: false },
        ],
        framingJumpDetected: false,
        capsChangedDetected: false,
        logicalZoomLikely: false,
      },
      error: null,
    },
    {
      index: 1,
      label: 'camera2 2, facing back',
      idHash: 'b2c3d4e5f607',
      groupHash: '112233445566',
      facing: 'environment',
      capabilities: {
        width: { min: 160, max: 3264 },
        height: { min: 120, max: 2448 },
        zoom: 'n/a',
        focusMode: 'n/a',
        focusDistance: 'n/a',
        exposureTime: 'n/a',
        iso: 'n/a',
        torch: false,
      },
      settings: { width: 1920, height: 1080, frameRate: 30 },
      resolutions: {
        '720p': { ok: true, width: 1280, height: 720, frameRate: 30 },
        '1080p': { ok: true, width: 1920, height: 1080, frameRate: 30 },
      },
      zoomSweep: null,
      error: null,
    },
    {
      index: 2,
      label: 'camera2 3, facing back',
      idHash: 'c3d4e5f60718',
      groupHash: '112233445566',
      facing: 'environment',
      capabilities: {
        width: { min: 160, max: 1600 },
        height: { min: 120, max: 1200 },
        zoom: 'n/a',
        focusMode: [],
        focusDistance: 'n/a',
        exposureTime: 'n/a',
        iso: 'n/a',
        torch: false,
      },
      settings: { width: 1600, height: 1200, frameRate: 30 },
      resolutions: {},
      zoomSweep: null,
      error: null,
    },
    {
      index: 3,
      label: 'camera2 1, facing front',
      idHash: 'd4e5f6071829',
      groupHash: '77889900aabb',
      facing: 'user',
      capabilities: { width: { min: 160, max: 3264 } },
      settings: { width: 1280, height: 720, frameRate: 30 },
      resolutions: {},
      zoomSweep: null,
      error: null,
    },
  ]);

  return {
    version: 1,
    reportId: '9f4a21',
    timestampUtc: '2026-11-25T09:30:00.000Z',
    env: baseEnv(),
    cameraPermission: { granted: true, error: null },
    cameras: cams,
    capture: {
      rVfcSupported: true,
      measuredFps: 13.4,
      frameCount: 60,
      videoFrameSupported: true,
      videoFrameFormat: 'I420',
      yuvDirectCopy: true,
      copyToOk: true,
      tCaptureMs: 0.9,
      workerTransferOk: true,
    },
    sensors: {
      gyroAvailable: true,
      gyroSource: 'Gyroscope',
      gyroHz: 98.5,
      atRest: {
        source: 'Gyroscope',
        durationMs: 2000,
        n: 196,
        biasDps: { x: 0.01, y: -0.02, z: 0.01 },
        maxAbsBiasDps: 0.02,
        rmsDps: 0.05,
        pass: true,
        movedDuringTest: false,
        error: null,
      },
    },
    labelTests: {},
    ...overrides,
  };
}

console.log('Running Step D0 diagnostics unit tests...');

await test('hashDeviceId returns 12-char hex SHA-256 and "none" for empty/null', async () => {
  assert.equal(await hashDeviceId(''), 'none');
  assert.equal(await hashDeviceId(null), 'none');
  assert.equal(await hashDeviceId(undefined), 'none');

  const h1 = await hashDeviceId('SECRET_RAW_DEVICE_ID_12345');
  const h2 = await hashDeviceId('SECRET_RAW_DEVICE_ID_12345');
  const h3 = await hashDeviceId('DIFFERENT_DEVICE_ID_67890');
  assert.match(h1, /^[0-9a-f]{12}$/);
  assert.equal(h1, h2);
  assert.notEqual(h1, h3);
});

await test('classifyCameras identifies MAIN?, ULTRAWIDE?, MACRO/DEPTH?, FRONT on A53 fixture', async () => {
  const report = a53Fixture();
  const [c0, c1, c2, c3] = report.cameras;
  assert.equal(c0.roleGuess, 'MAIN?');
  assert.equal(c0.suitable, true);
  assert.equal(c1.roleGuess, 'ULTRAWIDE?');
  assert.equal(c2.roleGuess, 'MACRO/DEPTH?');
  assert.equal(c2.suitable, false);
  assert.equal(c3.roleGuess, 'FRONT');
});

await test('recommend returns part2-slide on Galaxy A53 5G fixture (no tele, 1080p main, gyro)', async () => {
  const report = a53Fixture();
  const rec = recommend(report);
  assert.equal(rec.mode, 'part2-slide');
  assert.equal(rec.recommendedCameraHash, 'a1b2c3d4e5f6');
  assert.equal(rec.secondaryOption, 'digital-zoom');
  assert.match(rec.blurb, /8 in slide/i);
});

await test('recommend returns part3-tele when logical 3x zoom lens switch + gyro exist', async () => {
  const report = a53Fixture();
  report.cameras[0].zoomSweep.framingJumpDetected = true;
  report.cameras[0].zoomSweep.capsChangedDetected = true;
  report.cameras[0].zoomSweep.logicalZoomLikely = true;
  report.cameras[0].capabilities.exposureMode = ['continuous', 'manual'];
  report.cameras[0].capabilities.exposureTime = { min: 1, max: 1000 };
  const rec = recommend(report);
  assert.equal(rec.mode, 'part3-tele');
  assert.equal(rec.secondaryOption, 'part2-slide');
  assert.match(rec.blurb, /Part 3/i);
});

await test('D2 real Galaxy A53 5G (SM-A536B) report recommends part2-slide and picks camera 0 (AF + torch)', async () => {
  const report = a53Fixture({
    cameras: classifyCameras([
      {
        index: 0,
        label: 'camera 2, facing back',
        idHash: '52a24ec8dac6',
        facing: 'environment',
        capabilities: {
          width: { min: 1, max: 4000 },
          height: { min: 1, max: 3000 },
          zoom: { min: 1, max: 8, step: 0.1 },
          focusMode: ['manual'],
          focusDistance: { min: 0, max: 3.6, step: 0.01 },
          exposureMode: ['continuous', 'manual'],
          exposureTime: { min: 0.6, max: 1000, step: 0.1 },
          iso: { min: 50, max: 3200, step: 1 },
          torch: 'n/a',
        },
        settings: { width: 1080, height: 1920, frameRate: 30, zoom: 1 },
        resolutions: { '1080p': { ok: true, width: 1080, height: 1920, frameRate: 30 } },
        zoomSweep: {
          steps: [{ requested: 1, achieved: 1, frameDiff: 0 }, { requested: 4.5, achieved: 4.505, frameDiff: 30.15 }],
          framingJumpDetected: true,
          capsChangedDetected: false,
          logicalZoomLikely: true,
        },
        error: null,
      },
      {
        index: 1,
        label: 'camera 0, facing back',
        idHash: '004839289298',
        facing: 'environment',
        capabilities: {
          width: { min: 1, max: 4624 },
          height: { min: 1, max: 3468 },
          zoom: { min: 1, max: 8, step: 0.1 },
          focusMode: ['manual', 'single-shot', 'continuous'],
          focusDistance: { min: 0.1, max: 3.6, step: 0.01 },
          exposureMode: ['continuous', 'manual'],
          exposureTime: { min: 0.42, max: 1000, step: 0.1 },
          iso: { min: 50, max: 3200, step: 1 },
          torch: true,
        },
        settings: { width: 1080, height: 1920, frameRate: 30, zoom: 1 },
        resolutions: { '1080p': { ok: true, width: 1080, height: 1920, frameRate: 30 } },
        zoomSweep: {
          steps: [{ requested: 1, achieved: 1, frameDiff: 0 }, { requested: 4.5, achieved: 4.498, frameDiff: 35.35 }],
          framingJumpDetected: true,
          capsChangedDetected: false,
          logicalZoomLikely: true,
        },
        error: null,
      },
    ]),
  });
  const rec = recommend(report);
  assert.equal(rec.mode, 'part2-slide');
  assert.equal(rec.recommendedCameraHash, '004839289298');
});

await test('recommend returns part3-tele when a discrete TELE? lens + gyro exist', async () => {
  const cams = classifyCameras([
    {
      index: 0,
      label: 'camera2 0, facing back',
      idHash: '111111111111',
      facing: 'environment',
      capabilities: {
        width: { min: 160, max: 4000 },
        focusMode: ['continuous'],
        focusDistance: { min: 0.1, max: 10 },
        zoom: { min: 1, max: 10, step: 0.1 },
      },
      settings: { width: 1920, height: 1080 },
      resolutions: { '1080p': { ok: true, width: 1920, height: 1080, frameRate: 30 } },
      error: null,
    },
    {
      index: 1,
      label: 'camera2 4, facing back',
      idHash: '222222222222',
      facing: 'environment',
      capabilities: {
        width: { min: 160, max: 3264 },
        focusMode: ['continuous'],
        focusDistance: { min: 0.35, max: 10 },
        zoom: { min: 1, max: 3, step: 0.1 },
      },
      settings: { width: 1920, height: 1080 },
      resolutions: { '1080p': { ok: true, width: 1920, height: 1080, frameRate: 30 } },
      error: null,
    },
  ]);
  assert.equal(cams[0].roleGuess, 'MAIN?');
  assert.equal(cams[1].roleGuess, 'TELE?');

  const report = a53Fixture({ cameras: cams });
  const rec = recommend(report);
  assert.equal(rec.mode, 'part3-tele');
  assert.equal(rec.recommendedCameraHash, '222222222222');
});

await test('recommend returns digital-zoom fallback when 8 in focus fails but 2x zoom exists', async () => {
  const report = a53Fixture({
    labelTests: {
      in8: { distanceIn: 8, skipped: false, decodeRate: 0.1, medianPpm: 1.4, medianTotalMs: 12, width: 1920, height: 1080 },
    },
  });
  const rec = recommend(report);
  assert.equal(rec.mode, 'digital-zoom');
});

await test('recommend returns limited on desktop webcam and on missing gyro', async () => {
  const desktopCams = classifyCameras([
    {
      index: 0,
      label: 'Integrated HD Webcam',
      idHash: 'abcdef012345',
      facing: 'unknown',
      capabilities: { width: { min: 320, max: 1280 } },
      settings: { width: 1280, height: 720 },
      resolutions: { '720p': { ok: true, width: 1280, height: 720, frameRate: 30 } },
      error: null,
    },
  ]);
  const desktopRec = recommend(a53Fixture({ cameras: desktopCams }));
  assert.equal(desktopRec.mode, 'limited');
  assert.equal(desktopRec.reason, 'no-rear-camera');

  const noGyroRec = recommend(a53Fixture({ sensors: { gyroAvailable: false, gyroSource: 'none', gyroHz: 0 } }));
  assert.equal(noGyroRec.mode, 'limited');
  assert.equal(noGyroRec.reason, 'no-gyro-or-motion');
});

await test('recommend returns blocked on insecure context or denied camera permission', async () => {
  const insecure = recommend(a53Fixture({ env: baseEnv({ isSecureContext: false, protocol: 'http:' }) }));
  assert.equal(insecure.mode, 'blocked');
  assert.equal(insecure.reason, 'insecure-context');

  const denied = recommend(a53Fixture({
    cameraPermission: { granted: false, error: 'NotAllowedError' },
    cameras: [],
  }));
  assert.equal(denied.mode, 'blocked');
  assert.equal(denied.reason, 'NotAllowedError');
});

await test('formatReportText and formatReportJson never leak raw deviceId and emit valid JSON v1', async () => {
  const rawSecret = 'RAW_SECRET_CHROME_DEVICE_ID_999999999';
  const hashed = await hashDeviceId(rawSecret);
  const report = a53Fixture();
  report.cameras[0].idHash = hashed;
  report.recommendation = recommend(report);

  const jsonStr = formatReportJson(report);
  const textStr = formatReportText(report);

  assert.equal(jsonStr.includes(rawSecret), false, 'raw deviceId must never appear in JSON');
  assert.equal(textStr.includes(rawSecret), false, 'raw deviceId must never appear in text report');
  assert.ok(textStr.includes('DBC diag '), 'missing report header');
  assert.ok(textStr.includes('Recommendation: part2-slide'), 'missing recommendation line');
  assert.ok(textStr.includes('--- JSON ---'), 'missing JSON divider');

  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.cameras[0].idHash, hashed);
});

await test('D1 orientation extras format cleanly in v1 text and JSON reports', async () => {
  const report = a53Fixture({
    env: baseEnv({
      screenOrientation: { type: 'portrait-primary', angle: 0, lockSupported: true },
    }),
    sensors: {
      gyroAvailable: true,
      gyroSource: 'Gyroscope',
      gyroHz: 98.5,
      orientFrames: {
        relScreenOk: true,
        relDeviceOk: true,
        framesDiffer: false,
        gravityAvailable: true,
        gravityVec: { x: 0.12, y: 9.78, z: 0.34 },
        gravityRollDeg: 0.7,
        gravityPitchDeg: 1.99,
      },
      atRest: null,
    },
  });
  report.recommendation = recommend(report);
  const txt = formatReportText(report);
  assert.ok(txt.includes('portrait-primary (0deg, lock ok)'));
  assert.ok(txt.includes('relDevice=yes'));
  assert.ok(txt.includes('grav roll=0.7deg'));
  const parsed = JSON.parse(formatReportJson(report));
  assert.equal(parsed.version, 1);
  assert.equal(parsed.env.screenOrientation.type, 'portrait-primary');
});

console.log(`All ${passed} D0 diagnostics tests passed.`);
