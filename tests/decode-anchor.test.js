/**
 * B8 — `decodeAnchor`: anchor the reported label centre / ROI / overlay line to the decoded
 * start-stop span on the winning scanlines instead of a mis-origined span.
 *
 * Root cause (found by R8): decoded-symbol positions are measured from run 0, but the derivative
 * run extractor starts run 0 at the first edge (not at sample 0) when the scanline begins on a
 * bar->space edge (e.g. tote background -> label paper), so every span was shifted by the lead-in
 * distance (about 4-25% of the label length). `decodeAnchor` adds the run origin and reports the
 * mean decoded-span midpoint as the centre.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parsePGM } from './harness.js';
import { resolveFlags, flagsToWorkerMask, FLAG_DEFS } from '../src/flags.js';
import { WORKER_FLAG_BITS, FLAG_DECODE_ANCHOR } from '../src/worker/flagbits.js';
import {
  createScanlineState,
  extractRunsFromScanline,
  extractRunsLocalMidCrossing,
} from '../src/worker/scanline.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import { createSceneForPreset } from '../src/sim/presets.js';
import { renderFrame, createCpuRenderContext } from '../src/sim/cpu-render.js';
import {
  aimPose,
  hfovForLongAxisDeg,
  OVERLAY_FRAME_SIZES,
  OVERLAY_POSES,
  runOverlayMatrix,
} from '../src/sim/overlay-truth.js';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const FLAG_VERTICAL_MODE_BIT = WORKER_FLAG_BITS.verticalMode;
const scene = createSceneForPreset('fc-8-3p5');

test('decodeAnchor flag: default off, bit 14, worker-mask bit, registered in FLAG_DEFS', () => {
  const def = FLAG_DEFS.find((d) => d.name === 'decodeAnchor');
  assert.ok(def);
  assert.equal(def.default, false);
  assert.equal(def.item, 'B8');
  assert.equal(FLAG_DECODE_ANCHOR, 1 << 14);
  assert.equal(WORKER_FLAG_BITS.decodeAnchor, FLAG_DECODE_ANCHOR);
  assert.equal(flagsToWorkerMask(resolveFlags({ search: '', stored: null })) & FLAG_DECODE_ANCHOR, 0);
  assert.equal(flagsToWorkerMask(resolveFlags({ search: '?flags=decodeAnchor', stored: null })) & FLAG_DECODE_ANCHOR, FLAG_DECODE_ANCHOR);
  const bits = Object.values(WORKER_FLAG_BITS);
  assert.equal(new Set(bits).size, bits.length, 'worker flag bits are unique');
});

test('run origin: leading bar->space edge starts run 0 at that edge; leading space->bar and mid-crossing start at 0', () => {
  const st = createScanlineState();
  const n = 200;
  const buf = new Uint8Array(n);
  // Dark lead-in 0..39 (tote), white paper 40..79, then 1 bar/space pairs of 6 px, then white
  for (let i = 0; i < n; i++) {
    let v = 230;
    if (i < 40) v = 30;
    else if (i >= 80 && i < 160) v = Math.floor((i - 80) / 6) % 2 === 0 ? 20 : 235;
    buf[i] = v;
  }
  const rc = extractRunsFromScanline(buf, 0, n, st, 72, 18);
  assert.ok(rc > 10);
  const firstEdgePx = 39.5;
  assert.ok(Math.abs(st.runOriginQ8 / 256 - firstEdgePx) < 1.5, `origin ${st.runOriginQ8 / 256}`);

  // Starts on a space (white) then falls into a bar: leading space run tiles from sample 0
  const buf2 = new Uint8Array(n);
  for (let i = 0; i < n; i++) buf2[i] = i < 30 ? 230 : (Math.floor((i - 30) / 6) % 2 === 0 ? 20 : 235);
  extractRunsFromScanline(buf2, 0, n, st, 72, 18);
  assert.equal(st.runOriginQ8, 0);

  st.runOriginQ8 = 12345;
  extractRunsLocalMidCrossing(buf, 0, n, st, 20);
  assert.equal(st.runOriginQ8, 0);
});

// ---- Parity: flags off (and every other flag, decodeAnchor off) is bit-identical to main --------

const WALL_OTHER = Object.entries(WORKER_FLAG_BITS)
  .filter(([k]) => k !== 'decodeAnchor' && k !== 'requirePrefixStrict')
  .reduce((m, [, v]) => m | v, 0);

const PARITY_CASES = [
  { w: 1080, h: 1920, cell: 5, z: 8, yaw: 0, pitch: 0, roll: 0 },
  { w: 720, h: 1280, cell: 10, z: 8, yaw: 0, pitch: 0, roll: 25 },
  { w: 1920, h: 1080, cell: 5, z: 9, yaw: 18, pitch: -8, roll: 8 },
  { w: 1920, h: 1080, cell: 5, z: 16, yaw: 0, pitch: 0, roll: 0 },
];

function runCases(mask) {
  const h = createHash('sha256');
  const perFrame = [];
  for (const c of PARITY_CASES) {
    const cam = { width: c.w, height: c.h, hfovDeg: hfovForLongAxisDeg(c.w, c.h) };
    const cl = scene.cells[c.cell];
    const pose = aimPose(cl.cx + (cl.labelOffsetXIn || 0), cl.cy + (cl.labelOffsetYIn || 0), c.z, c.yaw, c.pitch, c.roll);
    const ctx = createCpuRenderContext(scene.cells.length);
    const st = createPipelineState(c.w, c.h);
    const res = createPipelineResult();
    st.flags = mask;
    st.scanline.mode = (mask & WORKER_FLAG_BITS.verticalMode) !== 0 ? 1 : 0;
    for (let f = 0; f < 3; f++) {
      const luma = renderFrame(scene, pose, { ...cam, frameSeed: 7 + f, ctx }, null);
      processFrameMulti(luma, c.w, c.h, st, res, false);
      const dets = extractMultiDetections(st);
      perFrame.push(dets);
      h.update(JSON.stringify({
        n: st.detCount,
        dets,
        r: [res.detected, res.roiX, res.roiY, res.roiW, res.roiH, res.roiCenterX, res.roiCenterY, res.roiMajorLen, res.thetaDeg, res.consensusCount, res.payloadLen],
      }));
    }
  }
  return { digest: h.digest('hex'), perFrame };
}

// Digests recorded on main (32cd7c6, before B8) with the same frames; flags-off must never move.
const MAIN_DIGEST_FLAGS_OFF = '93e54ee34d40b9fb5ace3721e15a5bb39573bbe172fae730bef71759fabe75bb';
const MAIN_DIGEST_ALL_OTHER_FLAGS = 'b06112035d31753ddab35ea3a1d019c24675fc5f74958380ecde4c572e1118a9';

const off = runCases(0);
const other = runCases(WALL_OTHER);
const anchorOff = off;
const anchorOn = runCases(FLAG_DECODE_ANCHOR);
const anchorOnWall = runCases(WALL_OTHER | FLAG_DECODE_ANCHOR);

test('flags off is bit-identical to pre-B8 main (all detection geometry, payloads and result fields)', () => {
  assert.equal(off.digest, MAIN_DIGEST_FLAGS_OFF);
  assert.ok(off.perFrame.flat().length >= 8, 'non-vacuous: decodes present');
});

test('every other worker flag on, decodeAnchor off: still bit-identical to pre-B8 main', () => {
  assert.equal(other.digest, MAIN_DIGEST_ALL_OTHER_FLAGS);
});

test('decodeAnchor changes geometry only: same payloads, symbols, theta, confidence, agree count and span length', () => {
  for (const [a, b] of [[anchorOff, anchorOn], [other, anchorOnWall]]) {
    assert.equal(a.perFrame.length, b.perFrame.length);
    let moved = 0;
    for (let i = 0; i < a.perFrame.length; i++) {
      const A = a.perFrame[i];
      const B = b.perFrame[i];
      assert.equal(A.length, B.length, `frame ${i} detection count`);
      for (let d = 0; d < A.length; d++) {
        for (const k of ['payload', 'payloadHex', 'symbolsHex', 'prefixOk', 'thetaDeg', 'roiConfidence', 'consensusCount', 'roiMajorLen']) {
          assert.equal(A[d][k], B[d][k], `frame ${i} det ${d} ${k}`);
        }
        if (Math.abs(A[d].roiCenterY - B[d].roiCenterY) > 1 || Math.abs(A[d].roiCenterX - B[d].roiCenterX) > 1) moved++;
      }
    }
    assert.ok(moved > 0, 'the anchor moves at least one reported centre');
  }
});

// ---- Accuracy against the R8 ground truth -----------------------------------------------------

const offMatrix = runOverlayMatrix({ scene, workerMask: 0 });
const onMatrix = runOverlayMatrix({ scene, workerMask: FLAG_DECODE_ANCHOR });

test('R8 truth: decodeAnchor cuts the worst centre error from ~25% to <= 3.5% of label length in every case', () => {
  assert.equal(onMatrix.summary.undecoded, 0);
  assert.equal(onMatrix.summary.scored, OVERLAY_FRAME_SIZES.length * OVERLAY_POSES.length * 2);
  assert.ok(offMatrix.summary.maxCentreErrFracLabel > 0.2, `off baseline ${offMatrix.summary.maxCentreErrFracLabel}`);
  assert.ok(onMatrix.summary.maxCentreErrFracLabel <= 0.035, `on ${onMatrix.summary.maxCentreErrFracLabel}`);
  for (let i = 0; i < onMatrix.rows.length; i++) {
    const a = offMatrix.rows[i].detection;
    const b = onMatrix.rows[i].detection;
    assert.ok(b.centreErrFracLabel < a.centreErrFracLabel, `row ${i} did not improve`);
    assert.ok(b.roiIouBars >= a.roiIouBars - 0.01, `row ${i} bars IoU regressed ${a.roiIouBars} -> ${b.roiIouBars}`);
  }
});

test('R8 truth: end-to-end overlay error (detection through the product mapper) falls from ~105 to <= 15 CSS px', () => {
  assert.ok(offMatrix.summary.maxOverlayErrCssPx > 80);
  assert.ok(onMatrix.summary.maxOverlayErrCssPx <= 15, `on ${onMatrix.summary.maxOverlayErrCssPx}`);
});

test('R8 truth: upright head-on cases land within 1% of label length along the scan axis', () => {
  for (const r of onMatrix.rows) {
    if (r.pose !== 'head-on-8in') continue;
    const alongPx = Math.abs(r.detection.dyPx); // head-on ladder: scan axis is image-vertical
    assert.ok(alongPx / r.truth.labelLongEdgePx <= 0.01, `${r.frame} crop=${r.crop} along ${alongPx}`);
  }
});

test('real tote still fixture: anchored centre sits on the bars, the old centre sits ~150 px high', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pgm = parsePGM(zlib.gunzipSync(fs.readFileSync(path.join(here, 'fixtures-sim', 'tote-tsX07wz7py1-gray.pgm.gz'))));
  const { width, height } = pgm;
  const luma = pgm.data || pgm.luma;
  const FLAGS = FLAG_VERTICAL_MODE_BIT | WORKER_FLAG_BITS.cribMatch | WORKER_FLAG_BITS.requirePrefix;
  function centreY(mask) {
    const st = createPipelineState(width, height);
    const res = createPipelineResult();
    st.flags = mask;
    st.scanline.mode = (mask & FLAG_VERTICAL_MODE_BIT) !== 0 ? 1 : 0;
    processFrameMulti(luma, width, height, st, res, false);
    const d = extractMultiDetections(st).find((x) => x.payload === 'tsX07wz7py1');
    assert.ok(d, 'still decodes');
    return d;
  }
  // Bars span roughly y 895..1385 in this 1080x2400 still (measured by eye / row gradient energy).
  const off = centreY(FLAGS);
  const on = centreY(FLAGS | FLAG_DECODE_ANCHOR);
  assert.ok(off.roiCenterY < 1000, `old centre ${off.roiCenterY}`);
  assert.ok(on.roiCenterY > 1090 && on.roiCenterY < 1170, `anchored centre ${on.roiCenterY}`);
  assert.equal(on.payload, off.payload);
  assert.equal(on.roiMajorLen, off.roiMajorLen);
});

console.log(`  centre error max: off ${(offMatrix.summary.maxCentreErrFracLabel * 100).toFixed(1)}% -> on ${(onMatrix.summary.maxCentreErrFracLabel * 100).toFixed(2)}% of label; e2e ${offMatrix.summary.maxOverlayErrCssPx.toFixed(1)} -> ${onMatrix.summary.maxOverlayErrCssPx.toFixed(1)} CSS px`);
console.log(`All ${passed} decodeAnchor tests passed.`);
