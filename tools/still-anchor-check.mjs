#!/usr/bin/env node
/**
 * B8 part 2 — real-image check for `decodeAnchor` on the default (non-vertical-mode) path.
 *
 * Uses the real 1080x2400 tote still (`tests/fixtures-sim/tote-tsX07wz7py1-gray.pgm.gz`). Its bars
 * were located by eye and by row gradient energy: they span y 897..1345 (length 448 px) and are centred
 * at x 530, i.e. the label bars centre is (530, 1121). The still is also cropped several ways to
 * move the label around the frame (the true centre moves with the crop offset).
 *
 *   node tools/still-anchor-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parsePGM } from '../tests/harness.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import { FLAG_DECODE_ANCHOR } from '../src/worker/flagbits.js';

export const STILL_PAYLOAD = 'tsX07wz7py1';
export const STILL_TRUTH = Object.freeze({ centreX: 530, centreY: 1121, barsLenPx: 448, barsTopY: 897, barsBottomY: 1345 });
export const STILL_CROPS = Object.freeze([
  [0, 0, 1080, 2400],
  [0, 150, 1080, 2250],
  [100, 300, 900, 1900],
  [0, 500, 1080, 1700],
  [150, 0, 930, 2400],
  [0, 700, 1080, 1100],
]);

export function loadStill() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, '..', 'tests', 'fixtures-sim', 'tote-tsX07wz7py1-gray.pgm.gz');
  const pgm = parsePGM(zlib.gunzipSync(fs.readFileSync(file)));
  return { width: pgm.width, height: pgm.height, luma: pgm.data || pgm.luma };
}

export function cropLuma(still, x0, y0, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    out.set(still.luma.subarray((y0 + y) * still.width + x0, (y0 + y) * still.width + x0 + w), y * w);
  }
  return out;
}

/** Decodes one crop with `mask` and scores the reported geometry against the by-eye bars truth. */
export function scoreStillCrop(still, crop, mask) {
  const [x0, y0, w, h] = crop;
  const luma = cropLuma(still, x0, y0, w, h);
  const state = createPipelineState(w, h);
  state.flags = mask | 0;
  const result = createPipelineResult();
  for (let k = 0; k < 2; k++) processFrameMulti(luma, w, h, state, result, false);
  const d = extractMultiDetections(state).find((x) => x.payload === STILL_PAYLOAD);
  if (!d) return null;
  const ex = STILL_TRUTH.centreX - x0;
  const ey = STILL_TRUTH.centreY - y0;
  return {
    crop,
    dx: d.roiCenterX - ex,
    dy: d.roiCenterY - ey,
    centreErrPx: Math.hypot(d.roiCenterX - ex, d.roiCenterY - ey),
    alongErrFracLabel: Math.abs(d.roiCenterY - ey) / STILL_TRUTH.barsLenPx,
    lenPx: d.roiMajorLen,
    lenErrFrac: Math.abs(d.roiMajorLen - STILL_TRUTH.barsLenPx) / STILL_TRUTH.barsLenPx,
    boxW: d.roiW,
    boxH: d.roiH,
    payload: d.payload,
  };
}

export function runStillCases(mask) {
  const still = loadStill();
  return STILL_CROPS.map((c) => scoreStillCrop(still, c, mask));
}

if (typeof process !== 'undefined' && process.argv[1] && process.argv[1].endsWith('still-anchor-check.mjs')) {
  const still = loadStill();
  console.log('crop (x,y,w,h)         |  default: dx,dy  len  box     |  decodeAnchor: dx,dy  len  box');
  for (const c of STILL_CROPS) {
    const a = scoreStillCrop(still, c, 0);
    const b = scoreStillCrop(still, c, FLAG_DECODE_ANCHOR);
    const f = (r) => (r ? `${r.dx.toFixed(0).padStart(4)},${r.dy.toFixed(0).padStart(4)}  ${r.lenPx.toFixed(0).padStart(4)}  ${r.boxW}x${r.boxH}` : 'no decode');
    console.log(`${c.join(',').padEnd(22)} | ${f(a).padEnd(26)}| ${f(b)}`);
  }
}
