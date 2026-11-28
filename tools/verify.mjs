#!/usr/bin/env node
/**
 * GR2 — Automated Regression Verification Gate (`tools/verify.mjs`).
 *
 * Runs all test suites + the benchmark harness (with --expose-gc), parses metrics,
 * compares against `baseline/baseline-d917944.json`, prints a compact scorecard,
 * optionally runs `tools/replay.mjs` over any `.dbct` tapes in `tapes/`, and exits
 * non-zero on any regression beyond allowed thresholds.
 *
 * Usage:
 *   node tools/verify.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(ROOT, 'baseline', 'baseline-d917944.json');

const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));

function runNode(args) {
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

const rows = [];
let failed = false;

// 1. Run all unit test files under tests/*.test.js
const testFiles = readdirSync(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .sort();

for (const file of testFiles) {
  const r = runNode([join('tests', file)]);
  const m = r.stdout.match(/All\s+(\d+)\s+.*passed/i);
  const count = m ? Number(m[1]) : 0;
  const ok = r.status === 0 && count > 0;
  if (!ok) failed = true;
  rows.push({
    suite: `tests/${file}`,
    status: ok ? 'PASS' : 'FAIL',
    detail: ok ? `${count} tests passed` : (r.stderr || r.stdout).trim().split('\n').slice(-2).join(' | '),
  });
}

// 2. Run benchmark harness with --expose-gc and parse baseline comparison
const h = runNode(['--expose-gc', 'tests/harness.js', '--iters=25']);
const out = h.stdout;
const roiMatch = out.match(/Positives=(\d+)\/(\d+),\s*Angle<=3°=(\d+)\/(\d+)\s*\(maxErr=([\d.]+)°\),\s*NegativesClean=(\d+)\/(\d+)/);
const decMatch = out.match(/Decoded=(\d+)\/(\d+)\s*\(([\d.]+)%\),\s*FalsePositives=(\d+)\/(\d+)/);
const pipeTimeMatch = out.match(/Phase 3 — Full Pipeline Timings[\s\S]*?p50=([\d.]+)ms\s+p95=([\d.]+)ms\s+p99=([\d.]+)ms/);
const heapMatch = out.match(/Phase 3 — Full Pipeline Timings[\s\S]*?delta=(-?\d+)\s*B\s*\(([\d.-]+)\s*B\/frame\)/);

const hOk = h.status === 0 && roiMatch && decMatch && pipeTimeMatch && heapMatch;
if (!hOk) {
  failed = true;
  rows.push({
    suite: 'tests/harness.js',
    status: 'FAIL',
    detail: `Exit ${h.status} or unparseable output`,
  });
} else {
  const roiPos = Number(roiMatch[1]);
  const roiTot = Number(roiMatch[2]);
  const maxErr = Number(roiMatch[5]);
  const negClean = Number(roiMatch[6]);
  const decoded = Number(decMatch[1]);
  const decTot = Number(decMatch[2]);
  const fp = Number(decMatch[4]);
  const p50 = Number(pipeTimeMatch[1]);
  const p95 = Number(pipeTimeMatch[2]);
  const bpf = Number(heapMatch[2]);

  const b = baseline.harness;
  const t = baseline.thresholds;
  const p95Limit = Math.min(t.p95HardCeilingMs, Math.max(b.p95Ms * t.p95Multiplier, b.p95Ms + 0.5));

  const checks = [
    [roiPos >= b.roiPositives, `RoI ${roiPos}/${roiTot} < ${b.roiPositives}`],
    [negClean >= b.roiNegativesClean, `RoI neg clean ${negClean} < ${b.roiNegativesClean}`],
    [decoded >= b.decoded, `Decoded ${decoded}/${decTot} < ${b.decoded}`],
    [fp <= b.falsePositives, `False positives ${fp} > ${b.falsePositives}`],
    [p95 <= p95Limit, `p95 ${p95.toFixed(3)}ms > ${p95Limit.toFixed(3)}ms`],
    [bpf <= t.maxBytesPerFrame, `heap ${bpf.toFixed(2)} B/frame > ${t.maxBytesPerFrame} B/frame`],
  ];

  const errs = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
  if (errs.length > 0) failed = true;

  rows.push({
    suite: 'tests/harness.js (RoI)',
    status: roiPos >= b.roiPositives && negClean >= b.roiNegativesClean ? 'PASS' : 'FAIL',
    detail: `${roiPos}/${roiTot} pos, maxErr=${maxErr}deg, negClean=${negClean}/2`,
  });
  rows.push({
    suite: 'tests/harness.js (Pipe)',
    status: errs.length === 0 ? 'PASS' : 'FAIL',
    detail:
      errs.length === 0
        ? `${decoded}/${decTot} dec, ${fp} FP, p50=${p50.toFixed(2)}ms, p95=${p95.toFixed(2)}ms (base ${b.p95Ms}ms), ${bpf.toFixed(1)} B/f`
        : errs.join('; '),
  });
}

// 3. Optional replay of any golden .dbct tapes in tapes/
const tapesDir = join(ROOT, 'tapes');
const replayScript = join(ROOT, 'tools', 'replay.mjs');
if (existsSync(tapesDir) && existsSync(replayScript)) {
  const tapes = readdirSync(tapesDir).filter((f) => f.endsWith('.dbct')).sort();
  for (const tape of tapes) {
    const r = runNode([replayScript, join('tapes', tape)]);
    const ok = r.status === 0;
    if (!ok) failed = true;
    rows.push({
      suite: `replay:${tape}`,
      status: ok ? 'PASS' : 'FAIL',
      detail: (r.stdout || r.stderr).trim().split('\n').pop() || '',
    });
  }
}

console.log('\n=== DBC Verification Gate (vs baseline d917944) ===');
for (const r of rows) {
  console.log(`  [${r.status}]  ${r.suite.padEnd(28)} ${r.detail}`);
}
console.log(failed ? '\nVERIFICATION FAILED' : '\nALL VERIFICATION GATES PASSED');
process.exit(failed ? 1 : 0);
