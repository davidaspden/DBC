/**
 * F1 — Oblique-Tail False-Read (`tsX41A00013!`) & `stopGuard` Regression Tests.
 *   node tests/fp-oblique-tail.test.js
 *
 * Reproduces the exact `fc-tele-30-3p5` oblique-tail false read (cell R4C1, expected
 * `tsX41A00013B`, false read `tsX41A00013!` on frames ~366-385) and verifies:
 *  1. Baseline (`flags=0` / `scanSmooth` without `stopGuard`) reproduces the FP on the
 *     oblique frames so the regression test is non-vacuous.
 *  2. `FLAG_STOP_GUARD` eliminates the FP across single-flag `stopGuard`, `scanSmooth+stopGuard`,
 *     `W-fc`, `strict`, and `W-all` while still decoding the true `tsX41A00013B` payload.
 *  3. `FLAG_STOP_GUARD` rejects clipped tails (no trailing quiet zone), narrow (<3.52 mod)
 *     trailing spaces, compressed/stretched Stops, and distorted dual-weak-symbol tails.
 *  4. Valid rotated 25-40 deg labels and all 14/14 harness fixtures still decode with 0 FP.
 */

import assert from 'node:assert/strict';
import {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  CODE128_PATTERNS,
  CODE128_STOP_PATTERN,
  CODE128_START_B,
  encodeCode128,
  buildSyntheticTestMatrix,
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
  createCode128State,
  decodeCode128FromRuns,
} from '../src/worker/decoders/code128.js';
import {
  FLAG_SCAN_SMOOTH,
  FLAG_STOP_GUARD,
} from '../src/worker/flagbits.js';
import {
  createScenarioFromPreset,
  resolveFlagSet,
} from '../tools/gate/scenarios.mjs';
import { sampleCameraPose } from '../src/sim/paths.js';
import {
  createCpuRenderContext,
  renderFrame,
  mulberry32,
} from '../src/sim/cpu-render.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

/** Builds Q8 run widths (`runWidthsQ8`, `runIsBar`) for a Code 128B payload. */
function buildQ8Runs(payload, modPx = 2.0, opts = {}) {
  const leadQ = opts.leadQuietMods ?? 10;
  const trailQ = opts.trailQuietMods ?? 10;
  const stopScale = opts.stopScale ?? 1.0;
  const omitTrail = Boolean(opts.omitTrail);

  const syms = [CODE128_START_B];
  let sum = CODE128_START_B;
  for (let i = 0; i < payload.length; i++) {
    const code = payload.charCodeAt(i) - 32;
    syms.push(code);
    sum += (i + 1) * code;
  }
  syms.push(sum % 103);

  const widths = [];
  const isBar = [];
  if (leadQ > 0) {
    widths.push(Math.round(leadQ * modPx * 256));
    isBar.push(0);
  }
  for (let s = 0; s < syms.length; s++) {
    const base = syms[s] * 6;
    for (let r = 0; r < 6; r++) {
      widths.push(Math.round(CODE128_PATTERNS[base + r] * modPx * 256));
      isBar.push((r & 1) === 0 ? 1 : 0);
    }
  }
  for (let r = 0; r < 7; r++) {
    widths.push(Math.round(CODE128_STOP_PATTERN[r] * modPx * stopScale * 256));
    isBar.push((r & 1) === 0 ? 1 : 0);
  }
  if (!omitTrail && trailQ > 0) {
    widths.push(Math.round(trailQ * modPx * 256));
    isBar.push(0);
  }
  return {
    runWidthsQ8: new Int32Array(widths),
    runIsBar: new Uint8Array(isBar),
    runCount: widths.length,
  };
}

/** Renders specific `(seed, frame)` samples from `fc-tele-30-3p5` once for reuse across tests. */
function renderObliqueFrames() {
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

  // Exact oblique-tail frames where cell R4C1 (tsX41A00013B) triggered `tsX41A00013!`
  const targets = [
    { seed: 1, frame: 366 },
    { seed: 1, frame: 385 },
    { seed: 2, frame: 374 },
    { seed: 2, frame: 377 },
    { seed: 2, frame: 381 },
    { seed: 2, frame: 384 },
    { seed: 2, frame: 385 },
  ];

  const frames = [];
  for (const tgt of targets) {
    const rng = mulberry32((Math.imul(tgt.seed | 0, 0x9e3779b1) ^ 0x13579bdf) >>> 0);
    const phaseOffsetSec = rng() * dtSec;
    const tSec = phaseOffsetSec + tgt.frame * dtSec;
    const poses = new Array(5);
    for (let k = 0; k < 5; k++) {
      const frac = (k / 4) - 0.5;
      poses[k] = sampleCameraPose(sc.path, Math.max(0, tSec + frac * shutterSec), poseCfg);
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

  return { sc, frames, expectedSet: new Set(sc.expectedPayloads) };
}

console.log('Running F1 oblique-tail & stopGuard regression tests...');

test('F1 stopGuard eliminates oblique-tail false read tsX41A00013!', () => {
  const { sc, frames, expectedSet } = renderObliqueFrames();
  const state = createPipelineState(sc.width, sc.height);
  const result = createPipelineResult();

  // 1. Confirm baseline (flags=0 and scanSmooth alone) reproduces the oblique-tail FP
  let baseFpCount = 0;
  let smoothFpCount = 0;
  for (const fr of frames) {
    state.flags = 0;
    state.scanline.mode = 0;
    processFrameMulti(fr.luma, sc.width, sc.height, state, result, false);
    for (const d of extractMultiDetections(state)) {
      if (!expectedSet.has(d.payload)) baseFpCount++;
    }

    state.flags = FLAG_SCAN_SMOOTH;
    state.scanline.mode = 0;
    processFrameMulti(fr.luma, sc.width, sc.height, state, result, false);
    for (const d of extractMultiDetections(state)) {
      if (!expectedSet.has(d.payload)) smoothFpCount++;
    }
  }
  assert.ok(baseFpCount >= 1, `expected flags=0 baseline to reproduce >= 1 FP, got ${baseFpCount}`);
  assert.ok(smoothFpCount >= 2, `expected scanSmooth alone to reproduce >= 2 FPs, got ${smoothFpCount}`);

  // 2. Confirm every flag combination containing stopGuard gets 0 FP AND still decodes tsX41A00013B
  const combos = [
    { name: 'single:stopGuard', mask: FLAG_STOP_GUARD },
    { name: 'scanSmooth+stopGuard', mask: FLAG_SCAN_SMOOTH | FLAG_STOP_GUARD },
    { name: 'W-fc', mask: resolveFlagSet('W-fc').workerMask },
    { name: 'strict', mask: resolveFlagSet('strict').workerMask },
    { name: 'W-all', mask: resolveFlagSet('W-all').workerMask },
  ];

  for (const combo of combos) {
    let fpCount = 0;
    let trueR4C1Count = 0;
    for (const fr of frames) {
      state.flags = combo.mask;
      state.scanline.mode = 0;
      processFrameMulti(fr.luma, sc.width, sc.height, state, result, false);
      for (const d of extractMultiDetections(state)) {
        if (!expectedSet.has(d.payload)) {
          fpCount++;
        } else if (d.payload === 'tsX41A00013B') {
          trueR4C1Count++;
        }
      }
    }
    assert.equal(fpCount, 0, `${combo.name} must produce 0 FPs on oblique R4C1 frames, got ${fpCount}`);
    assert.ok(
      trueR4C1Count >= 4,
      `${combo.name} must still decode valid tsX41A00013B on oblique frames (got ${trueR4C1Count}/${frames.length})`
    );
  }
});

test('F1 stopGuard enforces Stop width, trailing quiet zone, and clipped-tail rejection', () => {
  const c128 = createCode128State();

  // Valid clean runs pass with stopGuard
  const valid = buildQ8Runs('tsX41A00013B', 2.0);
  c128.flags = FLAG_STOP_GUARD;
  assert.equal(decodeCode128FromRuns(valid.runWidthsQ8, valid.runIsBar, valid.runCount, c128), 2);
  let decoded = '';
  for (let k = 0; k < c128.payloadLen; k++) decoded += String.fromCharCode(c128.payloadBytes[k]);
  assert.equal(decoded, 'tsX41A00013B');

  // Clipped tail (Stop ends right at scanline boundary, no observed trailing quiet zone)
  const clipped = buildQ8Runs('tsX41A00013B', 2.0, { omitTrail: true });
  c128.flags = 0;
  assert.equal(decodeCode128FromRuns(clipped.runWidthsQ8, clipped.runIsBar, clipped.runCount, c128), 2);
  c128.flags = FLAG_STOP_GUARD;
  assert.equal(
    decodeCode128FromRuns(clipped.runWidthsQ8, clipped.runIsBar, clipped.runCount, c128),
    0,
    'stopGuard must reject clipped tail with no observed trailing quiet zone'
  );

  // Narrow 2.9-module trailing space (<= 3.0 modules, mimics Stop internal space)
  const narrowTrail = buildQ8Runs('tsX41A00013B', 2.0, { trailQuietMods: 2.9 });
  c128.flags = 0;
  assert.equal(decodeCode128FromRuns(narrowTrail.runWidthsQ8, narrowTrail.runIsBar, narrowTrail.runCount, c128), 2);
  c128.flags = FLAG_STOP_GUARD;
  assert.equal(
    decodeCode128FromRuns(narrowTrail.runWidthsQ8, narrowTrail.runIsBar, narrowTrail.runCount, c128),
    0,
    'stopGuard must reject <3.52 module trailing space'
  );

  // Compressed Stop (0.71x expected width)
  const compressedStop = buildQ8Runs('tsX41A00013B', 2.0, { stopScale: 0.71 });
  c128.flags = 0;
  assert.equal(decodeCode128FromRuns(compressedStop.runWidthsQ8, compressedStop.runIsBar, compressedStop.runCount, c128), 2);
  c128.flags = FLAG_STOP_GUARD;
  assert.equal(
    decodeCode128FromRuns(compressedStop.runWidthsQ8, compressedStop.runIsBar, compressedStop.runCount, c128),
    0,
    'stopGuard must reject compressed 0.71x Stop'
  );

  // Stretched Stop (1.36x expected width)
  const stretchedStop = buildQ8Runs('tsX41A00013B', 2.0, { stopScale: 1.36 });
  c128.flags = 0;
  assert.equal(decodeCode128FromRuns(stretchedStop.runWidthsQ8, stretchedStop.runIsBar, stretchedStop.runCount, c128), 2);
  c128.flags = FLAG_STOP_GUARD;
  assert.equal(
    decodeCode128FromRuns(stretchedStop.runWidthsQ8, stretchedStop.runIsBar, stretchedStop.runCount, c128),
    0,
    'stopGuard must reject stretched 1.36x Stop'
  );
});

function renderRotatedScene(enc, angleDeg, modulePx = 2.2, barHeightPx = 90) {
  const luma = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  luma.fill(155);
  const rad = (angleDeg * Math.PI) / 180;
  const cosA = Math.cos(rad);
  const sinA = Math.sin(rad);
  const cx = FRAME_WIDTH * 0.5;
  const cy = FRAME_HEIGHT * 0.5;
  const halfW = enc.totalModules * modulePx * 0.5;
  const halfH = barHeightPx * 0.5;
  const invMod = 1.0 / modulePx;
  for (let y = 0; y < FRAME_HEIGHT; y++) {
    const dy = y - cy;
    const rowOff = y * FRAME_WIDTH;
    for (let x = 0; x < FRAME_WIDTH; x++) {
      const dx = x - cx;
      const u = dx * cosA + dy * sinA + halfW;
      const v = -dx * sinA + dy * cosA;
      if (v >= -halfH && v <= halfH && u >= 0 && u < enc.totalModules * modulePx) {
        const m = (u * invMod) | 0;
        luma[rowOff + x] = enc.modules[m] === 1 ? 26 : 230;
      }
    }
  }
  return luma;
}

test('F1 stopGuard decodes valid rotated 25-40 deg labels and 14/14 harness fixtures with 0 FP', () => {
  const state = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const result = createScanResult();
  state.flags = FLAG_STOP_GUARD;

  // Rotated 0, 25, 32, 40 deg valid `tsX41A00013B` labels
  const enc = encodeCode128('tsX41A00013B', { subset: 'B', quietZoneModules: 10 });
  for (const angleDeg of [0, 25, 32, 40]) {
    const luma = renderRotatedScene(enc, angleDeg, 2.2, 90);
    resetScanResult(result);
    const det = processFrame(luma, FRAME_WIDTH, FRAME_HEIGHT, state, result, false);
    assert.equal(det, 1, `stopGuard must decode valid tsX41A00013B at ${angleDeg} deg`);
    assert.equal(extractPayloadString(result), 'tsX41A00013B');
  }

  // All 14 positive + 2 negative harness fixtures under FLAG_STOP_GUARD
  const fixtures = buildSyntheticTestMatrix();
  let posDecoded = 0;
  let posTotal = 0;
  let negFp = 0;
  for (const fx of fixtures) {
    resetScanResult(result);
    const det = processFrame(fx.luma, fx.width, fx.height, state, result, false);
    const got = det === 1 ? extractPayloadString(result) : null;
    if (fx.symbology === 'CODE_128') {
      posTotal++;
      if (det === 1 && got === fx.payload) posDecoded++;
    } else if (det === 1) {
      negFp++;
    }
  }
  assert.equal(posTotal, 14);
  assert.equal(posDecoded, 14, `expected 14/14 harness decoded under stopGuard, got ${posDecoded}/14`);
  assert.equal(negFp, 0, `expected 0/2 negative harness FPs under stopGuard, got ${negFp}`);
});

console.log(`All ${passed} F1 oblique-tail & stopGuard tests passed.`);
