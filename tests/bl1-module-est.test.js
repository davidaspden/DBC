/**
 * BL1 — Module-Width Estimate (Crib-First + Autocorrelation Fallback) & Derived-Range Early-Reject Tests.
 *   node --expose-gc tests/bl1-module-est.test.js
 *
 * Verifies:
 *  1. Flags-off bit-identical behavior vs `flags = 0` (zero side-effects when FLAG_MODULE_EST is OFF).
 *  2. Crib-first primary estimator (`moduleSource = 1`, `cribSpanQ8 / 44`) and bounded integer
 *     autocorrelation fallback (`moduleSource = 2`, divisor selection `/1../4`) accuracy vs ground truth.
 *  3. Real still (`tests/fixtures-sim/tote-tsX07wz7py1-gray.pgm.gz`) decode under `moduleEst`.
 *  4. Negatives (`src/sim/negatives.js`): strong early-reject rate on non-barcode clutter + 0 FP.
 *  5. Sim defects (`src/sim/defects.js`): blur, print gain, tilt decode cleanly under `moduleEst`.
 *  6. Close-range (~10-14 px/mod) + far-range (~1.5 px/mod) pair proving derived range never
 *     rejects valid close-range or far-range labels (no hard-coded 1.6-8 px clamp).
 *  7. Zero-allocation hot-loop heap check (`--expose-gc`).
 *  8. `fc-tele-30-3p5` oblique-tail 0 FP under `moduleEst`, `W-fc+moduleEst`, and `W-all`.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  synthesizeFixture,
  buildSyntheticTestMatrix,
  parsePGM,
  createScanResult,
  resetScanResult,
} from './harness.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrame,
  processFrameMulti,
  extractPayloadString,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import {
  FLAG_MODULE_EST,
  FLAG_CRIB_MATCH,
  FLAG_STOP_GUARD,
  createScanlineState,
  extractRunsFromScanline,
  estimateModuleWidthQ8,
  updateDerivedModuleRangeQ8,
} from '../src/worker/scanline.js';
import { computeCode128Modules } from '../src/array/config.js';
import { generateNegativeSuite, scoreNegativeFixture } from '../src/sim/negatives.js';
import { createSceneForPreset } from '../src/sim/presets.js';
import { sampleCameraPose } from '../src/sim/paths.js';
import { createCpuRenderContext, renderFrame, mulberry32 } from '../src/sim/cpu-render.js';
import { createScenarioFromPreset, resolveFlagSet } from '../tools/gate/scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_STILL_PATH = path.resolve(__dirname, 'fixtures-sim', 'tote-tsX07wz7py1-gray.pgm.gz');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running BL1 moduleEst tests...');

test('BL1 flags-off bit-identical parity vs flags = 0', () => {
  const fixtures = buildSyntheticTestMatrix();
  const stateA = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const stateB = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const resA = createScanResult();
  const resB = createScanResult();

  for (const fx of fixtures) {
    stateA.flags = 0;
    stateB.flags = 0;
    resetScanResult(resA);
    resetScanResult(resB);

    const detA = processFrame(fx.luma, fx.width, fx.height, stateA, resA, false);
    const detB = processFrame(fx.luma, fx.width, fx.height, stateB, resB, false);

    assert.equal(detA, detB, `flags=0 parity mismatch on ${fx.name}`);
    assert.equal(extractPayloadString(resA), extractPayloadString(resB));
    assert.equal(resA.consensusCount, resB.consensusCount);
    assert.equal(resA.thetaDeg, resB.thetaDeg);
    assert.equal(stateA.scanline.linesEvaluated, 0, 'linesEvaluated must stay 0 when FLAG_MODULE_EST is OFF');
    assert.equal(stateA.scanline.linesRejectedEarly, 0, 'linesRejectedEarly must stay 0 when FLAG_MODULE_EST is OFF');
    assert.equal(stateA.scanline.moduleSource, 0, 'moduleSource must stay 0 when FLAG_MODULE_EST is OFF');
  }
});

test('BL1 crib-first (source=1) and autocorrelation fallback (source=2) accuracy vs ground truth', () => {
  const scanState = createScanlineState();
  const errors = [];

  // 1. Crib-first path on tsX labels across module widths 1.5 .. 6.0 px
  for (const modPx of [1.5, 2.0, 2.8, 4.0, 6.0]) {
    const fix = synthesizeFixture({
      name: `bl1_crib_${modPx}`,
      width: 1280,
      height: 720,
      symbology: 'CODE_128',
      payload: 'tsX07wz7py1',
      angleDeg: 0,
      modulePx: modPx,
      barHeightPx: 100,
      centerX: 640,
      centerY: 360,
    });
    const rowOff = 360 * 1280;
    scanState.roiMajorLen = computeCode128Modules(11, 0) * modPx;
    scanState.expectedModules = computeCode128Modules(11);
    const rc = extractRunsFromScanline(fix.luma, rowOff, 1280, scanState, 72, 18);
    assert.ok(rc >= 25);
    const ok = estimateModuleWidthQ8(fix.luma, rowOff, 1280, scanState, 1, 0);
    assert.equal(ok, 1, `crib estimator must accept valid tsX at ${modPx} px/mod`);
    assert.equal(scanState.moduleSource, 1, `expected moduleSource=1 (crib) at ${modPx} px/mod`);
    const estPx = scanState.moduleWidthQ8 / 256.0;
    const relErr = Math.abs(estPx - modPx) / modPx;
    errors.push({ kind: 'crib', modPx, estPx, relErr });
    assert.ok(relErr < 0.05, `crib modPx=${modPx} est=${estPx.toFixed(3)} err=${(relErr * 100).toFixed(2)}% >= 5%`);
  }

  // 2. Autocorrelation fallback path on non-tsX labels across module widths 1.5 .. 6.0 px
  for (const modPx of [1.5, 2.0, 3.0, 4.5, 6.0]) {
    const fix = synthesizeFixture({
      name: `bl1_ac_${modPx}`,
      width: 1280,
      height: 720,
      symbology: 'CODE_128',
      payload: 'SHIP-987654',
      angleDeg: 0,
      modulePx: modPx,
      barHeightPx: 100,
      centerX: 640,
      centerY: 360,
    });
    const rowOff = 360 * 1280;
    scanState.roiMajorLen = computeCode128Modules(11, 0) * modPx;
    scanState.expectedModules = 0;
    const rc = extractRunsFromScanline(fix.luma, rowOff, 1280, scanState, 72, 18);
    assert.ok(rc >= 25);
    const ok = estimateModuleWidthQ8(fix.luma, rowOff, 1280, scanState, 1, 0);
    assert.equal(ok, 1, `autocorr estimator must accept valid non-tsX at ${modPx} px/mod`);
    assert.equal(scanState.moduleSource, 2, `expected moduleSource=2 (autocorr) at ${modPx} px/mod`);
    const estPx = scanState.moduleWidthQ8 / 256.0;
    const relErr = Math.abs(estPx - modPx) / modPx;
    errors.push({ kind: 'autocorr', modPx, estPx, relErr });
    assert.ok(relErr < 0.12, `autocorr modPx=${modPx} est=${estPx.toFixed(3)} err=${(relErr * 100).toFixed(2)}% >= 12%`);
  }

  const maxErrPct = Math.max(...errors.map((e) => e.relErr)) * 100;
  const meanErrPct = (errors.reduce((s, e) => s + e.relErr, 0) / errors.length) * 100;
  console.log(`    [metric] module-width error: mean=${meanErrPct.toFixed(2)}%, max=${maxErrPct.toFixed(2)}%`);
});

test('BL1 decodes 14/14 harness fixtures and real still tote-tsX07wz7py1-gray.pgm.gz', () => {
  // 1. Harness 14 positive + 2 negative fixtures
  const fixtures = buildSyntheticTestMatrix();
  const state = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const res = createScanResult();
  state.flags = FLAG_MODULE_EST;

  let posOk = 0;
  let posTotal = 0;
  let negFp = 0;
  for (const fx of fixtures) {
    resetScanResult(res);
    const det = processFrame(fx.luma, fx.width, fx.height, state, res, false);
    const got = det === 1 ? extractPayloadString(res) : null;
    if (fx.symbology === 'CODE_128') {
      posTotal++;
      if (det === 1 && got === fx.payload) posOk++;
    } else if (det === 1) {
      negFp++;
    }
  }
  assert.equal(posOk, posTotal, `expected ${posTotal}/${posTotal} harness decoded with moduleEst, got ${posOk}`);
  assert.equal(negFp, 0, `expected 0 harness negative FPs, got ${negFp}`);

  // 2. Real still fixture
  const gz = fs.readFileSync(REAL_STILL_PATH);
  const pgm = parsePGM(zlib.gunzipSync(gz));
  const stReal = createPipelineState(pgm.width, pgm.height);
  const resReal = createPipelineResult();
  stReal.flags = FLAG_MODULE_EST;

  const detReal = processFrame(pgm.luma, pgm.width, pgm.height, stReal, resReal, true);
  assert.equal(detReal, 1, 'real still tote-tsX07wz7py1 must decode with FLAG_MODULE_EST');
  assert.equal(extractPayloadString(resReal), 'tsX07wz7py1');
  assert.ok(stReal.scanline.linesEvaluated >= 2, 'must evaluate scanlines when FLAG_MODULE_EST is ON');
  assert.ok(stReal.scanline.moduleWidthQ8 > 0, 'must populate moduleWidthQ8 on real still');
  console.log(
    `    [metric] real still: payload=${extractPayloadString(resReal)}, modPx=${(stReal.scanline.moduleWidthQ8 / 256).toFixed(2)}, src=${stReal.scanline.moduleSource}, tTotal=${resReal.tTotalMs.toFixed(2)}ms`
  );
});

test('BL1 close-range (~10-14 px/mod) and far-range (~1.5 px/mod) never rejected by derived range', () => {
  // Close-range: 6-char Code 128 at 11.5 px/mod (bar span ~101 * 11.5 = 1161 px on 1600x720)
  // AND 5-char Code 128 at 13.0 px/mod (bar span ~90 * 13 = 1170 px on 1600x720)
  const close1 = synthesizeFixture({
    name: 'close_11p5px',
    width: 1600,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX123',
    angleDeg: 0,
    modulePx: 11.5,
    barHeightPx: 180,
    centerX: 800,
    centerY: 360,
  });
  const close2 = synthesizeFixture({
    name: 'close_13p0px',
    width: 1600,
    height: 720,
    symbology: 'CODE_128',
    payload: 'AB123',
    angleDeg: 0,
    modulePx: 13.0,
    barHeightPx: 180,
    centerX: 800,
    centerY: 360,
  });
  // Far-range: 11-char FC label at 1.5 px/mod
  const far1 = synthesizeFixture({
    name: 'far_1p5px',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX07wz7py1',
    angleDeg: 0,
    modulePx: 1.5,
    barHeightPx: 80,
    centerX: 640,
    centerY: 360,
  });

  const stClose = createPipelineState(1600, 720);
  const resClose = createPipelineResult();
  stClose.flags = FLAG_MODULE_EST;

  assert.equal(processFrame(close1.luma, 1600, 720, stClose, resClose, false), 1, 'close-range 11.5 px/mod tsX must decode');
  assert.equal(extractPayloadString(resClose), 'tsX123');
  assert.ok(stClose.scanline.moduleWidthQ8 >= 10 * 256, `expected close1 modPx >= 10, got ${(stClose.scanline.moduleWidthQ8 / 256).toFixed(2)}`);

  assert.equal(processFrame(close2.luma, 1600, 720, stClose, resClose, false), 1, 'close-range 13.0 px/mod non-tsX must decode');
  assert.equal(extractPayloadString(resClose), 'AB123');
  assert.ok(stClose.scanline.moduleWidthQ8 >= 10 * 256, `expected close2 modPx >= 10, got ${(stClose.scanline.moduleWidthQ8 / 256).toFixed(2)}`);

  const stFar = createPipelineState(1280, 720);
  const resFar = createPipelineResult();
  stFar.flags = FLAG_MODULE_EST;
  assert.equal(processFrame(far1.luma, 1280, 720, stFar, resFar, false), 1, 'far-range 1.5 px/mod must decode');
  assert.equal(extractPayloadString(resFar), 'tsX07wz7py1');

  // Verify derived range with explicit expectedModules & roiMajorLen === 0 fallback
  const ss = createScanlineState();
  ss.expectedModules = computeCode128Modules(11);
  ss.roiMajorLen = 0;
  updateDerivedModuleRangeQ8(1600, ss, 0);
  assert.ok(ss.derivedMaxModQ8 > 10 * 256, 'fallback scanLen=1600 range must allow > 10 px/mod');
});

test('BL1 negatives suite: early-reject rate on clutter & 0 FP across all 9 categories', () => {
  const suite = generateNegativeSuite({ seed: 1, width: 1280, height: 720 });
  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_MODULE_EST;

  let totalNegEval = 0;
  let totalNegRej = 0;
  let clutterEval = 0;
  let clutterRej = 0;
  let totalFps = 0;

  const clutterKinds = new Set([
    'shipping-text-block',
    'tape-seams-tote-ribs',
    'repeated-fabric-clutter',
    'ean-code39-lookalike',
  ]);

  for (const fx of suite) {
    processFrameMulti(fx.luma, fx.width, fx.height, state, res, false);
    const dets = extractMultiDetections(state);
    const score = scoreNegativeFixture(fx, dets, { strict: false });
    totalFps += score.falsePositives.length;
    assert.equal(score.falsePositives.length, 0, `negative ${fx.kind} produced FP: ${score.falsePositives.join(',')}`);

    if (fx.failOnAnyAccept) {
      totalNegEval += state.scanline.linesEvaluated;
      totalNegRej += state.scanline.linesRejectedEarly;
    }
    if (clutterKinds.has(fx.kind)) {
      clutterEval += state.scanline.linesEvaluated;
      clutterRej += state.scanline.linesRejectedEarly;
    }
  }

  // Also test blank/uniform negative frame
  const blank = new Uint8Array(1280 * 720).fill(140);
  processFrameMulti(blank, 1280, 720, state, res, false);
  assert.equal(state.detCount, 0);
  assert.equal(state.scanline.linesRejectedEarly, state.scanline.linesEvaluated, 'blank frame must early-reject 100% of lines');
  totalNegEval += state.scanline.linesEvaluated;
  totalNegRej += state.scanline.linesRejectedEarly;

  const rejRate = totalNegEval > 0 ? totalNegRej / totalNegEval : 0;
  const clutterRejRate = clutterEval > 0 ? clutterRej / clutterEval : 0;
  console.log(
    `    [metric] negatives: FP=${totalFps}, early-reject=${totalNegRej}/${totalNegEval} (${(rejRate * 100).toFixed(1)}%), clutter-reject=${clutterRej}/${clutterEval} (${(clutterRejRate * 100).toFixed(1)}%)`
  );
  assert.ok(rejRate > 0.25, `expected meaningful early-reject rate on negatives, got ${(rejRate * 100).toFixed(1)}%`);
});

test('BL1 sim defects (blur, print gain, tilt) decode cleanly with 0 FP', () => {
  const defectCases = [
    { name: 'blur_1p1', blurSigma: 1.1, angleDeg: 0, modulePx: 2.4 },
    { name: 'tilt_7deg', blurSigma: 0.4, angleDeg: 7, modulePx: 2.2 },
    { name: 'tilt_95deg', blurSigma: 0.5, angleDeg: 95, modulePx: 2.2 },
  ];
  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_MODULE_EST;

  for (const dc of defectCases) {
    const fx = synthesizeFixture({
      name: dc.name,
      width: 1280,
      height: 720,
      symbology: 'CODE_128',
      payload: 'tsX41A00013B',
      angleDeg: dc.angleDeg,
      modulePx: dc.modulePx,
      barHeightPx: 110,
      centerX: 640,
      centerY: 360,
      blurSigma: dc.blurSigma,
    });
    const det = processFrame(fx.luma, 1280, 720, state, res, false);
    assert.equal(det, 1, `defect case ${dc.name} must decode under moduleEst`);
    assert.equal(extractPayloadString(res), 'tsX41A00013B');
  }

  // Real CPU-rendered scene with `src/sim/defects.js` enabled (print gain, tilt, peelWarp, etc.)
  const scene = createSceneForPreset('fc-12-3p5-auto', {
    defects: {
      enabled: true,
      seed: 7,
      force: { tiltDeg: 4.5, printGain: 1.08, peelWarp: 0.08 },
    },
  });
  const expectedSet = new Set(scene.cells.map((c) => c.payload));
  const ctx = createCpuRenderContext(scene.cells.length);
  const luma = new Uint8Array(1280 * 720);
  const pose = sampleCameraPose('snake-h', 1.2, { distanceIn: 12, speedInPerSec: 12, jitter: 0.1, loop: true });
  renderFrame(
    scene,
    [pose],
    {
      width: 1280,
      height: 720,
      hfovDeg: 70.7,
      shadowStrength: scene.shadowStrength,
      noiseStrength: scene.noiseStrength,
      glareStrength: scene.glareStrength,
      frameSeed: 42,
      ctx,
    },
    luma
  );

  const detCount = processFrameMulti(luma, 1280, 720, state, res, false);
  const dets = extractMultiDetections(state);
  assert.ok(detCount >= 1, `expected >= 1 decode on simDefects frame under moduleEst, got ${detCount}`);
  for (const d of dets) {
    assert.ok(expectedSet.has(d.payload), `unexpected FP on simDefects frame: ${d.payload}`);
  }
});

test('BL1 zero-alloc hot-loop heap check (--expose-gc) and timing', () => {
  const fx = synthesizeFixture({
    name: 'bl1_heap_tsx',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX07wz7py1',
    angleDeg: 0,
    modulePx: 2.2,
    barHeightPx: 110,
    centerX: 640,
    centerY: 360,
  });
  const fxAc = synthesizeFixture({
    name: 'bl1_heap_ac',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'SHIP-987654',
    angleDeg: 0,
    modulePx: 2.2,
    barHeightPx: 110,
    centerX: 640,
    centerY: 360,
  });

  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_MODULE_EST | FLAG_CRIB_MATCH;

  // Warmup V8 TurboFan JIT so no compilation/IC allocations occur during heap measurement
  for (let i = 0; i < 120; i++) {
    processFrame(i & 1 ? fxAc.luma : fx.luma, 1280, 720, state, res, false);
  }

  // 1. Direct BL1 estimator zero-alloc check (2000 calls after TurboFan warmup)
  const ss = createScanlineState();
  const rowOff = 360 * 1280;
  extractRunsFromScanline(fxAc.luma, rowOff, 1280, ss, 72, 18);
  for (let i = 0; i < 1000; i++) estimateModuleWidthQ8(fxAc.luma, rowOff, 1280, ss, 1, 0);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const eBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) {
    estimateModuleWidthQ8(fxAc.luma, rowOff, 1280, ss, 1, 0);
  }
  const eAfter = process.memoryUsage().heapUsed;
  const estBytesPerCall = (eAfter - eBefore) / 2000;

  // 2. Full processFrame zero-alloc heap measurement (no performance.now() or assert inside loop)
  const N = 100;
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let decCount = 0;
  for (let i = 0; i < N; i++) {
    decCount = (decCount + processFrame(i & 1 ? fxAc.luma : fx.luma, 1280, 720, state, res, false)) | 0;
  }
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(decCount, N);
  const bytesPerFrame = (heapAfter - heapBefore) / N;

  // 3. Per-frame timing measurement
  const times = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const det = processFrame(i & 1 ? fxAc.luma : fx.luma, 1280, 720, state, res, false);
    times[i] = performance.now() - t0;
    assert.equal(det, 1);
  }
  const sorted = Array.from(times).sort((a, b) => a - b);
  const meanMs = sorted.reduce((a, b) => a + b, 0) / N;
  const p95Ms = sorted[Math.floor(N * 0.95)];

  console.log(
    `    [metric] 100 frames: mean=${meanMs.toFixed(2)}ms, p95=${p95Ms.toFixed(2)}ms, heap=${bytesPerFrame.toFixed(1)} B/frame, est=${estBytesPerCall.toFixed(2)} B/call`
  );
  assert.ok(estBytesPerCall < 16, `estimateModuleWidthQ8 heap growth too high: ${estBytesPerCall.toFixed(2)} B/call`);
  assert.ok(bytesPerFrame < 1536, `hot-loop heap growth too high: ${bytesPerFrame.toFixed(1)} B/frame`);
});

test('BL1 fc-tele-30-3p5 oblique-tail 0 FP (moduleEst, W-fc+moduleEst, W-all)', () => {
  const sc = createScenarioFromPreset('fc-tele-30-3p5', { loops: 1, flagSet: 'off' });
  const dtSec = 1.0 / sc.fpsCap;
  const shutterSec = sc.shutterMs * 0.001;
  const ctx = createCpuRenderContext(sc.scene.cells.length);
  const poseCfg = {
    distanceIn: sc.distanceIn,
    speedInPerSec: sc.speed,
    jitter: sc.jitter,
    loop: true,
  };
  const targets = [
    { seed: 1, frame: 366 },
    { seed: 1, frame: 385 },
    { seed: 2, frame: 374 },
    { seed: 2, frame: 377 },
    { seed: 2, frame: 381 },
    { seed: 2, frame: 384 },
    { seed: 2, frame: 385 },
  ];
  const expectedSet = new Set(sc.expectedPayloads);
  const frames = [];
  for (const tgt of targets) {
    const rng = mulberry32((Math.imul(tgt.seed | 0, 0x9e3779b1) ^ 0x13579bdf) >>> 0);
    const phaseOffsetSec = rng() * dtSec;
    const tSec = phaseOffsetSec + tgt.frame * dtSec;
    const poses = new Array(5);
    for (let k = 0; k < 5; k++) {
      poses[k] = sampleCameraPose(sc.path, Math.max(0, tSec + ((k / 4) - 0.5) * shutterSec), poseCfg);
    }
    const luma = new Uint8Array(sc.width * sc.height);
    renderFrame(
      sc.scene,
      poses,
      {
        width: sc.width,
        height: sc.height,
        hfovDeg: sc.hfovDeg,
        shadowStrength: sc.scene.shadowStrength,
        noiseStrength: sc.scene.noiseStrength,
        glareStrength: sc.scene.glareStrength,
        frameSeed: tgt.seed * 100003 + tgt.frame * 0.71,
        ctx,
      },
      luma
    );
    frames.push({ ...tgt, luma });
  }

  const state = createPipelineState(sc.width, sc.height);
  const res = createPipelineResult();

  const combos = [
    { name: 'moduleEst+stopGuard', mask: FLAG_MODULE_EST | FLAG_STOP_GUARD },
    { name: 'W-fc+moduleEst', mask: resolveFlagSet('W-fc').workerMask | FLAG_MODULE_EST },
    { name: 'W-all', mask: resolveFlagSet('W-all').workerMask },
  ];
  for (const combo of combos) {
    let fps = 0;
    let trueHits = 0;
    for (const fr of frames) {
      state.flags = combo.mask;
      state.scanline.mode = 0;
      processFrameMulti(fr.luma, sc.width, sc.height, state, res, false);
      for (const d of extractMultiDetections(state)) {
        if (!expectedSet.has(d.payload)) fps++;
        else if (d.payload === 'tsX41A00013B') trueHits++;
      }
    }
    assert.equal(fps, 0, `${combo.name} must produce 0 FPs on oblique-tail frames, got ${fps}`);
    assert.ok(trueHits >= 4, `${combo.name} must decode valid tsX41A00013B on oblique frames, got ${trueHits}`);
  }
});

console.log(`All ${passed} BL1 moduleEst tests passed.`);
