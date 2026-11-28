/**
 * Unit tests for Wave 2 Streams C & U: C2 (`setZoom`), C3 (`pickBackCameras`, `setManualFocusDistance`),
 * C5 (`computeEvenCropRect`, `offsetDetectionByCrop`), and U4 (`createPauseController`).
 *   node tests/capture-ui.test.js
 */

import assert from 'node:assert/strict';
import { setZoom, setManualFocusDistance, pickBackCameras } from '../src/camera.js';
import { computeEvenCropRect, offsetDetectionByCrop, computePredictedLabelCrop } from '../src/capture/crop.js';
import { createPauseController } from '../src/ui/pause.js';
import { selectStandbackLens } from '../src/capture/lensprobe.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running Wave 2 Stream C & U unit tests...');

await test('C2 setZoom clamps/steps to capabilities.zoom and re-applies continuous AF', async () => {
  const calls = [];
  const track = {
    getCapabilities: () => ({ zoom: { min: 1, max: 8, step: 0.1 }, focusMode: ['manual', 'continuous'] }),
    applyConstraints: async (c) => { calls.push(c); },
  };
  const r = await setZoom(track, 2.53);
  assert.equal(r.ok, true);
  assert.equal(r.zoom, 2.5);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].advanced[0].zoom, 2.5);
  assert.equal(calls[1].advanced[0].focusMode, 'continuous');
});

await test('C3 pickBackCameras puts camera 0 (main AF+torch) before camera 2 (ultrawide on A53)', async () => {
  const ordered = pickBackCameras([
    { label: 'camera 1, facing front', deviceId: 'f1' },
    { label: 'camera 2, facing back', deviceId: 'uw' },
    { label: 'camera 0, facing back', deviceId: 'main' },
  ]);
  assert.equal(ordered.length, 2);
  assert.equal(ordered[0].deviceId, 'main');
  assert.equal(ordered[1].deviceId, 'uw');

  const calls = [];
  const track = {
    getCapabilities: () => ({ focusMode: ['manual', 'continuous'], focusDistance: { min: 0.1, max: 3.6, step: 0.01 } }),
    applyConstraints: async (c) => { calls.push(c); },
  };
  const fd = await setManualFocusDistance(track, 0.20);
  assert.equal(fd.ok, true);
  assert.equal(fd.distanceM, 0.2);
  assert.equal(calls[0].advanced[0].focusMode, 'manual');
  assert.equal(calls[1].advanced[0].focusDistance, 0.2);
});

await test('C5 computeEvenCropRect produces even/4-aligned coords for 4K portrait (2160x3840) & offsets boxes', async () => {
  const rect = computeEvenCropRect(2160, 3840, { widthFrac: 0.55, heightFrac: 0.65 });
  assert.equal(rect.x % 2, 0);
  assert.equal(rect.y % 2, 0);
  assert.equal(rect.width % 4, 0);
  assert.equal(rect.height % 2, 0);
  assert.ok(rect.x + rect.width <= 2160 && rect.y + rect.height <= 3840);

  const det = offsetDetectionByCrop({ roiX: 100, roiY: 200, roiCenterX: 150, roiCenterY: 250 }, rect.x, rect.y);
  assert.equal(det.roiX, 100 + rect.x);
  assert.equal(det.roiCenterY, 250 + rect.y);
});

await test('U4 pauseCtl pauses on manual hold and after >400ms face-down gravity', async () => {
  const states = [];
  const ctl = createPauseController({ onChange: (s) => states.push(s) });
  assert.equal(ctl.isPaused(), false);
  ctl.setManualHold(true);
  assert.equal(ctl.isPaused(), true);
  ctl.setManualHold(false);
  assert.equal(ctl.isPaused(), false);

  ctl.ingestAccel(0.1, 0.2, -9.7, 1000);
  assert.equal(ctl.isPaused(), false);
  ctl.ingestAccel(0.1, 0.2, -9.7, 1450);
  assert.equal(ctl.isPaused(), true);
  ctl.ingestAccel(0.2, 9.6, 0.4, 1600);
  assert.equal(ctl.isPaused(), false);
});

await test('C6 selectStandbackLens reports no tele on A53 (picks main camera 0) and picks tele when present', async () => {
  const a53Cams = [
    {
      label: 'camera 2, facing back',
      facing: 'environment',
      roleGuess: 'REAR-AUX?',
      capabilities: { width: { max: 4000 }, focusMode: ['manual'], torch: 'n/a', zoom: { min: 1, max: 8 } },
      zoomSweep: { logicalZoomLikely: false },
    },
    {
      label: 'camera 0, facing back',
      facing: 'environment',
      roleGuess: 'MAIN?',
      capabilities: { width: { max: 4624 }, focusMode: ['manual', 'continuous'], torch: true, zoom: { min: 1, max: 8 } },
      zoomSweep: { logicalZoomLikely: false },
    },
  ];
  const a53Res = selectStandbackLens(a53Cams);
  assert.equal(a53Res.hasTele, false);
  assert.equal(a53Res.profile, 'wall');
  assert.equal(a53Res.selectedCamera.label, 'camera 0, facing back');

  const teleCams = [
    ...a53Cams,
    {
      label: 'camera 4, facing back tele',
      facing: 'environment',
      roleGuess: 'TELE?',
      capabilities: { width: { max: 4000 }, focusMode: ['continuous'], focusDistance: { min: 0.3, max: 5 }, zoom: { min: 1, max: 10 } },
    },
  ];
  const teleRes = selectStandbackLens(teleCams);
  assert.equal(teleRes.hasTele, true);
  assert.equal(teleRes.profile, 'standback');
  assert.equal(teleRes.selectedCamera.label, 'camera 4, facing back tele');
});

await test('C7 computePredictedLabelCrop builds even-aligned 4K crop and falls back when stale or out of frame', async () => {
  const okCrop = computePredictedLabelCrop(
    { ok: true, inFrame: true, uPx: 1080, vPx: 1920, expectedLenPx: 420 },
    2160,
    3840,
    { quatAgeMs: 25 }
  );
  assert.equal(okCrop.fallback, false);
  assert.equal(okCrop.rect.x % 2, 0);
  assert.equal(okCrop.rect.y % 2, 0);
  assert.equal(okCrop.rect.width % 4, 0);
  assert.equal(okCrop.rect.height % 2, 0);

  const stale = computePredictedLabelCrop(
    { ok: true, inFrame: true, uPx: 1080, vPx: 1920, expectedLenPx: 420 },
    2160,
    3840,
    { quatAgeMs: 250 }
  );
  assert.equal(stale.fallback, true);
  assert.equal(stale.reason, 'stale-quat');
});

console.log(`All ${passed} Stream C & U tests passed.`);
