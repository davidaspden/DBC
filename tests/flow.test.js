/**
 * Unit tests for W13 downsampled block-matching optical flow (`src/worker/flow.js`).
 */
import assert from 'node:assert/strict';
import { createFlowState, computeOpticalFlow, resetFlowState } from '../src/worker/flow.js';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

function makeTexturedFrame(w, h, shiftX = 0, shiftY = 0, noiseAmp = 0) {
  const out = new Uint8Array(w * h);
  let seed = 1337;
  for (let y = 0; y < h; y++) {
    const sy = y - shiftY;
    for (let x = 0; x < w; x++) {
      const sx = x - shiftX;
      // Rich 2D multi-frequency pattern (boxes + diagonal bars + checkerboard)
      const p1 = Math.sin(sx * 0.27) * Math.cos(sy * 0.23) * 55;
      const p2 = Math.sin((sx + sy) * 0.41) * 35;
      const p3 = (((Math.floor(sx / 11) + Math.floor(sy / 13)) & 1) ? 28 : -28);
      let n = 0;
      if (noiseAmp > 0) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        n = ((seed & 255) / 255 - 0.5) * 2 * noiseAmp;
      }
      let v = Math.round(128 + p1 + p2 + p3 + n);
      if (v < 0) v = 0;
      if (v > 255) v = 255;
      out[y * w + x] = v;
    }
  }
  return out;
}

test('W13 recovers synthetic sub-pixel translations within < 0.5 ds-px under noise', () => {
  const dsW = 480;
  const dsH = 270;
  const state = createFlowState(dsW, dsH);

  const cases = [
    [3.25, -2.5],
    [-4.5, 1.75],
    [0.0, -5.0],
    [4.0, 4.0],
  ];

  for (const [trueDxDs, trueDyDs] of cases) {
    resetFlowState(state);
    const f0 = makeTexturedFrame(dsW, dsH, 0, 0, 4);
    const f1 = makeTexturedFrame(dsW, dsH, trueDxDs, trueDyDs, 4);
    assert.equal(computeOpticalFlow(f0, dsW, dsH, 2, 0, 0, state, true), 0);
    const ok = computeOpticalFlow(f1, dsW, dsH, 2, 0, 0, state, true);
    assert.equal(ok, 1);
    const estDxDs = state.dxFullPx / 4;
    const estDyDs = state.dyFullPx / 4;
    assert.ok(
      Math.abs(estDxDs - trueDxDs) < 0.5,
      `dx err too high: got ${estDxDs.toFixed(2)}, expected ${trueDxDs}`
    );
    assert.ok(
      Math.abs(estDyDs - trueDyDs) < 0.5,
      `dy err too high: got ${estDyDs.toFixed(2)}, expected ${trueDyDs}`
    );
    assert.ok(state.conf > 0.25, `low conf ${state.conf}`);
    assert.ok(state.tilesAccepted >= 5, `too few tiles ${state.tilesAccepted}`);
  }
});

test('W13 rejects featureless blank frames with conf = 0', () => {
  const dsW = 320;
  const dsH = 180;
  const state = createFlowState(dsW, dsH);
  const blank = new Uint8Array(dsW * dsH).fill(128);
  computeOpticalFlow(blank, dsW, dsH, 2, 0, 0, state);
  const ok = computeOpticalFlow(blank, dsW, dsH, 2, 0, 0, state);
  assert.equal(ok, 0);
  assert.equal(state.conf, 0);
  assert.equal(state.tilesAccepted, 0);
});

test('W13 meets <= 3 ms median budget at 1080p/4x (480x270)', () => {
  const dsW = 480;
  const dsH = 270;
  const state = createFlowState(dsW, dsH);
  const f0 = makeTexturedFrame(dsW, dsH, 0, 0, 2);
  const f1 = makeTexturedFrame(dsW, dsH, 3, -2, 2);
  computeOpticalFlow(f0, dsW, dsH, 2, 0, 0, state);
  const times = [];
  for (let i = 0; i < 30; i++) {
    computeOpticalFlow((i & 1) ? f0 : f1, dsW, dsH, 2, 0, 0, state, true);
    times.push(state.tFlowMs);
  }
  times.sort((a, b) => a - b);
  const p50 = times[times.length >> 1];
  assert.ok(p50 <= 3.0, `W13 flow p50 ${p50.toFixed(2)}ms exceeded 3.0ms budget`);
});

console.log(`All ${passed} W13 optical flow tests passed.`);
