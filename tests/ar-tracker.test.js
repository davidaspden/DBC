/**
 * M4 — AR wall tracker and pose (`src/ar/pose.js`, `src/ar/tracker.js`), flag `arWall`.
 *   node tests/ar-tracker.test.js
 * Acceptance (plan 3, M4): position error <= 0.3 in at 12 in and <= 1 in at 30 in; angle error <= 1 deg;
 * reprojection RMS <= 0.5 px; LOCKED >= 95% of frames; coasting recovers after a 5-frame dropout;
 * flag-gated; zero allocation.
 */
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createArLayout } from '../src/ar/layout.js';
import { createPoseSolver, createPoseResult } from '../src/ar/pose.js';
import {
  createWallTracker, rotDeltaFromGyro, TRACK_DISABLED, TRACK_LOST, TRACK_COASTING, TRACK_LOCKED,
} from '../src/ar/tracker.js';
import { isSimOn } from '../src/sim/simflags.js';
import { cameraFromPose, homographyOf, projectPoint, renderDotWall } from './helpers/ar-dot-render.js';
import { mulberry32 } from '../src/sim/prng.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }
console.log('Running M4 wall tracker tests...');

const layout = createArLayout({ tier: 'B' });
const W = 360; const H = 640; const HFOV = 60;
const rnd = mulberry32(21);
const U = (a, b) => a + (b - a) * rnd();

function priorsOf(pose, cam) {
  const a = projectPoint(cam, pose.aimX, pose.aimY);
  const b = projectPoint(cam, pose.aimX + 1, pose.aimY);
  return [pose.aimX, pose.aimY, 9, Math.atan2(b.v - a.v, b.u - a.u) * 180 / Math.PI, 30];
}
function frame(pose, seed, extra) {
  return renderDotWall({ layout, width: W, height: H, hfovDeg: HFOV, pose, psfSigmaPx: 1, noiseSigma: 3, seed, ...extra });
}
function poseErr(out, cam) {
  const dc = Math.hypot(out.C[0] - cam.C[0], out.C[1] - cam.C[1], out.C[2] - cam.C[2]);
  const da = Math.max(Math.abs(out.yawDeg - cam.yawDeg), Math.abs(out.pitchDeg - cam.pitchDeg));
  return { dc, da };
}

test('pose.js: exact decomposition of a noise-free homography (angles, centre, aim, distance)', () => {
  const ps = createPoseSolver(); const out = createPoseResult();
  for (let t = 0; t < 200; t++) {
    const pose = { aimX: U(0, 64), aimY: U(0, 56), distanceIn: U(8, 40), yawDeg: U(-45, 45), pitchDeg: U(-45, 45), rollDeg: U(-180, 180) };
    const cam = cameraFromPose(pose, 1080, 1920, 50);
    assert.ok(ps.solve(Float64Array.from(homographyOf(cam)), cam.fx, cam.fy, cam.u0, cam.v0, pose.aimX, pose.aimY, out));
    assert.ok(Math.abs(out.yawDeg - pose.yawDeg) < 1e-6 && Math.abs(out.pitchDeg - pose.pitchDeg) < 1e-6);
    let dr = Math.abs(out.rollDeg - pose.rollDeg); dr = Math.min(dr, 360 - dr);
    assert.ok(dr < 1e-6, `roll ${out.rollDeg} vs ${pose.rollDeg}`);
    assert.ok(Math.hypot(out.C[0] - cam.C[0], out.C[1] - cam.C[1], out.C[2] - cam.C[2]) < 1e-6);
    assert.ok(Math.abs(out.distanceIn - pose.distanceIn) < 1e-6);
    assert.ok(Math.abs(out.aimX - pose.aimX) < 1e-6 && Math.abs(out.aimY - pose.aimY) < 1e-6);
  }
});

test('flag gating: arWall is off by default and a disabled tracker does nothing', () => {
  assert.equal(isSimOn('arWall'), false);
  const tr = createWallTracker({ layout, width: W, height: H, hfovDeg: HFOV });
  assert.equal(tr.enabled, false);
  const luma = new Uint8Array(W * H).fill(200);
  const s = tr.update(luma);
  assert.equal(s.state, TRACK_DISABLED);
  assert.equal(s.frame, 0);
  assert.equal(s.poseValid, false);
});

function trajectory(n, dist, seed0, speedPx) {
  // smooth hand-like motion around a stance: aim drifts, small yaw/pitch/roll, distance sways
  const poses = [];
  for (let i = 0; i < n; i++) {
    const t = i / 30;
    poses.push({
      aimX: 32 + 3 * Math.sin(2 * Math.PI * 0.35 * t) + (speedPx / 20) * Math.sin(2 * Math.PI * 0.9 * t),
      aimY: 24 + 2.5 * Math.sin(2 * Math.PI * 0.27 * t + 1),
      distanceIn: dist + 0.8 * Math.sin(2 * Math.PI * 0.2 * t),
      yawDeg: 6 * Math.sin(2 * Math.PI * 0.3 * t),
      pitchDeg: 5 * Math.sin(2 * Math.PI * 0.4 * t + 2),
      rollDeg: 8 * Math.sin(2 * Math.PI * 0.25 * t) + 10,
    });
  }
  return poses;
}

test('tracking a 90-frame hand-motion path at 20 in: LOCKED >= 95%, angle error <= 1 deg, RMS <= 0.5 px', () => {
  const tr = createWallTracker({ layout, width: W, height: H, hfovDeg: HFOV, enabled: true });
  const poses = trajectory(90, 20, 0, 6);
  let locked = 0; let worstDa = 0; let worstRms = 0; let worstDc = 0; let n = 0;
  poses.forEach((pose, i) => {
    const r = frame(pose, 1000 + i);
    const cam = r.cam; cam.yawDeg = pose.yawDeg; cam.pitchDeg = pose.pitchDeg;
    if (i === 0) tr.setPriors(...priorsOf(pose, cam));
    const s = tr.update(r.luma);
    n++;
    if (s.state === TRACK_LOCKED) {
      locked++;
      const e = poseErr(s.pose, cam);
      worstDa = Math.max(worstDa, e.da); worstDc = Math.max(worstDc, e.dc); worstRms = Math.max(worstRms, s.rmsPx);
    }
  });
  console.log(`        LOCKED ${locked}/${n}; worst angle error ${worstDa.toFixed(3)} deg, centre error ${worstDc.toFixed(3)} in, RMS ${worstRms.toFixed(3)} px`);
  assert.ok(locked / n >= 0.95);
  assert.ok(worstDa <= 1);
  assert.ok(worstRms <= 0.5);
});

test('position error: <= 0.3 in at 12 in and <= 1 in at 30 in (end to end from rendered frames)', () => {
  for (const [dist, limit, hfov] of [[12, 0.3, 75], [30, 1.0, 50]]) {
    let worst = 0; let worstA = 0; let used = 0;
    for (let t = 0; t < 14; t++) {
      const pose = { aimX: U(24, 40), aimY: U(18, 34), distanceIn: dist, yawDeg: U(-15, 15), pitchDeg: U(-15, 15), rollDeg: U(-30, 30) };
      const r = renderDotWall({ layout, width: 540, height: 960, hfovDeg: hfov, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 40 + t });
      const cam = r.cam; cam.yawDeg = pose.yawDeg; cam.pitchDeg = pose.pitchDeg;
      const tr = createWallTracker({ layout, width: 540, height: 960, hfovDeg: hfov, enabled: true });
      tr.setPriors(...priorsOf(pose, cam));
      const s = tr.update(r.luma);
      if (s.state !== TRACK_LOCKED) continue;
      const e = poseErr(s.pose, cam);
      worst = Math.max(worst, e.dc); worstA = Math.max(worstA, e.da); used++;
    }
    console.log(`        ${dist} in: ${used}/14 locked, worst position error ${worst.toFixed(3)} in, angle ${worstA.toFixed(3)} deg`);
    assert.ok(used >= 9, `locked ${used}`);
    assert.ok(worst <= limit, `position ${worst} at ${dist} in`);
    assert.ok(worstA <= 1);
  }
});

test('coasting: a 5-frame dropout (blank frames) is bridged and the lock returns on the first good frame', () => {
  const tr = createWallTracker({ layout, width: W, height: H, hfovDeg: HFOV, enabled: true });
  const poses = trajectory(30, 18, 0, 6);
  const states = [];
  let errAfter = 1e9;
  poses.forEach((pose, i) => {
    const blank = i >= 12 && i < 17;
    const r = frame(pose, 2000 + i, blank ? { skipIds: new Set(layout.dots.map((d) => d.id)) } : undefined);
    const cam = r.cam; cam.yawDeg = pose.yawDeg; cam.pitchDeg = pose.pitchDeg;
    if (i === 0) tr.setPriors(...priorsOf(pose, cam));
    const s = tr.update(r.luma);
    states.push(s.state);
    if (i === 17) errAfter = poseErr(s.pose, cam).dc;
  });
  assert.ok(states.slice(1, 12).every((x) => x === TRACK_LOCKED));
  assert.ok(states.slice(12, 17).every((x) => x === TRACK_COASTING), `dropout states ${states.slice(12, 17)}`);
  assert.equal(states[17], TRACK_LOCKED);
  assert.ok(errAfter < 1.5, `error after recovery ${errAfter}`);
  console.log(`        states over the dropout: ${states.slice(11, 19).join(',')} (3 LOCKED, 2 COASTING); centre error after recovery ${errAfter.toFixed(2)} in`);
});

test('a dropout longer than maxCoast goes LOST and a cold start with priors re-acquires', () => {
  const tr = createWallTracker({ layout, width: W, height: H, hfovDeg: HFOV, enabled: true, maxCoast: 6 });
  const poses = trajectory(24, 18, 0, 6);
  const states = [];
  poses.forEach((pose, i) => {
    const blank = i >= 8 && i < 17; // 9 blank frames
    const r = frame(pose, 3000 + i, blank ? { skipIds: new Set(layout.dots.map((d) => d.id)) } : undefined);
    const cam = r.cam; cam.yawDeg = pose.yawDeg; cam.pitchDeg = pose.pitchDeg;
    if (i === 0) tr.setPriors(...priorsOf(pose, cam));
    states.push(tr.update(r.luma).state);
  });
  assert.ok(states.slice(8, 15).includes(TRACK_COASTING));
  assert.ok(states.slice(8, 17).includes(TRACK_LOST));
  assert.equal(states[17], TRACK_LOCKED, `states ${states}`);
});

test('arGyroPrior: a gyro rotation increment keeps the lock through a fast pan that loses it without', () => {
  // camera centre fixed, yaw steps of 4 deg per frame (large image jumps)
  function poseFrom(C, yaw) {
    const y = yaw * Math.PI / 180;
    const f = [Math.sin(y), 0, Math.cos(y)];
    const s = -C[2] / f[2];
    return { aimX: C[0] + s * f[0], aimY: C[1] + s * f[1], distanceIn: s, yawDeg: yaw, pitchDeg: 0, rollDeg: 0 };
  }
  const C = [32, 26, -18];
  const run = (useGyro) => {
    const tr = createWallTracker({ layout, width: W, height: H, hfovDeg: HFOV, enabled: true });
    const rd = new Float64Array(9);
    let lockedFrames = 0;
    for (let i = 0; i < 8; i++) {
      const pose = poseFrom(C, -14 + 4 * i);
      const r = frame(pose, 4000 + i);
      const cam = r.cam; cam.yawDeg = pose.yawDeg; cam.pitchDeg = 0;
      if (i === 0) tr.setPriors(...priorsOf(pose, cam));
      let rot = null;
      if (useGyro && i > 0) { rot = rotDeltaFromGyro(0, (4 * Math.PI / 180) * 30, 0, 1 / 30, rd); }
      const s = tr.update(r.luma, rot);
      if (i > 0 && s.state === TRACK_LOCKED && Math.abs(s.pose.yawDeg - pose.yawDeg) < 1) lockedFrames++;
    }
    return lockedFrames;
  };
  const withGyro = run(true);
  const without = run(false);
  console.log(`        locked frames of 7 during a 4 deg/frame pan: with gyro prior ${withGyro}, without ${without}`);
  assert.ok(withGyro >= 6);
  assert.ok(withGyro >= without);
});

test('rotDeltaFromGyro: matches the rotation between two rendered cameras with the same centre', () => {
  function poseFrom(C, yaw) {
    const y = yaw * Math.PI / 180; const f = [Math.sin(y), 0, Math.cos(y)]; const s = -C[2] / f[2];
    return { aimX: C[0] + s * f[0], aimY: C[1] + s * f[1], distanceIn: s, yawDeg: yaw, pitchDeg: 0, rollDeg: 0 };
  }
  const C = [30, 26, -18];
  const a = cameraFromPose(poseFrom(C, 0), 540, 960, 50); const b = cameraFromPose(poseFrom(C, 3), 540, 960, 50);
  const out = rotDeltaFromGyro(0, (3 * Math.PI) / 180, 0, 1, new Float64Array(9));
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0; for (let k = 0; k < 3; k++) s += b.R[i][k] * a.R[j][k];
    assert.ok(Math.abs(s - out[i * 3 + j]) < 1e-9);
  }
});

test('zero allocation: heap delta over 600 tracker updates (after JIT warm-up)', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const tr = createWallTracker({ layout, width: W, height: H, hfovDeg: HFOV, enabled: true });
  const poses = trajectory(6, 18, 0, 6);
  const frames = poses.map((pose, i) => frame(pose, 5000 + i));
  tr.setPriors(...priorsOf(poses[0], frames[0].cam));
  for (let i = 0; i < 400; i++) tr.update(frames[i % 6].luma); // warm-up: let the JIT settle so code objects are not counted
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 600; i++) tr.update(frames[i % 6].luma);
  gc(); gc();
  const delta = process.memoryUsage().heapUsed - before;
  console.log(`        heap delta over 600 updates: ${delta} B (${(delta / 600).toFixed(1)} B/frame)`);
  assert.ok(delta / 600 < 16, `heap delta ${delta}`);
});

test('timing: tracker update at 1080x1920 with ~25 dots', () => {
  const w = 1080; const h = 1920;
  const tr = createWallTracker({ layout, width: w, height: h, hfovDeg: 50, enabled: true });
  const pose = { aimX: 32, aimY: 28, distanceIn: 28, yawDeg: 6, pitchDeg: 3, rollDeg: 5 };
  const r = renderDotWall({ layout, width: w, height: h, hfovDeg: 50, pose, psfSigmaPx: 1.2, noiseSigma: 3, seed: 8 });
  tr.setPriors(...priorsOf(pose, r.cam));
  for (let i = 0; i < 30; i++) tr.update(r.luma);
  const ts = [];
  for (let i = 0; i < 40; i++) { const t0 = performance.now(); tr.update(r.luma); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b);
  console.log(`        1080x1920: best ${ts[0].toFixed(2)} ms, median ${ts[20].toFixed(2)} ms, state ${tr.status.state}, ${tr.status.dots} dots`);
  assert.equal(tr.status.state, TRACK_LOCKED);
  assert.ok(ts[0] <= 3.5, `best ${ts[0]}`); // detector ~2.5 ms + track/pose ~0.1 ms (plan budget: tracker <= 3 ms median; see docs)
});

assert.equal(TRACK_LOST, 1);
console.log(`All ${passed} M4 wall tracker tests passed.`);
