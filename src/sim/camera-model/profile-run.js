/**
 * K9 — camera-clock frame loop shared by `tools/gate/score.mjs` (headless gate) and
 * `src/sim/ab-run.js` (Labs A/B), so both score a camera profile the same way.
 *
 * Instead of "one frame every 1/fpsCap seconds", frames come from the profile's scheduler: the camera
 * decides when a frame starts and how long it takes (a 100 ms exposure is 10 fps), the busy worker drops
 * frames (fixed virtual worker time, so drops are deterministic), and every delivered frame is rendered
 * with rolling-shutter bands and exposure blur then passed through the K3/K5/K6/K7 post chain.
 *
 * `ideal` never reaches this module (the callers keep their own loop, so `ideal` stays byte-identical).
 *
 * Usage:
 *   const run = createProfileRun(spec, seed, workerMask, { width, height, pipeline });
 *   while (run.step()) { }            // each step = one camera frame (rendered + decoded, or dropped)
 *   const raw = run.finish();
 */

import { sampleCameraPose } from '../paths.js';
import { createCpuRenderContext, mulberry32 } from '../cpu-render.js';
import { createProfileSession } from './profiles.js';
import { FLAG_VERTICAL_MODE } from '../../worker/flagbits.js';

const r4 = (x) => Math.round(x * 10000) / 10000;

/**
 * @param {object} spec  scenario / spec (`width,height,hfovDeg,path,distanceIn,speed,jitter,loop,manualPose,scene,durationSec,profile`)
 * @param {number} seed
 * @param {number} workerMask
 * @param {{ width?: number, height?: number, nowMs?: () => number,
 *           pipeline: { createPipelineState: Function, createPipelineResult: Function,
 *                       processFrameMulti: Function, extractMultiDetections: Function } }} o
 */
export function createProfileRun(spec, seed, workerMask, o) {
  const width = (o.width ?? spec.width) | 0;
  const height = (o.height ?? spec.height) | 0;
  const nowMs = o.nowMs || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const session = createProfileSession(spec.profile, {
    width,
    height,
    seed,
    hfovDeg: spec.hfovDeg,
    distanceIn: spec.distanceIn,
  });
  if (!session) throw new Error('createProfileRun: the ideal profile has no camera session');
  const P = o.pipeline;
  const dtNominal = 1.0 / session.profile.scheduler.nominalFps;
  const durationSec = Math.max(dtNominal, spec.durationSec);
  const isLadder = (spec.scene.label?.orientation || 'ladder') === 'ladder';
  const still = spec.path === 'manual';
  const rng = mulberry32((Math.imul(seed | 0, 0x9e3779b1) ^ 0x13579bdf) >>> 0);
  const phaseOffsetSec = still ? 0 : rng() * dtNominal;

  const expectedSet = new Set(Array.isArray(spec.expectedPayloads)
    ? spec.expectedPayloads
    : spec.scene.cells.map((c) => c.payload));
  const totalCells = expectedSet.size;

  const ctx = createCpuRenderContext(spec.scene.cells.length);
  const luma = new Uint8Array(width * height);
  const ws = P.createPipelineState(width, height);
  ws.flags = workerMask;
  const wr = P.createPipelineResult();
  const poseCfg = {
    distanceIn: spec.distanceIn,
    speedInPerSec: spec.speed,
    jitter: spec.jitter,
    loop: spec.loop !== false,
    manualPose: spec.manualPose || undefined,
  };
  const sampler = (t) => sampleCameraPose(spec.path, t, poseCfg);
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

  const maxFrames = Math.ceil(durationSec * session.profile.scheduler.nominalFps * 1.5) + 16;
  const ms = new Float64Array(maxFrames);
  let delivered = 0;
  const first = new Map();
  const fpList = [];
  let falsePositives = 0;
  let timeToAllSec = null;
  let done = false;

  const run = {
    session,
    width,
    height,
    durationSec,
    /** @returns {boolean} true while more frames remain */
    step() {
      if (done) return false;
      const fr = session.nextFrame();
      if (fr.tStartSec >= durationSec) {
        done = true;
        return false;
      }
      if (!fr.accepted) return true; // dropped: the worker was busy
      renderOpts.frameSeed = seed * 100003 + fr.index * 0.71;
      session.render(spec.scene, sampler, renderOpts, luma, phaseOffsetSec, still);
      const tSec = phaseOffsetSec + fr.tDeliverSec;
      ws.flags = workerMask;
      ws.scanline.mode = isLadder && (workerMask & FLAG_VERTICAL_MODE) !== 0 ? 1 : 0;
      const t0 = nowMs();
      P.processFrameMulti(luma, width, height, ws, wr, false);
      if (delivered < maxFrames) ms[delivered] = nowMs() - t0;
      const f = delivered++;
      const dets = P.extractMultiDetections(ws);
      for (let d = 0; d < dets.length; d++) {
        const payload = dets[d].payload;
        if (!payload) continue;
        if (!expectedSet.has(payload)) {
          falsePositives++;
          fpList.push({ frame: f, tSec: r4(tSec), payload });
          continue;
        }
        if (!first.has(payload)) {
          first.set(payload, r4(tSec));
          if (first.size === totalCells && timeToAllSec === null) timeToAllSec = r4(tSec);
        }
      }
      return true;
    },

    /** Raw per-seed outcome for the caller's own result shape. */
    finish() {
      const n = Math.min(delivered, maxFrames);
      return {
        seed,
        width,
        height,
        framesRendered: delivered,
        cameraFrames: session.cameraFrames,
        totalCells,
        first,
        decodedPayloads: Array.from(first.keys()).sort(),
        falsePositives,
        falsePositivePayloads: fpList,
        timeToAllSec,
        workerMsSamples: Array.from(ms.subarray(0, n)),
        camera: session.summary(durationSec),
        durationSec,
      };
    },
  };
  return run;
}
