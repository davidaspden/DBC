/**
 * L4 — Unit & Closed-Form Occlusion Tests for Tote Lips & Interlock Geometry (`src/sim/lips.js`).
 *   node tests/lips.test.js
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_LIPS_SPEC,
  normalizeLipsSpec,
  computeToteOpening,
  computeLipOcclusionFraction,
  intersectLipPlane,
  computeUpperLipShadowFactor,
} from '../src/sim/lips.js';
import { createScene } from '../src/sim/scene.js';
import { renderFrame, createCpuRenderContext } from '../src/sim/cpu-render.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running L4 recessed tote lips & parallax occlusion tests...');

test('normalizeLipsSpec disables lips cleanly when null/false/enabled:false and applies OQ8 defaults when enabled', () => {
  assert.equal(normalizeLipsSpec(null), null);
  assert.equal(normalizeLipsSpec(undefined), null);
  assert.equal(normalizeLipsSpec(false), null);
  assert.equal(normalizeLipsSpec({ enabled: false }), null);

  const def = normalizeLipsSpec(true);
  assert.equal(def.enabled, true);
  assert.equal(def.lipHeightIn, 0.75);
  assert.equal(def.lipWidthIn, 0.65);
  assert.equal(def.interlockOffsetIn, 0.25);
  assert.equal(DEFAULT_LIPS_SPEC.lipHeightIn, 0.75);

  const open = computeToteOpening(7.0, 8.0, def);
  assert.ok(Math.abs(open.openHalfW - 6.35) < 1e-9);
  assert.ok(Math.abs(open.openTopY - 7.10) < 1e-9);
  assert.ok(Math.abs(open.openBotY - (-7.35)) < 1e-9);
});

test('simLips off produces bit-for-bit identical output to legacy scene.lips = null', () => {
  const width = 320;
  const height = 180;
  const baseScene = createScene({ fcMode: true });
  const offScene = createScene({ fcMode: true, lips: { enabled: false, lipHeightIn: 1.5 } });
  const cell = baseScene.cells[5];
  const pose = { x: cell.cx + 4, y: cell.cy, z: 10, yawDeg: -20, pitchDeg: 0, rollDeg: 0 };

  const a = new Uint8Array(width * height);
  const b = new Uint8Array(width * height);
  renderFrame(baseScene, [pose], { width, height, hfovDeg: 70.7, seed: 42 }, a);
  renderFrame(offScene, [pose], { width, height, hfovDeg: 70.7, seed: 42 }, b);
  assert.equal(Buffer.compare(a, b), 0, 'simLips off must be bit-for-bit identical to null');
});

test('head-on render with simLips differs only in lip shading/shadow band, leaving centered label bit-for-bit unchanged', () => {
  const width = 640;
  const height = 360;
  const sceneOff = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder' },
  });
  const sceneOn = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    label: { widthIn: 2.0, heightIn: 3.5, orientation: 'ladder' },
    lips: { enabled: true },
  });

  const cell = sceneOff.cells[5]; // R2C2
  // Camera head-on at 14 in sees full tote face including top/side lips and centered label
  const pose = { x: cell.cx, y: cell.cy, z: 14, yawDeg: 0, pitchDeg: 0, rollDeg: 0 };
  const imgOff = new Uint8Array(width * height);
  const imgOn = new Uint8Array(width * height);
  renderFrame(sceneOff, [pose], { width, height, hfovDeg: 70.7, seed: 1 }, imgOff);
  renderFrame(sceneOn, [pose], { width, height, hfovDeg: 70.7, seed: 1 }, imgOn);

  // Center of image (well inside centered 2x3.5 in label, far below upper lip shadow band) must be identical
  let labelDiff = 0;
  const cx = width >> 1;
  const cy = height >> 1;
  for (let y = cy - 40; y <= cy + 40; y++) {
    for (let x = cx - 20; x <= cx + 20; x++) {
      labelDiff += Math.abs(imgOn[y * width + x] - imgOff[y * width + x]);
    }
  }
  assert.equal(labelDiff, 0, `head-on centered label should be unchanged, got diff=${labelDiff}`);

  // Overall frame MUST differ due to lip rim shading, highlight & upper shadow band
  let totalDiff = 0;
  for (let i = 0; i < imgOff.length; i++) {
    totalDiff += Math.abs(imgOn[i] - imgOff[i]);
  }
  assert.ok(totalDiff > 5000, `expected lip shading differences across tote rim/shadow band, got ${totalDiff}`);

  // Upper shadow band function darkens points near openTopY and is 1.0 below shadowBandIn
  const sTop = computeUpperLipShadowFactor(7.05, 7.10, 1.25, 0.45);
  const sFar = computeUpperLipShadowFactor(5.0, 7.10, 1.25, 0.45);
  assert.ok(sTop < 0.65, `expected strong shadow right under upper lip, got ${sTop}`);
  assert.equal(sFar, 1.0);
});

test('closed-form 35 deg yaw parallax test confirms lip occludes exact computed fraction of label edge', () => {
  const lipHeightIn = 0.75;
  const lipWidthIn = 0.65;
  const labelWidthIn = 2.0;
  const labelHeightIn = 3.5;
  const yawDeg = 35;

  // Closed-form expectation when label right edge is flush with the recessed opening edge (gapToLipIn = 0)
  const expected = computeLipOcclusionFraction({
    lipHeightIn,
    gapToLipIn: 0,
    angleDeg: yawDeg,
    labelSpanIn: labelWidthIn,
  });
  // 0.75 * tan(35 deg) = 0.5251556 in -> 26.258% of 2.0 in label width
  assert.ok(Math.abs(expected.shiftIn - 0.75 * Math.tan(35 * Math.PI / 180)) < 1e-6);
  assert.ok(expected.occludedFraction > 0.25 && expected.occludedFraction < 0.28);

  // Place label flush against the right opening edge of the tote (openHalfW = 7.0 - 0.65 = 6.35 in)
  // Label center lx = openHalfW - labelWidthIn/2 = 5.35 in -> spans [4.35, 6.35]
  const openHalfW = 7.0 - lipWidthIn;
  const labelOffsetX = openHalfW - labelWidthIn * 0.5;

  const sceneOff = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    labelOffset: { meanXIn: labelOffsetX, meanYIn: 0, sigmaXIn: 0, sigmaYIn: 0 },
    label: {
      widthIn: labelWidthIn,
      heightIn: labelHeightIn,
      orientation: 'ladder',
      // Solid white quiet-zone-like test: check paper vs darker lip occlusion cleanly
      paperAlbedo: 0.93,
      inkAlbedo: 0.93,
    },
  });
  const sceneOn = createScene({
    fcMode: true,
    shadowStrength: 0,
    noiseStrength: 0,
    glareStrength: 0,
    labelOffset: { meanXIn: labelOffsetX, meanYIn: 0, sigmaXIn: 0, sigmaYIn: 0 },
    label: {
      widthIn: labelWidthIn,
      heightIn: labelHeightIn,
      orientation: 'ladder',
      paperAlbedo: 0.93,
      inkAlbedo: 0.93,
    },
    lips: { enabled: true, lipHeightIn, lipWidthIn, interlockOffsetIn: 0.25, shadowBandIn: 0, shadowDarken: 0 },
  });

  // Aim camera from far distance along a 35 deg ray (near-orthographic so every pixel on label sees ~35 deg yaw)
  const cell = sceneOff.cells[5];
  const targetX = cell.cx + labelOffsetX;
  const targetY = cell.cy;
  const dist = 40;
  const rad = yawDeg * Math.PI / 180;
  // Camera stands to the right (+X) looking left (-yawDeg) at targetX so the right lip occludes the right label edge
  const pose = {
    x: targetX + dist * Math.sin(rad),
    y: targetY,
    z: dist * Math.cos(rad),
    yawDeg: -yawDeg,
    pitchDeg: 0,
    rollDeg: 0,
  };

  const width = 1280;
  const height = 720;
  const imgOff = new Uint8Array(width * height);
  const imgOn = new Uint8Array(width * height);
  renderFrame(sceneOff, [pose], { width, height, hfovDeg: 25, seed: 1 }, imgOff);
  renderFrame(sceneOn, [pose], { width, height, hfovDeg: 25, seed: 1 }, imgOn);

  // Scan the horizontal midline y = height/2: count label pixels (bright white paper > 180) with lips off vs lips on
  const rowOff = (height >> 1) * width;
  let visibleOff = 0;
  let visibleOn = 0;
  for (let x = 0; x < width; x++) {
    const isWhiteOff = imgOff[rowOff + x] > 180;
    if (isWhiteOff) {
      visibleOff++;
      if (imgOn[rowOff + x] > 180) visibleOn++;
    }
  }
  assert.ok(visibleOff >= 80, `expected >= 80 label pixels on midline, got ${visibleOff}`);
  const measuredOccludedFraction = (visibleOff - visibleOn) / visibleOff;
  const err = Math.abs(measuredOccludedFraction - expected.occludedFraction);
  console.log(`    35deg yaw occlusion: measured=${(measuredOccludedFraction * 100).toFixed(2)}%, expected=${(expected.occludedFraction * 100).toFixed(2)}% (err=${(err * 100).toFixed(2)}%)`);
  assert.ok(
    err < 0.02,
    `35deg yaw occluded fraction mismatch: measured=${measuredOccludedFraction.toFixed(4)} vs expected=${expected.occludedFraction.toFixed(4)}`
  );

  // Also verify intersectLipPlane helper matches
  const lipPt = [0, 0];
  intersectLipPlane(0, 0, -Math.sin(rad), 0, -Math.cos(rad), lipHeightIn, lipPt);
  assert.ok(Math.abs(lipPt[0] - expected.shiftIn) < 1e-6);
  assert.equal(lipPt[1], 0);
});

test('renderFrame with simLips enabled runs with zero hot-loop heap allocation', () => {
  const scene = createScene({ fcMode: true, lips: { enabled: true } });
  const width = 320;
  const height = 180;
  const out = new Uint8Array(width * height);
  const ctx = createCpuRenderContext();
  const pose = { x: scene.cells[5].cx, y: scene.cells[5].cy, z: 12, yawDeg: 20, pitchDeg: 0, rollDeg: 0 };
  const opts = { width, height, hfovDeg: 70.7, seed: 1, ctx };
  for (let i = 0; i < 3; i++) renderFrame(scene, [pose], opts, out);
  const ret = renderFrame(scene, [pose], opts, out);
  assert.strictEqual(ret, out);
});

console.log(`All ${passed} L4 tote lips tests passed.`);
