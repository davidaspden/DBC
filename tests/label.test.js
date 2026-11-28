/**
 * Unit tests for L1 Parameterised Label Geometry & Encoding (`src/sim/label.js` + `src/sim/paths.js`).
 *   node tests/label.test.js
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_LABEL_SPEC,
  LEGACY_PAYLOAD_FN,
  FC_12_PAYLOAD_FN,
  computeCode128Modules,
  encodeCode128B,
  normalizeLabelSpec,
  sampleBarcodeIntegrated1D,
} from '../src/sim/label.js';
import { createWallCells, computeOptics } from '../src/sim/paths.js';
import { encodeCode128 } from './harness.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running L1 parameterised label geometry unit tests...');

test('encodeCode128B matches harness encodeCode128 bit-for-bit across 16-char, 12-char and 11-char payloads', () => {
  const samples = [
    LEGACY_PAYLOAD_FN(0, 0, 0),
    FC_12_PAYLOAD_FN(1, 2, 6),
    'tsX07wz7py1',
    'A1!',
  ];
  for (const payload of samples) {
    const a = encodeCode128B(payload, 10);
    const b = encodeCode128(payload, { subset: 'B', quietZoneModules: 10 });
    assert.equal(a.totalModules, computeCode128Modules(payload, 10));
    assert.equal(a.totalModules, b.totalModules);
    assert.equal(a.checkSymbol, b.checkSymbol);
    assert.deepEqual(Array.from(a.modules), Array.from(b.modules));
  }
  assert.equal(computeCode128Modules('tsX07wz7py1'), 176);
  assert.equal(computeCode128Modules('TOTE-R1C1-000101'), 231);
});

test('computeOptics parameterises label dimensions, payload length and orientation without changing defaults', () => {
  const def = computeOptics({ distanceIn: 10, hfovDeg: 70.7, widthPx: 1280, heightPx: 720 });
  const explicitDef = computeOptics({
    distanceIn: 10,
    hfovDeg: 70.7,
    widthPx: 1280,
    heightPx: 720,
    totalModules: 231,
    labelHeightIn: 6,
  });
  assert.equal(def.ppm, explicitDef.ppm);
  assert.equal(def.totalModules, 231);

  // 2 x 3.5 in, 11-char tsX07wz7py1 (176 modules)
  const fc11 = computeOptics({
    distanceIn: 12,
    hfovDeg: 70.7,
    widthPx: 1920,
    heightPx: 1080,
    labelWidthIn: 2.0,
    labelHeightIn: 3.5,
    payload: 'tsX07wz7py1',
  });
  assert.equal(fc11.totalModules, 176);
  const fcDouble = computeOptics({
    distanceIn: 12,
    hfovDeg: 70.7,
    widthPx: 1920,
    heightPx: 1080,
    labelWidthIn: 2.0,
    labelHeightIn: 7.0,
    payload: 'tsX07wz7py1',
  });
  assert.ok(Math.abs(fcDouble.ppm - fc11.ppm * 2) < 1e-6);

  // Picket orientation uses labelWidthIn along the scan axis
  const picket = computeOptics({
    distanceIn: 12,
    hfovDeg: 70.7,
    widthPx: 1920,
    heightPx: 1080,
    labelWidthIn: 4.0,
    labelHeightIn: 2.0,
    orientation: 'picket',
    payload: 'tsX07wz7py1',
  });
  assert.equal(picket.scanLenIn, 4.0);
  assert.ok(Math.abs(picket.ppm - (fc11.ppm * (4.0 / 3.5))) < 1e-6);
});

test('sampleBarcodeIntegrated1D matches closed-form box integration and responds to printGain', () => {
  // Single dark module at index 2 of 6: [0, 0, 1, 0, 0, 0]
  const mods = new Uint8Array([0, 0, 1, 0, 0, 0]);
  const n = mods.length;

  // Pixel centered at m=2.0 (edge 0->1) with width 1.0 module -> [1.5, 2.5] -> 0.5 coverage
  const covEdge = sampleBarcodeIntegrated1D(mods, n, 2.0 / n, 1.0 / n, 1.0);
  assert.ok(Math.abs(covEdge - 0.5) < 1e-6, `covEdge=${covEdge}`);

  // Pixel centered at m=2.5 with width 0.5 module -> [2.25, 2.75] inside bar -> 1.0 coverage
  const covBar = sampleBarcodeIntegrated1D(mods, n, 2.5 / n, 0.5 / n, 1.0);
  assert.ok(Math.abs(covBar - 1.0) < 1e-6, `covBar=${covBar}`);

  // Print gain > 1 expands bar width symmetrically into neighboring space at m=2.0
  const covThick = sampleBarcodeIntegrated1D(mods, n, 2.0 / n, 1.0 / n, 1.2);
  assert.ok(Math.abs(covThick - 0.6) < 1e-6, `covThick=${covThick}`);
  const covThin = sampleBarcodeIntegrated1D(mods, n, 2.0 / n, 1.0 / n, 0.8);
  assert.ok(Math.abs(covThin - 0.4) < 1e-6, `covThin=${covThin}`);
});

test('createWallCells supports custom pitch/payloadFn while keeping defaults identical', () => {
  const defCells = createWallCells();
  assert.equal(defCells.length, 16);
  assert.equal(defCells[0].payload, 'TOTE-R1C1-000101');
  assert.equal(defCells[15].cx, 21);
  assert.equal(defCells[15].cy, -24);

  const norm = normalizeLabelSpec({ widthIn: 2, heightIn: 3.5, orientation: 'picket' });
  assert.equal(norm.scanLenIn, 2);
  assert.equal(norm.barSpanIn, 3.5);
  assert.equal(DEFAULT_LABEL_SPEC.quietModules, 10);

  const custom = createWallCells({
    cols: 2,
    rows: 2,
    pitchXIn: 16,
    pitchYIn: 14,
    label: { payloadFn: (r, c) => `CUSTOM-${r}-${c}` },
  });
  assert.equal(custom.length, 4);
  assert.equal(custom[0].cx, -8);
  assert.equal(custom[0].cy, 7);
  assert.equal(custom[0].payload, 'CUSTOM-0-0');
});

console.log(`All ${passed} L1 label tests passed.`);
