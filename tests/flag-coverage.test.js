/**
 * G5 — Feature-Flag Coverage Matrix Guardrail Test (`tests/flag-coverage.test.js`).
 *   node tests/flag-coverage.test.js
 *
 * Fails if any flag in `src/flags.js` (`FLAG_DEFS`) or `src/sim/simflags.js` (`SIM_FLAG_DEFS`)
 * is unmapped, or if any mapped scenario ID or existing test file/name vanished.
 */

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLAG_DEFS } from '../src/flags.js';
import { SIM_FLAG_DEFS } from '../src/sim/simflags.js';
import {
  FLAG_COVERAGE_MAP,
  PRODUCT_FLAG_COVERAGE,
  SIM_FLAG_COVERAGE,
  validateFlagCoverage,
} from '../tools/gate/coverage-map.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running G5 feature-flag coverage matrix tests...');

test('every product flag (FLAG_DEFS) and sim/AR flag (SIM_FLAG_DEFS) has a valid coverage entry', () => {
  const res = validateFlagCoverage({ rootDir: ROOT });
  assert.equal(res.ok, true, `Flag coverage errors:\n  - ${res.errors.join('\n  - ')}`);
  assert.equal(res.stats.productCount, FLAG_DEFS.length);
  assert.equal(res.stats.simCount, SIM_FLAG_DEFS.length);
  assert.equal(Object.keys(PRODUCT_FLAG_COVERAGE).length, FLAG_DEFS.length);
  assert.equal(Object.keys(SIM_FLAG_COVERAGE).length, SIM_FLAG_DEFS.length);
  assert.ok(res.stats.scenarioCovered >= 12, `expected >= 12 worker flags covered by SimGate scenarios, got ${res.stats.scenarioCovered}`);
  assert.equal(res.stats.testCovered, FLAG_DEFS.length + SIM_FLAG_DEFS.length);
});

test('adding an unmapped flag to FLAG_DEFS or SIM_FLAG_DEFS fails validation', () => {
  const resProd = validateFlagCoverage({
    rootDir: ROOT,
    productFlags: [...FLAG_DEFS, { name: 'unmappedNewFlag', bit: null, default: false }],
  });
  assert.equal(resProd.ok, false);
  assert.ok(resProd.errors.some((e) => e.includes('unmappedNewFlag')));

  const resSim = validateFlagCoverage({
    rootDir: ROOT,
    simFlags: [...SIM_FLAG_DEFS, { name: 'unmappedSimKnob', default: false }],
  });
  assert.equal(resSim.ok, false);
  assert.ok(resSim.errors.some((e) => e.includes('unmappedSimKnob')));
});

test('a vanished scenario ID or vanished test file/name fails validation', () => {
  const badScenarioMap = {
    ...FLAG_COVERAGE_MAP,
    vertFallback: {
      ...FLAG_COVERAGE_MAP.vertFallback,
      scenarios: ['S99-does-not-exist'],
    },
  };
  const r1 = validateFlagCoverage({ rootDir: ROOT, coverageMap: badScenarioMap });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.includes('S99-does-not-exist')));

  const badTestFileMap = {
    ...FLAG_COVERAGE_MAP,
    tapeRecord: {
      ...FLAG_COVERAGE_MAP.tapeRecord,
      tests: [{ file: 'tests/nonexistent-vanished.test.js' }],
    },
  };
  const r2 = validateFlagCoverage({ rootDir: ROOT, coverageMap: badTestFileMap });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.includes('nonexistent-vanished.test.js')));

  const badTestNameMap = {
    ...FLAG_COVERAGE_MAP,
    tapeRecord: {
      ...FLAG_COVERAGE_MAP.tapeRecord,
      tests: [{ file: 'tests/tape.test.js', testName: 'this test name does not exist' }],
    },
  };
  const r3 = validateFlagCoverage({ rootDir: ROOT, coverageMap: badTestNameMap });
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => e.includes('this test name does not exist')));
});

test('orphan map entries not present in FLAG_DEFS or SIM_FLAG_DEFS fail validation', () => {
  const orphanMap = {
    ...FLAG_COVERAGE_MAP,
    deletedLegacyFlag: {
      registry: 'product',
      scenarios: [],
      tests: [{ file: 'tests/flags.test.js' }],
      reason: 'Should trigger orphan error.',
    },
  };
  const res = validateFlagCoverage({ rootDir: ROOT, coverageMap: orphanMap });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('deletedLegacyFlag')));
});

console.log(`All ${passed} G5 flag-coverage tests passed.`);
