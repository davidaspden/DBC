/**
 * R6 — GL to CPU parity (`src/sim/gl-parity.js`).
 *
 * The CPU renderer (`cpu-render.js`) is what SimGate scores with; the WebGL renderer
 * (`webgl-wall.js`) is what David looks at in `sim.html`. This module holds everything both halves
 * share: the fixed list of parity cases (preset, pose, frame size), the render options (noise off, glare
 * off), the comparison rules and the PGM codec. Browser-safe (the page `tools/gl-parity.html` and the
 * Node test import it).
 *
 * Acceptance (Master Plan 3, R6): mean absolute luma difference <= 6/255 inside label rectangles,
 * <= 10/255 elsewhere (noise off), and decode parity (same payload set) on every case.
 */

import { createSceneForPreset } from './presets.js';
import { aimPose, hfovForLongAxisDeg, projectLabelTruth } from './overlay-truth.js';
import { createWallCells } from './paths.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../worker/scanner.worker.js';

export const PARITY_FORMAT = 'dbc-gl-parity';
export const PARITY_VERSION = 1;
export const INSIDE_LABEL_TOL = 6; // mean abs luma (0..255) inside label rectangles
export const OUTSIDE_LABEL_TOL = 10; // mean abs luma elsewhere

const SIZE_SMALL = { width: 640, height: 360 };
const SIZE_TELE = { width: 1280, height: 720 };

/**
 * Six fixed cases: legacy 2x6 in and FC 2x3.5 in labels, head-on / oblique / rolled and one stand-back
 * tele view. All aim at wall cell 5 (second row, second column) through `aimPose`.
 */
export const PARITY_CASES = Object.freeze([
  { id: 'legacy-head-on-8in', presetId: 'a53-8-720', cellIndex: 5, dz: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 0, ...SIZE_SMALL, longAxisHfovDeg: 70.7 },
  { id: 'legacy-oblique-9in', presetId: 'a53-8-720', cellIndex: 5, dz: 9, yawDeg: 18, pitchDeg: -8, rollDeg: 8, ...SIZE_SMALL, longAxisHfovDeg: 70.7 },
  { id: 'legacy-rolled-8in', presetId: 'a53-8-720', cellIndex: 5, dz: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 25, ...SIZE_SMALL, longAxisHfovDeg: 70.7 },
  { id: 'fc-head-on-8in', presetId: 'fc-8-3p5', cellIndex: 5, dz: 8, yawDeg: 0, pitchDeg: 0, rollDeg: 0, ...SIZE_SMALL, longAxisHfovDeg: 70.7 },
  { id: 'fc-oblique-7in', presetId: 'fc-8-3p5', cellIndex: 5, dz: 7, yawDeg: 10, pitchDeg: -3, rollDeg: 4, ...SIZE_SMALL, longAxisHfovDeg: 70.7 },
  { id: 'legacy-tele-30in', presetId: 'tele-30', cellIndex: 5, dz: 30, yawDeg: 0, pitchDeg: 0, rollDeg: 0, ...SIZE_TELE, hfovDeg: 26 },
]);

/** Everything needed to render a case with either renderer. `fcMode` tells the GL page which cells to upload. */
export function buildParityCase(c) {
  const scene = createSceneForPreset(c.presetId);
  const cell = scene.cells[c.cellIndex];
  const pose = aimPose(
    cell.cx + (cell.labelOffsetXIn || 0),
    cell.cy + (cell.labelOffsetYIn || 0),
    c.dz,
    c.yawDeg,
    c.pitchDeg,
    c.rollDeg
  );
  const hfovDeg = c.hfovDeg ?? hfovForLongAxisDeg(c.width, c.height, c.longAxisHfovDeg);
  const fcMode = scene.label.heightIn < 5; // 2x3.5 FC label vs 2x6 legacy
  const opts = {
    width: c.width,
    height: c.height,
    hfovDeg,
    labelHeightIn: scene.label.heightIn,
    shadowStrength: 0.35,
    noiseStrength: 0, // noise off: both renderers seed noise differently
    glareStrength: 0,
    frameSeed: 0,
  };
  return { id: c.id, scene, pose, opts, fcMode, camera: { width: c.width, height: c.height, hfovDeg } };
}

/** The scene cells must equal what the GL page uploads (`createWallCells({ fcMode })`): checked by the test. */
export function glCellsFor(fcMode) {
  return createWallCells({ fcMode });
}

/** Pixel rectangles (axis-aligned, clipped) of every label that is in front of the camera. */
export function labelRects(built) {
  const rects = [];
  for (let i = 0; i < built.scene.cells.length; i++) {
    const t = projectLabelTruth(built.pose, built.scene, i, built.camera);
    if (!t || t.behind) continue;
    const b = t.paperBBox;
    const x0 = Math.max(0, Math.floor(b.minX));
    const y0 = Math.max(0, Math.floor(b.minY));
    const x1 = Math.min(built.camera.width - 1, Math.ceil(b.maxX));
    const y1 = Math.min(built.camera.height - 1, Math.ceil(b.maxY));
    if (x1 >= x0 && y1 >= y0) rects.push({ x0, y0, x1, y1, payload: t.payload });
  }
  return rects;
}

/**
 * Compares two luma frames. `inside` = pixels in any label rectangle, `outside` = the rest.
 * @returns {{ meanInside: number, meanOutside: number, maxAbs: number, nInside: number, nOutside: number }}
 */
export function compareFrames(a, b, width, height, rects) {
  const inside = new Uint8Array(width * height);
  for (const r of rects) {
    for (let y = r.y0; y <= r.y1; y++) inside.fill(1, y * width + r.x0, y * width + r.x1 + 1);
  }
  let sIn = 0;
  let sOut = 0;
  let nIn = 0;
  let nOut = 0;
  let maxAbs = 0;
  for (let i = 0; i < width * height; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > maxAbs) maxAbs = d;
    if (inside[i]) { sIn += d; nIn++; } else { sOut += d; nOut++; }
  }
  return { meanInside: nIn ? sIn / nIn : 0, meanOutside: nOut ? sOut / nOut : 0, maxAbs, nInside: nIn, nOutside: nOut };
}

/** Vertically flipped copy (the usual way a GL read-back goes wrong). */
export function flipVertical(luma, width, height) {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(luma.subarray(y * width, (y + 1) * width), (height - 1 - y) * width);
  return out;
}

/** Payloads the real worker decodes on a frame (3 repeats so consensus settles, like the live loop). */
export function decodeSet(luma, width, height, workerMask = 0) {
  const state = createPipelineState(width, height);
  state.flags = workerMask | 0;
  const result = createPipelineResult();
  let dets = [];
  for (let k = 0; k < 3; k++) {
    processFrameMulti(luma, width, height, state, result, false);
    dets = extractMultiDetections(state);
  }
  return [...new Set(dets.map((d) => d.payload))].sort();
}

/**
 * Full verdict for one case. `other` is the GL frame (or any frame to be judged against `cpu`).
 * Also reports whether a vertical flip would have fixed it (`flippedWouldPass`) to make a wrong read-back obvious.
 */
export function judgeCase(built, cpu, other) {
  const { width, height } = built.camera;
  const rects = labelRects(built);
  const m = compareFrames(cpu, other, width, height, rects);
  const cpuDecoded = decodeSet(cpu, width, height);
  const otherDecoded = decodeSet(other, width, height);
  const decodeParity = JSON.stringify(cpuDecoded) === JSON.stringify(otherDecoded);
  const pixelPass = m.meanInside <= INSIDE_LABEL_TOL && m.meanOutside <= OUTSIDE_LABEL_TOL;
  let flippedWouldPass = false;
  if (!pixelPass) {
    const f = compareFrames(cpu, flipVertical(other, width, height), width, height, rects);
    flippedWouldPass = f.meanInside <= INSIDE_LABEL_TOL && f.meanOutside <= OUTSIDE_LABEL_TOL;
  }
  return {
    id: built.id,
    ...m,
    labels: rects.length,
    cpuDecoded,
    otherDecoded,
    decodeParity,
    pixelPass,
    pass: pixelPass && decodeParity,
    flippedWouldPass,
  };
}

// ---- PGM codec ---------------------------------------------------------------------------------

export function encodePgm(luma, width, height) {
  const head = new TextEncoder().encode(`P5\n${width} ${height}\n255\n`);
  const out = new Uint8Array(head.length + width * height);
  out.set(head, 0);
  out.set(luma.subarray(0, width * height), head.length);
  return out;
}

export function decodePgm(bytes) {
  let p = 0;
  const token = () => {
    while (p < bytes.length && (bytes[p] === 0x20 || bytes[p] === 0x0a || bytes[p] === 0x0d || bytes[p] === 0x09)) p++;
    let s = '';
    while (p < bytes.length && bytes[p] > 0x20) s += String.fromCharCode(bytes[p++]);
    return s;
  };
  if (token() !== 'P5') throw new Error('not a binary PGM (P5)');
  const width = Number(token());
  const height = Number(token());
  if (Number(token()) !== 255) throw new Error('only 8-bit PGM supported');
  p++; // single whitespace after maxval
  if (bytes.length - p < width * height) throw new Error('PGM data truncated');
  return { width, height, luma: bytes.slice(p, p + width * height) };
}
