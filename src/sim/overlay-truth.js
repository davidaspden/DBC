/**
 * R8 — Overlay Ground-Truth Check (`src/sim/overlay-truth.js`).
 *
 * The sim knows exactly where every label is in the camera image (it projects the 3D label
 * corners through the same pinhole matrices as `src/sim/cpu-render.js`). This module compares
 * that ground truth with what the app would draw:
 *
 *   truth label corners (frame px)
 *        │                                    worker detection (frame px)
 *        ▼                                           ▼
 *   independent object-fit model            product mapper `createFrameToScreenMapper`
 *   (`displayRect`, written from the CSS     (`src/ui/frame-map.js`, the `overlayAlign` path)
 *    rules, NOT from frame-map.js)
 *        │                                           │
 *        └──────────── CSS px error ◄────────────────┘
 *
 * Three error families are reported per case and display:
 *   1. `mapping`      product mapper vs true display mapping, on the TRUE label corners (pure
 *                     coordinate-mapping error; the `overlayAlign` acceptance is <= 3 CSS px).
 *   2. `legacy*`      MODELS of the pre-fix defects (see `legacyStretchMap`, `legacyAssumedSizeMap`),
 *                     recorded as the documented "overlayAlign off" baseline so the fix is measured.
 *   3. `detection`    worker ROI centre / box vs truth in frame px and as a fraction of label height,
 *                     plus the end-to-end overlay error in CSS px (detection mapped by the product
 *                     mapper vs truth mapped by the true display model).
 *
 * Pure functions, no DOM, no flags. Test/tool code only (never imported by the app or the worker).
 */

import { mat4Perspective, mat4CameraView, mat4Multiply } from './paths.js';
import { projectWallPointToPixel, renderFrame, createCpuRenderContext } from './cpu-render.js';
import { DEFAULT_LABEL_SPEC, encodeCode128B } from './label.js';
import { createFrameToScreenMapper } from '../ui/frame-map.js';
import { computeEvenCropRect, offsetDetectionByCrop } from '../capture/crop.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../worker/scanner.worker.js';

const DEG2RAD = Math.PI / 180;

/** Acceptance bound (CSS px) for the product mapper with `overlayAlign` on. */
export const OVERLAY_MAPPING_TOL_CSS_PX = 3;

/**
 * Horizontal FOV (degrees) of the sim's pinhole camera when the *long* image axis spans
 * `longAxisHfovDeg` (the A53 main camera: about 70.7 deg along the long axis). The sim's
 * `hfovDeg` is always the FOV across the image WIDTH, so a portrait frame needs a smaller value.
 */
export function hfovForLongAxisDeg(width, height, longAxisHfovDeg = 70.7) {
  const halfTanLong = Math.tan(longAxisHfovDeg * 0.5 * DEG2RAD);
  const halfTanW = width >= height ? halfTanLong : halfTanLong * (width / height);
  return 2 * Math.atan(halfTanW) / DEG2RAD;
}

/**
 * Camera pose that looks at wall point `(wx, wy)` from distance `dz` with the given rotation, i.e. the
 * optical axis passes through the target (mirrors the forward vector of `mat4CameraView`).
 */
export function aimPose(wx, wy, dz, yawDeg = 0, pitchDeg = 0, rollDeg = 0) {
  const cy = Math.cos(yawDeg * DEG2RAD);
  const sy = Math.sin(yawDeg * DEG2RAD);
  const cp = Math.cos(pitchDeg * DEG2RAD);
  const sp = Math.sin(pitchDeg * DEG2RAD);
  const fx = sy * cp;
  const fy = sp;
  const fz = -cy * cp;
  const t = dz / -fz; // ray parameter reaching the wall plane z = 0
  return { x: wx - fx * t, y: wy - fy * t, z: dz, yawDeg, pitchDeg, rollDeg };
}

/** Builds the column-major MVP matrix the CPU renderer uses for `pose` (allocates; tool code). */
export function buildMvp(pose, width, height, hfovDeg) {
  const aspect = width / height;
  const halfTanH = Math.tan(hfovDeg * 0.5 * DEG2RAD);
  const halfTanV = halfTanH / aspect;
  const vfov = 2 * Math.atan(halfTanV);
  const proj = mat4Perspective(vfov, aspect, 0.5, 500.0);
  const view = mat4CameraView(pose);
  return mat4Multiply(proj, view, new Float32Array(16));
}

function bboxOf(pts) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

function projectRect(mvp, cx, cy, halfW, halfH, width, height, out) {
  // order: top-left, top-right, bottom-right, bottom-left (wall +Y is up)
  const xs = [cx - halfW, cx + halfW, cx + halfW, cx - halfW];
  const ys = [cy + halfH, cy + halfH, cy - halfH, cy - halfH];
  const tmp = new Float64Array(3);
  let behind = false;
  for (let i = 0; i < 4; i++) {
    projectWallPointToPixel(mvp, xs[i], ys[i], width, height, tmp, 0);
    if (tmp[2] !== 0) behind = true;
    out[i * 2] = tmp[0];
    out[i * 2 + 1] = tmp[1];
  }
  return behind;
}

/**
 * Projects one cell's label into the frame.
 *
 * Returns `null` when the scene uses L7 defects (their per-label tilt/offset are not modelled here)
 * so a caller can never silently compare against a wrong truth.
 *
 * @param {object} pose  `{x,y,z,yawDeg,pitchDeg,rollDeg}`
 * @param {object} scene `createScene()` / `createSceneForPreset()` result
 * @param {number} cellIndex
 * @param {{ width: number, height: number, hfovDeg: number }} camera
 */
export function projectLabelTruth(pose, scene, cellIndex, camera) {
  if (scene.defects) return null;
  const cell = scene.cells[cellIndex];
  const lbl = scene.label || DEFAULT_LABEL_SPEC;
  const widthIn = lbl.widthIn ?? DEFAULT_LABEL_SPEC.widthIn;
  const heightIn = lbl.heightIn ?? DEFAULT_LABEL_SPEC.heightIn;
  const sideMarginIn = lbl.sideMarginIn ?? DEFAULT_LABEL_SPEC.sideMarginIn;
  const quiet = lbl.quietModules ?? DEFAULT_LABEL_SPEC.quietModules;
  const isPicket = lbl.orientation === 'picket';
  const cx = cell.cx + (Number.isFinite(cell.labelOffsetXIn) ? cell.labelOffsetXIn : 0);
  const cy = cell.cy + (Number.isFinite(cell.labelOffsetYIn) ? cell.labelOffsetYIn : 0);

  const enc = encodeCode128B(cell.payload, quiet);
  const barsFrac = (enc.totalModules - 2 * quiet) / enc.totalModules;
  // Bar span across the stripes = label side minus the side margins; along the scan axis the
  // bars cover the module strip minus the quiet zones.
  const halfAcross = Math.max(0.05, (isPicket ? heightIn : widthIn) * 0.5 - sideMarginIn);
  const halfAlong = (isPicket ? widthIn : heightIn) * 0.5 * barsFrac;
  const barsHalfW = isPicket ? halfAlong : halfAcross;
  const barsHalfH = isPicket ? halfAcross : halfAlong;

  const mvp = buildMvp(pose, camera.width, camera.height, camera.hfovDeg);
  const paper = new Float64Array(8);
  const bars = new Float64Array(8);
  const behindA = projectRect(mvp, cx, cy, widthIn * 0.5, heightIn * 0.5, camera.width, camera.height, paper);
  const behindB = projectRect(mvp, cx, cy, barsHalfW, barsHalfH, camera.width, camera.height, bars);
  const c = new Float64Array(3);
  projectWallPointToPixel(mvp, cx, cy, camera.width, camera.height, c, 0);

  const pb = bboxOf(paper);
  const bb = bboxOf(bars);
  const inside = pb.minX >= 0 && pb.minY >= 0 && pb.maxX <= camera.width - 1 && pb.maxY <= camera.height - 1;
  // Image-space length of the label's long edge (used to normalise detection error)
  const edgeA = Math.hypot(paper[2] - paper[0], paper[3] - paper[1]); // top edge (width)
  const edgeB = Math.hypot(paper[6] - paper[0], paper[7] - paper[1]); // left edge (height)
  // Image-space direction of the scan axis (the label's long axis, top to bottom for a ladder), in
  // the worker's convention: 90 = image-vertical, 0 = image-horizontal, folded into [0, 180).
  const sx0 = paper[0];
  const sy0 = paper[1];
  const ex = isPicket ? paper[2] : paper[6];
  const ey = isPicket ? paper[3] : paper[7];
  let thetaDeg = Math.atan2(ey - sy0, ex - sx0) / DEG2RAD;
  thetaDeg = ((thetaDeg % 180) + 180) % 180;
  return {
    payload: cell.payload,
    cellIndex,
    thetaDeg,
    behind: behindA || behindB,
    fullyInside: inside,
    centre: { x: c[0], y: c[1] },
    paper: Array.from(paper),
    bars: Array.from(bars),
    paperBBox: pb,
    barsBBox: bb,
    labelLongEdgePx: Math.max(edgeA, edgeB),
  };
}

// ---------------------------------------------------------------------------------------------
// Display models
// ---------------------------------------------------------------------------------------------

/**
 * Where a browser paints a `frameW x frameH` image inside a `cssW x cssH` box for `object-fit`
 * `cover` or `contain`. Written from the CSS rules (aspect-ratio comparison), independent of
 * `src/ui/frame-map.js`, so the product mapper is checked against something it does not share code with.
 */
export function displayRect(frameW, frameH, cssW, cssH, fit = 'cover') {
  const frameAspect = frameW / frameH;
  const boxAspect = cssW / cssH;
  const fillsWidth = fit === 'cover' ? frameAspect < boxAspect : frameAspect > boxAspect;
  // fillsWidth: the image is scaled so its width equals the box width
  let w;
  let h;
  if (fillsWidth) {
    w = cssW;
    h = cssW / frameAspect;
  } else {
    h = cssH;
    w = cssH * frameAspect;
  }
  return { x: (cssW - w) / 2, y: (cssH - h) / 2, w, h };
}

/** Maps a frame point to CSS px the way the browser paints the media (independent model). */
export function trueDisplayMap(x, y, frameW, frameH, cssW, cssH, fit = 'cover') {
  const r = displayRect(frameW, frameH, cssW, cssH, fit);
  return { x: r.x + (x / frameW) * r.w, y: r.y + (y / frameH) * r.h };
}

/**
 * MODEL of the pre-fix array-page defect: the overlay canvas backing store is the frame size
 * (for example 1920x1080) but it is CSS-stretched to fill the display box, so the overlay is
 * scaled independently in X and Y while the video uses `object-fit: cover`.
 */
export function legacyStretchMap(x, y, frameW, frameH, cssW, cssH) {
  return { x: (x / frameW) * cssW, y: (y / frameH) * cssH };
}

/**
 * MODEL of the "assumed frame size" defect: the overlay maps with a stale/landscape size (default
 * 1920x1080) while the real frame is portrait (1080x1920, 1080x2400, ...).
 */
export function legacyAssumedSizeMap(x, y, cssW, cssH, fit = 'cover', assumedW = 1920, assumedH = 1080) {
  const m = createFrameToScreenMapper({ frameW: assumedW, frameH: assumedH, cssW, cssH, fit });
  return m.mapFrameToScreen(x, y);
}

function maxCornerError(corners, mapA, mapB) {
  let worst = 0;
  for (let i = 0; i < corners.length; i += 2) {
    const a = mapA(corners[i], corners[i + 1]);
    const b = mapB(corners[i], corners[i + 1]);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Coordinate-mapping errors (CSS px) of the product mapper and the two legacy models, measured on
 * the 4 paper corners and the centre of the TRUE label.
 */
export function scoreDisplayMapping(truth, frame, display) {
  const { width: fw, height: fh } = frame;
  const { cssW, cssH, fit } = display;
  const pts = truth.paper.concat([truth.centre.x, truth.centre.y]);
  const product = createFrameToScreenMapper({ frameW: fw, frameH: fh, cssW, cssH, fit });
  const trueMap = (x, y) => trueDisplayMap(x, y, fw, fh, cssW, cssH, fit);
  return {
    mappingErrCssPx: maxCornerError(pts, (x, y) => product.mapFrameToScreen(x, y), trueMap),
    legacyStretchErrCssPx: maxCornerError(pts, (x, y) => legacyStretchMap(x, y, fw, fh, cssW, cssH), trueMap),
    legacyAssumedSizeErrCssPx: maxCornerError(pts, (x, y) => legacyAssumedSizeMap(x, y, cssW, cssH, fit), trueMap),
  };
}

// ---------------------------------------------------------------------------------------------
// Detection scoring
// ---------------------------------------------------------------------------------------------

function iou(a, b) {
  const x0 = Math.max(a.minX, b.minX);
  const y0 = Math.max(a.minY, b.minY);
  const x1 = Math.min(a.maxX, b.maxX);
  const y1 = Math.min(a.maxY, b.maxY);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const ua = a.w * a.h + b.w * b.h - inter;
  return ua > 0 ? inter / ua : 0;
}

/** Scores one worker detection (already in FULL-frame px) against a truth projection. */
export function scoreDetection(det, truth) {
  const dx = det.roiCenterX - truth.centre.x;
  const dy = det.roiCenterY - truth.centre.y;
  const centreErrPx = Math.hypot(dx, dy);
  const roiBox = {
    minX: det.roiX,
    minY: det.roiY,
    maxX: det.roiX + det.roiW,
    maxY: det.roiY + det.roiH,
    w: det.roiW,
    h: det.roiH,
  };
  return {
    centreErrPx,
    centreErrFracLabel: truth.labelLongEdgePx > 0 ? centreErrPx / truth.labelLongEdgePx : Infinity,
    roiIouBars: iou(roiBox, truth.barsBBox),
    roiIouPaper: iou(roiBox, truth.paperBBox),
    dxPx: dx,
    dyPx: dy,
    thetaDeg: det.thetaDeg,
    thetaErrDeg: angleDiffDeg(det.thetaDeg, truth.thetaDeg),
  };
}

function angleDiffDeg(a, b) {
  let d = (a - b) % 180;
  if (d > 90) d -= 180;
  if (d < -90) d += 180;
  return Math.abs(d);
}

/**
 * Runs the real worker on one rendered frame (optionally source-cropped like C5 `cropAtSource`) and
 * returns the detection for `payload` mapped back to full-frame pixel space, or `null` if not decoded.
 */
export function detectInFrame(luma, width, height, { workerMask = 0, payload = null, crop = null } = {}) {
  let src = luma;
  let w = width;
  let h = height;
  let cropX = 0;
  let cropY = 0;
  if (crop) {
    cropX = crop.x;
    cropY = crop.y;
    w = crop.width;
    h = crop.height;
    src = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      src.set(luma.subarray((cropY + y) * width + cropX, (cropY + y) * width + cropX + w), y * w);
    }
  }
  const state = createPipelineState(w, h);
  state.flags = workerMask | 0;
  const result = createPipelineResult();
  // Decode a few repeats so multi-frame consensus state (as in the live loop) can settle.
  let dets = [];
  for (let k = 0; k < 3; k++) {
    processFrameMulti(src, w, h, state, result, false);
    dets = extractMultiDetections(state);
  }
  const hit = dets.find((d) => !payload || d.payload === payload);
  if (!hit) return null;
  return offsetDetectionByCrop(hit, cropX, cropY);
}

/**
 * Evaluates one render case against a list of displays.
 *
 * @param {{
 *   scene: object, cellIndex: number, pose: object,
 *   camera: { width: number, height: number, hfovDeg: number },
 *   displays: Array<{ id?: string, cssW: number, cssH: number, fit: 'cover'|'contain', dpr?: number }>,
 *   workerMask?: number, crop?: boolean | { widthFrac?: number, heightFrac?: number },
 *   seed?: number
 * }} c
 */
export function evaluateOverlayCase(c) {
  const { scene, cellIndex, pose, camera, displays } = c;
  const truth = projectLabelTruth(pose, scene, cellIndex, camera);
  if (!truth) return { ok: false, reason: 'defects-not-modelled' };
  if (truth.behind || !truth.fullyInside) return { ok: false, reason: 'label-not-fully-in-frame', truth };

  const luma = renderFrame(
    scene,
    pose,
    {
      width: camera.width,
      height: camera.height,
      hfovDeg: camera.hfovDeg,
      frameSeed: c.seed ?? 1,
      ctx: createCpuRenderContext(scene.cells.length),
    },
    null
  );

  let cropRect = null;
  if (c.crop) {
    const o = typeof c.crop === 'object' ? c.crop : {};
    cropRect = computeEvenCropRect(camera.width, camera.height, {
      widthFrac: o.widthFrac ?? 0.56,
      heightFrac: o.heightFrac ?? 0.66,
      cxFrac: 0.5,
      cyFrac: 0.5,
    });
  }
  const det = detectInFrame(luma, camera.width, camera.height, {
    workerMask: c.workerMask || 0,
    payload: truth.payload,
    crop: cropRect,
  });

  const frame = { width: camera.width, height: camera.height };
  const perDisplay = displays.map((d) => {
    const mapping = scoreDisplayMapping(truth, frame, d);
    let overlayErrCssPx = null;
    if (det) {
      const product = createFrameToScreenMapper({
        frameW: frame.width,
        frameH: frame.height,
        cssW: d.cssW,
        cssH: d.cssH,
        fit: d.fit,
      });
      const a = product.mapFrameToScreen(det.roiCenterX, det.roiCenterY);
      const b = trueDisplayMap(truth.centre.x, truth.centre.y, frame.width, frame.height, d.cssW, d.cssH, d.fit);
      overlayErrCssPx = Math.hypot(a.x - b.x, a.y - b.y);
    }
    return {
      id: d.id || `${d.cssW}x${d.cssH}-${d.fit}`,
      cssW: d.cssW,
      cssH: d.cssH,
      fit: d.fit,
      ...mapping,
      overlayErrCssPx,
    };
  });

  return {
    ok: true,
    payload: truth.payload,
    decoded: Boolean(det),
    cropRect,
    truth: { centre: truth.centre, labelLongEdgePx: truth.labelLongEdgePx },
    detection: det ? scoreDetection(det, truth) : null,
    displays: perDisplay,
  };
}

// ---------------------------------------------------------------------------------------------
// Canonical matrix
// ---------------------------------------------------------------------------------------------

/** Frame sizes real phones/streams report (diag cc0f88 and the 1080x2400 tote still). */
export const OVERLAY_FRAME_SIZES = Object.freeze([
  Object.freeze({ id: '720x1280', width: 720, height: 1280 }),
  Object.freeze({ id: '1080x1920', width: 1080, height: 1920 }),
  Object.freeze({ id: '1080x2400', width: 1080, height: 2400 }),
  Object.freeze({ id: '1920x1080', width: 1920, height: 1080 }),
]);

/** Display boxes: A53 portrait viewport (412x776 CSS px from cc0f88), its landscape swap, array-page 4:3 stage. */
export const OVERLAY_DISPLAYS = Object.freeze([
  Object.freeze({ id: 'phone-portrait-cover', cssW: 412, cssH: 776, fit: 'cover', dpr: 2.625 }),
  Object.freeze({ id: 'phone-portrait-contain', cssW: 412, cssH: 776, fit: 'contain', dpr: 2.625 }),
  Object.freeze({ id: 'phone-landscape-cover', cssW: 776, cssH: 412, fit: 'cover', dpr: 2.625 }),
  Object.freeze({ id: 'stage-4x3-cover', cssW: 640, cssH: 480, fit: 'cover', dpr: 1 }),
  Object.freeze({ id: 'stage-4x3-contain', cssW: 640, cssH: 480, fit: 'contain', dpr: 1 }),
]);

/** Poses: the camera aims at the label centre from `dz` inches (see `aimPose`). */
export const OVERLAY_POSES = Object.freeze([
  Object.freeze({ id: 'head-on-8in', dz: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 0 }),
  Object.freeze({ id: 'oblique-9in', dz: 9, yawDeg: 18, pitchDeg: -8, rollDeg: 8 }),
  Object.freeze({ id: 'rolled-8in', dz: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 25 }),
]);

/**
 * Runs the canonical matrix: frame sizes x poses x (full frame | crop-at-source) for one preset
 * cell, every display. Returns flat rows plus a summary (worst values per family).
 *
 * @param {{ scene: object, cellIndex?: number, longAxisHfovDeg?: number, frameSizes?: any[],
 *           poses?: any[], displays?: any[], crops?: boolean[], workerMask?: number }} o
 */
export function runOverlayMatrix(o) {
  const scene = o.scene;
  const cellIndex = o.cellIndex ?? 5;
  const cell = scene.cells[cellIndex];
  const rows = [];
  for (const fs of o.frameSizes || OVERLAY_FRAME_SIZES) {
    for (const p of o.poses || OVERLAY_POSES) {
      for (const crop of o.crops || [false, true]) {
        const camera = {
          width: fs.width,
          height: fs.height,
          hfovDeg: hfovForLongAxisDeg(fs.width, fs.height, o.longAxisHfovDeg ?? 70.7),
        };
        const pose = aimPose(
          cell.cx + (cell.labelOffsetXIn || 0),
          cell.cy + (cell.labelOffsetYIn || 0),
          p.dz,
          p.yawDeg,
          p.pitchDeg,
          p.rollDeg
        );
        const r = evaluateOverlayCase({
          scene,
          cellIndex,
          pose,
          camera,
          displays: o.displays || OVERLAY_DISPLAYS,
          crop,
          workerMask: o.workerMask || 0,
        });
        rows.push({ frame: fs.id, pose: p.id, crop: Boolean(crop), ...r });
      }
    }
  }
  const ok = rows.filter((r) => r.ok);
  const maxOf = (f) => ok.reduce((m, r) => Math.max(m, ...r.displays.map(f)), 0);
  const det = ok.filter((r) => r.detection);
  return {
    rows,
    summary: {
      cases: rows.length,
      scored: ok.length,
      skipped: rows.length - ok.length,
      undecoded: ok.length - det.length,
      maxMappingErrCssPx: maxOf((d) => d.mappingErrCssPx),
      minLegacyStretchErrCssPx: ok.length ? Math.min(...ok.flatMap((r) => r.displays.map((d) => d.legacyStretchErrCssPx))) : 0,
      maxLegacyStretchErrCssPx: maxOf((d) => d.legacyStretchErrCssPx),
      maxLegacyAssumedSizeErrCssPx: maxOf((d) => d.legacyAssumedSizeErrCssPx),
      maxOverlayErrCssPx: maxOf((d) => d.overlayErrCssPx || 0),
      maxCentreErrFracLabel: det.reduce((m, r) => Math.max(m, r.detection.centreErrFracLabel), 0),
      maxCentreErrPx: det.reduce((m, r) => Math.max(m, r.detection.centreErrPx), 0),
      minRoiIouBars: det.length ? Math.min(...det.map((r) => r.detection.roiIouBars)) : 0,
      maxThetaErrDeg: det.reduce((m, r) => Math.max(m, r.detection.thetaErrDeg), 0),
    },
  };
}
