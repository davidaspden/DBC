/**
 * F7 — `stopGuard` must not reject the real 1080x2400 tote still (`tsX07wz7py1`).
 *   node tests/stopguard-real-still.test.js
 *
 * Root cause: F1's start-vs-end character-width window `[0.62x .. 1.60x]` sat at the edge of the real
 * label's perspective taper (end char / start char ≈ 1.60–1.65), so `stopGuard` (alone, or with
 * `cribMatch`, or via `?flags=all`) rejected every scanline of the real label that decodes with flags off.
 * The upper bound is widened to 2.0x (512/256). Flags-off behaviour is untouched.
 */
import assert from 'node:assert/strict';
import { WORKER_FLAG_BITS as B } from '../src/worker/flagbits.js';
import { createPipelineState, createPipelineResult, processFrameMulti, extractMultiDetections } from '../src/worker/scanner.worker.js';
import { loadStill, STILL_PAYLOAD } from '../tools/still-anchor-check.mjs';

const still = loadStill();
function decode(mask) {
  const st = createPipelineState(still.width, still.height);
  st.flags = mask | 0;
  const res = createPipelineResult();
  for (let k = 0; k < 2; k++) processFrameMulti(still.luma, still.width, still.height, st, res, false);
  return extractMultiDetections(st).map((d) => d.payload);
}
const ALL = Object.entries(B).filter(([k]) => k !== 'requirePrefixStrict' && k !== 'softDecode' && k !== 'extraLines').reduce((m, [, v]) => m | v, 0);
const sets = { off: 0, stopGuard: B.stopGuard, 'cribMatch+stopGuard': B.cribMatch | B.stopGuard, 'cribMatch+stopGuard+decodeAnchor': B.cribMatch | B.stopGuard | B.decodeAnchor, 'all (no strict/extraLines)': ALL };
for (const [name, mask] of Object.entries(sets)) {
  assert.ok(decode(mask).includes(STILL_PAYLOAD), `${name} must decode ${STILL_PAYLOAD}`);
  console.log(`  PASS  ${name} decodes the real still`);
}
console.log('All stopGuard real-still tests passed.');
