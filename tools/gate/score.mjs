/**
 * G2 — SimGate Seed Runner, Metrics Aggregator & `worker_threads` Executor (`tools/gate/score.mjs`).
 *
 * Renders frames on the camera clock with `renderFrame` (`src/sim/cpu-render.js`),
 * feeds each frame to `processFrameMulti` (`src/worker/scanner.worker.js`),
 * scores coverage / time-to-all / time-to-first / false positives / worker timings / heap delta,
 * and supports parallel multi-seed execution via `node:worker_threads`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { sampleCameraPose } from '../../src/sim/paths.js';
import { createCpuRenderContext, renderFrame, mulberry32 } from '../../src/sim/cpu-render.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../../src/worker/scanner.worker.js';
import { FLAG_VERTICAL_MODE } from '../../src/worker/flagbits.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PROVISIONAL_DEVICE_FACTOR_A53 = 5.8;

/**
 * Loads `baseline/device-factor.json` if present (populated by G4), else falls back to 5.8.
 */
export function getDeviceFactorA53() {
  const path = join(ROOT, 'baseline', 'device-factor.json');
  if (existsSync(path)) {
    try {
      const data = JSON.parse(readFileSync(path, 'utf8'));
      const f = Number(data.deviceFactorA53 ?? data.factor);
      if (Number.isFinite(f) && f > 0) return f;
    } catch {}
  }
  return PROVISIONAL_DEVICE_FACTOR_A53;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return (s.length & 1) ? s[m] : (s[m - 1] + s[m]) * 0.5;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Runs a single seed of a scenario synchronously on the current thread.
 * Deterministic on all decode / coverage / timing-clock fields.
 *
 * @param {object} scenario
 * @param {number} seed
 * @param {{ deviceFactor?: number }} [opts]
 */
export function runScenarioSeed(scenario, seed, opts = {}) {
  const deviceFactor = opts.deviceFactor ?? getDeviceFactorA53();
  const width = scenario.width | 0;
  const height = scenario.height | 0;
  const fpsCap = scenario.fpsCap > 0 ? scenario.fpsCap : 30;
  const dtSec = 1.0 / fpsCap;
  const durationSec = Math.max(dtSec, scenario.durationSec);
  const frameCount = Math.max(1, Math.floor(durationSec * fpsCap + 1e-9));
  const shutterSec = (scenario.shutterMs || 0) * 0.001;
  const workerMask = (scenario.flags?.workerMask | 0) || 0;
  const isLadder = (scenario.scene.label?.orientation || 'ladder') === 'ladder';

  // Seeded phase offset in [0, dtSec) so distinct seeds sample distinct sweep phases deterministically
  const rng = mulberry32((Math.imul(seed | 0, 0x9e3779b1) ^ 0x13579bdf) >>> 0);
  const phaseOffsetSec = scenario.path === 'manual' ? 0 : rng() * dtSec;

  const expectedList = Array.isArray(scenario.expectedPayloads)
    ? scenario.expectedPayloads
    : scenario.scene.cells.map((c) => c.payload);
  const expectedSet = new Set(expectedList);
  const totalCells = expectedSet.size;

  const ctx = createCpuRenderContext(scenario.scene.cells.length);
  const luma = new Uint8Array(width * height);
  const workerState = createPipelineState(width, height);
  workerState.flags = workerMask;
  workerState.scanline.mode = (isLadder && (workerMask & FLAG_VERTICAL_MODE) !== 0) ? 1 : 0;
  const workerResult = createPipelineResult();

  const poseCfg = {
    distanceIn: scenario.distanceIn,
    speedInPerSec: scenario.speed,
    jitter: scenario.jitter,
    loop: scenario.loop !== false,
    manualPose: scenario.manualPose || undefined,
  };

  const renderOpts = {
    width,
    height,
    hfovDeg: scenario.hfovDeg,
    shadowStrength: scenario.scene.shadowStrength,
    noiseStrength: scenario.scene.noiseStrength,
    glareStrength: scenario.scene.glareStrength,
    frameSeed: 0,
    ctx,
  };

  const timeToFirst = new Map(); // payload -> first simTimeSec
  const fpPayloads = [];
  let falsePositives = 0;
  let timeToAllSec = null;
  const workerMsSamples = new Array(frameCount);

  let heapBefore = 0;
  const measureHeap = typeof global.gc === 'function';
  if (measureHeap) {
    global.gc();
    heapBefore = process.memoryUsage().heapUsed;
  }

  for (let f = 0; f < frameCount; f++) {
    const tSec = phaseOffsetSec + f * dtSec;
    const pose = sampleCameraPose(scenario.path, tSec, poseCfg);

    let poses;
    if (shutterSec > 0 && scenario.path !== 'manual' && !pose.finished) {
      const subFrames = scenario.shutterMs >= 8 ? 7 : 5;
      poses = new Array(subFrames);
      for (let k = 0; k < subFrames; k++) {
        const frac = (k / (subFrames - 1)) - 0.5;
        const ts = Math.max(0, tSec + frac * shutterSec);
        poses[k] = sampleCameraPose(scenario.path, ts, poseCfg);
      }
    } else {
      poses = [pose];
    }

    renderOpts.frameSeed = seed * 100003 + f * 0.71;
    renderFrame(scenario.scene, poses, renderOpts, luma);

    workerState.flags = workerMask;
    workerState.scanline.mode = (isLadder && (workerMask & FLAG_VERTICAL_MODE) !== 0) ? 1 : 0;
    const tw0 = performance.now();
    processFrameMulti(luma, width, height, workerState, workerResult, false);
    workerMsSamples[f] = performance.now() - tw0;

    const dets = extractMultiDetections(workerState);
    for (let d = 0; d < dets.length; d++) {
      const payload = dets[d].payload;
      if (!payload) continue;
      if (!expectedSet.has(payload)) {
        falsePositives++;
        fpPayloads.push({ frame: f, tSec: round4(tSec), payload });
        continue;
      }
      if (!timeToFirst.has(payload)) {
        timeToFirst.set(payload, round4(tSec));
        if (timeToFirst.size === totalCells && timeToAllSec === null) {
          timeToAllSec = round4(tSec);
        }
      }
    }
  }

  let heapBytesPerFrame = null;
  if (measureHeap) {
    global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    heapBytesPerFrame = round3(Math.max(0, (heapAfter - heapBefore) / frameCount));
  }

  const sortedMs = [...workerMsSamples].sort((a, b) => a - b);
  const p50 = percentile(sortedMs, 0.5);
  const p95 = percentile(sortedMs, 0.95);
  const max = sortedMs.length ? sortedMs[sortedMs.length - 1] : 0;

  // Deterministic sorted map of payload -> timeToFirstSec
  const timeToFirstByLabel = {};
  const decodedPayloads = Array.from(timeToFirst.keys()).sort();
  for (const p of decodedPayloads) {
    timeToFirstByLabel[p] = timeToFirst.get(p);
  }

  const decodedCount = decodedPayloads.length;
  const coverageRatio = totalCells > 0 ? round4(decodedCount / totalCells) : 0;

  return {
    seed,
    framesRendered: frameCount,
    fpsDelivered: round3(frameCount / durationSec),
    decodedCount,
    totalCells,
    coverageRatio,
    lockedAll: decodedCount === totalCells && totalCells > 0,
    timeToAllSec,
    decodedPayloads,
    timeToFirstByLabel,
    falsePositives,
    falsePositivePayloads: fpPayloads,
    workerMs: {
      node: { p50: round3(p50), p95: round3(p95), max: round3(max) },
      a53Scaled: {
        p50: round3(p50 * deviceFactor),
        p95: round3(p95 * deviceFactor),
        max: round3(max * deviceFactor),
      },
    },
    heapBytesPerFrame,
  };
}

/**
 * Aggregates per-seed results into a canonical scenario summary.
 */
export function aggregateScenarioResults(scenario, seedResults, deviceFactor = getDeviceFactorA53()) {
  const ordered = [...seedResults].sort((a, b) => a.seed - b.seed);
  const totalCells = ordered.length ? ordered[0].totalCells : scenario.expectedPayloads.length;
  const coverages = ordered.map((r) => r.decodedCount);
  const timeToAllVals = ordered.map((r) => r.timeToAllSec).filter((v) => v !== null);
  const totalFp = ordered.reduce((acc, r) => acc + r.falsePositives, 0);
  const lockedAllCount = ordered.filter((r) => r.lockedAll).length;

  const nodeP50s = ordered.map((r) => r.workerMs.node.p50);
  const nodeP95s = ordered.map((r) => r.workerMs.node.p95);
  const nodeMaxs = ordered.map((r) => r.workerMs.node.max);
  const heapVals = ordered.map((r) => r.heapBytesPerFrame).filter((v) => v !== null);

  const medNodeP50 = round3(median(nodeP50s));
  const medNodeP95 = round3(median(nodeP95s));
  const worstNodeMax = round3(nodeMaxs.length ? Math.max(...nodeMaxs) : 0);

  const detPayload = {
    id: scenario.runId || scenario.id,
    presetId: scenario.presetId,
    profile: scenario.profile,
    flagSet: scenario.flags.id,
    workerMask: scenario.flags.workerMask,
    seeds: ordered.map((r) => ({
      seed: r.seed,
      framesRendered: r.framesRendered,
      fpsDelivered: r.fpsDelivered,
      decodedCount: r.decodedCount,
      totalCells: r.totalCells,
      lockedAll: r.lockedAll,
      timeToAllSec: r.timeToAllSec,
      decodedPayloads: r.decodedPayloads,
      timeToFirstByLabel: r.timeToFirstByLabel,
      falsePositives: r.falsePositives,
      falsePositivePayloads: r.falsePositivePayloads,
    })),
  };

  const deterministicHash = createHash('sha256')
    .update(JSON.stringify(detPayload))
    .digest('hex')
    .slice(0, 16);

  return {
    id: scenario.runId || scenario.id,
    scenarioId: scenario.id,
    group: scenario.group,
    presetId: scenario.presetId,
    profile: scenario.profile,
    fidelityStatus: scenario.fidelityStatus || 'uncalibrated',
    flagSet: scenario.flags.id,
    workerFlags: [...scenario.flags.worker],
    workerMask: scenario.flags.workerMask,
    width: scenario.width,
    height: scenario.height,
    fpsCap: scenario.fpsCap,
    loops: scenario.loops,
    durationSec: scenario.durationSec,
    ppm: scenario.ppm,
    seedCount: ordered.length,
    totalCells,
    coverageMedian: round3(median(coverages)),
    coverageMin: coverages.length ? Math.min(...coverages) : 0,
    coverageMax: coverages.length ? Math.max(...coverages) : 0,
    lockedAllCount,
    timeToAllMedianSec: timeToAllVals.length ? round4(median(timeToAllVals)) : null,
    timeToAllSecBySeed: ordered.map((r) => r.timeToAllSec),
    falsePositivesTotal: totalFp,
    fpsDelivered: ordered.length ? ordered[0].fpsDelivered : 0,
    deterministicHash,
    workerMs: {
      deviceFactorA53: deviceFactor,
      node: { p50: medNodeP50, p95: medNodeP95, max: worstNodeMax },
      a53Scaled: {
        p50: round3(medNodeP50 * deviceFactor),
        p95: round3(medNodeP95 * deviceFactor),
        max: round3(worstNodeMax * deviceFactor),
      },
    },
    heapBytesPerFrame: heapVals.length ? round3(median(heapVals)) : null,
    seeds: ordered,
  };
}

/**
 * Strips non-deterministic wall-clock timing fields from a scenario summary or full report
 * so byte-identical determinism checks can compare the simulation output directly.
 */
export function stripVolatileMetrics(reportOrScenario) {
  const cleanScenario = (sc) => ({
    id: sc.id,
    scenarioId: sc.scenarioId,
    group: sc.group,
    presetId: sc.presetId,
    profile: sc.profile,
    fidelityStatus: sc.fidelityStatus,
    flagSet: sc.flagSet,
    workerFlags: sc.workerFlags,
    workerMask: sc.workerMask,
    width: sc.width,
    height: sc.height,
    fpsCap: sc.fpsCap,
    loops: sc.loops,
    durationSec: sc.durationSec,
    ppm: sc.ppm,
    seedCount: sc.seedCount,
    totalCells: sc.totalCells,
    coverageMedian: sc.coverageMedian,
    coverageMin: sc.coverageMin,
    coverageMax: sc.coverageMax,
    lockedAllCount: sc.lockedAllCount,
    timeToAllMedianSec: sc.timeToAllMedianSec,
    timeToAllSecBySeed: sc.timeToAllSecBySeed,
    falsePositivesTotal: sc.falsePositivesTotal,
    fpsDelivered: sc.fpsDelivered,
    deterministicHash: sc.deterministicHash,
    seeds: sc.seeds.map((s) => ({
      seed: s.seed,
      framesRendered: s.framesRendered,
      fpsDelivered: s.fpsDelivered,
      decodedCount: s.decodedCount,
      totalCells: s.totalCells,
      coverageRatio: s.coverageRatio,
      lockedAll: s.lockedAll,
      timeToAllSec: s.timeToAllSec,
      decodedPayloads: s.decodedPayloads,
      timeToFirstByLabel: s.timeToFirstByLabel,
      falsePositives: s.falsePositives,
      falsePositivePayloads: s.falsePositivePayloads,
    })),
  });

  if (Array.isArray(reportOrScenario.scenarios)) {
    return {
      schemaVersion: reportOrScenario.schemaVersion,
      renderer: reportOrScenario.renderer,
      fidelityStatus: reportOrScenario.fidelityStatus,
      scenarios: reportOrScenario.scenarios.map(cleanScenario),
    };
  }
  return cleanScenario(reportOrScenario);
}

/**
 * Strips non-cloneable functions (e.g. `scene.label.payloadFn`) before sending scenario to `worker_threads`.
 */
function serializeScenarioForWorker(scenario) {
  const { payloadFn: _unused, ...labelPlain } = scenario.scene.label || {};
  return {
    ...scenario,
    scene: {
      ...scenario.scene,
      label: labelPlain,
    },
  };
}

/**
 * Runs a list of scenarios across all their seeds, parallelising independent `(scenario, seed)`
 * tasks with `node:worker_threads` when there is more than one task and `jobs > 1`.
 */
export async function runScenarios(scenarios, opts = {}) {
  const deviceFactor = opts.deviceFactor ?? getDeviceFactorA53();
  const tasks = [];
  for (let si = 0; si < scenarios.length; si++) {
    const sc = scenarios[si];
    for (let ki = 0; ki < sc.seeds.length; ki++) {
      tasks.push({ scenarioIdx: si, seed: sc.seeds[ki] });
    }
  }

  const maxThreads = Number.isFinite(opts.jobs) && opts.jobs > 0
    ? (opts.jobs | 0)
    : Math.max(1, Math.min(availableParallelism(), 6));
  const useWorkers = opts.parallel !== false && tasks.length > 1 && maxThreads > 1;

  const resultsByScenario = scenarios.map(() => []);

  if (!useWorkers) {
    for (const t of tasks) {
      const res = runScenarioSeed(scenarios[t.scenarioIdx], t.seed, { deviceFactor });
      resultsByScenario[t.scenarioIdx].push(res);
    }
  } else {
    const workerCount = Math.min(maxThreads, tasks.length);
    const serializedScenarios = scenarios.map(serializeScenarioForWorker);
    let nextTask = 0;

    await new Promise((resolve, reject) => {
      let active = 0;
      let failed = false;

      const launchNext = () => {
        while (!failed && active < workerCount && nextTask < tasks.length) {
          const task = tasks[nextTask++];
          active++;
          const w = new Worker(new URL('./score.mjs', import.meta.url), {
            workerData: {
              scenario: serializedScenarios[task.scenarioIdx],
              seed: task.seed,
              deviceFactor,
            },
          });
          let settled = false;
          w.once('message', (msg) => {
            settled = true;
            resultsByScenario[task.scenarioIdx].push(msg);
          });
          w.once('error', (err) => {
            if (!failed) {
              failed = true;
              reject(err);
            }
          });
          w.once('exit', (code) => {
            active--;
            if (code !== 0 && !failed) {
              failed = true;
              reject(new Error(`SimGate worker exited with code ${code}`));
              return;
            }
            if (!settled && !failed) {
              failed = true;
              reject(new Error('SimGate worker exited without sending result'));
              return;
            }
            if (nextTask >= tasks.length && active === 0 && !failed) {
              resolve();
            } else {
              launchNext();
            }
          });
        }
      };

      launchNext();
    });
  }

  return scenarios.map((sc, idx) =>
    aggregateScenarioResults(sc, resultsByScenario[idx], deviceFactor)
  );
}

// Self-re-entry for `node:worker_threads` seed execution
if (!isMainThread && parentPort && workerData && workerData.scenario) {
  const res = runScenarioSeed(workerData.scenario, workerData.seed, {
    deviceFactor: workerData.deviceFactor,
  });
  parentPort.postMessage(res);
}
