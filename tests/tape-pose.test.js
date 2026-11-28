/**
 * T1 — tape-driven camera pose (`src/sim/tape-pose.js`, sim flag `simTapePose`).   node tests/tape-pose.test.js
 */
import assert from 'node:assert/strict';
import { createTapeRecorder } from '../src/tape/record.js';
import { quatFromPanTiltRollDeg } from '../src/array/orient.js';
import { sampleCameraPose, PATH_DEFINITIONS } from '../src/sim/paths.js';
import {
  quatToPanTiltRollDeg,
  quatAngleDeg,
  readTapeSensors,
  buildOrientationTrack,
  createTapePose,
  registerTapePath,
  unregisterTapePath,
  listRegisteredTapePaths,
} from '../src/sim/tape-pose.js';
import { computePresetLoopDurationSec, createScenarioFromPreset } from '../tools/gate/scenarios.mjs';
import { exportScenarioTape } from '../tools/sim-to-tape.mjs';
import { runScenarioSeed } from '../tools/gate/score.mjs';
import { setSimFlag, isSimOn } from '../src/sim/simflags.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const FPS = 30;
const POSE_CFG = { distanceIn: 30, speedInPerSec: 12, jitter: 1, loop: false };

/** A 10 s tape at 30 fps whose motion is the sim's own jittery pan-snake (yaw/pitch/roll all moving). */
async function makeMotionTape({ frames = 301, gyroBiasDps = 0, compress = false, accel = false } = {}) {
  const rec = createTapeRecorder({ maxFrames: frames, compress, meta: { fps: FPS, note: 'T1 test tape' } });
  rec.start();
  const h = 1 / 480;
  const luma = new Uint8Array(16);
  for (let i = 0; i < frames; i++) {
    const t = i / FPS;
    const p = sampleCameraPose('pan-snake', t, POSE_CFG);
    const a = sampleCameraPose('pan-snake', Math.max(0, t - h), POSE_CFG);
    const b = sampleCameraPose('pan-snake', t + h, POSE_CFG);
    const span = t + h - Math.max(0, t - h);
    await rec.pushFrame({
      frameId: i,
      tFrameMs: t * 1000,
      width: 4,
      height: 4,
      luma,
      sensorSample: {
        q: Array.from(quatFromPanTiltRollDeg(p.yawDeg, p.pitchDeg, p.rollDeg)),
        wPanDps: (b.yawDeg - a.yawDeg) / span + gyroBiasDps,
        wPitchDps: (b.pitchDeg - a.pitchDeg) / span,
        wRollDps: (b.rollDeg - a.rollDeg) / span,
        source: 'test',
        accel: accel ? { x: 4 * Math.sin(t * 0.8) + 3 * Math.sin(t * 9), y: 0, z: 9.8 } : null,
        simPose: { x: p.x, y: p.y, z: p.z, yawDeg: p.yawDeg, pitchDeg: p.pitchDeg, rollDeg: p.rollDeg },
      },
    });
  }
  rec.stop();
  return rec.exportBytes();
}

function maxQuatErrorDeg(tape, opts) {
  const integ = buildOrientationTrack(tape, opts);
  let worst = 0;
  for (let i = 0; i < integ.n; i++) {
    const qa = quatFromPanTiltRollDeg(integ.pan[i], integ.tilt[i], integ.roll[i]);
    const qr = tape.samples[i].sensor.q;
    worst = Math.max(worst, quatAngleDeg(qa, qr));
  }
  return worst;
}

await test('T1 quatToPanTiltRollDeg is the exact inverse of quatFromPanTiltRollDeg', () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < 200; i++) {
    const p = rnd() * 60;
    const t = rnd() * 45;
    const r = rnd() * 30;
    const e = quatToPanTiltRollDeg(quatFromPanTiltRollDeg(p, t, r));
    assert.ok(Math.abs(e.panDeg - p) < 1e-9 && Math.abs(e.tiltDeg - t) < 1e-9 && Math.abs(e.rollDeg - r) < 1e-9, `${p} ${t} ${r} -> ${JSON.stringify(e)}`);
  }
});

await test('T1 readTapeSensors reads gzip and raw tapes without decoding luma; clock is zero-based', async () => {
  for (const compress of [false, true]) {
    const tape = readTapeSensors(await makeMotionTape({ frames: 61, compress }));
    assert.equal(tape.samples.length, 61);
    assert.equal(tape.samples[0].tMs, 0);
    assert.ok(Math.abs(tape.durationSec - 2) < 1e-9);
    assert.equal(tape.header.meta.fps, FPS);
  }
  assert.throws(() => readTapeSensors(new Uint8Array(20)), /bad magic/);
});

let motionTape;
await test('T1 acceptance: integrating the gyro reproduces the recorded quaternion within 1 deg over 10 s', async () => {
  motionTape = readTapeSensors(await makeMotionTape());
  assert.ok(motionTape.durationSec >= 10);
  const worst = maxQuatErrorDeg(motionTape, { source: 'integrated' });
  console.log(`        max integrated-vs-recorded error over ${motionTape.durationSec} s: ${worst.toFixed(3)} deg`);
  assert.ok(worst < 1, `error ${worst} deg`);
  // the 'recorded' source is the quaternion itself
  assert.ok(maxQuatErrorDeg(motionTape, { source: 'recorded' }) < 1e-3);
});

await test('T1 gyro bias drifts as bias x time (0.05 dps stays inside 1 deg; 0.3 dps does not)', async () => {
  const small = readTapeSensors(await makeMotionTape({ gyroBiasDps: 0.05 }));
  const big = readTapeSensors(await makeMotionTape({ gyroBiasDps: 0.3 }));
  const eSmall = maxQuatErrorDeg(small, { source: 'integrated' });
  const eBig = maxQuatErrorDeg(big, { source: 'integrated' });
  assert.ok(eSmall < 1, `small ${eSmall}`);
  assert.ok(eBig > 2.5 && eBig < 3.5, `big ${eBig} (expect ~0.3 x 10 s = 3 deg)`);
});

await test('T1 pose sampler honours the tape clock, interpolates, stances and sway', async () => {
  const tape = motionTape;
  const tp = createTapePose(tape, { source: 'recorded' });
  // at frame times the pose equals the recorded orientation
  for (const i of [0, 37, 150, 300]) {
    const pose = tp.sample(tape.samples[i].tMs / 1000, { distanceIn: 30, loop: false });
    const q = tape.samples[i].sensor.q;
    const e = quatToPanTiltRollDeg(q);
    assert.ok(Math.abs(pose.yawDeg - e.panDeg) < 1e-9 && Math.abs(pose.pitchDeg - e.tiltDeg) < 1e-9 && Math.abs(pose.rollDeg - e.rollDeg) < 1e-9);
    assert.equal(pose.z, 30);
    assert.equal(pose.x, 0);
  }
  // halfway between two frames: the mean of both
  const mid = tp.sample((tape.samples[10].tMs + tape.samples[11].tMs) / 2000, { distanceIn: 30 });
  const a = quatToPanTiltRollDeg(tape.samples[10].sensor.q);
  const b = quatToPanTiltRollDeg(tape.samples[11].sensor.q);
  assert.ok(Math.abs(mid.yawDeg - (a.panDeg + b.panDeg) / 2) < 1e-9);
  // past the end: holds the last pose and says finished; looping wraps
  const end = tp.sample(tape.durationSec + 5, { loop: false });
  assert.equal(end.finished, true);
  assert.equal(end.speedInPerSec, 0);
  const wrap = tp.sample(tape.durationSec + 1, { loop: true });
  assert.equal(wrap.finished, false);
  // an irregular clock (dropped frames) is respected: sampling by time, not index
  const sparse = { ...tape, samples: tape.samples.filter((_, i) => i % 3 === 0 || i === 300) };
  const sp = createTapePose(sparse, { source: 'recorded' });
  const t = sparse.samples[20].tMs / 1000;
  assert.ok(Math.abs(sp.sample(t).yawDeg - tp.sample(t).yawDeg) < 1e-9);
  // aim point: facing straight on from D reaches the wall at the stance point
  const flat = createTapePose({ samples: [{ tMs: 0, sensor: { q: [0, 0, 0, 1] } }, { tMs: 1000, sensor: { q: [0, 0, 0, 1] } }], durationSec: 1 }, { source: 'recorded' });
  const f0 = flat.sample(0.5, { distanceIn: 12 });
  assert.ok(Math.abs(f0.targetX) < 1e-9 && Math.abs(f0.targetY) < 1e-9 && f0.z === 12);
  // sway: default none; with k, x follows the low-passed accelerometer and ignores the 9 rad/s shake
  const accTape = readTapeSensors(await makeMotionTape({ accel: true }));
  const plain = createTapePose(accTape, { source: 'recorded' });
  const sway = createTapePose(accTape, { source: 'recorded', swayInPerMs2: 0.5 });
  let maxX = 0;
  let maxPlain = 0;
  for (let i = 0; i < 300; i += 5) {
    maxX = Math.max(maxX, Math.abs(sway.sample(i / FPS).x));
    maxPlain = Math.max(maxPlain, Math.abs(plain.sample(i / FPS).x));
  }
  assert.equal(maxPlain, 0);
  assert.ok(maxX > 0.2 && maxX < 4, `sway ${maxX}`);
  // 'log' stance reads the tape's own pose log
  const logged = createTapePose(tape, { source: 'simPose', stance: 'log' });
  const lp = logged.sample(tape.samples[100].tMs / 1000, { loop: false });
  const want = tape.samples[100].sensor.simPose;
  assert.ok(Math.abs(lp.x - want.x) < 1e-9 && Math.abs(lp.z - want.z) < 1e-9 && Math.abs(lp.yawDeg - want.yawDeg) < 1e-9);
  assert.throws(() => createTapePose({ samples: [{ tMs: 0, sensor: {} }, { tMs: 10, sensor: {} }] }, { stance: 'log' }), /simPose/);
});

await test('T1 flags off: the tape path is not listed and PATH_DEFINITIONS/sampleCameraPose are untouched', async () => {
  assert.equal(isSimOn('simTapePose'), false);
  const before = JSON.stringify(PATH_DEFINITIONS);
  assert.equal(registerTapePath('nope', motionTape), null);
  assert.equal(JSON.stringify(PATH_DEFINITIONS), before);
  assert.deepEqual(listRegisteredTapePaths(), []);
  assert.ok(!PATH_DEFINITIONS.some((d) => d.id.startsWith('tape:')));
  // the built-in paths give the same poses as before registering anything
  const p0 = sampleCameraPose('snake-h', 3.3, { distanceIn: 10, speedInPerSec: 18, jitter: 0.2 });
  assert.equal(p0.x, sampleCameraPose('snake-h', 3.3, { distanceIn: 10, speedInPerSec: 18, jitter: 0.2 }).x);
});

await test('T1 flag on: path is listed, sampled through sampleCameraPose, gets its tape duration, and unregisters cleanly', async () => {
  const before = JSON.stringify(PATH_DEFINITIONS);
  // via the real sim flag
  setSimFlag('simTapePose', true, false);
  const id = registerTapePath('unit', motionTape, { source: 'integrated' });
  assert.equal(id, 'tape:unit');
  assert.ok(PATH_DEFINITIONS.some((d) => d.id === id));
  const pose = sampleCameraPose(id, 4.2, { distanceIn: 30, speedInPerSec: 18, jitter: 0, loop: false });
  const direct = createTapePose(motionTape, { source: 'integrated' }).sample(4.2, { distanceIn: 30, loop: false });
  assert.equal(pose.yawDeg, direct.yawDeg);
  assert.equal(computePresetLoopDurationSec({ pathId: id, speedInPerSec: 18 }), motionTape.durationSec);
  unregisterTapePath('unit');
  setSimFlag('simTapePose', false, false);
  assert.equal(JSON.stringify(PATH_DEFINITIONS), before);
  assert.equal(listRegisteredTapePaths().length, 0);
});

await test('T1 sim -> tape -> sim: a sim-exported tape drives the same camera path back, and the headless gate run decodes the same', async () => {
  const sc = createScenarioFromPreset('fc-8-3p5', { flagSet: 'off', durationSec: 2.5, width: 960, height: 540 });
  sc.loop = false;
  const direct = runScenarioSeed(sc, 1, { deviceFactor: 1 });
  const ex = await exportScenarioTape(sc, 1);
  const tape = readTapeSensors(ex.bytes);
  const id = registerTapePath('roundtrip', tape, { enabled: true, source: 'simPose', stance: 'log', originSec: 'header' });
  const cfg = { distanceIn: sc.distanceIn, speedInPerSec: sc.speed, jitter: sc.jitter, loop: false };
  const t0 = tape.header.meta.phaseOffsetSec;
  let worst = 0;
  for (let i = 0; i < tape.samples.length; i++) {
    const tSim = t0 + i / sc.fpsCap;
    const orig = sampleCameraPose(sc.path, tSim, cfg);
    const viaTape = sampleCameraPose(id, tSim, cfg);
    worst = Math.max(worst, Math.abs(orig.yawDeg - viaTape.yawDeg), Math.abs(orig.pitchDeg - viaTape.pitchDeg), Math.abs(orig.x - viaTape.x), Math.abs(orig.y - viaTape.y), Math.abs(orig.z - viaTape.z));
  }
  assert.ok(worst < 1e-3, `worst pose difference ${worst} (tape stores 4 decimals)`);
  // headless run on the tape path (the same scenario, only the path replaced)
  const sc2 = { ...sc, path: id };
  const viaTape = runScenarioSeed(sc2, 1, { deviceFactor: 1 });
  unregisterTapePath('roundtrip');
  console.log(`        direct decoded ${direct.decodedCount}, via tape path ${viaTape.decodedCount}, FP ${viaTape.falsePositives}`);
  assert.ok(direct.decodedCount > 0);
  assert.equal(viaTape.framesRendered, direct.framesRendered);
  assert.equal(viaTape.falsePositives, direct.falsePositives);
  assert.ok(Math.abs(viaTape.decodedCount - direct.decodedCount) <= 1, `decoded ${viaTape.decodedCount} vs ${direct.decodedCount}`);
});

console.log(`\nAll ${passed} T1 tape-pose tests passed.`);
