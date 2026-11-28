/**
 * F5 — Deduplication & Parameterised Default Unit Tests (`tests/refactor-f5.test.js`).
 *   node tests/refactor-f5.test.js
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeCode128Modules as configComputeCode128Modules } from '../src/array/config.js';
import { computeCode128Modules as labelComputeCode128Modules, mulberry32 as labelMulberry32 } from '../src/sim/label.js';
import { mulberry32 as prngMulberry32 } from '../src/sim/prng.js';
import { mulberry32 as cpuMulberry32 } from '../src/sim/cpu-render.js';
import { estimateModules, pxPerModule } from '../src/array/optics.js';
import { computeMaxSafeSpeedInPerSec } from '../src/capture/exposure.js';
import { formatLabelSizeOpticsSummary } from '../src/diag/decode-test.js';
import { median, percentile, percentileSorted } from '../src/util/stats.js';
import { median as abMedian } from '../tools/gate/ab.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '../src');

function collectJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectJsFiles(full, out);
    else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
      out.push(full);
    }
  }
  return out;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running F5 refactor deduplication & parameterisation tests...');

test('static source scan: single canonical computeCode128Modules and mulberry32 under src/', () => {
  const files = collectJsFiles(SRC_DIR);
  const c128Defs = [];
  const rngDefs = [];
  const medianDefs = [];
  const pctDefs = [];

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    const rel = path.relative(SRC_DIR, f).replace(/\\/g, '/');
    if (/\bfunction\s+computeCode128Modules\s*\(/.test(text)) c128Defs.push(rel);
    if (/\bfunction\s+mulberry32\s*\(/.test(text)) rngDefs.push(rel);
    if (/\bfunction\s+median\s*\(/.test(text)) medianDefs.push(rel);
    if (/\bfunction\s+percentile\s*\(/.test(text)) pctDefs.push(rel);
  }

  assert.deepEqual(c128Defs, ['array/config.js'], `expected single computeCode128Modules definition, found: ${c128Defs.join(', ')}`);
  assert.deepEqual(rngDefs, ['sim/prng.js'], `expected single mulberry32 definition, found: ${rngDefs.join(', ')}`);
  assert.deepEqual(medianDefs, ['util/stats.js'], `expected single median definition, found: ${medianDefs.join(', ')}`);
  assert.deepEqual(pctDefs, ['util/stats.js'], `expected single percentile definition, found: ${pctDefs.join(', ')}`);
});

test('re-exports preserve exact function identity for backwards compatibility', () => {
  assert.strictEqual(labelComputeCode128Modules, configComputeCode128Modules);
  assert.strictEqual(labelMulberry32, prngMulberry32);
  assert.strictEqual(cpuMulberry32, prngMulberry32);
  assert.strictEqual(abMedian, median);
});

test('src/array/optics.js preserves 12-char / 187-mod defaults and accepts 11-char / tsX07wz7py1 (176 mods)', () => {
  assert.equal(estimateModules(), 187);
  assert.equal(estimateModules(12), 187);
  assert.equal(estimateModules(11), 176);
  assert.equal(estimateModules('tsX07wz7py1'), 176);

  const ppmDefault = pxPerModule({ distanceIn: 12, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, labelLenIn: 3.5 });
  const ppmExplicit187 = pxPerModule({ distanceIn: 12, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, labelLenIn: 3.5, modules: 187 });
  assert.equal(ppmDefault, ppmExplicit187);

  const ppmExplicit176 = pxPerModule({ distanceIn: 12, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, labelLenIn: 3.5, modules: 176 });
  const ppmByChars = pxPerModule({ distanceIn: 12, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, labelLenIn: 3.5, payloadChars: 11 });
  const ppmByPayload = pxPerModule({ distanceIn: 12, hfovDeg: 70.7, widthPx: 1920, heightPx: 1080, labelLenIn: 3.5, payload: 'tsX07wz7py1' });
  assert.equal(ppmByChars, ppmExplicit176);
  assert.equal(ppmByPayload, ppmExplicit176);
  assert.ok(ppmByPayload > ppmDefault, '176-module label should have higher PPM than 187-module label');
});

test('src/capture/exposure.js preserves 12-char / 187-mod defaults and accepts 11-char / tsX07wz7py1 (176 mods)', () => {
  const vDefault = computeMaxSafeSpeedInPerSec({ exposureSec: 1 / 500 });
  const vExplicit187 = computeMaxSafeSpeedInPerSec({ exposureSec: 1 / 500, modules: 187 });
  assert.equal(vDefault, vExplicit187);

  const vExplicit176 = computeMaxSafeSpeedInPerSec({ exposureSec: 1 / 500, modules: 176 });
  const vByChars = computeMaxSafeSpeedInPerSec({ exposureSec: 1 / 500, payloadChars: 11 });
  const vByPayload = computeMaxSafeSpeedInPerSec({ exposureSec: 1 / 500, payload: 'tsX07wz7py1' });
  assert.equal(vByChars, vExplicit176);
  assert.equal(vByPayload, vExplicit176);
  assert.ok(vByPayload > vDefault, '176-module label should allow slightly higher safe scan speed than 187-module label');
});

test('src/diag/decode-test.js formatLabelSizeOpticsSummary preserves 12-char / 187-mod defaults and accepts 11-char / tsX07wz7py1', () => {
  const defSum = formatLabelSizeOpticsSummary();
  assert.equal(defSum.payloadChars, 12);
  assert.equal(defSum.modules, 187);

  const sumByChars = formatLabelSizeOpticsSummary({ payloadChars: 11 });
  assert.equal(sumByChars.payloadChars, 11);
  assert.equal(sumByChars.modules, 176);

  const sumByPayload = formatLabelSizeOpticsSummary({ payload: 'tsX07wz7py1' });
  assert.equal(sumByPayload.payloadChars, 11);
  assert.equal(sumByPayload.modules, 176);
  assert.equal(sumByPayload.ppm8, sumByChars.ppm8);
  assert.equal(sumByPayload.ppm16, sumByChars.ppm16);
  assert.ok(sumByPayload.ppm8 > defSum.ppm8);
});

test('src/util/stats.js median, percentile and percentileSorted exact unit tests', () => {
  assert.equal(median([]), 0);
  assert.equal(median([42]), 42);
  assert.equal(median([5, 1, 9]), 5);
  assert.equal(median([10, 2, 4, 8]), 6);

  const unsorted = [30, 10, 50, 20, 40];
  assert.equal(median(unsorted), 30);
  assert.deepEqual(unsorted, [30, 10, 50, 20, 40], 'median must not mutate input');

  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentileSorted([], 0.95), 0);
  const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentileSorted(sorted, 0), 1);
  assert.equal(percentileSorted(sorted, 0.5), 5);
  assert.equal(percentileSorted(sorted, 0.95), 9);
  assert.equal(percentileSorted(sorted, 1), 10);

  assert.equal(percentile(sorted, 0.95), 9);
  const shuffled = [9, 1, 7, 3, 10, 2, 8, 4, 6, 5];
  assert.equal(percentile(shuffled, 0.95), 9);
  assert.deepEqual(shuffled, [9, 1, 7, 3, 10, 2, 8, 4, 6, 5], 'percentile must not mutate input');

  // TypedArray support
  const f32 = new Float32Array([4, 1, 3, 2]);
  assert.equal(median(f32), 2.5);
  assert.equal(percentile(f32, 0.5), 2);
});

console.log(`All ${passed} F5 refactor tests passed.`);
