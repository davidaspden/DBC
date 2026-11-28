/**
 * K4–K7 Camera-Pipeline Model Unit Tests (`tests/camera-model-k4-k7.test.js`).
 *   node tests/camera-model-k4-k7.test.js
 *   node --expose-gc tests/camera-model-k4-k7.test.js
 */

import assert from 'node:assert/strict';
import {
  renderFrame,
  createCpuRenderContext,
} from '../src/sim/cpu-render.js';
import { createScene } from '../src/sim/scene.js';
import { computeOptics } from '../src/sim/paths.js';
import {
  DEFAULT_ROLLING_CONFIG,
  expectedRollingShearPx,
  createRollingState,
  renderRollingBands,
  renderRollingFrame,
} from '../src/sim/camera-model/rolling.js';
import {
  A53_FOCUS_LIMITS,
  DEFAULT_OPTICS_CONFIG,
  computeDefocusRadiusPx,
  distortPoint,
  undistortPoint,
  createOpticsState,
  stepAutofocus,
  applyOpticsModel,
} from '../src/sim/camera-model/optics.js';
import {
  DEFAULT_COMPRESS_CONFIG,
  computePsnr,
  createCompressState,
  applyCompression,
} from '../src/sim/camera-model/compress.js';
import {
  DEFAULT_GLARE_CONFIG,
  computeTorchLuxBoost,
  predictSpecHotspotPixel,
  createGlareState,
  applyGlareModel,
} from '../src/sim/camera-model/glare.js';
import {
  createExposureState,
  stepExposure,
} from '../src/sim/camera-model/exposure.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running K4-K7 camera-model tests...');

// ============================================================================
// K4 — Rolling Shutter Band Renderer
// ============================================================================

test('K4: disabled rolling shutter matches standard single-pose renderFrame bit-for-bit', () => {
  assert.equal(DEFAULT_ROLLING_CONFIG.enabled, false);
  const scene = createScene({
    fcMode: true,
    shadowStrength: 0.2,
    noiseStrength: 0,
    glareStrength: 0,
    label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder', payloadFn: () => 'tsX07wz7py1' },
  });
  const cell = scene.cells[5];
  const width = 320;
  const height = 180;
  const opts = { width, height, hfovDeg: 70.7, seed: 42 };
  const poseStart = { x: cell.cx, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const poseEnd = { x: cell.cx + 1.0, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

  const ref = new Uint8Array(width * height);
  renderFrame(scene, poseStart, opts, ref);

  const stOff = createRollingState(width, height, { enabled: false, readoutMs: 25, bandHeight: 8 });
  const out = new Uint8Array(width * height);
  renderRollingFrame(scene, 0, { poseStart, poseEnd }, opts, stOff, out);

  assert.deepEqual(out, ref, 'simRolling off must equal single-pose renderFrame bit-for-bit');
});

test('K4: 20 in/s horizontal pan shears vertical edge within 10% of closed-form expectation', () => {
  const width = 640;
  const height = 360;
  const hfovDeg = 70.7;
  const distIn = 8.0;
  const speedInPerSec = 20.0;
  const readoutMs = 25.0;

  const scene = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder', payloadFn: () => 'tsX07wz7py1' },
  });
  const cell = scene.cells[5];
  const opts = { width, height, hfovDeg, seed: 1 };

  const stOn = createRollingState(width, height, { enabled: true, readoutMs, bandHeight: 8 });
  const out = new Uint8Array(width * height);
  const poseAtTime = (tSec, outPose) => {
    outPose.x = cell.cx + speedInPerSec * tSec;
    outPose.y = cell.cy;
    outPose.z = distIn;
    outPose.yawDeg = 0;
    outPose.pitchDeg = 0;
    outPose.rollDeg = 0;
  };
  renderRollingFrame(scene, 0, poseAtTime, opts, stOn, out);

  // Find left white-paper edge of the label at two rows near top and bottom of label
  const optics = computeOptics({
    distanceIn: distIn,
    hfovDeg,
    widthPx: width,
    heightPx: height,
    totalModules: 176,
    labelWidthIn: 2.0,
    labelHeightIn: 3.5,
  });

  function findLeftLabelEdgeX(y) {
    const rowOff = y * width;
    // Sub-pixel linear interpolation at luma=160 crossing
    for (let x = 20; x < width - 20; x++) {
      const v1 = out[rowOff + x];
      if (v1 > 160) {
        const v0 = out[rowOff + x - 1];
        const frac = v1 > v0 ? (160 - v0) / (v1 - v0) : 0;
        return (x - 1) + frac;
      }
    }
    return -1;
  }

  // Align yTop and yBot to band centers (8-row bands) so band quantization does not bias dy
  const yTop = ((Math.round(height * 0.5 - optics.barcodeHeightPx * 0.40) >> 3) << 3) + 4;
  const yBot = ((Math.round(height * 0.5 + optics.barcodeHeightPx * 0.40) >> 3) << 3) + 4;
  const xTop = findLeftLabelEdgeX(yTop);
  const xBot = findLeftLabelEdgeX(yBot);
  assert.ok(xTop > 0 && xBot > 0, `could not locate label edges: xTop=${xTop}, xBot=${xBot}`);

  // Camera moves +x -> wall features shift -x over time -> bottom rows shift left relative to top
  const measuredShearPx = xTop - xBot;
  const expectedShearPx = expectedRollingShearPx(
    speedInPerSec,
    readoutMs,
    optics.pxPerInch,
    yBot - yTop,
    height
  );
  const relErr = Math.abs(measuredShearPx - expectedShearPx) / expectedShearPx;
  assert.ok(relErr <= 0.10,
    `rolling shear mismatch: measured=${measuredShearPx.toFixed(2)} px vs expected=${expectedShearPx.toFixed(2)} px (err=${(relErr * 100).toFixed(1)}%)`);
});

test('K4: renderRollingBands custom callback and zero-allocation hot loop', () => {
  const width = 160;
  const height = 96;
  const st = createRollingState(width, height, { enabled: true, readoutMs: 24, bandHeight: 8 });
  const out = new Uint8Array(width * height);
  const poseSource = {
    poseStart: { x: 0, y: 0, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    poseEnd: { x: 10, y: 0, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
  };
  const renderBand = (y0, y1, pose, buf) => {
    const v = Math.min(255, Math.max(0, Math.round(pose.x * 25)));
    for (let y = y0; y < y1; y++) {
      const off = y * width;
      for (let x = 0; x < width; x++) buf[off + x] = v;
    }
  };
  renderRollingBands(width, height, 0, poseSource, renderBand, st, out);
  assert.ok(out[0] < out[(height - 1) * width], 'bottom band must reflect later pose');

  for (let i = 0; i < 10; i++) renderRollingBands(width, height, i * 0.03, poseSource, renderBand, st, out);
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const iters = 200;
    for (let i = 0; i < iters; i++) renderRollingBands(width, height, i * 0.03, poseSource, renderBand, st, out);
    globalThis.gc();
    const bpf = Math.max(0, (process.memoryUsage().heapUsed - h0) / iters);
    assert.ok(bpf < 64, `K4 hot-loop heap growth too high: ${bpf.toFixed(1)} B/frame`);
  }
});

// ============================================================================
// K5 — Optics: Defocus/AF Lag, Vignette, Barrel Distortion, Sharpening, Demosaic
// ============================================================================

test('K5: defocus blur increases monotonically with focus error and AF hunts after jump', () => {
  assert.equal(DEFAULT_OPTICS_CONFIG.enabled, false);
  const w = 128;
  const h = 64;
  const stepImg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) stepImg[y * w + x] = x < 64 ? 40 : 210;
  }
  const out = new Uint8Array(w * h);

  const errs = [0.0, 0.05, 0.15, 0.40];
  let prevGrad = Infinity;
  let prevR = -1;
  for (const err of errs) {
    const r = computeDefocusRadiusPx(0.30 + err, 0.30);
    assert.ok(r > prevR, `defocus radius must increase monotonically: r=${r} <= ${prevR}`);
    prevR = r;

    const st = createOpticsState(w, h, {
      enabled: true,
      defocusEnabled: true,
      demosaicEnabled: false,
      vignetteEnabled: false,
      distortionEnabled: false,
      sharpenEnabled: false,
      focusDistM: 0.30 + err,
      subjectDistM: 0.30,
    });
    applyOpticsModel(stepImg, w, h, st, out);
    // Measure max horizontal gradient across the step edge at mid-row
    const rowOff = (h >> 1) * w;
    let maxGrad = 0;
    for (let x = 48; x < 80; x++) {
      const g = Math.abs(out[rowOff + x + 1] - out[rowOff + x]);
      if (g > maxGrad) maxGrad = g;
    }
    assert.ok(maxGrad <= prevGrad, `edge gradient must decrease with defocus: ${maxGrad} > ${prevGrad}`);
    prevGrad = maxGrad;
  }
  assert.ok(prevGrad < 80, `large focus error must measurably blur edge, maxGrad=${prevGrad}`);

  // AF hunting lag model after distance jump
  const afSt = createOpticsState(w, h, {
    enabled: true,
    focusDistM: 0.25,
    subjectDistM: 0.25,
  });
  let maxDist = 0.25;
  for (let i = 0; i < 60; i++) {
    const f = stepAutofocus(afSt, 0.033, 0.80, 1.0);
    if (f > maxDist) maxDist = f;
    assert.ok(f >= A53_FOCUS_LIMITS.minFocusDistM && f <= A53_FOCUS_LIMITS.maxFocusDistM);
  }
  assert.ok(maxDist > 0.805, `expected slight AF hunting overshoot > 0.805m, got ${maxDist.toFixed(4)}m`);
  assert.ok(Math.abs(afSt.focusDistM - 0.80) < 0.03,
    `expected AF to settle near 0.80m, got ${afSt.focusDistM.toFixed(4)}m`);
});

test('K5: sharpening halo overshoot on step edge, vignette, distortion round-trip & sub-switches', () => {
  const w = 128;
  const h = 96;
  const stepImg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) stepImg[y * w + x] = x < 64 ? 60 : 190;
  }
  const out = new Uint8Array(w * h);

  // Sharpening only -> halo overshoot > 190 on bright side and < 60 on dark side
  const stSharp = createOpticsState(w, h, {
    enabled: true,
    defocusEnabled: false,
    demosaicEnabled: false,
    vignetteEnabled: false,
    distortionEnabled: false,
    sharpenEnabled: true,
    sharpenAmount: 0.8,
    sharpenRadiusPx: 1.5,
  });
  applyOpticsModel(stepImg, w, h, stSharp, out);
  const rowOff = (h >> 1) * w;
  let darkMin = 255;
  let brightMax = 0;
  for (let x = 58; x < 64; x++) if (out[rowOff + x] < darkMin) darkMin = out[rowOff + x];
  for (let x = 64; x < 70; x++) if (out[rowOff + x] > brightMax) brightMax = out[rowOff + x];
  assert.ok(brightMax > 205, `expected bright halo overshoot > 205, got ${brightMax}`);
  assert.ok(darkMin < 45, `expected dark halo undershoot < 45, got ${darkMin}`);

  // Vignette only -> corners darker than center
  const flat = new Uint8Array(w * h).fill(200);
  const stVig = createOpticsState(w, h, {
    enabled: true,
    defocusEnabled: false,
    demosaicEnabled: false,
    vignetteEnabled: true,
    vignetteStrength: 0.3,
    distortionEnabled: false,
    sharpenEnabled: false,
  });
  applyOpticsModel(flat, w, h, stVig, out);
  const centerVal = out[(h >> 1) * w + (w >> 1)];
  const cornerVal = out[0];
  assert.ok(centerVal > 195 && cornerVal < 155,
    `expected vignette corner darkening: center=${centerVal}, corner=${cornerVal}`);

  // distortPoint / undistortPoint round-trip for AR M6
  const ptD = new Float64Array(2);
  const ptU = new Float64Array(2);
  for (const k1 of [-0.08, -0.04, 0.05]) {
    distortPoint(0.6, -0.45, k1, ptD, 0);
    undistortPoint(ptD[0], ptD[1], k1, ptU, 0);
    assert.ok(Math.hypot(ptU[0] - 0.6, ptU[1] + 0.45) < 1e-6,
      `distort/undistort round-trip failed for k1=${k1}`);
  }

  // Default-off is exact no-op
  const stOff = createOpticsState(w, h, { enabled: false });
  applyOpticsModel(stepImg, w, h, stOff, out);
  assert.deepEqual(out, stepImg);
});

test('K5: zero-allocation hot loop in applyOpticsModel', () => {
  const w = 128;
  const h = 96;
  const src = new Uint8Array(w * h);
  for (let i = 0; i < src.length; i++) src[i] = (i * 13) & 255;
  const out = new Uint8Array(w * h);
  const st = createOpticsState(w, h, {
    enabled: true,
    focusDistM: 0.35,
    subjectDistM: 0.30,
  });
  for (let i = 0; i < 25; i++) applyOpticsModel(src, w, h, st, out);
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const iters = 60;
    for (let i = 0; i < iters; i++) applyOpticsModel(src, w, h, st, out);
    globalThis.gc();
    const bpf = Math.max(0, (process.memoryUsage().heapUsed - h0) / iters);
    assert.ok(bpf < 128, `K5 hot-loop heap growth too high: ${bpf.toFixed(1)} B/frame`);
  }
});

// ============================================================================
// K6 — 8x8 Separable DCT & JPEG-Style Luma Quantization Compression
// ============================================================================

test('K6: PSNR is strictly monotone with quality and default-off is exact no-op', () => {
  assert.equal(DEFAULT_COMPRESS_CONFIG.enabled, false);
  const w = 160;
  const h = 120;
  const src = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Textured high-frequency pattern (bars + smooth ramp)
      const bars = ((y >> 1) & 1) ? 210 : 40;
      const ramp = (x * 255 / w) | 0;
      src[y * w + x] = (x > 40 && x < 120) ? bars : ramp;
    }
  }
  const out = new Uint8Array(w * h);
  const st = createCompressState({ enabled: true, quality: 10 });

  const qualities = [10, 20, 40, 60, 85, 95];
  let prevPsnr = -Infinity;
  for (const q of qualities) {
    st.quality = q;
    applyCompression(src, w, h, st, out);
    const psnr = computePsnr(src, out);
    assert.ok(psnr > prevPsnr, `PSNR must increase strictly with quality: Q=${q} (${psnr.toFixed(2)} dB) <= prev (${prevPsnr.toFixed(2)} dB)`);
    prevPsnr = psnr;
  }

  st.enabled = false;
  applyCompression(src, w, h, st, out);
  assert.deepEqual(out, src);
});

test('K6: 1.5-2.0 px/module ladder barcode decodes at Q=85 and degrades at Q=20', () => {
  const scene = createScene({
    fcMode: true,
    shadowStrength: 0.15,
    noiseStrength: 0,
    glareStrength: 0,
    label: {
      widthIn: 2.0,
      heightIn: 3.5,
      orientation: 'ladder',
      payloadFn: () => 'tsX07wz7py1',
    },
  });
  const cell = scene.cells[5];
  const width = 1280;
  const height = 720;
  const hfovDeg = 70.7;
  // At 12 in on 1280x720 (70.7 deg HFOV), 176 modules over 3.5 in => ~1.50 px/module;
  // at 10.5 in => ~1.71 px/module (squarely in 1.5-2.0 px/module range)
  const distIn = 10.5;
  const optics = computeOptics({
    distanceIn: distIn,
    hfovDeg,
    widthPx: width,
    heightPx: height,
    totalModules: 176,
    labelWidthIn: 2.0,
    labelHeightIn: 3.5,
  });
  const ppm = optics.barcodeHeightPx / 176;
  assert.ok(ppm >= 1.5 && ppm <= 2.0,
    `expected 1.5-2.0 px/module, got ${ppm.toFixed(2)}`);

  const pose = { x: cell.cx, y: cell.cy, z: distIn, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const clean = new Uint8Array(width * height);
  renderFrame(scene, pose, { width, height, hfovDeg, seed: 1 }, clean);

  const comp85 = new Uint8Array(width * height);
  const comp20 = new Uint8Array(width * height);
  const stComp = createCompressState({ enabled: true, quality: 85 });
  applyCompression(clean, width, height, stComp, comp85);
  stComp.quality = 20;
  applyCompression(clean, width, height, stComp, comp20);

  const psnr85 = computePsnr(clean, comp85);
  const psnr20 = computePsnr(clean, comp20);
  assert.ok(psnr85 > psnr20 + 6.0,
    `expected Q=20 to degrade PSNR by >6 dB: Q85=${psnr85.toFixed(2)} dB, Q20=${psnr20.toFixed(2)} dB`);

  const pipeState = createPipelineState(width, height);
  pipeState.flags = 0;
  const pipeRes = createPipelineResult();
  processFrameMulti(comp85, width, height, pipeState, pipeRes, false);
  const dets85 = extractMultiDetections(pipeState);
  assert.ok(dets85.some((d) => d.payload === 'tsX07wz7py1'),
    `expected Q=85 ladder (${ppm.toFixed(2)} px/mod) to decode tsX07wz7py1, got ${JSON.stringify(dets85.map((d) => d.payload))}`);
});

test('K6: zero-allocation hot loop in applyCompression', () => {
  const w = 160;
  const h = 96;
  const src = new Uint8Array(w * h);
  for (let i = 0; i < src.length; i++) src[i] = (i * 19) & 255;
  const out = new Uint8Array(w * h);
  const st = createCompressState({ enabled: true, quality: 75 });
  for (let i = 0; i < 20; i++) applyCompression(src, w, h, st, out);
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const iters = 50;
    for (let i = 0; i < iters; i++) applyCompression(src, w, h, st, out);
    globalThis.gc();
    const bpf = Math.max(0, (process.memoryUsage().heapUsed - h0) / iters);
    assert.ok(bpf < 128, `K6 hot-loop heap growth too high: ${bpf.toFixed(1)} B/frame`);
  }
});

// ============================================================================
// K7 — Moving Specular Glare & Co-Located Camera Torch
// ============================================================================

test('K7: specular hotspot centers at predicted specular direction and moves with pose', () => {
  assert.equal(DEFAULT_GLARE_CONFIG.enabled, false);
  const w = 320;
  const h = 180;
  const hfovDeg = 70.7;
  const base = new Uint8Array(w * h).fill(60);
  const out = new Uint8Array(w * h);

  const st = createGlareState({
    enabled: true,
    torchEnabled: true,
    torchIntensity: 0.6,
    roomGlareEnabled: false,
    gloss: 0.9,
    specExponent: 40,
  });

  // Check two poses: head-on and yawed/pitched so hotspot moves off center
  const poses = [
    { x: 0, y: 0, z: 12, yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
    { x: 0, y: 0, z: 12, yawDeg: 14, pitchDeg: -8, rollDeg: 0 },
  ];
  const pred = new Float64Array(3);
  const peakPositions = [];

  for (const pose of poses) {
    applyGlareModel(base, w, h, pose, hfovDeg, st, out);
    predictSpecHotspotPixel(pose, w, h, hfovDeg, null, pred, st);
    assert.equal(pred[2], 0, 'predicted hotspot should be in front of camera');

    // Find brightest pixel centroid (all pixels >= max - 2)
    let maxV = 0;
    for (let i = 0; i < out.length; i++) if (out[i] > maxV) maxV = out[i];
    let sumX = 0, sumY = 0, cnt = 0;
    for (let y = 0; y < h; y++) {
      const off = y * w;
      for (let x = 0; x < w; x++) {
        if (out[off + x] >= maxV - 2) {
          sumX += x;
          sumY += y;
          cnt++;
        }
      }
    }
    const peakX = sumX / cnt;
    const peakY = sumY / cnt;
    const distPx = Math.hypot(peakX - pred[0], peakY - pred[1]);
    assert.ok(distPx <= 4.0,
      `hotspot centroid (${peakX.toFixed(1)}, ${peakY.toFixed(1)}) too far from predicted (${pred[0].toFixed(1)}, ${pred[1].toFixed(1)}), err=${distPx.toFixed(1)} px`);
    peakPositions.push({ x: peakX, y: peakY });
  }

  // Verify hotspot actually moved when pose rotated
  const shift = Math.hypot(peakPositions[1].x - peakPositions[0].x, peakPositions[1].y - peakPositions[0].y);
  assert.ok(shift > 25, `expected hotspot to move > 25 px on yaw/pitch, moved ${shift.toFixed(1)} px`);
});

test('K7: label contrast drops inside hotspot, torch boosts AE, and off is exact no-op', () => {
  const scene = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder', payloadFn: () => 'tsX07wz7py1' },
  });
  const cell = scene.cells[5];
  const w = 320;
  const h = 180;
  const hfovDeg = 70.7;
  const pose = { x: cell.cx, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

  const clean = new Uint8Array(w * h);
  renderFrame(scene, pose, { width: w, height: h, hfovDeg, seed: 1 }, clean);

  const glared = new Uint8Array(w * h);
  const stGlare = createGlareState({
    enabled: true,
    torchEnabled: true,
    torchIntensity: 0.95,
    roomGlareEnabled: false,
    gloss: 0.9,
    specExponent: 32,
  });
  applyGlareModel(clean, w, h, pose, hfovDeg, stGlare, glared);

  // Measure contrast (max - min) in central 20x20 patch over the barcode bars
  function patchContrast(buf) {
    let lo = 255, hi = 0;
    const cx = w >> 1;
    const cy = h >> 1;
    for (let y = cy - 10; y <= cy + 10; y++) {
      for (let x = cx - 10; x <= cx + 10; x++) {
        const v = buf[y * w + x];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return hi - lo;
  }

  const cClean = patchContrast(clean);
  const cGlare = patchContrast(glared);
  assert.ok(cClean > 120, `expected strong clean bar contrast > 120, got ${cClean}`);
  assert.ok(cGlare < cClean * 0.4,
    `expected hotspot to wash out bar contrast: clean=${cClean}, glared=${cGlare}`);

  // Torch illumination boost feeds K2 AE and drives exposure down
  const boostOn = computeTorchLuxBoost(12, stGlare);
  const boostOff = computeTorchLuxBoost(12, { enabled: false, torchEnabled: true });
  assert.ok(boostOn > 500, `expected torch lux boost > 500, got ${boostOn}`);
  assert.equal(boostOff, 0);

  const expNoTorch = createExposureState({ enabled: true, lux: 'low', convergenceTauSec: 0.3 });
  const expTorch = createExposureState({ enabled: true, lux: 'low', convergenceTauSec: 0.3 });
  for (let i = 0; i < 60; i++) {
    stepExposure(expNoTorch, 0.05, 0);
    stepExposure(expTorch, 0.05, boostOn);
  }
  assert.ok(expNoTorch.outExposure.exposureTimeMs > 95, 'low light without torch should approach 100 ms');
  assert.ok(expTorch.outExposure.exposureTimeMs < 20,
    `torch boost should drive AE exposure down < 20 ms, got ${expTorch.outExposure.exposureTimeMs.toFixed(2)} ms`);

  // Exact no-op when glare disabled or both sources disabled
  const stOff = createGlareState({ enabled: false, torchEnabled: true });
  const outOff = new Uint8Array(w * h);
  applyGlareModel(clean, w, h, pose, hfovDeg, stOff, outOff);
  assert.deepEqual(outOff, clean);
});

test('K7: zero-allocation hot loop in applyGlareModel', () => {
  const w = 160;
  const h = 90;
  const src = new Uint8Array(w * h).fill(80);
  const out = new Uint8Array(w * h);
  const pose = { x: 0, y: 0, z: 12, yawDeg: 5, pitchDeg: -3, rollDeg: 0 };
  const st = createGlareState({ enabled: true, torchEnabled: true, roomGlareEnabled: true });
  for (let i = 0; i < 20; i++) applyGlareModel(src, w, h, pose, 70.7, st, out);
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const iters = 50;
    for (let i = 0; i < iters; i++) applyGlareModel(src, w, h, pose, 70.7, st, out);
    globalThis.gc();
    const bpf = Math.max(0, (process.memoryUsage().heapUsed - h0) / iters);
    assert.ok(bpf < 128, `K7 hot-loop heap growth too high: ${bpf.toFixed(1)} B/frame`);
  }
});

console.log(`All ${passed} K4-K7 camera-model tests passed.`);
