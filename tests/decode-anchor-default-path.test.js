/**
 * B8 part 2 — `decodeAnchor` on the default (non-vertical-mode) path.
 *
 * On the real tote still the default path decodes through Tier C (aligned profile averaging) and
 * reported the RoI-cluster box/centre, which drifts off the bars (up to ~100 px) and is often much
 * longer than the label. `decodeAnchor` now slides that box/centre along the scan axis onto the decoded
 * start-stop span and reports the decoded span length.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { WORKER_FLAG_BITS, FLAG_DECODE_ANCHOR } from '../src/worker/flagbits.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import {
  STILL_PAYLOAD,
  STILL_TRUTH,
  STILL_CROPS,
  loadStill,
  cropLuma,
  scoreStillCrop,
} from '../tools/still-anchor-check.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  console.log(`  PASS  ${name}`);
  passed++;
}

const still = loadStill();
const B = WORKER_FLAG_BITS;
const ALL_OTHER = Object.entries(B)
  .filter(([k]) => k !== 'decodeAnchor' && k !== 'requirePrefixStrict')
  .reduce((m, [, v]) => m | v, 0);
const CRIB_STACK = B.cribMatch | B.requirePrefix | B.prefixStack;

// ---- Parity with main (32cd7c6 + B8 = 9e92624): flags off must not move -----------------------

function digestStill(mask) {
  const h = createHash('sha256');
  const crops = [...STILL_CROPS, [200, 600, 800, 1200]];
  for (const [x0, y0, w, hh] of crops) {
    const f = cropLuma(still, x0, y0, w, hh);
    const st = createPipelineState(w, hh);
    const res = createPipelineResult();
    st.flags = mask;
    st.scanline.mode = (mask & B.verticalMode) !== 0 ? 1 : 0;
    for (let k = 0; k < 2; k++) {
      processFrameMulti(f, w, hh, st, res, false);
      h.update(JSON.stringify({
        n: st.detCount,
        d: extractMultiDetections(st),
        r: [res.detected, res.roiX, res.roiY, res.roiW, res.roiH, res.roiCenterX, res.roiCenterY, res.roiMajorLen, res.thetaDeg, res.consensusCount],
      }));
    }
  }
  return h.digest('hex');
}

test('flags off is bit-identical to pre-part-2 main on the real still and 6 crops (incl. all other flags, crib+prefixStack)', () => {
  assert.equal(digestStill(0), '546819793b63b393a496a64dbc75eb9954733939e71c4a128911c609ffbb353d');
  assert.equal(digestStill(ALL_OTHER), '7ce8d528af9fe563030e616264cae63a95d314cc8a206a63b5615b2971cfa2b2');
  assert.equal(digestStill(CRIB_STACK), '4737770dd82a170c8ecf8afc30b900770b11c880a2a52e8e874a7ebc1de33d18');
});

// ---- Accuracy against the by-eye bars truth ---------------------------------------------------

const off = STILL_CROPS.map((c) => scoreStillCrop(still, c, 0));
const on = STILL_CROPS.map((c) => scoreStillCrop(still, c, FLAG_DECODE_ANCHOR));

test('default path baseline (flag off): centre drifts up to ~100 px and span length up to ~70% too long', () => {
  assert.ok(off.every(Boolean), 'every crop decodes');
  assert.ok(Math.max(...off.map((r) => r.centreErrPx)) > 60, `max ${Math.max(...off.map((r) => r.centreErrPx))}`);
  assert.ok(Math.max(...off.map((r) => r.lenErrFrac)) > 0.5);
});

test('decodeAnchor: every crop centre within 12 px and span length within 3% of the true bars', () => {
  assert.ok(on.every(Boolean));
  for (let i = 0; i < on.length; i++) {
    assert.ok(on[i].centreErrPx <= 12, `crop ${on[i].crop} centre err ${on[i].centreErrPx}`);
    assert.ok(on[i].lenErrFrac <= 0.03, `crop ${on[i].crop} len ${on[i].lenPx}`);
    assert.ok(on[i].centreErrPx < off[i].centreErrPx + 1e-9 || off[i].centreErrPx < 8, `crop ${i} did not improve`);
    assert.equal(on[i].payload, off[i].payload);
  }
});

test('decodeAnchor: along-axis centre error on the full still falls from ~4% to ~0% of the bars length', () => {
  assert.ok(off[0].alongErrFracLabel > 0.03);
  assert.ok(on[0].alongErrFracLabel < 0.005, `${on[0].alongErrFracLabel}`);
  assert.ok(Math.abs(on[0].boxH - (STILL_TRUTH.barsLenPx + 24)) <= 6, `box height ${on[0].boxH} trimmed to the decoded span`);
  assert.ok(off[0].boxH > STILL_TRUTH.barsLenPx + 80, 'old box is much taller than the bars');
});

test('decodeAnchor with crib+prefixStack on the still: along-axis error ~0 px (was 17-73 px)', () => {
  const offS = STILL_CROPS.map((c) => scoreStillCrop(still, c, CRIB_STACK));
  const onS = STILL_CROPS.map((c) => scoreStillCrop(still, c, CRIB_STACK | FLAG_DECODE_ANCHOR));
  for (let i = 0; i < onS.length; i++) {
    assert.ok(Math.abs(onS[i].dy) <= 3, `crop ${i} along err ${onS[i].dy}`);
    assert.ok(Math.abs(offS[i].dy) >= 13, `crop ${i} baseline along err ${offS[i].dy}`);
    assert.equal(onS[i].lenPx, offS[i].lenPx);
  }
});

test('decodeAnchor still changes geometry only on the still: payload, theta, confidence and agree count identical', () => {
  for (const [x0, y0, w, hh] of STILL_CROPS) {
    const f = cropLuma(still, x0, y0, w, hh);
    const run = (mask) => {
      const st = createPipelineState(w, hh);
      const res = createPipelineResult();
      st.flags = mask;
      for (let k = 0; k < 2; k++) processFrameMulti(f, w, hh, st, res, false);
      return extractMultiDetections(st).find((d) => d.payload === STILL_PAYLOAD);
    };
    const a = run(0);
    const b = run(FLAG_DECODE_ANCHOR);
    for (const k of ['payload', 'payloadHex', 'symbolsHex', 'thetaDeg', 'roiConfidence', 'consensusCount']) {
      assert.equal(a[k], b[k], `${k} @ ${x0},${y0}`);
    }
  }
});

console.log(`All ${passed} decodeAnchor default-path tests passed.`);
