/**
 * G2 — SimGate Scenario Runner Unit & Determinism Tests (`tests/simgate.test.js`).
 *   node tests/simgate.test.js
 */

import assert from 'node:assert/strict';
import {
  buildWave1Scenarios,
  selectScenarios,
  createScenarioFromPreset,
  resolveFlagSet,
  W_FC_FLAGS,
  W_ALL_FLAGS,
} from '../tools/gate/scenarios.mjs';
import {
  runScenarioSeed,
  runScenarios,
  stripVolatileMetrics,
} from '../tools/gate/score.mjs';
import { buildReport, formatTable } from '../tools/gate/report.mjs';
import { parseCliArgs } from '../tools/simgate.mjs';
import { FLAG_REQUIRE_PREFIX_STRICT } from '../src/worker/flagbits.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running G2 simgate scenario runner tests...');

await test('flag sets off, W-fc, W-all, strict, single:<flag> resolve per spec 10.1', () => {
  const off = resolveFlagSet('off');
  assert.equal(off.workerMask, 0);
  assert.equal(off.worker.length, 0);

  const wfc = resolveFlagSet('W-fc');
  assert.deepEqual(wfc.worker, [...W_FC_FLAGS]);
  assert.notEqual(wfc.workerMask, 0);
  assert.equal(wfc.workerMask & FLAG_REQUIRE_PREFIX_STRICT, 0);

  const wall = resolveFlagSet('W-all');
  assert.deepEqual(wall.worker, [...W_ALL_FLAGS]);
  assert.equal(wall.workerMask & FLAG_REQUIRE_PREFIX_STRICT, 0, 'W-all must exclude requirePrefixStrict');
  assert.ok(wall.worker.length >= 12);

  const strict = resolveFlagSet('strict');
  assert.notEqual(strict.workerMask & FLAG_REQUIRE_PREFIX_STRICT, 0);

  const single = resolveFlagSet('single:cribMatch');
  assert.deepEqual(single.worker, ['cribMatch']);
  assert.notEqual(single.workerMask, 0);
});

await test('Wave 1 scenarios cover ideal profile, 4 original presets, FC presets and snake-h-fast-step', () => {
  const all = buildWave1Scenarios();
  assert.ok(all.length >= 14, `expected >= 14 scenarios, got ${all.length}`);
  for (const sc of all) {
    assert.equal(sc.profile, 'ideal');
    assert.equal(sc.fidelityStatus, 'uncalibrated');
  }
  const presetIds = new Set(all.map((s) => s.presetId));
  for (const req of [
    'a53-8-720', 'a53-8-1080', 'tele-30', 'full-wall',
    'fc-8-3p5', 'fc-12-3p5-auto', 'fc-tele-30-3p5', 'fc-30-1x-fail',
    'fc-jitter-hard', 'snake-h-fast-step',
  ]) {
    assert.ok(presetIds.has(req), `missing Wave 1 preset ${req}`);
  }

  const quick = selectScenarios({ quick: true });
  assert.equal(quick.length, 4, 'quick mode should select the 4 S01 original presets');
  for (const q of quick) {
    assert.equal(q.seeds.length, 1);
    assert.ok(q.durationSec <= 10);
    assert.equal(q.flags.id, 'off');
  }

  const parsed = parseCliArgs(['--only', 'S01', '--seeds', '3', '--quick', '--flags=W-fc']);
  assert.equal(parsed.only, 'S01');
  assert.equal(parsed.seeds, 3);
  assert.equal(parsed.quick, true);
  assert.equal(parsed.flags, 'W-fc');
});

await test('3-second scenario run twice produces byte-identical deterministic results', async () => {
  const sc = createScenarioFromPreset('a53-8-720', {
    id: 'det-3s',
    durationSec: 3.0,
    seeds: [1],
    flagSet: 'off',
  });

  const [r1] = await runScenarios([sc], { parallel: false });
  const [r2] = await runScenarios([sc], { parallel: false });

  assert.ok(r1.coverageMedian >= 2, `expected >= 2 cells decoded in 3s sweep, got ${r1.coverageMedian}`);
  assert.equal(r1.falsePositivesTotal, 0);
  assert.equal(r1.deterministicHash, r2.deterministicHash);

  const j1 = JSON.stringify(stripVolatileMetrics(buildReport([r1], { commit: 'test', machine: 'box' })));
  const j2 = JSON.stringify(stripVolatileMetrics(buildReport([r2], { commit: 'test', machine: 'box' })));
  assert.equal(j1, j2, 're-running scenario must yield byte-identical deterministic JSON');
});

await test('parallel worker_threads execution matches single-threaded execution identically', async () => {
  const sc = createScenarioFromPreset('a53-8-720', {
    id: 'par-check',
    durationSec: 1.5,
    seeds: [1, 2],
    flagSet: 'off',
  });

  const [seq] = await runScenarios([sc], { parallel: false });
  const [par] = await runScenarios([sc], { parallel: true, jobs: 2 });

  assert.equal(par.deterministicHash, seq.deterministicHash);
  assert.deepEqual(stripVolatileMetrics(par), stripVolatileMetrics(seq));
});

await test('false positive detector flags decodes outside expectedPayloads', () => {
  const sc = createScenarioFromPreset('a53-8-720', {
    id: 'fp-check',
    durationSec: 1.5,
    seeds: [1],
    flagSet: 'off',
    // Deliberately wrong expected set so every valid decode is caught as an FP
    expectedPayloads: ['BOGUS-WRONG-0001', 'BOGUS-WRONG-0002'],
  });

  const res = runScenarioSeed(sc, 1);
  assert.ok(res.falsePositives > 0, `expected FP > 0 with wrong expected set, got ${res.falsePositives}`);
  assert.equal(res.decodedCount, 0);
  assert.ok(res.falsePositivePayloads.length === res.falsePositives);
});

await test('report table formats cleanly with raw and A53-scaled metrics', async () => {
  const sc = createScenarioFromPreset('a53-8-720', {
    id: 'tbl-check',
    durationSec: 0.5,
    seeds: [1],
    flagSet: 'W-fc',
  });
  const [res] = await runScenarios([sc], { parallel: false });
  const tbl = formatTable([res]);
  assert.ok(tbl.includes('tbl-check'));
  assert.ok(tbl.includes('W-fc'));
  assert.ok(tbl.includes('ideal'));
});

console.log(`All ${passed} G2 simgate tests passed.`);
