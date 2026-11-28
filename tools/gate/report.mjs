/**
 * G2 — SimGate Report Builder, Table Formatter & JSON Writer (`tools/gate/report.mjs`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { stripVolatileMetrics } from './score.mjs';
import { getDeviceFactorA53 } from './device-factor.mjs';

function pad(str, len, right = false) {
  const s = String(str);
  if (s.length >= len) return s;
  const fill = ' '.repeat(len - s.length);
  return right ? fill + s : s + fill;
}

export function getShortCommit(cwd) {
  const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  return 'unknown';
}

export function getMachineSlug() {
  const raw = hostname() || 'local';
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'local';
}

/**
 * Builds the canonical JSON report object for a SimGate run.
 * When `includeTimings === false`, volatile wall-clock fields are omitted so repeated runs
 * produce byte-identical files.
 */
export function buildReport(scenarioResults, meta = {}) {
  const deviceFactorA53 = Number.isFinite(meta.deviceFactorA53) && meta.deviceFactorA53 > 0
    ? meta.deviceFactorA53
    : (scenarioResults[0]?.workerMs?.deviceFactorA53 ?? getDeviceFactorA53());
  const report = {
    schemaVersion: 1,
    commit: meta.commit || 'unknown',
    machine: meta.machine || getMachineSlug(),
    renderer: 'cpu',
    fidelityStatus: 'uncalibrated',
    deviceFactorA53,
    ...(meta.deviceFactorMeta ? { deviceFactorMeta: meta.deviceFactorMeta } : {}),
    quickMode: Boolean(meta.quickMode),
    truncatedAtSec: meta.quickMode ? (meta.truncatedAtSec ?? 10) : null,
    coverageGate: meta.quickMode ? 'disabled (truncated at 10s)' : 'standard',
    ...(meta.gate ? { gate: meta.gate } : {}),
    scenarios: scenarioResults,
  };
  if (meta.includeTimings === false) {
    return stripVolatileMetrics(report);
  }
  return report;
}

/**
 * Formats a concise one-screen ASCII summary table for terminal display.
 */
export function formatTable(scenarioResults, opts = {}) {
  const isQuick = Boolean(opts.quickMode || scenarioResults.some((sc) => sc.quickMode));
  const headers = [
    ['Scenario', 26, false],
    ['Profile', 8, false],
    ['Flags', 7, false],
    ['Dur', 7, true],
    ['Seeds', 5, true],
    ['Cov', 9, true],
    ['T-all(s)', 9, true],
    ['FP', 4, true],
    ['p50/p95 ms', 13, true],
    ['A53 p50/p95', 13, true],
    ['FPS', 5, true],
    ['Hash', 10, false],
  ];

  const lines = [];
  if (isQuick) {
    lines.push('QUICK MODE (truncated at 10s; coverage informational/not gated; fc-tele-30-3p5 full-length FP-gated)');
  }
  lines.push(headers.map(([h, w, r]) => pad(h, w, r)).join('  '));
  lines.push(headers.map(([, w]) => '-'.repeat(w)).join('  '));

  for (const sc of scenarioResults) {
    const covStr = sc.coverageGated === false
      ? `${sc.coverageMedian}/${sc.totalCells}*`
      : `${sc.coverageMedian}/${sc.totalCells}`;
    const durVal = Number.isFinite(sc.durationSec) ? `${sc.durationSec.toFixed(1)}s` : '--';
    const durStr = sc.truncated ? `${durVal}*` : durVal;
    const tAllStr = sc.timeToAllMedianSec !== null ? sc.timeToAllMedianSec.toFixed(2) : '--';
    const nodeMs = `${sc.workerMs.node.p50.toFixed(1)}/${sc.workerMs.node.p95.toFixed(1)}`;
    const a53Ms = `${sc.workerMs.a53Scaled.p50.toFixed(1)}/${sc.workerMs.a53Scaled.p95.toFixed(1)}`;
    const row = [
      pad(sc.id, 26, false),
      pad(sc.profile, 8, false),
      pad(sc.flagSet, 7, false),
      pad(durStr, 7, true),
      pad(sc.seedCount, 5, true),
      pad(covStr, 9, true),
      pad(tAllStr, 9, true),
      pad(sc.falsePositivesTotal, 4, true),
      pad(nodeMs, 13, true),
      pad(a53Ms, 13, true),
      pad(Math.round(sc.fpsDelivered), 5, true),
      pad(sc.deterministicHash.slice(0, 10), 10, false),
    ];
    lines.push(row.join('  '));
  }

  if (isQuick) {
    lines.push('(* truncated/informational in quick mode; coverage does not pass or fail --quick)');
  }

  return lines.join('\n');
}

/**
 * Writes the JSON report to `outPath` (creating parent directories if needed)
 * and returns the exact path written.
 */
export function writeReportJson(report, outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return outPath;
}

/**
 * Default git-ignored JSON output path: `gate-results/<commit>-<machine>.json`.
 */
export function defaultReportPath(rootDir, commit, machine) {
  return join(rootDir, 'gate-results', `${commit}-${machine}.json`);
}
