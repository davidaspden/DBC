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

console.log(`All ${passed} K4-K7 camera-model tests passed.`);
