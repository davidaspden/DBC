/**
 * Unit tests for K8: Mock MediaStreamTrack & getUserMedia Constraint Solver
 * exercising `src/camera.js` (including PP2 `lock30fps` + exposure helpers) and
 * `src/capture/lensprobe.js` against Samsung Galaxy A53 5G (`cc0f88`) capabilities.
 *
 *   node tests/camera-mock.test.js
 */

import assert from 'node:assert/strict';
import {
  A53_CC0F88_DIAG,
  MockOverconstrainedError,
  clampToCapability,
  createMockTrack,
  createMockMediaDevices,
  createMockVideoElement,
  installMockBrowserEnv,
} from '../src/sim/mock-track.js';
import {
  listVideoDevices,
  startCamera,
  setZoom,
  setFocusContinuous,
  setFocusPoint,
  setManualFocusDistance,
  pickBackCameras,
  setTorch,
  getExposureInfo,
  setExposure,
  stopCamera,
} from '../src/camera.js';
import {
  LENS_PROBE_STORAGE_KEY,
  selectStandbackLens,
  runLensProbe,
} from '../src/capture/lensprobe.js';

let passed = 0;

async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running K8 mock-track, camera.js & lensprobe.js unit tests...');

await test('built-in A53 cc0f88 capability table exposes camera 2 before camera 0 and two front cameras', async () => {
  const md = createMockMediaDevices();
  const devices = await md.enumerateDevices();
  assert.equal(devices.length, 4);
  assert.equal(devices[0].label, 'camera 2, facing back');
  assert.equal(devices[1].label, 'camera 0, facing back');
  assert.equal(devices[2].label, 'camera 1, facing front');
  assert.equal(devices[3].label, 'camera 3, facing front');

  const cam0 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 0' });
  const c0 = cam0.getCapabilities();
  assert.deepEqual(c0.zoom, { min: 1, max: 8, step: 0.1 });
  assert.deepEqual(c0.focusMode, ['manual', 'single-shot', 'continuous']);
  assert.deepEqual(c0.focusDistance, { min: 0.1, max: 3.6, step: 0.01 });
  assert.deepEqual(c0.exposureTime, { min: 0.42, max: 1000, step: 0.1 });
  assert.deepEqual(c0.iso, { min: 50, max: 3200, step: 1 });
  assert.deepEqual(c0.exposureCompensation, { min: -2, max: 2, step: 0.1 });
  assert.deepEqual(c0.exposureMode, ['continuous', 'manual']);
  assert.equal(c0.torch, true);

  const cam2 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 2' });
  const c2 = cam2.getCapabilities();
  assert.deepEqual(c2.focusMode, ['manual']);
  assert.deepEqual(c2.focusDistance, { min: 0, max: 3.6, step: 0.01 });
  assert.equal(c2.torch, false);
  assert.equal(c2.zoom, undefined);
});

await test('constraint solver clamps min/max/step, validates modes, handles advanced sets and rejects impossible exact', async () => {
  assert.equal(clampToCapability(0.5, { min: 1, max: 8, step: 0.1 }), 1);
  assert.equal(clampToCapability(12.3, { min: 1, max: 8, step: 0.1 }), 8);
  assert.equal(clampToCapability(2.54, { min: 1, max: 8, step: 0.1 }), 2.5);
  assert.equal(clampToCapability(0.01, { min: 0.42, max: 1000, step: 0.1 }), 0.42);
  assert.equal(clampToCapability(20, { min: 0.42, max: 1000, step: 0.1 }), 20.02);
  assert.equal(clampToCapability(5000, { min: 0.42, max: 1000, step: 0.1 }), 1000);

  const cam0 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 0' });

  // Direct clamping via advanced constraints
  await cam0.applyConstraints({ advanced: [{ zoom: 15 }] });
  assert.equal(cam0.getSettings().zoom, 8);
  await cam0.applyConstraints({ advanced: [{ zoom: 0.2 }] });
  assert.equal(cam0.getSettings().zoom, 1);

  // Impossible exact constraints throw OverconstrainedError
  await assert.rejects(
    () => cam0.applyConstraints({ frameRate: { exact: 60 } }),
    (err) => err instanceof MockOverconstrainedError && err.name === 'OverconstrainedError' && err.constraint === 'frameRate'
  );
  await assert.rejects(
    () => cam0.applyConstraints({ width: { exact: 9000 } }),
    (err) => err.name === 'OverconstrainedError' && err.constraint === 'width'
  );
  await assert.rejects(
    () => cam0.applyConstraints({ height: { exact: 9000 } }),
    (err) => err.name === 'OverconstrainedError' && err.constraint === 'height'
  );
  await assert.rejects(
    () => cam0.applyConstraints({ advanced: [{ focusMode: 'bogus-mode' }] }),
    (err) => err.name === 'OverconstrainedError' && err.constraint === 'focusMode'
  );
  await assert.rejects(
    () => cam0.applyConstraints({ advanced: [{ exposureMode: 'bogus-mode' }] }),
    (err) => err.name === 'OverconstrainedError' && err.constraint === 'exposureMode'
  );

  // Camera 2: manual focus only, continuous rejected as exact/single-set, skipped in multi-set advanced fallback
  const cam2 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 2' });
  await assert.rejects(
    () => cam2.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }),
    (err) => err.name === 'OverconstrainedError' && err.constraint === 'focusMode'
  );
  // Ideal unsupported mode does not throw and keeps existing mode
  await cam2.applyConstraints({ focusMode: { ideal: 'continuous' } });
  assert.equal(cam2.getSettings().focusMode, 'manual');

  // Multi-set advanced fallback skips unsatisfiable first set and applies second
  await cam2.applyConstraints({
    advanced: [
      { focusMode: 'continuous' },
      { focusMode: 'manual', focusDistance: 1.25 },
    ],
  });
  assert.equal(cam2.getSettings().focusMode, 'manual');
  assert.equal(cam2.getSettings().focusDistance, 1.25);

  // Ended track rejects applyConstraints
  cam2.stop();
  assert.equal(cam2.readyState, 'ended');
  await assert.rejects(
    () => cam2.applyConstraints({ advanced: [{ focusDistance: 0.5 }] }),
    (err) => err.name === 'InvalidStateError'
  );
});

await test('external diag JSON fixture plugs cleanly into createMockMediaDevices with portrait 720p/1080p/4K @30', async () => {
  // Simulates an external diag-cc0f88.json report (idHash only, no raw deviceId, 'n/a' fields)
  const externalDiag = {
    version: 1,
    reportId: 'ext-cc0f88',
    cameras: [
      {
        index: 0,
        label: 'camera 0, facing back',
        idHash: 'deadbeef0001',
        groupHash: 'feedface0001',
        facing: 'environment',
        roleGuess: 'MAIN?',
        capabilities: {
          width: { min: 160, max: 4624 },
          height: { min: 120, max: 3468 },
          frameRate: { min: 1, max: 30 },
          zoom: { min: 1, max: 8, step: 0.1 },
          focusMode: ['manual', 'single-shot', 'continuous'],
          focusDistance: { min: 0.1, max: 3.6, step: 0.01 },
          exposureMode: ['continuous', 'manual'],
          exposureTime: { min: 0.42, max: 1000, step: 0.1 },
          iso: { min: 50, max: 3200, step: 1 },
          torch: true,
          pointsOfInterest: 'n/a',
        },
        settings: { width: 1080, height: 1920, frameRate: 30, zoom: 1, focusMode: 'continuous' },
        resolutions: {
          '720p': { ok: true, width: 720, height: 1280, frameRate: 30 },
          '1080p': { ok: true, width: 1080, height: 1920, frameRate: 30 },
          '4K': { ok: true, width: 2160, height: 3840, frameRate: 30 },
        },
      },
    ],
  };

  const md = createMockMediaDevices(externalDiag);
  const s720 = await md.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  const st720 = s720.getVideoTracks()[0].getSettings();
  assert.equal(st720.width, 720);
  assert.equal(st720.height, 1280);
  assert.equal(st720.frameRate, 30);
  stopCamera(s720);

  const s1080 = await md.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } });
  const st1080 = s1080.getVideoTracks()[0].getSettings();
  assert.equal(st1080.width, 1080);
  assert.equal(st1080.height, 1920);
  stopCamera(s1080);

  const s4k = await md.getUserMedia({ video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } } });
  const st4k = s4k.getVideoTracks()[0].getSettings();
  assert.equal(st4k.width, 2160);
  assert.equal(st4k.height, 3840);
  assert.equal(st4k.frameRate, 30);
  stopCamera(s4k);

  // Impossible exact frameRate at getUserMedia level rejects with OverconstrainedError
  await assert.rejects(
    () => md.getUserMedia({ video: { frameRate: { exact: 60 } } }),
    (err) => err.name === 'OverconstrainedError' && err.constraint === 'frameRate'
  );
});

await test('listVideoDevices and pickBackCameras prefer camera 0 (AF+torch) over camera 2 on A53', async () => {
  const md = createMockMediaDevices(A53_CC0F88_DIAG);
  const env = installMockBrowserEnv(md);
  try {
    const all = await listVideoDevices();
    assert.equal(all.length, 4);
    assert.equal(all[0].label, 'camera 2, facing back');
    assert.equal(all[1].label, 'camera 0, facing back');

    const back = pickBackCameras(all);
    assert.equal(back.length, 2);
    assert.equal(back[0].label, 'camera 0, facing back');
    assert.equal(back[1].label, 'camera 2, facing back');
  } finally {
    env.restore();
  }
});

await test('setZoom clamps to 1-8 step 0.1 on camera 0, re-applies continuous AF, and fails cleanly on camera 2', async () => {
  const cam0 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 0' });

  // Switch to manual focus first so we verify setZoom restores continuous AF
  await setManualFocusDistance(cam0, 0.25);
  assert.equal(cam0.getSettings().focusMode, 'manual');

  const zLow = await setZoom(cam0, 0.3);
  assert.deepEqual(zLow, { ok: true, zoom: 1 });
  assert.equal(cam0.getSettings().zoom, 1);
  assert.equal(cam0.getSettings().focusMode, 'continuous');

  const zMid = await setZoom(cam0, 2.54);
  assert.deepEqual(zMid, { ok: true, zoom: 2.5 });
  assert.equal(cam0.getSettings().zoom, 2.5);

  const zHigh = await setZoom(cam0, 15);
  assert.deepEqual(zHigh, { ok: true, zoom: 8 });
  assert.equal(cam0.getSettings().zoom, 8);

  const cam2 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 2' });
  const z2 = await setZoom(cam2, 2);
  assert.deepEqual(z2, { ok: false, zoom: 1 });
});

await test('setFocusContinuous, setFocusPoint and setManualFocusDistance behave per A53 camera 0 and camera 2 caps', async () => {
  const cam0 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 0' });
  const cam2 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 2' });
  const cam3 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 3' });

  // setManualFocusDistance on camera 0: clamps to [0.1, 3.6] step 0.01 via two-step applyConstraints
  const fdLow = await setManualFocusDistance(cam0, 0.01);
  assert.deepEqual(fdLow, { ok: true, distanceM: 0.1 });
  assert.equal(cam0.getSettings().focusMode, 'manual');
  assert.equal(cam0.getSettings().focusDistance, 0.1);

  const fdMid = await setManualFocusDistance(cam0, 0.204);
  assert.deepEqual(fdMid, { ok: true, distanceM: 0.2 });
  assert.equal(cam0.getSettings().focusDistance, 0.2);

  const fdHigh = await setManualFocusDistance(cam0, 9.5);
  assert.deepEqual(fdHigh, { ok: true, distanceM: 3.6 });
  assert.equal(cam0.getSettings().focusDistance, 3.6);

  const hist = cam0.getHistory();
  assert.equal(hist[0].constraints.advanced[0].focusMode, 'manual');
  assert.equal(hist[1].constraints.advanced[0].focusDistance, 0.1);

  // setFocusContinuous on camera 0 succeeds; on camera 2 returns false
  assert.equal(await setFocusContinuous(cam0), true);
  assert.equal(cam0.getSettings().focusMode, 'continuous');
  assert.equal(await setFocusContinuous(cam2), false);
  assert.equal(cam2.getSettings().focusMode, 'manual');

  // setManualFocusDistance on camera 2 allows down to 0 m (range 0-3.6)
  const fdCam2 = await setManualFocusDistance(cam2, -0.2);
  assert.deepEqual(fdCam2, { ok: true, distanceM: 0 });
  assert.equal(cam2.getSettings().focusDistance, 0);

  // setManualFocusDistance on camera 3 (no focusDistance) fails cleanly
  const fdCam3 = await setManualFocusDistance(cam3, 0.2);
  assert.deepEqual(fdCam3, { ok: false, distanceM: null });

  // setFocusPoint: capture the 1500ms timer so tests run deterministically without sleeping 1.5s
  const pendingTimers = [];
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    pendingTimers.push({ fn, ms });
    return pendingTimers.length;
  };
  try {
    // On camera 0 (no pointsOfInterest, has single-shot): enters single-shot then timer restores continuous
    const fp0 = await setFocusPoint(cam0, 0.3, 0.7);
    assert.equal(fp0, true);
    assert.equal(cam0.getSettings().focusMode, 'single-shot');
    assert.equal(pendingTimers.length, 1);
    assert.equal(pendingTimers[0].ms, 1500);
    await pendingTimers[0].fn();
    assert.equal(cam0.getSettings().focusMode, 'continuous');

    // On a track with pointsOfInterest: clamps coordinates to [0, 1] and applies pointsOfInterest + single-shot
    const poiTrack = createMockTrack({
      focusMode: ['manual', 'single-shot', 'continuous'],
      pointsOfInterest: true,
    });
    const fpPoi = await setFocusPoint(poiTrack, -0.5, 1.8);
    assert.equal(fpPoi, true);
    assert.equal(poiTrack.getSettings().focusMode, 'single-shot');
    assert.deepEqual(poiTrack.getSettings().pointsOfInterest, [{ x: 0, y: 1 }]);
    await pendingTimers[1].fn();
    assert.equal(poiTrack.getSettings().focusMode, 'continuous');

    // On camera 2 (manual-only): verify current camera.js behavior (no applyConstraints sent)
    const beforeLen = cam2.getHistory().length;
    const fp2 = await setFocusPoint(cam2, 0.5, 0.5);
    assert.equal(cam2.getHistory().length, beforeLen);
    // Note: camera.js currently returns true even when single-shot is unsupported (recorded in K8 report)
    assert.equal(fp2, true);
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

await test('setTorch enables/disables torch on camera 0 and returns false on camera 2 (no torch)', async () => {
  const cam0 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 0' });
  assert.equal(await setTorch(cam0, true), true);
  assert.equal(cam0.getSettings().torch, true);
  assert.equal(await setTorch(cam0, false), true);
  assert.equal(cam0.getSettings().torch, false);

  const cam2 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 2' });
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await setTorch(cam2, true), false);
    assert.equal(cam2.getSettings().torch, undefined);
  } finally {
    console.warn = origWarn;
  }
});

await test('getExposureInfo & setExposure clamp to 42 us - 100 ms (0.42-1000 x 100us), set compensated ISO, and fall back to comp-min on camera 2', async () => {
  const cam0 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 0' });

  const info0 = getExposureInfo(cam0);
  assert.equal(info0.supported, true);
  assert.equal(info0.manualSupported, true);
  assert.equal(info0.mode, 'continuous');
  assert.equal(info0.min, 0.42);
  assert.equal(info0.max, 1000);
  assert.equal(info0.step, 0.1);
  assert.equal(info0.isoMin, 50);
  assert.equal(info0.isoMax, 3200);
  assert.equal(info0.compMin, -2);
  assert.equal(info0.compMax, 2);

  // Target 1/500 s (2 ms = 20 x 100us -> quantized to 20.02 x 100us on 0.42 + 0.1*k grid)
  const r500 = await setExposure(cam0, { targetSec: 1 / 500, enableManual: true });
  assert.equal(r500.ok, true);
  assert.equal(r500.mode, 'manual');
  assert.equal(r500.info.mode, 'manual');
  assert.equal(r500.info.exposureTime, 20.02);
  assert.ok(Math.abs(r500.info.exposureTimeSec - 0.002002) < 1e-7);
  // Compensated ISO = round(50 + (3200 - 50) * 0.75) = 2413
  assert.equal(r500.info.iso, 2413);

  // Verify two-step applyConstraints order (mode first, then exposureTime + iso)
  const h = cam0.getHistory();
  assert.equal(h[0].constraints.advanced[0].exposureMode, 'manual');
  assert.ok(Math.abs(h[1].constraints.advanced[0].exposureTime - 20.02) < 1e-9);
  assert.equal(h[1].constraints.advanced[0].iso, 2413);

  // Clamp below min (1 us -> 42 us = 0.42 x 100us)
  const rMin = await setExposure(cam0, { targetSec: 1e-6, enableManual: true });
  assert.equal(rMin.ok, true);
  assert.equal(rMin.info.exposureTime, 0.42);
  assert.ok(Math.abs(rMin.info.exposureTimeSec - 42e-6) < 1e-9);

  // Clamp above max (500 ms -> 100 ms = 1000 x 100us)
  const rMax = await setExposure(cam0, { targetSec: 0.5, enableManual: true });
  assert.equal(rMax.ok, true);
  assert.equal(rMax.info.exposureTime, 1000);
  assert.ok(Math.abs(rMax.info.exposureTimeSec - 0.1) < 1e-9);

  // Return to continuous AE
  const rAuto = await setExposure(cam0, { enableManual: false });
  assert.equal(rAuto.ok, true);
  assert.equal(rAuto.mode, 'auto');
  assert.equal(rAuto.info.mode, 'continuous');

  // Camera 2: manual exposureTime unsupported -> falls back to comp-min (-2 EV)
  const cam2 = createMockTrack(A53_CC0F88_DIAG, { cameraLabel: 'camera 2' });
  const info2 = getExposureInfo(cam2);
  assert.equal(info2.supported, true);
  assert.equal(info2.manualSupported, false);

  const rComp = await setExposure(cam2, { targetSec: 1 / 500, enableManual: true });
  assert.equal(rComp.ok, true);
  assert.equal(rComp.mode, 'comp-min');
  assert.equal(cam2.getSettings().exposureCompensation, -2);
});

await test('startCamera with PP2 lock30fps + fastShutter requests frameRate min 30, locks 1/250s manual exposure + compensated ISO, and stopCamera releases track', async () => {
  const md = createMockMediaDevices(A53_CC0F88_DIAG);
  const env = installMockBrowserEnv(md);
  const origInfo = console.info;
  console.info = () => {};
  try {
    // 1. Default start (lock30fps off): requests min: 15, stays in continuous exposure
    const v1 = createMockVideoElement();
    const res1 = await startCamera(v1, { width: 1280, height: 720 });
    assert.deepEqual(md.calls[0].constraints.video.frameRate, { ideal: 30, min: 15 });
    assert.equal(res1.width, 720);
    assert.equal(res1.height, 1280);
    assert.equal(res1.frameRate, 30);
    assert.equal(res1.focusMode, 'continuous');
    assert.equal(res1.hasTorch, true);
    assert.equal(res1.settings.exposureMode, 'continuous');
    stopCamera(res1.stream);
    assert.equal(res1.track.readyState, 'ended');
    assert.equal(res1.stream.active, false);

    // 2. PP2 lock30fps + fastShutter: requests frameRate min 30, sets 1/250s (4 ms = 40.02 x 100us) + ISO 2413
    const v2 = createMockVideoElement();
    const res2 = await startCamera(v2, {
      width: 1920,
      height: 1080,
      lock30fps: true,
      fastShutter: true,
    });
    assert.deepEqual(md.calls[1].constraints.video.frameRate, { ideal: 30, min: 30 });
    assert.equal(res2.width, 1080);
    assert.equal(res2.height, 1920);
    assert.equal(res2.frameRate, 30);
    assert.equal(res2.settings.exposureMode, 'manual');
    assert.equal(res2.settings.exposureTime, 40.02);
    assert.equal(res2.settings.iso, 2413);
    assert.equal(res2.focusMode, 'continuous');
    stopCamera(res2.stream);
    assert.equal(md.getActiveTracks().length, 0);

    // 3. PP2 lock30fps fallback when camera HAL max frameRate < 30 (e.g. 24 fps max)
    const slowCaps = {
      label: 'camera 0, facing back',
      facing: 'environment',
      portrait: true,
      capabilities: {
        width: { min: 160, max: 1920 },
        height: { min: 120, max: 1080 },
        frameRate: { min: 1, max: 24 },
        focusMode: ['manual', 'continuous'],
        exposureMode: ['continuous', 'manual'],
        exposureTime: { min: 0.42, max: 1000, step: 0.1 },
        iso: { min: 50, max: 3200, step: 1 },
        torch: true,
      },
    };
    const mdSlow = createMockMediaDevices(slowCaps);
    const envSlow = installMockBrowserEnv(mdSlow);
    try {
      const v3 = createMockVideoElement();
      const res3 = await startCamera(v3, {
        lock30fps: true,
        fastShutter: true,
        targetExposureSec: 1 / 500,
      });
      assert.equal(mdSlow.calls.length, 2);
      assert.deepEqual(mdSlow.calls[0].constraints.video.frameRate, { ideal: 30, min: 30 });
      assert.equal(mdSlow.calls[0].error, 'OverconstrainedError');
      assert.deepEqual(mdSlow.calls[1].constraints.video.frameRate, { ideal: 30, min: 15 });
      assert.equal(mdSlow.calls[1].ok, true);
      assert.equal(res3.frameRate, 24);
      assert.equal(res3.settings.exposureMode, 'manual');
      assert.equal(res3.settings.exposureTime, 20.02);
      assert.equal(res3.settings.iso, 2413);
      stopCamera(res3.stream);
    } finally {
      envSlow.restore();
    }
  } finally {
    console.info = origInfo;
    env.restore();
  }
});

await test('lensprobe runLensProbe & selectStandbackLens probe A53 via diag/cameras.js, pick camera 0 over camera 2, and detect tele when present', async () => {
  const md = createMockMediaDevices(A53_CC0F88_DIAG);
  const env = installMockBrowserEnv(md, { withDocument: true, withLocalStorage: true });
  try {
    const previewEl = createMockVideoElement();
    const res = await runLensProbe(previewEl);

    assert.equal(res.cameras.length, 4);
    assert.equal(res.hasTele, false);
    assert.equal(res.profile, 'wall');
    assert.equal(res.recommendedZoom, 1);
    assert.ok(res.selectedCamera);
    assert.equal(res.selectedCamera.label, 'camera 0, facing back');
    assert.equal(res.selectedCamera.roleGuess, 'MAIN?');

    const cam2 = res.cameras.find((c) => c.label === 'camera 2, facing back');
    assert.ok(cam2);
    assert.equal(cam2.roleGuess, 'REAR-AUX?');
    assert.equal(cam2.suitable, false);

    // Verify 720p / 1080p / 4K portrait resolution trials succeeded on camera 0
    assert.equal(res.selectedCamera.resolutions['720p'].ok, true);
    assert.equal(res.selectedCamera.resolutions['720p'].width, 720);
    assert.equal(res.selectedCamera.resolutions['720p'].height, 1280);
    assert.equal(res.selectedCamera.resolutions['1080p'].width, 1080);
    assert.equal(res.selectedCamera.resolutions['1080p'].height, 1920);
    assert.equal(res.selectedCamera.resolutions['4K'].width, 2160);
    assert.equal(res.selectedCamera.resolutions['4K'].height, 3840);

    // Verify zoom sweep ran without false tele detection
    assert.ok(res.selectedCamera.zoomSweep);
    assert.equal(res.selectedCamera.zoomSweep.teleEvidence, 'none');
    assert.equal(res.selectedCamera.zoomSweep.logicalZoomLikely, false);

    // All probed streams were cleanly stopped (exclusive probing, zero leaks)
    assert.equal(md.getActiveTracks().length, 0);

    // Summary persisted to localStorage under LENS_PROBE_STORAGE_KEY
    const stored = JSON.parse(env.storage.getItem(LENS_PROBE_STORAGE_KEY));
    assert.equal(stored.hasTele, false);
    assert.equal(stored.profile, 'wall');
    assert.equal(stored.label, 'camera 0, facing back');
  } finally {
    env.restore();
  }

  // Dedicated optical tele lens fixture -> selectStandbackLens picks standback profile
  const teleDiag = {
    version: 1,
    cameras: [
      {
        label: 'camera 0, facing back',
        facing: 'environment',
        capabilities: {
          width: { min: 160, max: 4000 },
          height: { min: 120, max: 3000 },
          frameRate: { min: 1, max: 30 },
          focusMode: ['manual', 'continuous'],
          focusDistance: { min: 0.1, max: 5, step: 0.01 },
          torch: true,
        },
        settings: { width: 1920, height: 1080, frameRate: 30, focusMode: 'continuous' },
      },
      {
        label: 'camera 4, facing back',
        facing: 'environment',
        capabilities: {
          width: { min: 160, max: 4000 },
          height: { min: 120, max: 3000 },
          frameRate: { min: 1, max: 30 },
          focusMode: ['manual', 'continuous'],
          focusDistance: { min: 0.3, max: 5, step: 0.01 },
          torch: false,
        },
        settings: { width: 1920, height: 1080, frameRate: 30, focusMode: 'continuous' },
      },
    ],
  };
  const mdTele = createMockMediaDevices(teleDiag);
  const envTele = installMockBrowserEnv(mdTele, { withDocument: true });
  try {
    const resTele = await runLensProbe(createMockVideoElement());
    assert.equal(resTele.hasTele, true);
    assert.equal(resTele.profile, 'standback');
    assert.equal(resTele.selectedCamera.label, 'camera 4, facing back');
    assert.equal(resTele.selectedCamera.roleGuess, 'TELE?');
    assert.equal(mdTele.getActiveTracks().length, 0);

    // Direct pure selection parity check
    const pureSel = selectStandbackLens(resTele.cameras);
    assert.equal(pureSel.hasTele, true);
    assert.equal(pureSel.selectedCamera.label, 'camera 4, facing back');
  } finally {
    envTele.restore();
  }
});

console.log(`All ${passed} K8 camera-mock tests passed.`);
