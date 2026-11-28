#!/usr/bin/env node
/**
 * GR2 / G1 — Automated Regression Verification Gate (`tools/verify.mjs`).
 *
 * Default mode (G1): extracts `--base <rev>` (default `HEAD~1`) via `git archive`
 * into a temporary directory, runs all unit suites on HEAD, runs `tests/harness.js`
 * interleaved N times (`--runs 5`, alternating order) on both HEAD and BASE on this
 * machine, optionally replays `.dbct` tapes in `tapes/`, prints one scorecard, and
 * exits non-zero on any regression.
 *
 * Usage:
 *   node tools/verify.mjs                          # Same-machine A/B vs HEAD~1 (N=5)
 *   node tools/verify.mjs --base d917944 --runs 3  # Same-machine A/B vs specific commit
 *   node tools/verify.mjs --legacy-json            # Historical comparison vs baseline JSON
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseHarnessOutput,
  aggregateHarnessRuns,
  compareAbMetrics,
  resolveBaseRevision,
  extractGitRefToDir,
  formatAbSummary,
} from './gate/ab.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_BASELINE_PATH = join(ROOT, 'baseline', 'baseline-d917944.json');

function parseCliArgs(argv) {
  const opts = {
    legacyJson: false,
    baseRev: 'HEAD~1',
    runs: 5,
    iters: 25,
    gate: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--legacy-json') opts.legacyJson = true;
    else if (a === '--gate') opts.gate = true;
    else if (a === '--base' && argv[i + 1]) opts.baseRev = argv[++i];
    else if (a.startsWith('--base=')) opts.baseRev = a.slice('--base='.length);
    else if (a === '--runs' && argv[i + 1]) opts.runs = Math.max(1, Number(argv[++i]) | 0);
    else if (a.startsWith('--runs=')) opts.runs = Math.max(1, Number(a.slice('--runs='.length)) | 0);
    else if (a === '--iters' && argv[i + 1]) opts.iters = Math.max(1, Number(argv[++i]) | 0);
    else if (a.startsWith('--iters=')) opts.iters = Math.max(1, Number(a.slice('--iters='.length)) | 0);
  }
  return opts;
}

function runNode(args, cwd = ROOT) {
  const res = spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 90000,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

const cli = parseCliArgs(process.argv.slice(2));
const rows = [];
let failed = false;

// 1. Run all unit test files under tests/*.test.js in HEAD
const testFiles = readdirSync(join(ROOT, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .sort();

for (const file of testFiles) {
  const r = runNode([join('tests', file)], ROOT);
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

// 2. Benchmark harness: either legacy JSON mode or same-machine interleaved A/B mode
if (cli.legacyJson) {
  const baseline = JSON.parse(readFileSync(LEGACY_BASELINE_PATH, 'utf8'));
  const h = runNode(['--expose-gc', 'tests/harness.js', `--iters=${cli.iters}`], ROOT);
  const parsed = h.status === 0 ? parseHarnessOutput(h.stdout) : null;
  if (!parsed) {
    failed = true;
    rows.push({
      suite: 'tests/harness.js',
      status: 'FAIL',
      detail: `Exit ${h.status} or unparseable output`,
    });
  } else {
    const b = baseline.harness;
    const t = baseline.thresholds;
    const p95Limit = Math.min(t.p95HardCeilingMs, Math.max(b.p95Ms * t.p95Multiplier, b.p95Ms + 0.5));
    const checks = [
      [parsed.roiPos >= b.roiPositives, `RoI ${parsed.roiPos}/${parsed.roiTot} < ${b.roiPositives}`],
      [parsed.negClean >= b.roiNegativesClean, `RoI neg clean ${parsed.negClean} < ${b.roiNegativesClean}`],
      [parsed.decoded >= b.decoded, `Decoded ${parsed.decoded}/${parsed.decTot} < ${b.decoded}`],
      [parsed.fp <= b.falsePositives, `False positives ${parsed.fp} > ${b.falsePositives}`],
      [parsed.p95 <= p95Limit, `p95 ${parsed.p95.toFixed(3)}ms > ${p95Limit.toFixed(3)}ms`],
      [parsed.bpf <= t.maxBytesPerFrame, `heap ${parsed.bpf.toFixed(2)} B/frame > ${t.maxBytesPerFrame} B/frame`],
    ];
    const errs = checks.filter(([ok]) => !ok).map(([, msg]) => msg);
    if (errs.length > 0) failed = true;

    rows.push({
      suite: 'tests/harness.js (RoI)',
      status: parsed.roiPos >= b.roiPositives && parsed.negClean >= b.roiNegativesClean ? 'PASS' : 'FAIL',
      detail: `${parsed.roiPos}/${parsed.roiTot} pos, maxErr=${parsed.maxErr}deg, negClean=${parsed.negClean}/2`,
    });
    rows.push({
      suite: 'tests/harness.js (Pipe)',
      status: errs.length === 0 ? 'PASS' : 'FAIL',
      detail: errs.length === 0
        ? `${parsed.decoded}/${parsed.decTot} dec, ${parsed.fp} FP, p50=${parsed.p50.toFixed(2)}ms, p95=${parsed.p95.toFixed(2)}ms (base ${b.p95Ms}ms), ${parsed.bpf.toFixed(1)} B/f`
        : errs.join('; '),
    });
  }
} else {
  const baseInfo = resolveBaseRevision(ROOT, cli.baseRev);
  let extracted = null;
  try {
    extracted = extractGitRefToDir(ROOT, baseInfo.rev);
    const hasBaseHarness = existsSync(join(extracted.dir, 'tests', 'harness.js'));
    if (!hasBaseHarness) {
      // Base predates tests/harness.js: run HEAD standalone with sanity checks
      const h = runNode(['--expose-gc', 'tests/harness.js', `--iters=${cli.iters}`], ROOT);
      const parsed = h.status === 0 ? parseHarnessOutput(h.stdout) : null;
      if (!parsed || parsed.decoded < 14 || parsed.fp > 0) failed = true;
      rows.push({
        suite: 'tests/harness.js (HEAD)',
        status: parsed && parsed.decoded >= 14 && parsed.fp === 0 ? 'PASS' : 'FAIL',
        detail: parsed
          ? `${parsed.decoded}/${parsed.decTot} dec, ${parsed.fp} FP, p50=${parsed.p50.toFixed(2)}ms (base lacks harness.js)`
          : 'Harness failed',
      });
    } else {
      const baseRuns = [];
      const headRuns = [];
      let harnessErr = null;
      const args = ['--expose-gc', 'tests/harness.js', `--iters=${cli.iters}`];

      for (let i = 0; i < cli.runs; i++) {
        const order = (i & 1) === 0 ? ['base', 'head'] : ['head', 'base'];
        for (const side of order) {
          const cwd = side === 'base' ? extracted.dir : ROOT;
          const res = runNode(args, cwd);
          const parsed = res.status === 0 ? parseHarnessOutput(res.stdout) : null;
          if (!parsed) {
            harnessErr = `${side} run #${i + 1} failed (exit ${res.status})`;
            break;
          }
          if (side === 'base') baseRuns.push(parsed);
          else headRuns.push(parsed);
        }
        if (harnessErr) break;
      }

      if (harnessErr) {
        failed = true;
        rows.push({
          suite: 'tests/harness.js (A/B)',
          status: 'FAIL',
          detail: harnessErr,
        });
      } else {
        const baseAgg = aggregateHarnessRuns(baseRuns);
        const headAgg = aggregateHarnessRuns(headRuns);
        const cmp = compareAbMetrics(baseAgg, headAgg);
        if (!cmp.ok) failed = true;

        rows.push({
          suite: 'tests/harness.js (RoI)',
          status: headAgg.roiPos >= baseAgg.roiPos && headAgg.negClean >= baseAgg.negClean ? 'PASS' : 'FAIL',
          detail: `${headAgg.roiPos}/${headAgg.roiTot} pos (base ${baseAgg.roiPos}), maxErr=${headAgg.maxErr.toFixed(2)}deg, negClean=${headAgg.negClean}/2`,
        });
        rows.push({
          suite: 'tests/harness.js (A/B)',
          status: cmp.ok ? 'PASS' : 'FAIL',
          detail: cmp.ok ? formatAbSummary(baseInfo.shortSha, cmp) : `${cmp.errors.join('; ')} | ${formatAbSummary(baseInfo.shortSha, cmp)}`,
        });
      }
    }
  } finally {
    if (extracted) extracted.cleanup();
  }
}

// 3. Optional replay of any golden .dbct tapes in tapes/
const tapesDir = join(ROOT, 'tapes');
const replayScript = join(ROOT, 'tools', 'replay.mjs');
if (existsSync(tapesDir) && existsSync(replayScript)) {
  const tapes = readdirSync(tapesDir).filter((f) => f.endsWith('.dbct')).sort();
  for (const tape of tapes) {
    const r = runNode([replayScript, join('tapes', tape)], ROOT);
    const ok = r.status === 0;
    if (!ok) failed = true;
    rows.push({
      suite: `replay:${tape}`,
      status: ok ? 'PASS' : 'FAIL',
      detail: (r.stdout || r.stderr).trim().split('\n').pop() || '',
    });
  }
}

const headerSuffix = cli.legacyJson
  ? '(vs legacy baseline d917944)'
  : `(same-machine A/B vs ${cli.baseRev}, N=${cli.runs})`;
console.log(`\n=== DBC Verification Gate ${headerSuffix} ===`);
for (const r of rows) {
  console.log(`  [${r.status}]  ${r.suite.padEnd(28)} ${r.detail}`);
}
console.log(failed ? '\nVERIFICATION FAILED' : '\nALL VERIFICATION GATES PASSED');
process.exit(failed ? 1 : 0);
