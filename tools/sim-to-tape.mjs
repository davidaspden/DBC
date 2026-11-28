#!/usr/bin/env node
/**
 * T4 — Sim-to-tape export (`tools/sim-to-tape.mjs`).
 *
 * Renders a gate scenario seed frame by frame (same loop as `runScenarioSeed` in
 * `tools/gate/score.mjs`: same seeded phase, poses, shutter sub-frames and `frameSeed`) and writes the
 * frames to a `.dbct` v1 tape with the real recorder (`src/tape/record.js`). Each frame carries:
 *   - `expectedPayloads`: the scene payloads the worker actually decoded on that frame (golden),
 *   - `tSec`/`tFrameMs`: the sim clock,
 *   - `sensorSample`: a synthesised, noise-free, deterministic IMU sample derived from the pose
 *     (`source: 'sim-synth'`; placeholder until R7's sensor synthesiser lands),
 * and the header `meta` carries the scenario id, seed, flags, worker mask, vertical-mode switch, the
 * full expected payload list and the direct-run summary.
 *
 * `replayScenarioTape()` replays such a tape exactly like the gate does (one pipeline state,
 * `state.flags` = mask, `scanline.mode` from the header) and returns the same decode summary, so
 * export -> replay equals the direct run (same decodes, same false positives).
 *
 * Note: `tools/replay.mjs` replays the same tape too, but does not set `scanline.mode`, so tapes of
 * `verticalMode` scenarios only round-trip exactly through `replayScenarioTape()`.
 *
 * Usage:
 *   node tools/sim-to-tape.mjs --preset fc-8-3p5 --out tapes/sim-fc-8-3p5.dbct [--seed 1]
 *        [--flags off|W-fc|W-all|strict|single:<flag>] [--duration 4] [--verify]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { sampleCameraPose } from '../src/sim/paths.js';
import { createCpuRenderContext, renderFrame, mulberry32 } from '../src/sim/cpu-render.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import { FLAG_VERTICAL_MODE } from '../src/worker/flagbits.js';
import { createTapeRecorder } from '../src/tape/record.js';
import { parseTapeBytes } from './replay.mjs';

const DEG2RAD = Math.PI / 180;

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

/** Seeded sweep-phase offset, identical to `runScenarioSeed`. */
export function scenarioPhaseOffsetSec(scenario, seed) {
  const fpsCap = scenario.fpsCap > 0 ? scenario.fpsCap : 30;
  const dtSec = 1.0 / fpsCap;
  const rng = mulberry32((Math.imul(seed | 0, 0x9e3779b1) ^ 0x13579bdf) >>> 0);
  return scenario.path === 'manual' ? 0 : rng() * dtSec;
}

/** `true` when the gate would switch the scanline stage to vertical mode for this scenario. */
export function scenarioUsesVerticalMode(scenario) {
  const mask = (scenario.flags?.workerMask | 0) || 0;
  const isLadder = (scenario.scene.label?.orientation || 'ladder') === 'ladder';
  return isLadder && (mask & FLAG_VERTICAL_MODE) !== 0;
}

/** Unit quaternion [x, y, z, w] for yaw (about +Y), pitch (about +X), roll (about -Z, the view axis). */
function poseQuaternion(yawDeg, pitchDeg, rollDeg) {
  const hy = yawDeg * DEG2RAD * 0.5;
  const hp = pitchDeg * DEG2RAD * 0.5;
  const hr = -rollDeg * DEG2RAD * 0.5;
  const qy = [0, Math.sin(hy), 0, Math.cos(hy)];
  const qp = [Math.sin(hp), 0, 0, Math.cos(hp)];
  const qr = [0, 0, Math.sin(hr), Math.cos(hr)];
  const mul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  return mul(mul(qy, qp), qr).map((v) => round4(v));
}

/**
 * Synthesises a deterministic sensor sample from the sim pose path (no bias/noise/drift; R7 adds
 * those). Field names follow the AR recorder's `sensorSample` (`q`, `wPanDps`, `wPitchDps`, `source`).
 */
export function synthSensorSample(scenario, poseCfg, tSec, pose) {
  const h = 1 / 120;
  const a = sampleCameraPose(scenario.path, Math.max(0, tSec - h), poseCfg);
  const b = sampleCameraPose(scenario.path, tSec + h, poseCfg);
  const span = tSec - Math.max(0, tSec - h) + h;
  const wPanDps = span > 0 ? (b.yawDeg - a.yawDeg) / span : 0;
  const wPitchDps = span > 0 ? (b.pitchDeg - a.pitchDeg) / span : 0;
  const wRollDps = span > 0 ? (b.rollDeg - a.rollDeg) / span : 0;
  return {
    source: 'sim-synth',
    q: poseQuaternion(pose.yawDeg, pose.pitchDeg, pose.rollDeg),
    wPanDps: round4(wPanDps),
    wPitchDps: round4(wPitchDps),
    rotRate: { alpha: round4(wRollDps), beta: round4(wPitchDps), gamma: round4(wPanDps) },
    accel: { x: 0, y: 0, z: 9.80665 },
    simPose: {
      x: round4(pose.x),
      y: round4(pose.y),
      z: round4(pose.z),
      yawDeg: round4(pose.yawDeg),
      pitchDeg: round4(pose.pitchDeg),
      rollDeg: round4(pose.rollDeg),
    },
  };
}

/**
 * Accumulates the gate's per-seed decode metrics (decoded set, per-label first time, time to all,
 * false positives) from per-frame detections, so a direct run and a tape replay are scored by the
 * same code.
 */
export function createDecodeScorer(expectedPayloads) {
  const expectedSet = new Set(expectedPayloads);
  const totalCells = expectedSet.size;
  const timeToFirst = new Map();
  const fpPayloads = [];
  let falsePositives = 0;
  let timeToAllSec = null;
  const perFrame = [];
  return {
    add(frameIndex, tSec, detections) {
      const framePayloads = [];
      for (let d = 0; d < detections.length; d++) {
        const payload = detections[d].payload;
        if (!payload) continue;
        framePayloads.push(payload);
        if (!expectedSet.has(payload)) {
          falsePositives++;
          fpPayloads.push({ frame: frameIndex, tSec: round4(tSec), payload });
          continue;
        }
        if (!timeToFirst.has(payload)) {
          timeToFirst.set(payload, round4(tSec));
          if (timeToFirst.size === totalCells && timeToAllSec === null) timeToAllSec = round4(tSec);
        }
      }
      perFrame.push(framePayloads);
    },
    result() {
      const decodedPayloads = Array.from(timeToFirst.keys()).sort();
      const timeToFirstByLabel = {};
      for (const p of decodedPayloads) timeToFirstByLabel[p] = timeToFirst.get(p);
      return {
        framesRendered: perFrame.length,
        decodedCount: decodedPayloads.length,
        totalCells,
        lockedAll: decodedPayloads.length === totalCells && totalCells > 0,
        timeToAllSec,
        decodedPayloads,
        timeToFirstByLabel,
        falsePositives,
        falsePositivePayloads: fpPayloads,
        perFrame,
      };
    },
  };
}

/**
 * Renders one scenario seed and packs it into a `.dbct` v1 tape.
 *
 * @param {object} scenario  from `createScenarioFromPreset` (`tools/gate/scenarios.mjs`)
 * @param {number} seed
 * @param {{ createdBy?: string, frameHook?: (luma: Uint8Array, info: object) => void }} [opts]
 *   `frameHook` runs on each rendered frame before it is decoded and recorded (the slot for the
 *   camera model / K9 profiles).
 * @returns {Promise<{ bytes: Uint8Array, summary: object, meta: object }>}
 */
export async function exportScenarioTape(scenario, seed, opts = {}) {
  const width = scenario.width | 0;
  const height = scenario.height | 0;
  const fpsCap = scenario.fpsCap > 0 ? scenario.fpsCap : 30;
  const dtSec = 1.0 / fpsCap;
  const durationSec = Math.max(dtSec, scenario.durationSec);
  const frameCount = Math.max(1, Math.floor(durationSec * fpsCap + 1e-9));
  const shutterSec = (scenario.shutterMs || 0) * 0.001;
  const workerMask = (scenario.flags?.workerMask | 0) || 0;
  const vertical = scenarioUsesVerticalMode(scenario);
  const phaseOffsetSec = scenarioPhaseOffsetSec(scenario, seed);
  const expectedList = Array.isArray(scenario.expectedPayloads)
    ? scenario.expectedPayloads
    : scenario.scene.cells.map((c) => c.payload);

  const ctx = createCpuRenderContext(scenario.scene.cells.length);
  const luma = new Uint8Array(width * height);
  const workerState = createPipelineState(width, height);
  const workerResult = createPipelineResult();
  const scorer = createDecodeScorer(expectedList);
  const expectedSet = new Set(expectedList);

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

  const headerMeta = {
    source: 'sim-to-tape',
    createdBy: opts.createdBy || 'tools/sim-to-tape.mjs',
    scenarioId: scenario.id,
    presetId: scenario.presetId,
    profile: scenario.profile,
    seed,
    flagSet: scenario.flags.id,
    workerFlags: [...scenario.flags.worker],
    workerMask,
    vertical,
    width,
    height,
    fpsCap,
    hfovDeg: scenario.hfovDeg,
    durationSec,
    frameCount,
    phaseOffsetSec,
    expectedPayloads: [...expectedList],
  };
  const rec = createTapeRecorder({
    maxFrames: frameCount,
    maxBytes: Number.MAX_SAFE_INTEGER,
    everyNth: 1,
    compress: true,
    meta: headerMeta,
  });
  rec.start();

  for (let f = 0; f < frameCount; f++) {
    const tSec = phaseOffsetSec + f * dtSec;
    const pose = sampleCameraPose(scenario.path, tSec, poseCfg);
    let poses;
    if (shutterSec > 0 && scenario.path !== 'manual' && !pose.finished) {
      const subFrames = scenario.shutterMs >= 8 ? 7 : 5;
      poses = new Array(subFrames);
      for (let k = 0; k < subFrames; k++) {
        const frac = k / (subFrames - 1) - 0.5;
        const ts = Math.max(0, tSec + frac * shutterSec);
        poses[k] = sampleCameraPose(scenario.path, ts, poseCfg);
      }
    } else {
      poses = [pose];
    }
    renderOpts.frameSeed = seed * 100003 + f * 0.71;
    renderFrame(scenario.scene, poses, renderOpts, luma);
    if (opts.frameHook) opts.frameHook(luma, { frame: f, tSec, pose, width, height });

    workerState.flags = workerMask;
    workerState.scanline.mode = vertical ? 1 : 0;
    processFrameMulti(luma, width, height, workerState, workerResult, false);
    const dets = extractMultiDetections(workerState);
    scorer.add(f, tSec, dets);

    const golden = [];
    for (const d of dets) if (d.payload && expectedSet.has(d.payload) && !golden.includes(d.payload)) golden.push(d.payload);

    const ok = await rec.pushFrame({
      frameId: f,
      tFrameMs: tSec * 1000,
      fps: fpsCap,
      width,
      height,
      cropX: 0,
      cropY: 0,
      luma,
      expectedPayloads: golden,
      sensorSample: { tSec, ...synthSensorSample(scenario, poseCfg, tSec, pose) },
    });
    if (!ok) throw new Error(`recorder refused frame ${f}`);
  }
  rec.stop();
  const bytes = rec.exportBytes();
  const { perFrame, ...summary } = scorer.result();
  return { bytes, summary, perFrame: perFrame, meta: headerMeta };
}

/**
 * Replays a parsed `.dbct` produced by `exportScenarioTape` the way the gate runs it and returns
 * the same decode summary. Pass `workerMask` to override the recorded flags (A/B on one tape).
 *
 * @param {{ header: object, frames: Array<{ meta: object, luma: Uint8Array }> }} parsed
 * @param {{ workerMask?: number, vertical?: boolean }} [opts]
 */
export function replayScenarioTape(parsed, opts = {}) {
  const hm = parsed.header.meta || {};
  const workerMask = opts.workerMask !== undefined ? opts.workerMask | 0 : (hm.workerMask | 0);
  const vertical =
    opts.vertical !== undefined
      ? Boolean(opts.vertical)
      : opts.workerMask !== undefined
        ? (workerMask & FLAG_VERTICAL_MODE) !== 0
        : Boolean(hm.vertical);
  const expected = Array.isArray(hm.expectedPayloads) ? hm.expectedPayloads : [];
  const scorer = createDecodeScorer(expected);
  let state = null;
  const result = createPipelineResult();
  for (let i = 0; i < parsed.frames.length; i++) {
    const { meta, luma } = parsed.frames[i];
    const w = meta.width | 0;
    const h = meta.height | 0;
    if (!state || state.width !== w || state.height !== h) state = createPipelineState(w, h);
    state.flags = workerMask;
    state.scanline.mode = vertical ? 1 : 0;
    processFrameMulti(luma, w, h, state, result, false);
    const tSec = Number.isFinite(meta.sensorSample?.tSec) ? meta.sensorSample.tSec : meta.tFrameMs / 1000;
    scorer.add(meta.frameId | 0, tSec, extractMultiDetections(state));
  }
  const { perFrame, ...summary } = scorer.result();
  return { ...summary, perFrame };
}

/** Compares two decode summaries; returns a list of human-readable differences (empty = identical). */
export function diffDecodeSummaries(a, b) {
  const diffs = [];
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  for (const k of ['framesRendered', 'decodedCount', 'totalCells', 'lockedAll', 'timeToAllSec', 'decodedPayloads', 'timeToFirstByLabel', 'falsePositives', 'falsePositivePayloads']) {
    if (!same(a[k], b[k])) diffs.push(`${k}: ${JSON.stringify(a[k])} vs ${JSON.stringify(b[k])}`);
  }
  if (a.perFrame && b.perFrame && !same(a.perFrame, b.perFrame)) diffs.push('perFrame payload lists differ');
  return diffs;
}

// CLI entrypoint
if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('sim-to-tape.mjs')) {
  const { createScenarioFromPreset } = await import('./gate/scenarios.mjs');
  const args = process.argv.slice(2);
  const opt = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
  };
  const preset = opt('--preset');
  const out = opt('--out');
  if (!preset || !out) {
    console.error('Usage: node tools/sim-to-tape.mjs --preset <id> --out <file.dbct> [--seed 1] [--flags off] [--duration sec] [--verify]');
    process.exit(2);
  }
  const seed = Number(opt('--seed', '1'));
  const durationArg = opt('--duration', null);
  const scenario = createScenarioFromPreset(preset, {
    flagSet: opt('--flags', 'off'),
    ...(durationArg !== null ? { durationSec: Number(durationArg) } : {}),
  });
  const { bytes, summary, perFrame, meta } = await exportScenarioTape(scenario, seed);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  const sidecar = {
    version: 1,
    name: out.replace(/^.*[\\/]/, '').replace(/\.dbct$/, ''),
    recordedUtc: new Date().toISOString(),
    device: { model: 'sim', diagReportId: null, cameraLabel: 'sim cpu-render', resolution: `${meta.width}x${meta.height}`, exposureMode: 'n/a', exposureMs: null, iso: null, torch: false },
    lighting: { condition: 'sim', lux: null, notes: `profile ${meta.profile}` },
    distance: { nominalIn: scenario.distanceIn, measuredBy: 'sim' },
    labels: meta.expectedPayloads.map((payload) => ({ payload, orientation: scenario.scene.label?.orientation || 'ladder' })),
    notes: `Exported by tools/sim-to-tape.mjs: preset ${preset}, seed ${seed}, flags ${meta.flagSet}, ${meta.frameCount} frames @ ${meta.fpsCap} fps. Synthetic sensorSample (source sim-synth).`,
  };
  writeFileSync(out.replace(/\.dbct$/, '') + '.json', JSON.stringify(sidecar, null, 2) + '\n');
  console.log(`Wrote ${out} (${(bytes.length / 1024).toFixed(0)} KiB, ${meta.frameCount} frames); direct run decoded ${summary.decodedCount}/${summary.totalCells}, FP ${summary.falsePositives}`);
  if (args.includes('--verify')) {
    const rep = replayScenarioTape(parseTapeBytes(bytes));
    const diffs = diffDecodeSummaries({ ...summary, perFrame }, rep);
    if (diffs.length) {
      console.error('ROUND TRIP MISMATCH:\n  ' + diffs.join('\n  '));
      process.exit(1);
    }
    console.log('Round trip OK: replay decodes and false positives equal the direct run.');
  }
}
