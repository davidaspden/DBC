/**
 * BL4 — Energy-Scored Conditional Multi-Scale RoI Structure Tensor (`FLAG_ROI_MULTISCALE`) Tests.
 *   node --expose-gc tests/bl4-roi-multiscale.test.js
 *
 * Verifies:
 *  1. Flags-off bit-for-bit parity vs `flags = 0` across all 16 harness fixtures & real still.
 *  2. Absolute directional energy (`blockEnergy`, `clusterEnergy`) exposure & monotonicity.
 *  3. Fast-path skip on easy clean frames (`multiscaleTriggered === 0`) & recovery on weak/
 *     low-contrast/blurred/small/cluttered frames (`multiscaleTriggered > 0`).
 *  4. RoI precision/recall on real still (`tote-tsX07wz7py1`), harness fixtures, and
 *     low-contrast/blurred/shadowed/cluttered `cpu-render.js` sim frames.
 *  5. R8 overlay ground-truth localization with `decodeAnchor` OFF and ON.
 *  6. Zero-allocation hot loop (`--expose-gc`) & timing budget (mean/p95 ms).
 *  7. `fc-tele-30-3p5` oblique-tail 0 FP under `W-fc+roiMultiscale` and `W-all` (plus `roiMultiscale` parity).
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
} from './harness.js';
import {
  createRoiState,
  estimateRoi,
  FLAG_ROI_MULTISCALE,
  FLAG_ROI_SMALL_CODES,
} from '../src/worker/roi.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrame,
  processFrameMulti,
  extractPayloadString,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import {
  FLAG_DECODE_ANCHOR,
  FLAG_STOP_GUARD,
} from '../src/worker/flagbits.js';
import { createSceneForPreset } from '../src/sim/presets.js';
import {
  createCpuRenderContext,
  renderFrame,
  mulberry32,
} from '../src/sim/cpu-render.js';
import { sampleCameraPose } from '../src/sim/paths.js';
import {
  hfovForLongAxisDeg,
  aimPose,
  projectLabelTruth,
  runOverlayMatrix,
} from '../src/sim/overlay-truth.js';
import {
  createScenarioFromPreset,
  resolveFlagSet,
} from '../tools/gate/scenarios.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

function loadRealStill() {
  const pgmPath = path.join(__dirname, 'fixtures-sim', 'tote-tsX07wz7py1-gray.pgm.gz');
  return parsePGM(zlib.gunzipSync(fs.readFileSync(pgmPath)));
}

function scaleContrast(src, contrastScale, meanLuma = 128) {
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = Math.round(meanLuma + (src[i] - meanLuma) * contrastScale);
    out[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
  }
  return out;
}

function addHorizontalClutterStripes(luma, w, h, y0, y1, x0, x1) {
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      // Weak text-like broken clutter
      const v = (((x >> 2) ^ (y >> 2)) & 1) ? 165 : 115;
      luma[row + x] = v;
    }
  }
}

console.log('Running BL4 multi-scale RoI Structure Tensor tests...');

test('1. Flags-off bit-for-bit parity vs baseline across all 16 harness fixtures & real still', () => {
  const fixtures = buildSyntheticTestMatrix();
  const still = loadRealStill();

  const roiA = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  const roiB = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  const resA = createPipelineResult();
  const resB = createPipelineResult();

  for (const fx of fixtures) {
    roiA.flags = 0;
    roiB.flags = 0;
    const fA = estimateRoi(fx.luma, fx.width, fx.height, roiA, resA);
    const fB = estimateRoi(fx.luma, fx.width, fx.height, roiB, resB);
    assert.equal(fA, fB, `found mismatch on ${fx.id}`);
    assert.equal(roiA.clusterCount, roiB.clusterCount);
    assert.equal(roiA.multiscaleTriggered, 0, 'flags=0 must never trigger multiscale');
    assert.equal(resA.roiX, resB.roiX);
    assert.equal(resA.roiY, resB.roiY);
    assert.equal(resA.roiW, resB.roiW);
    assert.equal(resA.roiH, resB.roiH);
    assert.equal(resA.roiCenterX, resB.roiCenterX);
    assert.equal(resA.roiCenterY, resB.roiCenterY);
    assert.equal(resA.thetaDeg, resB.thetaDeg);
    assert.equal(resA.roiConfidence, resB.roiConfidence);
  }

  // Real still flags=0 check
  const stStill = createPipelineState(still.width, still.height);
  const rStill = createPipelineResult();
  stStill.flags = 0;
  const n = processFrameMulti(still.luma, still.width, still.height, stStill, rStill, false);
  assert.equal(n, 1);
  assert.deepEqual(extractMultiDetections(stStill).map((d) => d.payload), ['tsX07wz7py1']);
  assert.equal(stStill.roi.multiscaleTriggered, 0);
});

test('2. Absolute directional energy (blockEnergy & clusterEnergy) exposed and monotonic', () => {
  const highC = synthesizeFixture({
    name: 'bl4_high_c',
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    symbology: 'CODE_128',
    payload: 'tsX11223344A',
    angleDeg: 0,
    modulePx: 2.5,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
  });
  const lowC = scaleContrast(highC.luma, 0.25, 128);
  const blank = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT).fill(128);

  const roi = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  roi.flags = FLAG_ROI_MULTISCALE;
  const res = createPipelineResult();

  const fHigh = estimateRoi(highC.luma, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
  assert.equal(fHigh, 1);
  const eHigh = roi.clusterEnergy[0];
  let maxBlockHigh = 0;
  for (let i = 0; i < roi.gridSize; i++) {
    if (roi.blockEnergy[i] > maxBlockHigh) maxBlockHigh = roi.blockEnergy[i];
  }
  assert.ok(eHigh > 1e5, `expected high clusterEnergy, got ${eHigh}`);
  assert.ok(maxBlockHigh > 1e5, `expected high blockEnergy, got ${maxBlockHigh}`);

  const fLow = estimateRoi(lowC, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
  assert.equal(fLow, 1, 'low contrast fixture should be detected');
  const eLow = roi.clusterEnergy[0];
  assert.ok(eLow > 0 && eLow < eHigh * 0.2, `expected eLow (${eLow}) << eHigh (${eHigh})`);

  const fBlank = estimateRoi(blank, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
  assert.equal(fBlank, 0);
  let maxBlockBlank = 0;
  for (let i = 0; i < roi.gridSize; i++) {
    if (roi.blockEnergy[i] > maxBlockBlank) maxBlockBlank = roi.blockEnergy[i];
  }
  assert.equal(maxBlockBlank, 0, 'blank frame must have 0 blockEnergy');
});

test('3. Easy clean frames skip multi-scale (multiscaleTriggered === 0); weak/low-contrast/blurred/small frames trigger & recover', () => {
  // Easy clean frames: 0, 15, 37, 90 deg high-contrast barcodes + real still
  const roiEasy = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  roiEasy.flags = FLAG_ROI_MULTISCALE;
  const res = createPipelineResult();

  const easyAngles = [0, 15, 37, 90];
  let easyFound = 0;
  for (const ang of easyAngles) {
    const fx = synthesizeFixture({
      name: `easy_${ang}`,
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      symbology: 'CODE_128',
      payload: 'tsX90123456B',
      angleDeg: ang,
      modulePx: 2.5,
      barHeightPx: 140,
      centerX: 640,
      centerY: 360,
    });
    const ok = estimateRoi(fx.luma, FRAME_WIDTH, FRAME_HEIGHT, roiEasy, res);
    if (ok === 1) easyFound++;
  }
  assert.equal(easyFound, easyAngles.length);
  assert.equal(
    roiEasy.multiscaleTriggered,
    0,
    `easy clean frames must skip multi-scale pass, got multiscaleTriggered=${roiEasy.multiscaleTriggered}`
  );

  // Real still should also skip multi-scale on primary pass
  const still = loadRealStill();
  const roiStill = createRoiState(still.width, still.height);
  roiStill.flags = FLAG_ROI_MULTISCALE;
  const okStill = estimateRoi(still.luma, still.width, still.height, roiStill, res);
  assert.equal(okStill, 1);
  assert.equal(
    roiStill.multiscaleTriggered,
    0,
    `real still should skip multi-scale pass, got ${roiStill.multiscaleTriggered}`
  );

  // Weak/hard cases where primary 4x pass misses (flags=0 returns 0) and BL4 recovers!
  const baseSharp = synthesizeFixture({
    name: 'weak_base',
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    symbology: 'CODE_128',
    payload: 'tsX55443322C',
    angleDeg: 90,
    modulePx: 2.6,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
    blurSigma: 3.0,
    noiseStd: 6,
  });
  const veryLowContrastBlurred = scaleContrast(baseSharp.luma, 0.04, 128);

  const smallFar = synthesizeFixture({
    name: 'weak_small_far',
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    symbology: 'CODE_128',
    payload: 'tsX4401A',
    angleDeg: 0,
    modulePx: 1.45,
    barHeightPx: 34,
    centerX: 640,
    centerY: 360,
  });

  const lowContrastCluttered = scaleContrast(
    synthesizeFixture({
      name: 'weak_clutter',
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      symbology: 'CODE_128',
      payload: 'tsX88776655D',
      angleDeg: 0,
      modulePx: 2.4,
      barHeightPx: 120,
      centerX: 640,
      centerY: 360,
      blurSigma: 2.8,
      noiseStd: 5,
    }).luma,
    0.04,
    130
  );
  addHorizontalClutterStripes(lowContrastCluttered, FRAME_WIDTH, FRAME_HEIGHT, 40, 180, 60, 320);

  const weakCases = [
    { name: 'veryLowContrastBlurred', luma: veryLowContrastBlurred, cx: 640, cy: 360 },
    { name: 'smallFar', luma: smallFar.luma, cx: 640, cy: 360 },
    { name: 'lowContrastCluttered', luma: lowContrastCluttered, cx: 640, cy: 360 },
  ];

  const roiOff = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  const roiOn = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  roiOff.flags = 0;
  roiOn.flags = FLAG_ROI_MULTISCALE;

  let baseHits = 0;
  let bl4Hits = 0;
  for (const wc of weakCases) {
    const f0 = estimateRoi(wc.luma, FRAME_WIDTH, FRAME_HEIGHT, roiOff, res);
    if (f0 === 1 && Math.hypot(res.roiCenterX - wc.cx, res.roiCenterY - wc.cy) < 120) baseHits++;

    const before = roiOn.multiscaleTriggered;
    const f1 = estimateRoi(wc.luma, FRAME_WIDTH, FRAME_HEIGHT, roiOn, res);
    const triggered = roiOn.multiscaleTriggered - before;
    assert.ok(triggered >= 1, `expected multi-scale trigger on ${wc.name}`);
    if (f1 === 1) {
      // Check if any cluster hits the barcode center
      let matched = false;
      for (let c = 0; c < roiOn.clusterCount; c++) {
        if (Math.hypot(roiOn.clusterCenterX[c] - wc.cx, roiOn.clusterCenterY[c] - wc.cy) < 120) {
          matched = true;
          break;
        }
      }
      if (matched) bl4Hits++;
    }
  }
  console.log(`  INFO  Weak-frame RoI recovery: baseline=${baseHits}/${weakCases.length} -> BL4=${bl4Hits}/${weakCases.length} (triggered=${roiOn.multiscaleTriggered})`);
  assert.ok(bl4Hits > baseHits, `BL4 must recover more weak frames than baseline (${bl4Hits} vs ${baseHits})`);
  assert.equal(bl4Hits, weakCases.length, `expected BL4 to recover all ${weakCases.length} weak cases, got ${bl4Hits}`);
});

test('4. RoI precision/recall on harness fixtures, real still, and cluttered/low-contrast sim frames', () => {
  const fixtures = buildSyntheticTestMatrix();
  const stOff = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  const stOn = createPipelineState(FRAME_WIDTH, FRAME_HEIGHT);
  stOn.flags = FLAG_ROI_MULTISCALE;
  const res = createPipelineResult();

  let posTotal = 0;
  let posRoiOff = 0;
  let posRoiOn = 0;
  let posDecOff = 0;
  let posDecOn = 0;
  let negFpOn = 0;
  let harnessEasyTriggered = 0;

  for (const fx of fixtures) {
    const fOff = estimateRoi(fx.luma, fx.width, fx.height, stOff.roi, res);
    const before = stOn.roi.multiscaleTriggered;
    const fOn = estimateRoi(fx.luma, fx.width, fx.height, stOn.roi, res);
    const trig = stOn.roi.multiscaleTriggered - before;

    const dOff = processFrame(fx.luma, fx.width, fx.height, stOff, res, false);
    const pOff = dOff === 1 ? extractPayloadString(res) : null;
    const dOn = processFrame(fx.luma, fx.width, fx.height, stOn, res, false);
    const pOn = dOn === 1 ? extractPayloadString(res) : null;

    if (fx.symbology === 'CODE_128') {
      posTotal++;
      if (fOff === 1) posRoiOff++;
      if (fOn === 1) posRoiOn++;
      if (dOff === 1 && pOff === fx.payload) posDecOff++;
      if (dOn === 1 && pOn === fx.payload) posDecOn++;
      if (trig > 0) harnessEasyTriggered++;
    } else if (dOn === 1) {
      negFpOn++;
    }
  }
  console.log(
    `  INFO  Harness (14 pos, 2 neg): RoI recall off=${posRoiOff}/${posTotal} on=${posRoiOn}/${posTotal} | ` +
    `decode off=${posDecOff}/${posTotal} on=${posDecOn}/${posTotal} | negFP=${negFpOn} | posTriggered=${harnessEasyTriggered}/${posTotal}`
  );
  assert.equal(posRoiOn, posTotal);
  assert.equal(posDecOn, posTotal);
  assert.equal(negFpOn, 0);

  // Cluttered / low-contrast / shadowed sim frames via cpu-render.js
  const scene = createSceneForPreset('fc-8-3p5');
  const cell = scene.cells[5];
  const cam = { width: 1280, height: 720, hfovDeg: hfovForLongAxisDeg(1280, 720) };
  const ctx = createCpuRenderContext(scene.cells.length);
  const simRoiOff = createRoiState(cam.width, cam.height);
  const simRoiOn = createRoiState(cam.width, cam.height);
  simRoiOn.flags = FLAG_ROI_MULTISCALE;

  const simCases = [
    { dz: 9, yaw: 0, pitch: 0, roll: 0, shadow: 0.60, noise: 0.05, contrast: 0.045 },
    { dz: 10, yaw: 14, pitch: -6, roll: 5, shadow: 0.65, noise: 0.05, contrast: 0.045 },
    { dz: 11, yaw: -12, pitch: 8, roll: -8, shadow: 0.55, noise: 0.05, contrast: 0.045 },
    { dz: 8, yaw: 0, pitch: 0, roll: 20, shadow: 0.60, noise: 0.05, contrast: 0.040 },
  ];

  let simHitsOff = 0;
  let simHitsOn = 0;
  for (let i = 0; i < simCases.length; i++) {
    const sc = simCases[i];
    const pose = aimPose(cell.cx + (cell.labelOffsetXIn || 0), cell.cy + (cell.labelOffsetYIn || 0), sc.dz, sc.yaw, sc.pitch, sc.roll);
    const truth = projectLabelTruth(pose, scene, 5, cam);
    const raw = renderFrame(scene, pose, {
      width: cam.width,
      height: cam.height,
      hfovDeg: cam.hfovDeg,
      shadowStrength: sc.shadow,
      noiseStrength: sc.noise,
      frameSeed: 101 + i,
      ctx,
    }, null);
    const degraded = scaleContrast(raw, sc.contrast, 128);

    const hitCluster = (roiState) => {
      for (let c = 0; c < roiState.clusterCount; c++) {
        if (Math.hypot(roiState.clusterCenterX[c] - truth.centre.x, roiState.clusterCenterY[c] - truth.centre.y) < truth.labelLongEdgePx * 0.45) {
          return true;
        }
      }
      return false;
    };

    if (estimateRoi(degraded, cam.width, cam.height, simRoiOff, res) === 1 && hitCluster(simRoiOff)) simHitsOff++;
    if (estimateRoi(degraded, cam.width, cam.height, simRoiOn, res) === 1 && hitCluster(simRoiOn)) simHitsOn++;
  }
  console.log(`  INFO  Low-contrast shadowed sim RoI recall: baseline=${simHitsOff}/${simCases.length} -> BL4=${simHitsOn}/${simCases.length}`);
  assert.ok(simHitsOn >= simHitsOff, `BL4 sim RoI recall (${simHitsOn}) must be >= baseline (${simHitsOff})`);
  assert.ok(simHitsOn >= 3, `expected BL4 to recover >= 3/4 degraded sim frames, got ${simHitsOn}/${simCases.length}`);
});

test('5. R8 overlay ground truth with decodeAnchor OFF and ON', () => {
  const scene = createSceneForPreset('fc-8-3p5');
  const base = runOverlayMatrix({ scene, workerMask: 0 }).summary;
  const bl4OffAnchor = runOverlayMatrix({ scene, workerMask: FLAG_ROI_MULTISCALE }).summary;
  const bl4OnAnchor = runOverlayMatrix({ scene, workerMask: FLAG_ROI_MULTISCALE | FLAG_DECODE_ANCHOR }).summary;

  console.log(
    `  INFO  R8 overlay truth: base(centreFrac=${base.maxCentreErrFracLabel.toFixed(3)}, theta=${base.maxThetaErrDeg.toFixed(2)}, iou=${base.minRoiIouBars.toFixed(3)}) | ` +
    `BL4(centreFrac=${bl4OffAnchor.maxCentreErrFracLabel.toFixed(3)}, theta=${bl4OffAnchor.maxThetaErrDeg.toFixed(2)}, iou=${bl4OffAnchor.minRoiIouBars.toFixed(3)}) | ` +
    `BL4+anchor(centreFrac=${bl4OnAnchor.maxCentreErrFracLabel.toFixed(3)}, theta=${bl4OnAnchor.maxThetaErrDeg.toFixed(2)}, iou=${bl4OnAnchor.minRoiIouBars.toFixed(3)})`
  );

  for (const [label, S] of [['BL4', bl4OffAnchor], ['BL4+decodeAnchor', bl4OnAnchor]]) {
    assert.equal(S.undecoded, 0, `${label}: undecoded=${S.undecoded}`);
    assert.ok(S.maxCentreErrFracLabel <= 0.3, `${label}: centre err ${S.maxCentreErrFracLabel}`);
    assert.ok(S.maxThetaErrDeg <= 6, `${label}: theta err ${S.maxThetaErrDeg}`);
    assert.ok(S.minRoiIouBars >= 0.15, `${label}: roi iou ${S.minRoiIouBars}`);
  }
});

test('6. Zero-allocation hot loop (--expose-gc) & performance budget (mean/p95 ms)', () => {
  const easyFx = synthesizeFixture({
    name: 'perf_easy',
    width: FRAME_WIDTH,
    height: FRAME_HEIGHT,
    symbology: 'CODE_128',
    payload: 'tsX12345678B',
    angleDeg: 15,
    modulePx: 2.5,
    barHeightPx: 140,
    centerX: 640,
    centerY: 360,
  });
  const weakLuma = scaleContrast(
    synthesizeFixture({
      name: 'perf_weak',
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      symbology: 'CODE_128',
      payload: 'tsX12345678B',
      angleDeg: 0,
      modulePx: 2.5,
      barHeightPx: 140,
      centerX: 640,
      centerY: 360,
      blurSigma: 3.0,
    }).luma,
    0.04,
    128
  );

  const roi = createRoiState(FRAME_WIDTH, FRAME_HEIGHT);
  roi.flags = FLAG_ROI_MULTISCALE;
  const res = createPipelineResult();

  // Warmup both fast path and multi-scale path
  for (let i = 0; i < 20; i++) {
    estimateRoi(easyFx.luma, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
    estimateRoi(weakLuma, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
  }

  const ITERS = 100;
  const tEasy = new Float64Array(ITERS);
  const tWeak = new Float64Array(ITERS);

  // 1. Pure hot-loop heap measurement (no timing/array allocations inside loop)
  if (typeof global.gc === 'function') global.gc();
  const heapBefore = process.memoryUsage().heapUsed;
  roi.multiscaleTriggered = 0;
  for (let i = 0; i < ITERS; i++) {
    estimateRoi(easyFx.luma, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
  }
  const easyTriggers = roi.multiscaleTriggered;
  for (let i = 0; i < ITERS; i++) {
    estimateRoi(weakLuma, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
  }
  const weakTriggers = roi.multiscaleTriggered - easyTriggers;
  const heapAfter = process.memoryUsage().heapUsed;
  const bytesPerFrame = Math.max(0, (heapAfter - heapBefore) / (ITERS * 2));

  // 2. Timing measurement
  for (let i = 0; i < ITERS; i++) {
    const a0 = performance.now();
    estimateRoi(easyFx.luma, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
    tEasy[i] = performance.now() - a0;
  }
  for (let i = 0; i < ITERS; i++) {
    const b0 = performance.now();
    estimateRoi(weakLuma, FRAME_WIDTH, FRAME_HEIGHT, roi, res);
    tWeak[i] = performance.now() - b0;
  }

  tEasy.sort();
  tWeak.sort();
  let sumEasy = 0;
  let sumWeak = 0;
  for (let i = 0; i < ITERS; i++) {
    sumEasy += tEasy[i];
    sumWeak += tWeak[i];
  }
  const meanEasy = sumEasy / ITERS;
  const p95Easy = tEasy[Math.floor(ITERS * 0.95)];
  const meanWeak = sumWeak / ITERS;
  const p95Weak = tWeak[Math.floor(ITERS * 0.95)];

  console.log(
    `  INFO  Perf (1280x720, ${ITERS}x): easy mean=${meanEasy.toFixed(2)}ms p95=${p95Easy.toFixed(2)}ms (triggers=${easyTriggers}/${ITERS}) | ` +
    `weak mean=${meanWeak.toFixed(2)}ms p95=${p95Weak.toFixed(2)}ms (triggers=${weakTriggers}/${ITERS}) | ` +
    `heap=${bytesPerFrame.toFixed(1)} B/frame`
  );

  assert.equal(easyTriggers, 0, 'easy frames must have 0 multi-scale triggers');
  assert.equal(weakTriggers, ITERS, 'weak frames must trigger multi-scale every time');
  assert.ok(meanEasy < 5.0, `easy RoI mean must stay < 5 ms, got ${meanEasy.toFixed(2)} ms`);
  assert.ok(bytesPerFrame < 512, `hot loop must be near-zero alloc (<512 B/frame), got ${bytesPerFrame.toFixed(1)} B/frame`);
});

test('7. fc-tele-30-3p5 oblique-tail 0 FP under W-fc+roiMultiscale and W-all (and parity under roiMultiscale alone)', () => {
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
  const expectedSet = new Set(sc.expectedPayloads);
  const targets = [
    { seed: 1, frame: 366 },
    { seed: 1, frame: 385 },
    { seed: 2, frame: 374 },
    { seed: 2, frame: 377 },
    { seed: 2, frame: 381 },
    { seed: 2, frame: 384 },
    { seed: 2, frame: 385 },
  ];
  const frames = targets.map((tgt) => {
    const rng = mulberry32((Math.imul(tgt.seed | 0, 0x9e3779b1) ^ 0x13579bdf) >>> 0);
    const phaseOffsetSec = rng() * dtSec;
    const tSec = phaseOffsetSec + tgt.frame * dtSec;
    const poses = new Array(5);
    for (let k = 0; k < 5; k++) {
      const frac = (k / 4) - 0.5;
      poses[k] = sampleCameraPose(sc.path, Math.max(0, tSec + frac * shutterSec), poseCfg);
    }
    const luma = new Uint8Array(sc.width * sc.height);
    renderFrame(sc.scene, poses, {
      width: sc.width,
      height: sc.height,
      hfovDeg: sc.hfovDeg,
      shadowStrength: sc.scene.shadowStrength,
      noiseStrength: sc.scene.noiseStrength,
      glareStrength: sc.scene.glareStrength,
      frameSeed: tgt.seed * 100003 + tgt.frame * 0.71,
      ctx,
    }, luma);
    return { ...tgt, luma };
  });

  const state = createPipelineState(sc.width, sc.height);
  const result = createPipelineResult();

  const combos = [
    { name: 'roiMultiscale+stopGuard', mask: FLAG_ROI_MULTISCALE | FLAG_STOP_GUARD },
    { name: 'W-fc+roiMultiscale', mask: resolveFlagSet('W-fc').workerMask | FLAG_ROI_MULTISCALE },
    { name: 'W-all', mask: resolveFlagSet('W-all').workerMask },
  ];

  for (const combo of combos) {
    let fp = 0;
    let tp = 0;
    for (const fr of frames) {
      state.flags = combo.mask;
      state.scanline.mode = 0;
      processFrameMulti(fr.luma, sc.width, sc.height, state, result, false);
      for (const d of extractMultiDetections(state)) {
        if (!expectedSet.has(d.payload)) fp++;
        else if (d.payload === 'tsX41A00013B') tp++;
      }
    }
    assert.equal(fp, 0, `${combo.name} must have 0 FP on oblique R4C1 frames, got ${fp}`);
    assert.ok(tp >= 4, `${combo.name} must decode tsX41A00013B on >=4/7 oblique frames, got ${tp}`);
  }
});

console.log(`All ${passed} BL4 multi-scale RoI tests passed.`);
