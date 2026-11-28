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
  evaluateQuickGate,
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
  assert.equal(quick.length, 6, 'quick mode should select 4 S01 presets + fc-tele-30-3p5 off & W-fc');
  const truncatedRuns = quick.filter((q) => q.truncated);
  assert.equal(truncatedRuns.length, 3, 'the 3 sweeping S01 presets are truncated at 10s');
  for (const q of quick) {
    assert.equal(q.quickMode, true);
    assert.equal(q.coverageGated, false, 'quick mode must never gate coverage');
    if (q.presetId === 'fc-tele-30-3p5') {
      assert.equal(q.truncated, false, 'fc-tele-30-3p5 must run full length in quick mode');
      assert.ok(q.durationSec > 10, `expected full-length duration > 10s, got ${q.durationSec}`);
      assert.equal(q.seeds.length, 2);
      assert.equal(q.fpGated, q.flags.id === 'W-fc');
    } else {
      assert.equal(q.seeds.length, 1);
      assert.ok(q.durationSec <= 10);
      assert.equal(q.flags.id, 'off');
      assert.equal(q.fpGated, false);
    }
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

await test('F6 quick mode labels 10s truncation, disables coverage gate, and fails if stopGuard is removed from fc-tele-30-3p5 W-fc', async () => {
  const quickSelected = selectScenarios({ quick: true });
  const wfcQuick = quickSelected.find((s) => s.presetId === 'fc-tele-30-3p5' && s.flags.id === 'W-fc');
  assert.ok(wfcQuick, 'expected fc-tele-30-3p5[W-fc] in quick mode');

  const truncZeroCov = {
    id: 'S01-a53-8-720',
    coverageMedian: 0,
    totalCells: 16,
    falsePositivesTotal: 0,
    coverageGated: false,
    fpGated: false,
    truncated: true,
    quickMode: true,
    durationSec: 10,
    profile: 'ideal',
    flagSet: 'off',
    seedCount: 1,
    timeToAllMedianSec: null,
    workerMs: { node: { p50: 1, p95: 2 }, a53Scaled: { p50: 8, p95: 16 } },
    fpsDelivered: 13,
    deterministicHash: '0123456789abcdef',
    seeds: [],
  };
  const zeroCovGate = evaluateQuickGate([truncZeroCov]);
  assert.equal(zeroCovGate.ok, true, 'quick mode must not fail on truncated 0/16 coverage');
  assert.ok(zeroCovGate.coverageGate.includes('disabled'));

  const tbl = formatTable([truncZeroCov], { quickMode: true });
  assert.ok(tbl.includes('truncated at 10s'));
  assert.ok(tbl.includes('10.0s*'));

  const rep = buildReport([truncZeroCov], { commit: 'test', machine: 'box', quickMode: true, truncatedAtSec: 10, gate: zeroCovGate });
  assert.equal(rep.quickMode, true);
  assert.equal(rep.truncatedAtSec, 10);
  assert.ok(rep.coverageGate.includes('disabled'));

  // Real check: fc-tele-30-3p5 full length with W-fc passes quick FP gate (0 FP),
  // whereas W-fc without stopGuard fails quick FP gate (FP > 0 on oblique tail).
  const wfcNoStopGuard = W_FC_FLAGS.filter((f) => f !== 'stopGuard');
  const [withStopGuard, withoutStopGuard] = await runScenarios([
    wfcQuick,
    createScenarioFromPreset('fc-tele-30-3p5', {
      id: 'fc-tele-30-3p5-no-stopguard',
      flagSet: { id: 'W-fc-no-stopGuard', worker: wfcNoStopGuard, page: [] },
      seeds: [1, 2],
      loops: 1,
      quickMode: true,
      truncated: false,
      truncatedAtSec: null,
      coverageGated: false,
      fpGated: true,
    }),
  ], { parallel: true });

  const passGate = evaluateQuickGate([withStopGuard]);
  assert.equal(passGate.ok, true, `expected 0 FP with stopGuard, got: ${passGate.failures.join('; ')}`);

  const failGate = evaluateQuickGate([withoutStopGuard]);
  assert.equal(failGate.ok, false, 'expected F6 quick gate to fail when stopGuard is removed from W-fc');
  assert.ok(withoutStopGuard.falsePositivesTotal > 0, `expected FP > 0 without stopGuard, got ${withoutStopGuard.falsePositivesTotal}`);
});

console.log(`All ${passed} G2 simgate tests passed.`);
