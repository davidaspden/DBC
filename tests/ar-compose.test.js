/**
 * M6 — AR label compositor (`src/ar/compose.js`). Run: node --expose-gc tests/ar-compose.test.js
 */
import assert from 'node:assert/strict';
import { createCompositor, headOnHomography } from '../src/ar/compose.js';
import { createScene } from '../src/sim/scene.js';
import { renderFrame, createCpuRenderContext } from '../src/sim/cpu-render.js';
import { createPipelineState, createPipelineResult, processFrameMulti, extractMultiDetections } from '../src/worker/scanner.worker.js';

let passed = 0;
async function test(name, fn) { await fn(); console.log(`  PASS  ${name}`); passed++; }

const HFOV = 70.7;
const scene = createScene({ fcMode: true, shadowStrength: 0, noiseStrength: 0, glareStrength: 0 });
const cell = scene.cells[5]; // R2C2
const aimX = cell.cx + scene.wallWidthIn / 2; const aimY = scene.wallHeightIn / 2 - cell.cy;
const flatPh = { valid: true, whitePoint: 200, blackPoint: 30, shadingGx: 0, shadingGy: 0, noiseSigma: 0, psfSigmaPx: 0 };
const Hm = new Float64Array(9);

function wallFrame(W, H, v = 200) { return new Uint8Array(W * H).fill(v); }
function decodes(luma, W, H, payload) {
  const ws = createPipelineState(W, H); const wr = createPipelineResult();
  processFrameMulti(luma, W, H, ws, wr, false);
  return extractMultiDetections(ws).some((d) => d.payload === payload);
}
function labelRect(W, H, z) { // px rect of the target label, head-on
  const f = (W / 2) / Math.tan((HFOV * Math.PI) / 360); const s = f / z;
  return { x0: Math.ceil(W / 2 - s * 1.0) + 2, x1: Math.floor(W / 2 + s * 1.0) - 2, y0: Math.ceil(H / 2 - s * 1.75) + 2, y1: Math.floor(H / 2 + s * 1.75) - 2 };
}

await test('M6 flag off: compose copies the raw frame bit-for-bit and draws nothing', () => {
  const W = 320; const H = 240;
  const raw = new Uint8Array(W * H); for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) & 255;
  const out = new Uint8Array(W * H);
  const c = createCompositor({ width: W, height: H, scene, enabled: false });
  assert.equal(c.compose(raw, headOnHomography(W, H, HFOV, 10, aimX, aimY, Hm), flatPh, out), 0);
  assert.equal(Buffer.compare(raw, out), 0);
  assert.equal(createCompositor({ width: W, height: H, scene }).enabled, false, 'arCompose defaults off');
});

await test('M6 geometry and contrast match the R5 CPU render of the same label (mean residual < 6/255)', () => {
  const W = 1280; const H = 720; const z = 8;
  const comp = createCompositor({ width: W, height: H, scene, enabled: true, labelPaperRel: 1 });
  const out = new Uint8Array(W * H);
  comp.compose(wallFrame(W, H), headOnHomography(W, H, HFOV, z, aimX, aimY, Hm), flatPh, out);
  const ref = new Uint8Array(W * H);
  renderFrame(scene, [{ x: cell.cx, y: cell.cy, z, yawDeg: 0, pitchDeg: 0, rollDeg: 0 }], { width: W, height: H, hfovDeg: HFOV, shadowStrength: 0, noiseStrength: 0, glareStrength: 0, ctx: createCpuRenderContext(scene.cells.length), seed: 1 }, ref);
  // CPU render has its own illumination: fit ref = a*out + b over the label, then compare
  const r = labelRect(W, H, z);
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) { const a = out[y * W + x]; const b = ref[y * W + x]; sx += a; sy += b; sxx += a * a; sxy += a * b; n++; }
  const k = (n * sxy - sx * sy) / (n * sxx - sx * sx); const b0 = (sy - k * sx) / n;
  let err = 0;
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) err += Math.abs(k * out[y * W + x] + b0 - ref[y * W + x]);
  err /= n;
  console.log(`        composite vs CPU render: gain ${k.toFixed(3)}, mean residual ${err.toFixed(2)}/255`);
  assert.ok(k > 0.3 && err < 6, `residual ${err}`);
  assert.equal(decodes(out, W, H, cell.payload), decodes(ref, W, H, cell.payload), 'composite decodes exactly when the CPU render does');
  assert.ok(decodes(out, W, H, cell.payload), 'composited label decodes at 8 in');
});

await test('M6 decode threshold in px/module matches the CPU render within 0.1', () => {
  const W = 1280; const H = 720;
  const f = (W / 2) / Math.tan((HFOV * Math.PI) / 360);
  const tm = 20 + (cell.payload.length + 2) * 11 + 13;
  const comp = createCompositor({ width: W, height: H, scene, enabled: true, labelPaperRel: 1 });
  const ctx = createCpuRenderContext(scene.cells.length);
  const out = new Uint8Array(W * H); const ref = new Uint8Array(W * H); const wall = wallFrame(W, H);
  let thrC = null; let thrR = null;
  for (let ppm = 2.0; ppm >= 0.8; ppm -= 0.05) {
    const z = (f * 3.5) / (ppm * tm);
    comp.compose(wall, headOnHomography(W, H, HFOV, z, aimX, aimY, Hm), flatPh, out);
    renderFrame(scene, [{ x: cell.cx, y: cell.cy, z, yawDeg: 0, pitchDeg: 0, rollDeg: 0 }], { width: W, height: H, hfovDeg: HFOV, shadowStrength: 0, noiseStrength: 0, glareStrength: 0, ctx, seed: 1 }, ref);
    if (thrC === null && !decodes(out, W, H, cell.payload)) thrC = ppm + 0.05;
    if (thrR === null && !decodes(ref, W, H, cell.payload)) thrR = ppm + 0.05;
    if (thrC !== null && thrR !== null) break;
  }
  thrC ??= 0.8; thrR ??= 0.8;
  console.log(`        lowest decoding px/module: composite ${thrC.toFixed(2)}, CPU render ${thrR.toFixed(2)}`);
  assert.ok(Math.abs(thrC - thrR) <= 0.1 + 1e-9, `${thrC} vs ${thrR}`);
});

await test('M6 PSF: blurred composite equals the sharp composite blurred by a reference 2D Gaussian (< 6/255 mean)', () => {
  const W = 400; const H = 400; const z = 10; const sigma = 1.5;
  const comp = createCompositor({ width: W, height: H, scene, enabled: true });
  const sharp = new Uint8Array(W * H); const blur = new Uint8Array(W * H);
  headOnHomography(W, H, HFOV, z, aimX, aimY, Hm);
  comp.compose(wallFrame(W, H), Hm, flatPh, sharp);
  comp.compose(wallFrame(W, H), Hm, { ...flatPh, psfSigmaPx: sigma }, blur);
  const R = Math.ceil(3 * sigma); const kk = []; let s = 0;
  for (let k = -R; k <= R; k++) { kk.push(Math.exp(-(k * k) / (2 * sigma * sigma))); s += kk[kk.length - 1]; }
  const r = labelRect(W, H, z);
  let err = 0; let n = 0;
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) {
    let acc = 0;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) acc += kk[j + R] * kk[i + R] * sharp[(y + j) * W + x + i];
    err += Math.abs(acc / (s * s) - blur[y * W + x]); n++;
  }
  err /= n;
  console.log(`        blur mean diff ${err.toFixed(2)}/255`);
  assert.ok(err < 6, `${err}`);
  assert.notEqual(Buffer.compare(sharp, blur), 0);
});

await test('M6 shading and matched noise follow the photometry (paper luma, noise sigma within 15%)', () => {
  const W = 400; const H = 400; const z = 8;
  const comp = createCompositor({ width: W, height: H, scene, enabled: true });
  const out = new Uint8Array(W * H);
  comp.compose(wallFrame(W, H, 120), headOnHomography(W, H, HFOV, z, aimX, aimY, Hm), { ...flatPh, noiseSigma: 4, shadingGx: 0.2 }, out, 9);
  // quiet zone at the top of the ladder label: plain paper
  const f = (W / 2) / Math.tan((HFOV * Math.PI) / 360); const s = f / z;
  const yq = Math.round(H / 2 - s * 1.75 + 4);
  let sum = 0; let sq = 0; let n = 0;
  for (let x = Math.round(W / 2 - s * 0.6); x < Math.round(W / 2 + s * 0.6); x++) { const d = out[yq * W + x] - 0.95 * 200 * (1 + 0.2 * ((x + 0.5) / W - 0.5)); sum += d; sq += d * d; n++; }
  const mean = sum / n; const sd = Math.sqrt(sq / n - mean * mean);
  console.log(`        paper bias ${mean.toFixed(2)}, noise sd ${sd.toFixed(2)} (target 4)`);
  assert.ok(Math.abs(mean) < 1.5 && Math.abs(sd - 4) < 0.6, `${mean} ${sd}`);
});

await test('M6 budget: 4 visible labels at 1080x1920 in <= 6 ms median on the box, zero allocation per frame', () => {
  const W = 1080; const H = 1920;
  const comp = createCompositor({ width: W, height: H, scene, enabled: true });
  const raw = wallFrame(W, H); const out = new Uint8Array(W * H);
  // aim between R2C2, R2C3, R3C2, R3C3 at 20 in: 4 labels in view
  headOnHomography(W, H, 60, 20, scene.wallWidthIn / 2, scene.wallHeightIn / 2, Hm);
  const ph = { ...flatPh, psfSigmaPx: 1.2, noiseSigma: 3, shadingGx: 0.1, shadingGy: -0.1 };
  for (let i = 0; i < 5; i++) comp.compose(raw, Hm, ph, out, i + 1);
  assert.ok(comp.stats.labelsDrawn >= 4, `drawn ${comp.stats.labelsDrawn}`);
  const ts = [];
  for (let i = 0; i < 21; i++) { const t = process.hrtime.bigint(); comp.compose(raw, Hm, ph, out, i + 1); ts.push(Number(process.hrtime.bigint() - t) / 1e6); }
  ts.sort((a, b) => a - b);
  console.log(`        compose 1080x1920, ${comp.stats.labelsDrawn} labels: median ${ts[10].toFixed(2)} ms, p95 ${ts[19].toFixed(2)} ms`);
  assert.ok(ts[10] <= 6, `median ${ts[10]} ms`);
  if (typeof global.gc === 'function') {
    global.gc(); const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < 30; i++) comp.compose(raw, Hm, ph, out, i + 1);
    global.gc(); const per = (process.memoryUsage().heapUsed - h0) / 30;
    console.log(`        heap ${per.toFixed(1)} B/frame`);
    assert.ok(per < 32, `${per} B/frame`);
  }
});

console.log(`\nAll ${passed} M6 compositor tests passed.`);
