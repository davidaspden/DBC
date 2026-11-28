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

console.log(`All ${passed} K4-K7 camera-model tests passed.`);
