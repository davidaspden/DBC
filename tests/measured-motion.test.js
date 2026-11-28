/**
 * T3 — motion statistics -> jitter model (`tools/tape-motion.mjs`, `src/sim/measured-motion.js`, sim flag
 * `simMeasuredMotion`).   node tests/measured-motion.test.js
 */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createTapeRecorder } from '../src/tape/record.js';
import { quatFromPanTiltRollDeg } from '../src/array/orient.js';
import { sampleCameraPose, hasMeasuredMotionHook } from '../src/sim/paths.js';
import { quatToPanTiltRollDeg } from '../src/sim/tape-pose.js';
import {
  welchPsd,
  bandPowers,
  fitAr2,
  rateSeriesFromSamples,
  fitMotionModel,
  createMeasuredMotion,
  legacyJitterModel,
  validateMotionModel,
  enableMeasuredMotion,
  disableMeasuredMotion,
  DEFAULT_JITTER_EQUIVALENT,
  BAND_HZ,
} from '../src/sim/measured-motion.js';
import { readTapeSensors } from '../src/sim/tape-pose.js';
import { modelFromTapeBytes, checkModelAgainstSeries } from '../tools/tape-motion.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

// ---- deterministic synthetic sources ----------------------------------------------------------
function rngGauss(seed) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
/** AR(2) resonator: pole radius r at frequency f0 (Hz) for sample rate fs; unit-variance drive. */
function ar2Series(n, fs, f0, r, seed, scale) {
  const g = rngGauss(seed);
  const a1 = 2 * r * Math.cos((2 * Math.PI * f0) / fs);
  const a2 = -r * r;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = (i > 0 ? a1 * x[i - 1] : 0) + (i > 1 ? a2 * x[i - 2] : 0) + g();
  for (let i = 0; i < n; i++) x[i] *= scale;
  return { x, a1, a2 };
}

const FS = 30;
const N = FS * 180; // 3 minutes
const src = {
  pan: ar2Series(N, FS, 3, 0.9, 11, 4).x, // one resonance: AR(2) fits
  tilt: (() => {
    const a = ar2Series(N, FS, 2, 0.92, 12, 3).x;
    const b = ar2Series(N, FS, 8, 0.9, 13, 2).x;
    return Float64Array.from(a, (v, i) => v + b[i]); // two resonances: AR(2) cannot fit it
  })(),
  roll: Float64Array.from(ar2Series(N, FS, 1, 0.5, 14, 0.8).x),
};

async function tapeBytes({ rates = true, quats = false } = {}) {
  const rec = createTapeRecorder({ maxFrames: N, compress: false, meta: { fps: FS } });
  rec.start();
  const luma = new Uint8Array(16);
  for (let i = 0; i < N; i++) {
    const ss = { source: 'synthetic' };
    if (rates) { ss.wPanDps = src.pan[i]; ss.wPitchDps = src.tilt[i]; ss.wRollDps = src.roll[i]; }
    // quaternion tapes: angles are the (scaled) source series themselves (bounded, unlike an integrated random walk)
    if (quats) ss.q = Array.from(quatFromPanTiltRollDeg(QSCALE * src.pan[i], QSCALE * src.tilt[i], QSCALE * src.roll[i]));
    await rec.pushFrame({ frameId: i, tFrameMs: (i * 1000) / FS, width: 4, height: 4, luma, sensorSample: ss });
  }
  rec.stop();
  return rec.exportBytes();
}

const QSCALE = 0.05;
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);

await test('T3 estimators: Welch band power recovers a sine (A^2/2) and white noise; AR(2) recovers its coefficients', () => {
  const n = 4096;
  const sine = Float64Array.from({ length: n }, (_, i) => 3 * Math.sin((2 * Math.PI * 4 * i) / FS));
  const p = bandPowers(welchPsd(sine, FS), [3, 5])[0];
  assert.ok(Math.abs(p - 4.5) / 4.5 < 0.05, `sine power ${p}`);
  const g = rngGauss(5);
  const white = Float64Array.from({ length: 40000 }, () => 2 * g());
  const tot = bandPowers(welchPsd(white, FS), [0.1, 14.9])[0];
  assert.ok(Math.abs(tot - 4 * (14.8 / 15)) / 4 < 0.06, `white power ${tot}`);
  const s = ar2Series(60000, FS, 3, 0.9, 99, 1);
  const fit = fitAr2(s.x);
  assert.ok(Math.abs(fit.a1 - s.a1) < 0.03 && Math.abs(fit.a2 - s.a2) < 0.03, `${fit.a1} ${fit.a2} vs ${s.a1} ${s.a2}`);
});

let model;
let series;
await test('T3 acceptance: the generator PSD matches the source tape within 20% in 0.5-10 Hz (every axis, every band, 3 seeds)', async () => {
  const bytes = await tapeBytes();
  ({ model, series } = modelFromTapeBytes(bytes, { name: 'synthetic', distanceIn: 10 }));
  assert.ok(Math.abs(model.fsHz - FS) < 1e-6);
  assert.equal(model.axes.pan.chosen, 'ar2', 'a single resonance is fitted by AR(2)');
  assert.equal(model.axes.tilt.chosen, 'welch', 'two resonances need the Welch table');
  let worstAll = 0;
  for (const seed of [1, 2, 3]) {
    const chk = checkModelAgainstSeries(model, series, { seed });
    worstAll = Math.max(worstAll, chk.worst);
    for (const ax of ['pan', 'tilt', 'roll']) {
      for (const kind of ['analytic', 'empirical']) {
        assert.ok(chk.perAxis[ax][kind].worst <= 0.2, `seed ${seed} ${ax} ${kind}: band errors ${chk.perAxis[ax][kind].rel.map((r) => r.toFixed(2)).join(' ')}`);
      }
    }
  }
  console.log(`        worst band power error over 3 seeds x 3 axes x 6 bands: ${(worstAll * 100).toFixed(1)}% (acceptance 20%)`);
  assert.deepEqual(model.bandHz, [BAND_HZ[0], BAND_HZ[1]]);
});

await test('T3 statistics: rms/peak rates, pitch-vs-yaw split and sweep speed', () => {
  const s = model.stats;
  assert.ok(Math.abs(s.rmsRateDps.pan - rms(src.pan)) / rms(src.pan) < 0.02);
  assert.ok(Math.abs(s.rmsRateDps.tilt - rms(src.tilt)) / rms(src.tilt) < 0.02);
  const peakPan = Math.max(...src.pan.map(Math.abs));
  assert.ok(Math.abs(s.peakRateDps.pan - peakPan) / peakPan < 0.02);
  assert.ok(Math.abs(s.split.panFrac + s.split.tiltFrac + s.split.rollFrac - 1) < 1e-9);
  const expectPanFrac = rms(src.pan) ** 2 / (rms(src.pan) ** 2 + rms(src.tilt) ** 2 + rms(src.roll) ** 2);
  assert.ok(Math.abs(s.split.panFrac - expectPanFrac) < 0.02);
  assert.equal(s.sweep.distanceIn, 10);
  assert.ok(Math.abs(s.sweep.alongScanInPerSec - s.sweep.rmsDps.tilt * (Math.PI / 180) * 10) < 1e-9);
  assert.ok(s.p99RateDps.pan <= s.peakRateDps.pan);
});

await test('T3 rates fall back to the recorded quaternion when a tape has no gyro fields', async () => {
  const withQ = readTapeSensors(await tapeBytes({ rates: false, quats: true }));
  const ser = rateSeriesFromSamples(withQ.samples, quatToPanTiltRollDeg);
  assert.match(ser.source, /quaternion/);
  // expected: central difference of the angle series the tape holds
  const want = Float64Array.from({ length: N - 2 }, (_, i) => (QSCALE * (src.pan[i + 2] - src.pan[i]) * FS) / 2);
  assert.ok(Math.abs(rms(ser.pan) - rms(want)) / rms(want) < 0.02, `${rms(ser.pan)} vs ${rms(want)}`);
  assert.throws(() => rateSeriesFromSamples(withQ.samples.map((s) => ({ ...s, sensor: {} })), quatToPanTiltRollDeg), /neither/);
  const m2 = fitMotionModel(ser, {});
  assert.equal(m2.axes.pan.chosen === 'ar2' || m2.axes.pan.chosen === 'welch', true);
});

await test('T3 generator: seeded, a pure function of time (random access), survives a JSON round trip', () => {
  const a = createMeasuredMotion(model, { seed: 7 });
  const b = createMeasuredMotion(JSON.parse(JSON.stringify(model)), { seed: 7 });
  const c = createMeasuredMotion(model, { seed: 8 });
  const ts = [5.3, 0.1, 99.9, 5.3];
  const first = ts.map((t) => ({ ...a.offsets(t) }));
  assert.deepEqual(first[0], first[3], 'same t, same offsets, whatever was asked in between');
  assert.deepEqual(ts.map((t) => ({ ...b.offsets(t) })), first, 'JSON round trip');
  assert.notDeepEqual({ ...c.offsets(5.3) }, first[0], 'different seed differs');
  // rate is the derivative of the angle offset
  const h = 1e-5;
  const r = a.rates(12.34);
  const num = (a.offsets(12.34 + h).yawDeg - a.offsets(12.34 - h).yawDeg) / (2 * h);
  assert.ok(Math.abs(r.yawDeg - num) < 1e-4 * (1 + Math.abs(num)), `${r.yawDeg} vs ${num}`);
  assert.equal(validateMotionModel(model).ok, true);
  assert.equal(validateMotionModel({ format: 'x' }).ok, false);
  assert.throws(() => createMeasuredMotion({ format: 'x' }), /invalid motion model/);
});

const CFG = { distanceIn: 10, speedInPerSec: 18, loop: true };
const probe = (id, jitter, ts = Array.from({ length: 120 }, (_, i) => 0.37 * i + 0.05)) => ts.map((t) => ({ ...sampleCameraPose(id, t, { ...CFG, jitter }) }));

await test('T3 flag off: enableMeasuredMotion does nothing and sampleCameraPose is untouched', () => {
  const before = JSON.stringify([probe('snake-h', 0.25), probe('pan-snake', 0.6), probe('diagonal-tilt', 0)]);
  assert.equal(enableMeasuredMotion(model, { seed: 1 }), false);
  assert.equal(hasMeasuredMotionHook(), false);
  assert.equal(JSON.stringify([probe('snake-h', 0.25), probe('pan-snake', 0.6), probe('diagonal-tilt', 0)]), before);
});

await test('T3 default model with the flag on equals the slider at jitter 0.25 (conservative default), and ignores the slider', () => {
  assert.equal(DEFAULT_JITTER_EQUIVALENT, 0.25);
  const legacy = {};
  for (const id of ['snake-h', 'pan-snake', 'diagonal-tilt']) legacy[id] = probe(id, 0.25);
  assert.equal(enableMeasuredMotion(legacyJitterModel(), { enabled: true }), true);
  assert.equal(hasMeasuredMotionHook(), true);
  for (const id of Object.keys(legacy)) {
    const on = probe(id, 0.25);
    for (let i = 0; i < on.length; i++) {
      for (const k of ['yawDeg', 'pitchDeg', 'rollDeg', 'x', 'y', 'z']) {
        assert.ok(Math.abs(on[i][k] - legacy[id][i][k]) < 1e-9, `${id}[${i}].${k}: ${on[i][k]} vs ${legacy[id][i][k]}`);
      }
    }
  }
  // the slider no longer drives the angular wobble (z breathing still follows it)
  const lo = probe('snake-h', 0.25);
  const hi = probe('snake-h', 0.9);
  for (let i = 0; i < lo.length; i++) {
    assert.equal(lo[i].yawDeg, hi[i].yawDeg);
    assert.equal(lo[i].rollDeg, hi[i].rollDeg);
  }
  assert.ok(lo.some((p, i) => p.z !== hi[i].z));
  disableMeasuredMotion();
  assert.equal(hasMeasuredMotionHook(), false);
  assert.deepEqual(probe('snake-h', 0.25), legacy['snake-h']);
});

await test('T3 a fitted model drives the sim: pose offsets have the tape rms and the path is otherwise unchanged', () => {
  const flat = probe('snake-h', 0, Array.from({ length: 3000 }, (_, i) => i / FS));
  enableMeasuredMotion(model, { enabled: true, seed: 3 });
  const live = probe('snake-h', 0, Array.from({ length: 3000 }, (_, i) => i / FS));
  disableMeasuredMotion();
  const dyaw = live.map((p, i) => p.yawDeg - flat[i].yawDeg);
  assert.ok(rms(dyaw) > 0.05, `yaw wobble rms ${rms(dyaw)}`);
  // expected angle rms from the model: sum of (rate power / (2 pi f)^2) over its components
  const gen = createMeasuredMotion(model, { seed: 3 });
  const direct = Array.from({ length: 3000 }, (_, i) => gen.offsets(i / FS).yawDeg);
  assert.ok(Math.abs(rms(dyaw) - rms(direct)) < 1e-9);
  for (let i = 0; i < live.length; i++) assert.equal(live[i].x, flat[i].x);
});

await test('T3 CLI: tools/tape-motion.mjs prints stats, passes its own 20% self-check and writes a loadable model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dbc-motion-'));
  const tape = join(dir, 'synthetic.dbct');
  writeFileSync(tape, await tapeBytes());
  const out = join(dir, 'model.json');
  const res = spawnSync('node', ['tools/tape-motion.mjs', tape, '--out', out, '--distance', '10'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /within 20%/);
  assert.match(res.stdout, /split pan\/tilt\/roll/);
  const loaded = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(validateMotionModel(loaded).ok, true);
  assert.equal(createMeasuredMotion(loaded, { seed: 1 }).components.pan > 50, true);
  const bad = spawnSync('node', ['tools/tape-motion.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

console.log(`\nAll ${passed} T3 measured-motion tests passed.`);
