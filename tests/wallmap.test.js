/**
 * Unit & 200-run Monte-Carlo tests + ablations for A10 (`src/wallmap.js`, `slideMap` flag).
 */
import assert from 'node:assert/strict';
import { createSlideWallMapper } from '../src/wallmap.js';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

function makeRng(seed = 9001) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function simulateSnakeRun(opts = {}, seed = 1) {
  const rng = makeRng(seed);
  const mapper = createSlideWallMapper({
    cols: 4, rows: 4, pitchXIn: 16, pitchYIn: 14, distanceIn: 10,
    startCorner: 'top-left',
    ...opts,
  });
  const cells = mapper.getCells();
  const frameW = 1920;
  const frameH = 1080;
  const fPx = (1920 * 0.5) / Math.tan((70.7 * 0.5) * Math.PI / 180);
  const trueD = 8 + rng() * 3; // 8..11 in standoff
  const speedInPerSec = opts.speedInPerSec || 12;
  const dtMs = 50; // 20 Hz
  const dtS = dtMs / 1000;

  // Build snake waypoints across all 16 totes
  const seq = [];
  for (let r = 0; r < 4; r++) {
    if (r % 2 === 0) {
      for (let c = 0; c < 4; c++) seq.push(cells[r * 4 + c]);
    } else {
      for (let c = 3; c >= 0; c--) seq.push(cells[r * 4 + c]);
    }
  }

  let curX = seq[0].cx;
  let curY = seq[0].cy;
  let tMs = 100;

  for (let s = 0; s < seq.length; s++) {
    const target = seq[s];
    const dist = Math.hypot(target.cx - curX, target.cy - curY);
    const steps = Math.max(1, Math.ceil(dist / (speedInPerSec * dtS)));

    for (let k = 0; k < steps; k++) {
      const dxIn = (target.cx - curX) / (steps - k);
      const dyIn = (target.cy - curY) / (steps - k);
      curX += dxIn;
      curY += dyIn;
      tMs += dtMs;

      const gyroY = (rng() - 0.5) * 0.04;
      const gyroX = (rng() - 0.5) * 0.04;
      const pxPerIn = fPx / trueD;
      const flowDx = -dxIn * pxPerIn + fPx * Math.tan(gyroY * dtS) + (rng() - 0.5) * 3.0;
      const flowDy = dyIn * pxPerIn + fPx * Math.tan(gyroX * dtS) + (rng() - 0.5) * 3.0;

      mapper.stepMotion({
        dtMs,
        flowDx,
        flowDy,
        flowConf: opts.dropFlow ? 0.05 : 0.75,
        gyroRadX: gyroX,
        gyroRadY: gyroY,
        accelX: (rng() - 0.5) * 0.3,
        accelY: 9.81,
        accelZ: (rng() - 0.5) * 0.3,
        frameW,
        frameH,
      });
    }

    // Label detection at target tote (unless deliberately skipped)
    if (opts.skipCellId === target.id) continue;
    const lenPx = (fPx * 3.5) / trueD;
    const payload = `tsX${String(seed).padStart(3, '0')}${target.id}B`;
    mapper.addDetection({
      payload,
      cx: frameW * 0.5 + (rng() - 0.5) * 30,
      cy: frameH * 0.5 + (rng() - 0.5) * 30,
      lenPx,
      frameW,
      frameH,
      prefixOk: 1,
      tFrameMs: tMs,
    });
  }

  let correctRead = 0;
  let silentWrong = 0;
  for (const c of mapper.getCells()) {
    const exp = `tsX${String(seed).padStart(3, '0')}${c.id}B`;
    if (c.state === 'READ') {
      if (c.payload === exp) correctRead++;
      else silentWrong++;
    }
  }
  return { mapper, correctRead, silentWrong };
}

test('A10 Monte-Carlo (200 runs at 12 in/s): >= 95% reads and 0 silent wrong placements', () => {
  let totalCorrect = 0;
  let totalCells = 0;
  let totalSilentWrong = 0;

  for (let run = 0; run < 200; run++) {
    const res = simulateSnakeRun({ speedInPerSec: 12 }, 100 + run);
    totalCorrect += res.correctRead;
    totalCells += 16;
    totalSilentWrong += res.silentWrong;
  }

  const rate = totalCorrect / totalCells;
  assert.ok(rate >= 0.95, `Slide mapper read rate ${(rate * 100).toFixed(1)}% < 95%`);
  assert.equal(totalSilentWrong, 0, `Detected ${totalSilentWrong} silent wrong placements`);
});

test('A10 missing cell detection & LOST fallback never silently mis-assigns later totes', () => {
  const res = simulateSnakeRun({ skipCellId: 'R1C3', speedInPerSec: 10 }, 7);
  const cells = res.mapper.getCells();
  assert.equal(cells[2].state, 'MISSING');
  assert.equal(cells[3].state, 'READ');
  assert.equal(cells[3].payload, 'tsX007R1C4B');
  assert.equal(res.silentWrong, 0);

  // Flow lost for > 1.5 s -> trackingState === 'LOST' (Tier C), no silent wrong placements
  const lostRun = simulateSnakeRun({ dropFlow: true, speedInPerSec: 10 }, 8);
  assert.equal(lostRun.mapper.getTrackingState().trackingState, 'LOST');
  assert.equal(lostRun.silentWrong, 0);

  // Manual Tier D fallback sets cell directly
  assert.equal(lostRun.mapper.setCellManually(0, 0, 'tsXMANUAL01B'), true);
  assert.equal(lostRun.mapper.getCells()[0].payload, 'tsXMANUAL01B');
  assert.ok(lostRun.mapper.exportCsv().includes('tsXMANUAL01B'));
});

console.log(`All ${passed} Wave 3 A10 slide-mode wall mapper tests passed.`);
