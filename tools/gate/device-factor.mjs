/**
 * F2 — Dynamic Machine-Measured A53 Device Factor (`tools/gate/device-factor.mjs`).
 *
 * Benchmarks the real 1080x2400 still fixture (`tests/fixtures-sim/tote-tsX07wz7py1-gray.pgm.gz`)
 * on the current machine at startup using the flags-off `processFrameMulti` path (matching
 * `tests/still-fixture.test.js`) and computes:
 *
 *   deviceFactorA53 = PHONE_MS_A53 / nodeP50Ms
 *
 * where `PHONE_MS_A53 = 38.0` is the measured Galaxy A53 (SM-A536B) decode time for `tsX07wz7py1`.
 * Results are cached in-process so `simgate` measures once on the main thread and passes the
 * measured factor to `worker_threads` without re-measuring inside workers.
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { parsePGM } from '../../tests/harness.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../../src/worker/scanner.worker.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PHONE_MS_A53 = 38.0;
export const EXPECTED_PAYLOAD = 'tsX07wz7py1';
export const DEFAULT_WARMUP = 3;
export const DEFAULT_ITERATIONS = 30;
export const STILL_FIXTURE_REL_PATH = 'tests/fixtures-sim/tote-tsX07wz7py1-gray.pgm.gz';

let cachedMeasurement = null;

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

/**
 * Collects provenance metadata for the current host machine.
 */
export function getMachineInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model || 'unknown',
    cpuCount: cpus.length,
    nodeVersion: process.version,
  };
}

/**
 * Measures the real 1080x2400 still fixture on the current machine with flags off (`flags = 0`)
 * and returns `{ deviceFactorA53, phoneMs, nodeP50Ms, nodeP95Ms, iterations, warmup, payload,
 * width, height, fixture, machine, measuredUtc }`.
 *
 * @param {{ iterations?: number, warmup?: number, phoneMs?: number, fixturePath?: string }} [opts]
 */
export function measureDeviceFactor(opts = {}) {
  const iterations = Math.max(1, (opts.iterations ?? DEFAULT_ITERATIONS) | 0);
  const warmup = Math.max(0, (opts.warmup ?? DEFAULT_WARMUP) | 0);
  const phoneMs = Number.isFinite(opts.phoneMs) && opts.phoneMs > 0 ? opts.phoneMs : PHONE_MS_A53;
  const fixturePath = opts.fixturePath || join(ROOT, STILL_FIXTURE_REL_PATH);

  const gzBytes = readFileSync(fixturePath);
  const pgmBytes = zlib.gunzipSync(gzBytes);
  const { width, height, luma } = parsePGM(pgmBytes);

  const state = createPipelineState(width, height);
  const result = createPipelineResult();
  state.flags = 0;
  state.scanline.mode = 0;

  for (let i = 0; i < warmup; i++) {
    processFrameMulti(luma, width, height, state, result, true);
  }

  const samples = new Array(iterations);
  let lastDets = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    processFrameMulti(luma, width, height, state, result, true);
    samples[i] = performance.now() - t0;
    lastDets = extractMultiDetections(state);
  }

  const matched = lastDets.find((d) => d.payload === EXPECTED_PAYLOAD);
  if (!matched) {
    const got = lastDets.map((d) => d.payload).join(', ') || 'none';
    throw new Error(
      `Still fixture device-factor benchmark failed to decode ${EXPECTED_PAYLOAD} (got: ${got})`
    );
  }

  samples.sort((a, b) => a - b);
  const nodeP50Ms = percentile(samples, 0.5);
  const nodeP95Ms = percentile(samples, 0.95);
  if (!(nodeP50Ms > 0)) {
    throw new Error(`Invalid measured nodeP50Ms: ${nodeP50Ms}`);
  }

  const deviceFactorA53 = phoneMs / nodeP50Ms;
  const machine = getMachineInfo();

  return {
    deviceFactorA53,
    phoneMs,
    nodeP50Ms,
    nodeP95Ms,
    iterations,
    warmup,
    payload: matched.payload,
    width,
    height,
    fixture: STILL_FIXTURE_REL_PATH,
    machine,
    measuredUtc: new Date().toISOString(),
  };
}

/**
 * Returns the in-process cached device-factor measurement, measuring once on first call.
 *
 * @param {{ iterations?: number, warmup?: number, phoneMs?: number, force?: boolean }} [opts]
 */
export function getDeviceFactorMeasurement(opts = {}) {
  if (!cachedMeasurement || opts.force) {
    cachedMeasurement = measureDeviceFactor(opts);
  }
  return cachedMeasurement;
}

/**
 * Convenience helper returning just the numeric `deviceFactorA53` (cached in-process).
 *
 * @param {{ iterations?: number, warmup?: number, phoneMs?: number, force?: boolean }} [opts]
 */
export function getDeviceFactorA53(opts = {}) {
  return getDeviceFactorMeasurement(opts).deviceFactorA53;
}

/**
 * Clears the in-process cached measurement (intended for unit tests).
 */
export function clearDeviceFactorCache() {
  cachedMeasurement = null;
}
