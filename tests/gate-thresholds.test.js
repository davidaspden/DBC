/**
 * G6 — per-profile thresholds and the `verify --gate` rules (`tools/gate/thresholds.mjs`,
 * `baseline/thresholds.json`). Pure checks on synthetic results; no simulation is run.
 * Run: node tests/gate-thresholds.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  loadThresholds, evaluateGate, selectGateScenarios, captureReferences, formatGateTable,
  CANARY_ONLY, CANARY_FLAGS,
} from '../tools/gate/thresholds.mjs';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const th = loadThresholds();
const MACHINE = 'test-machine';

// per-label times that add up to the reference sum (references keep only the sum, except the canary)
function evenTimes(ref) {
  const n = ref.decodedPayloads.length || 1;
  return Object.fromEntries(ref.decodedPayloads.map((p) => [p, ref.timeToFirstSumSec / n]));
}

// a result row shaped like `aggregateScenarioResults`, built from a reference
function fromRef(id, ref, over = {}) {
  const [runId] = id.split('@');
  return {
    id: runId, group: runId.startsWith('prof-') ? 'prof' : 'x', profile: ref.profile || 'ideal', flagSet: ref.flagSet,
    quickMode: true, fpGated: false,
    coverageMedian: ref.coverageMedian, totalCells: ref.totalCells,
    falsePositivesTotal: ref.falsePositivesTotal, timeToAllMedianSec: ref.timeToAllMedianSec,
    fpsDelivered: ref.fpsDelivered, deterministicHash: ref.deterministicHash,
    workerMs: { node: { p50: 3, p95: 5, max: 6 } }, heapBytesPerFrame: 1,
    ...(ref.camera ? { camera: { ...ref.camera } } : {}),
    seeds: [{ decodedPayloads: [...ref.decodedPayloads], timeToFirstByLabel: { ...(ref.timeToFirstByLabel || evenTimes(ref)) } }],
    ...over,
  };
}
function allFromRefs(over = {}) {
  return Object.entries(th.references).map(([k, ref]) => fromRef(k, ref, over[k] || {}));
}
const status = (ev, run, check) => ev.rows.find((r) => r.run === run && r.check.startsWith(check))?.status;

await test('G6 thresholds file: rules, floors and references are complete and reference real gate runs', () => {
  const ids = new Set(selectGateScenarios('quick').map((s) => s.runId || s.id));
  for (const key of Object.keys(th.references)) {
    assert.ok(ids.has(key.split('@')[0]), `reference ${key} is not a quick gate run`);
  }
  for (const id of ids) {
    const ref = th.references[`${id}@quick`];
    const flagsOnNoRef = /\[(W-fc|W-all)\]$/.test(id);
    assert.ok(ref || flagsOnNoRef, `no reference for gate run ${id}`);
    if (ref) {
      assert.notEqual(ref.coverageMedian, null);
      assert.ok(Array.isArray(ref.decodedPayloads));
    }
  }
  for (const f of th.floors) {
    assert.ok(['uncalibrated', 'report-only'].includes(f.status), `${f.id}: floors are uncalibrated or report-only until G7`);
    assert.ok(f.why && f.run && f.metric);
  }
  assert.equal(th.status, 'provisional');
  assert.equal(th.rules.flagsOn.p50TolerancePct['W-fc'], 20);
  assert.equal(th.rules.flagsOn.p50TolerancePct['W-all'], 30);
});

await test('G6 gate subset: quick = existing quick set + verticalMode canary + 5 profile rows; full is a superset of the profile rows', () => {
  const q = selectGateScenarios('quick');
  assert.equal(q.length, 12);
  assert.equal(q.filter((s) => s.group === 'prof').length, 5);
  const canary = q.filter((s) => s.presetId && (s.runId || s.id).includes(CANARY_FLAGS));
  assert.equal(canary.length, 1);
  assert.equal(canary[0].flags.id, CANARY_FLAGS);
  assert.ok((canary[0].runId || canary[0].id).startsWith(CANARY_ONLY));
  const f = selectGateScenarios('full');
  assert.ok(f.length > q.length);
  assert.equal(f.filter((s) => s.group === 'prof').length, 10, 'both flag sets per profile');
});

await test('G6 unchanged results pass; the capture round-trips to the same references', () => {
  const rows = allFromRefs();
  const ev = evaluateGate(rows, th, { machine: MACHINE });
  assert.equal(ev.ok, true, formatGateTable(ev));
  assert.equal(ev.warnings.length, 0);
  const cap = captureReferences(rows, { machine: MACHINE });
  for (const key of Object.keys(th.references)) {
    assert.equal(cap.references[key].coverageMedian, th.references[key].coverageMedian);
    assert.deepEqual(cap.references[key].decodedPayloads, th.references[key].decodedPayloads);
  }
});

await test('G6 flags off: lost coverage, a new false positive or slow time-to-first fails; a changed hash only warns', () => {
  const k = 'S01-a53-8-1080@quick';
  const ref = th.references[k];
  const lost = allFromRefs({ [k]: { coverageMedian: ref.coverageMedian - 1, seeds: [{ decodedPayloads: ref.decodedPayloads.slice(1), timeToFirstByLabel: {} }] } });
  assert.equal(evaluateGate(lost, th, { machine: MACHINE }).ok, false);
  const fp = allFromRefs({ [k]: { falsePositivesTotal: ref.falsePositivesTotal + 1 } });
  assert.equal(status(evaluateGate(fp, th, { machine: MACHINE }), 'S01-a53-8-1080', 'false positives'), 'FAIL');
  const slowTimes = Object.fromEntries(Object.entries(evenTimes(ref)).map(([p, t]) => [p, t * 1.3 + 0.2]));
  const slow = allFromRefs({ [k]: { seeds: [{ decodedPayloads: ref.decodedPayloads, timeToFirstByLabel: slowTimes }] } });
  assert.equal(status(evaluateGate(slow, th, { machine: MACHINE }), 'S01-a53-8-1080', 'time-to-first'), 'FAIL');
  const hash = allFromRefs({ [k]: { deterministicHash: 'deadbeef' } });
  const evh = evaluateGate(hash, th, { machine: MACHINE });
  assert.equal(evh.ok, true);
  assert.equal(evh.warnings.length, 1);
});

await test('G6 verticalMode canary: labels arriving later than the reference fail the gate (the scan-angle mutation case)', () => {
  const k = `${CANARY_ONLY}[${CANARY_FLAGS}]@quick`;
  const ref = th.references[k];
  assert.ok(ref && ref.timeToFirstByLabel, 'canary keeps per-label times');
  const delayed = Object.fromEntries(Object.entries(ref.timeToFirstByLabel).map(([p, t], i) => [p, i === 0 ? t : t + 0.3]));
  const ev = evaluateGate(allFromRefs({ [k]: { seeds: [{ decodedPayloads: ref.decodedPayloads, timeToFirstByLabel: delayed }] } }), th, { machine: MACHINE });
  assert.equal(ev.ok, false);
  assert.equal(status(ev, `${CANARY_ONLY}[${CANARY_FLAGS}]`, 'per-label'), 'FAIL');
  const early = Object.fromEntries(Object.entries(ref.timeToFirstByLabel).map(([p, t]) => [p, t * 0.5]));
  assert.equal(evaluateGate(allFromRefs({ [k]: { seeds: [{ decodedPayloads: ref.decodedPayloads, timeToFirstByLabel: early }] } }), th, { machine: MACHINE }).ok, true, 'earlier is fine');
});

await test('G6 flags on vs off (same run): not worse coverage, FP 0 on gated rows, time-to-all +5%, p50 +20% (W-fc) / +30% (W-all)', () => {
  const mk = (flagSet, over = {}) => ({
    id: `scn[${flagSet}]`, group: 'x', profile: 'ideal', flagSet, quickMode: false, fpGated: flagSet !== 'off',
    coverageMedian: 16, totalCells: 16, falsePositivesTotal: 0, timeToAllMedianSec: 10, fpsDelivered: 30,
    deterministicHash: 'h', workerMs: { node: { p50: 3, p95: 5, max: 6 } }, heapBytesPerFrame: 0,
    seeds: [{ decodedPayloads: [], timeToFirstByLabel: {} }], ...over,
  });
  const none = { ...th, references: {}, floors: [] };
  const ok = evaluateGate([mk('off'), mk('W-fc', { workerMs: { node: { p50: 3.5, p95: 5, max: 6 } } })], none, { machine: MACHINE });
  assert.equal(ok.ok, true, formatGateTable(ok));
  for (const [over, check] of [
    [{ coverageMedian: 15 }, 'coverage'],
    [{ falsePositivesTotal: 1 }, 'false positives'],
    [{ timeToAllMedianSec: 10.6 }, 'time-to-all'],
    [{ workerMs: { node: { p50: 4.3, p95: 5, max: 6 } } }, 'p50'],
  ]) {
    const ev = evaluateGate([mk('off'), mk('W-fc', over)], none, { machine: MACHINE });
    assert.equal(status(ev, 'scn[W-fc]', check), 'FAIL', check);
  }
  const wall = evaluateGate([mk('off'), mk('W-all', { workerMs: { node: { p50: 3.8, p95: 5, max: 6 } } })], none, { machine: MACHINE });
  assert.equal(wall.ok, true, 'W-all allows +30%: 3.8 ms vs 3 ms');
});

await test('G6 profile floors (uncalibrated): about 10 fps in low light, about 30 locked, ratio >= 2.5; any profile FP fails', () => {
  const rows = allFromRefs();
  assert.equal(evaluateGate(rows, th, { machine: MACHINE }).ok, true);
  const bad10 = allFromRefs({ 'prof-a53-fc-lowlight-10fps@quick': { camera: { cameraFps: 20, deliveredFps: 20, droppedFrames: 0 } } });
  const ev = evaluateGate(bad10, th, { machine: MACHINE });
  assert.equal(status(ev, 'prof-a53-fc-lowlight-10fps', 'floor fps-lowlight-10fps'), 'FAIL');
  const slowLocked = allFromRefs({ 'prof-a53-fc-lowlight-locked@quick': { camera: { cameraFps: 12, deliveredFps: 12, droppedFrames: 0 } } });
  const ev2 = evaluateGate(slowLocked, th, { machine: MACHINE });
  assert.equal(status(ev2, 'prof-a53-fc-lowlight-locked', 'floor fps-lowlight-locked'), 'FAIL');
  assert.equal(status(ev2, 'prof-a53-fc-lowlight-locked', 'floor locked-vs-10fps'), 'FAIL');
  const fp = allFromRefs({ 'prof-a53-torch-glare@quick': { falsePositivesTotal: 1 } });
  assert.equal(status(evaluateGate(fp, th, { machine: MACHINE }), 'prof-a53-torch-glare', 'profile false'), 'FAIL');
  assert.ok(evaluateGate(rows, th, { machine: MACHINE }).rows.every((r) => !/\[(uncalibrated)\]/.test(r.check) || r.status !== 'FAIL'));
});

await test('G6 timing is compared only against a same-machine baseline; without one it is skipped, not guessed', () => {
  const k = 'S01-a53-8-720@quick';
  const th2 = { ...th, timing: { [MACHINE]: { [k]: { p50: 2, p95: 3, heapBytesPerFrame: 1 } } } };
  const fine = evaluateGate(allFromRefs(), th2, { machine: MACHINE });
  assert.equal(status(fine, 'S01-a53-8-720', 'timing'), 'FAIL', 'p50 3 ms vs 2 ms baseline is +50%');
  const other = evaluateGate(allFromRefs(), th2, { machine: 'some-other-machine' });
  assert.equal(other.rows.some((r) => r.check.startsWith('timing')), false);
  assert.equal(other.ok, true);
});

await test('G6 verify.mjs wiring: --gate, --full and --gate-only are parsed; docs/gate.md exists', () => {
  const v = readFileSync(new URL('../tools/verify.mjs', import.meta.url), 'utf8');
  for (const s of ["'--gate'", "'--full'", "'--gate-only'", "'--capture-thresholds'", 'selectGateScenarios', 'evaluateGate']) {
    assert.ok(v.includes(s), `verify.mjs mentions ${s}`);
  }
  assert.ok(readFileSync(new URL('../docs/gate.md', import.meta.url), 'utf8').includes('verify.mjs --gate'));
});

console.log(`\nAll ${passed} G6 gate threshold tests passed.`);
