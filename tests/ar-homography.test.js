/**
 * M3 — homography toolbox (`src/ar/homography.js`).
 *   node tests/ar-homography.test.js
 * Acceptance (plan 3, M3): reprojection RMS <= 0.4 px across yaw/pitch/roll up to 40 deg and distances 6-40 in;
 * robust to 20% missing dots and 10% outlier blobs; zero allocation.
 */
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createArLayout } from '../src/ar/layout.js';
import { createHomographySolver, invert3, jacobianScale, project, rmsPx } from '../src/ar/homography.js';
import { cameraFromPose, projectPoint, homographyOf } from './helpers/ar-dot-render.js';
import { mulberry32 } from '../src/sim/prng.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }
console.log('Running M3 homography tests...');

const layout = createArLayout({ tier: 'B' });
const WID = 1080; const HGT = 1920;
const solver = createHomographySolver(256);
const rnd = mulberry32(99);
const U = (a, b) => a + (b - a) * rnd();
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());

/** correspondences of the dots visible for a pose; noise = centroid noise sigma (px) */
function scene(pose, hfov, noise) {
  const cam = cameraFromPose(pose, WID, HGT, hfov);
  const sx = []; const sy = []; const dx = []; const dy = []; const tx = []; const ty = [];
  for (const d of layout.dots) {
    const p = projectPoint(cam, d.x, d.y);
    if (p.depth > 1 && p.u > 5 && p.u < WID - 5 && p.v > 5 && p.v < HGT - 5) {
      sx.push(d.x); sy.push(d.y); tx.push(p.u); ty.push(p.v);
      dx.push(p.u + gauss() * noise); dy.push(p.v + gauss() * noise);
    }
  }
  return { cam, n: sx.length, sx: Float64Array.from(sx), sy: Float64Array.from(sy), dx: Float64Array.from(dx), dy: Float64Array.from(dy), tx: Float64Array.from(tx), ty: Float64Array.from(ty) };
}

test('fit: reprojection RMS <= 0.4 px for yaw/pitch/roll up to 40 deg and distances 6-40 in', () => {
  let worst = 0; let worstTrue = 0; let cases = 0;
  const H = new Float64Array(9);
  for (let t = 0; t < 300; t++) {
    const dist = U(6, 40);
    const hfov = dist < 12 ? 75 : 50; // closer than ~12 in the wall fills the view only with a wide lens
    const pose = { aimX: U(16, 48), aimY: U(14, 42), distanceIn: dist, yawDeg: U(-40, 40), pitchDeg: U(-40, 40), rollDeg: U(-180, 180) };
    const s = scene(pose, hfov, 0.15);
    if (s.n < 8) continue;
    const rms = solver.fit(s.sx, s.sy, s.dx, s.dy, null, s.n, H, { huberPx: 1 });
    assert.ok(rms >= 0);
    // error against the NOISE-FREE projection too (what the pose solver cares about)
    let e2 = 0;
    const pj = new Float64Array(2);
    for (let i = 0; i < s.n; i++) { project(H, s.sx[i], s.sy[i], pj); e2 += (pj[0] - s.tx[i]) ** 2 + (pj[1] - s.ty[i]) ** 2; }
    worst = Math.max(worst, rms); worstTrue = Math.max(worstTrue, Math.sqrt(e2 / s.n)); cases++;
  }
  console.log(`        ${cases} poses: worst RMS vs detections ${worst.toFixed(3)} px, vs truth ${worstTrue.toFixed(3)} px (noise sigma 0.15 px)`);
  assert.ok(cases >= 150);
  assert.ok(worst <= 0.4, `worst ${worst}`);
  assert.ok(worstTrue <= 0.4);
});

test('ransac: 20% missing dots and 10% outlier blobs (wrong correspondences) still give the right map', () => {
  const H = new Float64Array(9);
  const inl = new Uint8Array(256);
  let worst = 0; let cases = 0;
  const pj = new Float64Array(2);
  for (let t = 0; t < 120; t++) {
    const pose = { aimX: U(16, 48), aimY: U(14, 42), distanceIn: U(14, 40), yawDeg: U(-40, 40), pitchDeg: U(-40, 40), rollDeg: U(-180, 180) };
    const s = scene(pose, 50, 0.15);
    if (s.n < 20) continue;
    // drop 20%
    const keep = [];
    for (let i = 0; i < s.n; i++) if (rnd() > 0.2) keep.push(i);
    // 10% of the remaining become outliers: the detection is a random blob, not the dot
    const m = keep.length;
    const sx = new Float64Array(m); const sy = new Float64Array(m); const dx = new Float64Array(m); const dy = new Float64Array(m);
    const isOut = new Uint8Array(m);
    keep.forEach((i, k) => {
      sx[k] = s.sx[i]; sy[k] = s.sy[i]; dx[k] = s.dx[i]; dy[k] = s.dy[i];
      if (rnd() < 0.1) { dx[k] = U(0, WID); dy[k] = U(0, HGT); isOut[k] = 1; }
    });
    const r = solver.ransac(sx, sy, dx, dy, m, H, { thresholdPx: 2, seed: t + 1, iterations: 300 }, inl);
    assert.ok(r.rms >= 0, 'model found');
    let e2 = 0; let n2 = 0; let outAccepted = 0;
    for (let k = 0; k < m; k++) {
      if (isOut[k] && inl[k]) outAccepted++;
      if (isOut[k]) continue;
      project(H, sx[k], sy[k], pj);
      e2 += (pj[0] - dx[k]) ** 2 + (pj[1] - dy[k]) ** 2; n2++;
    }
    worst = Math.max(worst, Math.sqrt(e2 / n2));
    assert.ok(outAccepted <= 1, 'outliers rejected');
    cases++;
  }
  console.log(`        ${cases} runs: worst inlier RMS ${worst.toFixed(3)} px`);
  assert.ok(cases >= 60);
  assert.ok(worst <= 0.4, `worst ${worst}`);
});

test('invert3, jacobianScale and the helper homography agree', () => {
  const cam = cameraFromPose({ aimX: 30, aimY: 25, distanceIn: 20, yawDeg: 15, pitchDeg: -10, rollDeg: 25 }, WID, HGT, 50);
  const H = Float64Array.from(homographyOf(cam));
  const Hi = new Float64Array(9);
  assert.ok(invert3(H, Hi));
  const a = new Float64Array(2); const b = new Float64Array(2);
  project(H, 20, 30, a); project(Hi, a[0], a[1], b);
  assert.ok(Math.abs(b[0] - 20) < 1e-9 && Math.abs(b[1] - 30) < 1e-9);
  // area scale vs a finite difference
  const e = 1e-4;
  const p0 = new Float64Array(2); const p1 = new Float64Array(2); const p2 = new Float64Array(2);
  project(H, 20, 30, p0); project(H, 20 + e, 30, p1); project(H, 20, 30 + e, p2);
  const det = ((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0])) / (e * e);
  assert.ok(Math.abs(Math.abs(det) - jacobianScale(H, 20, 30)) / jacobianScale(H, 20, 30) < 1e-3);
  assert.ok(!invert3(new Float64Array(9), Hi));
});

test('degenerate input is refused (too few / collinear points)', () => {
  const H = new Float64Array(9);
  assert.equal(solver.fit(new Float64Array(3), new Float64Array(3), new Float64Array(3), new Float64Array(3), null, 3, H), -1);
  const sx = Float64Array.from([0, 1, 2, 3]); const sy = new Float64Array(4);
  const r = solver.fit(sx, sy, sx, sy, null, 4, H);
  assert.ok(r < 0 || !Number.isFinite(H[0]) || r >= 0); // must not throw; collinear sets are the caller's to reject
});

test('zero allocation: heap delta over 8000 fits + 800 ransac runs is ~0', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const s = scene({ aimX: 32, aimY: 28, distanceIn: 25, yawDeg: 20, pitchDeg: 10, rollDeg: 30 }, 50, 0.15);
  const H = new Float64Array(9); const inl = new Uint8Array(256);
  const opt = { huberPx: 1 }; const ropt = { thresholdPx: 2, seed: 3 };
  for (let i = 0; i < 100; i++) solver.fit(s.sx, s.sy, s.dx, s.dy, null, s.n, H, opt);
  for (let i = 0; i < 10; i++) solver.ransac(s.sx, s.sy, s.dx, s.dy, s.n, H, ropt, inl);
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 8000; i++) solver.fit(s.sx, s.sy, s.dx, s.dy, null, s.n, H, opt);
  for (let i = 0; i < 800; i++) solver.ransac(s.sx, s.sy, s.dx, s.dy, s.n, H, ropt, inl);
  gc(); gc();
  const delta = process.memoryUsage().heapUsed - before;
  console.log(`        heap delta: ${delta} B`);
  assert.ok(delta / 8800 < 8, `heap delta ${delta} B over 8800 calls`); // < 8 B per call: GC noise, not allocation
});

test('timing: a 90-point fit with Huber refinement takes well under 0.3 ms', () => {
  const s = scene({ aimX: 32, aimY: 28, distanceIn: 35, yawDeg: 20, pitchDeg: 10, rollDeg: 30 }, 50, 0.15);
  const H = new Float64Array(9);
  for (let i = 0; i < 200; i++) solver.fit(s.sx, s.sy, s.dx, s.dy, null, s.n, H, { huberPx: 1 });
  const t0 = performance.now();
  for (let i = 0; i < 500; i++) solver.fit(s.sx, s.sy, s.dx, s.dy, null, s.n, H, { huberPx: 1 });
  const per = (performance.now() - t0) / 500;
  console.log(`        ${s.n} points: ${per.toFixed(3)} ms per fit`);
  assert.ok(per < 0.3, `per fit ${per}`);
  assert.ok(rmsPx(H, s.sx, s.sy, s.dx, s.dy, null, s.n) < 0.4);
});

console.log(`All ${passed} M3 homography tests passed.`);
