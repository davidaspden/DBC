/**
 * L7 — Unit Tests for Seeded Per-Label Defects (`src/sim/defects.js` + `src/sim/cpu-render.js`).
 *   node tests/defects.test.js
 */

import assert from 'node:assert/strict';
import {
  normalizeDefectsSpec,
  buildCellDefectsTable,
  DEFECT_STRIDE,
  DEF_TILT_DEG,
  DEF_PRINT_GAIN,
} from '../src/sim/defects.js';
import { warpLabelScanCoord, warpLabelScanDeriv } from '../src/sim/label.js';
import { createScene } from '../src/sim/scene.js';
import { renderFrame, createCpuRenderContext } from '../src/sim/cpu-render.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running L7 seeded label defects unit tests...');

test('simDefects off produces bit-for-bit identical output to legacy scene.defects = null', () => {
  assert.equal(normalizeDefectsSpec(null), null);
  assert.equal(normalizeDefectsSpec(false), null);
  assert.equal(normalizeDefectsSpec({ enabled: false }), null);

  const width = 320;
  const height = 180;
  const sNull = createScene({ fcMode: true });
  const sOff = createScene({ fcMode: true, defects: { enabled: false, seed: 99 } });
  const cell = sNull.cells[5];
  const pose = { x: cell.cx, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

  const a = new Uint8Array(width * height);
  const b = new Uint8Array(width * height);
  renderFrame(sNull, [pose], { width, height, hfovDeg: 70.7, seed: 11 }, a);
  renderFrame(sOff, [pose], { width, height, hfovDeg: 70.7, seed: 11 }, b);
  assert.equal(Buffer.compare(a, b), 0, 'simDefects off must be bit-for-bit identical');
});

test('buildCellDefectsTable is deterministic with mulberry32 and bounds tilt +/-6 deg and printGain +/-10%', () => {
  const specA = normalizeDefectsSpec({ enabled: true, seed: 42 });
  const specB = normalizeDefectsSpec({ enabled: true, seed: 42 });
  const specC = normalizeDefectsSpec({ enabled: true, seed: 43 });

  const tA = buildCellDefectsTable(16, specA, 1.0);
  const tB = buildCellDefectsTable(16, specB, 1.0);
  const tC = buildCellDefectsTable(16, specC, 1.0);

  assert.deepEqual(Array.from(tA), Array.from(tB), 'same seed must produce identical defect table');
  assert.notDeepEqual(Array.from(tA), Array.from(tC), 'distinct seeds must produce distinct defect tables');

  for (let i = 0; i < 16; i++) {
    const tilt = tA[i * DEFECT_STRIDE + DEF_TILT_DEG];
    const pg = tA[i * DEFECT_STRIDE + DEF_PRINT_GAIN];
    assert.ok(tilt >= -6.0 && tilt <= 6.0, `tilt out of +/-6 deg: ${tilt}`);
    assert.ok(pg >= 0.90 && pg <= 1.10, `printGain out of +/-10%: ${pg}`);
  }

  // Peel warp helper preserves endpoints [0, 1] and is non-zero in interior
  assert.equal(warpLabelScanCoord(0, 0.2), 0);
  assert.equal(warpLabelScanCoord(1, 0.2), 1);
  assert.notEqual(warpLabelScanCoord(0.25, 0.2), 0.25);
  assert.ok(warpLabelScanDeriv(0.5, 0.2) > 1.0);
});

test('each of the 9 individual defects measurably alters rendered label luma/contrast cleanly', () => {
  const width = 480;
  const height = 360;
  const baseScene = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder', payloadFn: () => 'tsX07wz7py1' },
  });
  const cell = baseScene.cells[5];
  const pose = { x: cell.cx, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const baseImg = new Uint8Array(width * height);
  renderFrame(baseScene, [pose], { width, height, hfovDeg: 70.7, seed: 1 }, baseImg);

  // Neutral force baseline (all 9 defects explicitly zeroed) must match baseImg identically
  const zeroForce = {
    tiltDeg: 0,
    offsetXIn: 0,
    offsetYIn: 0,
    peelWarp: 0,
    printGain: 1.0,
    streak: false,
    scuff: false,
    cover: false,
    smudge: false,
    quietCutFrac: 0,
  };

  const cases = [
    { name: 'tilt (+5 deg)',            force: { ...zeroForce, tiltDeg: 5.0 } },
    { name: 'offset (+0.3, -0.25 in)',  force: { ...zeroForce, offsetXIn: 0.3, offsetYIn: -0.25 } },
    { name: 'peel warp (0.20)',         force: { ...zeroForce, peelWarp: 0.20 } },
    { name: 'print gain (+10%)',        force: { ...zeroForce, printGain: 1.10 } },
    { name: 'thermal dead-dot streak',  force: { ...zeroForce, streak: { u: 0.0, halfW: 0.12 } } },
    { name: 'abrasion scuff patch',     force: { ...zeroForce, scuff: { u: 0.0, v: 0.5, radU: 0.45, radV: 0.12, strength: 0.8 } } },
    { name: 'partial tape/sticker cover', force: { ...zeroForce, cover: { frac: 0.18, side: 1 } } },
    { name: 'dark smudge blotch',       force: { ...zeroForce, smudge: { u: 0.0, v: 0.5, radU: 0.45, radV: 0.12, strength: 0.7 } } },
    { name: 'truncated quiet zone',     force: { ...zeroForce, quietCutFrac: 0.85 } },
  ];

  const img = new Uint8Array(width * height);
  for (const c of cases) {
    const sc = createScene({
      fcMode: true,
      shadowStrength: 0,
      noiseStrength: 0,
      glareStrength: 0,
      label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder', payloadFn: () => 'tsX07wz7py1' },
      defects: { enabled: true, seed: 1, force: c.force },
    });
    renderFrame(sc, [pose], { width, height, hfovDeg: 70.7, seed: 1 }, img);

    let sumAbsDiff = 0;
    let changedPx = 0;
    for (let i = 0; i < img.length; i++) {
      const d = Math.abs(img[i] - baseImg[i]);
      if (d > 0) {
        sumAbsDiff += d;
        changedPx++;
      }
    }
    assert.ok(
      changedPx >= 50 && sumAbsDiff >= 1000,
      `defect "${c.name}" had insufficient measurable effect: changedPx=${changedPx}, sumAbsDiff=${sumAbsDiff}`
    );
  }
});

test('renderFrame with simDefects enabled runs with zero hot-loop heap allocation', () => {
  const scene = createScene({ fcMode: true, defects: { enabled: true, seed: 7 } });
  const width = 320;
  const height = 180;
  const out = new Uint8Array(width * height);
  const ctx = createCpuRenderContext();
  const pose = { x: scene.cells[5].cx, y: scene.cells[5].cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const opts = { width, height, hfovDeg: 70.7, seed: 1, ctx };
  for (let i = 0; i < 3; i++) renderFrame(scene, [pose], opts, out);
  const ret = renderFrame(scene, [pose], opts, out);
  assert.strictEqual(ret, out);
});

console.log(`All ${passed} L7 label defects tests passed.`);
