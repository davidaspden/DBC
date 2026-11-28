/**
 * G1 — Same-Machine Interleaved A/B Verification Helpers (`tools/gate/ab.mjs`).
 *
 * Zero-dependency helpers using Node built-ins + `git archive` + `tar` to benchmark
 * HEAD against any base git revision (`HEAD~1`, `origin/main`, commit SHA) on the
 * same machine with interleaved runs to cancel thermal/load drift.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_AB_THRESHOLDS = Object.freeze({
  maxP50Ratio: 1.10,       // <= +10% median latency
  maxP95Ratio: 1.25,       // <= +25% p95 latency
  maxHeapIncreaseBpf: 4.0, // <= +4 B/frame over base
  maxHeapCeilingBpf: 64.0, // hard hot-loop heap ceiling (B/frame)
});

/**
 * Computes exact median of a non-empty numeric array.
 * @param {number[]} values
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median requires a non-empty array');
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return (sorted.length & 1) === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
}

/**
 * Parses `tests/harness.js` stdout into structured metrics.
 * Returns `null` if any expected summary line is missing.
 *
 * @param {string} out
 */
export function parseHarnessOutput(out) {
  if (typeof out !== 'string' || !out) return null;
  const roiMatch = out.match(/Positives=(\d+)\/(\d+),\s*Angle<=3°=(\d+)\/(\d+)\s*\(maxErr=([\d.]+)°\),\s*NegativesClean=(\d+)\/(\d+)/);
  const decMatch = out.match(/Decoded=(\d+)\/(\d+)\s*\(([\d.]+)%\),\s*FalsePositives=(\d+)\/(\d+)/);
  const pipeTimeMatch = out.match(/Phase 3 — Full Pipeline Timings[\s\S]*?p50=([\d.]+)ms\s+p95=([\d.]+)ms\s+p99=([\d.]+)ms/);
  const heapMatch = out.match(/Phase 3 — Full Pipeline Timings[\s\S]*?delta=(-?\d+)\s*B\s*\(([\d.-]+)\s*B\/frame\)/);
  if (!roiMatch || !decMatch || !pipeTimeMatch || !heapMatch) return null;

  return {
    roiPos: Number(roiMatch[1]),
    roiTot: Number(roiMatch[2]),
    maxErr: Number(roiMatch[5]),
    negClean: Number(roiMatch[6]),
    decoded: Number(decMatch[1]),
    decTot: Number(decMatch[2]),
    fp: Number(decMatch[4]),
    p50: Number(pipeTimeMatch[1]),
    p95: Number(pipeTimeMatch[2]),
    p99: Number(pipeTimeMatch[3]),
    heapDelta: Number(heapMatch[1]),
    bpf: Number(heapMatch[2]),
  };
}

/**
 * Aggregates N harness runs using median latency/heap and worst-case accuracy/FP.
 *
 * @param {Array<ReturnType<typeof parseHarnessOutput>>} runs
 */
export function aggregateHarnessRuns(runs) {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('aggregateHarnessRuns requires at least one run');
  }
  const p50s = [];
  const p95s = [];
  const p99s = [];
  const bpfs = [];
  const maxErrs = [];
  let minRoiPos = Infinity;
  let minNegClean = Infinity;
  let minDecoded = Infinity;
  let maxFp = 0;

  for (const r of runs) {
    p50s.push(r.p50);
    p95s.push(r.p95);
    p99s.push(r.p99);
    bpfs.push(r.bpf);
    maxErrs.push(r.maxErr);
    if (r.roiPos < minRoiPos) minRoiPos = r.roiPos;
    if (r.negClean < minNegClean) minNegClean = r.negClean;
    if (r.decoded < minDecoded) minDecoded = r.decoded;
    if (r.fp > maxFp) maxFp = r.fp;
  }

  return {
    runs: runs.length,
    roiPos: minRoiPos,
    roiTot: runs[0].roiTot,
    negClean: minNegClean,
    maxErr: median(maxErrs),
    decoded: minDecoded,
    decTot: runs[0].decTot,
    fp: maxFp,
    p50: median(p50s),
    p95: median(p95s),
    p99: median(p99s),
    bpf: median(bpfs),
  };
}

/**
 * Compares HEAD aggregated metrics against same-machine BASE aggregated metrics.
 * Enforces G1 tolerances: p50 <= +10%, p95 <= +25%, heap not worse, decode superset, 0 new FP.
 */
export function compareAbMetrics(baseAgg, headAgg, thresholds = DEFAULT_AB_THRESHOLDS) {
  const t = { ...DEFAULT_AB_THRESHOLDS, ...(thresholds || {}) };
  const p50Limit = baseAgg.p50 * t.maxP50Ratio;
  const p95Limit = baseAgg.p95 * t.maxP95Ratio;
  const heapLimit = Math.min(t.maxHeapCeilingBpf, Math.max(baseAgg.bpf, 0) + t.maxHeapIncreaseBpf);

  const errors = [];
  if (headAgg.roiPos < baseAgg.roiPos) {
    errors.push(`RoI positives ${headAgg.roiPos}/${headAgg.roiTot} < base ${baseAgg.roiPos}/${baseAgg.roiTot}`);
  }
  if (headAgg.negClean < baseAgg.negClean) {
    errors.push(`RoI negatives clean ${headAgg.negClean} < base ${baseAgg.negClean}`);
  }
  if (headAgg.decoded < baseAgg.decoded) {
    errors.push(`Decoded ${headAgg.decoded}/${headAgg.decTot} < base ${baseAgg.decoded}/${baseAgg.decTot}`);
  }
  if (headAgg.fp > baseAgg.fp) {
    errors.push(`False positives ${headAgg.fp} > base ${baseAgg.fp}`);
  }
  if (headAgg.p50 > p50Limit) {
    const pct = ((headAgg.p50 / Math.max(baseAgg.p50, 1e-6) - 1) * 100).toFixed(1);
    errors.push(`p50 ${headAgg.p50.toFixed(3)}ms > ${p50Limit.toFixed(3)}ms (+${pct}% > +${Math.round((t.maxP50Ratio - 1) * 100)}%)`);
  }
  if (headAgg.p95 > p95Limit) {
    const pct = ((headAgg.p95 / Math.max(baseAgg.p95, 1e-6) - 1) * 100).toFixed(1);
    errors.push(`p95 ${headAgg.p95.toFixed(3)}ms > ${p95Limit.toFixed(3)}ms (+${pct}% > +${Math.round((t.maxP95Ratio - 1) * 100)}%)`);
  }
  if (headAgg.bpf > heapLimit) {
    errors.push(`heap ${headAgg.bpf.toFixed(2)} B/f > ${heapLimit.toFixed(2)} B/f (base ${baseAgg.bpf.toFixed(2)})`);
  }

  return {
    ok: errors.length === 0,
    errors,
    limits: { p50Limit, p95Limit, heapLimit },
    ratios: {
      p50Ratio: baseAgg.p50 > 0 ? headAgg.p50 / baseAgg.p50 : 1,
      p95Ratio: baseAgg.p95 > 0 ? headAgg.p95 / baseAgg.p95 : 1,
    },
    base: baseAgg,
    head: headAgg,
  };
}

/**
 * Resolves a git revision to its short commit SHA, falling back gracefully if needed.
 */
export function resolveBaseRevision(rootDir, requestedRev = 'HEAD~1') {
  const probe = spawnSync('git', ['rev-parse', '--verify', requestedRev], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (probe.status === 0) {
    const shortRes = spawnSync('git', ['rev-parse', '--short', requestedRev], {
      cwd: rootDir,
      encoding: 'utf8',
    });
    return {
      rev: requestedRev,
      shortSha: (shortRes.stdout || requestedRev).trim(),
      fallback: false,
    };
  }
  const headRes = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return {
    rev: 'HEAD',
    shortSha: (headRes.stdout || 'HEAD').trim(),
    fallback: true,
  };
}

function makeScratchTempDir(rootDir) {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dbc-ab-'));
    const probe = join(dir, '.write-probe');
    writeFileSync(probe, '1');
    rmSync(probe, { force: true });
    return dir;
  } catch {
    const fallback = join(rootDir, `.dbc-ab-tmp-${process.pid}-${Date.now()}`);
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/**
 * Extracts `<rev>` via `git archive` + `tar` into an isolated temporary directory.
 * Caller MUST invoke `cleanup()` in a `finally` block.
 */
export function extractGitRefToDir(rootDir, rev) {
  const tempRoot = makeScratchTempDir(rootDir);
  const extractDir = join(tempRoot, 'tree');
  const tarPath = join(tempRoot, 'base.tar');
  mkdirSync(extractDir, { recursive: true });

  const arch = spawnSync('git', ['archive', '--format=tar', `--output=${tarPath}`, rev], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (arch.status !== 0 || !existsSync(tarPath)) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`git archive ${rev} failed: ${(arch.stderr || arch.stdout || '').trim()}`);
  }

  const ext = spawnSync('tar', ['-xf', tarPath, '-C', extractDir], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  rmSync(tarPath, { force: true });
  if (ext.status !== 0) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw new Error(`tar extract ${rev} failed: ${(ext.stderr || ext.stdout || '').trim()}`);
  }

  return {
    tempRoot,
    dir: extractDir,
    cleanup() {
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

export function formatAbSummary(baseLabel, cmp) {
  const b = cmp.base;
  const h = cmp.head;
  const p50Pct = ((cmp.ratios.p50Ratio - 1) * 100).toFixed(1);
  const p95Pct = ((cmp.ratios.p95Ratio - 1) * 100).toFixed(1);
  const p50Sign = Number(p50Pct) >= 0 ? '+' : '';
  const p95Sign = Number(p95Pct) >= 0 ? '+' : '';
  return (
    `${h.decoded}/${h.decTot} dec (base ${b.decoded}), ${h.fp} FP, ` +
    `p50=${h.p50.toFixed(2)}ms vs ${b.p50.toFixed(2)}ms (${p50Sign}${p50Pct}%), ` +
    `p95=${h.p95.toFixed(2)}ms vs ${b.p95.toFixed(2)}ms (${p95Sign}${p95Pct}%), ` +
    `${h.bpf.toFixed(1)} vs ${b.bpf.toFixed(1)} B/f [N=${h.runs} vs ${baseLabel}]`
  );
}
