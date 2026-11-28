/**
 * Unit tests for G1 Same-Machine Interleaved A/B Verification (`tools/gate/ab.mjs`).
 *   node tests/verify-ab.test.js
 */

import assert from 'node:assert/strict';
import {
  median,
  parseHarnessOutput,
  aggregateHarnessRuns,
  compareAbMetrics,
} from '../tools/gate/ab.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running G1 A/B verification comparison math unit tests...');

function makeRun(overrides = {}) {
  return {
    roiPos: 14,
    roiTot: 14,
    maxErr: 0.68,
    negClean: 2,
    decoded: 14,
    decTot: 14,
    fp: 0,
    p50: 0.80,
    p95: 1.00,
    p99: 1.15,
    heapDelta: 12000,
    bpf: 16.0,
    ...overrides,
  };
}

test('median and parseHarnessOutput compute exact summary numbers', () => {
  assert.equal(median([5, 1, 9]), 5);
  assert.equal(median([10, 2, 4, 8]), 6);

  const sample = `
Phase 2 Summary: Positives=14/14, Angle<=3°=14/14 (maxErr=0.68°), NegativesClean=2/2
Phase 3 Summary: Decoded=14/14 (100.0%), FalsePositives=0/2
Phase 3 — Full Pipeline Timings:
  mean=0.81ms p50=0.77ms p95=1.06ms p99=1.18ms delta=14240 B (17.80 B/frame)
`;
  const parsed = parseHarnessOutput(sample);
  assert.ok(parsed);
  assert.equal(parsed.roiPos, 14);
  assert.equal(parsed.negClean, 2);
  assert.equal(parsed.decoded, 14);
  assert.equal(parsed.fp, 0);
  assert.equal(parsed.p50, 0.77);
  assert.equal(parsed.p95, 1.06);
  assert.equal(parsed.bpf, 17.8);
});

test('compareAbMetrics passes when HEAD is equal or within +10% p50 / +25% p95 / +4 B/f', () => {
  const baseAgg = aggregateHarnessRuns([
    makeRun({ p50: 0.80, p95: 1.00, bpf: 16.0 }),
    makeRun({ p50: 0.82, p95: 1.04, bpf: 16.5 }),
    makeRun({ p50: 0.78, p95: 0.98, bpf: 15.8 }),
  ]);
  const headAgg = aggregateHarnessRuns([
    makeRun({ p50: 0.85, p95: 1.18, bpf: 17.8 }),
    makeRun({ p50: 0.86, p95: 1.20, bpf: 18.0 }),
    makeRun({ p50: 0.84, p95: 1.15, bpf: 17.5 }),
  ]);
  const cmp = compareAbMetrics(baseAgg, headAgg);
  assert.equal(cmp.ok, true, `unexpected errors: ${cmp.errors.join('; ')}`);
  assert.equal(cmp.errors.length, 0);
});

test('compareAbMetrics rejects p50 regression (+15%), p95 regression (+30%), and heap regression', () => {
  const base = aggregateHarnessRuns([makeRun({ p50: 0.80, p95: 1.00, bpf: 16.0 })]);

  const slowP50 = compareAbMetrics(base, aggregateHarnessRuns([makeRun({ p50: 0.92, p95: 1.10 })]));
  assert.equal(slowP50.ok, false);
  assert.ok(slowP50.errors.some((e) => e.includes('p50')));

  const slowP95 = compareAbMetrics(base, aggregateHarnessRuns([makeRun({ p50: 0.82, p95: 1.30 })]));
  assert.equal(slowP95.ok, false);
  assert.ok(slowP95.errors.some((e) => e.includes('p95')));

  const leaky = compareAbMetrics(base, aggregateHarnessRuns([makeRun({ bpf: 36.0 })]));
  assert.equal(leaky.ok, false);
  assert.ok(leaky.errors.some((e) => e.includes('heap')));
});

test('compareAbMetrics rejects decoded accuracy drop, RoI drop, and any new false positive', () => {
  const base = aggregateHarnessRuns([makeRun()]);

  const decDrop = compareAbMetrics(base, aggregateHarnessRuns([makeRun({ decoded: 13 })]));
  assert.equal(decDrop.ok, false);
  assert.ok(decDrop.errors.some((e) => e.includes('Decoded')));

  const roiDrop = compareAbMetrics(base, aggregateHarnessRuns([makeRun({ roiPos: 13 })]));
  assert.equal(roiDrop.ok, false);
  assert.ok(roiDrop.errors.some((e) => e.includes('RoI positives')));

  const newFp = compareAbMetrics(base, aggregateHarnessRuns([makeRun({ fp: 1 })]));
  assert.equal(newFp.ok, false);
  assert.ok(newFp.errors.some((e) => e.includes('False positives')));
});

console.log(`All ${passed} G1 verify-ab tests passed.`);
