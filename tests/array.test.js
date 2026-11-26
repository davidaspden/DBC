/**
 * Unit tests for the Tilt & Pan Array Scanner (`src/array/orient.js` + `src/array/pan-mapper.js`).
 * Runs in Node.js ESM with zero dependencies:
 *   node tests/array.test.js
 */

import assert from 'node:assert/strict';
import {
  quatFromPanTiltRollDeg,
  extractPanTiltRollDeg,
  createOrientationTracker,
} from '../src/array/orient.js';
import { createPanArrayMapper } from '../src/array/pan-mapper.js';

let passed = 0;

function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running Tilt & Pan Array Scanner unit tests...');

test('quatFromPanTiltRollDeg round-trips pan/tilt angles accurately', () => {
  const q = quatFromPanTiltRollDeg(24.5, -18.2, 0);
  const out = extractPanTiltRollDeg(q);
  assert.ok(Math.abs(out.panDeg - 24.5) < 0.05, `panDeg=${out.panDeg}`);
  assert.ok(Math.abs(out.tiltDeg - (-18.2)) < 0.05, `tiltDeg=${out.tiltDeg}`);
});

test('projectPixelToWall maps pan/tilt angles to exact 4x4 tote cell coordinates at 30 in', () => {
  const mapper = createPanArrayMapper({
    cols: 4,
    rows: 4,
    pitchXIn: 14,
    pitchYIn: 16,
    distanceIn: 30,
    hfovDeg: 70.7,
  });

  // Aim directly at R1C1 (-21 in, +24 in) from (0, 0, 30)
  const panR1C1 = Math.atan2(-21, 30) * (180 / Math.PI);
  const tiltR1C1 = Math.atan2(24, Math.hypot(-21, 30)) * (180 / Math.PI);
  const q1 = quatFromPanTiltRollDeg(panR1C1, tiltR1C1, 0);
  const p1 = mapper.projectPixelToWall(q1, 640, 360, 1280, 720);
  assert.equal(p1.ok, true);
  assert.ok(Math.abs(p1.wx - (-21)) < 0.15, `wx=${p1.wx}`);
  assert.ok(Math.abs(p1.wy - 24) < 0.15, `wy=${p1.wy}`);
  assert.equal(Math.round(p1.colFloat) | 0, 0);
  assert.equal(Math.round(p1.rowFloat) | 0, 0);

  // Aim directly at R4C4 (+21 in, -24 in) from (0, 0, 30)
  const panR4C4 = Math.atan2(21, 30) * (180 / Math.PI);
  const tiltR4C4 = Math.atan2(-24, Math.hypot(21, 30)) * (180 / Math.PI);
  const q4 = quatFromPanTiltRollDeg(panR4C4, tiltR4C4, 0);
  const p4 = mapper.projectPixelToWall(q4, 640, 360, 1280, 720);
  assert.equal(p4.ok, true);
  assert.ok(Math.abs(p4.wx - 21) < 0.15, `wx=${p4.wx}`);
  assert.ok(Math.abs(p4.wy - (-24)) < 0.15, `wy=${p4.wy}`);
  assert.equal(Math.round(p4.colFloat) | 0, 3);
  assert.equal(Math.round(p4.rowFloat) | 0, 3);
});

test('Full 16-cell tilt & pan sweep places all 16 barcodes into exact cells with 0 conflicts', () => {
  const mapper = createPanArrayMapper({ cols: 4, rows: 4, pitchXIn: 14, pitchYIn: 16, distanceIn: 30 });
  const cells = mapper.getCells();

  for (const c of cells) {
    const pan = Math.atan2(c.cx, 30) * (180 / Math.PI);
    const tilt = Math.atan2(c.cy, Math.hypot(c.cx, 30)) * (180 / Math.PI);
    const q = quatFromPanTiltRollDeg(pan, tilt, 0);
    const res = mapper.addObservation(
      { payload: `TOTE-${c.id}`, cx: 640, cy: 360, lenPx: 260, consensus: 4 },
      q,
      1280,
      720
    );
    assert.equal(res.placed, true, `failed to place ${c.id}`);
    assert.equal(res.cell.id, c.id);
  }

  const summary = mapper.getSummary();
  assert.equal(summary.readCount, 16);
  assert.equal(summary.conflictCount, 0);
  assert.equal(summary.complete, true);
  assert.ok(mapper.exportCsv().includes('R4C4,READ,"TOTE-R4C4"'));
});

test('2-Corner calibration recovers true standoff distance D when nominal guess is wrong', () => {
  // User entered nominal D=30 in, but actually stands at D=42 in
  const mapper = createPanArrayMapper({ cols: 4, rows: 4, pitchXIn: 14, pitchYIn: 16, distanceIn: 30 });
  const trueD = 42;
  const qTL = quatFromPanTiltRollDeg(
    Math.atan2(-21, trueD) * (180 / Math.PI),
    Math.atan2(24, Math.hypot(-21, trueD)) * (180 / Math.PI),
    0
  );
  const qBR = quatFromPanTiltRollDeg(
    Math.atan2(21, trueD) * (180 / Math.PI),
    Math.atan2(-24, Math.hypot(21, trueD)) * (180 / Math.PI),
    0
  );

  const s1 = mapper.recordCornerCalibration(1, qTL);
  assert.equal(s1.ok, true);
  const s2 = mapper.recordCornerCalibration(2, qBR);
  assert.equal(s2.ok, true);
  assert.ok(Math.abs(s2.estimatedDistanceIn - trueD) < 2.5, `estimated D=${s2.estimatedDistanceIn}, true=${trueD}`);
});

test('Conflict guard flags mismatched barcode landing on an already-read cell', () => {
  const mapper = createPanArrayMapper({ cols: 2, rows: 2, pitchXIn: 14, pitchYIn: 16, distanceIn: 30 });
  const qTL = quatFromPanTiltRollDeg(
    Math.atan2(-7, 30) * (180 / Math.PI),
    Math.atan2(8, Math.hypot(-7, 30)) * (180 / Math.PI),
    0
  );
  mapper.addObservation({ payload: 'CODE-A', cx: 640, cy: 360 }, qTL, 1280, 720);
  mapper.addObservation({ payload: 'CODE-B', cx: 640, cy: 360 }, qTL, 1280, 720);
  assert.equal(mapper.getCells()[0].state, 'CONFLICT');
});

test('Zeroing on Top-Left (R1C1) or Top-Right (R1C4) maps cleanly across entire 4x4 array', () => {
  const mapper = createPanArrayMapper({ cols: 4, rows: 4, pitchXIn: 14, pitchYIn: 16, distanceIn: 30 });
  const orient = createOrientationTracker();

  // Start aimed at Top-Left (R1C1)
  const tlAim = mapper.getStartCornerAim('top-left');
  orient.zeroToQuaternion(tlAim.quat);
  const pTL = mapper.projectPixelToWall(orient.getRelativeQuaternion(), 640, 360, 1280, 720);
  assert.equal(pTL.ok, true);
  assert.equal(Math.round(pTL.rowFloat) | 0, 0);
  assert.equal(Math.round(pTL.colFloat) | 0, 0);
  assert.ok(Math.abs(pTL.wx - (-21)) < 0.15, `TL wx=${pTL.wx}`);
  assert.ok(Math.abs(pTL.wy - 24) < 0.15, `TL wy=${pTL.wy}`);

  // Start aimed at Top-Right (R1C4)
  const trAim = mapper.getStartCornerAim('top-right');
  orient.zeroToQuaternion(trAim.quat);
  const pTR = mapper.projectPixelToWall(orient.getRelativeQuaternion(), 640, 360, 1280, 720);
  assert.equal(pTR.ok, true);
  assert.equal(Math.round(pTR.rowFloat) | 0, 0);
  assert.equal(Math.round(pTR.colFloat) | 0, 3);
  assert.ok(Math.abs(pTR.wx - 21) < 0.15, `TR wx=${pTR.wx}`);
  assert.ok(Math.abs(pTR.wy - 24) < 0.15, `TR wy=${pTR.wy}`);

  // 2-Corner calibration starting from Top-Right (R1C4 -> R4C1) recovers true standoff D=38 in
  const trueD = 38;
  const qTR = quatFromPanTiltRollDeg(
    Math.atan2(21, trueD) * (180 / Math.PI),
    Math.atan2(24, Math.hypot(21, trueD)) * (180 / Math.PI),
    0
  );
  const qBL = quatFromPanTiltRollDeg(
    Math.atan2(-21, trueD) * (180 / Math.PI),
    Math.atan2(-24, Math.hypot(-21, trueD)) * (180 / Math.PI),
    0
  );
  const c1 = mapper.recordCornerCalibration(1, qTR, 'top-right');
  assert.equal(c1.ok, true);
  const c2 = mapper.recordCornerCalibration(2, qBL, 'top-right');
  assert.equal(c2.ok, true);
  assert.equal(c2.startCorner, 'top-right');
  assert.ok(Math.abs(c2.estimatedDistanceIn - trueD) < 2.5, `estimated D=${c2.estimatedDistanceIn}, true=${trueD}`);
});

test('OrientationTracker manual pan/tilt lookup works cleanly', () => {
  const orient = createOrientationTracker();
  orient.setManualPanTilt(15, -10, 0);
  const q = new Float64Array(4);
  orient.getQuaternionAt(performance.now(), q);
  const ang = extractPanTiltRollDeg(q);
  assert.ok(Math.abs(ang.panDeg - 15) < 0.05);
  assert.ok(Math.abs(ang.tiltDeg - (-10)) < 0.05);
});

console.log(`All ${passed} Tilt & Pan Array Scanner tests passed.`);
