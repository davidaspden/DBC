/**
 * R5 — Headless Pure-JS CPU Renderer Unit, Decode, Perf & Determinism Tests (`tests/cpu-render.test.js`).
 *   node tests/cpu-render.test.js
 *   node --expose-gc tests/cpu-render.test.js
 */

import assert from 'node:assert/strict';
import {
  renderFrame,
  createCpuRenderContext,
  mulberry32,
} from '../src/sim/cpu-render.js';
import { createScene } from '../src/sim/scene.js';
import { createSceneForPreset, getPreset, ORIGINAL_PRESET_IDS } from '../src/sim/presets.js';
import { encodeCode128B, sampleBarcodeIntegrated1D } from '../src/sim/label.js';
import { sampleCameraPose, computeOptics } from '../src/sim/paths.js';
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

console.log('Running R5 headless CPU renderer tests...');

test('mulberry32 is deterministic and yields uniform values in [0, 1)', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const c = mulberry32(43);
  let sameAC = 0;
  for (let i = 0; i < 64; i++) {
    const va = a();
    const vb = b();
    const vc = c();
    assert.ok(va >= 0 && va < 1);
    assert.equal(va, vb);
    if (va === vc) sameAC++;
  }
  assert.ok(sameAC < 4, 'distinct seeds must produce distinct sequences');
});

test('closed-form analytic coverage matches rendered pixels on flat lit barcode', () => {
  const scene = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    label: {
      widthIn: 2.0,
      heightIn: 3.5,
      orientation: 'ladder',
      payloadFn: () => 'tsX07wz7py1',
    },
  });
  const cell = scene.cells[0];
  const width = 1280;
  const height = 720;
  const hfovDeg = 70.7;
  const dist = 10;
  const pose = { x: cell.cx, y: cell.cy, z: dist, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

  const out = new Uint8Array(width * height);
  renderFrame(scene, [pose], { width, height, hfovDeg, seed: 1 }, out);

  const enc = encodeCode128B('tsX07wz7py1', 10);
  const optics = computeOptics({
    distanceIn: dist,
    hfovDeg,
    widthPx: width,
    heightPx: height,
    totalModules: enc.totalModules,
    labelWidthIn: 2.0,
    labelHeightIn: 3.5,
  });

  // Flat wall N=(0,0,1), shadow=0, glare=0, noise=0
  const lightZ = 0.89 / Math.hypot(-0.18, 0.42, 0.89);
  const flatIllum = 0.38 + 0.62 * lightZ;
  const cxPx = width >> 1; // x = 640 -> offset +0.5 px from wall center, well inside 2 in bar span

  // Sample 25 vertical pixels spanning quiet zone, start bars, data bars, stop bars
  const halfLabelPx = optics.barcodeHeightPx * 0.5;
  const centerY = height * 0.5;
  let maxErr = 0;
  for (let i = 0; i < 25; i++) {
    const frac = 0.02 + (i / 24) * 0.96; // v01 across [0.02, 0.98]
    const yPx = Math.floor(centerY - halfLabelPx + frac * optics.barcodeHeightPx);
    // Exact v01 at pixel center (yPx + 0.5)
    const wy = cell.cy + (centerY - (yPx + 0.5)) / optics.pxPerInch;
    const ly = wy - cell.cy;
    const v01 = (1.75 - ly) / 3.5;
    const dv = 1.0 / optics.barcodeHeightPx;
    const cov = sampleBarcodeIntegrated1D(enc.modules, enc.totalModules, v01, dv, 1.0);
    const albedo = 0.93 + (0.06 - 0.93) * cov;
    const expectedU8 = Math.round(albedo * flatIllum * 255);
    const actualU8 = out[yPx * width + cxPx];
    const err = Math.abs(actualU8 - expectedU8);
    if (err > maxErr) maxErr = err;
  }
  assert.ok(maxErr <= 1, `closed-form pixel error too high: maxErr=${maxErr}`);
});

test('tsX ladder rendered at 8 in decodes cleanly with real worker processFrameMulti', () => {
  const scene = createScene({
    fcMode: true,
    label: {
      widthIn: 2.0,
      heightIn: 3.5,
      orientation: 'ladder',
      payloadFn: () => 'tsX07wz7py1',
    },
  });
  const cell = scene.cells[5]; // R2C2
  const width = 1280;
  const height = 720;
  const out = new Uint8Array(width * height);
  const pose = { x: cell.cx, y: cell.cy, z: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };

  renderFrame(scene, [pose], { width, height, hfovDeg: 70.7, seed: 7 }, out);

  const workerState = createPipelineState(width, height);
  workerState.flags = 0; // flags off baseline decode!
  const result = createPipelineResult();
  processFrameMulti(out, width, height, workerState, result, false);
  const dets = extractMultiDetections(workerState);

  assert.ok(dets.length >= 1, `expected >= 1 detection at 8 in, got ${dets.length}`);
  assert.equal(dets[0].payload, 'tsX07wz7py1');
  assert.equal(dets[0].prefixOk, 1);
});

test('all 16 cells of rendered 4x4 grid decode accurately with zero false positives', () => {
  const scene = createSceneForPreset('a53-8-720');
  const width = 1280;
  const height = 720;
  const out = new Uint8Array(width * height);
  const ctx = createCpuRenderContext();
  const workerState = createPipelineState(width, height);
  workerState.flags = 0;
  const result = createPipelineResult();

  const expectedSet = new Set(scene.cells.map((c) => c.payload));
  const decodedSet = new Set();
  let fp = 0;

  for (const cell of scene.cells) {
    const pose = { x: cell.cx, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
    renderFrame(scene, [pose], { width, height, hfovDeg: 70.7, seed: cell.index + 1, ctx }, out);
    processFrameMulti(out, width, height, workerState, result, false);
    const dets = extractMultiDetections(workerState);
    for (const d of dets) {
      if (expectedSet.has(d.payload)) decodedSet.add(d.payload);
      else fp++;
    }
  }

  assert.equal(fp, 0, `unexpected false positives: ${fp}`);
  assert.equal(decodedSet.size, 16, `expected 16/16 cells decoded, got ${decodedSet.size}`);
});

test('multi-subframe shutter blur smears vertical ladder motion while keeping horizontal motion sharp', () => {
  const scene = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder' },
  });
  const cell = scene.cells[0];
  const width = 640;
  const height = 360;
  const hfovDeg = 70.7;

  const staticOut = new Uint8Array(width * height);
  const vBlurOut = new Uint8Array(width * height);
  const hBlurOut = new Uint8Array(width * height);

  const centerPose = { x: cell.cx, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  renderFrame(scene, [centerPose], { width, height, hfovDeg, seed: 1 }, staticOut);

  // 7 poses moving vertically by 0.25 in (smears horizontal ladder bars!)
  const vPoses = [];
  const hPoses = [];
  for (let k = 0; k < 7; k++) {
    const frac = k / 6 - 0.5;
    vPoses.push({ x: cell.cx, y: cell.cy + frac * 0.25, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
    hPoses.push({ x: cell.cx + frac * 0.25, y: cell.cy, z: 10, yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
  }
  renderFrame(scene, vPoses, { width, height, hfovDeg, seed: 1 }, vBlurOut);
  renderFrame(scene, hPoses, { width, height, hfovDeg, seed: 1 }, hBlurOut);

  // Measure vertical gradient energy down center column of the label
  const cx = width >> 1;
  const y0 = (height >> 1) - 40;
  const y1 = (height >> 1) + 40;
  let gradStatic = 0, gradV = 0, gradH = 0;
  for (let y = y0; y < y1; y++) {
    gradStatic += Math.abs(staticOut[(y + 1) * width + cx] - staticOut[y * width + cx]);
    gradV += Math.abs(vBlurOut[(y + 1) * width + cx] - vBlurOut[y * width + cx]);
    gradH += Math.abs(hBlurOut[(y + 1) * width + cx] - hBlurOut[y * width + cx]);
  }
  assert.ok(gradStatic > 500, `expected strong bar contrast, got ${gradStatic}`);
  assert.ok(gradV < gradStatic * 0.6, `vertical shutter motion must reduce bar contrast (${gradV} vs ${gradStatic})`);
  assert.ok(gradH > gradStatic * 0.9, `horizontal shutter motion should preserve ladder bar contrast (${gradH} vs ${gradStatic})`);
});

test('all 4 original presets render deterministically (byte-identical on repeat)', () => {
  for (const id of ORIGINAL_PRESET_IDS) {
    const preset = getPreset(id);
    const scene = createSceneForPreset(id);
    // Use compact 320x180 for quick byte-identical check across all 4 presets
    const width = 320;
    const height = 180;
    const pose = sampleCameraPose(preset.pathId, 1.5, preset);
    const a = new Uint8Array(width * height);
    const b = new Uint8Array(width * height);
    const c = new Uint8Array(width * height);

    renderFrame(scene, [pose], { width, height, hfovDeg: preset.hfovDeg, seed: 123 }, a);
    renderFrame(scene, [pose], { width, height, hfovDeg: preset.hfovDeg, seed: 123 }, b);
    renderFrame(scene, [pose], { width, height, hfovDeg: preset.hfovDeg, seed: 999 }, c);

    assert.equal(Buffer.compare(a, b), 0, `non-deterministic render for preset ${id}`);
    assert.notEqual(Buffer.compare(a, c), 0, `seed change should alter noisy render for preset ${id}`);
  }
});

test('performance budgets: 720p 12in view < 120 ms and 4x4 full-wall < 250 ms', () => {
  const ctx = createCpuRenderContext();

  // 1) 720p at 12 in (with 5-subframe shutter blur, representative of live sweep)
  const scene12 = createSceneForPreset('a53-8-720');
  const w720 = 1280, h720 = 720;
  const out720 = new Uint8Array(w720 * h720);
  const poses12 = [];
  for (let k = 0; k < 5; k++) {
    const frac = k / 4 - 0.5;
    poses12.push(sampleCameraPose('snake-h', 1.2 + frac * 0.002, {
      distanceIn: 12,
      speedInPerSec: 18,
      jitter: 0.15,
    }));
  }
  // 2 warm-up renders + 5 timed renders (median)
  for (let i = 0; i < 2; i++) {
    renderFrame(scene12, poses12, { width: w720, height: h720, hfovDeg: 70.7, seed: i, ctx }, out720);
  }
  const times720 = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    renderFrame(scene12, poses12, { width: w720, height: h720, hfovDeg: 70.7, seed: 100 + i, ctx }, out720);
    times720.push(performance.now() - t0);
  }
  times720.sort((a, b) => a - b);
  const med720 = times720[times720.length >> 1];

  // 2) Full 4x4 wall at 1920x1080 (52 in): 2 warm-up renders + 5 timed renders (median)
  const sceneFull = createSceneForPreset('full-wall');
  const presetFull = getPreset('full-wall');
  const wFull = presetFull.width, hFull = presetFull.height;
  const outFull = new Uint8Array(wFull * hFull);
  const poseFull = sampleCameraPose(presetFull.pathId, 0, presetFull);
  for (let i = 0; i < 2; i++) {
    renderFrame(sceneFull, [poseFull], { width: wFull, height: hFull, hfovDeg: presetFull.hfovDeg, seed: i, ctx }, outFull);
  }
  const timesFull = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    renderFrame(sceneFull, [poseFull], { width: wFull, height: hFull, hfovDeg: presetFull.hfovDeg, seed: 200 + i, ctx }, outFull);
    timesFull.push(performance.now() - t0);
  }
  timesFull.sort((a, b) => a - b);
  const medFull = timesFull[timesFull.length >> 1];

  console.log(`    perf: 720p@12in(5-sub)=${med720.toFixed(2)}ms (<120ms), full-wall 1080p=${medFull.toFixed(2)}ms (<250ms)`);
  assert.ok(med720 < 120, `720p 12in render too slow: ${med720.toFixed(2)} ms (limit 120 ms)`);
  assert.ok(medFull < 250, `full-wall 1080p render too slow: ${medFull.toFixed(2)} ms (limit 250 ms)`);
});

test('hot loop executes with near-zero heap allocation per frame', () => {
  const scene = createSceneForPreset('a53-8-720');
  const width = 640;
  const height = 360;
  const out = new Uint8Array(width * height);
  const ctx = createCpuRenderContext();
  const pose = sampleCameraPose('snake-h', 1.0, { distanceIn: 10, speedInPerSec: 18, jitter: 0.15 });
  const poses = [pose];
  const opts = { width, height, hfovDeg: 70.7, seed: 1, ctx };

  // Warm up scene cache and JIT
  for (let i = 0; i < 5; i++) {
    opts.seed = i;
    renderFrame(scene, poses, opts, out);
  }

  if (typeof global.gc === 'function') {
    global.gc();
    const h0 = process.memoryUsage().heapUsed;
    const iters = 30;
    for (let i = 0; i < iters; i++) {
      opts.seed = 100 + i;
      renderFrame(scene, poses, opts, out);
    }
    global.gc();
    const h1 = process.memoryUsage().heapUsed;
    const bytesPerFrame = Math.max(0, (h1 - h0) / iters);
    console.log(`    heap: ${bytesPerFrame.toFixed(1)} B/frame over ${iters} frames`);
    assert.ok(bytesPerFrame < 128, `hot-loop heap delta too high: ${bytesPerFrame.toFixed(1)} B/frame`);
  } else {
    // Even without --expose-gc, verify output buffer is reused in place
    const ret = renderFrame(scene, poses, opts, out);
    assert.strictEqual(ret, out);
  }
});

console.log(`All ${passed} R5 cpu-render tests passed.`);
