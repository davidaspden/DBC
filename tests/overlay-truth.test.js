/**
 * R8 — overlay ground-truth check. Renders the sim label at known poses, projects the true label
 * corners, and compares them with (a) the product frame->screen mapper and (b) the worker's
 * detection geometry, across frame sizes, display boxes (cover/contain, DPR) and crop-at-source.
 */
import assert from 'node:assert/strict';
import { createSceneForPreset } from '../src/sim/presets.js';
import { createFrameToScreenMapper } from '../src/ui/frame-map.js';
import {
  OVERLAY_MAPPING_TOL_CSS_PX,
  OVERLAY_FRAME_SIZES,
  OVERLAY_DISPLAYS,
  OVERLAY_POSES,
  hfovForLongAxisDeg,
  aimPose,
  projectLabelTruth,
  displayRect,
  trueDisplayMap,
  legacyStretchMap,
  legacyAssumedSizeMap,
  scoreDisplayMapping,
  runOverlayMatrix,
  evaluateOverlayCase,
} from '../src/sim/overlay-truth.js';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const scene = createSceneForPreset('fc-8-3p5');

test('hfovForLongAxisDeg keeps the long-axis FOV for portrait and landscape frames', () => {
  assert.equal(hfovForLongAxisDeg(1920, 1080), 70.7);
  const portrait = hfovForLongAxisDeg(1080, 1920);
  assert.ok(portrait < 45 && portrait > 35, `portrait width fov ${portrait}`);
  // Same focal length in pixels either way.
  const fLand = 1920 / 2 / Math.tan((70.7 * Math.PI) / 360);
  const fPort = 1080 / 2 / Math.tan((portrait * Math.PI) / 360);
  assert.ok(Math.abs(fLand - fPort) < 1e-6);
});

test('truth projection: head-on label is centred, upright and sized from the pinhole model', () => {
  const cell = scene.cells[5];
  const camera = { width: 1080, height: 1920, hfovDeg: hfovForLongAxisDeg(1080, 1920) };
  const pose = aimPose(cell.cx + (cell.labelOffsetXIn || 0), cell.cy + (cell.labelOffsetYIn || 0), 8);
  const t = projectLabelTruth(pose, scene, 5, camera);
  assert.ok(Math.abs(t.centre.x - 539.5) < 1 && Math.abs(t.centre.y - 959.5) < 1, JSON.stringify(t.centre));
  const f = 1920 / 2 / Math.tan((70.7 * Math.PI) / 360);
  const expectedLong = (f * 3.5) / 8; // 3.5 in label height at 8 in
  assert.ok(Math.abs(t.labelLongEdgePx - expectedLong) < 1, `${t.labelLongEdgePx} vs ${expectedLong}`);
  assert.ok(t.fullyInside && !t.behind);
  assert.ok(Math.abs(t.thetaDeg - 90) < 0.1);
});

test('independent display model matches CSS object-fit rules', () => {
  const cover = displayRect(1080, 1920, 412, 776, 'cover');
  const contain = displayRect(1080, 1920, 412, 776, 'contain');
  assert.ok(cover.w >= 412 - 1e-9 && cover.h >= 776 - 1e-9);
  assert.ok(contain.w <= 412 + 1e-9 && contain.h <= 776 + 1e-9);
  const c = trueDisplayMap(540, 960, 1080, 1920, 412, 776, 'cover');
  assert.ok(Math.abs(c.x - 206) < 1e-9 && Math.abs(c.y - 388) < 1e-9);
});

test('product mapper (overlayAlign path) agrees with the independent model for every frame x display', () => {
  for (const fs of OVERLAY_FRAME_SIZES) {
    for (const d of OVERLAY_DISPLAYS) {
      const m = createFrameToScreenMapper({ frameW: fs.width, frameH: fs.height, cssW: d.cssW, cssH: d.cssH, fit: d.fit });
      for (const [fx, fy] of [[0, 0], [fs.width, fs.height], [fs.width * 0.3, fs.height * 0.8], [fs.width / 2, fs.height / 2]]) {
        const a = m.mapFrameToScreen(fx, fy);
        const b = trueDisplayMap(fx, fy, fs.width, fs.height, d.cssW, d.cssH, d.fit);
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) <= OVERLAY_MAPPING_TOL_CSS_PX, `${fs.id} ${d.id}`);
      }
    }
  }
});

test('negative control: a mapper that assumes the wrong frame size is caught (>3 CSS px)', () => {
  const frame = { width: 1080, height: 1920 };
  const d = OVERLAY_DISPLAYS[0];
  const a = legacyAssumedSizeMap(540, 960, d.cssW, d.cssH, d.fit);
  const b = trueDisplayMap(540, 960, frame.width, frame.height, d.cssW, d.cssH, d.fit);
  assert.ok(Math.hypot(a.x - b.x, a.y - b.y) > 100);
  const s = legacyStretchMap(270, 480, frame.width, frame.height, 640, 480);
  const tr = trueDisplayMap(270, 480, frame.width, frame.height, 640, 480, "cover");
  assert.ok(Math.hypot(s.x - tr.x, s.y - tr.y) > OVERLAY_MAPPING_TOL_CSS_PX);
  // scoreDisplayMapping surfaces the same defects as numbers.
  const cell = scene.cells[5];
  const cam = { width: 1080, height: 1920, hfovDeg: hfovForLongAxisDeg(1080, 1920) };
  const truth = projectLabelTruth(aimPose(cell.cx + (cell.labelOffsetXIn || 0), cell.cy + (cell.labelOffsetYIn || 0), 8), scene, 5, cam);
  const sc = scoreDisplayMapping(truth, frame, { cssW: 640, cssH: 480, fit: 'cover' });
  assert.ok(sc.mappingErrCssPx <= OVERLAY_MAPPING_TOL_CSS_PX);
  assert.ok(sc.legacyStretchErrCssPx > OVERLAY_MAPPING_TOL_CSS_PX);
  assert.ok(sc.legacyAssumedSizeErrCssPx > OVERLAY_MAPPING_TOL_CSS_PX);
});

const matrix = runOverlayMatrix({ scene });
const S = matrix.summary;
console.log(`  matrix: ${JSON.stringify(S)}`);

test('matrix covers 4 frame sizes x 3 poses x {full, crop} and scores every case', () => {
  assert.equal(S.cases, OVERLAY_FRAME_SIZES.length * OVERLAY_POSES.length * 2);
  assert.equal(S.skipped, 0, 'every label must be fully inside its frame');
  assert.equal(S.undecoded, 0, 'worker must decode every case');
});

test('ACCEPTANCE: overlayAlign mapping error <= 3 CSS px in every case and display (full + crop-at-source)', () => {
  assert.ok(S.maxMappingErrCssPx <= OVERLAY_MAPPING_TOL_CSS_PX, `max ${S.maxMappingErrCssPx}`);
  for (const r of matrix.rows) {
    for (const d of r.displays) {
      assert.ok(d.mappingErrCssPx <= OVERLAY_MAPPING_TOL_CSS_PX, `${r.frame} ${r.pose} crop=${r.crop} ${d.id}`);
    }
  }
});

test('BASELINE (overlayAlign off, modelled defects): legacy mappings exceed 3 CSS px, recorded as the documented offset', () => {
  assert.ok(S.maxLegacyStretchErrCssPx > 100, `stretch max ${S.maxLegacyStretchErrCssPx}`);
  assert.ok(S.maxLegacyAssumedSizeErrCssPx > 300, `assumed-size max ${S.maxLegacyAssumedSizeErrCssPx}`);
  // Every aspect-mismatched case is wrong under both legacy models.
  const bad = matrix.rows.filter((r) => r.ok).flatMap((r) => r.displays).filter((d) => d.legacyAssumedSizeErrCssPx > OVERLAY_MAPPING_TOL_CSS_PX);
  assert.ok(bad.length > matrix.rows.length * 3);
});

test('detection localisation regression bounds (worker ROI centre vs truth, frame px)', () => {
  // Current measured worst: ~25% of label height (see docs/overlay-truth.md). The bound guards
  // against it getting worse; tighten it when the detector's anchor is fixed.
  assert.ok(S.maxCentreErrFracLabel <= 0.3, `centre err ${S.maxCentreErrFracLabel}`);
  assert.ok(S.maxThetaErrDeg <= 6, `theta err ${S.maxThetaErrDeg}`);
  assert.ok(S.minRoiIouBars >= 0.15, `roi iou ${S.minRoiIouBars}`);
  for (const r of matrix.rows) {
    if (r.pose === 'head-on-8in' && !r.crop) assert.ok(r.detection.thetaErrDeg < 1, `${r.frame} head-on theta`);
  }
});

test('crop-at-source: detection is mapped back into full-frame px (cropX/cropY applied)', () => {
  const cell = scene.cells[5];
  const camera = { width: 1080, height: 1920, hfovDeg: hfovForLongAxisDeg(1080, 1920) };
  const pose = aimPose(cell.cx + (cell.labelOffsetXIn || 0), cell.cy + (cell.labelOffsetYIn || 0), 8);
  const full = evaluateOverlayCase({ scene, cellIndex: 5, pose, camera, displays: OVERLAY_DISPLAYS, crop: false });
  const crop = evaluateOverlayCase({ scene, cellIndex: 5, pose, camera, displays: OVERLAY_DISPLAYS, crop: true });
  assert.ok(crop.cropRect && crop.cropRect.x > 0 && crop.cropRect.y > 0, 'crop rect is inset');
  // If the crop offset were dropped the error would be roughly the crop origin (>=100 px).
  assert.ok(crop.detection.centreErrPx < 0.3 * full.truth.labelLongEdgePx);
  assert.ok(Math.abs(crop.detection.centreErrPx - full.detection.centreErrPx) < 0.2 * full.truth.labelLongEdgePx);
});

test('scenes with defects are not scored (truth not modelled)', () => {
  const s2 = { ...scene, defects: [{ type: 'glare' }] };
  assert.equal(projectLabelTruth(aimPose(0, 0, 8), s2, 5, { width: 100, height: 100, hfovDeg: 60 }), null);
});

console.log(`All ${passed} overlay ground-truth tests passed.`);
