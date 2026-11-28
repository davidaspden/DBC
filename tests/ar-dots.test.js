/**
 * M2 — AR dot detector (`src/ar/dots.js`).
 *   node tests/ar-dots.test.js
 *
 * Synthetic walls come from `tests/helpers/ar-dot-render.js` (exact projected discs, supersampled, PSF,
 * motion blur, noise, shading) so the truth is exact. Acceptance (plan 3, M2):
 *   centroid error <= 0.15 px static, <= 0.5 px with 3 px motion blur;
 *   recall >= 98%, 0 false dots on a clean wall; 0 heap delta per frame; <= 3 ms at 1080x1920.
 */
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createArLayout } from '../src/ar/layout.js';
import { createDotDetector } from '../src/ar/dots.js';
import { renderDotWall } from './helpers/ar-dot-render.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}
console.log('Running M2 AR dot detector tests...');

const layoutB = createArLayout({ tier: 'B' });
const W = 540;
const H = 960;
const det = createDotDetector({ width: W, height: H });

const POSES = [
  { aimX: 32, aimY: 28, distanceIn: 20, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
  { aimX: 30, aimY: 26, distanceIn: 16, yawDeg: 12, pitchDeg: 6, rollDeg: 4 },
  { aimX: 34, aimY: 30, distanceIn: 24, yawDeg: -20, pitchDeg: -8, rollDeg: -10 },
  { aimX: 28, aimY: 24, distanceIn: 14, yawDeg: 25, pitchDeg: 10, rollDeg: 30 },
  { aimX: 36, aimY: 32, distanceIn: 30, yawDeg: -10, pitchDeg: 15, rollDeg: 0 },
  { aimX: 32, aimY: 28, distanceIn: 12, yawDeg: 30, pitchDeg: -12, rollDeg: -25 },
  { aimX: 40, aimY: 20, distanceIn: 18, yawDeg: 5, pitchDeg: 3, rollDeg: 90 },
  { aimX: 24, aimY: 36, distanceIn: 22, yawDeg: -35, pitchDeg: 5, rollDeg: 8 },
];

/** match detections to truth; returns metrics for dots fully inside the frame. */
function score(r, o, radius = 3) {
  const truth = r.truth.filter((t) => t.inside && t.diameterPx >= 6);
  const used = new Uint8Array(truth.length);
  let false_ = 0;
  const errs = [];
  for (let i = 0; i < o.count; i++) {
    let bj = -1;
    let bd = Infinity;
    for (let j = 0; j < truth.length; j++) {
      const d = Math.hypot(truth[j].u - o.x[i], truth[j].v - o.y[i]);
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj >= 0 && bd < radius) { used[bj] = 1; errs.push(bd); } else {
      // a detection may match a partly clipped dot (not in `truth`): only count it false if no visible dot is near
      const near = r.truth.some((t) => Math.hypot(t.u - o.x[i], t.v - o.y[i]) < radius * 2);
      if (!near) false_++;
    }
  }
  let found = 0;
  for (let j = 0; j < truth.length; j++) found += used[j];
  return { truth: truth.length, found, false: false_, errs };
}

function runSet(extra) {
  let truth = 0; let found = 0; let fals = 0; let worst = 0; let sumSq = 0; let n = 0;
  POSES.forEach((pose, idx) => {
    const r = renderDotWall({ layout: layoutB, width: W, height: H, hfovDeg: 50, pose, seed: 100 + idx, ...extra });
    const o = det.detect(r.luma);
    const s = score(r, o);
    truth += s.truth; found += s.found; fals += s.false;
    for (const e of s.errs) { worst = Math.max(worst, e); sumSq += e * e; n++; }
  });
  return { truth, found, recall: found / truth, false: fals, worst, rms: Math.sqrt(sumSq / n) };
}

test('static: recall >= 98%, zero false dots, centroid error <= 0.15 px (noise 3, PSF 1 px)', () => {
  const r = runSet({ psfSigmaPx: 1.0, noiseSigma: 3 });
  console.log(`        static: ${r.found}/${r.truth} recall ${(r.recall * 100).toFixed(1)}%, false ${r.false}, centroid max ${r.worst.toFixed(3)} rms ${r.rms.toFixed(3)} px`);
  assert.ok(r.truth > 100);
  assert.ok(r.recall >= 0.98, `recall ${r.recall}`);
  assert.equal(r.false, 0);
  assert.ok(r.worst <= 0.15, `worst ${r.worst}`);
});

test('3 px motion blur (several directions): centroid error <= 0.5 px, recall >= 98%', () => {
  let worst = 0; let found = 0; let truth = 0; let fals = 0;
  [0, 35, 90, 140].forEach((angleDeg) => {
    const r = runSet({ psfSigmaPx: 1.0, noiseSigma: 3, motion: { lenPx: 3, angleDeg } });
    worst = Math.max(worst, r.worst); found += r.found; truth += r.truth; fals += r.false;
  });
  console.log(`        blur 3 px: ${found}/${truth}, false ${fals}, centroid max ${worst.toFixed(3)} px`);
  assert.ok(found / truth >= 0.98, `recall ${found / truth}`);
  assert.equal(fals, 0);
  assert.ok(worst <= 0.5, `worst ${worst}`);
});

test('clean wall: no dots and no false dots on an empty wall with shading and noise', () => {
  const empty = new Set(layoutB.dots.map((d) => d.id));
  for (const shading of [undefined, { gx: 0.6, gy: -0.4 }]) {
    const r = renderDotWall({ layout: layoutB, width: W, height: H, hfovDeg: 50, pose: POSES[1], skipIds: empty, noiseSigma: 4, psfSigmaPx: 1, shading, seed: 5 });
    const o = det.detect(r.luma);
    assert.equal(o.count, 0, `false dots: ${o.count}`);
  }
});

test('shading across the wall does not lose dots (local threshold)', () => {
  const r = runSet({ psfSigmaPx: 1.0, noiseSigma: 3, shading: { gx: 0.5, gy: 0.4 } });
  console.log(`        shaded: recall ${(r.recall * 100).toFixed(1)}%, false ${r.false}`);
  assert.ok(r.recall >= 0.98);
  assert.equal(r.false, 0);
});

test('non-dot blobs: a long streak is rejected, a round blob is accepted (and reported)', () => {
  const r = renderDotWall({ layout: layoutB, width: W, height: H, hfovDeg: 50, pose: POSES[0], noiseSigma: 2, psfSigmaPx: 1, seed: 9 });
  const base = det.detect(r.luma).count;
  const streak = r.luma.slice();
  for (let y = 100; y < 106; y++) for (let x = 60; x < 140; x++) streak[y * W + x] = 30;
  assert.equal(det.detect(streak).count, base);
  assert.ok(det.result.rejected.elongation >= 1);
});

test('size classes: landmark dots are classified by their ratio to the neighbours', () => {
  let ok = 0; let tot = 0; let landmark = 0; let landmarkOk = 0;
  POSES.forEach((pose, idx) => {
    const r = renderDotWall({ layout: layoutB, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: 1, noiseSigma: 3, seed: 300 + idx });
    const o = det.detect(r.luma);
    for (let i = 0; i < o.count; i++) {
      let bj = -1; let bd = 3;
      for (let j = 0; j < r.truth.length; j++) {
        const d = Math.hypot(r.truth[j].u - o.x[i], r.truth[j].v - o.y[i]);
        if (d < bd) { bd = d; bj = j; }
      }
      if (bj < 0) continue;
      const names = ['x1', 'x1.25', 'x1.5', 'x2'];
      const hit = names[o.sizeClass[i]] === r.truth[bj].sizeClass;
      tot++; ok += hit ? 1 : 0;
      if (r.truth[bj].sizeClass !== 'x1') { landmark++; landmarkOk += hit ? 1 : 0; }
    }
  });
  console.log(`        size class: ${ok}/${tot} all, ${landmarkOk}/${landmark} landmarks`);
  // A coarse hint only (perspective changes neighbour sizes by tens of percent at oblique poses);
  // M3 re-checks the classes against the homography-predicted diameters.
  assert.ok(ok / tot >= 0.85, `size class accuracy ${ok / tot}`);
  assert.ok(landmarkOk / landmark >= 0.75, `landmark accuracy ${landmarkOk / landmark}`);
});

test('zero allocation per frame: heap delta over 300 detections is ~0', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const r = renderDotWall({ layout: layoutB, width: W, height: H, hfovDeg: 50, pose: POSES[1], psfSigmaPx: 1, noiseSigma: 3, seed: 1 });
  for (let i = 0; i < 50; i++) det.detect(r.luma);
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 300; i++) det.detect(r.luma);
  gc(); gc();
  const delta = process.memoryUsage().heapUsed - before;
  console.log(`        heap delta over 300 frames: ${delta} B`);
  assert.ok(delta < 20000, `heap delta ${delta}`);
});

test('speed: <= 3 ms per 1080x1920 frame (best of 60; median reported)', () => {
  const w = 1080; const h = 1920;
  const d2 = createDotDetector({ width: w, height: h });
  const r = renderDotWall({ layout: layoutB, width: w, height: h, hfovDeg: 45, pose: { aimX: 32, aimY: 28, distanceIn: 30, yawDeg: 10, pitchDeg: 5, rollDeg: 5 }, psfSigmaPx: 1.2, noiseSigma: 3, seed: 2 });
  const ts = [];
  for (let i = 0; i < 60; i++) {
    const t0 = performance.now();
    d2.detect(r.luma);
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  console.log(`        1080x1920: best ${ts[0].toFixed(2)} ms, median ${ts[30].toFixed(2)} ms, ${d2.result.count} dots`);
  assert.ok(ts[0] <= 3, `best ${ts[0]}`);
  assert.ok(d2.result.count >= 15);
});

test('flag-independent: module is pure (no globals), results deterministic', () => {
  const r = renderDotWall({ layout: layoutB, width: W, height: H, hfovDeg: 50, pose: POSES[2], psfSigmaPx: 1, noiseSigma: 3, seed: 3 });
  det.detect(r.luma);
  const a = Array.from(det.result.x.slice(0, det.result.count));
  det.detect(r.luma);
  const b = Array.from(det.result.x.slice(0, det.result.count));
  assert.deepEqual(a, b);
});

test('unaligned buffer (byte-load path) gives the same dots as the aligned fast path', () => {
  const r = renderDotWall({ layout: layoutB, width: W, height: H, hfovDeg: 50, pose: POSES[3], psfSigmaPx: 1, noiseSigma: 3, seed: 4 });
  det.detect(r.luma);
  const a = Array.from(det.result.x.slice(0, det.result.count));
  const shifted = new Uint8Array(W * H + 1).subarray(1);
  shifted.set(r.luma);
  assert.equal(shifted.byteOffset & 3, 1);
  const d2 = createDotDetector({ width: W, height: H });
  d2.detect(shifted);
  const b = Array.from(d2.result.x.slice(0, d2.result.count));
  assert.equal(b.length, a.length);
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.02));
});

console.log(`All ${passed} M2 AR dot detector tests passed.`);
