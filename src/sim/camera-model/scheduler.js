/**
 * K1 — Camera Frame Delivery Scheduler (`src/sim/camera-model/scheduler.js`).
 *
 * Models real Android Chrome / Galaxy A53 frame delivery timing:
 *  - Nominal frame cadence (`nominalFps`), stretched by exposure + readout:
 *      `duration = max(1 / nominalFps, exposureSec + readoutSec)`
 *  - Seeded Gaussian rVFC callback jitter + occasional 1-frame stalls (`mulberry32`).
 *  - Main-thread `extractLumaFrame` copy cost (`copyCostMsPerMp` ms per megapixel).
 *  - Busy-worker drop rule (worker only accepts a new frame when idle).
 *  - Sliding-window HUD fps, delivered fps, and dropped frame counter.
 *
 * Zero per-frame heap allocations inside `stepScheduler`.
 * Gated by `enabled` / `simCamera` (default OFF).
 */

import { mulberry32 } from '../cpu-render.js';

export const DEFAULT_SCHEDULER_CONFIG = Object.freeze({
  enabled: false,
  nominalFps: 30,
  exposureSec: 1 / 120,
  readoutSec: 0,
  jitterStdMs: 0.8,
  stallProb: 0.01,
  copyCostMsPerMp: 1.2,
  width: 1280,
  height: 720,
  dropPolicy: 'latest', // 'latest' (HTMLVideoElement latest frame) | 'strict' (drop on busy rVFC)
  hudWindowSec: 1.0,
  seed: 1337,
});

const HUD_RING_CAP = 256;

/**
 * Computes camera frame interval (seconds) stretched by exposure + readout.
 *
 * @param {number} nominalFps
 * @param {number} exposureSec
 * @param {number} [readoutSec=0]
 * @returns {number}
 */
export function computeFrameDurationSec(nominalFps, exposureSec, readoutSec = 0) {
  const fps = nominalFps > 0 ? nominalFps : 30;
  const nominalDur = 1.0 / fps;
  const expDur = (exposureSec > 0 ? exposureSec : 0) + (readoutSec > 0 ? readoutSec : 0);
  return expDur > nominalDur ? expDur : nominalDur;
}

/**
 * Computes main-thread luma extraction copy cost in milliseconds.
 *
 * @param {number} width
 * @param {number} height
 * @param {number} copyCostMsPerMp
 * @returns {number}
 */
export function computeCopyCostMs(width, height, copyCostMsPerMp) {
  if (!(copyCostMsPerMp > 0)) return 0;
  return (width * height * 1e-6) * copyCostMsPerMp;
}

/**
 * Box-Muller standard normal sample using state's seeded PRNG (zero allocation).
 */
function nextGaussian(state) {
  if (state._hasSpareNormal) {
    state._hasSpareNormal = false;
    return state._spareNormal;
  }
  const rng = state._rng;
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12;
  const u2 = rng();
  const mag = Math.sqrt(-2.0 * Math.log(u1));
  const angle = 6.283185307179586 * u2;
  state._spareNormal = mag * Math.sin(angle);
  state._hasSpareNormal = true;
  return mag * Math.cos(angle);
}

/**
 * Records a delivered timestamp into the pre-allocated ring buffer and computes HUD fps.
 */
function recordHudDelivery(state, tDeliverSec) {
  const ring = state._hudRing;
  ring[state._hudHead] = tDeliverSec;
  state._hudHead = (state._hudHead + 1) & (HUD_RING_CAP - 1);
  if (state._hudLen < HUD_RING_CAP) state._hudLen++;

  const n = state._hudLen;
  if (n < 2) {
    return tDeliverSec > 0 ? 1.0 / tDeliverSec : state.nominalFps;
  }

  const windowSec = state.hudWindowSec;
  const cutoff = tDeliverSec - windowSec;
  let count = 0;
  let oldest = tDeliverSec;
  // Walk backwards from most recent entry
  let idx = (state._hudHead - 1) & (HUD_RING_CAP - 1);
  for (let i = 0; i < n; i++) {
    const ts = ring[idx];
    if (ts < cutoff && count >= 2) break;
    oldest = ts;
    count++;
    idx = (idx - 1) & (HUD_RING_CAP - 1);
  }
  const span = tDeliverSec - oldest;
  if (span <= 1e-6) return state.nominalFps;
  return (count - 1) / span;
}

/**
 * Creates a reusable, zero-allocation scheduler state.
 *
 * @param {Partial<typeof DEFAULT_SCHEDULER_CONFIG>} [config]
 */
export function createSchedulerState(config = {}) {
  const state = {
    enabled: Boolean(config.enabled ?? DEFAULT_SCHEDULER_CONFIG.enabled),
    nominalFps: config.nominalFps ?? DEFAULT_SCHEDULER_CONFIG.nominalFps,
    exposureSec: config.exposureSec ?? DEFAULT_SCHEDULER_CONFIG.exposureSec,
    readoutSec: config.readoutSec ?? DEFAULT_SCHEDULER_CONFIG.readoutSec,
    jitterStdMs: config.jitterStdMs ?? DEFAULT_SCHEDULER_CONFIG.jitterStdMs,
    stallProb: config.stallProb ?? DEFAULT_SCHEDULER_CONFIG.stallProb,
    copyCostMsPerMp: config.copyCostMsPerMp ?? DEFAULT_SCHEDULER_CONFIG.copyCostMsPerMp,
    width: (config.width ?? DEFAULT_SCHEDULER_CONFIG.width) | 0,
    height: (config.height ?? DEFAULT_SCHEDULER_CONFIG.height) | 0,
    dropPolicy: config.dropPolicy ?? DEFAULT_SCHEDULER_CONFIG.dropPolicy,
    hudWindowSec: config.hudWindowSec ?? DEFAULT_SCHEDULER_CONFIG.hudWindowSec,
    seed: (config.seed ?? DEFAULT_SCHEDULER_CONFIG.seed) >>> 0,

    // Clock & worker tracking
    tCameraSec: 0,
    tLastCallbackSec: 0,
    workerFreeAtSec: 0,
    hasPendingFrame: false,
    pendingCameraSec: 0,
    pendingWorkerMs: 0,

    // Counters
    cameraCount: 0,
    deliveredCount: 0,
    droppedCount: 0,
    stallCount: 0,
    lastHudFps: 0,

    // Pre-allocated PRNG & ring buffer
    _rng: mulberry32((config.seed ?? DEFAULT_SCHEDULER_CONFIG.seed) >>> 0),
    _hasSpareNormal: false,
    _spareNormal: 0,
    _hudRing: new Float64Array(HUD_RING_CAP),
    _hudHead: 0,
    _hudLen: 0,

    // Reusable per-step output struct
    outEvent: {
      tCameraSec: 0,
      tDeliverSec: 0,
      tCompleteSec: 0,
      durationSec: 0,
      copyMs: 0,
      workerMs: 0,
      jitterMs: 0,
      stalled: false,
      accepted: false,
      droppedThisStep: 0,
      cameraFps: 0,
      deliveredFps: 0,
      hudFps: 0,
      cameraCount: 0,
      deliveredCount: 0,
      droppedCount: 0,
    },
  };
  return state;
}

/**
 * Resets an existing scheduler state in place (zero allocation).
 *
 * @param {ReturnType<typeof createSchedulerState>} state
 * @param {number} [seed]
 */
export function resetSchedulerState(state, seed) {
  if (seed !== undefined) state.seed = seed >>> 0;
  state.tCameraSec = 0;
  state.tLastCallbackSec = 0;
  state.workerFreeAtSec = 0;
  state.hasPendingFrame = false;
  state.pendingCameraSec = 0;
  state.pendingWorkerMs = 0;
  state.cameraCount = 0;
  state.deliveredCount = 0;
  state.droppedCount = 0;
  state.stallCount = 0;
  state.lastHudFps = 0;
  state._rng = mulberry32(state.seed);
  state._hasSpareNormal = false;
  state._spareNormal = 0;
  state._hudHead = 0;
  state._hudLen = 0;
  state._hudRing.fill(0);
}

/**
 * Advances the camera scheduler by one camera frame production interval.
 * Mutates and returns `out` (defaults to `state.outEvent`) with zero heap allocations.
 *
 * @param {ReturnType<typeof createSchedulerState>} state
 * @param {number} [workerMs=6]
 * @param {number} [exposureSec] - overrides state.exposureSec for this frame if provided
 * @param {number} [readoutSec]  - overrides state.readoutSec for this frame if provided
 * @param {object} [out]
 */
export function stepScheduler(state, workerMs = 6, exposureSec, readoutSec, out = state.outEvent) {
  const expSec = exposureSec !== undefined ? exposureSec : state.exposureSec;
  const rdSec = readoutSec !== undefined ? readoutSec : state.readoutSec;
  const baseDur = computeFrameDurationSec(state.nominalFps, expSec, rdSec);

  let jitterMs = 0;
  let stalled = false;
  let copyMs = 0;

  if (state.enabled) {
    if (state.jitterStdMs > 0) {
      jitterMs = nextGaussian(state) * state.jitterStdMs;
      // Clamp jitter to avoid negative/colliding timestamps
      const maxJitterMs = baseDur * 400.0;
      if (jitterMs < -maxJitterMs) jitterMs = -maxJitterMs;
      else if (jitterMs > maxJitterMs) jitterMs = maxJitterMs;
    }
    if (state.stallProb > 0 && state._rng() < state.stallProb) {
      stalled = true;
      state.stallCount++;
    }
    copyMs = computeCopyCostMs(state.width, state.height, state.copyCostMsPerMp);
  }

  const durSec = stalled ? baseDur * 2.0 : baseDur;
  const tNom = state.tCameraSec + durSec;
  let tCallback = tNom + jitterMs * 1e-3;
  if (tCallback <= state.tLastCallbackSec + 1e-6) {
    tCallback = state.tLastCallbackSec + 1e-6;
  }
  state.tCameraSec = tNom;
  state.tLastCallbackSec = tCallback;
  state.cameraCount++;

  let droppedThisStep = 0;
  let accepted = false;
  let tDeliverSec = tCallback;
  let tCompleteSec = state.workerFreeAtSec;
  const wMs = workerMs > 0 ? workerMs : 0;

  if (!state.enabled) {
    // Flag OFF: ideal synchronous delivery at nominal cadence, zero drops
    accepted = true;
    tDeliverSec = tCallback;
    tCompleteSec = tCallback + wMs * 1e-3;
    state.workerFreeAtSec = tCompleteSec;
    state.deliveredCount++;
    state.lastHudFps = recordHudDelivery(state, tDeliverSec);
  } else if (state.dropPolicy === 'strict') {
    // Pure rVFC busy-drop: if worker is still busy at callback time, drop this frame
    if (tCallback >= state.workerFreeAtSec) {
      accepted = true;
      tDeliverSec = tCallback;
      tCompleteSec = tDeliverSec + (copyMs + wMs) * 1e-3;
      state.workerFreeAtSec = tCompleteSec;
      state.deliveredCount++;
      state.lastHudFps = recordHudDelivery(state, tDeliverSec);
    } else {
      accepted = false;
      droppedThisStep = 1;
      state.droppedCount++;
    }
  } else {
    // 'latest' policy: HTMLVideoElement retains the newest frame while worker is busy.
    // First, if a previous frame was waiting and worker finished before this new frame arrived,
    // dispatch that pending frame at workerFreeAtSec.
    if (state.hasPendingFrame && state.workerFreeAtSec <= tCallback) {
      const pDeliver = state.workerFreeAtSec;
      const pComplete = pDeliver + (copyMs + state.pendingWorkerMs) * 1e-3;
      state.workerFreeAtSec = pComplete;
      state.hasPendingFrame = false;
      state.deliveredCount++;
      state.lastHudFps = recordHudDelivery(state, pDeliver);
    }

    if (tCallback >= state.workerFreeAtSec) {
      // Worker is idle when this frame arrives -> accept immediately
      accepted = true;
      tDeliverSec = tCallback;
      tCompleteSec = tDeliverSec + (copyMs + wMs) * 1e-3;
      state.workerFreeAtSec = tCompleteSec;
      state.deliveredCount++;
      state.lastHudFps = recordHudDelivery(state, tDeliverSec);
    } else {
      // Worker is still busy: overwrite any unconsumed pending frame (counting it as dropped)
      if (state.hasPendingFrame) {
        droppedThisStep = 1;
        state.droppedCount++;
      }
      state.hasPendingFrame = true;
      state.pendingCameraSec = tCallback;
      state.pendingWorkerMs = wMs;
      accepted = false;
    }
  }

  const elapsed = tCallback > 0 ? tCallback : 1e-6;
  out.tCameraSec = tCallback;
  out.tDeliverSec = tDeliverSec;
  out.tCompleteSec = tCompleteSec;
  out.durationSec = durSec;
  out.copyMs = copyMs;
  out.workerMs = wMs;
  out.jitterMs = jitterMs;
  out.stalled = stalled;
  out.accepted = accepted;
  out.droppedThisStep = droppedThisStep;
  out.cameraFps = state.cameraCount / elapsed;
  out.deliveredFps = state.deliveredCount / elapsed;
  out.hudFps = state.lastHudFps;
  out.cameraCount = state.cameraCount;
  out.deliveredCount = state.deliveredCount;
  out.droppedCount = state.droppedCount;
  return out;
}

/**
 * Runs a deterministic schedule simulation over `durationSec` seconds and returns summary metrics.
 *
 * @param {number} durationSec
 * @param {Partial<typeof DEFAULT_SCHEDULER_CONFIG>} [config]
 * @param {number | ((tSec: number, frameIdx: number) => number)} [workerMs=6]
 * @param {number | ((tSec: number, frameIdx: number) => number)} [exposureSec]
 */
export function simulateSchedule(durationSec, config = {}, workerMs = 6, exposureSec) {
  const state = createSchedulerState(config);
  const wIsFn = typeof workerMs === 'function';
  const eIsFn = typeof exposureSec === 'function';
  let copySum = 0;
  let steps = 0;

  while (state.tCameraSec < durationSec) {
    const w = wIsFn ? workerMs(state.tCameraSec, steps) : workerMs;
    const e = eIsFn ? exposureSec(state.tCameraSec, steps) : exposureSec;
    const ev = stepScheduler(state, w, e, undefined, state.outEvent);
    copySum += ev.copyMs;
    steps++;
    if (steps > 1000000) break;
  }

  // Flush final pending frame if it completes within durationSec
  if (state.enabled && state.dropPolicy !== 'strict' && state.hasPendingFrame && state.workerFreeAtSec <= durationSec) {
    const copyMs = computeCopyCostMs(state.width, state.height, state.copyCostMsPerMp);
    state.deliveredCount++;
    state.lastHudFps = recordHudDelivery(state, state.workerFreeAtSec);
    state.workerFreeAtSec += (copyMs + state.pendingWorkerMs) * 1e-3;
    state.hasPendingFrame = false;
  }

  const elapsed = state.tCameraSec > 0 ? state.tCameraSec : durationSec;
  return {
    durationSec: elapsed,
    cameraFrames: state.cameraCount,
    deliveredFrames: state.deliveredCount,
    droppedFrames: state.droppedCount,
    stallCount: state.stallCount,
    cameraFps: state.cameraCount / elapsed,
    deliveredFps: state.deliveredCount / elapsed,
    hudFps: state.lastHudFps,
    meanCopyMs: steps > 0 ? copySum / steps : 0,
  };
}
