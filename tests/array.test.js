/**
 * Unit tests for the Tilt & Pan Array Scanner (`src/array/orient.js` + `src/array/pan-mapper.js`).
 * Runs in Node.js ESM with zero dependencies:
 *   node tests/array.test.js
 */

import assert from 'node:assert/strict';
import {
  quatFromPanTiltRollDeg,
  extractPanTiltRollDeg,
  quatMultiply,
  quatRotateVec,
  createOrientationTracker,
} from '../src/array/orient.js';
import { createPanArrayMapper } from '../src/array/pan-mapper.js';
import { classifyHold, solveAxisRemap, AXIS_REMAPS, applyAxisRemap } from '../src/array/setup.js';
import { computeBlurModules } from '../src/array/blur.js';
import { computeViewTransform, mapRectToHud } from '../src/array/viewmap.js';
import { pxPerModule } from '../src/array/optics.js';
import { createAutoZeroStateMachine } from '../src/array/autozero.js';

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

test('A1 fcLabelDefaults and toteOrientation config produce expected 3.5 in optics & swapped pitch', () => {
  const mapper = createPanArrayMapper({ fcLabelDefaults: true, toteOrientation: '16Wx14H' });
  assert.equal(mapper.cfg.labelLenIn, 3.5);
  assert.equal(mapper.cfg.labelModules, 187);
  assert.equal(mapper.cfg.pitchXIn, 16);
  assert.equal(mapper.cfg.pitchYIn, 14);
  assert.equal(mapper.cfg.distanceIn, 12);

  const rep12 = mapper.getOpticsReport(1920, 1080);
  assert.equal(rep12.status, 'ok');
  assert.ok(rep12.ppm > 2.0, `12 in ppm=${rep12.ppm}`);

  const ppm30 = pxPerModule({ distanceIn: 30, hfovDeg: 70.7, zoom: 1, widthPx: 1920, heightPx: 1080, labelLenIn: 3.5, modules: 187 });
  assert.ok(ppm30 < 1.0, `30 in 1x ppm=${ppm30}`);
});

test('A7 orientGravityZero preserves absolute gravity pitch/roll at 15 deg roll + 20 deg pitch & screen rotations', () => {
  const orient = createOrientationTracker({ gravityZero: true });
  const mapper = createPanArrayMapper({ cols: 4, rows: 4, pitchXIn: 14, pitchYIn: 16, distanceIn: 30 });

  // Upright phone in world frame (+Z up) is Rx(+90 deg). Compose with roll 15 deg & pitch up 20 deg.
  const qRx90 = new Float64Array([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
  const qTiltRoll = quatFromPanTiltRollDeg(0, 20, 15);
  const qWorldFromDev = new Float64Array(4);
  quatMultiply(qRx90, qTiltRoll, qWorldFromDev);

  orient.setDeviceQuaternion(qWorldFromDev);
  orient.zeroYawOnly(0);
  const info = orient.getSetupInfo();
  assert.ok(Math.abs(info.pitchDeg - 20) < 0.2, `expected gravity pitch ~20 deg, got ${info.pitchDeg}`);
  assert.ok(Math.abs(info.rollDeg - 15) < 0.5, `expected gravity roll ~15 deg, got ${info.rollDeg}`);

  // Stand in front of R1C1 with phone tilted up 20 deg -> ray hits R1C1 squarely
  mapper.setInFrontStanceForCell(0, 0, info.pitchDeg);
  const p0 = mapper.projectPixelToWall(orient.getRelativeQuaternion(), 640, 360, 1280, 720);
  assert.equal(p0.ok, true);
  assert.ok(Math.abs(p0.wx - (-21)) < 0.25, `wx=${p0.wx}`);
  assert.ok(Math.abs(p0.wy - 24) < 0.25, `wy=${p0.wy}`);

  // Rotate screen 90 deg mid-run while device physically holds same world orientation
  // (device rotated -90 around Z in hand, screenAngle updated to 90 -> optical ray stays on R1C1!)
  const qDevRot = new Float64Array(4);
  const qRz90 = new Float64Array([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
  quatMultiply(qWorldFromDev, qRz90, qDevRot);
  orient.setScreenAngle(90);
  orient.setDeviceQuaternion(qDevRot);
  const p90 = mapper.projectPixelToWall(orient.getRelativeQuaternion(), 640, 360, 1280, 720);
  assert.ok(Math.abs(p90.wx - (-21)) < 0.25, `after 90deg screen rot wx=${p90.wx}`);
  assert.ok(Math.abs(p90.wy - 24) < 0.25, `after 90deg screen rot wy=${p90.wy}`);

  // classifyHold verdicts
  assert.equal(classifyHold({ rollDeg: 3, pitchDeg: 5, frameW: 1080, frameH: 1920 }).verdict, 'OK');
  assert.equal(classifyHold({ rollDeg: 15, pitchDeg: 5 }).verdict, 'LEVEL_PHONE');
  assert.equal(classifyHold({ rollDeg: 35, pitchDeg: 5, frameW: 1920, frameH: 1080 }).verdict, 'ROTATED');
  assert.equal(classifyHold({ rollDeg: 0, pitchDeg: 48 }).verdict, 'AIM_WALL');
});

test('A7 solveAxisRemap recovers every one of the 8 D4 axis permutations/flips from 3 reads', () => {
  const truePts = [
    { expectedX: -21, expectedY: 24 },
    { expectedX: 7, expectedY: 8 },
    { expectedX: 21, expectedY: -24 },
  ];
  for (let id = 1; id < AXIS_REMAPS.length; id++) {
    const remap = AXIS_REMAPS[id];
    // Generate corrupted sensor tangents such that applying `remap` recovers truePts
    // Find inverse remap in D4
    const inv = AXIS_REMAPS.find((cand) => {
      const a = applyAxisRemap(1, 2, cand);
      const b = applyAxisRemap(a.x, a.y, remap);
      return b.x === 1 && b.y === 2;
    });
    const reads = truePts.map((pt) => {
      const m = applyAxisRemap(pt.expectedX / 30, pt.expectedY / 30, inv);
      return { tx: m.x, ty: m.y, expectedX: pt.expectedX, expectedY: pt.expectedY };
    });
    const solved = solveAxisRemap(reads, { distanceIn: 30, pitchXIn: 14, pitchYIn: 16, currentRemapId: 0 });
    assert.equal(solved.improved, true, `failed to detect improvement for remap ${id}`);
    assert.equal(solved.remap.id, id, `expected remap ${id}, got ${solved.remap.id}`);
    assert.ok(solved.bestErrIn < 0.05);
  }
});

test('B1 computeBlurModules gates vertical pitch on ladder labels and ignores harmless sideways pan', () => {
  const panOnly = computeBlurModules({
    wPanDps: 35,
    wPitchDps: 0,
    scanAngleDeg: 90,
    exposureSec: 1 / 60,
    pxPerModule: 2.5,
    focalLengthPx: 1350,
  });
  const pitchOnly = computeBlurModules({
    wPanDps: 0,
    wPitchDps: 20,
    scanAngleDeg: 90,
    exposureSec: 1 / 60,
    pxPerModule: 2.5,
    focalLengthPx: 1350,
  });
  assert.ok(panOnly < 0.01, `sideways pan on ladder label should have ~0 blur, got ${panOnly}`);
  assert.ok(pitchOnly > 2.5, `vertical pitch on ladder label at 1/60s should exceed gate, got ${pitchOnly}`);
});

test('B2 computeViewTransform maps 16:9 frame into 4:3 stage with exact contain letterboxing', () => {
  const xf = computeViewTransform(1920, 1080, 400, 300, 'contain');
  assert.ok(Math.abs(xf.drawW - 400) < 1e-6);
  assert.ok(Math.abs(xf.drawH - 225) < 1e-6);
  assert.ok(Math.abs(xf.offX - 0) < 1e-6);
  assert.ok(Math.abs(xf.offY - 37.5) < 1e-6);
  const mapped = mapRectToHud({ x: 960, y: 540, w: 192, h: 108 }, xf);
  assert.ok(Math.abs(mapped.x - 200) < 1e-6);
  assert.ok(Math.abs(mapped.y - 150) < 1e-6);
});

test('A2 conflictHysteresis ignores single stray misread while flagging genuine 3v3 conflict', () => {
  const mapper = createPanArrayMapper({
    cols: 2, rows: 2, pitchXIn: 16, pitchYIn: 14, distanceIn: 12,
    conflictHysteresis: true,
  });
  const qTL = quatFromPanTiltRollDeg(
    Math.atan2(-8, 12) * (180 / Math.PI),
    Math.atan2(7, Math.hypot(-8, 12)) * (180 / Math.PI),
    0
  );
  // 6 valid reads + 1 stray misread -> stays READ!
  for (let i = 0; i < 6; i++) {
    mapper.addObservation({ payload: 'tsX01GOOD01B', cx: 640, cy: 360, prefixOk: 1 }, qTL, 1280, 720);
  }
  mapper.addObservation({ payload: 'NOISE-BAD', cx: 640, cy: 360, prefixOk: 0 }, qTL, 1280, 720);
  assert.equal(mapper.getCells()[0].state, 'READ');
  assert.equal(mapper.getCells()[0].payload, 'tsX01GOOD01B');

  // Now compete on cell 1 (3 vs 3) -> CONFLICT!
  const qTR = quatFromPanTiltRollDeg(
    Math.atan2(8, 12) * (180 / Math.PI),
    Math.atan2(7, Math.hypot(8, 12)) * (180 / Math.PI),
    0
  );
  for (let i = 0; i < 3; i++) {
    mapper.addObservation({ payload: 'tsX02AAA001B', cx: 640, cy: 360 }, qTR, 1280, 720);
    mapper.addObservation({ payload: 'tsX02BBB002B', cx: 640, cy: 360 }, qTR, 1280, 720);
  }
  assert.equal(mapper.getCells()[1].state, 'CONFLICT');
});

test('A3 dupCheck flags cross-cell duplicate payloads and A4/A5 damp & label-anchor cleanly', () => {
  const mapper = createPanArrayMapper({
    cols: 2, rows: 2, pitchXIn: 16, pitchYIn: 14, distanceIn: 12,
    dupCheck: true, nudgeDamp: true, driftFromLabel: true,
  });
  const qTL = quatFromPanTiltRollDeg(
    Math.atan2(-8, 12) * (180 / Math.PI),
    Math.atan2(7, Math.hypot(-8, 12)) * (180 / Math.PI),
    0
  );
  const qTR = quatFromPanTiltRollDeg(
    Math.atan2(8, 12) * (180 / Math.PI),
    Math.atan2(7, Math.hypot(8, 12)) * (180 / Math.PI),
    0
  );
  for (let i = 0; i < 2; i++) mapper.addObservation({ payload: 'tsXDUPE0001B', cx: 640, cy: 360 }, qTL, 1280, 720);
  for (let i = 0; i < 2; i++) mapper.addObservation({ payload: 'tsXDUPE0001B', cx: 640, cy: 360 }, qTR, 1280, 720);
  assert.equal(mapper.getCells()[0].state, 'CONFLICT');
  assert.equal(mapper.getCells()[1].state, 'CONFLICT');
  assert.ok(mapper.getDuplicateEvents().length >= 1);

  // A5 anchorObservationToCell rejects giant 16 in jump and accepts small 3 in sway
  mapper.stance.px = 3;
  const okSmall = mapper.anchorObservationToCell({ cx: 640, cy: 360 }, qTL, 0, 0, 1280, 720);
  assert.equal(okSmall.ok, true);
  assert.ok(Math.abs(mapper.stance.px) < 0.2);

  mapper.stance.px = 14;
  const rejBig = mapper.anchorObservationToCell({ cx: 640, cy: 360 }, qTL, 0, 0, 1280, 720);
  assert.equal(rejBig.ok, false);
  assert.equal(rejBig.reason, 'jump-too-large');
});

test('A6 autoZeroFromLabel accepts 2 centred square reads and rejects skewed or off-centre reads', () => {
  const az = createAutoZeroStateMachine({ expectedScanDeg: 90, labelLenIn: 3.5 });
  az.arm();
  const base = { payload: 'tsX11AUTO01B', cx: 640, cy: 360, lenPx: 400, thetaDeg: 90, frameW: 1280, frameH: 720, focalLengthPx: 1350, currentDistanceIn: 12, wTotalDps: 1.5, rollDeg: 2 };

  // Skewed (>15 deg) rejected
  assert.equal(az.evaluate({ ...base, thetaDeg: 70 }).reason, 'skewed');
  // Off-centre rejected
  assert.equal(az.evaluate({ ...base, cx: 950 }).reason, 'off-center');
  // First valid read awaits second agreement
  assert.equal(az.evaluate(base).reason, 'awaiting-second-read');
  // Second agreeing read triggers!
  const trig = az.evaluate(base);
  assert.equal(trig.triggered, true);
  assert.equal(trig.payload, 'tsX11AUTO01B');
  assert.ok(trig.estimatedDistanceIn > 10 && trig.estimatedDistanceIn < 14);
});

console.log(`All ${passed} Tilt & Pan Array Scanner tests passed.`);
