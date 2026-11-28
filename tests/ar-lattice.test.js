/**
 * M3 — wall matcher (`src/ar/lattice.js`).
 *   node tests/ar-lattice.test.js
 * Acceptance (plan 3, M3): wrong-offset detection >= 99% when a landmark is visible; zero allocation;
 * plus the cold-start matching quality we actually get (reported, with its limits).
 */
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createArLayout } from '../src/ar/layout.js';
import { createDotDetector } from '../src/ar/dots.js';
import { createWallMatcher, OFFSET_OK, OFFSET_WRONG, OFFSET_UNVERIFIED } from '../src/ar/lattice.js';
import { renderDotWall, projectPoint } from './helpers/ar-dot-render.js';
import { mulberry32 } from '../src/sim/prng.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }
console.log('Running M3 wall matcher tests...');

const layout = createArLayout({ tier: 'B' });
const idIndex = new Map(layout.dots.map((d, i) => [d.id, i]));
const W = 540; const H = 960;
const det = createDotDetector({ width: W, height: H });
const wm = createWallMatcher({ layout });
const rnd = mulberry32(7);
const U = (a, b) => a + (b - a) * rnd();

function randomPose(maxTilt) {
  return { aimX: U(12, 52), aimY: U(10, 46), distanceIn: U(12, 30), yawDeg: U(-maxTilt, maxTilt), pitchDeg: U(-maxTilt, maxTilt), rollDeg: U(-180, 180) };
}
function priorsOf(r, pose) {
  const a = projectPoint(r.cam, pose.aimX, pose.aimY);
  const b = projectPoint(r.cam, pose.aimX + 1, pose.aimY);
  return { centerX: pose.aimX, centerY: pose.aimY, centerTolIn: 8, axisAngleDeg: Math.atan2(b.v - a.v, b.u - a.u) * 180 / Math.PI, axisTolDeg: 30 };
}
function truthAssignment(r, o, asg) {
  let right = 0; let wrong = 0;
  for (let i = 0; i < o.count; i++) {
    asg[i] = -1;
    let bj = -1; let bd = 3;
    r.truth.forEach((q, j) => { const d = Math.hypot(q.u - o.x[i], q.v - o.y[i]); if (d < bd) { bd = d; bj = j; } });
    if (bj >= 0) asg[i] = idIndex.get(r.truth[bj].id);
  }
  return { right, wrong };
}
function battery(N, maxTilt) {
  let ok = 0; let safe = 0; let bad = 0; let tried = 0;
  for (let t = 0; t < N; t++) {
    const pose = randomPose(maxTilt);
    const r = renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: t });
    const o = det.detect(r.luma);
    if (o.count < 6) continue;
    tried++;
    const m = wm.match(o, { width: W, height: H, ...priorsOf(r, pose) });
    const truth = new Int32Array(o.count);
    truthAssignment(r, o, truth);
    let right = 0; let wrong = 0;
    for (let i = 0; i < o.count; i++) {
      if (m.detToModel[i] < 0) continue;
      if (m.detToModel[i] === truth[i]) right++; else wrong++;
    }
    if (m.ok && wrong === 0 && right >= 0.8 * o.count) ok++;
    else if (m.ok) bad++;
    else safe++;
  }
  return { tried, ok, safe, bad };
}

test('cold start with stance/gyro priors, tilt <= 20 deg: matches >= 90% of frames, never a wrong "ok"', () => {
  const b = battery(60, 20);
  console.log(`        tilt<=20: ${b.ok}/${b.tried} matched exactly, ${b.safe} refused (ok=false), ${b.bad} wrong-but-ok`);
  assert.equal(b.bad, 0);
  assert.ok(b.ok / b.tried >= 0.9, `${b.ok}/${b.tried}`);
});

test('cold start, tilt up to 35 deg: may refuse (ok=false) but never reports a wrong match as ok', () => {
  const b = battery(60, 35);
  console.log(`        tilt<=35: ${b.ok}/${b.tried} matched exactly, ${b.safe} refused, ${b.bad} wrong-but-ok`);
  assert.equal(b.bad, 0);
  assert.ok(b.ok / b.tried >= 0.5, `${b.ok}/${b.tried}`);
});

test('wrong-offset detection: a one-step lattice shift is rejected >= 99% when a landmark is visible', () => {
  // step shifts (one dot spacing along a grid line) and whole-tote shifts (16 in / 14 in, corner onto corner)
  const stepShifts = [[4, 0], [-4, 0], [0, 3.5], [0, -3.5]];
  const toteShifts = [[16, 0], [-16, 0], [0, 14], [0, -14]];
  let stepTrials = 0; let stepRejected = 0; let toteTrials = 0; let toteRejected = 0; let toteBlind = 0;
  let falseWrong = 0; let correctOk = 0;
  const truth = new Int32Array(256); const shifted = new Int32Array(256);
  for (let t = 0; t < 120; t++) {
    const pose = randomPose(25);
    if (t % 2 === 0) { pose.aimX = rnd() < 0.5 ? U(4, 12) : U(52, 60); pose.aimY = U(4, 12); pose.distanceIn = U(16, 26); } // origin / axis dots in view
    const r = renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 500 + t });
    const o = det.detect(r.luma);
    if (o.count < 8) continue;
    truthAssignment(r, o, truth);
    wm.evaluate(o, truth, null);
    if (wm.result.offset === OFFSET_WRONG) falseWrong++;
    if (wm.result.offset !== OFFSET_OK) continue; // no measurable landmark in this frame
    correctOk++;
    for (const group of [stepShifts, toteShifts]) {
      for (const [sdx, sdy] of group) {
        let kept = 0;
        for (let i = 0; i < o.count; i++) {
          shifted[i] = -1;
          if (truth[i] < 0) continue;
          const m = wm.nearestModel(wm.model.x[truth[i]] + sdx, wm.model.y[truth[i]] + sdy, 0.2);
          shifted[i] = m;
          if (m >= 0) kept++;
        }
        if (kept < 6) continue;
        // the origin (x2) / axis (x1.5) dot must still be part of the shifted labelling to tell tote copies apart
        let rare = false;
        for (let i = 0; i < o.count; i++) if (truth[i] >= 0 && shifted[i] >= 0 && wm.model.sizeClass[truth[i]] >= 2 && o.diameter[i] >= 10) rare = true;
        wm.evaluate(o, shifted, null);
        const wrong = wm.result.offset === OFFSET_WRONG;
        if (group === stepShifts) { stepTrials++; if (wrong) stepRejected++; } else if (rare) { toteTrials++; if (wrong) toteRejected++; } else toteBlind++;
      }
    }
  }
  const rate = stepRejected / stepTrials;
  const rateTote = toteRejected / Math.max(1, toteTrials);
  console.log(`        ${correctOk} frames with a measurable landmark; one-step shifts rejected ${stepRejected}/${stepTrials} (${(rate * 100).toFixed(1)}%)`);
  console.log(`        whole-tote shifts rejected ${toteRejected}/${toteTrials} when the origin/axis dot is in view; ${toteBlind} shifted labellings without it are indistinguishable (reported ambiguous by match())`);
  console.log(`        false "wrong" on the correct labelling: ${falseWrong}`);
  assert.ok(stepTrials >= 200, `step trials ${stepTrials}`);
  assert.ok(rate >= 0.99, `rate ${rate}`);
  assert.ok(toteTrials >= 10, `tote trials ${toteTrials}`);
  assert.ok(rateTote >= 0.99, `tote rate ${rateTote}`);
  assert.equal(falseWrong, 0);
});

test('no landmark in view and no prior: the periodic wall is reported ambiguous, not guessed', () => {
  const pose = { aimX: 32, aimY: 28, distanceIn: 20, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const r = renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 1 });
  const o = det.detect(r.luma);
  const m = wm.match(o, { width: W, height: H });
  assert.equal(m.ok, false);
  assert.equal(m.ambiguous, true);
  const withPrior = wm.match(o, { width: W, height: H, ...priorsOf(r, pose) });
  assert.equal(withPrior.ok, true);
  assert.ok(withPrior.rmsPx < 0.2);
});

test('track(): re-fits from a perturbed prior homography and keeps the labelling', () => {
  const pose = { aimX: 30, aimY: 26, distanceIn: 18, yawDeg: 12, pitchDeg: 6, rollDeg: 4 };
  const r = renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 2 });
  const o = det.detect(r.luma);
  const Hp = Float64Array.from(r.H);
  // 3% zoom error about the image centre plus a ~6 px shift
  const sc = 1.03; const cx = W / 2; const cy = H / 2;
  for (let c = 0; c < 3; c++) { Hp[c] = sc * Hp[c] + (1 - sc) * cx * Hp[6 + c]; Hp[3 + c] = sc * Hp[3 + c] + (1 - sc) * cy * Hp[6 + c]; }
  Hp[2] += 6; Hp[5] -= 5;
  const m = wm.track(o, Hp, { width: W, height: H });
  assert.ok(m.ok);
  const truth = new Int32Array(o.count);
  truthAssignment(r, o, truth);
  let wrong = 0;
  for (let i = 0; i < o.count; i++) if (m.detToModel[i] >= 0 && m.detToModel[i] !== truth[i]) wrong++;
  assert.equal(wrong, 0);
  assert.ok(m.inliers >= 0.9 * o.count);
  assert.ok(m.rmsPx < 0.2);
});

test('outlier blobs and missing dots: the matcher still labels the real dots correctly', () => {
  const pose = { aimX: 32, aimY: 28, distanceIn: 22, yawDeg: 8, pitchDeg: 5, rollDeg: 10 };
  const skip = new Set(['corner-r2-c1', 'gridh-r2-x7', 'gridv-c2-y6']);
  const blobs = [{ u: 100, v: 300, r: 12 }, { u: 400, v: 700, r: 10 }];
  const r = renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 3, skipIds: skip, extraBlobs: blobs });
  const o = det.detect(r.luma);
  const m = wm.match(o, { width: W, height: H, ...priorsOf(r, pose) });
  assert.ok(m.ok);
  const truth = new Int32Array(o.count);
  truthAssignment(r, o, truth);
  let wrong = 0; let matched = 0; let blobMatched = 0;
  for (let i = 0; i < o.count; i++) {
    if (m.detToModel[i] < 0) { if (truth[i] < 0) blobMatched += 0; continue; }
    matched++;
    if (truth[i] < 0) blobMatched++;
    else if (m.detToModel[i] !== truth[i]) wrong++;
  }
  assert.equal(wrong, 0);
  assert.equal(blobMatched, 0, 'blobs must not be labelled as wall dots');
  assert.ok(matched >= 10);
});

test('zero allocation: heap delta over 400 match() + 400 track() calls', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const pose = { aimX: 30, aimY: 26, distanceIn: 18, yawDeg: 12, pitchDeg: 6, rollDeg: 4 };
  const r = renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 2 });
  const o = det.detect(r.luma);
  const opts = { width: W, height: H, ...priorsOf(r, pose) };
  const topts = { width: W, height: H };
  const Hp = Float64Array.from(r.H);
  for (let i = 0; i < 50; i++) { wm.match(o, opts); wm.track(o, Hp, topts); }
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 400; i++) { wm.match(o, opts); wm.track(o, Hp, topts); }
  gc(); gc();
  const delta = process.memoryUsage().heapUsed - before;
  console.log(`        heap delta over 800 calls: ${delta} B`);
  assert.ok(delta / 800 < 16, `heap delta ${delta}`);
});

test('timing: match() and track() on a 20-dot frame', () => {
  const pose = { aimX: 30, aimY: 26, distanceIn: 18, yawDeg: 12, pitchDeg: 6, rollDeg: 4 };
  const r = renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 2 });
  const o = det.detect(r.luma);
  const opts = { width: W, height: H, ...priorsOf(r, pose) };
  const Hp = Float64Array.from(r.H);
  for (let i = 0; i < 50; i++) { wm.match(o, opts); wm.track(o, Hp, { width: W, height: H }); }
  let t0 = performance.now();
  for (let i = 0; i < 100; i++) wm.match(o, opts);
  const tm = (performance.now() - t0) / 100;
  t0 = performance.now();
  for (let i = 0; i < 100; i++) wm.track(o, Hp, { width: W, height: H });
  const tt = (performance.now() - t0) / 100;
  console.log(`        ${o.count} dots: match ${tm.toFixed(2)} ms (cold start, only on (re)acquisition), track ${tt.toFixed(3)} ms`);
  assert.ok(tt < 1, `track ${tt}`);
  assert.ok(tm < 10, `match ${tm}`);
});

assert.equal(OFFSET_UNVERIFIED, 0);
console.log(`All ${passed} M3 wall matcher tests passed.`);
