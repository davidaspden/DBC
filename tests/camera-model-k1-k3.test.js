/**
 * K1–K3 Camera-Pipeline Model Unit Tests (`tests/camera-model-k1-k3.test.js`).
 *   node tests/camera-model-k1-k3.test.js
 *   node --expose-gc tests/camera-model-k1-k3.test.js
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_SCHEDULER_CONFIG,
  computeFrameDurationSec,
  computeCopyCostMs,
  createSchedulerState,
  resetSchedulerState,
  stepScheduler,
  simulateSchedule,
} from '../src/sim/camera-model/scheduler.js';
import {
  A53_EXPOSURE_LIMITS,
  DEFAULT_EXPOSURE_CONFIG,
  resolveLux,
  exposureMsToChromeUnits,
  chromeUnitsToExposureMs,
  createExposureState,
  applyLockedExposure,
  stepExposure,
} from '../src/sim/camera-model/exposure.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running K1-K3 camera-model tests...');

// ============================================================================
// K1 — Frame Delivery Scheduler
// ============================================================================

test('K1: computeFrameDurationSec obeys max(1/fps, exposure + readout)', () => {
  assert.ok(Math.abs(computeFrameDurationSec(30, 0.008, 0) - 1 / 30) < 1e-9);
  assert.ok(Math.abs(computeFrameDurationSec(30, 0.100, 0) - 0.100) < 1e-9);
  assert.ok(Math.abs(computeFrameDurationSec(30, 0.020, 0.025) - 0.045) < 1e-9);
  assert.ok(Math.abs(computeCopyCostMs(1280, 720, 1.5) - 1.3824) < 1e-6);
});

test('K1: 30 fps + 6 ms worker yields ~30 fps with zero drops', () => {
  const res = simulateSchedule(10, {
    enabled: true,
    nominalFps: 30,
    exposureSec: 0.008,
    readoutSec: 0,
    jitterStdMs: 0.5,
    stallProb: 0,
    copyCostMsPerMp: 1.0,
    seed: 101,
  }, 6);
  assert.ok(res.deliveredFps >= 29.0 && res.deliveredFps <= 31.0,
    `expected ~30 fps, got ${res.deliveredFps.toFixed(2)}`);
  assert.equal(res.droppedFrames, 0, `expected 0 drops, got ${res.droppedFrames}`);
  assert.ok(res.hudFps >= 28.0 && res.hudFps <= 32.0, `unexpected hudFps=${res.hudFps.toFixed(2)}`);
});

test('K1: 100 ms exposure collapses delivery to ~10 fps', () => {
  const res = simulateSchedule(10, {
    enabled: true,
    nominalFps: 30,
    exposureSec: 0.100,
    readoutSec: 0,
    jitterStdMs: 0.5,
    stallProb: 0,
    copyCostMsPerMp: 1.0,
    seed: 202,
  }, 6);
  assert.ok(res.deliveredFps >= 9.5 && res.deliveredFps <= 10.5,
    `expected ~10 fps, got ${res.deliveredFps.toFixed(2)}`);
  assert.equal(res.droppedFrames, 0);
});

test('K1: 38 ms busy worker at 30 fps yields ~26 fps with dropped frames', () => {
  const res = simulateSchedule(10, {
    enabled: true,
    nominalFps: 30,
    exposureSec: 0.008,
    readoutSec: 0,
    jitterStdMs: 0.5,
    stallProb: 0,
    copyCostMsPerMp: 0,
    seed: 303,
  }, 38);
  assert.ok(res.deliveredFps >= 25.0 && res.deliveredFps <= 27.0,
    `expected ~26 fps, got ${res.deliveredFps.toFixed(2)}`);
  assert.ok(res.droppedFrames > 20, `expected drops > 20, got ${res.droppedFrames}`);
});

test('K1: seeded determinism, stalls, and default-off no-op', () => {
  assert.equal(DEFAULT_SCHEDULER_CONFIG.enabled, false);
  const a = simulateSchedule(5, { enabled: true, stallProb: 0.05, seed: 777 }, 10);
  const b = simulateSchedule(5, { enabled: true, stallProb: 0.05, seed: 777 }, 10);
  assert.deepEqual(a, b, 'same seed must produce identical schedule');
  assert.ok(a.stallCount > 0, 'stallProb=0.05 over 5s should trigger at least one stall');

  const off = simulateSchedule(5, { enabled: false, nominalFps: 30, stallProb: 0.5, jitterStdMs: 5 }, 50);
  assert.equal(off.droppedFrames, 0);
  assert.equal(off.stallCount, 0);
  assert.ok(Math.abs(off.deliveredFps - 30) < 0.5);
});

test('K1: zero-allocation hot loop in stepScheduler', () => {
  const state = createSchedulerState({ enabled: true, seed: 42, stallProb: 0.02 });
  // Warm up
  for (let i = 0; i < 500; i++) stepScheduler(state, 12);
  resetSchedulerState(state, 42);
  const evRef = state.outEvent;
  for (let i = 0; i < 2000; i++) {
    const out = stepScheduler(state, 12);
    assert.equal(out, evRef, 'must reuse outEvent struct');
  }
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const iters = 5000;
    for (let i = 0; i < iters; i++) stepScheduler(state, 12);
    globalThis.gc();
    const bpf = Math.max(0, (process.memoryUsage().heapUsed - h0) / iters);
    assert.ok(bpf < 16, `unexpected heap growth: ${bpf.toFixed(2)} B/step`);
  }
});

// ============================================================================
// K2 — Auto-Exposure & ISO Model (A53 Limits)
// ============================================================================

test('K2: A53 limits, Chrome 100us unit conversion, and default-off no-op', () => {
  assert.equal(DEFAULT_EXPOSURE_CONFIG.enabled, false);
  assert.equal(A53_EXPOSURE_LIMITS.minExposureMs, 0.042);
  assert.equal(A53_EXPOSURE_LIMITS.maxExposureMs, 100.0);
  assert.equal(A53_EXPOSURE_LIMITS.minIso, 50);
  assert.equal(A53_EXPOSURE_LIMITS.maxIso, 3200);
  assert.ok(Math.abs(exposureMsToChromeUnits(100) - 1000) < 1e-9);
  assert.ok(Math.abs(chromeUnitsToExposureMs(0.42) - 0.042) < 1e-9);
  assert.equal(resolveLux('low'), 15);

  const offState = createExposureState({ enabled: false, lux: 'low' });
  const offOut = stepExposure(offState, 1.0);
  assert.equal(offOut.maxAchievableFps, 30);
  assert.equal(offOut.exposureGain, 1.0);
});

test('K2: low-light AE walks to 100 ms exposure ceiling and ~10 fps', () => {
  const expState = createExposureState({
    enabled: true,
    mode: 'continuous',
    lux: 'low',
    nominalFps: 30,
    minFrameRate: 15,
    convergenceTauSec: 0.4,
  });

  // Run AE for 4 seconds to settle
  let out;
  for (let i = 0; i < 80; i++) {
    out = stepExposure(expState, 0.05);
  }
  assert.ok(out.exposureTimeMs >= 98.0 && out.exposureTimeMs <= 100.0,
    `expected ~100 ms exposure in low light, got ${out.exposureTimeMs.toFixed(2)} ms`);
  assert.ok(out.iso >= 400 && out.iso <= 3200, `expected elevated ISO, got ${out.iso.toFixed(1)}`);

  // Feed converged AE exposure into K1 scheduler -> ~10 fps
  const sched = simulateSchedule(6, {
    enabled: true,
    nominalFps: 30,
    exposureSec: out.exposureSec,
    jitterStdMs: 0.3,
    stallProb: 0,
    seed: 515,
  }, 6);
  assert.ok(sched.deliveredFps >= 9.5 && sched.deliveredFps <= 10.5,
    `expected ~10 fps under low-light AE, got ${sched.deliveredFps.toFixed(2)}`);
});

test('K2: PP2 locked exposure (4 ms + ISO 1600 + min 30 fps) restores ~30 fps', () => {
  const expState = createExposureState({
    enabled: true,
    lux: 'low',
    nominalFps: 30,
  });
  applyLockedExposure(expState, 4.0, 1600, 30);
  const out = stepExposure(expState, 0.033);
  assert.equal(out.mode, 'manual');
  assert.equal(out.exposureTimeMs, 4.0);
  assert.equal(out.iso, 1600);
  assert.equal(out.maxAchievableFps, 30);

  const sched = simulateSchedule(6, {
    enabled: true,
    nominalFps: 30,
    exposureSec: out.exposureSec,
    jitterStdMs: 0.3,
    stallProb: 0,
    seed: 616,
  }, 6);
  assert.ok(sched.deliveredFps >= 29.0 && sched.deliveredFps <= 31.0,
    `expected ~30 fps under PP2 locked exposure, got ${sched.deliveredFps.toFixed(2)}`);
});

test('K2: AE convergence lag and zero-allocation stepExposure', () => {
  const state = createExposureState({
    enabled: true,
    mode: 'continuous',
    lux: 'low',
    initialExposureMs: 8.0,
    initialIso: 100,
    convergenceTauSec: 0.6,
  });
  const e0 = stepExposure(state, 0.05).exposureTimeMs;
  const eMid = stepExposure(state, 0.30).exposureTimeMs;
  for (let i = 0; i < 40; i++) stepExposure(state, 0.1);
  const eEnd = state.outExposure.exposureTimeMs;
  assert.ok(e0 > 8.0 && e0 < eMid && eMid < eEnd && eEnd > 95.0,
    `expected gradual lag convergence: e0=${e0.toFixed(2)}, eMid=${eMid.toFixed(2)}, eEnd=${eEnd.toFixed(2)}`);

  // Torch boost drives AE exposure back down
  for (let i = 0; i < 40; i++) stepExposure(state, 0.1, 800);
  assert.ok(state.outExposure.exposureTimeMs < 20.0,
    `expected torch boost to drive AE exposure down, got ${state.outExposure.exposureTimeMs.toFixed(2)} ms`);

  const ref = state.outExposure;
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const iters = 5000;
    for (let i = 0; i < iters; i++) {
      assert.equal(stepExposure(state, 0.033), ref);
    }
    globalThis.gc();
    const bpf = Math.max(0, (process.memoryUsage().heapUsed - h0) / iters);
    assert.ok(bpf < 16, `K2 heap growth too high: ${bpf.toFixed(2)} B/step`);
  }
});

console.log(`All ${passed} K1-K3 camera-model tests passed.`);
