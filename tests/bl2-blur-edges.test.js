/**
 * BL2 — Fallback Blur-Resilient 2nd-Derivative / LoG Edge Extractor & Fusion Tests.
 *   node --expose-gc tests/bl2-blur-edges.test.js
 *
 * Verifies:
 *  1. Flags-off bit-identical parity vs `flags = 0` (`blurFallbackTriggered === 0`).
 *  2. Easy sharp harness fixtures rarely/never trigger fallback (`blurFallbackTriggered === 0`).
 *  3. Module-width accuracy from `extractRunsBlurResilient` under blur & sharp conditions.
 *  4. Blur & print-gain defect cases:
 *     - K5 defocus / low-pass blur sweep
 *     - `src/sim/cpu-render.js` multi-subframe motion blur
 *     - `src/sim/defects.js` printGain ±10% + blur
 *     - Independent composition: `deblur1d` standalone vs `blurEdges` vs `deblur1d+blurEdges`
 *  5. Real still (`tests/fixtures-sim/tote-tsX07wz7py1-gray.pgm.gz`) decode under `blurEdges`.
 *  6. Negatives (`src/sim/negatives.js`): 0 FP across all 9 categories.
 *  7. Zero-allocation hot-loop heap check (`--expose-gc`) and per-frame timing.
 *  8. `fc-tele-30-3p5` oblique-tail 0 FP (`blurEdges+stopGuard`, `W-fc+blurEdges`, `W-all`).
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
  FLAG_BLUR_EDGES,
  FLAG_DEBLUR_1D,
  FLAG_MODULE_EST,
  FLAG_STOP_GUARD,
  createScanlineState,
  extractRunsFromScanline,
  extractRunsBlurResilient,
} from '../src/worker/scanline.js';
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

/**
 * Helper: applies a 1D horizontal box-blur (motion/defocus low-pass) of `radius` pixels
 * (kernel width `2*radius + 1`, or fractional passes) to a copy of `luma`.
 */
function applyHorizBoxBlur(src, width, height, kernelW) {
  const out = new Uint8Array(src.length);
  const k = Math.max(1, Math.round(kernelW));
  const half = k >> 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let cnt = 0;
      const x0 = Math.max(0, x - half);
      const x1 = Math.min(width - 1, x - half + k - 1);
      for (let xx = x0; xx <= x1; xx++) {
        sum += src[row + xx];
        cnt++;
      }
      out[row + x] = Math.round(sum / cnt);
    }
  }
  return out;
}

/**
 * Helper: applies K5 5-tap separable binomial low-pass `[1, 4, 6, 4, 1] / 16`
 * `passes` times to simulate optical defocus.
 */
function applyK5Defocus(src, width, height, passes = 1) {
  let cur = new Uint8Array(src);
  let tmp = new Uint8Array(src.length);
  for (let p = 0; p < passes; p++) {
    // Horizontal K5
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const xm2 = x >= 2 ? x - 2 : 0;
        const xm1 = x >= 1 ? x - 1 : 0;
        const xp1 = x + 1 < width ? x + 1 : width - 1;
        const xp2 = x + 2 < width ? x + 2 : width - 1;
        tmp[row + x] = (
          cur[row + xm2] +
          (cur[row + xm1] << 2) +
          cur[row + x] * 6 +
          (cur[row + xp1] << 2) +
          cur[row + xp2] +
          8
        ) >> 4;
      }
    }
    // Vertical K5
    for (let y = 0; y < height; y++) {
      const ym2 = (y >= 2 ? y - 2 : 0) * width;
      const ym1 = (y >= 1 ? y - 1 : 0) * width;
      const y0 = y * width;
      const yp1 = (y + 1 < height ? y + 1 : height - 1) * width;
      const yp2 = (y + 2 < height ? y + 2 : height - 1) * width;
      for (let x = 0; x < width; x++) {
        cur[y0 + x] = (
          tmp[ym2 + x] +
          (tmp[ym1 + x] << 2) +
          tmp[y0 + x] * 6 +
          (tmp[yp1 + x] << 2) +
          tmp[yp2 + x] +
          8
        ) >> 4;
      }
    }
  }
  return cur;
}

console.log('Running BL2 blurEdges tests...');

test('BL2 flags-off bit-identical parity vs flags = 0', () => {
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
    assert.equal(stateA.scanline.blurFallbackTriggered, 0, 'blurFallbackTriggered must stay 0 when FLAG_BLUR_EDGES is OFF');
  }
});

test('BL2 easy sharp cases never trigger fallback (blurFallbackTriggered === 0)', () => {
  const sharpAngles = [0, 15, 37, 90];
  const state = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const res = createScanResult();
  state.flags = FLAG_BLUR_EDGES;
  state.scanline.blurFallbackTriggered = 0;

  let decoded = 0;
  for (const angleDeg of sharpAngles) {
    const fx = synthesizeFixture({
      name: `sharp_${angleDeg}`,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      symbology: 'CODE_128',
      payload: 'tsX07wz7py1',
      angleDeg,
      modulePx: 2.5,
      barHeightPx: 110,
      centerX: 640,
      centerY: 360,
    });
    resetScanResult(res);
    const det = processFrame(fx.luma, fx.width, fx.height, state, res, false);
    assert.equal(det, 1, `sharp fixture ${fx.name} must decode`);
    assert.equal(extractPayloadString(res), 'tsX07wz7py1');
    decoded++;
  }

  assert.equal(
    state.scanline.blurFallbackTriggered,
    0,
    `expected blurFallbackTriggered === 0 on ${decoded} clean sharp fixtures, got ${state.scanline.blurFallbackTriggered}`
  );
  console.log(`    [metric] easy sharp fallback fire rate: ${state.scanline.blurFallbackTriggered}/${decoded} (0.0%)`);
});

test('BL2 module-width error from extracted blur-resilient runs', () => {
  const ss = createScanlineState();
  const relErrors = [];

  for (const cfg of [
    { modPx: 2.0, blurPasses: 1 },
    { modPx: 2.5, blurPasses: 2 },
    { modPx: 3.0, blurPasses: 2 },
    { modPx: 4.0, blurPasses: 3 },
  ]) {
    const fx = synthesizeFixture({
      name: `moderr_${cfg.modPx}_${cfg.blurPasses}`,
      width: 1280,
      height: 720,
      symbology: 'CODE_128',
      payload: 'tsX07wz7py1',
      angleDeg: 0,
      modulePx: cfg.modPx,
      barHeightPx: 100,
      centerX: 640,
      centerY: 360,
    });
    const blurred = applyK5Defocus(fx.luma, 1280, 720, cfg.blurPasses);
    const rowOff = 360 * 1280;
    extractRunsFromScanline(blurred, rowOff, 1280, ss, 72, 18);
    const rc = extractRunsBlurResilient(blurred, rowOff, 1280, ss, 1, 0);
    assert.ok(rc >= 60, `expected >= 60 fused runs on modPx=${cfg.modPx}, got ${rc}`);

    // Code 128 invariant: 6 runs = 11 modules (excluding leading/trailing quiet spaces)
    let sumQ8 = 0;
    let used = 0;
    for (let r = 1; r < rc - 1; r++) {
      const wQ8 = ss.runWidthsQ8[r];
      if (ss.runIsBar[r] === 0 && wQ8 > cfg.modPx * 256 * 6) continue;
      sumQ8 += wQ8;
      used++;
    }
    assert.ok(used >= 60, `expected >= 60 non-quiet runs, got ${used}`);
    const estModPx = (sumQ8 * 6) / (used * 11 * 256);
    const relErr = Math.abs(estModPx - cfg.modPx) / cfg.modPx;
    relErrors.push(relErr);
    assert.ok(relErr < 0.08, `modPx=${cfg.modPx} est=${estModPx.toFixed(3)} err=${(relErr * 100).toFixed(2)}% >= 8%`);
  }

  const meanErrPct = (relErrors.reduce((a, b) => a + b, 0) / relErrors.length) * 100;
  const maxErrPct = Math.max(...relErrors) * 100;
  console.log(`    [metric] blur-resilient run module-width error: mean=${meanErrPct.toFixed(2)}%, max=${maxErrPct.toFixed(2)}%`);
});

test('BL2 blur & print-gain defect suite + deblur1d independent composition', () => {
  const cases = [];

  // 1. K5 defocus / low-pass blur & directional box blur cases across module widths
  for (const spec of [
    { name: 'k5_m2p2_p2', modPx: 2.2, k5: 2, box: 0, sig: 0, blurPx: 2.2 },
    { name: 'k5_m2p5_p3', modPx: 2.5, k5: 3, box: 0, sig: 0, blurPx: 2.8 },
    { name: 'k5_m3p0_p4', modPx: 3.0, k5: 4, box: 0, sig: 0, blurPx: 3.2 },
    { name: 'sig_m2p2_1p4', modPx: 2.2, k5: 0, box: 0, sig: 1.4, blurPx: 2.4 },
    { name: 'box_m2p2_k3', modPx: 2.2, k5: 0, box: 3, sig: 0, blurPx: 2.6 },
    { name: 'box_m2p8_k4', modPx: 2.8, k5: 0, box: 4, sig: 0, blurPx: 3.4 },
  ]) {
    const base = synthesizeFixture({
      name: spec.name,
      width: 1280,
      height: 720,
      symbology: 'CODE_128',
      payload: 'tsX07wz7py1',
      angleDeg: 0,
      modulePx: spec.modPx,
      barHeightPx: 110,
      centerX: 640,
      centerY: 360,
      blurSigma: spec.sig,
    });
    const luma = spec.k5 > 0
      ? applyK5Defocus(base.luma, 1280, 720, spec.k5)
      : (spec.box > 0 ? applyHorizBoxBlur(base.luma, 1280, 720, spec.box) : base.luma);
    cases.push({ name: spec.name, luma, expected: 'tsX07wz7py1', blurPx: spec.blurPx, multi: false });
  }

  // 2. CPU-rendered multi-subframe motion blur + defects.js printGain (±10%)
  for (const pg of [0.90, 1.10]) {
    const scene = createSceneForPreset('fc-12-3p5-auto', {
      defects: {
        enabled: true,
        seed: pg > 1 ? 11 : 13,
        force: { tiltDeg: 3.0, printGain: pg, peelWarp: 0.06 },
      },
    });
    const expectedSet = new Set(scene.cells.map((c) => c.payload));
    const ctx = createCpuRenderContext(scene.cells.length);
    const luma = new Uint8Array(1280 * 720);
    // 7-subframe shutter integration for directional motion blur
    const poses = new Array(7);
    const tCenter = 1.25;
    const shutterSec = 0.008; // 8 ms shutter -> visible along-scan motion blur
    for (let k = 0; k < 7; k++) {
      poses[k] = sampleCameraPose('snake-h', tCenter + ((k / 6) - 0.5) * shutterSec, {
        distanceIn: 12,
        speedInPerSec: 18,
        jitter: 0.08,
        loop: true,
      });
    }
    renderFrame(
      scene,
      poses,
      {
        width: 1280,
        height: 720,
        hfovDeg: 70.7,
        shadowStrength: scene.shadowStrength,
        noiseStrength: scene.noiseStrength,
        glareStrength: scene.glareStrength,
        frameSeed: pg > 1 ? 101 : 103,
        ctx,
      },
      luma
    );
    cases.push({
      name: `sim_pg_${pg.toFixed(2)}_mblur`,
      luma,
      expectedSet,
      blurPx: 3.0,
      multi: true,
    });
  }

  const modes = [
    { name: 'off', flags: 0 },
    { name: 'deblur1d', flags: FLAG_DEBLUR_1D },
    { name: 'blurEdges', flags: FLAG_BLUR_EDGES },
    { name: 'deblur1d+blurEdges', flags: FLAG_DEBLUR_1D | FLAG_BLUR_EDGES },
  ];

  const scores = {};
  for (const mode of modes) {
    const state = createPipelineState(1280, 720);
    const res = createPipelineResult();
    state.flags = mode.flags;
    state.scanline.blurFallbackTriggered = 0;
    let ok = 0;
    let fp = 0;

    for (const c of cases) {
      state.scanline.blurPx = c.blurPx;
      if (c.multi) {
        const cnt = processFrameMulti(c.luma, 1280, 720, state, res, false);
        const dets = extractMultiDetections(state);
        for (const d of dets) {
          if (!c.expectedSet.has(d.payload)) fp++;
        }
        if (cnt >= 1 && fp === 0) ok++;
      } else {
        const det = processFrame(c.luma, 1280, 720, state, res, false);
        if (det === 1) {
          const got = extractPayloadString(res);
          if (got === c.expected) ok++;
          else fp++;
        }
      }
    }
    assert.equal(fp, 0, `mode ${mode.name} produced ${fp} FP on blur/defect suite`);
    scores[mode.name] = { ok, total: cases.length, fallback: state.scanline.blurFallbackTriggered };
  }

  console.log(
    `    [metric] blur+defect suite (${cases.length} cases): ` +
    `off=${scores.off.ok}/${cases.length}, ` +
    `deblur1d=${scores.deblur1d.ok}/${cases.length}, ` +
    `blurEdges=${scores.blurEdges.ok}/${cases.length} (fb=${scores.blurEdges.fallback}), ` +
    `deblur1d+blurEdges=${scores['deblur1d+blurEdges'].ok}/${cases.length} (fb=${scores['deblur1d+blurEdges'].fallback})`
  );
  assert.ok(
    scores.blurEdges.ok >= scores.off.ok,
    `blurEdges (${scores.blurEdges.ok}) must not regress vs off (${scores.off.ok})`
  );
  assert.ok(
    scores['deblur1d+blurEdges'].ok >= scores.deblur1d.ok,
    `deblur1d+blurEdges (${scores['deblur1d+blurEdges'].ok}) must not regress vs deblur1d (${scores.deblur1d.ok})`
  );
  assert.ok(
    scores['deblur1d+blurEdges'].ok >= 6,
    `expected strong blur+defect decode rate (>= 6/${cases.length}), got ${scores['deblur1d+blurEdges'].ok}`
  );
});

test('BL2 decodes 14/14 harness fixtures and real still tote-tsX07wz7py1-gray.pgm.gz', () => {
  const fixtures = buildSyntheticTestMatrix();
  const state = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const res = createScanResult();
  state.flags = FLAG_BLUR_EDGES;

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
  assert.equal(posOk, posTotal, `expected ${posTotal}/${posTotal} harness decoded with blurEdges, got ${posOk}`);
  assert.equal(negFp, 0, `expected 0 harness negative FPs, got ${negFp}`);

  // Real still fixture
  const gz = fs.readFileSync(REAL_STILL_PATH);
  const pgm = parsePGM(zlib.gunzipSync(gz));
  const stReal = createPipelineState(pgm.width, pgm.height);
  const resReal = createPipelineResult();
  stReal.flags = FLAG_BLUR_EDGES;

  const detReal = processFrame(pgm.luma, pgm.width, pgm.height, stReal, resReal, true);
  assert.equal(detReal, 1, 'real still tote-tsX07wz7py1 must decode with FLAG_BLUR_EDGES');
  assert.equal(extractPayloadString(resReal), 'tsX07wz7py1');
  console.log(
    `    [metric] real still: payload=${extractPayloadString(resReal)}, fallback=${stReal.scanline.blurFallbackTriggered}, tTotal=${resReal.tTotalMs.toFixed(2)}ms`
  );
});

test('BL2 negatives suite: 0 FP across all 9 categories', () => {
  const suite = generateNegativeSuite({ seed: 1, width: 1280, height: 720 });
  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_BLUR_EDGES | FLAG_STOP_GUARD;

  let totalFps = 0;
  for (const fx of suite) {
    processFrameMulti(fx.luma, fx.width, fx.height, state, res, false);
    const dets = extractMultiDetections(state);
    const score = scoreNegativeFixture(fx, dets, { strict: false });
    totalFps += score.falsePositives.length;
    assert.equal(score.falsePositives.length, 0, `negative ${fx.kind} produced FP: ${score.falsePositives.join(',')}`);
  }
  console.log(`    [metric] negatives (${suite.length} fixtures): FP=${totalFps}`);
});

test('BL2 zero-alloc hot-loop heap check (--expose-gc) and timing', () => {
  const fxSharp = synthesizeFixture({
    name: 'bl2_heap_sharp',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX07wz7py1',
    angleDeg: 0,
    modulePx: 2.5,
    barHeightPx: 110,
    centerX: 640,
    centerY: 360,
  });
  const blurredLuma = applyK5Defocus(fxSharp.luma, 1280, 720, 3);

  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_BLUR_EDGES | FLAG_MODULE_EST;

  // Warmup V8 TurboFan JIT on both sharp and blur-fallback paths
  for (let i = 0; i < 240; i++) {
    processFrame(i & 1 ? blurredLuma : fxSharp.luma, 1280, 720, state, res, false);
  }

  // 1. Direct extractRunsBlurResilient zero-alloc check (2000 calls)
  const ss = createScanlineState();
  const rowOff = 360 * 1280;
  extractRunsFromScanline(blurredLuma, rowOff, 1280, ss, 72, 18);
  for (let i = 0; i < 1000; i++) extractRunsBlurResilient(blurredLuma, rowOff, 1280, ss, 1, 0);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const eBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) {
    extractRunsBlurResilient(blurredLuma, rowOff, 1280, ss, 1, 0);
  }
  const eAfter = process.memoryUsage().heapUsed;
  const extBytesPerCall = (eAfter - eBefore) / 2000;

  // 2. Full processFrame zero-alloc heap measurement
  const N = 100;
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let decCount = 0;
  for (let i = 0; i < N; i++) {
    decCount = (decCount + processFrame(i & 1 ? blurredLuma : fxSharp.luma, 1280, 720, state, res, false)) | 0;
  }
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(decCount, N);
  const bytesPerFrame = (heapAfter - heapBefore) / N;

  // 3. Per-frame timing measurement
  const times = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const det = processFrame(i & 1 ? blurredLuma : fxSharp.luma, 1280, 720, state, res, false);
    times[i] = performance.now() - t0;
    assert.equal(det, 1);
  }
  const sorted = Array.from(times).sort((a, b) => a - b);
  const meanMs = sorted.reduce((a, b) => a + b, 0) / N;
  const p95Ms = sorted[Math.floor(N * 0.95)];

  console.log(
    `    [metric] 100 frames: mean=${meanMs.toFixed(2)}ms, p95=${p95Ms.toFixed(2)}ms, heap=${bytesPerFrame.toFixed(1)} B/frame, ext=${extBytesPerCall.toFixed(2)} B/call`
  );
  assert.ok(extBytesPerCall < 16, `extractRunsBlurResilient heap growth too high: ${extBytesPerCall.toFixed(2)} B/call`);
  assert.ok(bytesPerFrame < 1536, `hot-loop heap growth too high: ${bytesPerFrame.toFixed(1)} B/frame`);
});

test('BL2 fc-tele-30-3p5 oblique-tail 0 FP (blurEdges+stopGuard, W-fc+blurEdges, W-all)', () => {
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
    { name: 'blurEdges+stopGuard', mask: FLAG_BLUR_EDGES | FLAG_STOP_GUARD },
    { name: 'W-fc+blurEdges', mask: resolveFlagSet('W-fc').workerMask | FLAG_BLUR_EDGES },
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

console.log(`All ${passed} BL2 blurEdges tests passed.`);
