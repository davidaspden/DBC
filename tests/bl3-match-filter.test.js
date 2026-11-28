/**
 * BL3 — Matched-Filter Start B / Stop / Optional Combined tsX Tests (`FLAG_MATCH_FILTER`, bit 17).
 *   node --expose-gc tests/bl3-match-filter.test.js
 *
 * Verifies:
 *  1. Flags-off bit-identical parity vs `flags = 0` (`matchLinesEvaluated === 0`, `startScore === 0`).
 *  2. Pre-allocated Q8 scale-bucketed template bank (Start B, Stop, combined Start B+tsX),
 *     forward & reverse correlation, close-range stride decimation, and `prefixStack` anchoring.
 *  3. Harness 14/14 positive + 0/2 negative + real still (`tote-tsX07wz7py1-gray.pgm.gz`) decode.
 *  4. Blur & print-gain defects decode improvement (standalone and combined with BL1/BL2).
 *  5. Early-reject rate on negatives / clutter / blank lines with 0 FP across all 9 categories.
 *  6. `stopGuard` agreement & low-stop-correlation rejection.
 *  7. `fc-tele-30-3p5` oblique-tail 0 FP (`matchFilter+stopGuard`, `W-fc+matchFilter`, `W-all`).
 *  8. Steady-state timing & zero-alloc heap check (`--expose-gc`, warmed up).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  FRAME_WIDTH,
  FRAME_HEIGHT,
  CODE128_PATTERNS,
  CODE128_STOP_PATTERN,
  CODE128_START_B,
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
  FLAG_MATCH_FILTER,
  FLAG_CRIB_MATCH,
  FLAG_PREFIX_STACK,
  FLAG_STOP_GUARD,
  FLAG_MODULE_EST,
  FLAG_BLUR_EDGES,
  FLAG_DEBLUR_1D,
  MF_NUM_BUCKETS,
  MF_TPL_COUNT,
  createScanlineState,
  extractRunsFromScanline,
  selectMatchFilterBucket,
  matchFilterScanline,
} from '../src/worker/scanline.js';
import {
  createCode128State,
  decodeCode128FromRuns,
} from '../src/worker/decoders/code128.js';
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

/** Applies K5 separable binomial low-pass `[1, 4, 6, 4, 1] / 16` `passes` times. */
function applyK5Defocus(src, width, height, passes = 1) {
  let cur = new Uint8Array(src);
  let tmp = new Uint8Array(src.length);
  for (let p = 0; p < passes; p++) {
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

/** Builds Q8 run widths (`runWidthsQ8`, `runIsBar`) for a Code 128B payload. */
function buildQ8Runs(payload, modPx = 2.0, opts = {}) {
  const leadQ = opts.leadQuietMods ?? 10;
  const trailQ = opts.trailQuietMods ?? 10;
  const stopScale = opts.stopScale ?? 1.0;

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
  if (trailQ > 0) {
    widths.push(Math.round(trailQ * modPx * 256));
    isBar.push(0);
  }
  return {
    runWidthsQ8: new Int32Array(widths),
    runIsBar: new Uint8Array(isBar),
    runCount: widths.length,
  };
}

console.log('Running BL3 matchFilter tests...');

test('BL3 flags-off bit-identical parity vs flags = 0', () => {
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
    assert.equal(stateA.scanline.matchLinesEvaluated, 0, 'matchLinesEvaluated must stay 0 when OFF');
    assert.equal(stateA.scanline.matchLinesRejected, 0, 'matchLinesRejected must stay 0 when OFF');
    assert.equal(stateA.scanline.startScore, 0, 'startScore must stay 0 when OFF');
    assert.equal(stateA.scanline.stopScore, 0, 'stopScore must stay 0 when OFF');
  }
});

test('BL3 pre-allocated template bank, scale buckets, forward/reverse & tsX correlation', () => {
  const ss = createScanlineState();
  const c128 = createCode128State();
  assert.ok(ss.templateBank instanceof Int16Array, 'templateBank must be Int16Array');
  assert.ok(ss.templateLens instanceof Uint8Array, 'templateLens must be Uint8Array');
  assert.ok(ss.corrScratch instanceof Int32Array, 'corrScratch must be Int32Array');
  assert.equal(ss.templateCount, MF_TPL_COUNT);
  assert.equal(ss.templateLens.length, MF_NUM_BUCKETS * 3);
  for (let i = 0; i < ss.templateCount; i++) {
    assert.ok(ss.templateLens[i] >= 8, `template ${i} length must be >= 8`);
  }
  assert.equal(selectMatchFilterBucket(320), 0);
  assert.equal(selectMatchFilterBucket(1492), MF_NUM_BUCKETS - 1);

  // Forward tsX barcode at 2.2 px/mod -> high Start B, Stop, and combined tsX scores
  const fwd = synthesizeFixture({
    name: 'mf_fwd_tsx',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX07wz7py1',
    angleDeg: 0,
    modulePx: 2.2,
    barHeightPx: 100,
    centerX: 640,
    centerY: 360,
  });
  const rowOff = 360 * 1280;
  ss.flags = FLAG_MATCH_FILTER | FLAG_MODULE_EST;
  ss.moduleWidthQ8 = Math.round(2.2 * 256);
  const okFwd = matchFilterScanline(fwd.luma, rowOff, 1280, ss, c128, 0);
  assert.equal(okFwd, 1, 'forward tsX scanline must pass matched filter');
  assert.ok(ss.startScore >= 750, `expected high Start B score >= 750, got ${ss.startScore}`);
  assert.ok(ss.stopScore >= 750, `expected high Stop score >= 750, got ${ss.stopScore}`);
  assert.ok(ss.tsxScore >= 750, `expected high combined tsX score >= 750, got ${ss.tsxScore}`);
  assert.equal(ss.matchDir, 1, 'expected forward direction (+1)');
  assert.equal(c128.mfValid, 1);

  // Reverse (180 deg) tsX barcode -> detects dir = -1 with high Start B, Stop, tsX scores
  const revRow = new Uint8Array(1280);
  for (let x = 0; x < 1280; x++) revRow[x] = fwd.luma[rowOff + (1279 - x)];
  const okRev = matchFilterScanline(revRow, 0, 1280, ss, c128, 0);
  assert.equal(okRev, 1, 'reverse tsX scanline must pass matched filter');
  assert.ok(ss.startScore >= 750, `expected high reverse Start B score >= 750, got ${ss.startScore}`);
  assert.ok(ss.stopScore >= 750, `expected high reverse Stop score >= 750, got ${ss.stopScore}`);
  assert.ok(ss.tsxScore >= 750, `expected high reverse tsX score >= 750, got ${ss.tsxScore}`);
  assert.equal(ss.matchDir, -1, 'expected reverse direction (-1)');

  // Non-tsX barcode: Start B & Stop high, combined tsX low
  const nonTsx = synthesizeFixture({
    name: 'mf_non_tsx',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'SHIP-987654',
    angleDeg: 0,
    modulePx: 2.5,
    barHeightPx: 100,
    centerX: 640,
    centerY: 360,
  });
  ss.moduleWidthQ8 = Math.round(2.5 * 256);
  const okNon = matchFilterScanline(nonTsx.luma, rowOff, 1280, ss, c128, 0);
  assert.equal(okNon, 1, 'non-tsX barcode must pass matched filter');
  assert.ok(ss.startScore >= 750 && ss.stopScore >= 750);
  assert.ok(ss.tsxScore < 600, `non-tsX should not match tsX template strongly, got ${ss.tsxScore}`);

  // Close-range barcode (11.5 px/mod -> stride >= 2 decimation)
  const close = synthesizeFixture({
    name: 'mf_close_11p5',
    width: 1600,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX123',
    angleDeg: 0,
    modulePx: 11.5,
    barHeightPx: 160,
    centerX: 800,
    centerY: 360,
  });
  ss.moduleWidthQ8 = Math.round(11.5 * 256);
  const okClose = matchFilterScanline(close.luma, 360 * 1600, 1600, ss, c128, 0);
  assert.equal(okClose, 1, 'close-range 11.5 px/mod barcode must pass matched filter');
  assert.ok(ss.startScore >= 700 && ss.stopScore >= 700);
});

test('BL3 decodes 14/14 harness fixtures and real still tote-tsX07wz7py1-gray.pgm.gz', () => {
  const fixtures = buildSyntheticTestMatrix();
  const state = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const res = createScanResult();
  state.flags = FLAG_MATCH_FILTER | FLAG_CRIB_MATCH | FLAG_PREFIX_STACK;

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
  assert.equal(posOk, posTotal, `expected ${posTotal}/${posTotal} harness decoded with matchFilter, got ${posOk}`);
  assert.equal(negFp, 0, `expected 0 harness negative FPs, got ${negFp}`);

  // Real still fixture
  const gz = fs.readFileSync(REAL_STILL_PATH);
  const pgm = parsePGM(zlib.gunzipSync(gz));
  const stReal = createPipelineState(pgm.width, pgm.height);
  const resReal = createPipelineResult();
  stReal.flags = FLAG_MATCH_FILTER | FLAG_CRIB_MATCH | FLAG_PREFIX_STACK;

  const detReal = processFrame(pgm.luma, pgm.width, pgm.height, stReal, resReal, true);
  assert.equal(detReal, 1, 'real still tote-tsX07wz7py1 must decode with FLAG_MATCH_FILTER');
  assert.equal(extractPayloadString(resReal), 'tsX07wz7py1');
  console.log(
    `    [metric] real still: payload=${extractPayloadString(resReal)}, startScore=${stReal.scanline.startScore}, stopScore=${stReal.scanline.stopScore}, tsxScore=${stReal.scanline.tsxScore}, tTotal=${resReal.tTotalMs.toFixed(2)}ms`
  );
});

test('BL3 blur & print-gain defect suite (standalone and combined with BL1/BL2)', () => {
  const cases = [];

  // K5 defocus + Gaussian blur cases
  for (const spec of [
    { name: 'k5_m2p2_p2', modPx: 2.2, k5: 2, sig: 0, blurPx: 2.2 },
    { name: 'k5_m2p5_p3', modPx: 2.5, k5: 3, sig: 0, blurPx: 2.8 },
    { name: 'k5_m3p0_p4', modPx: 3.0, k5: 4, sig: 0, blurPx: 3.2 },
    { name: 'sig_m2p2_1p4', modPx: 2.2, k5: 0, sig: 1.4, blurPx: 2.4 },
    { name: 'sig_m2p4_1p6', modPx: 2.4, k5: 0, sig: 1.6, blurPx: 2.6 },
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
    const luma = spec.k5 > 0 ? applyK5Defocus(base.luma, 1280, 720, spec.k5) : base.luma;
    cases.push({ name: spec.name, luma, expected: 'tsX07wz7py1', blurPx: spec.blurPx, multi: false });
  }

  // CPU-rendered motion blur + printGain (±10%)
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
    const poses = new Array(7);
    const tCenter = 1.25;
    const shutterSec = 0.008;
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
    { name: 'matchFilter', flags: FLAG_MATCH_FILTER },
    { name: 'BL1+BL2+BL3', flags: FLAG_MODULE_EST | FLAG_BLUR_EDGES | FLAG_MATCH_FILTER | FLAG_CRIB_MATCH | FLAG_PREFIX_STACK | FLAG_DEBLUR_1D },
  ];

  const scores = {};
  for (const mode of modes) {
    const state = createPipelineState(1280, 720);
    const res = createPipelineResult();
    state.flags = mode.flags;
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
    scores[mode.name] = ok;
  }

  console.log(
    `    [metric] blur+defect suite (${cases.length} cases): off=${scores.off}/${cases.length}, matchFilter=${scores.matchFilter}/${cases.length}, BL1+BL2+BL3=${scores['BL1+BL2+BL3']}/${cases.length}`
  );
  assert.ok(scores.matchFilter >= scores.off, `matchFilter (${scores.matchFilter}) must not regress vs off (${scores.off})`);
  assert.ok(scores['BL1+BL2+BL3'] >= scores.off, `BL1+BL2+BL3 (${scores['BL1+BL2+BL3']}) must improve/match off (${scores.off})`);
  assert.ok(scores['BL1+BL2+BL3'] >= 5, `expected strong BL1+BL2+BL3 blur+defect decode rate (>= 5/${cases.length}), got ${scores['BL1+BL2+BL3']}`);
});

test('BL3 negatives suite: early-reject rate on clutter/blank & 0 FP across all 9 categories', () => {
  const suite = generateNegativeSuite({ seed: 1, width: 1280, height: 720 });
  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_MATCH_FILTER | FLAG_STOP_GUARD;

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
      totalNegEval += state.scanline.matchLinesEvaluated;
      totalNegRej += state.scanline.matchLinesRejected;
    }
    if (clutterKinds.has(fx.kind)) {
      clutterEval += state.scanline.matchLinesEvaluated;
      clutterRej += state.scanline.matchLinesRejected;
    }
  }

  // Blank/uniform frame -> 100% early reject
  const blank = new Uint8Array(1280 * 720).fill(140);
  processFrameMulti(blank, 1280, 720, state, res, false);
  assert.equal(state.detCount, 0);
  assert.ok(state.scanline.matchLinesEvaluated > 0);
  assert.equal(
    state.scanline.matchLinesRejected,
    state.scanline.matchLinesEvaluated,
    'blank frame must early-reject 100% of scanlines'
  );
  totalNegEval += state.scanline.matchLinesEvaluated;
  totalNegRej += state.scanline.matchLinesRejected;

  const rejRate = totalNegEval > 0 ? totalNegRej / totalNegEval : 0;
  const clutterRejRate = clutterEval > 0 ? clutterRej / clutterEval : 0;
  console.log(
    `    [metric] negatives: FP=${totalFps}, early-reject=${totalNegRej}/${totalNegEval} (${(rejRate * 100).toFixed(1)}%), clutter-reject=${clutterRej}/${clutterEval} (${(clutterRejRate * 100).toFixed(1)}%)`
  );
  assert.ok(rejRate > 0.35, `expected strong early-reject rate on negatives (> 35%), got ${(rejRate * 100).toFixed(1)}%`);
});

test('BL3 stopGuard agreement & low-stop-correlation rejection', () => {
  const c128 = createCode128State();
  const valid = buildQ8Runs('tsX41A00013B', 2.2);

  // 1. High Stop correlation + matching scale -> accepted by matchFilter + stopGuard
  c128.flags = FLAG_MATCH_FILTER | FLAG_STOP_GUARD;
  c128.mfValid = 1;
  c128.mfStopCorr = null;
  c128.mfStopScore = 880;
  c128.mfScaleQ8 = Math.round(2.2 * 256);
  c128.mfDir = 1;
  assert.equal(
    decodeCode128FromRuns(valid.runWidthsQ8, valid.runIsBar, valid.runCount, c128),
    2,
    'valid runs with high Stop correlation and matching scale must pass stopGuard'
  );
  assert.equal(c128.lastStopCorrQ10, 880);

  // 2. Low Stop correlation (< 380) -> feeds stopGuard and rejects even though runs are clean
  c128.mfValid = 1;
  c128.mfStopCorr = null;
  c128.mfStopScore = 240;
  c128.mfScaleQ8 = Math.round(2.2 * 256);
  assert.equal(
    decodeCode128FromRuns(valid.runWidthsQ8, valid.runIsBar, valid.runCount, c128),
    0,
    'low Stop correlation must feed stopGuard and reject candidate'
  );

  // 3. Gross scale disagreement between matched filter and Stop width -> rejected by stopGuard
  c128.mfValid = 1;
  c128.mfStopCorr = null;
  c128.mfStopScore = 880;
  c128.mfScaleQ8 = Math.round(5.5 * 256); // 2.5x larger than actual 2.2 px/mod Stop
  assert.equal(
    decodeCode128FromRuns(valid.runWidthsQ8, valid.runIsBar, valid.runCount, c128),
    0,
    'gross scale disagreement between matchFilter and Stop must be rejected by stopGuard'
  );

  // 4. End-to-end corrScratch lookup on real rendered barcode
  const fx = synthesizeFixture({
    name: 'mf_stopguard_e2e',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'tsX41A00013B',
    angleDeg: 0,
    modulePx: 2.2,
    barHeightPx: 100,
    centerX: 640,
    centerY: 360,
  });
  const ss = createScanlineState();
  ss.flags = FLAG_MATCH_FILTER | FLAG_STOP_GUARD;
  const rowOff = 360 * 1280;
  const rc = extractRunsFromScanline(fx.luma, rowOff, 1280, ss, 72, 18);
  assert.equal(matchFilterScanline(fx.luma, rowOff, 1280, ss, c128, 0), 1);
  c128.flags = FLAG_MATCH_FILTER | FLAG_STOP_GUARD;
  c128.mfRunOriginQ8 = ss.runOriginQ8;
  assert.equal(decodeCode128FromRuns(ss.runWidthsQ8, ss.runIsBar, rc, c128), 2);
  assert.ok(c128.lastStopCorrQ10 >= 700, `expected high local Stop correlation >= 700, got ${c128.lastStopCorrQ10}`);
});

test('BL3 fc-tele-30-3p5 oblique-tail 0 FP (matchFilter+stopGuard, W-fc+matchFilter, W-all)', () => {
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
    { name: 'matchFilter+stopGuard', mask: FLAG_MATCH_FILTER | FLAG_STOP_GUARD },
    { name: 'W-fc+matchFilter', mask: resolveFlagSet('W-fc').workerMask | FLAG_MATCH_FILTER },
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
    console.log(`    [metric] oblique ${combo.name}: FP=${fps}, trueHits=${trueHits}/${frames.length}`);
  }
});

test('BL3 zero-alloc hot-loop heap check (--expose-gc) and steady-state timing', () => {
  const fx = synthesizeFixture({
    name: 'bl3_heap_tsx',
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
  const fxNon = synthesizeFixture({
    name: 'bl3_heap_non',
    width: 1280,
    height: 720,
    symbology: 'CODE_128',
    payload: 'SHIP-987654',
    angleDeg: 0,
    modulePx: 2.5,
    barHeightPx: 110,
    centerX: 640,
    centerY: 360,
  });

  const state = createPipelineState(1280, 720);
  const res = createPipelineResult();
  state.flags = FLAG_MATCH_FILTER | FLAG_MODULE_EST | FLAG_CRIB_MATCH | FLAG_STOP_GUARD;

  // Warmup V8 TurboFan JIT
  for (let i = 0; i < 240; i++) {
    processFrame(i & 1 ? fxNon.luma : fx.luma, 1280, 720, state, res, false);
  }

  // 1. Direct matchFilterScanline zero-alloc check (2000 calls after TurboFan warmup)
  const ss = createScanlineState();
  const c128 = createCode128State();
  const rowOff = 360 * 1280;
  ss.flags = FLAG_MATCH_FILTER | FLAG_MODULE_EST;
  ss.moduleWidthQ8 = Math.round(2.2 * 256);
  for (let i = 0; i < 1200; i++) matchFilterScanline(fx.luma, rowOff, 1280, ss, c128, 0);
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const mfBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 2000; i++) {
    matchFilterScanline(fx.luma, rowOff, 1280, ss, c128, 0);
  }
  const mfAfter = process.memoryUsage().heapUsed;
  const mfBytesPerCall = (mfAfter - mfBefore) / 2000;

  // 2. Full processFrame zero-alloc heap measurement
  const N = 100;
  if (typeof globalThis.gc === 'function') globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  let decCount = 0;
  for (let i = 0; i < N; i++) {
    decCount = (decCount + processFrame(i & 1 ? fxNon.luma : fx.luma, 1280, 720, state, res, false)) | 0;
  }
  const heapAfter = process.memoryUsage().heapUsed;
  assert.equal(decCount, N);
  const bytesPerFrame = (heapAfter - heapBefore) / N;

  // 3. Per-frame timing measurement
  const times = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const det = processFrame(i & 1 ? fxNon.luma : fx.luma, 1280, 720, state, res, false);
    times[i] = performance.now() - t0;
    assert.equal(det, 1);
  }
  const sorted = Array.from(times).sort((a, b) => a - b);
  const meanMs = sorted.reduce((a, b) => a + b, 0) / N;
  const p95Ms = sorted[Math.floor(N * 0.95)];

  console.log(
    `    [metric] 100 frames: mean=${meanMs.toFixed(2)}ms, p95=${p95Ms.toFixed(2)}ms, heap=${bytesPerFrame.toFixed(1)} B/frame, mf=${mfBytesPerCall.toFixed(2)} B/call`
  );
  assert.ok(mfBytesPerCall < 16, `matchFilterScanline heap growth too high: ${mfBytesPerCall.toFixed(2)} B/call`);
  assert.ok(bytesPerFrame < 1536, `hot-loop heap growth too high: ${bytesPerFrame.toFixed(1)} B/frame`);
});

console.log(`All ${passed} BL3 matchFilter tests passed.`);
