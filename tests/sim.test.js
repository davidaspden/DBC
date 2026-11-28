/**
 * Unit tests for the WebGL 4x4 Tote Wall Camera Motion Simulator (`src/sim/paths.js`).
 * Runs in Node.js ESM with zero dependencies:
 *   node tests/sim.test.js
 */

import assert from 'node:assert/strict';
import {
  TOTE_WIDTH_IN,
  TOTE_HEIGHT_IN,
  BARCODE_WIDTH_IN,
  BARCODE_HEIGHT_IN,
  WALL_WIDTH_IN,
  WALL_HEIGHT_IN,
  PATH_DEFINITIONS,
  createWallCells,
  computeOptics,
  sampleCameraPose,
  mat4Perspective,
  mat4CameraView,
  mat4Multiply,
} from '../src/sim/paths.js';
import { encodeCode128 } from './harness.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running WebGL 4x4 simulator geometry, optics & path tests...');

test('Wall geometry matches exact 14x16 in totes and 2x6 in vertical barcodes in 4x4 grid', () => {
  assert.equal(TOTE_WIDTH_IN, 14);
  assert.equal(TOTE_HEIGHT_IN, 16);
  assert.equal(BARCODE_WIDTH_IN, 2);
  assert.equal(BARCODE_HEIGHT_IN, 6);
  assert.equal(WALL_WIDTH_IN, 56);
  assert.equal(WALL_HEIGHT_IN, 64);

  const cells = createWallCells();
  assert.equal(cells.length, 16);
  assert.equal(cells[0].id, 'R1C1');
  assert.equal(cells[0].cx, -21);
  assert.equal(cells[0].cy, 24);
  assert.equal(cells[15].id, 'R4C4');
  assert.equal(cells[15].cx, 21);
  assert.equal(cells[15].cy, -24);

  // Every cell payload must be unique and validly Code 128B encodable (<= 256 modules)
  const unique = new Set();
  for (const c of cells) {
    unique.add(c.payload);
    const enc = encodeCode128(c.payload, { subset: 'B', quietZoneModules: 10 });
    assert.ok(enc.totalModules === 231, `expected 231 modules for 16-char Code 128B, got ${enc.totalModules}`);
  }
  assert.equal(unique.size, 16);
});

test('computeOptics calculates expected FOV footprint and pixels-per-module (ppm)', () => {
  // Galaxy A53 5G main 1x (~70.7 deg HFOV) at 10 in, 1280x720
  const o10 = computeOptics({ distanceIn: 10, hfovDeg: 70.7, widthPx: 1280, heightPx: 720, totalModules: 231 });
  assert.ok(o10.visibleWidthIn > 14 && o10.visibleWidthIn < 14.5, `visibleWidthIn=${o10.visibleWidthIn}`);
  assert.ok(o10.ppm > 2.2, `expected >2.2 ppm at 10 in 720p, got ${o10.ppm}`);
  assert.equal(o10.nyquistOk, true);

  // 3x telephoto (26 deg HFOV) at 30 in, 1920x1080
  const oTele = computeOptics({ distanceIn: 30, hfovDeg: 26, widthPx: 1920, heightPx: 1080, totalModules: 231 });
  assert.ok(oTele.ppm > 3.0, `expected >3.0 ppm at 30 in 3x tele 1080p, got ${oTele.ppm}`);
  assert.equal(oTele.nyquistOk, true);

  // 1x main at 60 in, 720p must fall below 2.0 ppm Nyquist floor
  const oFar = computeOptics({ distanceIn: 60, hfovDeg: 70.7, widthPx: 1280, heightPx: 720, totalModules: 231 });
  assert.equal(oFar.nyquistOk, false);
});

test('All camera paths produce finite poses and cover expected bounds', () => {
  for (const def of PATH_DEFINITIONS) {
    const p0 = sampleCameraPose(def.id, 0, { distanceIn: 14, speedInPerSec: 20, jitter: 0.2, loop: false });
    const p1 = sampleCameraPose(def.id, 2.5, { distanceIn: 14, speedInPerSec: 20, jitter: 0.2, loop: false });
    for (const p of [p0, p1]) {
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z));
      assert.ok(Number.isFinite(p.yawDeg) && Number.isFinite(p.pitchDeg) && Number.isFinite(p.rollDeg));
      assert.ok(p.z >= 4);
    }
  }

  // Stand-back pan keeps camera anchored at (0, 0, 30) while rotating yaw/pitch toward wall corners
  const pan0 = sampleCameraPose('pan-snake', 0, { distanceIn: 30, speedInPerSec: 20, jitter: 0, loop: false });
  assert.equal(pan0.x, 0);
  assert.equal(pan0.y, 0);
  assert.equal(pan0.z, 30);
  assert.ok(pan0.yawDeg < -30, `expected leftward yaw toward R1C1, got ${pan0.yawDeg}`);
  assert.ok(pan0.pitchDeg > 25, `expected upward pitch toward R1C1, got ${pan0.pitchDeg}`);
});

test('mat4Perspective + mat4CameraView maps wall origin (0,0,0) to NDC center (0,0) when camera faces -Z', () => {
  const proj = mat4Perspective(Math.PI / 3, 16 / 9, 0.5, 500);
  const view = mat4CameraView({ x: 0, y: 0, z: 20, yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
  const mvp = mat4Multiply(proj, view);

  // Transform world point (0, 0, 0, 1) -> column 3 of mvp
  const cx = mvp[12] / mvp[15];
  const cy = mvp[13] / mvp[15];
  assert.ok(Math.abs(cx) < 1e-6, `expected NDC x=0, got ${cx}`);
  assert.ok(Math.abs(cy) < 1e-6, `expected NDC y=0, got ${cy}`);

  // When camera pans right (+yawDeg toward +X), point (+10, 0, 0) should land near NDC center x=0
  const yawTo10 = (Math.atan2(10, 20) * 180) / Math.PI;
  const viewPan = mat4CameraView({ x: 0, y: 0, z: 20, yawDeg: yawTo10, pitchDeg: 0, rollDeg: 0 });
  const mvpPan = mat4Multiply(proj, viewPan);
  const px = mvpPan[0] * 10 + mvpPan[12];
  const pw = mvpPan[3] * 10 + mvpPan[15];
  assert.ok(Math.abs(px / pw) < 1e-5, `expected aimed point (+10,0,0) at NDC x=0, got ${px / pw}`);
});

test('F1 FC realism 3.5 in tsX labels match expected module count and Nyquist floor at 8/12/30 in', () => {
  const fcCells = createWallCells({ fcMode: true });
  assert.equal(fcCells.length, 16);
  for (const c of fcCells) {
    assert.ok(c.payload.startsWith('tsX'), `expected tsX prefix, got ${c.payload}`);
    const enc = encodeCode128(c.payload, { subset: 'B', quietZoneModules: 10 });
    assert.equal(enc.totalModules, 187, `expected 187 modules for 12-char Code 128B, got ${enc.totalModules}`);
  }

  // A53 1x (70.7 deg) 1080p at 8 in -> > 3 ppm (OK), 12 in -> > 2 ppm (OK), 30 in -> < 1.0 ppm (FAIL)
  const o8 = computeOptics({ distanceIn: 8, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, totalModules: 187, labelHeightIn: 3.5 });
  const o12 = computeOptics({ distanceIn: 12, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, totalModules: 187, labelHeightIn: 3.5 });
  const o30 = computeOptics({ distanceIn: 30, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, totalModules: 187, labelHeightIn: 3.5 });
  assert.ok(o8.ppm > 3.0, `8 in ppm=${o8.ppm}`);
  assert.ok(o12.ppm > 2.0, `12 in ppm=${o12.ppm}`);
  assert.ok(o30.ppm < 1.0, `30 in 1x ppm=${o30.ppm}`);
  assert.equal(o30.nyquistOk, false);
});

test('F2 snake-h has zero along-scan blur on row passes while snake-v has full along-scan blur', () => {
  const pH = sampleCameraPose('snake-h', 0.5, { distanceIn: 10, speedInPerSec: 20, jitter: 0, loop: false });
  const pV = sampleCameraPose('snake-v', 0.5, { distanceIn: 10, speedInPerSec: 20, jitter: 0, loop: false });
  assert.ok(pH.alongScanSpeedInPerSec < 0.01, `horizontal row pass should have ~0 along-scan speed, got ${pH.alongScanSpeedInPerSec}`);
  assert.ok(pV.alongScanSpeedInPerSec > 19.5, `vertical column pass should have full along-scan speed, got ${pV.alongScanSpeedInPerSec}`);
  assert.ok(PATH_DEFINITIONS.some((p) => p.id === 'snake-h-fast-step'));
});

console.log(`All ${passed} WebGL simulator tests passed.`);
