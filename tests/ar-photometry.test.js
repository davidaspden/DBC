/**
 * M5 — wall photometry estimator (`src/ar/photometry.js`), flag `arCompose`.
 *   node tests/ar-photometry.test.js
 * Acceptance (plan 3, M5): PSF / noise / shading recovered within 15%; black and white points within 5/255.
 */
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createArLayout } from '../src/ar/layout.js';
import { createDotDetector } from '../src/ar/dots.js';
import { createPhotometryEstimator } from '../src/ar/photometry.js';
import { isSimOn } from '../src/sim/simflags.js';
import { renderDotWall } from './helpers/ar-dot-render.js';
import { mulberry32 } from '../src/sim/prng.js';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }
console.log('Running M5 photometry tests...');

const layout = createArLayout({ tier: 'B' });
const W = 540; const H = 960;
const det = createDotDetector({ width: W, height: H });
const ph = createPhotometryEstimator({ width: W, height: H, enabled: true });
const rnd = mulberry32(5);
const U = (a, b) => a + (b - a) * rnd();

function render(c, seed) {
  const pose = { aimX: U(26, 38), aimY: U(20, 34), distanceIn: U(14, 20), yawDeg: U(-12, 12), pitchDeg: U(-10, 10), rollDeg: U(-20, 20) };
  return renderDotWall({ layout, width: W, height: H, hfovDeg: 50, pose, psfSigmaPx: c.psf, noiseSigma: c.noise, paper: c.paper, ink: c.ink, shading: c.shading, motion: c.motion, seed });
}

test('recovers PSF, noise, shading within 15% and black/white within 5/255 over 24 random walls', () => {
  let worstPsf = 0; let worstNoise = 0; let worstWhite = 0; let worstBlack = 0; let worstShade = 0; let valid = 0;
  for (let t = 0; t < 24; t++) {
    const c = {
      psf: U(0.8, 2.6), noise: U(1.5, 6), paper: U(150, 205), ink: U(10, 60),
      shading: t % 3 === 0 ? null : { gx: U(-0.4, 0.4), gy: U(-0.4, 0.4) },
    };
    const r = render(c, 100 + t);
    const o = det.detect(r.luma);
    const e = ph.estimate(r.luma, o);
    if (!e.valid) continue;
    valid++;
    // the shading multiplies paper and ink alike; the centre of the image is the reference
    worstPsf = Math.max(worstPsf, Math.abs(e.psfSigmaPx - c.psf) / c.psf);
    worstNoise = Math.max(worstNoise, Math.abs(e.noiseSigma - c.noise) / c.noise);
    worstWhite = Math.max(worstWhite, Math.abs(e.whitePoint - c.paper));
    worstBlack = Math.max(worstBlack, Math.abs(e.blackPoint - c.ink));
    if (c.shading) worstShade = Math.max(worstShade, Math.abs(e.shadingGx - c.shading.gx), Math.abs(e.shadingGy - c.shading.gy));
  }
  console.log(`        ${valid}/24 valid: PSF worst ${(worstPsf * 100).toFixed(1)}%, noise ${(worstNoise * 100).toFixed(1)}%, white ${worstWhite.toFixed(2)}/255, black ${worstBlack.toFixed(2)}/255, shading gradient error ${worstShade.toFixed(3)} (fraction across the frame)`);
  assert.ok(valid >= 22);
  assert.ok(worstPsf <= 0.15, `psf ${worstPsf}`);
  assert.ok(worstNoise <= 0.15, `noise ${worstNoise}`);
  assert.ok(worstWhite <= 5, `white ${worstWhite}`);
  assert.ok(worstBlack <= 5, `black ${worstBlack}`);
  assert.ok(worstShade <= 0.05, `shading ${worstShade}`);
});

test('motion blur shows up as direction-dependent PSF width (min/max per ray direction)', () => {
  const still = render({ psf: 1.0, noise: 2, paper: 200, ink: 30, shading: null }, 7);
  const blur = render({ psf: 1.0, noise: 2, paper: 200, ink: 30, shading: null, motion: { lenPx: 4, angleDeg: 0 } }, 7);
  const a = { ...ph.estimate(still.luma, det.detect(still.luma)) };
  const b = { ...ph.estimate(blur.luma, det.detect(blur.luma)) };
  const ratioStill = a.psfSigmaMax / a.psfSigmaMin;
  const ratioBlur = b.psfSigmaMax / b.psfSigmaMin;
  console.log(`        direction ratio max/min: still ${ratioStill.toFixed(2)}, 4 px blur ${ratioBlur.toFixed(2)}`);
  assert.ok(ratioStill < 1.15);
  assert.ok(ratioBlur > 1.4);
});

test('flag gating: arCompose is off by default; a disabled estimator reports nothing', () => {
  assert.equal(isSimOn('arCompose'), false);
  const off = createPhotometryEstimator({ width: W, height: H });
  assert.equal(off.enabled, false);
  const r = render({ psf: 1, noise: 2, paper: 200, ink: 30, shading: null }, 9);
  assert.equal(off.estimate(r.luma, det.detect(r.luma)).valid, false);
});

test('too little clean wall or too few big dots: valid = false (callers keep the last estimate)', () => {
  const flat = new Uint8Array(W * H).fill(200);
  det.detect(flat);
  assert.equal(ph.estimate(flat, det.result).valid, false); // no dots at all
  const near = render({ psf: 1, noise: 2, paper: 200, ink: 30, shading: null }, 11);
  const o = det.detect(near.luma);
  const saved = o.count;
  o.count = 1; // one dot only
  assert.equal(ph.estimate(near.luma, o).valid, false);
  o.count = saved;
});

test('zero allocation: heap delta over 400 estimates', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const r = render({ psf: 1.2, noise: 3, paper: 200, ink: 30, shading: { gx: 0.2, gy: 0.1 } }, 12);
  const o = det.detect(r.luma);
  for (let i = 0; i < 300; i++) ph.estimate(r.luma, o);
  gc(); gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 600; i++) ph.estimate(r.luma, o);
  gc(); gc();
  const delta = process.memoryUsage().heapUsed - before;
  console.log(`        heap delta over 600 estimates: ${delta} B (${(delta / 600).toFixed(1)} B/call)`);
  assert.ok(delta / 600 < 16, `heap delta ${delta}`);
});

test('timing: one estimate at 1080x1920', () => {
  const w = 1080; const h = 1920;
  const d2 = createDotDetector({ width: w, height: h });
  const p2 = createPhotometryEstimator({ width: w, height: h, enabled: true });
  const r = renderDotWall({ layout, width: w, height: h, hfovDeg: 50, pose: { aimX: 32, aimY: 28, distanceIn: 28, yawDeg: 6, pitchDeg: 3, rollDeg: 5 }, psfSigmaPx: 1.4, noiseSigma: 3, shading: { gx: 0.2, gy: -0.1 }, seed: 13 });
  const o = d2.detect(r.luma);
  let e = p2.estimate(r.luma, o);
  for (let i = 0; i < 20; i++) e = p2.estimate(r.luma, o);
  const ts = [];
  for (let i = 0; i < 40; i++) { const t0 = performance.now(); p2.estimate(r.luma, o); ts.push(performance.now() - t0); }
  ts.sort((a, b) => a - b);
  console.log(`        1080x1920: best ${ts[0].toFixed(2)} ms, median ${ts[20].toFixed(2)} ms (valid=${e.valid}; run at ~1 Hz or on key frames, not every frame)`);
  assert.ok(e.valid);
  assert.ok(ts[20] < 6, `median ${ts[20]}`);
});

console.log(`All ${passed} M5 photometry tests passed.`);
