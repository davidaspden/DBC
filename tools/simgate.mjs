#!/usr/bin/env node
/**
 * G2 — Headless SimGate Scenario Runner (`tools/simgate.mjs`).
 *
 * Runs synthetic 3D tote-wall scenarios on the headless CPU renderer (`src/sim/cpu-render.js`)
 * through the real DBC barcode worker (`processFrameMulti`), parallelising seeds via
 * `node:worker_threads`, and writes a JSON report to git-ignored `gate-results/`.
 *
 * Usage:
 *   node tools/simgate.mjs --list
 *   node tools/simgate.mjs --quick
 *   node tools/simgate.mjs --only S01 --seeds 5 --loops 3
 *   node tools/simgate.mjs --only fc-8-3p5 --flags off,W-fc,W-all --seeds 2
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWave1Scenarios, selectScenarios } from './gate/scenarios.mjs';
import { runScenarios } from './gate/score.mjs';
import {
  PHONE_MS_A53,
  DEFAULT_ITERATIONS,
  getDeviceFactorMeasurement,
  getMachineInfo,
} from './gate/device-factor.mjs';
import {
  buildReport,
  formatTable,
  writeReportJson,
  defaultReportPath,
  getShortCommit,
  getMachineSlug,
} from './gate/report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parseCliArgs(argv) {
  const opts = {
    list: false,
    quick: false,
    only: null,
    seeds: null,
    flags: null,
    loops: null,
    durationSec: null,
    jobs: null,
    out: null,
    deviceFactor: null,
    deterministicJson: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = true;
    else if (a === '--quick') opts.quick = true;
    else if (a === '--deterministic-json') opts.deterministicJson = true;
    else if (a === '--only' && argv[i + 1]) opts.only = argv[++i];
    else if (a.startsWith('--only=')) opts.only = a.slice('--only='.length);
    else if (a === '--seeds' && argv[i + 1]) opts.seeds = Number(argv[++i]);
    else if (a.startsWith('--seeds=')) opts.seeds = Number(a.slice('--seeds='.length));
    else if (a === '--flags' && argv[i + 1]) opts.flags = argv[++i];
    else if (a.startsWith('--flags=')) opts.flags = a.slice('--flags='.length);
    else if (a === '--loops' && argv[i + 1]) opts.loops = Number(argv[++i]);
    else if (a.startsWith('--loops=')) opts.loops = Number(a.slice('--loops='.length));
    else if (a === '--duration' && argv[i + 1]) opts.durationSec = Number(argv[++i]);
    else if (a.startsWith('--duration=')) opts.durationSec = Number(a.slice('--duration='.length));
    else if (a === '--jobs' && argv[i + 1]) opts.jobs = Number(argv[++i]);
    else if (a.startsWith('--jobs=')) opts.jobs = Number(a.slice('--jobs='.length));
    else if (a === '--out' && argv[i + 1]) opts.out = argv[++i];
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--device-factor' && argv[i + 1]) opts.deviceFactor = Number(argv[++i]);
    else if (a.startsWith('--device-factor=')) opts.deviceFactor = Number(a.slice('--device-factor='.length));
  }

  return opts;
}

function printScenarioList() {
  const list = buildWave1Scenarios();
  console.log(`SimGate Wave 1 scenarios (${list.length} entries, profile: ideal, status: uncalibrated):`);
  for (const sc of list) {
    const q = sc.quick ? ' [quick]' : '';
    console.log(
      `  ${sc.id.padEnd(22)} group=${sc.group.padEnd(4)} preset=${sc.presetId.padEnd(18)} ` +
      `${sc.width}x${sc.height}@${sc.fpsCap}fps  loop=${sc.loopDurationSec.toFixed(1)}s  ` +
      `flags=${sc.flagSets.join(',')}${q}`
    );
  }
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.list) {
    printScenarioList();
    return;
  }

  const t0 = performance.now();
  const scenarios = selectScenarios(opts);

  let deviceFactor;
  let deviceFactorMeta;
  if (opts.deviceFactor !== null) {
    if (!Number.isFinite(opts.deviceFactor) || opts.deviceFactor <= 0) {
      throw new Error(`Invalid --device-factor value: ${opts.deviceFactor}`);
    }
    deviceFactor = opts.deviceFactor;
    deviceFactorMeta = {
      phoneMs: PHONE_MS_A53,
      nodeP50Ms: null,
      iterations: 0,
      source: 'cli-override',
      machine: getMachineInfo(),
    };
  } else {
    const measured = getDeviceFactorMeasurement({ iterations: DEFAULT_ITERATIONS });
    deviceFactor = measured.deviceFactorA53;
    deviceFactorMeta = {
      phoneMs: measured.phoneMs,
      nodeP50Ms: measured.nodeP50Ms,
      nodeP95Ms: measured.nodeP95Ms,
      iterations: measured.iterations,
      machine: measured.machine,
    };
  }

  const mInfo = deviceFactorMeta.machine;
  const dfDetail = deviceFactorMeta.nodeP50Ms !== null
    ? `deviceFactorA53=${deviceFactor.toFixed(2)}x (nodeP50Ms=${deviceFactorMeta.nodeP50Ms.toFixed(2)}ms, phoneMs=${deviceFactorMeta.phoneMs}, iters=${deviceFactorMeta.iterations})`
    : `deviceFactorA53=${deviceFactor.toFixed(2)}x (cli-override)`;

  console.log(
    `SimGate: machine=${mInfo.hostname} | cpu=${mInfo.cpuModel} (${mInfo.cpuCount} cores, ${mInfo.platform}/${mInfo.arch}, Node ${mInfo.nodeVersion})`
  );
  console.log(
    `SimGate: running ${scenarios.length} scenario(s) ` +
    `(${opts.quick ? 'quick mode' : 'standard mode'}, profile=ideal, fidelity=uncalibrated, ` +
    `${dfDetail})...`
  );

  const results = await runScenarios(scenarios, {
    deviceFactor,
    jobs: opts.jobs,
  });

  const commit = getShortCommit(ROOT);
  const machine = getMachineSlug();
  const report = buildReport(results, {
    commit,
    machine,
    deviceFactorA53: deviceFactor,
    deviceFactorMeta,
    includeTimings: !opts.deterministicJson,
  });

  const outPath = opts.out || defaultReportPath(ROOT, commit, machine);
  writeReportJson(report, outPath);

  const elapsedSec = ((performance.now() - t0) / 1000).toFixed(2);
  console.log('');
  console.log(formatTable(results));
  console.log('');
  console.log(`Wrote ${outPath} in ${elapsedSec} s (profile=ideal, fidelity=uncalibrated).`);
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('simgate.mjs')) {
  main().catch((err) => {
    console.error('SimGate failed:', err);
    process.exit(1);
  });
}
