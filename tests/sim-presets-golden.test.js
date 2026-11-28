/**
 * Golden Regression Tests for R4 Scene Model & Frozen Simulator Presets.
 *   node tests/sim-presets-golden.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScene, registerSimPlugin, getSimPlugins, clearSimPlugins } from '../src/sim/scene.js';
import {
  SIM_PRESETS,
  ORIGINAL_PRESET_IDS,
  FC_PRESET_IDS,
  getPreset,
  createSceneForPreset,
} from '../src/sim/presets.js';
import { encodeCode128B } from '../src/sim/label.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running R4 sim scene & golden preset unit tests...');

test('Default createScene matches legacy 4x4 14x16 in wall and 2x6 in 231-module labels', () => {
  const s = createScene();
  assert.equal(s.cols, 4);
  assert.equal(s.rows, 4);
  assert.equal(s.pitchXIn, 14);
  assert.equal(s.pitchYIn, 16);
  assert.equal(s.wallWidthIn, 56);
  assert.equal(s.wallHeightIn, 64);
  assert.equal(s.label.widthIn, 2);
  assert.equal(s.label.heightIn, 6);
  assert.equal(s.label.orientation, 'ladder');
  assert.equal(s.cells.length, 16);
  assert.equal(s.cells[0].payload, 'TOTE-R1C1-000101');
  assert.equal(encodeCode128B(s.cells[0].payload, s.label.quietModules).totalModules, 231);
  assert.equal(s.shadowStrength, 0.35);
  assert.equal(s.noiseStrength, 0.015);
  assert.equal(s.glareStrength, 0.16);
});

test('Golden preset values remain bit-for-bit identical across original, FC and snake-h-fast-step presets', () => {
  const GOLDEN = {
    'a53-8-720':        { fcMode: false, labelHeightIn: 6,   pathId: 'snake-h',           distanceIn: 10, hfovDeg: 70.7, speedInPerSec: 18, fpsCap: 13, shutterMs: 2,  jitter: 0.15, width: 1280, height: 720 },
    'a53-8-1080':       { fcMode: false, labelHeightIn: 6,   pathId: 'snake-h',           distanceIn: 12, hfovDeg: 70.7, speedInPerSec: 20, fpsCap: 13, shutterMs: 2,  jitter: 0.15, width: 1920, height: 1080 },
    'tele-30':          { fcMode: false, labelHeightIn: 6,   pathId: 'pan-snake',         distanceIn: 30, hfovDeg: 26,   speedInPerSec: 22, fpsCap: 30, shutterMs: 2,  jitter: 0.15, width: 1920, height: 1080 },
    'full-wall':        { fcMode: false, labelHeightIn: 6,   pathId: 'manual',            distanceIn: 52, hfovDeg: 70.7, speedInPerSec: 18, fpsCap: 30, shutterMs: 0,  jitter: 0,    width: 1920, height: 1080 },
    'fc-8-3p5':         { fcMode: true,  labelHeightIn: 3.5, pathId: 'snake-h',           distanceIn: 8,  hfovDeg: 70.7, speedInPerSec: 14, fpsCap: 13, shutterMs: 4,  jitter: 0.25, width: 1920, height: 1080 },
    'fc-12-3p5-auto':   { fcMode: true,  labelHeightIn: 3.5, pathId: 'snake-h',           distanceIn: 12, hfovDeg: 70.7, speedInPerSec: 14, fpsCap: 13, shutterMs: 16, jitter: 0.30, width: 1920, height: 1080 },
    'fc-tele-30-3p5':   { fcMode: true,  labelHeightIn: 3.5, pathId: 'pan-snake',         distanceIn: 30, hfovDeg: 26,   speedInPerSec: 18, fpsCap: 30, shutterMs: 4,  jitter: 0.25, width: 1920, height: 1080 },
    'fc-30-1x-fail':    { fcMode: true,  labelHeightIn: 3.5, pathId: 'pan-snake',         distanceIn: 30, hfovDeg: 70.7, speedInPerSec: 16, fpsCap: 13, shutterMs: 8,  jitter: 0.20, width: 1920, height: 1080 },
    'fc-jitter-hard':   { fcMode: true,  labelHeightIn: 3.5, pathId: 'snake-h',           distanceIn: 10, hfovDeg: 70.7, speedInPerSec: 16, fpsCap: 10, shutterMs: 8,  jitter: 0.65, width: 1920, height: 1080 },
    'snake-h-fast-step':{ fcMode: true,  labelHeightIn: 3.5, pathId: 'snake-h-fast-step', distanceIn: 12, hfovDeg: 70.7, speedInPerSec: 14, fpsCap: 13, shutterMs: 4,  jitter: 0.25, width: 1920, height: 1080 },
  };

  assert.deepEqual([...ORIGINAL_PRESET_IDS, ...FC_PRESET_IDS], Object.keys(GOLDEN));
  for (const [id, expected] of Object.entries(GOLDEN)) {
    const p = getPreset(id);
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(p[k], v, `${id}.${k}: expected ${v}, got ${p[k]}`);
    }
    const sc = createSceneForPreset(id);
    assert.equal(sc.fcMode, expected.fcMode);
    assert.equal(sc.label.heightIn, expected.labelHeightIn);
  }
  assert.deepEqual(SIM_PRESETS['full-wall'].manualPose, { x: 0, y: 0, z: 52, yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
});

test('SIM_PRESETS matches sim.html applyPreset() values verbatim', () => {
  const simHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'sim.html'), 'utf8');
  for (const id of [...ORIGINAL_PRESET_IDS, 'fc-8-3p5', 'fc-12-3p5-auto', 'fc-tele-30-3p5', 'fc-30-1x-fail', 'fc-jitter-hard']) {
    const preset = getPreset(id);
    const rx = new RegExp(`name === '${id}'[\\s\\S]*?(?=else if|rngJitter\\.value)`);
    const m = simHtml.match(rx);
    assert.ok(m, `Preset ${id} block not found in sim.html`);
    const block = m[0];
    assert.ok(block.includes(`state.pathId = '${preset.pathId}'`), `${id} pathId mismatch in sim.html`);
    assert.ok(block.includes(`state.distanceIn = ${preset.distanceIn}`), `${id} distanceIn mismatch in sim.html`);
    assert.ok(block.includes(`state.hfovDeg = ${preset.hfovDeg}`), `${id} hfovDeg mismatch in sim.html`);
    assert.ok(block.includes(`state.fpsCap = ${preset.fpsCap}`), `${id} fpsCap mismatch in sim.html`);
    assert.ok(block.includes(`state.shutterMs = ${preset.shutterMs}`), `${id} shutterMs mismatch in sim.html`);
    assert.ok(block.includes(`applyResolution('${preset.width}x${preset.height}')`), `${id} resolution mismatch in sim.html`);
  }
});

test('registerSimPlugin manages stream hooks cleanly', () => {
  clearSimPlugins();
  assert.equal(getSimPlugins().length, 0);
  const plugin = { id: 'test-plugin' };
  registerSimPlugin(plugin);
  assert.equal(getSimPlugins().length, 1);
  assert.equal(getSimPlugins()[0].id, 'test-plugin');
  clearSimPlugins();
});

console.log(`All ${passed} R4 sim-presets-golden tests passed.`);
