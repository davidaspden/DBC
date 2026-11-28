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
  generateFcTsxPayloads,
  createFcLabelPayloadFn,
  createFcLabelSpec,
} from '../src/sim/label.js';
import { createWallCells, computeOptics } from '../src/sim/paths.js';
import {
  SIM_PRESETS,
  createSceneForPreset,
  applySimFcLabel,
} from '../src/sim/presets.js';
import { renderFrame, createCpuRenderContext } from '../src/sim/cpu-render.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
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

test('L2 simFcLabel generates 16 unique 11-char tsX payloads (176 modules) with seeded printGain +/-5%', () => {
  const payloadsA = generateFcTsxPayloads(16, 42);
  const payloadsB = generateFcTsxPayloads(16, 42);
  const payloadsC = generateFcTsxPayloads(16, 43);

  assert.deepEqual(payloadsA, payloadsB, 'same seed must be deterministic');
  assert.notDeepEqual(payloadsA, payloadsC, 'distinct seeds must produce distinct payloads');
  assert.equal(new Set(payloadsA).size, 16, 'all 16 payloads must be unique');

  const pattern = /^tsX\d{2}[0-9a-z]{6}$/;
  for (const p of payloadsA) {
    assert.ok(p.startsWith('tsX'), `must start with tsX: ${p}`);
    assert.equal(p.length, 11, `must be 11 chars: ${p}`);
    assert.match(p, pattern, `must match tsX + 2 digits + 6 base36 lowercase chars: ${p}`);
    const enc = encodeCode128B(p, 10);
    assert.equal(enc.totalModules, 176, `expected 176 modules for ${p}`);
  }

  const specA = createFcLabelSpec({ seed: 101 });
  const specB = createFcLabelSpec({ seed: 101 });
  const specC = createFcLabelSpec({ seed: 202 });
  assert.equal(specA.widthIn, 2.0);
  assert.equal(specA.heightIn, 3.5);
  assert.equal(specA.orientation, 'ladder');
  assert.equal(specA.quietModules, 10);
  assert.ok(specA.printGain >= 0.95 && specA.printGain <= 1.05, `printGain out of +/-5% range: ${specA.printGain}`);
  assert.equal(specA.printGain, specB.printGain);
  assert.notEqual(specA.printGain, specC.printGain);

  const fn = createFcLabelPayloadFn({ seed: 42 });
  assert.equal(fn(0, 0, 0), payloadsA[0]);
  assert.equal(fn(3, 3, 15), payloadsA[15]);
});

test('L2 applySimFcLabel leaves presets/scenes unchanged when flag off and decodes all 16 cells when flag on', () => {
  // Flag off: existing 16-char and 12-char scenes and frozen presets stay bit-for-bit unchanged
  const baseLegacy = createSceneForPreset('a53-8-720');
  const offLegacy = applySimFcLabel(baseLegacy, { seed: 7, simFcLabel: false });
  assert.strictEqual(offLegacy, baseLegacy);
  assert.equal(offLegacy.cells[0].payload, 'TOTE-R1C1-000101');
  assert.equal(offLegacy.label.heightIn, 6);

  const baseFc12 = createSceneForPreset('fc-8-3p5');
  const offFc12 = applySimFcLabel(baseFc12, { seed: 7, simFcLabel: false });
  assert.strictEqual(offFc12, baseFc12);
  assert.equal(offFc12.cells[0].payload, 'tsX11A00001B');
  assert.equal(offFc12.cells[0].payload.length, 12);

  // Preset object stays frozen and untouched
  const presetOff = applySimFcLabel(SIM_PRESETS['fc-8-3p5'], { seed: 7, simFcLabel: false });
  assert.strictEqual(presetOff, SIM_PRESETS['fc-8-3p5']);
  const presetOn = applySimFcLabel(SIM_PRESETS['a53-8-720'], { seed: 7, simFcLabel: true });
  assert.notStrictEqual(presetOn, SIM_PRESETS['a53-8-720']);
  assert.equal(SIM_PRESETS['a53-8-720'].labelHeightIn, 6);
  assert.equal(presetOn.labelHeightIn, 3.5);
  assert.equal(presetOn.fcMode, true);

  // Flag on: all 16 cells render via CPU renderer and decode via processFrameMulti
  const fcScene = applySimFcLabel(baseFc12, { seed: 7, simFcLabel: true });
  assert.equal(fcScene.cells.length, 16);
  const expectedSet = new Set(fcScene.cells.map((c) => c.payload));
  assert.equal(expectedSet.size, 16);
  for (const p of expectedSet) {
    assert.ok(p.startsWith('tsX') && p.length === 11);
  }

  const width = 1280;
  const height = 720;
  const out = new Uint8Array(width * height);
  const ctx = createCpuRenderContext();
  const state = createPipelineState(width, height);
  state.flags = 0;
  const result = createPipelineResult();

  const decodedSet = new Set();
  let fp = 0;
  for (const cell of fcScene.cells) {
    const pose = { x: cell.cx, y: cell.cy, z: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    renderFrame(fcScene, [pose], { width, height, hfovDeg: 70.7, seed: cell.index + 1, ctx }, out);
    processFrameMulti(out, width, height, state, result, false);
    const dets = extractMultiDetections(state);
    for (const d of dets) {
      if (expectedSet.has(d.payload)) decodedSet.add(d.payload);
      else fp++;
    }
  }
  assert.equal(fp, 0, `unexpected false positives: ${fp}`);
  assert.equal(decodedSet.size, 16, `expected 16/16 FC tsX cells decoded, got ${decodedSet.size}`);
});

console.log(`All ${passed} L1/L2 label tests passed.`);
