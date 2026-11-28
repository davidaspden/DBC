/**
 * R3 — in-browser / in-Node A/B runner (`src/sim/ab-run.js`).
 *
 * Runs a scenario spec (`specFromScenarioJson`) through the CPU renderer and the real worker pipeline for
 * each flag set over the SAME path, phase and seed, and returns one result row per flag set. It mirrors
 * `runScenarioSeed` in `tools/gate/score.mjs` (same render options, seed phase, sub-pose shutter, decode
 * and scoring rules) but has no node imports, so the Labs panel can call it in the browser. A test pins
 * the two to identical decode sets, false positives and time-to-all.
 *
 * Async only so a page can yield to the UI between frames; in Node pass `yieldFn: null`.
 */

import { sampleCameraPose } from './paths.js';
import { createCpuRenderContext, renderFrame, mulberry32 } from './cpu-render.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../worker/scanner.worker.js';
import { FLAG_VERTICAL_MODE } from '../worker/flagbits.js';
import { createProfileRun } from './camera-model/profile-run.js';

const r4 = (x) => Math.round(x * 10000) / 10000;

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
}

/**
 * @param {object} spec  from `specFromScenarioJson`
 * @param {number} seed
 * @param {number} workerMask
 * @param {{ yieldFn?: (() => Promise<void>) | null, yieldEvery?: number,
 *           onProgress?: (frac: number) => void, scale?: number }} [opts]
 */
export async function runSpecSeed(spec, seed, workerMask, opts = {}) {
  const scale = opts.scale > 0 && opts.scale < 1 ? opts.scale : 1;
  const width = Math.max(64, Math.round((spec.width * scale) / 2) * 2);
  const height = Math.max(64, Math.round((spec.height * scale) / 2) * 2);
  if (spec.profile && spec.profile !== 'ideal') {
    return runSpecSeedProfile(spec, seed, workerMask, width, height, opts);
  }
  const fpsCap = spec.fpsCap > 0 ? spec.fpsCap : 30;
  const dtSec = 1.0 / fpsCap;
  const durationSec = Math.max(dtSec, spec.durationSec);
  const frameCount = Math.max(1, Math.floor(durationSec * fpsCap + 1e-9));
  const shutterSec = (spec.shutterMs || 0) * 0.001;
  const isLadder = (spec.scene.label?.orientation || 'ladder') === 'ladder';
  const rng = mulberry32((Math.imul(seed | 0, 0x9e3779b1) ^ 0x13579bdf) >>> 0);
  const phaseOffsetSec = spec.path === 'manual' ? 0 : rng() * dtSec;

  const expectedSet = new Set(spec.scene.cells.map((c) => c.payload));
  const total = expectedSet.size;
  const ctx = createCpuRenderContext(spec.scene.cells.length);
  const luma = new Uint8Array(width * height);
  const ws = createPipelineState(width, height);
  const wr = createPipelineResult();
  const poseCfg = {
    distanceIn: spec.distanceIn,
    speedInPerSec: spec.speed,
    jitter: spec.jitter,
    loop: spec.loop !== false,
    manualPose: spec.manualPose || undefined,
  };
  const renderOpts = {
    width,
    height,
    hfovDeg: spec.hfovDeg,
    shadowStrength: spec.scene.shadowStrength,
    noiseStrength: spec.scene.noiseStrength,
    glareStrength: spec.scene.glareStrength,
    frameSeed: 0,
    ctx,
  };

  const first = new Map();
  let falsePositives = 0;
  let timeToAllSec = null;
  const ms = new Array(frameCount);
  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  for (let f = 0; f < frameCount; f++) {
    const tSec = phaseOffsetSec + f * dtSec;
    const pose = sampleCameraPose(spec.path, tSec, poseCfg);
    let poses;
    if (shutterSec > 0 && spec.path !== 'manual' && !pose.finished) {
      const subFrames = spec.shutterMs >= 8 ? 7 : 5;
      poses = new Array(subFrames);
      for (let k = 0; k < subFrames; k++) {
        const frac = k / (subFrames - 1) - 0.5;
        poses[k] = sampleCameraPose(spec.path, Math.max(0, tSec + frac * shutterSec), poseCfg);
      }
    } else {
      poses = [pose];
    }
    renderOpts.frameSeed = seed * 100003 + f * 0.71;
    renderFrame(spec.scene, poses, renderOpts, luma);
    ws.flags = workerMask;
    ws.scanline.mode = isLadder && (workerMask & FLAG_VERTICAL_MODE) !== 0 ? 1 : 0;
    const t0 = nowMs();
    processFrameMulti(luma, width, height, ws, wr, false);
    ms[f] = nowMs() - t0;
    const dets = extractMultiDetections(ws);
    for (let d = 0; d < dets.length; d++) {
      const payload = dets[d].payload;
      if (!payload) continue;
      if (!expectedSet.has(payload)) {
        falsePositives++;
        continue;
      }
      if (!first.has(payload)) {
        first.set(payload, r4(tSec));
        if (first.size === total && timeToAllSec === null) timeToAllSec = r4(tSec);
      }
    }
    if (opts.yieldFn && opts.yieldEvery > 0 && f % opts.yieldEvery === opts.yieldEvery - 1) {
      if (opts.onProgress) opts.onProgress((f + 1) / frameCount);
      await opts.yieldFn();
    }
  }
  const sorted = [...ms].sort((a, b) => a - b);
  const decodedPayloads = Array.from(first.keys()).sort();
  return {
    seed,
    width,
    height,
    framesRendered: frameCount,
    decoded: decodedPayloads.length,
    total,
    decodedPayloads,
    falsePositives,
    timeToAllSec,
    workerMs: { p50: Math.round(pct(sorted, 0.5) * 1000) / 1000, p95: Math.round(pct(sorted, 0.95) * 1000) / 1000 },
  };
}

/** K9: camera-profile seed (same loop as `tools/gate/score.mjs` via `createProfileRun`). */
async function runSpecSeedProfile(spec, seed, workerMask, width, height, opts) {
  const run = createProfileRun(spec, seed, workerMask, {
    width,
    height,
    pipeline: { createPipelineState, createPipelineResult, processFrameMulti, extractMultiDetections },
  });
  let steps = 0;
  const approxSteps = Math.max(1, Math.round(run.durationSec * run.session.profile.scheduler.nominalFps));
  while (run.step()) {
    steps++;
    if (opts.yieldFn && opts.yieldEvery > 0 && steps % opts.yieldEvery === 0) {
      if (opts.onProgress) opts.onProgress(Math.min(1, steps / approxSteps));
      await opts.yieldFn();
    }
  }
  const raw = run.finish();
  const sorted = [...raw.workerMsSamples].sort((a, b) => a - b);
  return {
    seed,
    width,
    height,
    framesRendered: raw.framesRendered,
    decoded: raw.decodedPayloads.length,
    total: raw.totalCells,
    decodedPayloads: raw.decodedPayloads,
    falsePositives: raw.falsePositives,
    timeToAllSec: raw.timeToAllSec,
    camera: raw.camera,
    workerMs: { p50: Math.round(pct(sorted, 0.5) * 1000) / 1000, p95: Math.round(pct(sorted, 0.95) * 1000) / 1000 },
  };
}

/**
 * A/B: runs every flag set of the spec over the same seeds and returns rows
 * `{ id, worker, workerMask, seeds: [...], decoded, total, falsePositives, timeToAllSec }`
 * (decoded / FP summed over seeds as the worst case is not meaningful; they are reported per seed and
 * averaged for the headline `decoded` using the first seed to match the single-seed page view).
 */
export async function runAb(spec, opts = {}) {
  const rows = [];
  for (let i = 0; i < spec.flagSets.length; i++) {
    const fs = spec.flagSets[i];
    const perSeed = [];
    for (let s = 0; s < spec.seeds.length; s++) {
      perSeed.push(await runSpecSeed(spec, spec.seeds[s], fs.workerMask, opts));
    }
    rows.push({
      id: fs.id,
      worker: fs.worker,
      workerMask: fs.workerMask,
      seeds: perSeed,
      decoded: perSeed[0].decoded,
      total: perSeed[0].total,
      falsePositives: perSeed.reduce((a, r) => a + r.falsePositives, 0),
      timeToAllSec: perSeed[0].timeToAllSec,
    });
  }
  return rows;
}
