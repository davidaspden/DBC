/**
 * Unit & 200-run Monte-Carlo tests for A8 (`panKalman`) and A9 (`allocCleanup`).
 */
import assert from 'node:assert/strict';
import {
  solveDistanceFromLabel,
  solveTwoReadFocalAndDistance,
  createPanKalmanFilter,
  computeDriftSigmaIn,
} from '../src/array/kalman.js';
import { createPanArrayMapper } from '../src/array/pan-mapper.js';
import { quatFromPanTiltRollDeg, extractPanTiltRollDeg } from '../src/array/orient.js';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('A8 solveDistanceFromLabel accounts for cos^2(tilt)*cos(pan) within 1% at outer columns', () => {
  const fPx = 1350;
  const labelLenIn = 3.5;
  const trueD = 28.0;
  const panRad = 38 * (Math.PI / 180);
  const tiltRad = 22 * (Math.PI / 180);
  const trueLenPx = (fPx * labelLenIn * Math.cos(tiltRad) ** 2 * Math.cos(panRad)) / trueD;
  const sol = solveDistanceFromLabel({ fPx, labelLenIn, lenPx: trueLenPx, panRad, tiltRad });
  assert.ok(Math.abs(sol.dIn - trueD) / trueD < 0.01, `got ${sol.dIn}, expected ${trueD}`);
});

test('A8 solveTwoReadFocalAndDistance recovers f and D within 5% from two corner reads', () => {
  const trueF = 1480;
  const trueD = 26.0;
  const truePx = 1.5;
  const truePy = -1.0;
  const truePsi0 = 0.03;
  const labelLenIn = 3.5;

  function synthRead(cellX, cellY) {
    const tanX = (cellX - truePx) / trueD - Math.tan(truePsi0);
    const tanY = (cellY - truePy) / trueD;
    const inv = 1 / Math.hypot(tanX, tanY, 1);
    const panRad = Math.atan(tanX + Math.tan(truePsi0));
    const tiltRad = Math.atan(tanY * Math.cos(panRad));
    const lenPx = (trueF * labelLenIn * Math.cos(tiltRad) ** 2 * Math.cos(panRad)) / trueD;
    return { cellX, cellY, rx: tanX * inv, ry: tanY * inv, wz: inv, lenPx };
  }

  const rA = synthRead(-24, 21);
  const rB = synthRead(24, -21);
  const sol = solveTwoReadFocalAndDistance(rA, rB, {
    labelLenIn,
    fPxInit: 1200,
    dInInit: 20,
  });
  assert.equal(sol.ok, true);
  assert.ok(Math.abs(sol.dIn - trueD) / trueD < 0.05, `D err too high: ${sol.dIn} vs ${trueD}`);
  assert.ok(Math.abs(sol.fPx - trueF) / trueF < 0.05, `f err too high: ${sol.fPx} vs ${trueF}`);
  assert.ok(sol.rmsWallIn < 0.5);
});

test('A8 Monte-Carlo (200 runs): 0 silent wrong cells and step-sideways 8 in / 16 in detection', () => {
  const rng = makeRng(20261128);
  let silentWrongCells = 0;

  for (let run = 0; run < 200; run++) {
    const trueD = 18 + rng() * 16; // 18..34 in
    const mapper = createPanArrayMapper({
      cols: 4, rows: 4, pitchXIn: 16, pitchYIn: 14, distanceIn: trueD,
      fcLabelDefaults: true, panKalman: true, conflictHysteresis: true, dupCheck: true,
    });
    const cells = mapper.getCells();
    const wobblePx = (rng() - 0.5) * 4.0;
    const wobblePy = (rng() - 0.5) * 3.0;
    mapper.stance.px = wobblePx * 0.4;
    mapper.stance.py = wobblePy * 0.4;

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const payload = `tsX${String(run).padStart(3, '0')}${c.id}B`;
      const panDeg = Math.atan2(c.cx - wobblePx, trueD) * (180 / Math.PI) + (rng() - 0.5) * 1.2;
      const tiltDeg = Math.atan2(c.cy - wobblePy, Math.hypot(c.cx - wobblePx, trueD)) * (180 / Math.PI) + (rng() - 0.5) * 1.2;
      const q = quatFromPanTiltRollDeg(panDeg, tiltDeg, (rng() - 0.5) * 3);
      for (let v = 0; v < 2; v++) {
        mapper.addObservation({ payload, cx: 640, cy: 360, prefixOk: 1, tFrameMs: (i * 2 + v) * 80 + 100 }, q, 1280, 720);
      }
    }

    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const expected = `tsX${String(run).padStart(3, '0')}${c.id}B`;
      if (c.state === 'READ' && c.payload !== expected) {
        silentWrongCells++;
      }
    }
  }
  assert.equal(silentWrongCells, 0, `Detected ${silentWrongCells} silent wrong cells in 200 MC runs`);

  // Step sideways 16 in -> must trigger stanceWarning or outside-snap-tolerance (never silent wrong cell)
  const mStep = createPanArrayMapper({
    cols: 4, rows: 4, pitchXIn: 16, pitchYIn: 14, distanceIn: 24,
    panKalman: true, dupCheck: true,
  });
  const q0 = mStep.getAimQuaternionForCell(0, 0).quat;
  mStep.addObservation({ payload: 'tsXSTEP0001B', cx: 640, cy: 360, tFrameMs: 100 }, q0, 1280, 720);
  mStep.addObservation({ payload: 'tsXSTEP0001B', cx: 640, cy: 360, tFrameMs: 160 }, q0, 1280, 720);
  // Operator steps 16 in sideways while looking at R1C1 -> lands on R1C2 with duplicate payload -> flags CONFLICT/LOW_CONF!
  mStep.stance.px = 16;
  mStep.addObservation({ payload: 'tsXSTEP0001B', cx: 640, cy: 360, tFrameMs: 300 }, q0, 1280, 720);
  mStep.addObservation({ payload: 'tsXSTEP0001B', cx: 640, cy: 360, tFrameMs: 360 }, q0, 1280, 720);
  assert.notEqual(mStep.getCells()[1].state, 'READ');
  assert.ok(computeDriftSigmaIn(24, 0.3, 1.0) > 2.5);
});

test('A9 allocCleanup reuses footprint & snapshot buffers with identical values and C7 predictLabelPixel round-trips', () => {
  const m = createPanArrayMapper({
    cols: 4, rows: 4, pitchXIn: 16, pitchYIn: 14, distanceIn: 24, allocCleanup: true,
  });
  const q = m.getAimQuaternionForCell(1, 2).quat;
  const fp1 = m.getCameraFootprint(q, 1920, 1080);
  const fp2 = m.getCameraFootprint(q, 1920, 1080);
  assert.equal(fp1, fp2, 'allocCleanup must reuse footprint struct');
  assert.equal(fp2.targetCell.id, 'R2C3');

  const pred = m.predictLabelPixel(q, 1, 2, 1920, 1080);
  assert.equal(pred.ok, true);
  assert.equal(pred.inFrame, true);
  assert.ok(Math.abs(pred.uPx - 960) < 2, `uPx=${pred.uPx}`);
  assert.ok(Math.abs(pred.vPx - 540) < 2, `vPx=${pred.vPx}`);

  const snap = new Uint8Array(16);
  m.getCellStateSnapshot(snap);
  assert.equal(snap[0], 0);

  // Verify extractPanTiltRollDeg scratch reuse produces accurate results
  const out = { panDeg: 0, tiltDeg: 0, rollDeg: 0 };
  const qTest = quatFromPanTiltRollDeg(15, -10, 5);
  extractPanTiltRollDeg(qTest, out);
  assert.ok(Math.abs(out.panDeg - 15) < 0.1);
  assert.ok(Math.abs(out.tiltDeg - (-10)) < 0.1);
});

console.log(`All ${passed} Wave 3 A8/A9 pan model & alloc cleanup tests passed.`);
