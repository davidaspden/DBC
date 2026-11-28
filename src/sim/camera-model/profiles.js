/**
 * K9 — Camera profiles and wiring (`src/sim/camera-model/profiles.js`).
 *
 * A profile bundles the K1–K7 models (frame scheduler, exposure/ISO, sensor, optics, rolling shutter,
 * compression, glare) plus a fixed device factor into one name. `ideal` is "all off": the session for it
 * is `null` and callers skip the camera model entirely, so `ideal` output equals the output before K9
 * byte for byte.
 *
 * All numbers below are **provisional priors** (fitted later by G7 against real tapes). They are mirrored
 * in `profiles/<id>.json` for tools and humans; `tests/camera-profiles.test.js` fails if the two drift.
 *
 * Wiring (headless gate and Labs A/B share it): per camera frame
 *   `nextFrame(workerMs)`  -> steps K2 exposure (AE or locked) and K1 scheduler: when the frame starts,
 *                             how long it takes (exposure stretches it: 100 ms exposure = 10 fps), and
 *                             whether the busy worker takes it or it is dropped;
 *   `render(...)`          -> K4 rolling-shutter bands over the CPU renderer, each band blurred over the
 *                             exposure window (sub-poses), then K7 glare -> K5 optics -> K3 sensor -> K6 JPEG.
 *
 * Memory rule: everything the per-frame calls touch is allocated in `createProfileSession`. The only
 * allocations during a run are the pose objects the caller's `sampler(tSec)` returns (harness level).
 *
 * Known limits (documented, not hidden):
 *  - The browser (GL) path has no rolling-shutter bands: the GL renderer draws one pose per frame. The
 *    hook applies glare/optics/sensor/compression to the read-back luma and drives shutter blur + fps cap.
 *  - The scheduler is fed a fixed virtual worker time (`workerMsModel`), not the measured one, so frame
 *    drops are deterministic (same seed, same bytes).
 *  - The frame period is `max(1/fps, exposure)`: sensor readout overlaps the next exposure on real
 *    hardware, so the readout time is only used for the rolling-shutter skew, not for the frame period.
 */

import { stepScheduler, createSchedulerState } from './scheduler.js';
import { createExposureState, stepExposure, applyLockedExposure } from './exposure.js';
import { createSensorState, applySensorModel } from './sensor.js';
import { createOpticsState, applyOpticsModel, stepAutofocus } from './optics.js';
import { createRollingState } from './rolling.js';
import { createCompressState, applyCompression } from './compress.js';
import { createGlareState, applyGlareModel, computeTorchLuxBoost } from './glare.js';
import { renderFrame } from '../cpu-render.js';

export const CAMERA_PROFILE_IDS = Object.freeze([
  'ideal',
  'a53-fc-normal',
  'a53-fc-lowlight-10fps',
  'a53-fc-lowlight-locked',
  'a53-torch-glare',
]);

const MAX_SUBPOSES = 7;

// Shared provisional building blocks --------------------------------------------------------------
const A53_SCHEDULER = {
  nominalFps: 30,
  jitterStdMs: 0.8,
  stallProb: 0.01,
  copyCostMsPerMp: 1.2,
  dropPolicy: 'latest',
};
// 4 bands: each band is a full renderFrame call (the CPU renderer cannot clip rows), so band count is the cost knob
const A53_ROLLING = { readoutMs: 25, bandCount: 4 };
const A53_OPTICS_MILD = {
  defocusEnabled: true,
  demosaicEnabled: true,
  demosaicStrength: 0.18,
  vignetteEnabled: true,
  vignetteStrength: 0.22,
  distortionEnabled: true,
  k1: -0.06,
  sharpenEnabled: true,
  sharpenAmount: 0.4,
  sharpenRadiusPx: 1.5,
};

function freezeDeep(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) freezeDeep(o[k]);
  }
  return o;
}

export const CAMERA_PROFILES = freezeDeep({
  ideal: {
    id: 'ideal',
    label: 'ideal (no camera model)',
    description: 'All camera-model stages off. Output equals the pre-K9 renderer byte for byte.',
    ideal: true,
    fidelity: 'ideal',
  },

  'a53-fc-normal': {
    id: 'a53-fc-normal',
    label: 'A53, FC warehouse light, AE, 30 fps',
    description: 'Fluorescent warehouse (about 400 lux), auto exposure about 16 ms at ISO about 180, 30 fps, 25 ms rolling readout, mild sharpening, JPEG quality 85, semi-gloss labels.',
    ideal: false,
    fidelity: 'provisional',
    deviceFactorA53: 8.09,
    workerMsModel: 25,
    scheduler: { ...A53_SCHEDULER },
    exposure: { mode: 'continuous', lux: 400, minFrameRate: 15, strictFrameRateCeiling: false, initialExposureMs: 16.67, initialIso: 180 },
    sensor: { iso: 180 },
    optics: { ...A53_OPTICS_MILD },
    rolling: { ...A53_ROLLING },
    compress: { quality: 85 },
    glare: { gloss: 0.5, roomGlareEnabled: true, roomIntensity: 0.35, torchEnabled: false },
  },

  'a53-fc-lowlight-10fps': {
    id: 'a53-fc-lowlight-10fps',
    label: 'A53, low light, AE walks to 100 ms, 10 fps',
    description: 'About 25 lux: AE runs the shutter to the 100 ms ceiling, ISO about 480, so the camera delivers 10 fps with strong motion blur and heavy noise; JPEG quality 75. Reproduces the live 10 fps seen on the phone.',
    ideal: false,
    fidelity: 'provisional',
    deviceFactorA53: 8.09,
    workerMsModel: 25,
    scheduler: { ...A53_SCHEDULER },
    exposure: { mode: 'continuous', lux: 25, minFrameRate: 15, strictFrameRateCeiling: false, initialExposureMs: 100, initialIso: 480 },
    sensor: { iso: 480, shotCoeff: 0.022, readNoiseBase: 0.005 },
    optics: { ...A53_OPTICS_MILD, sharpenAmount: 0.3 },
    rolling: { ...A53_ROLLING },
    compress: { quality: 75 },
    glare: { gloss: 0.5, roomGlareEnabled: true, roomIntensity: 0.35, torchEnabled: false },
  },

  'a53-fc-lowlight-locked': {
    id: 'a53-fc-lowlight-locked',
    label: 'A53, low light, locked 5 ms / ISO 3200, 30 fps (PP2 prediction)',
    description: 'The same light as the 10 fps profile with the PP2 behaviour: exposure locked at 5 ms, ISO 3200, minimum frame rate 30. Sharp bars and 30 fps, paid for with underexposure (about 1.6 EV dark) and heavy noise. Predicts what PP2 buys; it needs PP2 in src/camera.js to exist for real.',
    ideal: false,
    fidelity: 'provisional',
    requires: 'PP2',
    deviceFactorA53: 8.09,
    workerMsModel: 25,
    scheduler: { ...A53_SCHEDULER },
    exposure: { mode: 'manual', lux: 25, minFrameRate: 30, strictFrameRateCeiling: true, manualExposureMs: 5, manualIso: 3200, initialExposureMs: 5, initialIso: 3200 },
    sensor: { iso: 3200, shotCoeff: 0.022, readNoiseBase: 0.005 },
    optics: { ...A53_OPTICS_MILD, sharpenAmount: 0.3 },
    rolling: { ...A53_ROLLING },
    compress: { quality: 75 },
    glare: { gloss: 0.5, roomGlareEnabled: true, roomIntensity: 0.35, torchEnabled: false },
  },

  'a53-torch-glare': {
    id: 'a53-torch-glare',
    label: 'A53, torch on, glossy labels, hotspots',
    description: 'Dim aisle (about 25 lux) with the torch on at the camera: the torch adds about 900 lux at 12 in, AE drops to a fast shutter, glossy stock gives a specular hotspot that moves with the pose and washes out bars.',
    ideal: false,
    fidelity: 'provisional',
    deviceFactorA53: 8.09,
    workerMsModel: 25,
    scheduler: { ...A53_SCHEDULER },
    exposure: { mode: 'continuous', lux: 25, minFrameRate: 15, strictFrameRateCeiling: false, initialExposureMs: 4, initialIso: 100 },
    sensor: { iso: 100 },
    optics: { ...A53_OPTICS_MILD },
    rolling: { ...A53_ROLLING },
    compress: { quality: 85 },
    glare: { gloss: 1.0, roomGlareEnabled: true, roomIntensity: 0.35, torchEnabled: true, torchIntensity: 0.95 },
  },
});

export function getCameraProfile(id) {
  const p = CAMERA_PROFILES[id];
  if (!p) throw new Error(`Unknown camera profile: ${id}`);
  return p;
}

export function isKnownCameraProfile(id) {
  return Object.prototype.hasOwnProperty.call(CAMERA_PROFILES, id);
}

export function listCameraProfiles() {
  return CAMERA_PROFILE_IDS.map((id) => CAMERA_PROFILES[id]);
}

/**
 * Creates the per-run camera session for `profileId` (one per seed/run; pre-allocates every buffer).
 * Returns `null` for `ideal` so callers keep their existing code path untouched.
 *
 * @param {string} profileId
 * @param {{ width: number, height: number, seed?: number, hfovDeg?: number, distanceIn?: number }} o
 */
export function createProfileSession(profileId, o) {
  const p = getCameraProfile(profileId);
  if (p.ideal) return null;
  const width = o.width | 0;
  const height = o.height | 0;
  const seed = (o.seed ?? 1) >>> 0;
  const hfovDeg = o.hfovDeg ?? 70.7;
  const n = Math.imul(width, height);

  const sched = createSchedulerState({
    ...p.scheduler,
    enabled: true,
    width,
    height,
    exposureSec: (p.exposure.initialExposureMs ?? 12) * 1e-3,
    readoutSec: 0,
    seed: (Math.imul(seed, 0x9e3779b1) ^ 0x1badf00d) >>> 0,
  });
  const exp = createExposureState({
    ...p.exposure,
    enabled: true,
    nominalFps: p.scheduler.nominalFps,
  });
  if (p.exposure.mode === 'manual') {
    applyLockedExposure(exp, p.exposure.manualExposureMs, p.exposure.manualIso, p.exposure.minFrameRate);
  }
  const sensor = createSensorState(width, height, {
    ...p.sensor,
    enabled: true,
    seed: (Math.imul(seed, 0x85ebca6b) ^ 0x2545f491) >>> 0,
  });
  const optics = createOpticsState(width, height, { ...p.optics, enabled: true });
  const bandCount = Math.max(1, p.rolling.bandCount | 0);
  const rolling = createRollingState(width, height, { readoutMs: p.rolling.readoutMs, bandHeight: Math.ceil(height / bandCount), enabled: true });
  const compress = createCompressState({ ...p.compress, enabled: true });
  const glare = createGlareState({ ...p.glare, enabled: true });

  // one exact-length array per sub-pose count (renderFrame reads `poses.length`)
  const poseArrays = { 1: new Array(1), 5: new Array(5), 7: new Array(MAX_SUBPOSES) };
  const bandOpts = {};

  const frame = {
    index: -1,
    tStartSec: 0,
    exposureSec: 0,
    exposureMs: 0,
    iso: 0,
    exposureGain: 1,
    durationSec: 0,
    tDeliverSec: 0,
    accepted: false,
    stalled: false,
  };

  const session = {
    profile: p,
    profileId: p.id,
    width,
    height,
    hfovDeg,
    frame,
    sched,
    exp,
    sensor,
    optics,
    rolling,
    compress,
    glare,
    lastDurSec: 1 / p.scheduler.nominalFps,
    distanceIn: o.distanceIn ?? 12,
    // running stats (no arrays: zero alloc)
    cameraFrames: 0,
    expSumMs: 0,
    isoSum: 0,
    gainSum: 0,
    expMinMs: Infinity,
    expMaxMs: 0,
    poseArrays,
    bandOpts,

    /**
     * Advances exposure (K2) and the scheduler (K1) by one camera frame and fills `session.frame`.
     * @param {number} [workerMs] virtual worker time for the busy-drop rule (default: the profile's model)
     */
    nextFrame(workerMs) {
      const fr = this.frame;
      const torch = computeTorchLuxBoost(this.distanceIn, this.glare);
      const e = stepExposure(this.exp, this.lastDurSec, torch, undefined, this.exp.outExposure);
      const tStart = this.sched.tCameraSec;
      const ev = stepScheduler(this.sched, workerMs !== undefined ? workerMs : this.profile.workerMsModel, e.exposureSec, 0, this.sched.outEvent);
      fr.index++;
      fr.tStartSec = tStart;
      fr.exposureSec = e.exposureSec;
      fr.exposureMs = e.exposureTimeMs;
      fr.iso = e.iso;
      fr.exposureGain = e.exposureGain;
      fr.durationSec = ev.durationSec;
      fr.tDeliverSec = ev.tDeliverSec;
      fr.accepted = ev.accepted;
      fr.stalled = ev.stalled;
      this.lastDurSec = ev.durationSec;
      this.cameraFrames++;
      this.expSumMs += e.exposureTimeMs;
      this.isoSum += e.iso;
      this.gainSum += e.exposureGain;
      if (e.exposureTimeMs < this.expMinMs) this.expMinMs = e.exposureTimeMs;
      if (e.exposureTimeMs > this.expMaxMs) this.expMaxMs = e.exposureTimeMs;
      return fr;
    },

    /** Number of sub-poses used to blur over an exposure of `exposureSec`. */
    subPoseCount(exposureSec) {
      // 7 sub-poses from 8 ms exposure, 5 from 0.5 ms, else 1 (matches the sim.html / score.mjs shutter rule)
      const ms = exposureSec * 1000;
      return ms >= 8 ? MAX_SUBPOSES : (ms >= 0.5 ? 5 : 1);
    },

    /**
     * Renders the current `frame` into `luma`: rolling-shutter bands, each blurred over the exposure
     * window, then glare -> optics -> sensor -> JPEG.
     *
     * @param {object} scene
     * @param {(tSec: number) => object} sampler  absolute-time pose sampler (caller supplies; allocates poses)
     * @param {object} renderOpts  `renderFrame` options (width, height, hfovDeg, ... ctx, frameSeed)
     * @param {Uint8Array} luma
     * @param {number} tBaseSec  scenario time of camera t = 0 (the seed's phase offset)
     * @param {boolean} [still]  true for a static path (no blur / skew needed)
     */
    render(scene, sampler, renderOpts, luma, tBaseSec, still = false) {
      const fr = this.frame;
      const w = this.width;
      const h = this.height;
      const nSub = still ? 1 : this.subPoseCount(fr.exposureSec);
      const readoutSec = this.rolling.readoutMs * 1e-3;
      const bandH = this.rolling.bandHeight > 0 ? this.rolling.bandHeight : 8;
      const scratch = this.rolling.scratchFrame;
      const subPoses = this.poseArrays[nSub];
      const bo = this.bandOpts;
      bo.width = w;
      bo.height = h;
      bo.hfovDeg = renderOpts.hfovDeg;
      bo.shadowStrength = renderOpts.shadowStrength;
      bo.noiseStrength = renderOpts.noiseStrength;
      bo.glareStrength = renderOpts.glareStrength;
      bo.labelWidthIn = renderOpts.labelWidthIn;
      bo.labelHeightIn = renderOpts.labelHeightIn;
      bo.labelOrientation = renderOpts.labelOrientation;
      bo.printGain = renderOpts.printGain;
      bo.frameSeed = renderOpts.frameSeed;
      bo.seed = renderOpts.seed;
      bo.ctx = renderOpts.ctx || this.rolling.cpuCtx;

      const invH = 1.0 / h;
      const bandCount = still ? 1 : Math.ceil(h / bandH);
      let midPose = null;
      for (let b = 0; b < bandCount; b++) {
        const y0 = still ? 0 : b * bandH;
        const y1 = still ? h : (y0 + bandH < h ? y0 + bandH : h);
        const frac = still ? 0 : ((y0 + y1) * 0.5) * invH;
        const tRowStart = tBaseSec + fr.tStartSec + frac * readoutSec;
        const tCenter = tRowStart + fr.exposureSec * 0.5;
        for (let k = 0; k < nSub; k++) {
          const f = nSub > 1 ? (k / (nSub - 1)) - 0.5 : 0;
          const t = tCenter + f * fr.exposureSec;
          subPoses[k] = sampler(t > 0 ? t : 0);
        }
        if (still) {
          renderFrame(scene, subPoses, bo, luma);
        } else {
          renderFrame(scene, subPoses, bo, scratch);
          const s0 = Math.imul(y0, w);
          const s1 = Math.imul(y1, w);
          for (let i = s0; i < s1; i++) luma[i] = scratch[i];
        }
        if (b === (bandCount >> 1)) midPose = subPoses[nSub >> 1];
      }
      this.postProcess(luma, midPose);
      return luma;
    },

    /**
     * Applies glare -> optics (with AF hunting) -> sensor -> JPEG to `luma` in place (zero allocation).
     * Used directly by the browser hook on the read-back GL frame.
     * @param {Uint8Array} luma
     * @param {object | null} pose  `{ x, y, z, yawDeg, pitchDeg, rollDeg }` (z in inches)
     */
    postProcess(luma, pose) {
      const fr = this.frame;
      const dt = this.lastDurSec;
      if (pose) {
        this.distanceIn = pose.z;
        applyGlareModel(luma, this.width, this.height, pose, this.hfovDeg, this.glare, luma);
        this.optics.subjectDistM = pose.z * 0.0254;
        stepAutofocus(this.optics, dt, this.optics.subjectDistM, 1.0);
      }
      applyOpticsModel(luma, this.width, this.height, this.optics, luma);
      this.sensor.iso = fr.iso;
      this.sensor.exposureGain = fr.exposureGain;
      applySensorModel(luma, this.width, this.height, this.sensor, luma, fr.index);
      applyCompression(luma, this.width, this.height, this.compress, luma);
      return luma;
    },

    /** Summary of what the camera did (deterministic; goes into the gate JSON). */
    summary(durationSec) {
      const s = this.sched;
      const frames = this.cameraFrames > 0 ? this.cameraFrames : 1;
      const dur = durationSec > 0 ? durationSec : (s.tCameraSec || 1);
      return {
        profile: this.profileId,
        cameraFrames: this.cameraFrames,
        deliveredFrames: s.deliveredCount,
        droppedFrames: s.droppedCount,
        stalls: s.stallCount,
        cameraFps: Math.round((this.cameraFrames / dur) * 1000) / 1000,
        deliveredFps: Math.round((s.deliveredCount / dur) * 1000) / 1000,
        exposureMsMean: Math.round((this.expSumMs / frames) * 1000) / 1000,
        exposureMsMin: Math.round((this.cameraFrames ? this.expMinMs : 0) * 1000) / 1000,
        exposureMsMax: Math.round(this.expMaxMs * 1000) / 1000,
        isoMean: Math.round((this.isoSum / frames) * 10) / 10,
        exposureGainMean: Math.round((this.gainSum / frames) * 1000) / 1000,
      };
    },
  };
  return session;
}
