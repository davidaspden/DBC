/**
 * L6 — Negative & False-Positive Fixture Suite Tests (`tests/negatives.test.js`).
 * Runs all 9 negative fixture categories through `processFrameMulti` under:
 *  - `flags=0` (baseline)
 *  - `W-fc` (`vertFallback|extraLines|cribMatch|requirePrefix|prefixStack|illumNorm|scanSmooth`)
 *  - `strict` (`W-fc|requirePrefixStrict`)
 *
 *   node tests/negatives.test.js
 */

import assert from 'node:assert/strict';
import {
  NEGATIVE_KINDS,
  generateNegativeFixture,
  generateNegativeSuite,
  scoreNegativeFixture,
} from '../src/sim/negatives.js';
import {
  createPipelineState,
  createPipelineResult,
  processFrameMulti,
  extractMultiDetections,
} from '../src/worker/scanner.worker.js';
import {
  FLAG_VERT_FALLBACK,
  FLAG_EXTRA_LINES,
  FLAG_CRIB_MATCH,
  FLAG_REQUIRE_PREFIX,
  FLAG_REQUIRE_PREFIX_STRICT,
  FLAG_PREFIX_STACK,
  FLAG_ILLUM_NORM,
  FLAG_SCAN_SMOOTH,
} from '../src/worker/flagbits.js';

const FLAGS_OFF = 0;
const FLAGS_W_FC =
  FLAG_VERT_FALLBACK |
  FLAG_EXTRA_LINES |
  FLAG_CRIB_MATCH |
  FLAG_REQUIRE_PREFIX |
  FLAG_PREFIX_STACK |
  FLAG_ILLUM_NORM |
  FLAG_SCAN_SMOOTH;
const FLAGS_STRICT = FLAGS_W_FC | FLAG_REQUIRE_PREFIX_STRICT;

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  PASS  ${name}`);
}

console.log('Running L6 negative & false-positive fixture tests...');

test('generateNegativeSuite produces all 9 required deterministic fixture kinds with metadata', () => {
  assert.equal(NEGATIVE_KINDS.length, 9);
  const suiteA = generateNegativeSuite({ seed: 100 });
  const suiteB = generateNegativeSuite({ seed: 100 });
  assert.equal(suiteA.length, 9);

  for (let i = 0; i < 9; i++) {
    const a = suiteA[i];
    const b = suiteB[i];
    assert.equal(a.id, b.id);
    assert.equal(a.kind, NEGATIVE_KINDS[i]);
    assert.equal(a.luma.length, a.width * a.height);
    assert.equal(Buffer.compare(a.luma, b.luma), 0, `fixture ${a.kind} must be deterministic`);
    assert.ok(Array.isArray(a.expectedPayloads));
    assert.equal(typeof a.allowValidNonTsx, 'boolean');
    assert.equal(typeof a.failOnAnyAccept, 'boolean');
  }
});

test('0 false payloads across all 9 negative fixture kinds under flags=0, W-fc, and strict (3 seeds each)', () => {
  const flagSets = [
    { name: 'flags=0', mask: FLAGS_OFF, strict: false },
    { name: 'W-fc', mask: FLAGS_W_FC, strict: false },
    { name: 'strict', mask: FLAGS_STRICT, strict: true },
  ];

  const width = 480;
  const height = 480;
  const state = createPipelineState(width, height);
  const result = createPipelineResult();

  let totalEvaluations = 0;
  let totalFP = 0;
  let validNonTsxDecodedLoose = 0;
  let validNonTsxRejectedStrict = 0;

  for (const seed of [1, 42, 777]) {
    const suite = generateNegativeSuite({ seed, width, height });
    for (const fixture of suite) {
      for (const fs of flagSets) {
        state.flags = fs.mask;
        processFrameMulti(fixture.luma, fixture.width, fixture.height, state, result, false);
        const dets = extractMultiDetections(state);
        const score = scoreNegativeFixture(fixture, dets, { strict: fs.strict });
        totalEvaluations++;

        if (!score.ok) {
          totalFP += score.falsePositives.length;
        }
        assert.equal(
          score.falsePositives.length,
          0,
          `FP on ${fixture.id} under ${fs.name}: got ${JSON.stringify(score.falsePositives)}`
        );

        if (fixture.kind === 'valid-non-tsx') {
          if (!fs.strict) {
            assert.ok(
              score.validHits.length >= 1,
              `valid non-tsX ${fixture.id} should decode under ${fs.name}`
            );
            validNonTsxDecodedLoose++;
          } else {
            assert.equal(
              dets.length,
              0,
              `valid non-tsX ${fixture.id} must be rejected under strict, got ${JSON.stringify(dets)}`
            );
            validNonTsxRejectedStrict++;
          }
        }
      }
    }
  }

  console.log(
    `    evaluated=${totalEvaluations} fixture-runs, FP=${totalFP}, ` +
    `validNonTsxLoose=${validNonTsxDecodedLoose}/6, validNonTsxRejectedStrict=${validNonTsxRejectedStrict}/3`
  );
  assert.equal(totalFP, 0);
  assert.equal(validNonTsxDecodedLoose, 6);
  assert.equal(validNonTsxRejectedStrict, 3);
});

test('both EAN-13 lookalike and Code 39 lookalike variants reject cleanly under all flag sets', () => {
  const width = 480;
  const height = 480;
  const state = createPipelineState(width, height);
  const result = createPipelineResult();

  // Even seed -> EAN-13 lookalike; odd seed -> Code 39 lookalike
  const eanFix = generateNegativeFixture('ean-code39-lookalike', { seed: 20, width, height });
  const c39Fix = generateNegativeFixture('ean-code39-lookalike', { seed: 21, width, height });
  assert.notEqual(Buffer.compare(eanFix.luma, c39Fix.luma), 0);

  for (const fix of [eanFix, c39Fix]) {
    for (const mask of [FLAGS_OFF, FLAGS_W_FC, FLAGS_STRICT]) {
      state.flags = mask;
      const count = processFrameMulti(fix.luma, width, height, state, result, false);
      assert.equal(count, 0, `${fix.id} must produce 0 detections under mask=${mask}`);
    }
  }
});

console.log(`All ${passed} L6 negative fixture tests passed.`);
